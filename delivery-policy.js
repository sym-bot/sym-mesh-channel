'use strict';

/**
 * delivery-policy.js — one decision for every surface where a peer's words can reach this session:
 * the channel push, the sym_receive line and the sym_fetch body.
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
 *      nothing. The line carries none of the peer's text, because keeping that out is what
 *      withholding is for.
 *   2. Size does not reach the context until the payload is read, so a large payload is announced
 *      on the header and read in parts (sym_fetch pages it). Only a payload over this node's hard
 *      limit is withheld: SYM_MAX_PAYLOAD_BYTES, by default 1 MiB, the bound the LAN transport
 *      already sets on one frame.
 *   3. The same judgement runs wherever the words would enter the context: push, receive and
 *      fetch. The peer's `content` string is judged with the categories and the payload, because
 *      a fetch shows it and nothing makes it repeat the categories.
 *   4. Rate is the one check that is not about content. It measures arrival, so it is counted
 *      once per delivery, on the push, and it holds back only the push: the delivery waits in the
 *      inbox and sym_receive shows it. Counting it again at read time withheld the 31st message of
 *      any backlog read in one call, and counted every delivery twice.
 */

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
 *  LAN transport already sets on one frame (@sym-bot/sym frame-parser MAX_FRAME_SIZE). */
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

/** A payload's size on the wire: the bytes of its compact JSON. */
function payloadBytes(payload) {
  if (payload === undefined || payload === null) return 0;
  let s;
  try { s = JSON.stringify(payload); } catch { s = String(payload); }
  return Buffer.byteLength(s ?? '', 'utf8');
}

/** A payload as sym_fetch shows it: indented JSON, or the string itself. */
function payloadText(payload) {
  if (payload === undefined || payload === null) return null;
  try { return JSON.stringify(payload, null, 2) ?? String(payload); } catch { return String(payload); }
}

/** The payload marker on a header: its size in the characters a fetch returns. */
function payloadTag(payload) {
  const t = payloadText(payload);
  return t === null ? '' : ` [+payload ${t.length}b]`;
}

/** A message body as sym_fetch returns it, for the push store and the inbox alike. */
function renderBody(content, payload) {
  const t = payloadText(payload);
  return t === null ? String(content ?? '') : `${String(content ?? '')}\n\n---PAYLOAD---\n${t}`;
}

/** Every text surface of a delivery that some surface shows: each category, the peer's content
 *  string, and the payload. */
function textSurfaces({ content, categories, payload }) {
  const out = [];
  for (const v of Object.values(categories || {})) {
    const t = typeof v === 'string' ? v : (v && typeof v === 'object' && v.text != null ? String(v.text) : '');
    if (t) out.push(t);
  }
  if (typeof content === 'string' && content) out.push(content);
  if (payload !== undefined && payload !== null) {
    let s;
    try { s = typeof payload === 'string' ? payload : JSON.stringify(payload); } catch { s = String(payload); }
    if (s) out.push(s);
  }
  return out;
}

/**
 * The content policy. judge() answers { show: true } or { show: false, reason, detail, excerpt }:
 * `reason` is a stable token, `detail` is our own sentence for the session (never the peer's words),
 * and `excerpt` is for the operator's stderr audit only.
 */
function createDeliveryPolicy({ allowedPeers = [], maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  const allowed = new Set(allowedPeers.filter(Boolean));
  function judge({ from, content, categories, payload }) {
    if (allowed.size && !allowed.has(from)) {
      return { show: false, reason: 'sender-not-allowed', detail: 'its sender is not in SYM_ALLOWED_PEERS', excerpt: '' };
    }
    const bytes = payloadBytes(payload);
    if (bytes > maxPayloadBytes) {
      return {
        show: false, reason: 'payload-over-limit',
        detail: `its payload is ${fmt(bytes)} bytes, over this node's limit of ${fmt(maxPayloadBytes)} ` +
          `(SYM_MAX_PAYLOAD_BYTES; raise it and restart to fetch this one from the inbox)`,
        excerpt: `${bytes}b > ${maxPayloadBytes}b limit`,
      };
    }
    for (const surface of textSurfaces({ content, categories, payload })) {
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

/** A sender's name as printed on a line that carries none of the peer's text: no line breaks, no
 *  brackets, no control characters, at most 120 characters. */
function displayName(name) {
  const s = String(name ?? '').replace(/[\s[\]\u0000-\u001f\u007f-\u009f]/g, '_').slice(0, 120);
  return s || 'unknown';
}

/** One withheld delivery, in our words only. */
function withheldLine(id, from, decision) {
  return `[${id}] from ${displayName(from)}: ${decision.detail}`;
}

/**
 * The sym_receive answer. "Caught up" is said only when the batch held no delivery from a peer at
 * all; a delivery that was drained and not shown is listed, so a withheld message is never reported
 * as no message.
 *
 * @param {object} r
 * @param {string[]} r.shown        rendered lines for the deliveries shown
 * @param {string[]} r.withheld     withheldLine() for each delivery withheld on its content
 * @param {Map<string,number>} r.notAllowed  sender → count, for deliveries kept out by SYM_ALLOWED_PEERS
 * @param {number} r.remaining      deliveries past this batch
 * @param {boolean} r.peek
 */
function receiveReport({ shown, withheld, notAllowed, remaining, peek }) {
  const kept = [...notAllowed.values()].reduce((a, b) => a + b, 0);
  const more = remaining > 0 ? ` (+${remaining} more — call sym_receive again)` : '';
  const peekTag = peek ? ' (peek — not drained)' : '';
  if (!shown.length && !withheld.length && !kept) {
    return remaining > 0
      ? `No delivery from a peer in this batch${peekTag}${more}.`
      : 'Caught up — nothing new delivered since your last sym_receive.';
  }
  const parts = [];
  if (shown.length) parts.push(`${shown.length} new mesh message(s)${peekTag}${more}:\n${shown.join('\n')}`);
  else parts.push(`No message to show${peekTag}${more}: ${withheld.length + kept} delivered and withheld.`);
  if (withheld.length) parts.push(`Withheld — delivered to this node, not shown:\n${withheld.join('\n')}`);
  if (kept) {
    const who = [...notAllowed].map(([n, c]) => `${displayName(n)} ×${c}`).join(', ');
    parts.push(`Not shown, sender outside SYM_ALLOWED_PEERS: ${kept} (${who}).`);
  }
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
 * it holds and how to ask for the rest, so a long payload is never cut without saying so.
 */
function fetchPart({ id, head, body, offset = 0, pageChars = FETCH_PAGE_CHARS }) {
  const total = body.length;
  if (offset > 0 && offset >= total) {
    return { error: `offset ${offset} is past the end of ${id}, which is ${fmt(total)} characters long.` };
  }
  if (offset === 0 && total <= pageChars) return { text: `${head}\n\n${body}` };
  let end = Math.min(total, offset + pageChars);
  // Never split a surrogate pair: a character cut in half is a character lost from both parts.
  if (end < total && /[\uD800-\uDBFF]/.test(body[end - 1])) end--;
  const where = `characters ${fmt(offset)}–${fmt(end)} of ${fmt(total)}`;
  const tail = end >= total
    ? `— ${where}: the end of ${id}.`
    : `— ${where}. The rest: sym_fetch {"msg_id": "${id}", "offset": ${end}}`;
  return { text: `${head}\n\n${body.slice(offset, end)}\n\n${tail}` };
}

module.exports = {
  INJECTION_PATTERNS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  FETCH_PAGE_CHARS,
  readMaxPayloadBytes,
  payloadBytes,
  payloadText,
  payloadTag,
  renderBody,
  createDeliveryPolicy,
  createRateLimiter,
  displayName,
  withheldLine,
  receiveReport,
  readOffset,
  fetchPart,
};
