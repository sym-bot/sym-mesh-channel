'use strict';

// node-host.js against the real sym 0.14 SDK, in process: two SymNodes joined through the real §5.2
// handshake over an in-memory pipe (the public connectTransport). A delivery carries the facts
// verified-record gave for it (design D2); the outbox holds by nodeId and flushes on a proven session
// (D6); the facts survive a restart; a 0.13 inbox entry is withheld as before-core-secure.

const h = require('./_harness.js'); // sandbox first
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const sdk = require('@sym-bot/sym');
const { NodeHost } = require('../node-host.js');

const uniq = (b) => `${b}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const ROOM = 'host-room';
function builder(name) {
  return (cfg) => new sdk.SymNode({ name, room: cfg.room || ROOM, relayOnly: true, silent: true, ...(cfg.nodeId ? { nodeId: cfg.nodeId, create: cfg.create === true } : {}) });
}
function hostFor(name) {
  const host = new NodeHost({ build: builder(name), nodeDir: (id) => sdk.identity.nodeDirById(id) });
  host.open({ room: ROOM });
  return host;
}
const deliveries = (host) => { const out = []; host.on('delivery', (d) => out.push(d)); return out; };

test('a directed record, a room record and a message arrive with what the node verified', async () => {
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  const bob = hostFor(uniq('bob'));
  const got = deliveries(bob);
  try {
    await alice.start(); await bob.start();
    await h.connectNodes(alice, bob.node);
    alice.remember({ focus: 'a directed request for bob' }, { to: bob.nodeId, payload: { ticket: 7 } });
    alice.remember({ focus: 'a room observation' });
    alice.send('a plain message', { to: bob.nodeId });
    await h.until(() => got.length >= 3, 5000);
    const [directed, room, message] = [got.find((d) => d.kind === 'cmb' && d.directed), got.find((d) => d.kind === 'cmb' && !d.directed), got.find((d) => d.kind === 'message')];
    assert.ok(directed && room && message, JSON.stringify(got.map((d) => [d.kind, d.directed])));
    assert.strictEqual(directed.facts.signer.nodeId, alice.nodeId);
    assert.strictEqual(directed.facts.signer.keySource, 'proven');
    assert.strictEqual(directed.facts.audience, 'directed');
    assert.strictEqual(directed.facts.relayed, false);
    assert.match(directed.key, /^cmb-[0-9a-f]{64}$/);
    assert.match(directed.id, /^in\d{4}$/);
    assert.deepStrictEqual(directed.payload, { ticket: 7 }, 'the payload came back from the signed application section');
    assert.strictEqual(room.facts.audience, 'room');
    assert.strictEqual(message.facts.signer.nodeId, alice.nodeId);
    assert.match(message.id, /^m\d{3}$/);
    assert.strictEqual(message.content, 'a plain message');
    // The feed: everything drained, the facts attached, and the parents/to handles resolve.
    const r = bob.drain({});
    assert.strictEqual(r.items.length, 3);
    assert.ok(r.items.every((d) => d.facts && !d.withheld));
    assert.strictEqual(bob.keyOf(directed.id), directed.key);
    assert.strictEqual(bob.signerOf(message.id), alice.nodeId);
    assert.strictEqual(bob.markRead(directed.id), true);
    assert.strictEqual(bob.get(directed.id).acked, true);
  } finally { await alice.stop(); await bob.stop(); }
});

test('a reply cites its parent (after an own observation, as §15.7 requires), and the receiver sees the lineage', async () => {
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  const bob = hostFor(uniq('bob'));
  const got = deliveries(bob);
  const seen = [];
  alice.on('verified-record', (e) => seen.push(e));
  try {
    await alice.start(); await bob.start();
    await h.connectNodes(alice, bob.node);
    alice.remember({ focus: 'what is the relay doing' }, { to: bob.nodeId });
    await h.until(() => got.length >= 1, 5000);
    const key = got[0].key;
    const refused = bob.emitRecord({ categories: { focus: 'it is fine' }, to: alice.nodeId, parents: [key] });
    assert.strictEqual(refused.outcome, 'remix-refused', 'a first emission that remixes a peer is the §15.7 guard\'s refusal, said as such');
    assert.strictEqual(bob.emitRecord({ categories: { focus: 'bob watched the relay for an hour' } }).outcome, 'published');
    const sent = bob.emitRecord({ categories: { focus: 'it is fine' }, to: alice.nodeId, parents: [key] });
    assert.strictEqual(sent.outcome, 'sent');
    await h.until(() => seen.some((e) => e.record.metadata.lineage), 5000);
    const reply = seen.find((e) => e.record.metadata.lineage);
    assert.deepStrictEqual(reply.record.metadata.lineage.parents, [key]);
    assert.strictEqual(bob.emitRecord({ categories: { focus: 'bob watched the relay for an hour' } }).outcome, 'already-in-memory', 'identical cognition: an answer, not a salted re-send');
  } finally { await alice.stop(); await bob.stop(); }
});

test('a known peer with no session is held for, and the hold flushes when its session is proven again', async () => {
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  const bob = hostFor(uniq('bob'));
  const arrived = [];
  alice.on('verified-record', (e) => arrived.push(e.record.categories.focus.text));
  try {
    await alice.start(); await bob.start();
    const pipe = await h.connectNodes(alice, bob.node);
    const stranger = '01a0fd15-0000-7000-8000-00000000abcd';
    assert.strictEqual(bob.emitRecord({ categories: { focus: 'to nobody' }, to: stranger }).outcome, 'unknown-peer');
    pipe.tc.close();
    await h.until(() => !bob.peers().some((p) => p.peerId === alice.nodeId), 5000);
    const held = bob.emitRecord({ categories: { focus: 'held for alice' }, to: alice.nodeId });
    assert.strictEqual(held.outcome, 'held');
    assert.strictEqual(bob.outbox.pendingFor(alice.nodeId).length, 1);
    const flushed = new Promise((r) => bob.once('outbox-flushed', r));
    await h.connectNodes(alice, bob.node);
    const info = await Promise.race([flushed, new Promise((r) => setTimeout(() => r(null), 5000))]);
    assert.ok(info && info.sent === 1, 'flushed on the proven session');
    await h.until(() => arrived.includes('held for alice'), 5000);
    assert.ok(arrived.includes('held for alice'));
    assert.strictEqual(bob.outbox.pendingFor(alice.nodeId).length, 0);
  } finally { await alice.stop(); await bob.stop(); }
});

test('the facts of an inbox delivery survive a restart of the channel', async () => {
  const name = uniq('bob');
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  let bob = hostFor(name);
  const got = deliveries(bob);
  try {
    await alice.start(); await bob.start();
    await h.connectNodes(alice, bob.node);
    alice.remember({ focus: 'waiting across a restart' }, { to: bob.nodeId });
    await h.until(() => got.length >= 1, 5000);
    const id = got[0].id;
    const nodeId = bob.nodeId;
    await bob.stop();
    await new Promise((r) => setTimeout(r, 1200));   // the SDK writes its inbox at most once a second
    bob = new NodeHost({ build: builder(name), nodeDir: (x) => sdk.identity.nodeDirById(x) });
    bob.open({ room: ROOM, nodeId, create: false });
    await bob.start();
    const d = bob.get(id);
    assert.ok(d, 'the inbox is durable');
    assert.strictEqual(d.facts && d.facts.signer.nodeId, alice.nodeId, 'and so are its facts');
  } finally { await alice.stop(); await bob.stop(); }
});

test('a 0.13 inbox entry is withheld as received before Core Secure, never shown', async () => {
  const name = uniq('upgraded');
  const ident = sdk.identity.loadIdentity({ name, create: true });
  const dir = sdk.identity.nodeDirById(ident.nodeId);
  fs.writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify({ seq: 2, cursor: 0, messages: [
    { seq: 1, id: 'in0001', from: 'someone', content: 'OLD-UNVERIFIED-TEXT', categories: { focus: { text: 'OLD-UNVERIFIED-TEXT' } }, directed: true, receivedAt: Date.now() - 1000 },
    { seq: 2, id: 'in0002', from: 'someone', content: 'another', categories: { focus: { text: 'another' } }, directed: false, receivedAt: Date.now() - 500 },
  ] }));
  const host = new NodeHost({ build: builder(name), nodeDir: (x) => sdk.identity.nodeDirById(x) });
  host.open({ room: ROOM, nodeId: ident.nodeId, create: false });
  try {
    await host.start();
    const r = host.drain({});
    assert.strictEqual(r.items.length, 2);
    for (const d of r.items) {
      assert.strictEqual(d.facts, null);
      assert.strictEqual(d.withheld, 'before-core-secure');
    }
    assert.strictEqual(host.keyOf('in0001'), null, 'an unverified delivery cannot be cited as verified');
    assert.strictEqual(host.signerOf('in0001'), null, 'nor named as a recipient');
  } finally { await host.stop(); }
});

test('a pinned nodeId that is not on this host is refused, never minted (design D10)', () => {
  const host = new NodeHost({ build: builder(uniq('ghost')), nodeDir: (x) => sdk.identity.nodeDirById(x) });
  assert.throws(() => host.open({ room: ROOM, nodeId: '01a0fd15-0000-7000-8000-0000000fffff', create: false }), (e) => e.code === 'EIDENTITYABSENT');
});

test('a mood from a rejected record is attributed through the exact join; a mood frame is labelled unattributed', () => {
  // The SDK only raises mood-delivered when SVAF rejects; this drives the events the way it emits them.
  const fake = new EventEmitter();
  Object.assign(fake, { nodeId: '01a0fd15-0000-7000-8000-000000000002', name: 'fake', inboxStatus: () => ({ seq: 0, cursor: 0, undrained: 0 }), inboxGet: () => null, inbox: () => ({ messages: [], remaining: 0 }), peers: () => [] });
  const host = new NodeHost({ build: () => fake, nodeDir: () => fs.mkdtempSync(path.join(process.env.HOME, 'fake-node-')) });
  host.open({});
  const got = deliveries(host);
  const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
  fake.emit('verified-record', {
    record: { categories: { focus: { text: 'debugging auth' }, mood: { text: 'exhausted' } }, metadata: { key: `cmb-${'1'.repeat(64)}`, assertionId: 'asrt-mood' } },
    session: { nodeId: A, name: 'alice', transport: 'lan' },
    verification: { suite: 'mmp-sig-v2.0', assertionId: 'asrt-mood', authorNodeId: A, authorName: 'alice', authorKeySource: 'proven', audience: 'room', room: 'r' },
  });
  fake.emit('mood-delivered', { from: 'alice', mood: 'exhausted', valence: -0.6, arousal: -0.5, context: 'extracted from rejected CMB' });
  fake.emit('mood-delivered', { from: 'bob', mood: 'calm', drift: 0.1 });
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].kind, 'mood');
  assert.strictEqual(got[0].facts.signer.nodeId, A);
  assert.strictEqual(got[0].mood.valence, -0.6);
  assert.strictEqual(got[1].facts, null);
  assert.strictEqual(got[1].moodFrom, 'bob');
  assert.strictEqual(host.feed.unread(), 2, 'kept in the feed for sym_receive');
});
