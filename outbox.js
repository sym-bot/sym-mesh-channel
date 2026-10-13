'use strict';

// outbox.js — hold a directed CMB AT THE SENDER while its recipient has no session, by nodeId.
//
// WHAT THIS IS NOT. It is not delivery. The queue is invisible to the recipient: nobody but this
// process knows the record waits. If this node never comes back, the record is gone. Every surface
// therefore says HELD, never "delivered", and a queue that is not flushing is reported loudly.
//
// KEYED BY NODE ID (design D6). A name is a label the sender chose, so it is never a route: the
// queue holds only for a nodeId this node has had a Core Secure session with: the node host records a
// nodeId here from `peer-joined` only when `peers()` shows that nodeId's session as a proven Core
// Secure one (peer-joined does not say which profile the session has). An unknown
// nodeId is refused rather than held, so a typo creates no state.
//
// A held item the SDK refuses to send when the peer returns is marked STUCK with the reason, and is
// reported as stuck, never as waiting (design D7). Both files are 0600: they hold what this agent said.
//
// It lives in the node's own directory (sym 0.14: `nodes/by-id/<nodeId>/`), which sym's migration
// moved there with the rest of a 0.13 node's files. A 0.10 item addressed by NAME is converted
// through the 0.10 roster's recorded id when it has one; otherwise it stays, reported as held for a
// label that is not a route, for the operator to discard.

const fs = require('fs');
const path = require('path');
const { isNodeId } = require('./identity.js');

const MAX_ITEMS = 200;
const MAX_BYTES = 8 * 1024 * 1024;   // count is the wrong instrument alone: CMB size varies hugely

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Atomic and private: a torn write here loses mail the sender has already promised to hold, and the
// queue holds what this agent said (review L9).
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on platforms without modes */ }
  fs.renameSync(tmp, file);
}

/** Days an item has been held, or null for one stamped before heldAt was populated. */
function ageDays(item, now = Date.now()) {
  return typeof item.heldAt === 'number' ? Math.floor((now - item.heldAt) / 86_400_000) : null;
}

/**
 * The outbox of the node whose directory is `dir`.
 */
function createOutbox(dir) {
  const outboxFile = path.join(dir, 'outbox.json');
  const rosterFile = path.join(dir, 'known-peers.json');

  // ── Known peers: nodeIds this node has had a proven session with ──
  // 0.10 wrote { "<name>": { peerId, lastSeen } }; 0.11 writes { version: 2, peers: { "<nodeId>":
  // { label, lastSeen } } }. A 0.10 roster is read for its ids, and its names are kept only to convert
  // held items.
  function loadRoster() {
    const raw = readJson(rosterFile, {});
    if (raw && raw.version === 2 && raw.peers && typeof raw.peers === 'object') return { peers: raw.peers, byOldName: raw.byOldName || {} };
    const peers = {};
    const byOldName = {};
    for (const [name, v] of Object.entries(raw || {})) {
      const id = v && isNodeId(v.peerId) ? v.peerId.toLowerCase() : null;
      if (!id) continue;
      peers[id] = { label: name, lastSeen: v.lastSeen || null };
      byOldName[name] = id;
    }
    return { peers, byOldName };
  }
  function saveRoster(r) { writeJsonAtomic(rosterFile, { version: 2, peers: r.peers, byOldName: r.byOldName }); }

  function rememberPeer(nodeId, label) {
    if (!isNodeId(nodeId)) return;
    const id = nodeId.toLowerCase();
    const r = loadRoster();
    const prev = r.peers[id];
    if (prev && prev.label === (label || prev.label) && prev.lastSeen && Date.now() - prev.lastSeen < 3_600_000) return;   // no churn
    r.peers[id] = { label: typeof label === 'string' ? label.slice(0, 256) : (prev && prev.label) || '', lastSeen: Date.now() };
    saveRoster(r);
  }

  function isKnown(nodeId) {
    return isNodeId(nodeId) && !!loadRoster().peers[nodeId.toLowerCase()];
  }

  function knownLabel(nodeId) {
    const p = isNodeId(nodeId) ? loadRoster().peers[nodeId.toLowerCase()] : null;
    return p ? p.label : null;
  }

  // ── The queue ──
  function load() {
    const d = readJson(outboxFile, { seq: 0, items: [] });
    if (!Array.isArray(d.items)) d.items = [];
    if (typeof d.seq !== 'number') d.seq = 0;
    let changed = false;
    let roster = null;
    for (const it of d.items) {
      if (!it) continue;
      // The pre-rename key (0.9): a load-time migration, not a runtime fallback.
      if (it.fields !== undefined && it.categories === undefined) { it.categories = it.fields; delete it.fields; changed = true; }
      // A 0.10 item addressed by name: converted through the old roster's id, or marked as a label.
      if (!isNodeId(it.to) && !it.label) {
        roster = roster || loadRoster();
        const id = roster.byOldName[it.to];
        if (id) { it.label = it.to; it.to = id; } else { it.label = it.to; it.to = null; }
        changed = true;
      }
    }
    if (changed) { try { writeJsonAtomic(outboxFile, d); } catch { /* converted again next load */ } }
    return d;
  }

  /**
   * Hold a CMB for a nodeId that has no session now.
   * @returns {{held: true, seq: number, queued: number} | {held: false, reason: string}}
   */
  function hold(to, envelope) {
    if (!isNodeId(to)) return { held: false, reason: 'not-a-node-id' };
    const d = load();
    const item = { to: to.toLowerCase(), label: knownLabel(to) || '', categories: envelope.categories, parents: envelope.parents || [], payload: envelope.payload };
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (bytes > MAX_BYTES) return { held: false, reason: 'envelope-too-large' };
    const used = Buffer.byteLength(JSON.stringify(d.items));
    // Refuse rather than evict: evicting would drop mail the sender already said it was holding.
    if (d.items.length >= MAX_ITEMS || used + bytes > MAX_BYTES) return { held: false, reason: 'outbox-full' };
    d.seq += 1;
    d.items.push({ seq: d.seq, ...item, heldAt: Date.now() });
    writeJsonAtomic(outboxFile, d);
    return { held: true, seq: d.seq, queued: d.items.length };
  }

  /** Items held for `nodeId`, oldest first. */
  function pendingFor(nodeId) {
    if (!isNodeId(nodeId)) return [];
    const id = nodeId.toLowerCase();
    return load().items.filter((i) => i.to === id);
  }

  /** Items a 0.10 build held for a name this node cannot map to a nodeId. */
  function heldForLabel(label) {
    return load().items.filter((i) => i.to === null && i.label === label);
  }

  function summary(now = Date.now()) {
    const d = load();
    const byPeer = {};
    const byLabelOnly = {};
    let oldestDays = null;
    for (const i of d.items) {
      if (i.to) {
        const k = i.to;
        byPeer[k] = byPeer[k] || { count: 0, label: i.label || '', stuck: 0, stuckReason: null };
        byPeer[k].count++;
        if (i.stuck) { byPeer[k].stuck++; byPeer[k].stuckReason = i.stuck.reason; }
      } else {
        byLabelOnly[i.label] = (byLabelOnly[i.label] || 0) + 1;
      }
      const age = ageDays(i, now);
      if (age !== null && (oldestDays === null || age > oldestDays)) oldestDays = age;
    }
    return { total: d.items.length, byPeer, byLabelOnly, oldestDays, bytes: Buffer.byteLength(JSON.stringify(d.items)) };
  }

  /** Mark an item the SDK refused to send: it stays held, and is reported as stuck with the reason. */
  function markStuck(seq, reason) {
    const d = load();
    const it = d.items.find((i) => i.seq === seq);
    if (!it) return false;
    it.stuck = { reason: String(reason || 'refused').slice(0, 300), at: Date.now() };
    writeJsonAtomic(outboxFile, d);
    return true;
  }
  function clearStuck(seq) {
    const d = load();
    const it = d.items.find((i) => i.seq === seq);
    if (!it || !it.stuck) return false;
    delete it.stuck;
    writeJsonAtomic(outboxFile, d);
    return true;
  }

  /** Remove items once they have actually been sent — never on dispatch alone. */
  function drop(seqs) {
    const set = new Set(seqs);
    const d = load();
    d.items = d.items.filter((i) => !set.has(i.seq));
    writeJsonAtomic(outboxFile, d);
    return d.items.length;
  }

  return { hold, pendingFor, heldForLabel, summary, drop, markStuck, clearStuck, rememberPeer, isKnown, knownLabel, outboxFile, rosterFile };
}

module.exports = { createOutbox, ageDays, MAX_ITEMS, MAX_BYTES };
