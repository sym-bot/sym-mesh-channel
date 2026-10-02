'use strict';

/**
 * delivery-facts.js — what the node verified about each delivery, kept until the delivery is shown.
 *
 * A delivery is two facts from two public sym 0.14 events (design D2):
 *   - VERIFIED: `verified-record` { record, session, verification } fires once §8.8.5 has passed,
 *     before admission. It says who signed, with which key and where that key came from, the
 *     audience, the room, and which proven session delivered the record.
 *   - DELIVERED: `cmb-accepted` (an admitted room-bound record, or a directed one surfaced whatever
 *     SVAF decided, §9.2.2) and `message` (a directed message record). They carry no verification.
 *
 * `verified-record` cannot be the feed on its own: a room-bound record SVAF rejects MUST NOT be
 * surfaced (§9.2.2), and the hook fires before SVAF decides. So the facts wait here, keyed by the
 * record's assertion identity (§8.8.2: one authenticated assertion; two authors who say the same
 * words share a cognition key but never an assertion id), and are attached when the delivery comes.
 *
 * The SDK's inbox is durable and this map is not, so the facts of every inbox delivery are written
 * beside the inbox (in the node's directory). A restarted channel still knows who signed each
 * delivery that waits there. An inbox delivery with no facts is never shown: its reason is
 * recorded instead (legacy-import, before-core-secure, unverified).
 *
 * The SDK gap this works around (design §6 item 2): inbox items do not carry the verification.
 */

const fs = require('fs');
const path = require('path');

const PENDING_MAX = 2048;
const PENDING_TTL_MS = 10 * 60 * 1000;
const LEDGER_MAX = 1000;
const LEDGER_FILE = 'deliveries.json';

/** The reasons a delivery has no verification facts, in the words every surface uses. */
const WITHHELD_REASONS = Object.freeze({
  'legacy-import': 'it arrived on a Legacy Import session: quarantined and unverified (sym design D7)',
  'before-core-secure': 'it was received before this node ran Core Secure (sym 0.14), so nothing verified it',
  unverified: 'no Core Secure verification was given for it, so this node cannot say who signed it',
});

const { NODE_ID_RE } = require('./identity.js');
const text = (v, max = 256) => (typeof v === 'string' ? v.slice(0, max) : null);
const nodeId = (v) => (typeof v === 'string' && NODE_ID_RE.test(v) ? v.toLowerCase() : null);

/**
 * The facts a host may show, built from one `verified-record` event (or the same shape served by a
 * node's interior). Plain JSON, primitives only, so it persists and renders without the record.
 * Returns null when the event does not carry what verification means: a signer nodeId and an
 * assertion id.
 */
function factsFrom(event) {
  if (!event || typeof event !== 'object') return null;
  const v = event.verification || {};
  const s = event.session || {};
  const md = (event.record && event.record.metadata) || {};
  const signer = nodeId(v.authorNodeId);
  const assertionId = text(v.assertionId, 128) || text(md.assertionId, 128);
  if (!signer || !assertionId) return null;
  const deliverer = nodeId(s.nodeId);
  return {
    assertionId,
    key: text(md.key, 128),
    suite: text(v.suite, 64),
    room: text(v.room ?? md.room, 256),
    audience: v.audience === 'directed' ? 'directed' : 'room',
    to: nodeId(v.to),
    signer: {
      nodeId: signer,
      label: text(v.authorName ?? md.createdBy, 256) || '',
      keySource: text(v.authorKeySource, 32),
      key: text(v.authorKey, 128),
    },
    deliverer: deliverer ? {
      nodeId: deliverer,
      label: text(s.name, 256) || '',
      transport: s.transport === 'relay' ? 'relay' : (s.transport === 'lan' ? 'lan' : text(s.transport, 16)),
      profile: text(s.profile, 32),
    } : null,
    // The record's own lineage (§14.3): what it cites, so the reader can follow the conversation.
    parents: Array.isArray(md.lineage && md.lineage.parents) ? md.lineage.parents.filter((k) => typeof k === 'string').slice(0, 16).map((k) => k.slice(0, 128)) : [],
    relayed: v.relayed === true || (!!deliverer && deliverer !== signer),
    anchor: v.anchor === true,
    verifiedAt: Date.now(),
  };
}

/**
 * @param {object} opts
 * @param {string|null} opts.dir — where the ledger persists (the node's directory); null keeps it in memory
 * @param {number} [opts.inboxSeq] — the inbox's seq now, recorded once as the start of Core Secure here
 * @param {function} [opts.now]
 */
function createFactsLedger({ dir = null, inboxSeq = 0, now = Date.now } = {}) {
  const pending = new Map(); // assertionId → { facts, at, record mood text }
  let byInbox = new Map();   // inbox id → facts | { withheld: reason }
  let coreSecureSinceSeq = null;
  const file = dir ? path.join(dir, 'mesh-channel', LEDGER_FILE) : null;
  let writeTimer = null;

  if (file) {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.version === 1) {
        if (Number.isSafeInteger(d.coreSecureSinceSeq)) coreSecureSinceSeq = d.coreSecureSinceSeq;
        if (d.byInbox && typeof d.byInbox === 'object') byInbox = new Map(Object.entries(d.byInbox));
      }
    } catch { /* first run, or unreadable: start empty, and the start of Core Secure is now */ }
  }
  if (coreSecureSinceSeq === null) {
    coreSecureSinceSeq = Number.isSafeInteger(inboxSeq) ? inboxSeq : 0;
    persistSoon();
  }

  function writeNow() {
    if (!file) return;
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, coreSecureSinceSeq, byInbox: Object.fromEntries(byInbox) }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* best effort: the facts stay in memory for this process */ }
  }
  function persistSoon() {
    if (!file || writeTimer) return;
    writeTimer = setTimeout(writeNow, 500);
    if (writeTimer.unref) writeTimer.unref();
  }

  function sweep(t) {
    for (const [k, p] of pending) {
      if (t - p.at <= PENDING_TTL_MS && pending.size <= PENDING_MAX) break;
      pending.delete(k);
    }
  }

  return {
    /** `verified-record`: keep the facts until the delivery comes (or they age out). */
    noteVerified(event) {
      const facts = factsFrom(event);
      if (!facts) return null;
      const mood = event.record && event.record.categories && event.record.categories.mood;
      const t = now();
      pending.delete(facts.assertionId);
      pending.set(facts.assertionId, { facts, at: t, mood: mood && typeof mood.text === 'string' ? mood.text : null, attached: false });
      sweep(t);
      return facts;
    },

    /** The facts of the assertion `assertionId`, if they were verified here. */
    take(assertionId) {
      const p = typeof assertionId === 'string' ? pending.get(assertionId) : null;
      if (!p) return null;
      p.attached = true;
      return p.facts;
    },

    /**
     * Attach facts to an inbox id, or record why there are none. `facts` null means none were given;
     * `profile` (the entry's own) says whether that is a Legacy Import quarantine.
     */
    recordInbox(inboxId, facts, { profile } = {}) {
      if (typeof inboxId !== 'string' || !inboxId) return;
      let v = facts;
      if (!v) v = { withheld: profile === 'legacy-import' ? 'legacy-import' : 'unverified' };
      byInbox.delete(inboxId);
      byInbox.set(inboxId, v);
      while (byInbox.size > LEDGER_MAX) byInbox.delete(byInbox.keys().next().value);
      persistSoon();
    },

    /**
     * What is known about an inbox item: { facts } or { withheld: reason }. An item this ledger never
     * saw is `before-core-secure` when its seq predates this ledger, otherwise `unverified`.
     */
    forInbox(item) {
      const id = item && item.id;
      const v = id ? byInbox.get(id) : undefined;
      if (v && v.withheld) return { withheld: v.withheld };
      if (v) return { facts: v };
      const seq = item && Number.isSafeInteger(item.seq) ? item.seq : null;
      return { withheld: seq !== null && seq <= coreSecureSinceSeq ? 'before-core-secure' : 'unverified' };
    },

    /**
     * The one recently verified, not yet delivered record from session `fromLabel` whose mood text is
     * `moodText`, or null when there is none or more than one. The mood of a rejected record reaches
     * the host as `mood-delivered` with only the session's name (design §6 item 3): an exact join is
     * attempted, and an ambiguous one is not guessed.
     */
    moodSource(fromLabel, moodText, windowMs = 120000) {
      const t = now();
      const hits = [];
      for (const p of pending.values()) {
        if (p.attached || t - p.at > windowMs) continue;
        if (p.mood !== moodText) continue;
        if (!p.facts.deliverer || p.facts.deliverer.label !== fromLabel) continue;
        hits.push(p);
      }
      if (hits.length !== 1) return null;
      hits[0].attached = true;
      return hits[0].facts;
    },

    coreSecureSinceSeq: () => coreSecureSinceSeq,
    pendingSize: () => pending.size,
    size: () => byInbox.size,
    flush: writeNow,
  };
}

module.exports = { factsFrom, createFactsLedger, WITHHELD_REASONS, LEDGER_FILE };
