'use strict';

// Tests for the sender-held outbox — the mesh-channel half of the directed-send
// seam. The daemon half lives in @sym-bot/sym; neither suite can see the other,
// which is exactly how the refusal hid. The end-to-end proof is the sym_send-first
// acceptance test in the sym repo; these cover this package's contract.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const outbox = require('../outbox.js');

const N = 'outbox-test-node';
const dir = path.join(os.homedir(), '.sym', 'nodes', N);
const clean = () => fs.rmSync(dir, { recursive: true, force: true });

test('an UNKNOWN peer name is not holdable — a typo must not create a queue', () => {
  clean();
  // Deliberately NOT using "identity.json exists on disk" as the test: that is
  // true for 961 of 962 node directories on a working machine, so it admits
  // essentially everything. Known means THIS node saw the peer.
  assert.equal(outbox.isKnownPeer(N, 'never-seen-peer'), false);
  clean();
});

test('a peer becomes known only by being observed, and then can be held for', () => {
  clean();
  assert.equal(outbox.isKnownPeer(N, 'real-peer'), false);
  outbox.rememberPeer(N, 'real-peer', 'peer-id-1');
  assert.equal(outbox.isKnownPeer(N, 'real-peer'), true, 'observing a peer makes its name known');
  const h = outbox.hold(N, 'real-peer', { focus: 'x' }, {});
  assert.equal(h.held, true);
  assert.equal(h.seq, 1);
  clean();
});

test('a nodeId is accepted as known once its name has been observed', () => {
  clean();
  outbox.rememberPeer(N, 'real-peer', 'peer-id-1');
  assert.equal(outbox.isKnownPeer(N, 'peer-id-1'), true, 'addressing by nodeId must resolve too');
  clean();
});

test('held items survive a reload — the queue is durable, not in-memory', () => {
  clean();
  outbox.rememberPeer(N, 'p', 'id');
  outbox.hold(N, 'p', { focus: 'first' }, {});
  outbox.hold(N, 'p', { focus: 'second' }, {});
  const again = outbox.pendingFor(N, 'p');   // re-reads from disk
  assert.equal(again.length, 2);
  assert.equal(again[0].fields.focus, 'first', 'FIFO order preserved across reload');
  clean();
});

test('drop removes ONLY the acknowledged seqs', () => {
  clean();
  outbox.rememberPeer(N, 'p', 'id');
  const a = outbox.hold(N, 'p', { focus: 'a' }, {});
  outbox.hold(N, 'p', { focus: 'b' }, {});
  const left = outbox.drop(N, [a.seq]);
  assert.equal(left, 1);
  assert.equal(outbox.pendingFor(N, 'p')[0].fields.focus, 'b');
  clean();
});

test('a FULL outbox REFUSES rather than evicting', () => {
  clean();
  outbox.rememberPeer(N, 'p', 'id');
  for (let i = 0; i < outbox.MAX_ITEMS; i++) outbox.hold(N, 'p', { focus: `f${i}` }, {});
  const over = outbox.hold(N, 'p', { focus: 'one too many' }, {});
  assert.equal(over.held, false, 'must refuse');
  assert.equal(over.reason, 'outbox-full');
  // Evicting would drop mail the sender already said it was holding — silently,
  // and only this node would ever know. A refusal is visible to the caller.
  assert.equal(outbox.pendingFor(N, 'p').length, outbox.MAX_ITEMS, 'nothing was evicted');
  clean();
});

test('summary reports per-peer counts — held mail must be visible somewhere', () => {
  clean();
  outbox.rememberPeer(N, 'p1', 'id1');
  outbox.rememberPeer(N, 'p2', 'id2');
  outbox.hold(N, 'p1', { focus: 'a' }, {});
  outbox.hold(N, 'p2', { focus: 'b' }, {});
  outbox.hold(N, 'p2', { focus: 'c' }, {});
  const s = outbox.summary(N);
  assert.equal(s.total, 3);
  assert.equal(s.byPeer.p1, 1);
  assert.equal(s.byPeer.p2, 2);
  clean();
});
