'use strict';

// provenance.js — a delivery is shown as verified only when its own facts make it so (design D2; review
// H1, L2, L5). The rule, the interim join that stands in until the SDK puts facts on the entry, and the
// two repros it answers: r2 (a quarantined record carrying a verified record's assertion id) and r11 (a
// second copy's verified-record replacing the first's facts).

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { gate, entryFacts, factsFrom, createInterimJoin, WITHHELD_REASONS } = require('../provenance.js');

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

test('facts that travel on the entry (the SDK this round) are read from it and gated the same way', () => {
  const e = { ...entry(), verification: ev().verification, session: ev().session };
  const f = entryFacts(e);
  assert.strictEqual(f.signer.key, KA);
  assert.ok(gate(e, f).facts);
  assert.strictEqual(entryFacts(entry()), null, 'no verification on the entry: no facts from it');
});

test('r2: a quarantined record that carries a verified record\'s assertion id is withheld, never shown as its author\'s', () => {
  const join = createInterimJoin();
  join.noteVerified(ev({ aid: 'asrt-alice-real' }));
  const legacy = { verified: false, profile: 'legacy-import', cmb: { metadata: { key: `cmb-${'2'.repeat(64)}`, assertionId: 'asrt-alice-real', signatureSuite: 'mmp-sig-v2.0' } }, author: { name: 'alice', nodeId: null, via: { name: 'old-box', nodeId: L } } };
  const v = gate(legacy, join.take(legacy));
  assert.deepStrictEqual(v, { withheld: 'legacy-import' });
});

test('r11: a second copy of an assertion never replaces the first; the copy that was admitted names its own session', () => {
  const join = createInterimJoin();
  join.noteVerified(ev({ via: A, viaKey: KA }));                 // alice's own copy
  join.noteVerified(ev({ via: C, viaKey: KC }));                 // carol relays the same record
  const fromAlice = join.take(entry());                           // the admitted copy came from alice directly
  assert.strictEqual(fromAlice.deliverer.nodeId, A);
  assert.strictEqual(fromAlice.relayed, false);
  const join2 = createInterimJoin();
  join2.noteVerified(ev({ via: A }));
  join2.noteVerified(ev({ via: C, viaKey: KC }));
  const viaCarol = join2.take(entry({ author: { nodeId: A, via: { nodeId: C } } }));
  assert.strictEqual(viaCarol.deliverer.nodeId, C, 'the admitted copy was carol\'s');
});

test('the interim join is bounded and keeps nothing on disk', () => {
  const join = createInterimJoin();
  for (let i = 0; i < 3000; i++) join.noteVerified(ev({ aid: `asrt-${i}` }));
  assert.ok(join.pendingSize() <= 2048);
  const src = require('node:fs').readFileSync(require.resolve('../provenance.js'), 'utf8');
  assert.ok(!/writeFile|mkdirSync/.test(src), 'no second store');
});
