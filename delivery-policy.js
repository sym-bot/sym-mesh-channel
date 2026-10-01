'use strict';

/**
 * delivery-policy.js — one decision for every surface where a peer's words can reach this session:
 * the channel push, the sym_receive line, the sym_fetch body and the sym_recall line.
 *
 * THE INCIDENT (2026-09-27). A peer sent a requested strategy review as a CMB carrying a
 * 36,459-character payload. It arrived and sat in the inbox, and the receiving session never
 * learned of it: sym_receive drained it, an 8 KB payload cap withheld it, and with nothing left to
 * show the tool answered "Caught up — nothing new delivered". The push path had applied the same
 * cap and written only a stderr line. sym_fetch on the inbox id applied no check at all, so the
 * one surface that could have shown the message was also the one that ignored the filter.
 *
 * The rules that follow from it:
 *   1. A withheld delivery is NAMED: its id, its sender and our reason. It is never counted as
 *      nothing. The line carries none of the peer's text, and the sender's name is printed through
 *      displayName, because the sender chooses its name.
 *   2. Size does not reach the context until the payload is read, so a large payload is announced
 *      on the header and read in parts (sym_fetch pages it). Only a payload over this node's hard
 *      limit is withheld: SYM_MAX_PAYLOAD_BYTES, by default 1 MiB. On the local network a frame
 *      already bounds a payload at that size; a relayed delivery is bounded by this setting alone.
 *   3. The same judgement runs wherever the words would enter the context: push, receive, fetch
 *      and recall. The peer's `content` string is judged with the categories and the payload,
 *      because a fetch shows it and nothing makes it repeat the categories.
 *   4. Rate is the one check that is not about content. It measures arrival, so it is counted
 *      once per delivery, on the push, before anything is pushed (a withheld notice included), and
 *      it holds back only the push: the delivery waits in the inbox and sym_receive shows it.
 *      Counting it again at read time withheld the 31st message of any backlog read in one call.
 */

const { scanClassifierRisk, quarantineHeader } = require('./classifier-risk.js');
const { hiddenFieldsTag } = require('./surface-truth.js');

// ── Prompt-injection patterns ────────────────────────────────
// Attack model: a peer with a valid identity sends a CMB whose categories look relevant (so it
// passes SVAF) but whose text tries to take over the receiving session ("ignore previous
// instructions", persona overrides, fabricated tool calls). A match withholds the delivery on
// every surface; none of it is shown, not even in part.
const INJECTION_PATTERNS = [
  // Classic instruction overrides
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?|guidelines?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?)/i,
  /forget\s+(everything|all)\s+(you('ve)?\s+)?(know|been\s+told|learned)/i,

  // Role / persona hijacking
  /you\s+are\s+now\s+(a\s+|an\s+)?(new\s+)?(ai|assistant|model|system|gpt|claude|llm)/i,
  /act\s+as\s+(a\s+|an\s+)?(different|new|unrestricted|jailbroken|evil|rogue)/i,
  /pretend\s+(you\s+)?(are|have\s+no)\s+(restrictions?|rules?|guidelines?|ethics?)/i,
  /new\s+(persona|personality|mode|role)\s*:/i,

  // System prompt injection
  /<\s*system\s*>/i,
  /\[SYSTEM\]/,
  /##\s*system\s+prompt/i,
  /---\s*system\s*---/i,

  // Tool / function call fabrication
  /<\s*tool_call\s*>/i,
  /<\s*function_calls?\s*>/i,
  /\{"type"\s*:\s*"tool_use"/,

  // Privilege / capability escalation
  /you\s+(now\s+)?(have|possess)\s+(full|unrestricted|admin|root|elevated)\s+(access|permissions?|capabilities?)/i,
  /override\s+(safety|content|ethical?|policy)\s+(filter|check|guard|restriction)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

/** The largest payload a node accepts unless SYM_MAX_PAYLOAD_BYTES says otherwise: the bound the
 *  LAN transport already sets on one frame (@sym-bot/sym frame-parser MAX_FRAME_SIZE). A relayed
 *  delivery is not held to a frame, so for it this setting is the only bound. */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

/** The most characters of a message one sym_fetch answer carries; a longer message is read in parts
 *  with `offset`. Well inside what an MCP host takes from one tool call (Claude Code's default
 *  ceiling is 25,000 tokens), so no host cuts a part short on its own. */
const FETCH_PAGE_CHARS = 48_000;

const fmt = (n) => Number(n).toLocaleString('en-US');

/**
 * SYM_MAX_PAYLOAD_BYTES read as a positive whole number of bytes. Unset means the default; a value
 * that is not a whole number is reported back as `invalid` so the caller can say it was ignored.
 * (The old reader passed it to parseInt, and a NaN limit silently disabled the check.)
 */
function readMaxPayloadBytes(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return { bytes: DEFAULT_MAX_PAYLOAD_BYTES };
  if (!/^\d+$/.test(s) || Number(s) < 1) return { bytes: DEFAULT_MAX_PAYLOAD_BYTES, invalid: s };
  return { bytes: Number(s) };
}

// ── One delivery, serialised once ────────────────────────────

const PREPARED = Symbol('a prepared delivery');

function serialise(payload, indented) {
  if (payload === undefined || payload === null) return null;
  try { return JSON.stringify(payload, null, indented ? 2 : undefined) ?? String(payload); } catch { return String(payload); }
}

/**
 * A delivery as every check and line reads it. Its payload is serialised at most twice, however
 * many read it: compactly, for its size on the wire and the injection scan, and indented, for the
 * header's size and the fetched body. With a 1 MiB ceiling, serialising once per reader was most
 * of the cost of a sym_receive.
 */
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

/** A payload's size on the wire: the bytes of its compact JSON. */
function payloadBytes(p) {
  const s = prepare(p).compact;
  return s === null ? 0 : Buffer.byteLength(s, 'utf8');
}

/** The payload marker on a header: its size in the characters a fetch returns. */
function payloadTag(p) {
  const t = prepare(p).indented;
  return t === null ? '' : ` [+payload ${t.length}b]`;
}

/** A message body as sym_fetch returns it, for the push store and the inbox alike. */
function renderBody(content, p) {
  const t = prepare(p).indented;
  return t === null ? String(content ?? '') : `${String(content ?? '')}\n\n---PAYLOAD---\n${t}`;
}

/** Every text surface of a delivery that some surface shows: the text of each category, the peer's
 *  content string, and the payload (a string payload as itself, anything else as its JSON). */
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
 * The content policy. judge() answers { show: true } or { show: false, reason, detail, excerpt }:
 * `reason` is a stable token, `detail` is our own sentence for the session (never the peer's words),
 * and `excerpt` is for the operator's stderr audit only. `self` skips only the allowlist, for a
 * delivery under this node's own name: a name is not proof, so the content checks still run.
 */
function createDeliveryPolicy({ allowedPeers = [], maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  const allowed = new Set(allowedPeers.filter(Boolean));
  function judge(d, { self = false } = {}) {
    const p = prepare(d);
    if (!self && allowed.size && !allowed.has(p.from)) {
      return { show: false, reason: 'sender-not-allowed', detail: 'its sender is not in SYM_ALLOWED_PEERS', excerpt: '' };
    }
    const bytes = payloadBytes(p);
    if (bytes > maxPayloadBytes) {
      return {
        show: false, reason: 'payload-over-limit',
        detail: `its payload is ${fmt(bytes)} bytes, over this node's limit of ${fmt(maxPayloadBytes)} ` +
          `(SYM_MAX_PAYLOAD_BYTES; raise it and restart to fetch this one from the inbox)`,
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
  return { judge, maxPayloadBytes, allowedPeers: [...allowed] };
}

// ── The push ─────────────────────────────────────────────────

/** Per-sender arrivals in a sliding window. admit() counts one arrival and answers false once the
 *  sender is over `limit` arrivals in `windowMs`. */
function createRateLimiter({ limit = 30, windowMs = 60_000 } = {}) {
  const windows = new Map();
  return {
    limit,
    admit(peer, now = Date.now()) {
      const w = (windows.get(peer) || []).filter((t) => now - t < windowMs);
      w.push(now);
      windows.set(peer, w);
      return w.length <= limit;
    },
  };
}

/**
 * What the real-time push does with one arrival: 'silent' for a sender the allowlist keeps out
 * (nothing is pushed and nothing is counted), 'rate-held' once the sender is over the rate,
 * 'notice' for a withheld delivery (announced in our words) and 'push' for one shown. The rate is
 * counted before either kind of push, so a flood of withheld deliveries is held back like any
 * other flood (the legacy message path once pushed its notice first, with no bound).
 */
function pushAction(verdict, rate, from, now = Date.now()) {
  if (verdict.reason === 'sender-not-allowed') return 'silent';
  if (!rate.admit(from, now)) return 'rate-held';
  return verdict.show ? 'push' : 'notice';
}

// ── What the session and the operator read ───────────────────

/** A sender's name as this node prints it: no line breaks, no brackets, no control characters, at
 *  most 120 characters. A sender chooses its own name, so a raw one could forge a line. */
function displayName(name) {
  const s = String(name ?? '').replace(/[\s[\]\u0000-\u001f\u007f-\u009f]/g, '_').slice(0, 120);
  return s || 'unknown';
}

/** One withheld delivery, in our words only. */
function withheldLine(id, from, decision) {
  return `[${id}] from ${displayName(from)}: ${decision.detail}`;
}

/** The operator's stderr line for one withholding. The sender's name goes through displayName and
 *  the excerpt loses every control character and quote, so a peer can neither write lines of its
 *  own into the audit nor send escape sequences to the operator's terminal. */
function auditLine(surface, reason, peer, excerpt, id) {
  const safe = String(excerpt ?? '').replace(/[\u0000-\u001f\u007f-\u009f"]/g, ' ').slice(0, 120);
  return `[sym-security] WITHHELD surface=${surface} reason=${reason} peer=${displayName(peer)}${id ? ` id=${id}` : ''} excerpt="${safe}"\n`;
}

/**
 * One inbox delivery as sym_receive shows it, and the count it lands in: 'shown', 'withheld',
 * 'not-allowed' or 'own-name'. It never throws: a delivery this node cannot render is withheld with
 * that reason, so one bad message costs one line and never the batch the drain has already taken.
 * `audit` is [reason, excerpt] when the operator's log should record the decision.
 */
function receiveLine(m, { policy, selfName, now = Date.now(), pushed = false }) {
  try {
    // Under this node's own name: an echo of its own words, or a node using its name. Counted, never
    // silently dropped, since the name alone cannot tell the two apart.
    if (m.from === selfName) return { bucket: 'own-name' };
    const p = prepare({ from: m.from, content: m.content, categories: m.categories, payload: m.payload });
    const verdict = policy.judge(p);
    if (verdict.reason === 'sender-not-allowed') return { bucket: 'not-allowed' };
    // `label` is what to print (the claimed author, and the deliverer when different); `from` is the
    // deliverer every decision above was made on.
    if (!verdict.show) return { bucket: 'withheld', line: withheldLine(m.id, m.label || m.from, verdict), audit: [verdict.reason, verdict.excerpt] };
    const name = displayName(m.label || m.from);
    const age = Math.round((now - m.receivedAt) / 1000);
    const focus = String(m.categories?.focus?.text || m.content || '');
    const dirTag = m.directed ? ' →you' : '';
    // The same delivery already went out as a <channel> push under this id. Said, not hidden: the
    // server cannot tell whether that push reached the session, so the line still appears.
    const memTag = (m.directed && m.remixed === false ? ' ·not-stored' : '') + (pushed ? ' ·pushed' : '');
    const payTag = payloadTag(p);
    // The push's classifier-risk quarantine, over the text the push scans, so one delivery gets one
    // verdict on both surfaces; this line enters the context the same way a push does.
    const risk = scanClassifierRisk(`${focus}\n${renderBody(m.content || focus, p)}`);
    if (risk.risky) {
      return { bucket: 'shown', line: `${quarantineHeader(name, dirTag, risk.terms.length, `${memTag}${payTag}${hiddenFieldsTag(m.categories)}`)} [${m.id}] (${age}s ago)`, audit: [`classifier-risk:${risk.terms.join(',')}`, focus] };
    }
    const flat = focus.replace(/\s+/g, ' ');
    const cutTag = flat.length > 90 ? '…' : '';
    // m053: this line shows the focus' first 90 chars and NOTHING of the other fields — a bare-focus
    // CMB and one hauling 1.4KB of commitment were indistinguishable here, and a receiver replied to
    // the header. The elision is explicit.
    return { bucket: 'shown', line: `[${name}${dirTag}] ${flat.slice(0, 90)}${cutTag}${memTag}${payTag}${hiddenFieldsTag(m.categories)} [${m.id}] (${age}s ago)` };
  } catch {
    return { bucket: 'withheld', line: withheldLine(m && m.id, m && m.from, { detail: 'this node could not render it' }), audit: ['render-failed', ''] };
  }
}

/**
 * One sym_recall hit. A memory is text the session reads like any delivery, so a peer's memory passes
 * the same policy: withheld, the line shows the sender and our reason and none of its text. A memory
 * under this node's own name skips only the allowlist. (Recall has no fetch path, so a line is not
 * quarantined for wording: the agent asked for these memories, and a quarantined line could never
 * be read.)
 */
function recallLine(r, { policy, selfName }) {
  const sender = r.source || r.cmb?.createdBy || 'unknown';
  const head = `[${displayName(r.label || sender)}] ${r.timestamp ? new Date(r.timestamp).toLocaleString() : ''}`;
  try {
    const verdict = policy.judge({ from: sender, content: r.content, categories: r.cmb?.categories, payload: r.cmb?.payload }, { self: sender === selfName });
    if (!verdict.show) return { line: `${head}\n  withheld: ${verdict.detail}`, audit: [verdict.reason, verdict.excerpt] };
    const focus = String(r.cmb?.categories?.focus?.text || r.content || '');
    const cut = focus.length > 150 ? '… [truncated — sym_fetch for full]' : '';
    return { line: `${head}\n  ${focus.slice(0, 150)}${cut}` };
  } catch {
    return { line: `${head}\n  withheld: this node could not render it`, audit: ['render-failed', ''] };
  }
}

/**
 * The sym_receive answer. "Caught up" is said only when the batch held no delivery at all; every
 * delivery drained is shown, withheld with its reason, counted against the allowlist by sender, or
 * counted as sent under this node's own name, so a withheld message is never reported as none.
 *
 * @param {object} r
 * @param {string[]} r.shown        rendered lines for the deliveries shown
 * @param {string[]} r.withheld     withheldLine() for each delivery withheld on its content
 * @param {Map<string,number>} r.notAllowed  sender → count, for deliveries kept out by SYM_ALLOWED_PEERS
 * @param {number} [r.ownName]      deliveries under this node's own name
 * @param {string[]} [r.alreadyRead] ids of deliveries the session already read in full with sym_fetch
 * @param {number} r.remaining      deliveries past this batch
 * @param {boolean} r.peek
 */
function receiveReport({ shown, withheld, notAllowed, ownName = 0, alreadyRead = [], remaining, peek }) {
  const kept = [...notAllowed.values()].reduce((a, b) => a + b, 0);
  const more = remaining > 0 ? ` (+${remaining} more — call sym_receive again)` : '';
  const peekTag = peek ? ' (peek — not drained)' : '';
  const readLine = alreadyRead.length
    ? `Already read with sym_fetch, not repeated: ${alreadyRead.length} (${alreadyRead.join(', ')}).`
    : '';
  if (!shown.length && !withheld.length && !kept && !ownName) {
    // Never "caught up" while a next batch is waiting (the 2026-09-27 failure, review F3).
    if (readLine) return remaining > 0 ? `No delivery in this batch${peekTag}${more}. ${readLine}` : `Caught up — nothing unread${peekTag}. ${readLine}`;
    return remaining > 0
      ? `No delivery in this batch${peekTag}${more}.`
      : 'Caught up — nothing new delivered since your last sym_receive.';
  }
  const parts = [];
  if (shown.length) parts.push(`${shown.length} new mesh message(s)${peekTag}${more}:\n${shown.join('\n')}`);
  else parts.push(`No message to show${peekTag}${more}: ${withheld.length + kept + ownName} delivered and not shown.`);
  if (withheld.length) parts.push(`Withheld — delivered to this node, not shown:\n${withheld.join('\n')}`);
  if (kept) {
    const who = [...notAllowed].map(([n, c]) => `${displayName(n)} ×${c}`).join(', ');
    parts.push(`Not shown, sender outside SYM_ALLOWED_PEERS: ${kept} (${who}).`);
  }
  if (ownName) parts.push(`Not shown, sent under this node's own name: ${ownName} (an echo of this node's own words, or another node using its name).`);
  if (readLine) parts.push(readLine);
  if (shown.length) parts.push('Use sym_fetch <id> for full content; reply via sym_send to=<peer>.');
  return parts.join('\n\n');
}

/**
 * sym_fetch's `offset`: absent means the start; otherwise a whole number of characters (a numeric
 * string is accepted, since hosts differ in how they pass numbers). Anything else is a malformed
 * call, answered as one.
 */
function readOffset(raw) {
  if (raw === undefined || raw === null || raw === '') return { offset: 0 };
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 0) {
    return { error: `sym_fetch offset must be a whole number of characters from the start of the message (0 or more); got ${JSON.stringify(raw)}. No lookup was attempted.` };
  }
  return { offset: n };
}

/**
 * One part of a message for sym_fetch. A message that fits one part is returned whole, exactly as
 * before. A longer one is returned FETCH_PAGE_CHARS at a time, and every part says which characters
 * it holds (counted from 1, both ends included) and the offset that reads the rest, so a long
 * payload is never cut without saying so.
 */
function fetchPart({ id, head, body, offset = 0, pageChars = FETCH_PAGE_CHARS }) {
  const total = body.length;
  if (offset > 0 && offset >= total) {
    return { error: `offset ${offset} is past the end of ${id}, which is ${fmt(total)} characters long.` };
  }
  // `last`: this answer ends the message, so the caller may treat it as read in full.
  if (offset === 0 && total <= pageChars) return { text: `${head}\n\n${body}`, last: true };
  // Never split a surrogate pair at either end: a character cut in half is lost from both parts.
  // An offset from this tool is always a boundary; a typed one may land inside a pair.
  let start = offset;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start])) start--;
  let end = Math.min(total, start + pageChars);
  if (end < total && /[\uD800-\uDBFF]/.test(body[end - 1])) end = end - 1 > start ? end - 1 : end + 1;
  const where = `characters ${fmt(start + 1)}–${fmt(end)} of ${fmt(total)}`;
  const tail = end >= total
    ? `— ${where}: the end of ${id}.`
    : `— ${where}. The rest: sym_fetch {"msg_id": "${id}", "offset": ${end}}`;
  return { text: `${head}\n\n${body.slice(start, end)}\n\n${tail}`, last: end >= total };
}

module.exports = {
  INJECTION_PATTERNS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  FETCH_PAGE_CHARS,
  readMaxPayloadBytes,
  prepare,
  payloadBytes,
  payloadTag,
  renderBody,
  createDeliveryPolicy,
  createRateLimiter,
  pushAction,
  displayName,
  withheldLine,
  auditLine,
  receiveLine,
  recallLine,
  receiveReport,
  readOffset,
  fetchPart,
};
