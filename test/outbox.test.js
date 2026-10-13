'use strict';

// outbox.js — a directed CMB held AT THE SENDER while its recipient has no session, keyed by nodeId
// (design D6). A name is never a route; a nodeId this node never had a proven session with is refused,
// so a typo creates no state. A 0.10 outbox addressed by name is converted through its old roster.

require('./_harness.js'); // sandbox first
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createOutbox, ageDays, MAX_ITEMS } = require('../outbox.js');

const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
const B = '01a0fd15-52ca-77cd-bc1c-8eef67a748e6';
const fresh = () => fs.mkdtempSync(path.join(process.env.HOME, 'node-dir-'));

test('an unknown nodeId and a name are not holdable', () => {
  const ob = createOutbox(fresh());
  assert.strictEqual(ob.isKnown(A), false);
  assert.deepStrictEqual(ob.hold('alice', { categories: { focus: 'x' } }), { held: false, reason: 'not-a-node-id' });
  ob.rememberPeer('alice', 'alice');
  assert.strictEqual(ob.isKnown('alice'), false, 'a name never becomes known');
});

test('a nodeId becomes known by a proven session, and is then held for, durably, with its parents', () => {
  const dir = fresh();
  const ob = createOutbox(dir);
  ob.rememberPeer(A.toUpperCase(), 'alice');
  assert.strictEqual(ob.isKnown(A), true);
  assert.strictEqual(ob.knownLabel(A), 'alice');
  const h = ob.hold(A, { categories: { focus: 'held' }, parents: [`cmb-${'f'.repeat(64)}`], payload: { n: 1 } });
  assert.strictEqual(h.held, true);
  const again = createOutbox(dir).pendingFor(A);
  assert.strictEqual(again.length, 1, 'the queue survives a reload');
  assert.deepStrictEqual(again[0].parents, [`cmb-${'f'.repeat(64)}`]);
  assert.deepStrictEqual(again[0].payload, { n: 1 });
  assert.strictEqual(typeof again[0].heldAt, 'number');
});

test('drop removes only the given items; a full outbox refuses rather than evicting', () => {
  const ob = createOutbox(fresh());
  ob.rememberPeer(A, 'alice'); ob.rememberPeer(B, 'bob');
  const a = ob.hold(A, { categories: { focus: 'a' } });
  ob.hold(B, { categories: { focus: 'b' } });
  assert.strictEqual(ob.drop([a.seq]), 1);
  assert.strictEqual(ob.pendingFor(A).length, 0);
  assert.strictEqual(ob.pendingFor(B).length, 1);
  for (let i = ob.summary().total; i < MAX_ITEMS; i++) assert.ok(ob.hold(B, { categories: { focus: `n${i}` } }).held);
  assert.deepStrictEqual(ob.hold(B, { categories: { focus: 'one too many' } }), { held: false, reason: 'outbox-full' });
});

test('age is reported, and an item stamped before ages existed reads as unknown, not zero', () => {
  const now = Date.now();
  assert.strictEqual(ageDays({ heldAt: now - 10 * 86400000 }, now), 10);
  assert.strictEqual(ageDays({ heldAt: null }, now), null);
  const ob = createOutbox(fresh());
  ob.rememberPeer(A, 'alice');
  ob.hold(A, { categories: { focus: 'x' } });
  const s = ob.summary(Date.now() + 3 * 86400000 + 1000);
  assert.strictEqual(s.oldestDays, 3);
  assert.deepStrictEqual(s.byPeer[A], { count: 1, label: 'alice', stuck: 0, stuckReason: null });
});

test('L9: the outbox and roster files are 0600; a refused item is marked stuck with its reason and kept, lineage included', () => {
  const ob = createOutbox(fresh());
  ob.rememberPeer(A, 'alice');
  const h = ob.hold(A, { categories: { focus: 'a cited reply' }, parents: [`cmb-${'f'.repeat(64)}`] });
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(ob.outboxFile).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(ob.rosterFile).mode & 0o777, 0o600);
  }
  assert.strictEqual(ob.markStuck(h.seq, 'the SDK refused it'), true);
  const s = ob.summary();
  assert.deepStrictEqual([s.byPeer[A].stuck, s.byPeer[A].stuckReason], [1, 'the SDK refused it']);
  assert.deepStrictEqual(ob.pendingFor(A)[0].parents, [`cmb-${'f'.repeat(64)}`]);
  assert.strictEqual(ob.clearStuck(h.seq), true);
  assert.strictEqual(ob.summary().byPeer[A].stuck, 0);
});

test('a 0.10 outbox addressed by name is converted through its roster; one it cannot map is held for a label', () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, 'known-peers.json'), JSON.stringify({ alice: { peerId: A, lastSeen: null }, ghost: { peerId: 'not-a-uuid' } }));
  fs.writeFileSync(path.join(dir, 'outbox.json'), JSON.stringify({ seq: 2, items: [
    { seq: 1, to: 'alice', categories: { focus: 'for alice' }, opts: {}, heldAt: 1 },
    { seq: 2, to: 'ghost', fields: { focus: 'for a 0.9 ghost' }, opts: {} },
  ] }));
  const ob = createOutbox(dir);
  assert.strictEqual(ob.isKnown(A), true, 'the 0.10 roster\'s recorded id is kept');
  const forAlice = ob.pendingFor(A);
  assert.strictEqual(forAlice.length, 1);
  assert.strictEqual(forAlice[0].label, 'alice');
  const ghost = ob.heldForLabel('ghost');
  assert.strictEqual(ghost.length, 1);
  assert.deepStrictEqual(ghost[0].categories, { focus: 'for a 0.9 ghost' }, 'the pre-rename key is migrated too');
  assert.deepStrictEqual(ob.summary().byLabelOnly, { ghost: 1 });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'outbox.json'), 'utf8'));
  assert.deepStrictEqual(onDisk.items.map((i) => i.to), [A, null], 'the conversion is written back');
});
