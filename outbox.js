'use strict';

// outbox.js — hold a directed envelope AT THE SENDER when the peer is not connected.
//
// WHY THIS EXISTS, and why it is here rather than in the daemon.
//
// A directed send to an absent peer used to be refused inside this package, in
// sym_send's `matches.length === 0` branch, BEFORE anything was sent. No envelope
// left mesh-channel — so a correct, well-tested delivery spool in sym-daemon sat
// downstream of a message that was never sent. The refusal lived in the seam
// between two test suites: mesh-channel's cannot see the daemon, the daemon's
// cannot see mesh-channel.
//
// The daemon spool cannot serve seats yet, and that is measured rather than
// assumed: mesh-channel has ZERO references to register-agent/daemon.sock, and
// the daemon log carries ZERO hosted-agent registrations for any seat against
// 109 for the ops agents. Seats are standalone SymNodes. So for seat-to-seat the
// envelope is held HERE, by the sender, which needs no registration at all.
//
// WHAT THIS IS NOT. It is not delivery. The queue is invisible to the receiver —
// nobody but this process knows the message exists. If this node never comes
// back, the message is gone. Every surface therefore says HELD, never
// "delivered", and an unflushed queue is reported loudly rather than pending
// quietly. Its weakness is the mirror of the daemon spool's: this fails when the
// SENDER is the intermittent one.
//
// KNOWN vs UNKNOWN is the guard against a typo creating state. A name is known
// only if THIS node has actually seen it as a peer, recorded when the peer was
// observed. `identity.json exists on disk` was rejected as the test: it is true
// for 961 of 962 node directories here, so it admits essentially everything.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_ITEMS = 200;
const MAX_BYTES = 8 * 1024 * 1024;   // count is the wrong instrument alone: CMB size varies hugely

function baseDir(nodeName) {
  return path.join(os.homedir(), '.sym', 'nodes', nodeName);
}
function outboxFile(nodeName) { return path.join(baseDir(nodeName), 'outbox.json'); }
function rosterFile(nodeName) { return path.join(baseDir(nodeName), 'known-peers.json'); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Atomic: a torn write here loses mail that the sender has already promised to
// hold, which is the one thing this module exists to prevent.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ── Known-peer roster ────────────────────────────────────────
// Written when a peer is actually observed. Proves the name connected to us at
// some point, rather than merely existing somewhere on disk.
function rememberPeer(nodeName, peerName, peerId) {
  if (!peerName) return;
  const roster = readJson(rosterFile(nodeName), {});
  if (roster[peerName] && roster[peerName].peerId === peerId) return;   // no churn
  roster[peerName] = { peerId: peerId || null, lastSeen: null };
  writeJsonAtomic(rosterFile(nodeName), roster);
}

function isKnownPeer(nodeName, name) {
  if (!name) return false;
  const roster = readJson(rosterFile(nodeName), {});
  if (roster[name]) return true;
  return Object.values(roster).some(v => v && v.peerId === name);
}

// ── Outbox ───────────────────────────────────────────────────
function load(nodeName) {
  const d = readJson(outboxFile(nodeName), { seq: 0, items: [] });
  if (!Array.isArray(d.items)) d.items = [];
  if (typeof d.seq !== 'number') d.seq = 0;
  return d;
}

/**
 * Hold an envelope for a peer that is not currently connected.
 * @returns {{held: true, seq: number, queued: number} | {held: false, reason: string}}
 */
function hold(nodeName, to, fields, opts) {
  const d = load(nodeName);
  const bytes = Buffer.byteLength(JSON.stringify({ fields, opts }));
  if (bytes > MAX_BYTES) return { held: false, reason: 'envelope-too-large' };

  const used = Buffer.byteLength(JSON.stringify(d.items));
  // Refuse rather than evict. Evicting here would drop mail the sender already
  // said it was holding — silently, and only for the sender to know.
  if (d.items.length >= MAX_ITEMS || used + bytes > MAX_BYTES) {
    return { held: false, reason: 'outbox-full' };
  }

  d.seq += 1;
  d.items.push({ seq: d.seq, to, fields, opts: opts || {}, heldAt: null });
  writeJsonAtomic(outboxFile(nodeName), d);
  return { held: true, seq: d.seq, queued: d.items.length };
}

function pendingFor(nodeName, to) {
  return load(nodeName).items.filter(i => i.to === to);
}

function summary(nodeName) {
  const d = load(nodeName);
  const byPeer = {};
  for (const i of d.items) byPeer[i.to] = (byPeer[i.to] || 0) + 1;
  return { total: d.items.length, byPeer, bytes: Buffer.byteLength(JSON.stringify(d.items)) };
}

/**
 * Remove items for a peer once they have actually been sent.
 * Called only AFTER a successful send — never on dispatch.
 */
function drop(nodeName, seqs) {
  const set = new Set(seqs);
  const d = load(nodeName);
  d.items = d.items.filter(i => !set.has(i.seq));
  writeJsonAtomic(outboxFile(nodeName), d);
  return d.items.length;
}

module.exports = {
  hold, pendingFor, summary, drop,
  rememberPeer, isKnownPeer,
  outboxFile, rosterFile,
  MAX_ITEMS, MAX_BYTES,
};
