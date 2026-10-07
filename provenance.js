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
 * MESSAGES AND MOODS. sym raises these as events, not inbox entries, and since 569cad5 each event
 * carries the same frozen `verified`, `profile`, `verification` and `session` facts as an inbox entry,
 * by the same names. A message, and a mood from a record that verified, are gated by the rule above,
 * as an entry is. Nothing is joined or looked up: the key is the one the facts name.
 *
 * A MOOD FRAME is not a record: nothing in it is signed. sym gives it `verification: null` and the
 * facts of the Core Secure session it travelled sealed on, which means "this session's proven peer
 * sent it". `gateSessionMood` attributes it to that peer, by the key the session proved, and marks
 * the facts `signed: false`; every surface says it is unsigned. A mood frame without those facts, or
 * on a Legacy Import session, is withheld.
 */

const { NODE_ID_RE } = require('./identity.js');

/** The reasons a delivery is not shown as verified, in the words every surface uses. Our words only. */
const WITHHELD_REASONS = Object.freeze({
  'legacy-import': 'it arrived on a Legacy Import session: quarantined and unverified (sym design D7)',
  unverified: 'the node did not mark it verified',
  'no-provenance': 'it carries no Core Secure provenance (received before this node ran Core Secure, or from an SDK that does not record it)',
  'facts-mismatch': 'its verification facts do not match the delivery\'s own author, so this node cannot say who signed it',
  'mood-unattributed': 'it is a mood with neither a signed record nor a proven session behind it, so this node cannot say who sent it',
});

const text = (v, max = 256) => (typeof v === 'string' ? v.slice(0, max) : null);
const nodeId = (v) => (typeof v === 'string' && NODE_ID_RE.test(v) ? v.toLowerCase() : null);

/**
 * The facts a line may show, built from `{ verification, session, record }` (a `verified-record`
 * event, or the same fields on an entry). Plain data. Null without a signer nodeId and an assertion id.
 */
function factsFrom({ verification, session, record, key = null } = {}) {
  const v = verification || {};
  const s = session || {};
  const md = (record && record.metadata) || {};
  const signer = nodeId(v.authorNodeId);
  const assertionId = text(v.assertionId, 128) || text(md.assertionId, 128);
  if (!signer || !assertionId) return null;
  const deliverer = nodeId(s.nodeId);
  return {
    signed: true,
    assertionId,
    key: text(md.key, 128) || text(key, 128),
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

/**
 * The facts an entry carries itself, or null. An inbox item (`inbox()`, `inboxGet()`) and an interior
 * delivery item carry `record`, the signed projection; a `cmb-accepted` entry carries `cmb`.
 */
function entryFacts(entry) {
  if (!entry || typeof entry !== 'object' || !entry.verification || typeof entry.verification !== 'object') return null;
  return factsFrom({ verification: entry.verification, session: entry.session, record: entry.record || entry.cmb || { metadata: { assertionId: entry.assertionId } }, key: entry.key });
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
 * A mood frame (no record): `{ facts }` with `signed: false`, attributed to the proven peer of the
 * session it travelled sealed on, or `{ withheld }`. The event must say it is not a verified record
 * (`verified: false`, `verification: null`), carry the session's facts on Core Secure, and name that
 * session's peer as its sender and deliverer.
 */
function gateSessionMood(m) {
  if (!m || typeof m !== 'object') return { withheld: 'mood-unattributed' };
  const sess = m.session && typeof m.session === 'object' ? m.session : null;
  if (m.profile === 'legacy-import' || (sess && sess.profile === 'legacy-import')) return { withheld: 'legacy-import' };
  if (m.verified !== false || m.verification !== null || !sess || m.profile !== 'core-secure' || sess.profile !== 'core-secure') return { withheld: 'mood-unattributed' };
  const peer = nodeId(sess.nodeId);
  const key = text(sess.identityKey, 128);
  const by = m.deliveredBy && typeof m.deliveredBy === 'object' ? nodeId(m.deliveredBy.nodeId) : null;
  if (!peer || !key || nodeId(m.authorNodeId) !== peer || by !== peer) return { withheld: 'mood-unattributed' };
  const who = { nodeId: peer, label: text(sess.name, 256) || '', keySource: 'session', key };
  return {
    facts: {
      signed: false, assertionId: null, key: null, suite: null, room: text(sess.room, 256), audience: 'room', to: null,
      signer: who,
      deliverer: { nodeId: peer, label: who.label, key, transport: sess.transport === 'relay' ? 'relay' : (sess.transport === 'lan' ? 'lan' : text(sess.transport, 16)) },
      parents: [], relayed: false, anchor: false,
    },
  };
}

module.exports = { factsFrom, entryFacts, gate, gateSessionMood, WITHHELD_REASONS };
