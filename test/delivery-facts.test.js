'use strict';

// delivery-facts.js — the verified facts of a delivery, kept by assertion id until the node delivers
// it, and kept durably beside the inbox (design D2).

require('./_harness.js'); // sandbox first
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { factsFrom, createFactsLedger, WITHHELD_REASONS } = require('../delivery-facts.js');

const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
const C = '01a0fd15-52ca-7111-8222-0a1b2c3d4e5f';
const KEY = `cmb-${'c'.repeat(64)}`;

function event({ assertionId = 'asrt-1', author = A, via = A, audience = 'room', mood = null, parents = null } = {}) {
  return {
    record: { categories: { focus: { text: 'x' }, ...(mood ? { mood: { text: mood } } : {}) }, metadata: { key: KEY, assertionId, room: 'team', createdBy: 'alice', lineage: parents ? { parents } : null } },
    session: { nodeId: via, name: via === A ? 'alice' : 'carol', transport: 'relay', profile: 'core-secure' },
    verification: { suite: 'mmp-sig-v2.0', assertionId, authorNodeId: author, authorName: 'alice', authorKey: 'K', authorKeySource: 'proven', audience, room: 'team', to: null, relayed: via !== author, anchor: false },
  };
}

test('factsFrom keeps what was verified, as plain data; an event without a signer or an assertion is no facts', () => {
  const f = factsFrom(event({ via: C, parents: [`cmb-${'d'.repeat(64)}`] }));
  assert.strictEqual(f.signer.nodeId, A);
  assert.strictEqual(f.signer.keySource, 'proven');
  assert.strictEqual(f.deliverer.nodeId, C);
  assert.strictEqual(f.relayed, true);
  assert.strictEqual(f.audience, 'room');
  assert.strictEqual(f.key, KEY);
  assert.deepStrictEqual(f.parents, [`cmb-${'d'.repeat(64)}`]);
  assert.doesNotThrow(() => JSON.stringify(f));
  assert.strictEqual(factsFrom({ verification: { assertionId: 'asrt-x' } }), null, 'no signer nodeId');
  assert.strictEqual(factsFrom({ verification: { authorNodeId: 'alice', assertionId: 'asrt-x' } }), null, 'a name is not a signer');
  assert.strictEqual(factsFrom(null), null);
});

test('the join is by assertion id: two authors who say the same words share a key, never an assertion', () => {
  const L = createFactsLedger({});
  L.noteVerified(event({ assertionId: 'asrt-alice' }));
  L.noteVerified(event({ assertionId: 'asrt-carol', author: C, via: C }));
  assert.strictEqual(L.take('asrt-carol').signer.nodeId, C);
  assert.strictEqual(L.take('asrt-alice').signer.nodeId, A);
  assert.strictEqual(L.take('asrt-nobody'), null);
});

test('an inbox delivery keeps its facts across a restart; one the ledger never saw is withheld with its reason', () => {
  const dir = fs.mkdtempSync(path.join(process.env.HOME, 'ledger-'));
  const L1 = createFactsLedger({ dir, inboxSeq: 7 });
  L1.noteVerified(event());
  L1.recordInbox('in0008', L1.take('asrt-1'), { profile: 'core-secure' });
  L1.recordInbox('in0009', null, { profile: 'legacy-import' });
  L1.recordInbox('in0010', null, {});
  L1.flush();
  const L2 = createFactsLedger({ dir, inboxSeq: 999 });
  assert.strictEqual(L2.coreSecureSinceSeq(), 7, 'the start of Core Secure is recorded once, not moved by a restart');
  assert.strictEqual(L2.forInbox({ id: 'in0008', seq: 8 }).facts.signer.nodeId, A);
  assert.deepStrictEqual(L2.forInbox({ id: 'in0009', seq: 9 }), { withheld: 'legacy-import' });
  assert.deepStrictEqual(L2.forInbox({ id: 'in0010', seq: 10 }), { withheld: 'unverified' });
  assert.deepStrictEqual(L2.forInbox({ id: 'in0003', seq: 3 }), { withheld: 'before-core-secure' }, 'a 0.13 inbox entry');
  assert.deepStrictEqual(L2.forInbox({ id: 'in0050', seq: 50 }), { withheld: 'unverified' });
  const mode = fs.statSync(path.join(dir, 'mesh-channel', 'deliveries.json')).mode & 0o777;
  if (process.platform !== 'win32') assert.strictEqual(mode, 0o600);
  for (const r of Object.keys(WITHHELD_REASONS)) assert.ok(WITHHELD_REASONS[r].length > 20);
});

test('the pending map is bounded, and the ledger keeps at most its size', () => {
  const L = createFactsLedger({});
  for (let i = 0; i < 3000; i++) L.noteVerified(event({ assertionId: `asrt-${i}` }));
  assert.ok(L.pendingSize() <= 2048, String(L.pendingSize()));
  assert.ok(L.take('asrt-2999'));
  assert.strictEqual(L.take('asrt-0'), null, 'the oldest went first');
  for (let i = 0; i < 1200; i++) L.recordInbox(`in${i}`, null, {});
  assert.ok(L.size() <= 1000);
});

test('a mood is attributed only when exactly one recent, undelivered record from that session carries it', () => {
  const L = createFactsLedger({});
  L.noteVerified(event({ assertionId: 'asrt-m1', mood: 'exhausted' }));
  assert.strictEqual(L.moodSource('alice', 'exhausted').assertionId, 'asrt-m1');
  assert.strictEqual(L.moodSource('alice', 'exhausted'), null, 'used once');
  L.noteVerified(event({ assertionId: 'asrt-m2', mood: 'tired' }));
  L.noteVerified(event({ assertionId: 'asrt-m3', mood: 'tired' }));
  assert.strictEqual(L.moodSource('alice', 'tired'), null, 'two candidates: not guessed');
  L.noteVerified(event({ assertionId: 'asrt-m4', mood: 'calm' }));
  L.take('asrt-m4');
  assert.strictEqual(L.moodSource('alice', 'calm'), null, 'a record that was delivered (admitted) is not the source of a rejected record\'s mood');
  assert.strictEqual(L.moodSource('bob', 'exhausted'), null);
});
