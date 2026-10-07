'use strict';

/**
 * delivery-policy.js — one decision, and one way of saying it, for every surface where a peer's
 * words can reach this session: the channel push, the sym_receive line, the sym_fetch body and the
 * sym_recall line.
 *
 * Three rules, in this order:
 *   1. VERIFIED OR NOT SHOWN (design D2). A delivery reaches the model only when its own facts make it
 *      verified (provenance.js). One that does not is named by id and reason, never by its text.
 *   2. THE CONTENT POLICY (the 2026-09-27 incident): the allowlist, the payload limit and the
 *      injection patterns, the same judgement on every surface. A withheld delivery is NAMED with its
 *      id and our reason, never counted as nothing. The rate holds back only the push.
 *   3. PEER TEXT IS DATA (design D6). It never starts a line of the channel's markup: a push and a
 *      sym_receive line carry a bounded lead escaped as a JSON string on one line, and the full text is
 *      shown only by sym_fetch, inside a fence peer text cannot close. Only the signed parts are
 *      rendered: the seven CAT7 texts and the signed application data.
 *
 * A signer is named by its label and its key fingerprint suffix (key-display.js, design D3), never by
 * a truncated label or nodeId: both are chosen by their owner.
 */

const crypto = require('crypto');
const { scanClassifierRisk, quarantineHeader, neutralizeSurface } = require('./classifier-risk.js');
const { hiddenFieldsTag } = require('./surface-truth.js');
const { isNodeId } = require('./identity.js');
const { WITHHELD_REASONS } = require('./provenance.js');
const { createKeyBook, fullFingerprint, plainLabel } = require('./key-display.js');

// ── Prompt-injection patterns ────────────────────────────────
// A verified signature proves who wrote a record, not that it is safe to read. A match withholds the
// delivery on every surface; none of it is shown.
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

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const FETCH_PAGE_CHARS = 48_000;
/** The lead a push carries (the 0.10 compact header's size) and the lead a sym_receive line carries. */
const PUSH_LEAD_CHARS = 100;
const RECEIVE_LEAD_CHARS = 90;
const RECALL_LEAD_CHARS = 150;
const CAT7 = ['focus', 'issue', 'intent', 'motivation', 'commitment', 'perspective', 'mood'];

const fmt = (n) => Number(n).toLocaleString('en-US');

function readMaxPayloadBytes(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return { bytes: DEFAULT_MAX_PAYLOAD_BYTES };
  if (!/^\d+$/.test(s) || Number(s) < 1) return { bytes: DEFAULT_MAX_PAYLOAD_BYTES, invalid: s };
  return { bytes: Number(s) };
}

const DEFAULT_RATE_LIMIT = 30;
function readRateLimit(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return { limit: DEFAULT_RATE_LIMIT };
  if (!/^\d+$/.test(s)) return { limit: DEFAULT_RATE_LIMIT, invalid: s };
  return { limit: Number(s) };
}

/** SYM_ALLOWED_PEERS: nodeIds; names ignored and reported; a list with no nodeId fails closed. */
function readAllowedPeers(raw) {
  const entries = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const nodeIds = [];
  const ignored = [];
  for (const e of entries) (isNodeId(e) ? nodeIds : ignored).push(isNodeId(e) ? e.toLowerCase() : e);
  return { nodeIds, ignored, failClosed: entries.length > 0 && nodeIds.length === 0, set: entries.length > 0 };
}

const RISK_SCAN_CHARS = 64 * 1024;
function riskText(lead, body) {
  const b = String(body ?? '');
  return `${lead}\n${b.length > RISK_SCAN_CHARS ? b.slice(0, RISK_SCAN_CHARS) : b}`;
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
 * The content policy. judge() answers { show: true } or { show: false, reason, detail, counts }.
 * `from` is the VERIFIED SIGNER's nodeId. `self` skips only the allowlist. `reason` is the category a
 * withheld line names; `detail` is our own words; `counts` holds only numbers of ours (XMesh World,
 * agent-c: a withheld delivery names why, never the peer's text — not even in the operator's log).
 */
function createDeliveryPolicy({ allowedPeers = [], failClosed = false, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  const allowed = new Set(allowedPeers.filter(Boolean).map((s) => String(s).toLowerCase()));
  function judge(d, { self = false } = {}) {
    const p = prepare(d);
    if (!self && failClosed) {
      return { show: false, reason: 'sender-not-allowed', detail: 'SYM_ALLOWED_PEERS is set but lists no nodeId, so it allows nothing (names are labels since 0.11; list nodeIds)', counts: {} };
    }
    if (!self && allowed.size && !allowed.has(String(p.from || '').toLowerCase())) {
      return { show: false, reason: 'sender-not-allowed', detail: 'its signer is not in SYM_ALLOWED_PEERS', counts: {} };
    }
    const bytes = payloadBytes(p);
    if (bytes > maxPayloadBytes) {
      return {
        show: false, reason: 'payload-over-limit',
        detail: `its payload is ${fmt(bytes)} bytes, over this node's limit of ${fmt(maxPayloadBytes)} (SYM_MAX_PAYLOAD_BYTES; raise it and restart to fetch this one from the inbox)`,
        counts: { bytes, limit: maxPayloadBytes },
      };
    }
    for (const surface of textSurfaces(p)) {
      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(surface)) {
          return { show: false, reason: 'injection-pattern', detail: 'its text matched a prompt-injection pattern, so none of it is shown (the sender can resend it reworded)', counts: {} };
        }
      }
    }
    return { show: true };
  }
  return { judge, maxPayloadBytes, allowedPeers: [...allowed], failClosed };
}

// ── The push ─────────────────────────────────────────────────

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

function pushAction(verdict, rate, rateKey, now = Date.now()) {
  if (verdict.reason === 'sender-not-allowed') return 'silent';
  if (!rate.admit(rateKey, now)) return 'rate-held';
  return verdict.show ? 'push' : 'notice';
}

// ── Peer text as data ────────────────────────────────────────

/** A label in our own lines and logs (also used for outbox labels): one line, no markup characters. */
function displayName(name) {
  return plainLabel(name);
}

/**
 * Peer text summarised on one line: whitespace collapsed, cut to `max` characters, and escaped as a
 * JSON string — quoted, with every quote, backslash, control character and line separator escaped —
 * so it can never end the line or start one of the channel's own.
 */
function escapeLead(t, max) {
  const flat = String(t ?? '').replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return JSON.stringify(cut);
}

/** The signed text a line leads with (design D6): a CMB's focus, a message's text, a mood's text. */
function leadText(d) {
  if (d.kind === 'mood' || d.kind === 'message') return String(d.text ?? '');
  const f = d.categories && d.categories.focus;
  return String((f && typeof f === 'object' ? f.text : f) ?? '');
}

/**
 * The body sym_fetch shows: only what was signed (design D6) — the seven CAT7 texts, a message's or a
 * mood's text, and the signed application data. Never the SDK's rendered `content`, a non-CAT7 key, or
 * a mood's valence and arousal.
 */
function signedBody(d, p) {
  const lines = [];
  if (d.kind === 'message') lines.push(String(d.text ?? ''));
  else if (d.kind === 'mood') lines.push(`mood: ${String(d.text ?? '')}`);
  else {
    for (const f of CAT7) {
      const v = d.categories && d.categories[f];
      const t = v && typeof v === 'object' ? v.text : v;
      // 'neutral' is the canonical empty value an emitter writes for a category it left out (§14.3.2).
      if (typeof t === 'string' && t && t !== 'neutral') lines.push(`${f}: ${t}`);
    }
  }
  const pay = prepare(p).indented;
  if (pay !== null) lines.push('', '(payload — signed application data)', pay);
  return lines.join('\n');
}

function keyBook(ctx) { return (ctx && ctx.keys) || DEFAULT_KEYS; }
const DEFAULT_KEYS = createKeyBook();

/**
 * The bracket every line opens with: the signer (label and key fingerprint suffix), the audience, and
 * the relay session when there was one.
 *   [alice ⟨…7f3a91c2⟩ →you]
 *   [bob (2 keys) ⟨…77c0de11a4⟩ →room via carol ⟨…0a1b2c3d⟩]
 */
function deliveryTag(d, ctx) {
  const keys = keyBook(ctx);
  const f = d.facts;
  const who = keys.tag({ key: f.signer.key, label: f.signer.label, nodeId: f.signer.nodeId });
  // A mood frame carries no signed record: it is its session's proven peer's word, and said to be unsigned.
  if (d.kind === 'mood') return `[${who} mood${f.signed === false ? ', unsigned' : ''}]`;
  const audience = f.audience === 'directed' ? '→you' : '→room';
  const relay = f.relayed && f.deliverer ? ` via ${keys.tag({ key: f.deliverer.key, label: f.deliverer.label, nodeId: f.deliverer.nodeId })}` : '';
  return `[${who} ${audience}${relay}${d.kind === 'message' ? ' message' : ''}]`;
}

/** A reason category as a line names it: our own word, one token. */
function reasonWord(reason) {
  return String(reason || 'withheld').replace(/[^a-z0-9-]/gi, '_').slice(0, 40);
}

/** The line for a delivery the content policy withholds: its id, the signer, the category and why. */
function withheldLine(id, who, decision) {
  return `[${id}] from ${who}: withheld · ${reasonWord(decision.reason || 'render-failed')} — ${decision.detail}`;
}

/** The line for a delivery that is not verified: its id, the category and why, nothing of its text. */
function unverifiedLine(d) {
  const reason = WITHHELD_REASONS[d.withheld] ? d.withheld : 'unverified';
  return `[${d.id}] withheld, not verified · ${reason}: ${WITHHELD_REASONS[reason]}`;
}

/**
 * The operator's stderr line for one withholding: the surface, the category, the sender and our own
 * counts (`flagged=2`, `bytes=…`). Never an excerpt of the peer's text: a host may show this log to a
 * model, and the text is what was withheld (XMesh World, agent-c).
 */
function auditLine(surface, reason, peer, counts, id) {
  const who = displayName(peer).replace(/\s/g, '_');
  const nums = counts && typeof counts === 'object'
    ? Object.entries(counts).filter(([k, v]) => /^[a-z]{1,16}$/.test(k) && Number.isSafeInteger(v)).map(([k, v]) => ` ${k}=${v}`).join('')
    : '';
  return `[sym-security] WITHHELD surface=${surface} reason=${String(reason || 'withheld').replace(/[^a-z0-9:-]/gi, '_').slice(0, 64)} peer=${who}${id ? ` id=${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 16)}` : ''}${nums}\n`;
}

function keyTag(d) {
  const key = d.key || (d.facts && d.facts.key);
  return key ? ` key ${key}` : '';
}

/**
 * The judgement for one delivery: { bucket, verdict?, prepared? } — 'unverified', 'own', 'not-allowed',
 * 'withheld' or 'shown'.
 */
function judgeDelivery(d, { policy, selfNodeId }) {
  if (!d.facts) return { bucket: 'unverified' };
  const signer = d.facts.signer.nodeId;
  if (selfNodeId && signer === selfNodeId) return { bucket: 'own' };
  const p = prepare({ from: signer, content: d.kind === 'cmb' ? undefined : d.text, categories: d.categories, payload: d.payload });
  const verdict = policy.judge(p, { self: false });
  if (verdict.reason === 'sender-not-allowed') return { bucket: 'not-allowed', verdict, prepared: p };
  if (!verdict.show) return { bucket: 'withheld', verdict, prepared: p };
  return { bucket: 'shown', verdict, prepared: p };
}

function whoOf(d, ctx) {
  return d.facts ? keyBook(ctx).tag({ key: d.facts.signer.key, label: d.facts.signer.label, nodeId: d.facts.signer.nodeId }) : 'an unverified sender';
}

/**
 * The push for a delivery that is shown (design D6): one line — the tag, an escaped lead of at most
 * PUSH_LEAD_CHARS, the markers and the id — and the facts as structured meta.
 */
function pushOf(d, prepared, ctx) {
  const lead = leadText(d);
  const risk = scanClassifierRisk(riskText(lead, signedBody(d, prepared)));
  const memTag = d.directed && d.remixed === false && d.kind === 'cmb' ? ' ·not-stored' : '';
  const tail = `${memTag}${payloadTag(prepared)}${hiddenFieldsTag(d.categories)}`;
  const tag = deliveryTag(d, ctx);
  const text = risk.risky
    ? `${quarantineHeader(tag.slice(1, -1), '', risk.terms.length, tail)} [${d.id}]`
    : `${tag} ${escapeLead(lead, PUSH_LEAD_CHARS)}${tail} [${d.id}]`;
  const f = d.facts;
  const meta = {
    delivery_id: d.id,
    kind: d.kind,
    signer_node_id: f.signer.nodeId,
    signer_key_fingerprint: fullFingerprint(f.signer.key) || '',
    audience: f.audience,
    relayed_by: f.relayed && f.deliverer ? f.deliverer.nodeId : '',
    cmb_key: d.key || f.key || '',
    assertion_id: f.assertionId || '',
    signed: f.signed === false ? 'no' : 'yes',
  };
  return { text, meta, risk, lead };
}

/**
 * One delivery as sym_receive shows it, and the count it lands in. Never throws: a delivery that
 * cannot be rendered costs one line, never the batch.
 */
function receiveLine(d, ctx) {
  const { policy, selfNodeId, now = Date.now(), pushed = false } = ctx;
  try {
    const j = judgeDelivery(d, { policy, selfNodeId });
    if (j.bucket === 'unverified') return { bucket: 'unverified', line: unverifiedLine(d), audit: [`unverified:${d.withheld || 'unverified'}`, {}] };
    if (j.bucket === 'own') return { bucket: 'own', id: d.id };
    if (j.bucket === 'not-allowed') return { bucket: 'not-allowed', who: whoOf(d, ctx) };
    if (j.bucket === 'withheld') return { bucket: 'withheld', line: withheldLine(d.id, whoOf(d, ctx), j.verdict), audit: [j.verdict.reason, j.verdict.counts] };
    const age = Math.round((now - (d.receivedAt || now)) / 1000);
    const lead = leadText(d);
    const memTag = (d.directed && d.remixed === false && d.kind === 'cmb' ? ' ·not-stored' : '') + (pushed ? ' ·pushed' : '');
    const tail = `${memTag}${payloadTag(j.prepared)}${hiddenFieldsTag(d.categories)}`;
    const risk = scanClassifierRisk(riskText(lead, signedBody(d, j.prepared)));
    const tag = deliveryTag(d, ctx);
    if (risk.risky) {
      return { bucket: 'shown', line: `${quarantineHeader(tag.slice(1, -1), '', risk.terms.length, tail)} [${d.id}]${keyTag(d)} (${age}s ago)`, audit: ['classifier-risk', { flagged: risk.terms.length }] };
    }
    return { bucket: 'shown', line: `${tag} ${escapeLead(lead, RECEIVE_LEAD_CHARS)}${tail} [${d.id}]${keyTag(d)} (${age}s ago)` };
  } catch {
    return { bucket: 'withheld', line: withheldLine(d && d.id, 'a sender', { reason: 'render-failed', detail: 'this node could not render it' }), audit: ['render-failed', {}] };
  }
}

const KEY_SOURCE_SAID = {
  pinned: 'pinned out of band (an invite or the configured anchor)',
  anchor: 'the configured anchor',
  proven: 'proven by a Core Secure session with it',
  grant: 'vouched by a grant rooted at the anchor',
  session: 'proven by the session that delivered it',
};

/** The account sym_fetch gives before a delivery's body: everything verified, in full. */
function fetchHead(d, ctx) {
  const f = d.facts;
  const when = new Date(d.receivedAt || Date.now()).toISOString();
  const lines = [`[${d.id}] ${deliveryTag(d, ctx)} · ${when}`];
  if (f.signed === false) {
    // A mood frame (MMP §9.3): no record, nothing signed. Its session proved who sent it.
    lines.push(`Sent by: ${displayName(f.signer.label)} — nodeId ${f.signer.nodeId}; key fingerprint ${fullFingerprint(f.signer.key) || 'unknown'}, the key its Core Secure session proved. The label and the nodeId are the sender's own choice; the key is what this node verified.`);
    lines.push(`Unsigned: a mood frame carries no signed record, so nothing in it is a signature. It came sealed on that peer's own session${f.deliverer && f.deliverer.transport ? `, over ${f.deliverer.transport}` : ''}, which is what attributes it.`);
    lines.push('Memory: a mood frame — delivered, never stored, nothing to cite.');
    return lines.join('\n');
  }
  lines.push(`Signed by: ${displayName(f.signer.label)} — nodeId ${f.signer.nodeId}; key fingerprint ${fullFingerprint(f.signer.key) || 'unknown'}; the key is ${KEY_SOURCE_SAID[f.signer.keySource] || (f.signer.keySource ? `bound (${f.signer.keySource})` : 'bound')}. The label and the nodeId are the signer's own choice; the key is what this node verified.`);
  lines.push(f.relayed && f.deliverer
    ? `Delivered: relayed by ${displayName(f.deliverer.label)} — nodeId ${f.deliverer.nodeId}, key fingerprint ${fullFingerprint(f.deliverer.key) || 'unknown'}, over ${f.deliverer.transport || 'a session'}. The record's signature is the author's, over the seven CAT7 texts and the signed metadata shown here.`
    : `Delivered: directly by its author's own session${f.deliverer && f.deliverer.transport ? `, over ${f.deliverer.transport}` : ''}.`);
  lines.push(f.audience === 'directed' ? 'Audience: directed to this node (the signed recipient is this node\'s nodeId).' : `Audience: room-bound, room "${displayName(f.room ?? 'default')}".`);
  if (d.kind === 'mood') lines.push('Memory: this node\'s SVAF rejected the record, so it was not stored; only its mood was delivered (MMP §9.3).');
  else if (d.kind === 'message') lines.push('Memory: a message — delivered, never stored.');
  else lines.push(`Memory: ${d.remixed === false ? 'delivered only, not stored in this node\'s memory' : 'admitted to this node\'s memory'}.`);
  const key = d.key || f.key;
  lines.push(`Record: key ${key || '(none given)'} · assertion ${f.assertionId} · ${f.suite || 'suite not given'}`);
  if (Array.isArray(f.parents) && f.parents.length) lines.push(`Lineage: it cites ${f.parents.join(', ')}.`);
  if (key) lines.push(`Cite it: parents ["${key}"] (or ["${d.id}"]) when you respond to it (MMP §14.3).`);
  return lines.join('\n');
}

/** A fence for one fetch: peer text cannot close it, because it does not know the nonce. */
function newFence(id) {
  const nonce = crypto.randomBytes(6).toString('hex');
  return { open: `----- BEGIN PEER TEXT ${id} ${nonce} -----`, close: `----- END PEER TEXT ${id} ${nonce} -----` };
}

/**
 * One sym_recall hit (design D9, review L3): this node's own record only when its signed author is this
 * node's own nodeId (and it was not received from a peer, or was verified as this node's when it was);
 * a peer's record only when it was verified on admission. The lead is escaped as on every surface.
 */
function recallLine(r, ctx) {
  const { policy, selfName, selfNodeId } = ctx;
  const md = (r.cmb && r.cmb.metadata) || {};
  const authorId = r.author && typeof r.author.nodeId === 'string' ? r.author.nodeId.toLowerCase() : null;
  const signed = typeof md.createdByNodeId === 'string' ? md.createdByNodeId.toLowerCase() : null;
  const own = !!selfNodeId && ((signed === selfNodeId && (r.peerId === null || r.peerId === undefined) && !authorId) || (authorId === selfNodeId && r.verified === true));
  if (!own && (r.verified !== true || !authorId)) return { bucket: 'unverified' };
  const keys = keyBook(ctx);
  const who = own ? `${displayName(selfName)} (this node)` : keys.tag({ key: r.author.key, label: r.author.name, nodeId: authorId });
  const head = `[${who}] ${r.timestamp || r.storedAt ? new Date(r.timestamp || r.storedAt).toISOString() : ''}`;
  const key = r.key ? ` key ${r.key}` : '';
  try {
    const cats = r.cmb && r.cmb.categories;
    const focusV = cats && cats.focus;
    const focus = String((focusV && typeof focusV === 'object' ? focusV.text : focusV) ?? '');
    const verdict = policy.judge({ from: own ? null : authorId, categories: cats, payload: r.cmb && r.cmb.payload }, { self: own });
    if (!verdict.show) return { line: `${head}${key}\n  withheld · ${reasonWord(verdict.reason)} — ${verdict.detail}`, audit: [verdict.reason, verdict.counts] };
    const risk = scanClassifierRisk(focus);
    if (risk.risky) return { line: `${head}${key}\n  ${escapeLead(neutralizeSurface(focus), RECALL_LEAD_CHARS)} [${risk.terms.length} flagged term(s) defanged]`, audit: ['classifier-risk', { flagged: risk.terms.length }] };
    return { line: `${head}${key}\n  ${escapeLead(focus, RECALL_LEAD_CHARS)}` };
  } catch {
    return { line: `${head}${key}\n  withheld · render-failed — this node could not render it`, audit: ['render-failed', {}] };
  }
}

/** The sym_receive answer. "Caught up" only when the batch held no delivery at all. */
function receiveReport({ shown, withheld, unverified = [], notAllowed, own = [], alreadyRead = [], alreadyPushed = [], remaining, peek }) {
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
  if (shown.length) parts.push('Each line: [signer label ⟨…key fingerprint⟩ →you|→room (via relay)] "escaped lead". sym_fetch <id> gives the full verification and the signed text; reply with sym_send {to: "<id>", parents: ["<id>"]}.');
  return parts.join('\n\n');
}

function readOffset(raw) {
  if (raw === undefined || raw === null || raw === '') return { offset: 0 };
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 0) {
    return { error: `sym_fetch offset must be a whole number of characters from the start of the message (0 or more); got ${JSON.stringify(raw)}. No lookup was attempted.` };
  }
  return { offset: n };
}

/**
 * One part of a message for sym_fetch; every part says which characters it holds. With `fence`, the
 * part's slice of peer text sits between the fence's markers.
 */
function fetchPart({ id, head, body, offset = 0, pageChars = FETCH_PAGE_CHARS, fence = null }) {
  const total = body.length;
  if (offset > 0 && offset >= total) return { error: `offset ${offset} is past the end of ${id}, which is ${fmt(total)} characters long.` };
  const wrap = (t) => (fence ? `${fence.open}\n${t}\n${fence.close}` : t);
  if (offset === 0 && total <= pageChars) return { text: `${head}\n\n${wrap(body)}`, last: true };
  let start = offset;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start]) && /[\uD800-\uDBFF]/.test(body[start - 1])) start--;
  let end = Math.min(total, start + pageChars);
  if (end < total && /[\uD800-\uDBFF]/.test(body[end - 1])) end = end - 1 > start ? end - 1 : end + 1;
  const where = `characters ${fmt(start + 1)}–${fmt(end)} of ${fmt(total)}`;
  const tail = end >= total ? `— ${where}: the end of ${id}.` : `— ${where}. The rest: sym_fetch {"msg_id": "${id}", "offset": ${end}}`;
  return { text: `${head}\n\n${wrap(body.slice(start, end))}\n\n${tail}`, last: end >= total };
}

module.exports = {
  INJECTION_PATTERNS, DEFAULT_MAX_PAYLOAD_BYTES, FETCH_PAGE_CHARS, PUSH_LEAD_CHARS, RECEIVE_LEAD_CHARS,
  readMaxPayloadBytes, DEFAULT_RATE_LIMIT, readRateLimit, readAllowedPeers, RISK_SCAN_CHARS, riskText,
  prepare, payloadBytes, payloadTag, createDeliveryPolicy, createRateLimiter, pushAction,
  displayName, escapeLead, leadText, signedBody, deliveryTag, withheldLine, unverifiedLine, auditLine,
  keyTag, judgeDelivery, pushOf, receiveLine, fetchHead, newFence, recallLine, receiveReport, readOffset, fetchPart,
};
