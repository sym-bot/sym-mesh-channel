'use strict';

// Interior mode (design D7; XMesh C2; sym D8, D9.3): the channel attaches as a node's mind. Against a
// real sym 0.14 node it submits drafts the node signs, says the node's refusals in plain words, reports
// the SDK's missing read side, and ends the mind when the host's stdin closes. Against a stub that
// speaks the read requests the design proposes (§6 item 1), deliveries reach the model with their facts.

const h = require('./_harness.js'); // sandbox first
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const sdk = require('@sym-bot/sym');
const { InteriorHost, readCapability } = require('../interior-host.js');

const t = h.suite('interior mode');
const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
const NODE = '01a0fd15-52ca-7999-8999-000000000999';
const KEY = `cmb-${'9'.repeat(64)}`;
const KA = require('node:crypto').randomBytes(32).toString('base64url');
const { fingerprint } = require('../key-display.js');

function capFile(cap) {
  const f = path.join(fs.mkdtempSync(path.join(process.env.HOME, 'cap-')), 'capability');
  fs.writeFileSync(f, cap, { mode: 0o600 });
  return f;
}

/**
 * A node interior that speaks the read side the design builds to (§6 item 8), with the capability bound
 * to the first connection that presents it.
 */
async function stubInterior({ capability, items = [], refuseRecall = null }) {
  const sockPath = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'stub-')), 's.sock');
  const submitted = [];
  let ended = false;
  let cursor = 0;
  let boundTo = null;
  let connections = 0;
  const clients = new Set();
  const server = net.createServer((sock) => {
    clients.add(sock);
    connections++;
    sock.on('close', () => clients.delete(sock));
    let buf = '';
    sock.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const reply = (o) => sock.write(JSON.stringify({ id: req.id, ...o }) + '\n');
        if (req.capability !== capability || ended) { reply({ type: 'refused', reason: 'no-live-capability' }); continue; }
        if (boundTo && boundTo !== sock) { reply({ type: 'refused', reason: 'capability-bound-elsewhere' }); continue; }
        boundTo = sock;
        if (req.type === 'submit') { submitted.push(req); reply({ type: 'submitted', key: KEY, assertionId: 'asrt-stub' }); }
        else if (req.type === 'end') { ended = true; reply({ type: 'ended' }); }
        else if (req.type === 'mission') reply({ type: 'mission', mindId: 'mind-1', missionId: 'mission-7', kinds: ['observe'], allowTo: [A], ratePerMinute: 60, nodeId: NODE, name: 'cog-node', room: 'team' });
        else if (req.type === 'subscribe') reply({ type: 'subscribed' });
        else if (req.type === 'deliveries') {
          const fresh = items.filter((x) => x.seq > cursor).slice(0, req.limit || 50);
          if (!req.peek && fresh.length) cursor = fresh[fresh.length - 1].seq;
          reply({ type: 'deliveries', items: fresh, cursor, remaining: 0 });
        } else if (req.type === 'ack') reply({ type: 'acked' });
        else if (req.type === 'recall') {
          if (refuseRecall) reply({ type: 'refused', reason: refuseRecall });
          else reply({ type: 'recall', items: [{ key: KEY, record: { categories: { focus: { text: 'a stored record' } } }, verified: true, storedAt: 1, author: { name: 'alice', nodeId: A, key: KA } }, { key: KEY, record: { categories: { focus: { text: 'NO-AUTHOR record' } } }, verified: true, storedAt: 2 }] });
        }
        else reply({ type: 'refused', reason: 'unknown-request' });
      }
    });
  });
  await new Promise((r) => server.listen(sockPath, r));
  return {
    sockPath, submitted, get ended() { return ended; }, get connections() { return connections; },
    kickAll() { for (const c of clients) c.destroy(); },
    push(item) { for (const c of clients) c.write(JSON.stringify({ type: 'delivery', item }) + '\n'); },
    close: () => new Promise((r) => { for (const c of clients) c.destroy(); server.close(() => r()); }),
  };
}

const servedItem = (seq, over = {}) => ({
  seq, id: `in${String(seq).padStart(4, '0')}`, kind: 'cmb', receivedAt: Date.now(), remixed: true,
  record: { categories: { focus: { text: `served delivery ${seq}` } }, metadata: { key: KEY, assertionId: `asrt-${seq}`, room: 'team', createdBy: 'alice' } },
  verified: true, profile: 'core-secure', assertionId: `asrt-${seq}`,
  author: { name: 'alice', nodeId: A, key: KA, via: { name: 'alice', nodeId: A } },
  verification: { suite: 'mmp-sig-v2.0', assertionId: `asrt-${seq}`, authorNodeId: A, authorName: 'alice', authorKey: KA, authorKeySource: 'proven', audience: 'directed', room: 'team', to: NODE, relayed: false },
  session: { nodeId: A, name: 'alice', identityKey: KA, transport: 'lan', profile: 'core-secure' },
  ...over,
});

t('against a real sym 0.14 node: signed submissions, refusals in plain words, the read gap said, the mind ended on exit', async () => {
  const node = new sdk.SymNode({ name: `cog-${Date.now().toString(36)}`, room: 'cog-room', relayOnly: true, silent: true });
  await node.start();
  const sock = await node.interior().listen();
  const mind = node.interior().startMind({ id: 'mission-1', kinds: ['observe', 'report'] });
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: sock, SYM_INTERIOR_CAPABILITY_FILE: capFile(mind.capability), SYM_INTERIOR_KINDS: 'observe,report' } });
  try {
    await s.initialize();
    assert.match(s.instructions, /You are the mind of a SYM mesh node, attached to its interior/);
    assert.match(s.instructions, /does not serve its deliveries/);
    const names = (await s.tools()).map((x) => x.name);
    assert.ok(!names.includes('sym_peers') && !names.includes('sym_join_room'), names.join(','));
    assert.ok((await s.tools()).find((x) => x.name === 'sym_publish').inputSchema.properties.kind);
    assert.match((await s.call('sym_publish', { focus: 'no kind given' })).text, /must name a submission kind \(the mission's kinds: observe, report\)/);
    const ok = await s.call('sym_publish', { kind: 'observe', focus: 'the mind observes the build is green' });
    assert.match(ok.text, /^Submitted as kind 'observe': the node signed and sent CMB cmb-[0-9a-f]{64} \(assertion asrt-/);
    const stored = node.recall('').map((e) => e.cmb.categories.focus.text);
    assert.ok(stored.includes('the mind observes the build is green'), 'the node signed it as itself and keeps it');
    assert.match((await s.call('sym_publish', { kind: 'deploy', focus: 'x' })).text, /^Not submitted: the mission did not declare that kind/);
    assert.match((await s.call('sym_send', { kind: 'report', to: A, focus: 'x' })).text, /^Not submitted: the mission's allowlist does not include that recipient/);
    assert.match((await s.call('sym_send', { kind: 'report', to: 'alice', focus: 'x' })).text, /never a name/);
    assert.match((await s.call('sym_receive')).text, /does not serve deliveries \(the node answered unknown-request\).*That is not an empty inbox/);
    assert.match((await s.call('sym_peers')).text, /not available in interior mode/);
    const st = (await s.call('sym_status')).text;
    assert.match(st, /The node serves: deliveries no \(it answered unknown-request\)/);
    assert.match(st, /attached \(the capability is bound to this one connection\)/);
    assert.match(st, /Submissions: 1 signed and sent, 2 refused/);
    assert.ok(!s.pushes().some((p) => p.type === 'push-check'), 'nothing to push, so no push check');
    assert.strictEqual(node.interior().busy, true);
    await s.close();
    await h.until(() => !node.interior().busy, 3000);
    assert.strictEqual(node.interior().busy, false, 'stdin closed: the mind was ended and its capability revoked');
  } finally { await s.close(); await node.stop(); }
});

t('without a capability, interior mode attaches nothing and every tool says why', async () => {
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: '/nonexistent.sock', SYM_INTERIOR_CAPABILITY: '', SYM_INTERIOR_CAPABILITY_FILE: '' } });
  try {
    await s.initialize();
    assert.match(s.instructions, /^INTERIOR MODE NOT ATTACHED: SYM_INTERIOR_SOCKET is set, but no capability was given/);
    const r = await s.call('sym_publish', { focus: 'x' });
    assert.strictEqual(r.isError, true);
    assert.match(r.text, /INTERIOR MODE NOT ATTACHED/);
  } finally { await s.close(); }
});

t('a socket that cannot be opened is named, not a crash', async () => {
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: path.join(process.env.HOME, 'no-such.sock'), SYM_INTERIOR_CAPABILITY: 'cap' } });
  try {
    await s.initialize();
    assert.match(s.instructions, /INTERIOR MODE NOT ATTACHED: could not open .*no-such\.sock/);
  } finally { await s.close(); }
});

t('against the read side the design builds to: deliveries gated by their own facts, push, fetch, cite, recall, end', async () => {
  const cap = 'stub-capability';
  const noFacts = servedItem(3, { verified: undefined, profile: undefined, verification: undefined, session: undefined, record: { categories: { focus: { text: 'MARKER-UNPROVEN' } }, metadata: { key: KEY, assertionId: 'asrt-3' } } });
  const stub = await stubInterior({ capability: cap, items: [servedItem(1), noFacts] });
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: stub.sockPath, SYM_INTERIOR_CAPABILITY: cap } });
  const tag = `alice ⟨…${fingerprint(KA).slice(-8)}⟩`;
  try {
    await s.initialize();
    assert.match(s.instructions, /the mind of the SYM mesh node cog-node \(01a0fd15-52ca-7999-8999-000000000999\)/);
    assert.match(s.instructions, /kinds: observe/);
    assert.ok(await s.waitForPush((p) => p.type === 'push-check', 5000), 'a node that streams deliveries gets a push check');
    const r = (await s.call('sym_receive')).text;
    assert.match(r, new RegExp(`\\[${tag} →you\\] "served delivery 1" \\[in0001\\] key cmb-9{64}`));
    assert.match(r, /\[in0003\] withheld, not verified: it carries no Core Secure provenance/, 'an item without its own facts is not shown');
    assert.ok(!/MARKER-UNPROVEN/.test(r));
    const f = (await s.call('sym_fetch', { msg_id: 'in0001' })).text;
    assert.match(f, new RegExp(`Signed by: alice — nodeId ${A}; key fingerprint ${fingerprint(KA)}`));
    stub.push(servedItem(2, { record: { categories: { focus: { text: 'pushed through the interior' } }, metadata: { key: KEY, assertionId: 'asrt-2' } } }));
    const pushed = await s.waitForPush((p) => /pushed through the interior/.test(p.text), 5000);
    assert.ok(pushed, 'a streamed delivery is pushed like any other');
    const sent = await s.call('sym_send', { to: 'in0001', parents: ['in0001'], focus: 'answering alice' });
    assert.match(sent.text, new RegExp(`^Submitted as kind 'observe'.* to ${A}\\. Lineage: 1 parent`));
    assert.deepStrictEqual(stub.submitted[0].parents, [KEY], 'the delivery id was resolved to its key');
    assert.strictEqual(stub.submitted[0].to, A, 'and `to` to its verified signer');
    const rec = (await s.call('sym_recall', { query: '' })).text;
    assert.match(rec, new RegExp(`\\[${tag}\\].*\\n {2}"a stored record"`));
    assert.ok(!/NO-AUTHOR|\(this node\)/.test(rec), `an item with no author is neither shown nor this node's own (L3): ${rec}`);
    await s.close();
    await h.until(() => stub.ended, 3000);
    assert.strictEqual(stub.ended, true);
    assert.strictEqual(stub.connections, 1, 'one connection for the life of the mind');
  } finally { await s.close(); await stub.close(); }
});

t('L6: a refusal is a refusal, not "unsupported"; a closed bound connection detaches the mind, which never reconnects', async () => {
  const cap = 'stub-capability-2';
  const stub = await stubInterior({ capability: cap, items: [servedItem(1)], refuseRecall: 'rate' });
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: stub.sockPath, SYM_INTERIOR_CAPABILITY: cap } });
  try {
    await s.initialize();
    const rec = (await s.call('sym_recall', { query: '' })).text;
    assert.match(rec, /^The node refused the recall: the mission's submission rate is used up/);
    assert.doesNotMatch((await s.call('sym_status')).text, /recall no \(/, 'a refusal says nothing about what the node serves');
    stub.kickAll();
    await new Promise((r) => setTimeout(r, 200));
    const after = await s.call('sym_publish', { focus: 'after the node closed' });
    assert.strictEqual(after.isError, true);
    assert.match(after.text, /detached/);
    assert.match((await s.call('sym_status')).text, /DETACHED: the node closed the interior connection/);
    assert.strictEqual(stub.connections, 1, 'the capability is never presented on a second connection');
  } finally { await s.close(); await stub.close(); }
});

t('L6: the capability file must be this user\'s and private; a loose or odd one is refused, never used', async () => {
  const f = capFile('from-file');
  assert.deepStrictEqual(readCapability({ SYM_INTERIOR_CAPABILITY_FILE: f, SYM_INTERIOR_CAPABILITY: 'from-env' }), { capability: 'from-file', source: 'file' });
  if (process.platform !== 'win32') {
    fs.chmodSync(f, 0o644);
    const loose = readCapability({ SYM_INTERIOR_CAPABILITY_FILE: f });
    assert.strictEqual(loose.capability, null);
    assert.match(loose.error, /readable or writable by other users/);
  }
  assert.match(readCapability({ SYM_INTERIOR_CAPABILITY_FILE: path.dirname(f) }).error, /not a regular file/);
  assert.match(readCapability({ SYM_INTERIOR_CAPABILITY_FILE: '/no/such/file' }).error, /cannot read/);
  assert.deepStrictEqual(readCapability({ SYM_INTERIOR_CAPABILITY: ' tok ' }), { capability: 'tok', source: 'env' });
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: path.join(process.env.HOME, 'x.sock'), SYM_INTERIOR_CAPABILITY_FILE: f } });
  try {
    await s.initialize();
    assert.match(s.instructions, /^INTERIOR MODE NOT ATTACHED: .*readable or writable by other users/);
  } finally { await s.close(); }
  const stub = await stubInterior({ capability: 'right' });
  const host = new InteriorHost({ socketPath: stub.sockPath, capability: 'wrong', defaultKind: 'observe' });
  try {
    await host.start();
    const out = await host.emitRecord({ categories: { focus: 'x' } });
    assert.strictEqual(out.outcome, 'refused');
    assert.match(out.text, /capability is not live/);
  } finally { await host.stop(); await stub.close(); }
});

t.run();
