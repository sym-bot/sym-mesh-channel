'use strict';

/**
 * delivery-policy.js — one decision, and one way of saying it, for every surface where a peer's
 * words can reach this session: the channel push, the sym_receive line, the sym_fetch body and the
 * sym_recall line.
 *
 * Two layers, in this order:
 *   1. VERIFIED OR NOT SHOWN (design D2). A delivery reaches the model only with the verification
 *      facts the SDK gave for it (delivery-facts.js). One without them is named by id and reason,
 *      never by its text.
 *   2. THE CONTENT POLICY, unchanged in substance since 0.10 (the 2026-09-27 incident): the
 *      allowlist, the payload limit and the injection patterns, the same judgement on every surface,
 *      and a withheld delivery is NAMED with its id and our reason, never counted as nothing. Rate is
 *      the one check that is not about content: counted once per arrival on the push, it holds back
 *      only the push.
 *
 * NAMES ARE LABELS (design D6). The allowlist holds nodeIds and is judged against the verified
 * signer. The rate counts per delivering session. A line prints the signer's label beside the last 8
 * characters of its nodeId, so two nodes that share a label are told apart on the line itself.
 */

const { scanClassifierRisk, quarantineHeader, neutralizeSurface } = require('./classifier-risk.js');
const { hiddenFieldsTag } = require('./surface-truth.js');
const { isNodeId, shortId } = require('./identity.js');
const { WITHHELD_REASONS } = require('./delivery-facts.js');

// ── Prompt-injection patterns ────────────────────────────────
// Attack model: a peer with a valid identity sends a CMB whose categories look relevant (so it
// passes SVAF) but whose text tries to take over the receiving session ("ignore previous
// instructions", persona overrides, fabricated tool calls). A verified signature proves who wrote
// it, not that it is safe to read. A match withholds the delivery on every surface.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?|guidelines?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?)/i,
  /forget\s+(everything|all)\s+(you('ve)?\s+)?(know|been\s+told|learned)/i,
  /you\s+are\s+now\s+(a\s+|an\s+)?(new\s+)?(ai|assistant|model|system|gpt|claude|llm)/i,
  /act\s+as\s+(a\s+|an\s+)?(different|new|unrestricted|jailbroken|evil|rogue)/i,
  /pretend\s+(you\s+)?(are|have\s+no)\s+(restrictions?|rules?|guidelines?|ethics?)/i,
  /new\s+(persona|personality|mode|role)\s*:/i,
  /<\s*system\s*>/i,
  /\[SYSTEM\]/,
  /##\s*system\s+prompt/i,
  /---\s*system\s*---/i,
  /<\s*tool_call\s*>/i,
  /<\s*function_calls?\s*>/i,
  /\{"type"\s*:\s*"tool_use"/,
  /you\s+(now\s+)?(have|possess)\s+(full|unrestricted|admin|root|elevated)\s+(access|permissions?|capabilities?)/i,
  /override\s+(safety|content|ethical?|policy)\s+(filter|check|guard|restriction)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

/** The largest payload shown unless SYM_MAX_PAYLOAD_BYTES says otherwise. A record's application
 *  section decodes to at most 512 KiB (§8.8.3), so the default never withholds a valid record. */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

/** The most characters of a message one sym_fetch answer carries; a longer one is read in parts. */
const FETCH_PAGE_CHARS = 48_000;

const fmt = (n) => Number(n).toLocaleString('en-US');

/** SYM_MAX_PAYLOAD_BYTES as a positive whole number of bytes; anything else is reported back. */
function readMaxPayloadBytes(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return { bytes: DEFAULT_MAX_PAYLOAD_BYTES };
  if (!/^\d+$/.test(s) || Number(s) < 1) return { bytes: DEFAULT_MAX_PAYLOAD_BYTES, invalid: s };
  return { bytes: Number(s) };
}

/** SYM_RATE_LIMIT: pushes per delivering session per minute (0 holds every push back). */
const DEFAULT_RATE_LIMIT = 30;
function readRateLimit(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return { limit: DEFAULT_RATE_LIMIT };
  if (!/^\d+$/.test(s)) return { limit: DEFAULT_RATE_LIMIT, invalid: s };
  return { limit: Number(s) };
}

/**
 * SYM_ALLOWED_PEERS: comma-separated nodeIds (design D6). An entry that is not a nodeId is ignored
 * and returned in `ignored` for the caller to report. A list that was set but holds no nodeId
 * FAILS CLOSED: an operator who set it meant to restrict, and a 0.10 list of names would otherwise
 * allow everyone the moment it stopped matching anything.
 */
function readAllowedPeers(raw) {
  const entries = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const nodeIds = [];
  const ignored = [];
  for (const e of entries) (isNodeId(e) ? nodeIds : ignored).push(isNodeId(e) ? e.toLowerCase() : e);
  return { nodeIds, ignored, failClosed: entries.length > 0 && nodeIds.length === 0, set: entries.length > 0 };
}

const RISK_SCAN_CHARS = 64 * 1024;
function riskText(focus, body) {
  const b = String(body ?? '');
  return `${focus}\n${b.length > RISK_SCAN_CHARS ? b.slice(0, RISK_SCAN_CHARS) : b}`;
}

// ── One delivery, serialised once ────────────────────────────

const PREPARED = Symbol('a prepared delivery');

function serialise(payload, indented) {
  if (payload === undefined || payload === null) return null;
  try { return JSON.stringify(payload, null, indented ? 2 : undefined) ?? String(payload); } catch { return String(payload); }
}

/** A delivery as every check reads it; its payload is serialised at most twice. */
function prepare(d) {
  if (d && d[PREPARED]) return d;
  const payload = d.payload;
  let compact, indented;
  return {
    [PREPARED]: true,
    from: d.from, content: d.content, categories: d.categories || {}, payload,
    get compact() { return compact === undefined ? (compact = serialise(payload, false)) : compact; },
    get indented() { return indented === undefined ? (indented = serialise(payload, true)) : indented; },
  };
}

function payloadBytes(p) {
  const s = prepare(p).compact;
  return s === null ? 0 : Buffer.byteLength(s, 'utf8');
}

function payloadTag(p) {
  return prepare(p).indented === null ? '' : ` [+payload ${fmt(payloadBytes(p))} bytes]`;
}

/** A message body as sym_fetch returns it. The payload is the record's signed application data. */
function renderBody(content, p) {
  const t = prepare(p).indented;
  return t === null ? String(content ?? '') : `${String(content ?? '')}\n\n---PAYLOAD (signed application data)---\n${t}`;
}

function textSurfaces(p) {
  const out = [];
  for (const v of Object.values(p.categories || {})) {
    const t = typeof v === 'string' ? v : (v && typeof v === 'object' && v.text != null ? String(v.text) : '');
    if (t) out.push(t);
  }
  if (typeof p.content === 'string' && p.content) out.push(p.content);
  if (p.payload !== undefined && p.payload !== null) {
    const s = typeof p.payload === 'string' ? p.payload : p.compact;
    if (s) out.push(s);
  }
  return out;
}

/**
 * The content policy. judge() answers { show: true } or { show: false, reason, detail, excerpt }.
 * `from` is the VERIFIED SIGNER's nodeId. `self` skips only the allowlist.
 */
function createDeliveryPolicy({ allowedPeers = [], failClosed = false, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  const allowed = new Set(allowedPeers.filter(Boolean).map((s) => String(s).toLowerCase()));
  function judge(d, { self = false } = {}) {
    const p = prepare(d);
    if (!self && failClosed) {
      return { show: false, reason: 'sender-not-allowed', detail: 'SYM_ALLOWED_PEERS is set but lists no nodeId, so it allows nothing (names are labels since 0.11; list nodeIds)', excerpt: '' };
    }
    if (!self && allowed.size && !allowed.has(String(p.from || '').toLowerCase())) {
      return { show: false, reason: 'sender-not-allowed', detail: 'its signer is not in SYM_ALLOWED_PEERS', excerpt: '' };
    }
    const bytes = payloadBytes(p);
    if (bytes > maxPayloadBytes) {
      return {
        show: false, reason: 'payload-over-limit',
        detail: `its payload is ${fmt(bytes)} bytes, over this node's limit of ${fmt(maxPayloadBytes)} ` +
          '(SYM_MAX_PAYLOAD_BYTES; raise it and restart to fetch this one from the inbox)',
        excerpt: `${bytes}b > ${maxPayloadBytes}b limit`,
      };
    }
    for (const surface of textSurfaces(p)) {
      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(surface)) {
          return {
            show: false, reason: 'injection-pattern',
            detail: 'its text matched a prompt-injection pattern, so none of it is shown (the sender can resend it reworded)',
            excerpt: surface.slice(0, 200),
          };
        }
      }
    }
    return { show: true };
  }
  return { judge, maxPayloadBytes, allowedPeers: [...allowed], failClosed };
}

// ── The push ─────────────────────────────────────────────────

/** Per-key arrivals in a sliding window. admit() counts one and answers false once over `limit`. */
function createRateLimiter({ limit = 30, windowMs = 60_000 } = {}) {
  const windows = new Map();
  let lastSweep = -Infinity;
  return {
    limit,
    admit(key, now = Date.now()) {
      const w = (windows.get(key) || []).filter((t) => now - t < windowMs);
      w.push(now);
      windows.set(key, w);
      if (windows.size > 1000 && now - lastSweep >= windowMs) {
        lastSweep = now;
        for (const [k, v] of windows) if (!v.some((t) => now - t < windowMs)) windows.delete(k);
      }
      return w.length <= limit;
    },
  };
}

/**
 * What the push does with one arrival: 'silent' for a signer the allowlist keeps out, 'rate-held'
 * once its session is over the rate, 'notice' for a withheld delivery, 'push' for one shown.
 */
function pushAction(verdict, rate, rateKey, now = Date.now()) {
  if (verdict.reason === 'sender-not-allowed') return 'silent';
  if (!rate.admit(rateKey, now)) return 'rate-held';
  return verdict.show ? 'push' : 'notice';
}

// ── What the session and the operator read ───────────────────

/** A label as this node prints it: no line breaks, brackets, control characters or line markers. */
function displayName(name) {
  const s = String(name ?? '').replace(/[\r\n\t\v\f[\]\u0000-\u001f\u007f-\u009f\u2028\u2029→·]/g, '_').replace(/ via /gi, ' via_').slice(0, 120);
  return s || 'unknown';
}

/** `label·3f9a2b1c`: the signer's own label and the last 8 of its nodeId. */
function whoTag(label, nodeId) {
  return `${displayName(label)}·${shortId(nodeId)}`;
}

/**
 * The bracket every line opens with: who signed, the audience, and the relay when there was one.
 *   [alice·3f9a2b1c →you]           directed to this node, delivered by its author
 *   [bob·77c0de11 →room via carol·0a1b2c3d]   room-bound, relayed by carol's session
 */
function deliveryTag(d) {
  if (d.kind === 'mood') {
    if (d.facts) return `[${whoTag(d.facts.signer.label, d.facts.signer.nodeId)} mood]`;
    return `[mood via ${displayName(d.moodFrom)} · unattributed]`;
  }
  const f = d.facts;
  const audience = f.audience === 'directed' ? '→you' : '→room';
  const relay = f.relayed && f.deliverer ? ` via ${whoTag(f.deliverer.label, f.deliverer.nodeId)}` : '';
  const kind = d.kind === 'message' ? ' message' : '';
  return `[${whoTag(f.signer.label, f.signer.nodeId)} ${audience}${relay}${kind}]`;
}

/** One withheld delivery, in our words only. */
function withheldLine(id, who, decision) {
  return `[${id}] from ${who}: ${decision.detail}`;
}

/** The line for a delivery with no verification facts: its id and why, nothing of its text. */
function unverifiedLine(d) {
  return `[${d.id}] withheld, not verified: ${WITHHELD_REASONS[d.withheld] || WITHHELD_REASONS.unverified}`;
}

/** The operator's stderr line for one withholding. */
function auditLine(surface, reason, peer, excerpt, id) {
  const safe = String(excerpt ?? '').replace(/[\u0000-\u001f\u007f-\u009f"]/g, ' ').slice(0, 120);
  const who = displayName(peer).replace(/\s/g, '_');
  return `[sym-security] WITHHELD surface=${surface} reason=${reason} peer=${who}${id ? ` id=${id}` : ''} excerpt="${safe}"\n`;
}

/** The text a delivery's line leads with. */
function leadText(d) {
  if (d.kind === 'mood') return `mood: ${d.mood && d.mood.text ? d.mood.text : ''}${moodNumbers(d.mood)}`;
  return String(d.categories?.focus?.text || d.content || '');
}
function moodNumbers(m) {
  if (!m) return '';
  const v = typeof m.valence === 'number' ? ` v:${m.valence}` : '';
  const a = typeof m.arousal === 'number' ? ` a:${m.arousal}` : '';
  return v || a ? ` (${(v + a).trim()})` : '';
}
function moodSuffix(categories) {
  const mood = categories?.mood?.text || '';
  return mood && mood !== 'neutral' ? ` (mood: ${mood})` : '';
}
function keyTag(d) {
  const key = d.key || (d.facts && d.facts.key);
  return key ? ` key ${key}` : '';
}

/**
 * The policy judgement for one delivery. Returns { bucket, verdict?, who? } where bucket is
 * 'unverified', 'own', 'not-allowed', 'withheld' or 'shown'.
 */
function judgeDelivery(d, { policy, selfNodeId }) {
  if (!d.facts && d.kind !== 'mood') return { bucket: 'unverified' };
  const signer = d.facts ? d.facts.signer.nodeId : null;
  if (signer && selfNodeId && signer === selfNodeId) return { bucket: 'own' };
  const p = prepare({ from: signer, content: d.content, categories: d.categories, payload: d.payload });
  // A mood the SDK could not tie to a signer (design §6 item 3) has no nodeId, so with an allowlist set
  // it is kept out; the content checks still run on the mood text.
  const verdict = policy.judge(p, { self: false });
  if (verdict.reason === 'sender-not-allowed') return { bucket: 'not-allowed', verdict, prepared: p };
  if (!verdict.show) return { bucket: 'withheld', verdict, prepared: p };
  return { bucket: 'shown', verdict, prepared: p };
}

/** Who a withheld line names: the signer tag, or the mood's label. */
function whoOf(d) {
  if (d.facts) return whoTag(d.facts.signer.label, d.facts.signer.nodeId);
  if (d.kind === 'mood') return `${displayName(d.moodFrom)} (unattributed mood)`;
  return 'an unverified sender';
}

/**
 * The push header for a delivery that is shown: the tag, the lead text and the markers. The caller
 * appends the id and the key, as every line ends.
 */
function pushHeader(d, prepared) {
  const lead = leadText(d);
  const risk = scanClassifierRisk(riskText(lead, renderBody(d.content || lead, prepared)));
  const memTag = d.directed && d.remixed === false ? ' ·not-stored' : '';
  const tail = `${memTag}${payloadTag(prepared)}${hiddenFieldsTag(d.categories)}`;
  if (risk.risky) return { header: quarantineHeader(deliveryTag(d).slice(1, -1), '', risk.terms.length, tail), risk, lead };
  return { header: `${deliveryTag(d)} ${lead}${d.kind === 'cmb' ? moodSuffix(d.categories) : ''}${tail}`, risk, lead };
}

/**
 * One delivery as sym_receive shows it, and the count it lands in. It never throws: a delivery this
 * node cannot render is withheld with that reason, so one bad message costs one line, never the
 * batch the drain has already taken. `audit` is [reason, excerpt] when the operator's log records it.
 */
function receiveLine(d, { policy, selfNodeId, now = Date.now(), pushed = false }) {
  try {
    const j = judgeDelivery(d, { policy, selfNodeId });
    if (j.bucket === 'unverified') return { bucket: 'unverified', line: unverifiedLine(d), audit: [`unverified:${d.withheld || 'unverified'}`, ''] };
    if (j.bucket === 'own') return { bucket: 'own', id: d.id };
    if (j.bucket === 'not-allowed') return { bucket: 'not-allowed', who: whoOf(d) };
    if (j.bucket === 'withheld') return { bucket: 'withheld', line: withheldLine(d.id, whoOf(d), j.verdict), audit: [j.verdict.reason, j.verdict.excerpt] };
    const age = Math.round((now - (d.receivedAt || now)) / 1000);
    const lead = leadText(d);
    const memTag = (d.directed && d.remixed === false ? ' ·not-stored' : '') + (pushed ? ' ·pushed' : '');
    const tail = `${memTag}${payloadTag(j.prepared)}${hiddenFieldsTag(d.categories)}`;
    const risk = scanClassifierRisk(riskText(lead, renderBody(d.content || lead, j.prepared)));
    if (risk.risky) {
      return { bucket: 'shown', line: `${quarantineHeader(deliveryTag(d).slice(1, -1), '', risk.terms.length, tail)} [${d.id}]${keyTag(d)} (${age}s ago)`, audit: [`classifier-risk:${risk.terms.join(',')}`, lead] };
    }
    const flat = lead.replace(/\s+/g, ' ');
    const cut = flat.length > 90 ? '…' : '';
    return { bucket: 'shown', line: `${deliveryTag(d)} ${flat.slice(0, 90)}${cut}${tail} [${d.id}]${keyTag(d)} (${age}s ago)` };
  } catch {
    return { bucket: 'withheld', line: withheldLine(d && d.id, 'a sender', { detail: 'this node could not render it' }), audit: ['render-failed', ''] };
  }
}

const KEY_SOURCE_SAID = {
  pinned: 'pinned out of band (an invite or the configured anchor)',
  anchor: 'the configured anchor',
  proven: 'proven by a Core Secure session with it',
  grant: 'vouched by a grant rooted at the anchor',
  session: 'proven by the session that delivered it',
};

/**
 * The account sym_fetch gives before a delivery's body: everything the node verified, in full.
 */
function fetchHead(d) {
  const when = new Date(d.receivedAt || Date.now()).toISOString();
  if (d.kind === 'mood' && !d.facts) {
    return `[${d.id}] mood via ${displayName(d.moodFrom)} · ${when}\n` +
      'Signed by: not attributed. The SDK named only the session label for this mood (a mood frame, or a rejected record it could not tie to one verified record), so no signer is claimed.';
  }
  const f = d.facts;
  const lines = [];
  lines.push(`[${d.id}] ${deliveryTag(d)} · ${when}`);
  lines.push(`Signed by: ${displayName(f.signer.label)} — nodeId ${f.signer.nodeId}; its key is ${KEY_SOURCE_SAID[f.signer.keySource] || (f.signer.keySource ? `bound (${f.signer.keySource})` : 'bound')}. The name is the signer's own label; the nodeId is the identity.`);
  lines.push(f.relayed && f.deliverer
    ? `Delivered: relayed by ${displayName(f.deliverer.label)} — nodeId ${f.deliverer.nodeId}, over ${f.deliverer.transport || 'a session'}. The signature is the author's, so the relay could not change it.`
    : `Delivered: directly by its author's own session${f.deliverer && f.deliverer.transport ? `, over ${f.deliverer.transport}` : ''}.`);
  lines.push(f.audience === 'directed'
    ? 'Audience: directed to this node (the signed recipient is this node\'s nodeId).'
    : `Audience: room-bound, room "${f.room ?? 'default'}"; this node's SVAF admitted it.`);
  const stored = d.kind === 'message' ? 'a message: delivered, never stored' : (d.remixed === false ? 'delivered only, not stored in this node\'s memory' : 'admitted to this node\'s memory');
  lines.push(`Memory: ${stored}.`);
  const key = d.key || f.key;
  lines.push(`Record: key ${key || '(none given)'} · assertion ${f.assertionId} · ${f.suite || 'suite not given'}`);
  if (Array.isArray(f.parents) && f.parents.length) lines.push(`Lineage: it cites ${f.parents.join(', ')}.`);
  if (key) lines.push(`Cite it: parents ["${key}"] (or ["${d.id}"]) when you respond to it (MMP §14.3).`);
  return lines.join('\n');
}

/**
 * One sym_recall hit. A memory is text the session reads like any delivery: a peer's record is
 * shown only when it is marked verified, and it passes the same content policy.
 */
function recallLine(r, { policy, selfName }) {
  const own = !r.peerId;
  const author = r.author && r.author.nodeId ? r.author : null;
  const who = own ? `${displayName(selfName)} (this node)` : (author ? whoTag(author.name, author.nodeId) : 'an unverified sender');
  const head = `[${who}] ${r.timestamp || r.storedAt ? new Date(r.timestamp || r.storedAt).toISOString() : ''}`;
  const key = r.key ? ` key ${r.key}` : '';
  if (!own && r.verified !== true) return { bucket: 'unverified' };
  try {
    const verdict = policy.judge({ from: own ? null : author.nodeId, content: r.content, categories: r.cmb?.categories, payload: r.cmb?.payload }, { self: own });
    if (!verdict.show) return { line: `${head}${key}\n  withheld: ${verdict.detail}`, audit: [verdict.reason, verdict.excerpt] };
    const focus = String(r.cmb?.categories?.focus?.text || r.content || '');
    const cut = focus.length > 150 ? '… [truncated]' : '';
    const risk = scanClassifierRisk(focus);
    if (risk.risky) return { line: `${head}${key}\n  ${neutralizeSurface(focus.slice(0, 150))}${cut} [${risk.terms.length} flagged term(s) defanged]`, audit: [`classifier-risk:${risk.terms.join(',')}`, focus] };
    return { line: `${head}${key}\n  ${focus.slice(0, 150)}${cut}` };
  } catch {
    return { line: `${head}${key}\n  withheld: this node could not render it`, audit: ['render-failed', ''] };
  }
}

/**
 * The sym_receive answer. "Caught up" is said only when the batch held no delivery at all.
 */
function receiveReport({ shown, withheld, unverified = [], notAllowed, own = [], alreadyRead = [], alreadyPushed = [], remaining, peek, unsupported = null }) {
  if (unsupported) return unsupported;
  const kept = [...notAllowed.values()].reduce((a, b) => a + b, 0);
  const more = remaining > 0 ? ` (+${remaining} more — call sym_receive again)` : '';
  const peekTag = peek ? ' (peek — not drained)' : '';
  const readLine = [
    alreadyRead.length ? `Already read with sym_fetch, not repeated: ${alreadyRead.length} (${alreadyRead.join(', ')}).` : '',
    alreadyPushed.length ? `Already pushed into this session, not repeated: ${alreadyPushed.length} (${alreadyPushed.join(', ')}) — sym_fetch any of them to read it again.` : '',
  ].filter(Boolean).join(' ');
  if (!shown.length && !withheld.length && !unverified.length && !kept && !own.length) {
    if (readLine) return remaining > 0 ? `No delivery in this batch${peekTag}${more}. ${readLine}` : `Caught up — nothing unread${peekTag}. ${readLine}`;
    return remaining > 0 ? `No delivery in this batch${peekTag}${more}.` : 'Caught up — nothing new delivered since your last sym_receive.';
  }
  const parts = [];
  if (shown.length) parts.push(`${shown.length} new mesh delivery(ies)${peekTag}${more}:\n${shown.join('\n')}`);
  else parts.push(`No delivery to show${peekTag}${more}: ${withheld.length + unverified.length + kept + own.length} delivered and not shown.`);
  if (withheld.length) parts.push(`Withheld by this node's content policy — delivered, not shown:\n${withheld.join('\n')}`);
  if (unverified.length) parts.push(`Withheld, not verified under Core Secure — never shown:\n${unverified.join('\n')}`);
  if (kept) {
    const who = [...notAllowed].map(([n, c]) => `${n} ×${c}`).join(', ');
    parts.push(`Not shown, signer outside SYM_ALLOWED_PEERS: ${kept} (${who}).`);
  }
  if (own.length) parts.push(`Not shown, signed by this node itself: ${own.length} (${own.join(', ')}) — its own records, relayed back.`);
  if (readLine) parts.push(readLine);
  if (shown.length) parts.push('Each line: [signer·last-8-of-nodeId →you|→room (via relay)]. sym_fetch <id> gives the full verification and body; reply with sym_send {to: "<id>", parents: ["<id>"]}.');
  return parts.join('\n\n');
}

/** sym_fetch's `offset`: absent means the start; otherwise a whole number of characters. */
function readOffset(raw) {
  if (raw === undefined || raw === null || raw === '') return { offset: 0 };
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 0) {
    return { error: `sym_fetch offset must be a whole number of characters from the start of the message (0 or more); got ${JSON.stringify(raw)}. No lookup was attempted.` };
  }
  return { offset: n };
}

/** One part of a message for sym_fetch; every part says which characters it holds. */
function fetchPart({ id, head, body, offset = 0, pageChars = FETCH_PAGE_CHARS }) {
  const total = body.length;
  if (offset > 0 && offset >= total) {
    return { error: `offset ${offset} is past the end of ${id}, which is ${fmt(total)} characters long.` };
  }
  if (offset === 0 && total <= pageChars) return { text: `${head}\n\n${body}`, last: true };
  let start = offset;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start]) && /[\uD800-\uDBFF]/.test(body[start - 1])) start--;
  let end = Math.min(total, start + pageChars);
  if (end < total && /[\uD800-\uDBFF]/.test(body[end - 1])) end = end - 1 > start ? end - 1 : end + 1;
  const where = `characters ${fmt(start + 1)}–${fmt(end)} of ${fmt(total)}`;
  const tail = end >= total
    ? `— ${where}: the end of ${id}.`
    : `— ${where}. The rest: sym_fetch {"msg_id": "${id}", "offset": ${end}}`;
  return { text: `${head}\n\n${body.slice(start, end)}\n\n${tail}`, last: end >= total };
}

module.exports = {
  keyTag,
  INJECTION_PATTERNS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  FETCH_PAGE_CHARS,
  readMaxPayloadBytes,
  DEFAULT_RATE_LIMIT,
  readRateLimit,
  readAllowedPeers,
  RISK_SCAN_CHARS,
  riskText,
  prepare,
  payloadBytes,
  payloadTag,
  renderBody,
  createDeliveryPolicy,
  createRateLimiter,
  pushAction,
  displayName,
  whoTag,
  deliveryTag,
  withheldLine,
  unverifiedLine,
  auditLine,
  judgeDelivery,
  pushHeader,
  receiveLine,
  fetchHead,
  recallLine,
  receiveReport,
  readOffset,
  fetchPart,
};
