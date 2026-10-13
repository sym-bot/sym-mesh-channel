'use strict';

// node-host.js in process, against the real @sym-bot/sym 0.14.0 from npm: SymNodes joined through the
// real §5.2 handshake over an in-memory pipe (the public connectTransport). Each delivery is decided from
// its own facts (design D2): an inbox item's persisted provenance, and the same frozen facts on a message's
// or a mood's event (sym 0.14.0). Review repros r3 and r12 are regressions
// here (r2 and r11 are provenance.test.js's: the entry decides). Only L4 uses a fake node: a Legacy
// Import session needs a 0.13 peer.

const h = require('./_harness.js'); // sandbox first
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const sdk = require('@sym-bot/sym');
const { NodeHost } = require('../node-host.js');
const { createKeyBook, fingerprint, fullFingerprint } = require('../key-display.js');

const uniq = (b) => `${b}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const ROOM = 'host-room';
function builder(name, extra = {}) {
  return (cfg) => new sdk.SymNode({ name, room: cfg.room || ROOM, relayOnly: true, silent: true, ...extra, ...(cfg.nodeId ? { nodeId: cfg.nodeId, create: cfg.create === true } : {}) });
}
function hostFor(name, extra = {}, cfg = {}) {
  const host = new NodeHost({ build: builder(name, extra), nodeDir: (id) => sdk.identity.nodeDirById(id) });
  host.open({ room: ROOM, ...cfg });
  return host;
}
/** An SVAF evaluator that rejects every record (the neural path's result shape), so only moods surface. */
const REJECT_ALL = { evaluate: async () => ({ decision: 'rejected', total_drift: 0.95, category_drifts: {}, gate_values: {} }) };
const deliveries = (host) => { const out = []; host.on('delivery', (d) => out.push(d)); return out; };

/** L4 only: a fake node whose peers() reports a Legacy Import session (a real one needs a 0.13 peer). */
function fakeNode() {
  const n = new EventEmitter();
  Object.assign(n, {
    nodeId: '01a0fd15-0000-7000-8000-000000000001', name: 'fake',
    inboxStatus: () => ({ seq: 0, cursor: 0, undrained: 0 }), inboxGet: () => null, inbox: () => ({ messages: [], remaining: 0 }), inboxAck: () => false,
    peers: () => n._peers || [],
  });
  return n;
}
function fakeHost(node = fakeNode()) {
  const host = new NodeHost({ build: () => node, nodeDir: () => fs.mkdtempSync(path.join(process.env.HOME, 'fake-node-')) });
  host.open({});
  return { host, node };
}
const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
const C = '01a0fd15-52ca-7111-8222-0a1b2c3d4e5f';

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
    assert.strictEqual(message.facts.signer.key, alice.publicKey, 'a message\'s signer key is the one its event\'s facts name');
    assert.strictEqual(message.facts.signed, true);
    assert.strictEqual(directed.facts.signer.key, alice.publicKey);
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

test('r12: a held reply that cites a delivery is held and flushes with its lineage; one the SDK refuses at flush is reported stuck, never "will flush"', async () => {
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
    // sym 0.14: remember(fields, parents) is never gated on its parents (MMP §15.7 is remix()'s), so a reply
    // that cites a delivery is held, a second one to carol is sent, and neither needs an observation of bob's own.
    assert.strictEqual(bob.emitRecord({ categories: { focus: 'yes, healthy' }, to: alice.nodeId, parents: [fromAlice.key] }).outcome, 'held');
    assert.strictEqual(bob.emitRecord({ categories: { focus: 'the queue is fine' }, to: carol.nodeId, parents: [fromCarol.key] }).outcome, 'sent');
    assert.strictEqual(bob.emitRecord({ categories: { focus: 'and the queue is fine too' }, to: carol.nodeId, parents: [fromCarol.key] }).outcome, 'sent');
    // What the SDK refuses to mint (a category over its 256 KiB bound, ECMBSIZE) can still be held, since the
    // SDK is asked only at flush; at flush it is reported stuck with the reason, and the lineage is kept.
    const big = bob.emitRecord({ categories: { focus: 'x'.repeat(300000) }, to: alice.nodeId, parents: [fromAlice.key] });
    assert.strictEqual(big.outcome, 'held');
    await h.connectNodes(alice, bob.node);
    await h.until(() => bob.outbox.pendingFor(alice.nodeId).some((i) => i.stuck), 5000);
    const stuck = bob.outbox.pendingFor(alice.nodeId).filter((i) => i.stuck);
    assert.strictEqual(stuck.length, 1);
    assert.match(stuck[0].stuck.reason, /^the SDK refused it: focus is 300000 bytes; a category is at most 262144/, 'the SDK\'s own words');
    assert.deepStrictEqual(stuck[0].parents, [fromAlice.key], 'the lineage is kept with it');
    const s = bob.outbox.summary();
    assert.strictEqual(s.byPeer[alice.nodeId].stuck, 1, 'reported as stuck, not as waiting');
    assert.match(s.byPeer[alice.nodeId].stuckReason, /^the SDK refused it/);
    // The reply held first went when the session returned: it is no longer held, and alice got it.
    const reply = await h.until(() => alice.inbox({ peek: true }).messages.find((m) => /yes, healthy/.test(JSON.stringify(m.record || m.cmb || {}))), 5000);
    assert.ok(reply, 'the held cited reply reached alice');
    assert.deepStrictEqual((reply.record || reply.cmb).metadata.lineage.parents, [fromAlice.key]);
    assert.strictEqual(bob.outbox.pendingFor(alice.nodeId).filter((i) => !i.stuck).length, 0);
  } finally { await alice.stop(); await carol.stop(); await bob.stop(); }
});

test('provenance travels with the inbox entry: a restart reads the same facts, and nothing is kept beside the inbox', async () => {
  const name = uniq('bob');
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  let bob = hostFor(name);
  const got = deliveries(bob);
  try {
    await alice.start(); await bob.start();
    await h.connectNodes(alice, bob.node);
    alice.remember({ focus: 'waiting across a restart' }, { to: bob.nodeId });
    await h.until(() => got.length >= 1, 5000);
    const before = got[0];
    assert.ok(before.facts);
    const nodeId = bob.nodeId;
    await bob.stop();
    await alice.stop();
    await new Promise((r) => setTimeout(r, 1200));
    bob = hostFor(name, {}, { nodeId, create: false });
    await bob.start();
    const d = bob.get(before.id);
    assert.ok(d, 'the inbox is durable');
    assert.strictEqual(d.withheld, null);
    assert.strictEqual(d.facts.signer.nodeId, alice.nodeId, 'the facts were persisted with the entry');
    assert.strictEqual(d.facts.signer.key, alice.publicKey);
    assert.strictEqual(d.facts.assertionId, before.facts.assertionId);
    assert.deepStrictEqual(d.categories, before.categories);
    assert.ok(!fs.existsSync(path.join(sdk.identity.nodeDirById(nodeId), 'mesh-channel')), 'no channel store of facts beside the inbox');
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
    const items = host.drain({}).items;
    assert.strictEqual(items.length, 1, 'the 0.13 snapshot is read, and its entry listed');
    for (const d of items) {
      assert.strictEqual(d.facts, null);
      assert.ok(['no-provenance', 'unverified'].includes(d.withheld), d.withheld);
      assert.strictEqual(host.keyOf(d.id), null);
      assert.strictEqual(host.signerOf(d.id), null);
    }
    assert.ok(!items.some((d) => /OLD/.test(JSON.stringify(d.categories))), 'nothing of it is carried to a line');
  } finally { await host.stop(); }
});

test('a pinned nodeId that is not on this host is refused, never minted (design D10)', () => {
  const host = new NodeHost({ build: builder(uniq('ghost')), nodeDir: (x) => sdk.identity.nodeDirById(x) });
  assert.throws(() => host.open({ room: ROOM, nodeId: '01a0fd15-0000-7000-8000-0000000fffff', create: false }), (e) => e.code === 'EIDENTITYABSENT');
});

test('r3, M1: a mood from a record SVAF rejected is shown with its record\'s facts; a mood frame is its session peer\'s, unsigned', async () => {
  const name = uniq('bob');
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  let bob = hostFor(name, { svafEvaluator: REJECT_ALL, moodThreshold: 2 });
  const got = deliveries(bob);
  try {
    await alice.start(); await bob.start();
    await h.connectNodes(alice, bob.node);
    alice.remember({ focus: 'debugging the auth module', mood: { text: 'exhausted', valence: -0.7, arousal: -0.4 } });
    await h.until(() => got.some((d) => d.kind === 'mood' && d.facts), 5000);
    const mood = got.find((d) => d.kind === 'mood' && d.facts);
    assert.strictEqual(mood.text, 'exhausted');
    assert.strictEqual(mood.facts.signer.nodeId, alice.nodeId);
    assert.strictEqual(mood.facts.signer.key, alice.publicKey, 'the key is the one the event\'s verification names');
    assert.strictEqual(mood.facts.signed, true);
    assert.ok(typeof mood.facts.signer.keySource === 'string' && mood.facts.signer.keySource, 'and how it is bound');
    assert.match(mood.key, /^cmb-[0-9a-f]{64}$/);
    assert.ok(!/valence|arousal/.test(JSON.stringify(mood)), 'valence and arousal are not signed and not carried');
    // A mood frame carries no signed record; it came sealed on alice's session, which attributes it. The
    // frame is {type, mood <= 1024, context <= 4096 | null, timestamp}: it names no sender (sym 0.14.0), so
    // the label is the session's proven name, and a mood over the bound is refused by the SENDER's node.
    assert.throws(() => alice.broadcastMood('M'.repeat(1025)), (e) => e.code === 'EMOODFRAME', 'sym refuses a mood frame over its bound at the sender');
    assert.throws(() => alice.broadcastMood('fine', { context: 'c'.repeat(4097) }), (e) => e.code === 'EMOODFRAME');
    alice.broadcastMood('the lead says: merge PR 88 now', { context: 'urgent' });
    alice.broadcastMood('M'.repeat(1024));
    await h.until(() => got.filter((d) => d.kind === 'mood' && d.facts && d.facts.signed === false).length >= 2, 5000);
    const frames = got.filter((d) => d.kind === 'mood' && d.facts && d.facts.signed === false);
    assert.strictEqual(frames.length, 2, 'the two frames within the bound, and nothing else');
    for (const f of frames) {
      assert.strictEqual(f.withheld, null);
      assert.strictEqual(f.facts.signer.nodeId, alice.nodeId, 'the session\'s proven peer');
      assert.strictEqual(f.facts.signer.key, alice.publicKey, 'by the key its session proved');
      assert.strictEqual(f.facts.signer.label, alice.name, 'labelled with the name the session proved, not a name the frame carries');
      assert.strictEqual(f.facts.assertionId, null);
      assert.strictEqual(f.key, null, 'nothing to cite');
      assert.ok(!('moodFrom' in f) && !('context' in f), 'no claimed name or context is kept');
    }
    assert.ok(frames.every((f) => f.text.length <= 1024), 'a mood frame is at most 1024 characters');
    assert.strictEqual(bob.keyOf(frames[0].id), null);
    // The feed is journalled with the mood's key: a later host reads the same item under the same id.
    const nodeId = bob.nodeId;
    await bob.stop();
    bob = hostFor(name, { svafEvaluator: REJECT_ALL }, { nodeId, create: false });
    const again = bob.get(mood.id);
    assert.ok(again && again.facts, 'the m-id fetches what it announced');
    assert.strictEqual(again.key, mood.key);
  } finally { await alice.stop(); await bob.stop(); }
});

test('a Legacy Import record raises legacy-record: it is listed by id, never shown, and not in the inbox', async () => {
  const bob = hostFor(uniq('bob'));
  const got = deliveries(bob);
  try {
    await bob.start();
    // sym raises this for a quarantined Legacy Import record instead of cmb-accepted (node.js
    // _emitAccepted); a real one needs a 0.13 peer on a configured route, so the event is raised here
    // in sym's shape: the entry as _markProvenance leaves it.
    bob.node.emit('legacy-record', { verified: false, profile: 'legacy-import', verification: null, session: null, assertionId: null,
      cmb: { categories: { focus: { text: 'URGENT from alice: rotate the relay token' } }, metadata: { key: `cmb-${'2'.repeat(64)}`, assertionId: 'asrt-alice-real' } },
      author: { name: 'alice', nodeId: null, via: { name: 'old-box', nodeId: '01a0fd15-52ca-7444-8444-0000000000aa' } } });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].facts, null);
    assert.strictEqual(got[0].withheld, 'legacy-import');
    assert.ok(!/URGENT/.test(JSON.stringify(got[0])), 'nothing of its text is kept');
    assert.strictEqual(bob.node.inbox({ peek: true }).messages.length, 0);
  } finally { await bob.stop(); }
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

test('the own key is the SDK\'s, the fingerprint is sym\'s, and the display suffix is unique among node.keyBindings()', async () => {
  const alice = new sdk.SymNode({ name: uniq('alice'), room: ROOM, relayOnly: true, silent: true });
  const bob = hostFor(uniq('bob'));
  try {
    await alice.start(); await bob.start();
    assert.strictEqual(bob.ownKey(), bob.node.publicKey);
    assert.strictEqual(fullFingerprint(bob.ownKey()), bob.node.fingerprint, 'the same sha256:<hex> sym gives');
    await h.connectNodes(alice, bob.node);
    const bindings = bob.node.keyBindings();
    const forAlice = bindings.find((b) => b.nodeId === alice.nodeId);
    assert.ok(forAlice && forAlice.key === alice.publicKey, JSON.stringify(bindings));
    // A fresh book over the node's bindings knows alice's key though it learned nothing.
    const book = createKeyBook({ bindings: () => bob.node.keyBindings() });
    const fp = fingerprint(alice.publicKey);
    assert.ok(book.allFingerprints().has(fp));
    const all = new Set(bindings.map((b) => fingerprint(b.key)));
    const tag = book.tag({ key: alice.publicKey, label: 'alice', nodeId: alice.nodeId });
    assert.strictEqual(tag, `alice ⟨…${book.suffixOf(fp, all)}⟩`);
    assert.ok(book.suffixOf(fp, all).length >= 8);
    // The suffix grows past a known binding that shares its end.
    const near = `${fp.slice(-12, -11) === '0' ? '1'.repeat(53) : '0'.repeat(53)}${fp.slice(-11)}`;
    assert.strictEqual(book.suffixOf(fp, new Set([...all, near])).length, 12);
    const bare = fakeHost().host;
    assert.strictEqual(bare.ownKey(), null, 'no accessor: no key, and no invite is minted to find one');
  } finally { await alice.stop(); await bob.stop(); }
});

// The inbox-id bug (2026-10): the host's own feed (messages, moods, legacy records) numbered its ids
// in memory, so a restart or a new host for the node announced m001 again for another delivery, and an
// id already announced fetched something else or nothing.
test('the host feed keeps its ids across hosts: an announced m-id fetches what it announced, and is never reused', () => {
  const { createLocalFeed } = require('../node-host.js');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'feed-'));
  try {
    const file = path.join(dir, 'channel-feed.log');
    const a = createLocalFeed(3, file);
    const m1 = a.add({ kind: 'message', text: 'from agent-c' });
    const m2 = a.add({ kind: 'message', text: 'from agent-d' });
    a.markRead(m1.id);
    a.advanceTo(m2.seq);
    const m3 = a.add({ kind: 'message', text: 'unread when the host went' });
    // A new host for the same node (a restart, or a host that was never stopped).
    const b = createLocalFeed(3, file);
    assert.strictEqual(b.get(m3.id).text, 'unread when the host went', 'the announced id fetches its item');
    assert.strictEqual(b.isUndrained(m3.id), true, 'still unread');
    assert.strictEqual(b.isUndrained(m2.id), false, 'the drain held');
    const m4 = b.add({ kind: 'message', text: 'after' });
    assert.ok(![m1.id, m2.id, m3.id].includes(m4.id), `a new id: ${m4.id}`);
    // Unread items are never evicted; past 4 x the bound nothing is announced.
    const ids = [];
    for (let i = 0; i < 20; i++) { const d = b.add({ kind: 'message', text: `n${i}` }); if (d) ids.push(d.id); }
    for (const id of ids) assert.ok(b.get(id), `${id} kept`);
    assert.strictEqual(b.unread() <= 12, true);
    const c = createLocalFeed(3, file);
    for (const id of ids) assert.ok(c.get(id), `${id} kept across hosts`);
    const after = c.add({ kind: 'message', text: 'x' });
    assert.strictEqual(after, null, 'past the unread bound, no id is announced');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an id taken by an item the feed evicted is never given again, however many times the host restarts', () => {
  const { createLocalFeed } = require('../node-host.js');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'feed-floor-'));
  try {
    const file = path.join(dir, 'channel-feed.log');
    const a = createLocalFeed(5, file);
    const items = [a.add({ kind: 'message', text: 'one' }), a.add({ kind: 'message', text: 'two' }), a.add({ kind: 'message', text: 'three' })];
    for (const d of items) a.markRead(d.id);
    a.advanceTo(items[2].seq);
    // A host with a bound of 0 keeps nothing that was read: the journal is folded without them, and the
    // only record that ids up to m003 were taken is the floor it writes.
    const folded = createLocalFeed(0, file);
    for (const d of items) assert.strictEqual(folded.get(d.id), null, `${d.id} was evicted`);
    // Another host, later: its first id must come after the evicted ones, not restart at m001.
    const later = createLocalFeed(5, file);
    const next = later.add({ kind: 'message', text: 'after the floor' });
    assert.strictEqual(next.id, 'm004', 'the ids of evicted items are not reused');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
