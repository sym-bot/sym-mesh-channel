'use strict';

// provenance.js — a delivery is shown as verified only when its own facts make it so (design D2; review
// H1, L2, L5). The rule; the facts read from the entry (sym persists them with the inbox item); the
// facts of a message or a mood, built from the event and the node's key bindings; and the two repros
// the old join answered, now answered by the entry itself: r2 (a quarantined record carrying a verified
// record's assertion id) and r11 (a relayed second copy renaming the admitted copy's session).

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { gate, entryFacts, eventFacts, factsFrom, WITHHELD_REASONS } = require('../provenance.js');

const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
const C = '01a0fd15-52ca-7111-8222-0a1b2c3d4e5f';
const L = '01a0fd15-52ca-7444-8444-0000000000aa';
const KA = crypto.randomBytes(32).toString('base64url');
const KC = crypto.randomBytes(32).toString('base64url');
const KEY = `cmb-${'1'.repeat(64)}`;
const ev = ({ aid = 'asrt-1', author = A, authorKey = KA, via = A, viaKey = KA } = {}) => ({
  record: { categories: { focus: { text: 'f' } }, metadata: { key: KEY, assertionId: aid, createdBy: 'alice' } },
  session: { nodeId: via, name: via === A ? 'alice' : 'carol', identityKey: viaKey, transport: 'lan' },
  verification: { suite: 'mmp-sig-v2.0', assertionId: aid, authorNodeId: author, authorName: 'alice', authorKey, authorKeySource: 'proven', audience: 'room', room: 'r', relayed: via !== author },
});
const entry = (over = {}) => ({ verified: true, profile: 'core-secure', assertionId: 'asrt-1', cmb: { metadata: { key: KEY, assertionId: 'asrt-1' } }, author: { name: 'alice', nodeId: A, via: { name: 'alice', nodeId: A } }, ...over });

test('an entry passes only with verified, core-secure, facts with a key, and a matching author and session', () => {
  const f = factsFrom(ev());
  assert.ok(gate(entry(), f).facts);
  assert.deepStrictEqual(gate(entry({ profile: 'legacy-import', verified: false }), f), { withheld: 'legacy-import' });
  assert.deepStrictEqual(gate(entry({ verified: false }), f), { withheld: 'unverified' });
  assert.deepStrictEqual(gate(entry({ verified: undefined, profile: undefined }), f), { withheld: 'no-provenance' }, 'a 0.13 entry');
  assert.deepStrictEqual(gate(entry({ profile: undefined }), f), { withheld: 'no-provenance' });
  assert.deepStrictEqual(gate(entry(), null), { withheld: 'no-provenance' });
  assert.deepStrictEqual(gate(entry(), factsFrom(ev({ authorKey: null }))), { withheld: 'no-provenance' }, 'facts without the signer key identify no one');
  assert.deepStrictEqual(gate(entry({ author: { nodeId: C, via: { nodeId: A } } }), f), { withheld: 'facts-mismatch' });
  assert.deepStrictEqual(gate(entry({ author: { nodeId: A, key: KC, via: { nodeId: A } } }), f), { withheld: 'facts-mismatch' });
  assert.deepStrictEqual(gate(entry({ author: { nodeId: A, via: { nodeId: C } } }), f), { withheld: 'facts-mismatch' });
  for (const r of Object.keys(WITHHELD_REASONS)) assert.ok(WITHHELD_REASONS[r].length > 20);
});

test('facts that travel on the entry are read from it and gated the same way; the signed projection is the record', () => {
  const e = { ...entry(), verification: ev().verification, session: ev().session };
  const f = entryFacts(e);
  assert.strictEqual(f.signer.key, KA);
  assert.ok(gate(e, f).facts);
  assert.strictEqual(entryFacts(entry()), null, 'no verification on the entry: no facts from it');
  // An inbox item carries `record` (the signed projection) and `key`; its lineage is read from it.
  const parent = `cmb-${'7'.repeat(64)}`;
  const item = { ...entry(), cmb: undefined, key: KEY, verification: ev().verification, session: ev().session,
    record: { categories: { focus: { text: 'f', meta: {} } }, metadata: { key: KEY, assertionId: 'asrt-1', lineage: { parents: [parent] } } } };
  const fi = entryFacts(item);
  assert.strictEqual(fi.key, KEY);
  assert.deepStrictEqual(fi.parents, [parent]);
});

test('r2: a quarantined entry that carries a verified record\'s assertion id is withheld: its own fields decide', () => {
  // sym persists a Legacy Import entry with verified:false, profile 'legacy-import' and no facts; even
  // with a verified record's facts beside it, the entry's own profile withholds it.
  const legacy = { verified: false, profile: 'legacy-import', verification: null, session: null, assertionId: null,
    cmb: { metadata: { key: `cmb-${'2'.repeat(64)}`, assertionId: 'asrt-alice-real', signatureSuite: 'mmp-sig-v2.0' } }, author: { name: 'alice', nodeId: null, via: { name: 'old-box', nodeId: L } } };
  assert.deepStrictEqual(gate(legacy, entryFacts(legacy)), { withheld: 'legacy-import' });
  assert.deepStrictEqual(gate(legacy, factsFrom(ev({ aid: 'asrt-alice-real' }))), { withheld: 'legacy-import' });
});

test('r11: the admitted copy names its own delivering session; a relayed copy\'s session is not taken for it', () => {
  const fromAlice = { ...entry(), verification: ev().verification, session: ev({ via: A, viaKey: KA }).session };
  assert.strictEqual(gate(fromAlice, entryFacts(fromAlice)).facts.deliverer.nodeId, A);
  assert.strictEqual(entryFacts(fromAlice).relayed, false);
  const viaCarol = { ...entry({ author: { name: 'alice', nodeId: A, via: { name: 'carol', nodeId: C } } }), verification: ev({ via: C, viaKey: KC }).verification, session: ev({ via: C, viaKey: KC }).session };
  assert.strictEqual(gate(viaCarol, entryFacts(viaCarol)).facts.deliverer.nodeId, C, 'the admitted copy was carol\'s');
  // Facts whose session is not the one the entry names are a mismatch, not a rename.
  assert.deepStrictEqual(gate(fromAlice, entryFacts(viaCarol)), { withheld: 'facts-mismatch' });
});

test('a message\'s or a mood\'s facts are built from the event and the node\'s key bindings; no binding, no facts', () => {
  const bindings = new Map([[A, { key: KA, source: 'pinned' }], [C, { key: KC, source: 'session' }]]);
  const bindingOf = (id) => bindings.get(id) || null;
  const f = eventFacts({ assertionId: 'asrt-m', key: KEY, authorNodeId: A, authorLabel: 'alice', delivererNodeId: C, delivererLabel: 'carol', transport: 'relay', audience: 'directed', bindingOf });
  assert.deepStrictEqual(f.signer, { nodeId: A, label: 'alice', keySource: 'pinned', key: KA });
  assert.deepStrictEqual(f.deliverer, { nodeId: C, label: 'carol', key: KC, transport: 'relay' });
  assert.strictEqual(f.relayed, true);
  assert.strictEqual(f.audience, 'directed');
  assert.strictEqual(f.key, KEY);
  assert.strictEqual(eventFacts({ assertionId: 'asrt-m', authorNodeId: L, bindingOf }), null, 'an author this node binds no key to');
  assert.strictEqual(eventFacts({ assertionId: null, authorNodeId: A, bindingOf }), null, 'no assertion: nothing names the record');
  assert.strictEqual(eventFacts({ assertionId: 'asrt-m', authorNodeId: 'alice', bindingOf }), null, 'a label is not a nodeId');
  assert.ok(WITHHELD_REASONS['no-key-binding']);
});

test('there is no join and no second store', () => {
  const src = require('node:fs').readFileSync(require.resolve('../provenance.js'), 'utf8');
  assert.ok(!/writeFile|mkdirSync|new Map\(/.test(src), 'nothing kept here');
  assert.ok(!('createInterimJoin' in require('../provenance.js')));
});

test('only the signed parts of a record are carried: the seven CAT7 texts and sym\'s payload schema, nothing beside them', () => {
  const { signedParts, PAYLOAD_SCHEMA } = require('../signed-parts.js');
  const data = Buffer.from(JSON.stringify({ ticket: 7 })).toString('base64url');
  const record = {
    categories: { focus: { text: 'f', meta: { key: 'k' } }, mood: { text: 'calm', valence: 0.9, arousal: 0.1 }, evil: { text: 'NOT-SIGNED' }, intent: 'plain string' },
    metadata: { key: KEY, application: { schema: PAYLOAD_SCHEMA, mediaType: 'application/json', encoding: 'base64url', byteLength: 12, digest: 'x', data } },
  };
  const parts = signedParts(record);
  assert.deepStrictEqual(parts.categories, { focus: { text: 'f' }, intent: { text: 'plain string' }, mood: { text: 'calm' } });
  assert.deepStrictEqual(parts.payload, { ticket: 7 });
  const other = signedParts({ ...record, metadata: { application: { ...record.metadata.application, schema: 'https://example.org/other' } } });
  assert.strictEqual(other.payload, null, 'another schema is not a payload');
  assert.deepStrictEqual(signedParts(null), { categories: {}, payload: null });
});
