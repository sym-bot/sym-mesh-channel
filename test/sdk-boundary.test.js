'use strict';

// The SDK boundary (design D1): the channel uses sym 0.14's public host API only.
//
// BEHAVIOUR, NOT SOURCE TEXT (review L11). The node host runs a real SymNode wrapped in a Proxy that
// records every read of an underscore member made directly by a channel file. The SDK's own methods,
// called through the proxy, read their own fields freely; only a read whose immediate caller is the
// channel's code counts. The workload covers what the server does: open, start, a proven session,
// directed and room deliveries, a message, emit with parents, drain, fetch, ack, recall, peers, status,
// an invite, a hold and a flush, and a room move.
//
// The static scan that remains is for names that must not appear at all: the retired frame-handler,
// secrets and daemon IPC, and any deep import into sym's lib/.

const h = require('./_harness.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sdk = require('@sym-bot/sym');
const { NodeHost } = require('../node-host.js');

const root = path.join(__dirname, '..');
const CHANNEL_FILE = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?!node_modules)[^/]+\\.js`);

function watched(node, reads) {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop.startsWith('_')) {
        const caller = (new Error().stack || '').split('\n')[2] || '';
        if (CHANNEL_FILE.test(caller)) reads.push(`${prop} from ${caller.trim()}`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

test('the node host reads no SDK underscore member, across everything the server does with a node', async () => {
  const reads = [];
  const uniq = (b) => `${b}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const name = uniq('bob');
  const build = (cfg) => watched(new sdk.SymNode({ name, room: cfg.room || 'boundary', relayOnly: true, silent: true, ...(cfg.nodeId ? { nodeId: cfg.nodeId, create: false } : {}) }), reads);
  const bob = new NodeHost({ build, nodeDir: (id) => sdk.identity.nodeDirById(id) });
  const alice = new sdk.SymNode({ name: uniq('alice'), room: 'boundary', relayOnly: true, silent: true });
  const got = [];
  bob.on('delivery', (d) => got.push(d));
  try {
    bob.open({ room: 'boundary' });
    await bob.start(); await alice.start();
    const pipe = await h.connectNodes(alice, bob.node);
    alice.remember({ focus: 'a directed request' }, { to: bob.nodeId });
    alice.remember({ focus: 'a room observation' });
    alice.send('a message', { to: bob.nodeId });
    await h.until(() => got.length >= 3, 5000);
    bob.emitRecord({ categories: { focus: 'bob observes' } });
    bob.emitRecord({ categories: { focus: 'a reply' }, to: alice.nodeId, parents: [got[0].key] });
    const r = bob.drain({ limit: 10 });
    bob.get(r.items[0].id); bob.markRead(r.items[0].id); bob.unreadCount(); bob.isUndrained(r.items[0].id);
    bob.keyOf(r.items[0].id); bob.signerOf(r.items[0].id);
    bob.recall(''); bob.peers(); bob.status(); bob.memoryCount(); bob.ownKey(); bob.inviteURL({ room: 'boundary' });
    pipe.tc.close();
    await h.until(() => !bob.peers().some((p) => p.peerId === alice.nodeId), 5000);
    bob.emitRecord({ categories: { focus: 'held for alice' }, to: alice.nodeId });
    await h.connectNodes(alice, bob.node);
    await h.until(() => bob.outbox.pendingFor(alice.nodeId).length === 0, 5000);
    const moved = await bob.rebuild({ room: 'boundary-2' });
    assert.ok(moved.ok, moved.error);
    bob.status();
  } finally { await alice.stop(); await bob.stop(); }
  assert.deepStrictEqual(reads, [], `the channel reached into the SDK:\n${reads.join('\n')}`);
});

test('the shipped files name nothing Core Secure retired, and import nothing from sym\'s lib/', () => {
  const shipped = require('../package.json').files
    .flatMap((f) => (f.endsWith('/') ? fs.readdirSync(path.join(root, f)).filter((x) => /\.(m?js)$/.test(x)).map((x) => path.join(f, x)) : [f]))
    .filter((f) => /\.(m?js)$/.test(f));
  assert.ok(shipped.includes('provenance.js') && shipped.includes('key-display.js') && shipped.includes('tool-queue.js'));
  const RETIRED = [/_frameHandler/, /_identityKey/, /_peerSharedSecrets/, /frame-received/, /register-agent/, /agent-cmb/, /daemon\.sock/, /@sym-bot\/sym\/lib\//];
  for (const f of shipped) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const re of RETIRED) assert.ok(!re.test(src), `${f} uses ${re}`);
  }
});
