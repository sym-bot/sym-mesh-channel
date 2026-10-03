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
 * MESSAGES AND MOODS. sym raises these as events, not inbox entries, and the events carry no
 * `verification` or `session` (design §6, mismatches 3 and 4): they name the record (`key`,
 * `assertionId`), its proven author and the delivering peer by nodeId. `eventFacts` builds the same
 * facts from those names and the node's own key bindings (`node.keyBindings()`). With no binding for
 * the author there are no facts, and the delivery is withheld ('no-key-binding'). Nothing is joined
 * or kept here: the interim build's in-memory join to `verified-record` is gone.
 */

const { NODE_ID_RE } = require('./identity.js');

/** The reasons a delivery is not shown as verified, in the words every surface uses. Our words only. */
const WITHHELD_REASONS = Object.freeze({
  'legacy-import': 'it arrived on a Legacy Import session: quarantined and unverified (sym design D7)',
  unverified: 'the node did not mark it verified',
  'no-provenance': 'it carries no Core Secure provenance (received before this node ran Core Secure, or from an SDK that does not record it)',
  'facts-mismatch': 'its verification facts do not match the delivery\'s own author, so this node cannot say who signed it',
  'no-key-binding': 'the node raised it as verified but holds no key for its author now, so this node cannot say which key signed it',
  'mood-unattributed': 'it is a mood with no signed record and proven sender behind it (a mood frame, or a mood the SDK did not attribute)',
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

/**
 * The facts of a delivery sym raises as an event (a message, a mood): the record's assertion id and
 * key, its proven author and the peer that delivered it, by nodeId, and the keys this node binds to
 * them. `bindingOf(nodeId)` → `{ key, source }` or null. Null when the author has no binding here.
 */
function eventFacts({ assertionId, key, authorNodeId, authorLabel, delivererNodeId, delivererLabel, transport, audience, bindingOf }) {
  const signer = nodeId(authorNodeId);
  const aid = text(assertionId, 128);
  if (!signer || !aid || typeof bindingOf !== 'function') return null;
  const sb = bindingOf(signer);
  if (!sb || typeof sb.key !== 'string' || !sb.key) return null;
  const deliverer = nodeId(delivererNodeId);
  const db = deliverer ? bindingOf(deliverer) : null;
  return {
    assertionId: aid,
    key: text(key, 128),
    suite: null,
    room: null,
    audience: audience === 'directed' ? 'directed' : 'room',
    to: null,
    signer: { nodeId: signer, label: text(authorLabel, 256) || '', keySource: text(sb.source, 32), key: text(sb.key, 128) },
    deliverer: deliverer ? { nodeId: deliverer, label: text(delivererLabel, 256) || '', key: db && typeof db.key === 'string' ? text(db.key, 128) : null, transport: transport === 'relay' ? 'relay' : (transport === 'lan' || transport === 'bonjour' ? 'lan' : null) } : null,
    parents: [],
    relayed: !!deliverer && deliverer !== signer,
    anchor: false,
  };
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

module.exports = { factsFrom, entryFacts, eventFacts, gate, WITHHELD_REASONS };
