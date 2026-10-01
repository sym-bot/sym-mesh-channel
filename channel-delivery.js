'use strict';

// Channel-side delivery bookkeeping: who sent a delivery, which inbox item a push is, what the
// session has already read, and what a send actually did. Pure functions over the SDK's public
// surface, so they work on @sym-bot/sym 0.13.8 and use the 0.13.12 interface when it is there
// (entry.author, entry.inboxId, node.inboxAck, remember().delivery on every directed send).

/**
 * The peer that handed us a delivery: the name this node's own connection knows it by. This, not
 * the author a record names, is what the allowlist, the own-name check and the push rate key on.
 * Anyone can write any createdBy into a record, so a record claiming to be from an allowlisted
 * peer must not be let in on that claim (review F1). 0.13.12 names it in `author.via`; before that,
 * an SVAF-admitted entry's `source` is the SDK's store-local `<receiver>+<deliverer>` key, which
 * printed as "claude-sym-agent-a+claude-sym-agent-b" on agent-a's own screen — the part after our
 * own name is the deliverer.
 */
//
// The order is by how much of it the sending peer can write (delta review F2): 0.13.12's author.via
// comes from our connection; an entry's peerId, resolved through peers(), is the connection too; the
// `source` string is last, because the engine builds it from the wire frame's own `source` field when
// a frame carries one, which a hostile peer can set to any name.
function delivererOf(item, selfName, peers) {
  const via = item && item.author && item.author.via;
  if (via && typeof via.name === 'string' && via.name) return via.name;
  if (item && item.peerId && Array.isArray(peers)) {
    const p = peers.find((x) => x && x.peerId === item.peerId);
    if (p && typeof p.name === 'string' && p.name) return p.name;
  }
  const raw = String((item && (item.source ?? item.from)) || '');
  const prefix = `${selfName}+`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

/**
 * The deliverer and display label for a STORED record (sym_recall), which carries the store-local
 * `<receiver>+<deliverer>` source and the record's createdBy. On engines before 0.13.12 an admitted
 * record's createdBy was rewritten to the receiver, i.e. our own name, so that claim is not shown.
 */
function recallSender(r, selfName) {
  // A stored record that carries 0.13.12's author fields is named exactly as the push names it.
  if (r && r.author) return { from: delivererOf(r, selfName) || 'unknown', label: senderLabel(r, selfName) || 'unknown' };
  const from = delivererOf({ source: r && r.source }, selfName) || 'unknown';
  const claimed = r && r.cmb && typeof r.cmb.createdBy === 'string' ? r.cmb.createdBy : '';
  const label = claimed && claimed !== from && claimed !== selfName ? `${claimed} via ${from}` : from;
  return { from, label };
}

/**
 * The name to print for a delivery's sender. The record's author (0.13.12 `author.name`, still an
 * unverified label until the Core Secure handshake lands) and, when it is a different node, the
 * peer that delivered it — so a relayed or forged attribution is visible on the line itself.
 */
function senderLabel(item, selfName, peers) {
  const deliverer = delivererOf(item, selfName, peers);
  const author = item && item.author && typeof item.author.name === 'string' ? item.author.name : '';
  // Neither half may carry the marker itself, or "a via b" could be forged inside one name (F4).
  const plain = (x) => String(x).replace(/ via /gi, ' via_');
  return author && author !== deliverer ? `${plain(author)} via ${plain(deliverer)}` : deliverer;
}

/**
 * The inbox id of the delivery a cmb-accepted entry describes, so the push and sym_receive name
 * one message with one id. 0.13.12 stamps the id on the entry, and this package requires it. The
 * fallback is best effort for older engines only: their inbox listener runs first and synchronously
 * per delivery, so the newest item is this delivery's, built from the same entry.content compared
 * here; anything else falls back to an mNNN id rather than guessing.
 */
function inboxIdFor(n, entry) {
  if (entry && typeof entry.inboxId === 'string' && entry.inboxId) return entry.inboxId;
  try {
    const s = n.inboxStatus();
    const id = `in${String(s.seq).padStart(4, '0')}`;
    const m = n.inboxGet(id);
    if (m && m.content === (entry.content || '') && !!m.directed === !!entry.directed) return id;
  } catch { /* no inbox on this engine — the caller falls back to its own store */ }
  return null;
}

/**
 * What the session has read in full with sym_fetch. A pushed id that was fetched used to come back
 * from sym_receive under a second id and keep the unread footer lit, because the drain cursor only
 * moves in seq order. The engine's inboxAck (0.13.12) persists this; on older engines the same
 * state lives here for the life of the process. A push alone never marks anything read: when
 * channels are not enabled for this server, the push goes nowhere and the inbox is all there is.
 */
function createReadTracker() {
  const read = new Map();     // inbox id → seq, for everything read in full
  const engineAcked = new Set();   // the subset the engine accepted an inboxAck for
  return {
    markRead(n, id) {
      let acked = false;
      try { if (typeof n.inboxAck === 'function') { n.inboxAck(id); acked = true; } } catch { /* engine refused — keep local state */ }
      try {
        const m = n.inboxGet(id);
        if (m) read.set(id, m.seq);
      } catch { /* no inbox on this engine */ }
      if (acked) engineAcked.add(id);
    },
    isRead(m) {
      return !!m && (m.acked === true || read.has(m.id));
    },
    /** inboxStatus() with fetched-but-undrained items taken out of the unread count — except the
     *  ones the engine accepted an ack for, which its own count already leaves out. */
    adjust(n, s) {
      if (!s) return s;
      let fetched = 0;
      for (const [id, seq] of read) if (seq > s.cursor && !engineAcked.has(id)) fetched++;
      return fetched ? { ...s, undrained: Math.max(0, s.undrained - fetched) } : s;
    },
  };
}

/**
 * What one remember() did on the wire, from the engine's own account of it. The channel used to
 * assume a directed send reached its target because the target was in peers() — a peer whose
 * socket had already closed stays listed, so a send to a session that had just restarted came back
 * "Sent" and arrived nowhere.
 *
 *   'sent'        a frame was handed to at least one transport (no receipt exists in MMP, so this
 *                 is dispatch, not delivery)
 *   'undelivered' a directed send that reached no transport
 *   'no-peers'    a broadcast with nobody connected
 *   'collapsed'   the engine recognised its own latest record and sent nothing (0.13.8 only;
 *                 0.13.12 dispatches the stored record instead)
 *   'unknown'     an engine that reports nothing; the caller keeps its older inference
 */
function sendOutcome(entry) {
  if (!entry) return 'unknown';
  const d = entry.delivery;
  if (d && typeof d.dispatched === 'number') {
    if (d.dispatched > 0) return 'sent';
    return d.directed ? 'undelivered' : 'no-peers';
  }
  if (entry.collapsed) return 'collapsed';
  return 'unknown';
}

/**
 * A warning for a directed send to a peer we have not heard from lately. Peers ping every 10 s when
 * idle (MMP §5.4), so silence past STALE_AFTER_MS means the transport is probably gone even though
 * the peer is still listed — the state a restarted session leaves behind until its 120 s timeout.
 */
const STALE_AFTER_MS = 30000;
function staleNote(peer, now = Date.now()) {
  if (!peer || !peer.lastSeen) return '';
  const age = now - peer.lastSeen;
  if (age <= STALE_AFTER_MS) return '';
  return ` Warning: nothing has arrived from ${peer.name || 'this peer'} for ${Math.round(age / 1000)}s, so its connection may already be gone; MMP has no delivery receipt to confirm arrival.`;
}

// ── Send-path delivery integrity (E8 variant c) ──────────────────────────────
// SymNode.remember() dedups on the content hash of the CAT7 categories, returning null when
// identical categories are already in the LOCAL store. A local-store hit is NOT proof of delivery:
// a CMB stored while this node had no connected peer, or on a prior send before a reconnect, would
// block its own identical re-send forever (root-caused 2026-07-18). So we record which CMB keys
// were actually dispatched to a connected destination: a dedup against a NEVER-DISPATCHED key is
// re-issued (disambiguated with a salt), while a dedup against an already-dispatched key stays
// suppressed — no flood regression. The set is channel-internal, so it uses its own stable
// content hash, not the store's key.
const crypto = require('crypto');

function cmbContentKey(categories) {
  return crypto.createHash('sha256').update(JSON.stringify(categories)).digest('hex').slice(0, 32);
}
// Directed deliveries are tagged per (contentKey, target) so identical content can still be
// delivered to a different peer; broadcasts are tagged by content key only.
function deliveryTag(categories, targetPeerId) {
  return targetPeerId ? `${cmbContentKey(categories)}|${targetPeerId}` : cmbContentKey(categories);
}
function connectedPeerCount(n) {
  try { const s = n.status && n.status(); return (s && s.peerCount) || (n.peers && n.peers().length) || 0; }
  catch { return 0; }
}

/**
 * An explicit operator send (sym_send / sym_publish / an outbox flush). Returns
 * { text, isError?, undelivered?, entry? }. okSummary(entry, sent) builds the happy-path text so
 * each caller keeps its verb; `now` is injectable for deterministic tests.
 *
 * The engine's own account of the send (remember().delivery) decides whether anything left this
 * node. Only an engine that gives no account falls back to inference — the inference this replaced
 * called every directed send connected "by construction", which is how a send to a session that had
 * just restarted came back "Sent" and was never seen again.
 */
function explicitSend(n, delivered, categories, sendOpts, okSummary, now) {
  const stamp = now || (() => new Date().toISOString());
  const targetPeerId = sendOpts.to || null;
  const tag = (cats) => deliveryTag(cats, targetPeerId);

  // One remember(), classified. Returns a result, or null when the store deduped it.
  const attempt = (cats) => {
    const entry = n.remember(cats, sendOpts);
    const outcome = sendOutcome(entry);
    if (!entry || outcome === 'collapsed') return null;
    const sent = outcome === 'unknown'
      ? (targetPeerId ? true : connectedPeerCount(n) > 0)   // an engine with no delivery report
      : outcome === 'sent';
    if (sent) delivered.add(tag(cats));
    if (outcome === 'undelivered') {
      return {
        text: `NOT DELIVERED — the target is not connected, so no frame left this node (CMB ${entry.key} is stored locally only).`,
        undelivered: true,
        entry,
      };
    }
    return { entry, sent };
  };

  const first = attempt(categories);
  if (first) return first.undelivered ? first : { text: okSummary(first.entry, first.sent), entry: first.entry };
  if (delivered.has(tag(categories))) {
    return { text: `Duplicate — an identical CMB was already dispatched${targetPeerId ? '' : ' to the room'}, so it was not re-sent. Dispatch is not a delivery receipt; change the content to send it again.`, duplicate: true };
  }
  const salted = Object.assign({}, categories, { focus: `${categories.focus} [re-sent ${stamp()}]` });
  const retry = attempt(salted);
  if (!retry) {
    return { text: 'Send failed: the prior copy was undelivered and the disambiguated re-send did not store (persist error). Nothing broadcast.', isError: true };
  }
  if (retry.undelivered) return retry;
  // Credit the original content too: the salted copy stands for it, so the next identical send is a
  // duplicate, not another salted re-send (each with a new timestamp, so unbounded) (re-review F2).
  if (retry.sent) delivered.add(tag(categories));
  return { text: `Re-sent CMB ${retry.entry.key}${targetPeerId ? '' : ' to the room'} — a prior identical copy was in the local store but had never been delivered; content-addressed dedup would otherwise have silently suppressed this send.`, entry: retry.entry };
}

module.exports = {
  delivererOf, senderLabel, recallSender, inboxIdFor, createReadTracker, sendOutcome, staleNote, STALE_AFTER_MS,
  cmbContentKey, deliveryTag, connectedPeerCount, explicitSend,
};
