'use strict';

/**
 * provenance.js — whether a delivery may be shown as verified, decided from the delivery itself
 * (design D2; review H1, L2, L5).
 *
 * PROVENANCE TRAVELS WITH THE DELIVERY. The SDK hands the channel each delivery as an entry that
 * carries what the node verified about it (design §6 item 1): `verified`, `profile`, `assertionId`,
 * `verification`, `session` and `author`. The channel renders those facts and keeps no second store
 * of them (v1's ledger is deleted). An entry is shown as verified only when its own fields say so:
 *
 *   1. it is not a Legacy Import record                       (else 'legacy-import')
 *   2. entry.verified === true                                 (else 'unverified')
 *   3. entry.profile === 'core-secure'                         (else 'no-provenance')
 *   4. it has facts, with the signer's key                     (else 'no-provenance')
 *   5. the facts' author nodeId is entry.author.nodeId, and the facts' key is entry.author.key when
 *      the entry carries one                                   (else 'facts-mismatch')
 *   6. the facts' delivering session is entry.author.via.nodeId when both are given
 *                                                              (else 'facts-mismatch')
 *
 * UNTIL THE SDK LANDS (interim). sym 0.14 at 341dafb puts no facts on the entry, so the facts come from
 * `verified-record`, held in memory by assertion id — but they are used only through the same checks
 * against the entry, so a quarantined entry that carries a verified record's assertion id is withheld
 * (review r2). A second `verified-record` for one assertion never replaces the first; the candidate
 * whose session delivered the admitted copy is chosen (r11). Nothing is persisted: after a restart an
 * entry the SDK did not stamp with facts is 'no-provenance'.
 */

const { NODE_ID_RE } = require('./identity.js');

const PENDING_MAX = 2048;
const PENDING_TTL_MS = 10 * 60 * 1000;
const LIVE_MAX = 1000;

/** The reasons a delivery is not shown as verified, in the words every surface uses. Our words only. */
const WITHHELD_REASONS = Object.freeze({
  'legacy-import': 'it arrived on a Legacy Import session: quarantined and unverified (sym design D7)',
  unverified: 'the node did not mark it verified',
  'no-provenance': 'it carries no Core Secure provenance (received before this node ran Core Secure, or from an SDK that does not record it)',
  'facts-mismatch': 'its verification facts do not match the delivery\'s own author, so this node cannot say who signed it',
  'mood-unattributed': 'it is a mood with no signed record and proven sender behind it (a mood frame, or a mood the SDK did not attribute)',
});

const text = (v, max = 256) => (typeof v === 'string' ? v.slice(0, max) : null);
const nodeId = (v) => (typeof v === 'string' && NODE_ID_RE.test(v) ? v.toLowerCase() : null);

/**
 * The facts a line may show, built from `{ verification, session, record }` (a `verified-record`
 * event, or the same fields on an entry). Plain data. Null without a signer nodeId and an assertion id.
 */
function factsFrom({ verification, session, record } = {}) {
  const v = verification || {};
  const s = session || {};
  const md = (record && record.metadata) || {};
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
    signer: { nodeId: signer, label: text(v.authorName ?? md.createdBy, 256) || '', keySource: text(v.authorKeySource, 32), key: text(v.authorKey, 128) },
    deliverer: deliverer ? { nodeId: deliverer, label: text(s.name, 256) || '', key: text(s.identityKey, 128), transport: s.transport === 'relay' ? 'relay' : (s.transport === 'lan' ? 'lan' : text(s.transport, 16)) } : null,
    parents: Array.isArray(md.lineage && md.lineage.parents) ? md.lineage.parents.filter((k) => typeof k === 'string').slice(0, 16).map((k) => k.slice(0, 128)) : [],
    relayed: v.relayed === true || (!!deliverer && deliverer !== signer),
    anchor: v.anchor === true,
  };
}

/** The facts an entry carries itself (the SDK this round), or null. */
function entryFacts(entry) {
  if (!entry || typeof entry !== 'object' || !entry.verification || typeof entry.verification !== 'object') return null;
  return factsFrom({ verification: entry.verification, session: entry.session, record: entry.cmb || entry.record || { metadata: { key: entry.key, assertionId: entry.assertionId } } });
}

/** Steps 1-6 above: `{ facts }`, or `{ withheld: reason }`. */
function gate(entry, facts) {
  if (!entry || typeof entry !== 'object') return { withheld: 'unverified' };
  if (entry.profile === 'legacy-import') return { withheld: 'legacy-import' };
  if (entry.verified !== true) return { withheld: entry.verified === undefined && entry.profile === undefined ? 'no-provenance' : 'unverified' };
  if (entry.profile !== 'core-secure') return { withheld: 'no-provenance' };
  if (!facts || !facts.signer || !facts.signer.key) return { withheld: 'no-provenance' };
  const author = entry.author || {};
  if (nodeId(author.nodeId) !== facts.signer.nodeId) return { withheld: 'facts-mismatch' };
  if (typeof author.key === 'string' && author.key && author.key !== facts.signer.key) return { withheld: 'facts-mismatch' };
  const via = author.via && nodeId(author.via.nodeId);
  if (via && facts.deliverer && via !== facts.deliverer.nodeId) return { withheld: 'facts-mismatch' };
  return { facts };
}

/**
 * The interim join (until the SDK puts facts on the entry). `noteVerified` holds a verified record's
 * facts by assertion id, first copy first; `take(entry)` returns the facts for the delivered copy;
 * `live` keeps, for this process only, what was decided for an inbox id, because sym 0.14's inbox()
 * items carry no facts to decide again from.
 */
function createInterimJoin({ now = Date.now } = {}) {
  const pending = new Map();   // assertionId → { at, candidates: [facts…], record mood text }
  const live = new Map();      // inbox id → { facts } | { withheld }

  function sweep(t) {
    for (const [k, p] of pending) {
      if (t - p.at <= PENDING_TTL_MS && pending.size <= PENDING_MAX) break;
      pending.delete(k);
    }
  }

  return {
    noteVerified(event) {
      const facts = factsFrom(event || {});
      if (!facts) return null;
      const t = now();
      const p = pending.get(facts.assertionId);
      if (p) {
        // A second copy (a relay forwarding it, a reconnect replay) never replaces the first (r11).
        if (!p.candidates.some((c) => c.deliverer && facts.deliverer && c.deliverer.nodeId === facts.deliverer.nodeId)) p.candidates.push(facts);
        return facts;
      }
      pending.set(facts.assertionId, { at: t, candidates: [facts] });
      sweep(t);
      return facts;
    },

    /** The facts for the copy `entry` describes: the candidate its own `author.via` delivered, else the first. */
    take(entry) {
      const aid = entry && (entry.assertionId || (entry.cmb && entry.cmb.metadata && entry.cmb.metadata.assertionId));
      const p = typeof aid === 'string' ? pending.get(aid) : null;
      if (!p) return null;
      const via = entry.author && entry.author.via && nodeId(entry.author.via.nodeId);
      const pick = (via && p.candidates.find((c) => c.deliverer && c.deliverer.nodeId === via)) || p.candidates[0];
      pending.delete(aid);
      return pick;
    },

    /** The facts of a record that was verified and NOT admitted (a rejected record's mood). */
    peek(assertionId) {
      const p = typeof assertionId === 'string' ? pending.get(assertionId) : null;
      return p ? p.candidates[0] : null;
    },

    recordLive(inboxId, verdict) {
      if (typeof inboxId !== 'string' || !inboxId) return;
      live.delete(inboxId);
      live.set(inboxId, verdict);
      while (live.size > LIVE_MAX) live.delete(live.keys().next().value);
    },
    live(inboxId) { return live.get(inboxId) || null; },
    pendingSize: () => pending.size,
  };
}

module.exports = { factsFrom, entryFacts, gate, createInterimJoin, WITHHELD_REASONS };
