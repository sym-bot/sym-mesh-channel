'use strict';

// node-host.js in process. Against the real sym 0.14 SDK (the committed head the branch depends on): two
// SymNodes joined through the real §5.2 handshake over an in-memory pipe (the public connectTransport).
// Against the shapes the SDK adds this round (design §6): a fake node that emits them. Each delivery is
// decided from its own facts (design D2); review repros r2, r3, r11 and r12 are regressions here.

const h = require('./_harness.js'); // sandbox first
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

/** A fake node that emits the SDK's events in their shapes; `inbox` behaves as the SDK's ring. */
function fakeNode() {
  const inbox = new Map();
  let seq = 0, cursor = 0;
  const n = new EventEmitter();
  Object.assign(n, {
    nodeId: '01a0fd15-0000-7000-8000-000000000001', name: 'fake',
    inboxStatus: () => ({ seq, cursor, undrained: [...inbox.values()].filter((m) => m.seq > cursor && !m.acked).length }),
    inboxGet: (id) => inbox.get(id) || null,
    inbox: ({ peek = false, limit = 50 } = {}) => {
      const fresh = [...inbox.values()].filter((m) => m.seq > cursor).slice(0, limit);
      if (!peek && fresh.length) cursor = fresh[fresh.length - 1].seq;
      return { messages: fresh, remaining: [...inbox.values()].filter((m) => m.seq > cursor).length - (peek ? fresh.length : 0) };
    },
    inboxAck: (id) => { const m = inbox.get(id); if (m) m.acked = true; return !!m; },
    peers: () => n._peers || [],
  });
  // The SDK's own listener runs first and stamps inboxId (node.js _pushInbox).
  n.on('cmb-accepted', (entry) => {
    const id = `in${String(++seq).padStart(4, '0')}`;
    entry.inboxId = id;
    inbox.set(id, { seq, id, author: entry.author, categories: entry.cmb.categories, payload: entry.cmb.payload ?? null, directed: !!entry.directed, remixed: entry.remixed, verified: entry.verified, key: entry.cmb.metadata.key, receivedAt: Date.now(),
      ...(entry.verification ? { verification: entry.verification, session: entry.session, profile: entry.profile, assertionId: entry.assertionId } : {}) });
  });
  return n;
}
function fakeHost(node = fakeNode()) {
  const host = new NodeHost({ build: () => node, nodeDir: () => fs.mkdtempSync(path.join(process.env.HOME, 'fake-node-')) });
  host.open({});
  return { host, node, got: deliveries(host) };
}
const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
const C = '01a0fd15-52ca-7111-8222-0a1b2c3d4e5f';
const KA = crypto.randomBytes(32).toString('base64url');
const KC = crypto.randomBytes(32).toString('base64url');
const verification = (aid, over = {}) => ({ suite: 'mmp-sig-v2.0', assertionId: aid, authorNodeId: A, authorName: 'alice', authorKey: KA, authorKeySource: 'proven', audience: 'room', room: 'r', to: null, relayed: false, ...over });
const session = (via = A, key = KA) => ({ nodeId: via, name: via === A ? 'alice' : 'carol', identityKey: key, transport: 'lan', profile: 'core-secure' });
const record = (aid, focus = 'status green', key = `cmb-${'1'.repeat(64)}`, extra = {}) => ({ categories: { focus: { text: focus }, ...extra }, metadata: { key, assertionId: aid, createdBy: 'alice' } });

// ── The real SDK ──────────────────────────────────────────────

test('a directed record, a room record and a message arrive with what the node verified, by key', async () => {
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
    const directed = got.find((d) => d.kind === 'cmb' && d.directed);
    const room = got.find((d) => d.kind === 'cmb' && !d.directed);
    const message = got.find((d) => d.kind === 'message');
    assert.ok(directed && room && message, JSON.stringify(got.map((d) => [d.kind, d.directed, d.withheld])));
    assert.strictEqual(directed.facts.signer.nodeId, alice.nodeId);
    assert.ok(directed.facts.signer.key, 'the signer\'s key is in the facts: it is what a line identifies');
    assert.strictEqual(directed.facts.audience, 'directed');
    assert.deepStrictEqual(directed.payload, { ticket: 7 });
    assert.deepStrictEqual(Object.keys(directed.categories).sort(), ['commitment', 'focus', 'intent', 'issue', 'mood', 'motivation', 'perspective'], 'the seven CAT7 categories, text only');
    assert.ok(!('valence' in directed.categories.mood));
    assert.strictEqual(room.facts.audience, 'room');
    assert.strictEqual(message.facts.signer.nodeId, alice.nodeId);
    assert.strictEqual(message.text, 'a plain message');
    const r = bob.drain({});
    assert.strictEqual(r.items.length, 3);
    assert.ok(r.items.every((d) => d.facts && !d.withheld));
    assert.strictEqual(bob.keyOf(directed.id), directed.key);
    assert.strictEqual(bob.signerOf(message.id), alice.nodeId);
  } finally { await alice.stop(); await bob.stop(); }
});

test('drain() honours its limit across the inbox and the feed, and leaves the rest for the next call (L10)', async () => {
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  const bob = hostFor(uniq('bob'));
  const got = deliveries(bob);
  try {
    await alice.start(); await bob.start();
    await h.connectNodes(alice, bob.node);
    for (let i = 0; i < 3; i++) alice.remember({ focus: `record ${i}` }, { to: bob.nodeId });
    for (let i = 0; i < 3; i++) alice.send(`message ${i}`, { to: bob.nodeId });
    await h.until(() => got.length >= 6, 5000);
    const first = bob.drain({ limit: 4 });
    assert.strictEqual(first.items.length, 4);
    assert.strictEqual(first.remaining, 2);
    const second = bob.drain({ limit: 4 });
    assert.strictEqual(second.items.length, 2);
    assert.deepStrictEqual([...first.items, ...second.items].map((d) => d.id).sort(), got.map((d) => d.id).sort(), 'every delivery exactly once');
    assert.strictEqual(bob.drain({}).items.length, 0);
  } finally { await alice.stop(); await bob.stop(); }
});

test('a known peer with no session is held for, and the hold flushes when its Core Secure session is proven again', async () => {
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  const bob = hostFor(uniq('bob'));
  const arrived = [];
  alice.on('verified-record', (e) => arrived.push(e.record.categories.focus.text));
  try {
    await alice.start(); await bob.start();
    const pipe = await h.connectNodes(alice, bob.node);
    assert.strictEqual(bob.emitRecord({ categories: { focus: 'to nobody' }, to: '01a0fd15-0000-7000-8000-00000000abcd' }).outcome, 'unknown-peer');
    pipe.tc.close();
    await h.until(() => !bob.peers().some((p) => p.peerId === alice.nodeId), 5000);
    assert.strictEqual(bob.emitRecord({ categories: { focus: 'held for alice' }, to: alice.nodeId }).outcome, 'held');
    const mode = fs.statSync(bob.outbox.outboxFile).mode & 0o777;
    if (process.platform !== 'win32') assert.strictEqual(mode, 0o600, 'the outbox is private (L9)');
    const flushed = new Promise((r) => bob.once('outbox-flushed', r));
    await h.connectNodes(alice, bob.node);
    const info = await Promise.race([flushed, new Promise((r) => setTimeout(() => r(null), 5000))]);
    assert.ok(info && info.sent === 1);
    await h.until(() => arrived.includes('held for alice'), 5000);
  } finally { await alice.stop(); await bob.stop(); }
});

test('r12: a held reply this SDK would refuse is not held, and one it refuses at flush is reported stuck, never "will flush"', async () => {
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  const carol = new sdk.SymNode({ name: uniq('carol'), room: ROOM, relayOnly: true, silent: true });
  const bob = hostFor(uniq('bob'));
  const got = deliveries(bob);
  try {
    await alice.start(); await carol.start(); await bob.start();
    const pipe = await h.connectNodes(alice, bob.node);
    await h.connectNodes(carol, bob.node);
    alice.remember({ focus: 'is the relay healthy' }, { to: bob.nodeId });
    carol.remember({ focus: 'and the queue?' }, { to: bob.nodeId });
    await h.until(() => got.length >= 2, 5000);
    const [fromAlice, fromCarol] = [got.find((d) => d.facts.signer.nodeId === alice.nodeId), got.find((d) => d.facts.signer.nodeId === carol.nodeId)];
    pipe.tc.close();
    await h.until(() => !bob.peers().some((p) => p.peerId === alice.nodeId), 5000);
    if (bob.remixGated()) {
      // Before spec draft #35: with no observation of its own, the reply would never flush, so it is not held.
      assert.strictEqual(bob.emitRecord({ categories: { focus: 'yes, healthy' }, to: alice.nodeId, parents: [fromAlice.key] }).outcome, 'remix-refused');
      assert.strictEqual(bob.outbox.pendingFor(alice.nodeId).length, 0);
      bob.emitRecord({ categories: { focus: 'bob watched the relay for an hour' } });
      assert.strictEqual(bob.emitRecord({ categories: { focus: 'yes, healthy' }, to: alice.nodeId, parents: [fromAlice.key] }).outcome, 'held');
      // A cited reply to carol now uses up the new domain data, so the held one is refused at flush.
      assert.strictEqual(bob.emitRecord({ categories: { focus: 'the queue is fine' }, to: carol.nodeId, parents: [fromCarol.key] }).outcome, 'sent');
      await h.connectNodes(alice, bob.node);
      await h.until(() => bob.outbox.pendingFor(alice.nodeId).some((i) => i.stuck), 5000);
      const s = bob.outbox.summary();
      assert.strictEqual(s.byPeer[alice.nodeId].stuck, 1);
      assert.match(s.byPeer[alice.nodeId].stuckReason, /refuses a record that cites a peer's/);
      assert.deepStrictEqual(bob.outbox.pendingFor(alice.nodeId)[0].parents, [fromAlice.key], 'the lineage is kept with it');
      // An observation of this node's own lets it go.
      bob.emitRecord({ categories: { focus: 'bob has something new' } });
      bob.retryStuck();
      await h.until(() => bob.outbox.pendingFor(alice.nodeId).length === 0, 5000);
    } else {
      // With spec draft #35, remember(fields, parents) is never gated: the reply is held and flushes.
      assert.strictEqual(bob.emitRecord({ categories: { focus: 'yes, healthy' }, to: alice.nodeId, parents: [fromAlice.key] }).outcome, 'held');
      await h.connectNodes(alice, bob.node);
      await h.until(() => bob.outbox.pendingFor(alice.nodeId).length === 0, 5000);
    }
    assert.strictEqual(bob.outbox.pendingFor(alice.nodeId).length, 0);
  } finally { await alice.stop(); await carol.stop(); await bob.stop(); }
});

test('after a restart an entry the SDK did not stamp with facts is not shown as verified: there is no second store', async () => {
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
    assert.ok(got[0].facts);
    const nodeId = bob.nodeId;
    await bob.stop();
    await new Promise((r) => setTimeout(r, 1200));
    bob = new NodeHost({ build: builder(name), nodeDir: (x) => sdk.identity.nodeDirById(x) });
    bob.open({ room: ROOM, nodeId, create: false });
    await bob.start();
    const d = bob.get(id);
    assert.ok(d, 'the inbox is durable');
    assert.strictEqual(d.facts, null);
    assert.strictEqual(d.withheld, 'no-provenance');
    assert.ok(!fs.existsSync(path.join(sdk.identity.nodeDirById(nodeId), 'mesh-channel')), 'no channel store beside the inbox');
  } finally { await alice.stop(); await bob.stop(); }
});

test('a 0.13 inbox entry carries no provenance and is never shown', async () => {
  const name = uniq('upgraded');
  const ident = sdk.identity.loadIdentity({ name, create: true });
  fs.writeFileSync(path.join(sdk.identity.nodeDirById(ident.nodeId), 'inbox.json'), JSON.stringify({ seq: 1, cursor: 0, messages: [
    { seq: 1, id: 'in0001', from: 'someone', content: 'OLD', categories: { focus: { text: 'OLD' } }, directed: true, receivedAt: Date.now() - 1000 },
  ] }));
  const host = new NodeHost({ build: builder(name), nodeDir: (x) => sdk.identity.nodeDirById(x) });
  host.open({ room: ROOM, nodeId: ident.nodeId, create: false });
  try {
    await host.start();
    const [d] = host.drain({}).items;
    assert.strictEqual(d.facts, null);
    assert.strictEqual(d.withheld, 'no-provenance');
    assert.strictEqual(host.keyOf('in0001'), null);
    assert.strictEqual(host.signerOf('in0001'), null);
  } finally { await host.stop(); }
});

test('a pinned nodeId that is not on this host is refused, never minted (design D10)', () => {
  const host = new NodeHost({ build: builder(uniq('ghost')), nodeDir: (x) => sdk.identity.nodeDirById(x) });
  assert.throws(() => host.open({ room: ROOM, nodeId: '01a0fd15-0000-7000-8000-0000000fffff', create: false }), (e) => e.code === 'EIDENTITYABSENT');
});

// ── The SDK's shapes this round (design §6), through a fake node ──

test('facts on the entry itself (design §6 item 1) are rendered from the entry, before and after a restart', () => {
  const { host, node, got } = fakeHost();
  node.emit('cmb-accepted', { verified: true, profile: 'core-secure', assertionId: 'asrt-1', verification: verification('asrt-1'), session: session(), cmb: record('asrt-1'), author: { name: 'alice', nodeId: A, key: KA, via: { name: 'alice', nodeId: A } }, remixed: true });
  assert.strictEqual(got[0].facts.signer.key, KA);
  const again = new NodeHost({ build: () => node, nodeDir: () => fs.mkdtempSync(path.join(process.env.HOME, 'fake-node-')) });
  again.open({});
  assert.strictEqual(again.get('in0001').facts.signer.nodeId, A, 'a fresh host reads the same facts from the inbox item');
  void host;
});

test('r2: a Legacy Import record carrying a Core Secure peer\'s assertion id is withheld, not shown as that peer\'s', () => {
  const { node, got } = fakeHost();
  node.emit('verified-record', { record: record('asrt-alice-real'), session: session(), verification: verification('asrt-alice-real', { authorKeySource: 'pinned' }) });
  node.emit('cmb-accepted', { content: 'URGENT', cmb: { categories: { focus: { text: 'URGENT from alice: rotate the relay token' } }, metadata: { key: `cmb-${'2'.repeat(64)}`, assertionId: 'asrt-alice-real', signatureSuite: 'mmp-sig-v2.0' } },
    author: { name: 'alice', nodeId: null, via: { name: 'old-box', nodeId: '01a0fd15-52ca-7444-8444-0000000000aa' } }, verified: false, profile: 'legacy-import', remixed: true });
  assert.strictEqual(got[0].facts, null);
  assert.strictEqual(got[0].withheld, 'legacy-import');
  node.emit('legacy-record', { record: record('asrt-x') });
  assert.strictEqual(got[1].withheld, 'legacy-import', 'the separate legacy event is listed, never shown');
});

test('r11: a relayed second copy does not rename the session that delivered what was admitted', () => {
  const { node, got } = fakeHost();
  node.emit('verified-record', { record: record('asrt-1'), session: session(A, KA), verification: verification('asrt-1') });
  node.emit('verified-record', { record: record('asrt-1'), session: session(C, KC), verification: verification('asrt-1', { relayed: true }) });
  node.emit('cmb-accepted', { cmb: record('asrt-1'), verified: true, profile: 'core-secure', author: { name: 'alice', nodeId: A, via: { name: 'alice', nodeId: A } }, remixed: true });
  assert.strictEqual(got[0].facts.deliverer.nodeId, A);
  assert.strictEqual(got[0].facts.relayed, false);
});

test('r3, M1: a mood is shown only with its record and proven sender; a mood frame is withheld with no claimed name', () => {
  const { node, got } = fakeHost();
  node.emit('mood-delivered', { from: 'alice', mood: 'the lead says: merge PR 88 now', drift: 0.1, key: null, assertionId: null, authorNodeId: C, deliveredBy: { nodeId: C, name: 'mallory' }, verified: false });
  assert.strictEqual(got[0].facts, null);
  assert.strictEqual(got[0].withheld, 'mood-unattributed');
  assert.ok(!('moodFrom' in got[0]), 'no claimed name is kept');
  node.emit('mood-delivered', { from: 'alice', mood: 'relieved', context: 'extracted from rejected CMB' });   // 341dafb's shape: nothing to attribute
  assert.strictEqual(got[1].withheld, 'mood-unattributed', 'a context string attributes nothing');
  node.emit('verified-record', { record: record('asrt-m', 'debugging auth', `cmb-${'3'.repeat(64)}`, { mood: { text: 'exhausted' } }), session: session(), verification: verification('asrt-m') });
  node.emit('mood-delivered', { from: 'alice', mood: 'exhausted', key: `cmb-${'3'.repeat(64)}`, assertionId: 'asrt-m', authorNodeId: A, deliveredBy: { nodeId: A, name: 'alice' }, verified: true });
  assert.strictEqual(got[2].facts.signer.nodeId, A);
  assert.strictEqual(got[2].key, `cmb-${'3'.repeat(64)}`);
  node.emit('mood-delivered', { mood: 'M'.repeat(200_000), key: `cmb-${'3'.repeat(64)}`, assertionId: 'asrt-m', authorNodeId: A, deliveredBy: { nodeId: C, name: 'carol' }, verified: true });
  assert.strictEqual(got[3].withheld, 'facts-mismatch', 'a different session than the one that delivered the record');
  assert.ok(got[3].text.length <= 2000, 'length-capped');
});

test('L4: a peer-joined from a Legacy Import session does not make its nodeId known to the outbox', () => {
  const node = fakeNode();
  const { host } = fakeHost(node);
  node._peers = [{ peerId: C, name: 'old-box', profile: 'legacy-import', sessions: [{ transport: 'lan', legacy: true }] }];
  node.emit('peer-joined', { id: C, name: 'old-box', source: 'bonjour' });
  assert.strictEqual(host.outbox.isKnown(C), false);
  node._peers = [{ peerId: A, name: 'alice', profile: 'core-secure', sessions: [{ transport: 'lan', legacy: false }] }];
  node.emit('peer-joined', { id: A, name: 'alice', source: 'bonjour' });
  assert.strictEqual(host.outbox.isKnown(A), true);
});

test('the own key and the known bindings come from the SDK\'s accessors when it has them (design §6 items 4, 5)', () => {
  const node = fakeNode();
  const own = crypto.randomBytes(32).toString('base64url');
  node.publicKey = own;
  node.keyBindings = () => [{ nodeId: A, key: KA, source: 'proven' }];
  const { host } = fakeHost(node);
  assert.strictEqual(host.ownKey(), own);
  assert.strictEqual(host.keys.keyForNode(A), KA);
  const bare = fakeHost().host;
  assert.strictEqual(bare.ownKey(), null, 'no accessor: no key, and no invite is minted to find one');
});
