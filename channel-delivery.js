'use strict';

// channel-delivery.js — what an emit asked for, and what the node says it did (design D3, D4).
//
// THE SALT IS GONE (audit C-6.1). 0.10 re-sent identical categories with "[re-sent <time>]"
// appended to the focus when the store already held them: focus text the agent never wrote,
// signed in its name. Content-addressed dedup (§8.8.2: identical CAT7 cognition collapses to one
// key) is not an error to route around. The answer says what happened, and the agent decides
// whether it has something new to say.
//
// The node's own account decides every answer: remember()'s return, its `delivery` report, and the
// metric events it emits during the call. Nothing is inferred from peers() or from a local set.

const { isNodeId } = require('./identity.js');

const CMB_KEY_RE = /^cmb-[0-9a-f]{64}$/;
const DELIVERY_ID_RE = /^(in\d{4,}|m\d{3,})$/;
const CAT7_TEXT = ['focus', 'issue', 'intent', 'motivation', 'commitment', 'perspective'];
const MAX_PARENTS = 16;

/**
 * The CAT7 categories exactly as the caller gave them. A category left out is left out, and the SDK
 * records it as `neutral`, the canonical empty value (§14.3.2). 0.10 invented 'directive',
 * 'observation', 'none' and the node's own name for missing categories, and receivers weighed those
 * words in SVAF; a mood's valence and arousal invented as 0 claimed a measured neutral.
 */
function givenCategories(args) {
  const out = {};
  for (const f of CAT7_TEXT) {
    if (typeof args[f] === 'string' && args[f]) out[f] = args[f];
  }
  if (args.mood && typeof args.mood === 'object' && !Array.isArray(args.mood)) {
    const m = {};
    if (typeof args.mood.text === 'string' && args.mood.text) m.text = args.mood.text;
    for (const k of ['valence', 'arousal']) if (typeof args.mood[k] === 'number' && Number.isFinite(args.mood[k])) m[k] = args.mood[k];
    if (m.text) out.mood = m;
  } else if (typeof args.mood === 'string' && args.mood) out.mood = { text: args.mood };
  return out;
}

/**
 * `parents` as the node takes them: CMB keys. A delivery id (in0042, m007) is resolved to its key by
 * `resolve(id)` → key | null. Returns { keys } or { error } — an unresolvable parent is refused before
 * anything is minted, so lineage is never silently dropped.
 */
function resolveParents(raw, resolve) {
  if (raw === undefined || raw === null) return { keys: [] };
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list)) return { error: 'parents must be a list of CMB keys or delivery ids, e.g. ["in0042"] or ["cmb-…"]' };
  if (list.length > MAX_PARENTS) return { error: `parents takes at most ${MAX_PARENTS} entries; got ${list.length}` };
  const keys = [];
  for (const p of list) {
    const s = typeof p === 'string' ? p.trim() : '';
    if (CMB_KEY_RE.test(s)) { if (!keys.includes(s)) keys.push(s); continue; }
    if (DELIVERY_ID_RE.test(s)) {
      const k = resolve(s);
      if (!k) return { error: `parent ${s} is not a delivery this server can resolve to a CMB key (unknown, expired, or withheld). Pass its key instead (sym_fetch ${s} shows it), or leave it out.` };
      if (!keys.includes(k)) keys.push(k);
      continue;
    }
    return { error: `parent ${JSON.stringify(String(p).slice(0, 80))} is neither a CMB key (cmb- and 64 hex) nor a delivery id (in0042, m007)` };
  }
  return { keys };
}

/**
 * `to` as the node routes it: a nodeId. A delivery id stands for that delivery's VERIFIED signer
 * (`signerOf(id)` → nodeId | null). A name is never a route (design D6): it is refused, and the
 * caller is shown the nodeIds that use that label so it can choose by identity.
 * Returns { nodeId } or { error, labelMatches? }.
 */
function resolveTo(raw, { signerOf, peersLabelled } = {}) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { error: 'to is empty' };
  if (isNodeId(s)) return { nodeId: s.toLowerCase() };
  if (DELIVERY_ID_RE.test(s)) {
    const id = signerOf ? signerOf(s) : null;
    if (!id) return { error: `${s} is not a delivery whose signer this server verified (unknown, expired, or withheld), so it names no one to send to.` };
    return { nodeId: id, via: s };
  }
  const matches = peersLabelled ? peersLabelled(s) : [];
  const hint = matches.length
    ? ` Connected peers that use the label ${JSON.stringify(s)}: ${matches.map((p) => p.nodeId).join(', ')}. A label is the sender's own choice and two nodes can share one; pass the nodeId you mean.`
    : ' sym_peers lists each connected peer\'s nodeId.';
  return { error: `to takes a nodeId or a delivery id (in0042), never a name: names are labels, not routes (MMP §8.8.4).${hint}`, labelMatches: matches };
}

/**
 * What one remember() did, from the node's own account (design D4).
 *   entry   — remember()'s return
 *   metrics — the metric types the node emitted during the call
 *   directed — whether the call had `to`
 */
function emitOutcome(entry, metrics, directed) {
  const m = new Set(metrics || []);
  if (!entry) {
    if (m.has('remix-rejected')) return { outcome: 'remix-refused' };
    return { outcome: 'already-in-memory' };
  }
  const key = entry.key || entry.cmb?.metadata?.key || null;
  const assertionId = entry.cmb?.metadata?.assertionId || null;
  const d = entry.delivery;
  if (directed) {
    if (d && d.undelivered) return { outcome: 'undelivered', key, assertionId, reason: d.reason || null };
    return { outcome: 'sent', key, assertionId, dispatched: d ? d.dispatched : null, duplicate: entry.duplicate === true || entry.collapsed === true };
  }
  if (entry.collapsed) return { outcome: 'already-said', key };
  if (d && typeof d.dispatched === 'number') {
    return d.dispatched > 0 ? { outcome: 'published', key, assertionId, dispatched: d.dispatched } : { outcome: 'no-peers', key, assertionId };
  }
  return { outcome: 'published', key, assertionId, dispatched: null };
}

const NOT_SENT_SAID = {
  'not-connected': 'the recipient has no session with this node',
  'too-large': 'its frame is over the transport\'s size bound',
  'write-failed': 'the write to the session failed',
  'send-failed': 'the send failed',
  unsealable: 'it is not a signed v2.0 record',
  'queue-full': 'the relay send queue is full',
};

// The SDK's refusals to build or sign a record (sym 0.14): ECMBSIZE (a category, the record or its
// frame over a bound), ESIGN (the key could not sign), and the plain errors remember() and createCMB
// throw before anything is stored or sent. Matched by code, then by message for the plain ones.
const MINT_REFUSAL = /^(?:createCMB\b|CMB requires categories|remember\(\) requires|mmp-sig-v2(?:\.0)?: |mmp-app-v1: )/;
const SENDING_TOOLS = new Set(['sym_send', 'sym_publish']);

/**
 * "Not sent: …" as the tool's own answer, when the error a sending tool threw is the SDK refusing the
 * record; otherwise null, and the caller rethrows. Any other error is not a refusal, and "nothing
 * left this node" would be a claim about the wire it cannot make.
 */
function notSentAnswer(tool, e) {
  if (!SENDING_TOOLS.has(tool) || !(e instanceof Error)) return null;
  const coded = e.code === 'ECMBSIZE' || e.code === 'ESIGN';
  if (!coded && !(Object.getPrototypeOf(e) === Error.prototype && MINT_REFUSAL.test(String(e.message)))) return null;
  return { content: [{ type: 'text', text: `Not sent: ${e.message}. Nothing left this node.` }], isError: true };
}

/**
 * A warning for a directed send to a peer this node has not heard from lately. Peers ping every 10 s
 * when idle (MMP §5.4), so silence past STALE_AFTER_MS means the session is probably gone even though
 * the peer is still listed.
 */
const STALE_AFTER_MS = 30000;
function staleNote(peer, now = Date.now()) {
  if (!peer || !peer.lastSeen) return '';
  const age = now - peer.lastSeen;
  if (age <= STALE_AFTER_MS) return '';
  return ` Warning: nothing has arrived from this peer for ${Math.round(age / 1000)}s, so its session may already be gone; MMP has no delivery receipt to confirm arrival.`;
}

module.exports = {
  givenCategories, resolveParents, resolveTo, emitOutcome, notSentAnswer, staleNote,
  NOT_SENT_SAID, CMB_KEY_RE, DELIVERY_ID_RE, STALE_AFTER_MS, MAX_PARENTS,
};
