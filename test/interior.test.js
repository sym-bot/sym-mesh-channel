'use strict';

// Interior mode (design D9; XMesh C2; sym D8, D9.3): the channel attaches as a node's mind. Against a
// real sym 0.14 node's interior: the mission, the read side scoped to it (sym ruling C), deliveries gated
// by their own facts, the push, fetch, citing a delivery, recall, the kind signed as the intent, the
// refusals in plain words, the capability bound to its one connection (sym's name for the refusal:
// capability-bound-to-another-connection), and the mind ended when the host's stdin closes. One small
// stub stands for a node whose interior serves no read side, so "unsupported" is told from "refused".

const h = require('./_harness.js'); // sandbox first
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const sdk = require('@sym-bot/sym');
const { InteriorHost, readCapability, said } = require('../interior-host.js');
const { fingerprint, fullFingerprint } = require('../key-display.js');

const t = h.suite('interior mode');
const ROOM = 'cog-room';
const uniq = (b) => `${b}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const node = (name) => new sdk.SymNode({ name: uniq(name), room: ROOM, relayOnly: true, silent: true });

function capFile(cap) {
  const f = path.join(fs.mkdtempSync(path.join(process.env.HOME, 'cap-')), 'capability');
  fs.writeFileSync(f, cap, { mode: 0o600 });
  return f;
}

/** One request on a fresh connection to an interior socket: the raw reply. */
function rawRequest(sockPath, body) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath);
    let buf = '';
    c.on('error', reject);
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i !== -1) { c.destroy(); resolve(JSON.parse(buf.slice(0, i))); }
    });
    c.on('connect', () => c.write(JSON.stringify({ id: 'raw-1', ...body }) + '\n'));
  });
}

/** A cog node with its interior listening, alice connected to it, and `start()` for one mind. */
async function cogWithMind(mission) {
  const cog = node('cog');
  const alice = node('alice');
  await cog.start(); await alice.start();
  await h.connectNodes(alice, cog);
  const sock = await cog.interior().listen();
  return { cog, alice, sock, start: () => cog.interior().startMind({ allowTo: [alice.nodeId], ...mission }) };
}

t('against a real node: the mission, its read view, push, fetch, cite, recall, the kind as the intent, and the mind ended on exit', async () => {
  const { cog, alice, sock, start } = await cogWithMind({ id: 'mission-7', kinds: ['observe', 'report'] });
  const arrived = [];
  alice.on('verified-record', (e) => arrived.push(e));
  // Delivered before the mind started: not in its view (sym ruling C).
  alice.remember({ focus: 'MARKER-BEFORE the mind started' }, { to: cog.nodeId });
  await h.until(() => cog.inbox({ peek: true }).messages.length >= 1, 5000);
  const mind = start();
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: sock, SYM_INTERIOR_CAPABILITY_FILE: capFile(mind.capability) } });
  const tag = `${alice.name} ⟨…${fingerprint(alice.publicKey).slice(-8)}⟩`;
  try {
    await s.initialize();
    assert.match(s.instructions, new RegExp(`the mind of the SYM mesh node ${cog.name} \\(${cog.nodeId}\\)`));
    assert.match(s.instructions, /kinds: observe, report/);
    assert.match(s.instructions, /signs the kind as the record's intent/);
    assert.ok(await s.waitForPush((p) => p.type === 'push-check', 5000), 'a node that streams deliveries gets a push check');

    alice.remember({ focus: 'served delivery one' }, { to: cog.nodeId, payload: { ticket: 7 } });
    const pushed = await s.waitForPush((p) => /served delivery one/.test(p.text), 5000);
    assert.ok(pushed, 'a delivery in the mind\'s view is pushed');
    const id = (pushed.text.match(/\[(in\d{4,})\]/) || [])[1];
    assert.ok(id, pushed.text);

    const r = (await s.call('sym_receive')).text;
    assert.match(r, new RegExp(`\\[${tag} →you\\] "served delivery one".* \\[${id}\\] key cmb-[0-9a-f]{64}`));
    assert.ok(!/MARKER-BEFORE/.test(r), 'what arrived before the mind started is not in its view');

    const f = (await s.call('sym_fetch', { msg_id: id })).text;
    assert.match(f, new RegExp(`Signed by: ${alice.name} — nodeId ${alice.nodeId}; key fingerprint ${fullFingerprint(alice.publicKey)}`));
    assert.match(f, /"ticket": 7/, 'the payload is read from the record\'s signed application section');

    const sent = await s.call('sym_send', { kind: 'report', to: id, parents: [id], focus: 'answering alice' });
    assert.match(sent.text, new RegExp(`^Submitted as kind 'report'.* to ${alice.nodeId}\\. Lineage: 1 parent`));
    await h.until(() => arrived.some((e) => e.record.categories.focus.text === 'answering alice'), 5000);
    const reply = arrived.find((e) => e.record.categories.focus.text === 'answering alice');
    assert.strictEqual(reply.verification.authorNodeId, cog.nodeId, 'the node signed it as itself');
    assert.strictEqual(reply.record.categories.intent.text, 'report', 'the kind is the signed intent');
    assert.strictEqual(reply.record.metadata.lineage.parents.length, 1, 'cited by key');

    assert.match((await s.call('sym_publish', { kind: 'observe', intent: 'deploy now', focus: 'x' })).text, /^Not submitted: the intent category must be the submission's kind/);
    assert.match((await s.call('sym_publish', { kind: 'deploy', focus: 'x' })).text, /^Not submitted: the mission did not declare that kind/);
    assert.match((await s.call('sym_send', { kind: 'report', to: '01a0fd15-0000-7000-8000-00000000beef', focus: 'x' })).text, /^Not submitted: the mission's allowlist does not include that recipient/);
    assert.match((await s.call('sym_send', { kind: 'report', to: 'alice', focus: 'x' })).text, /never a name/);
    assert.match((await s.call('sym_publish', { focus: 'no kind given' })).text, /must name a submission kind \(the mission's kinds: observe, report\)/);
    const ok = await s.call('sym_publish', { kind: 'observe', focus: 'the mind observes the build is green' });
    assert.match(ok.text, /^Submitted as kind 'observe': the node signed and sent CMB cmb-[0-9a-f]{64} \(assertion /);
    assert.ok(cog.recall('').some((e) => e.cmb.categories.focus.text === 'the mind observes the build is green'));

    const rec = (await s.call('sym_recall', { query: '' })).text;
    assert.match(rec, /\(this node\)/, rec);
    assert.ok(!/MARKER-BEFORE/.test(rec), 'recall is the mission\'s scope too');

    const st = (await s.call('sym_status')).text;
    assert.match(st, /The node serves: deliveries yes, push yes, recall yes/);
    assert.match(st, /attached \(the capability is bound to this one connection\)/);
    assert.match(st, /^Versions: @sym-bot\/mesh-channel \S+; @sym-bot\/sym \S+ loaded by this server/m);
    assert.match(st, /Submissions: 2 signed and sent, 3 refused/);

    // The capability is bound to this session's connection: presented on another, sym refuses it by name.
    const other = await rawRequest(sock, { type: 'mission', capability: mind.capability });
    assert.deepStrictEqual([other.type, other.reason], ['refused', 'capability-bound-to-another-connection']);
    assert.match(said(other.reason), /bound to another connection/);

    assert.strictEqual(cog.interior().busy, true);
    await s.close();
    await h.until(() => !cog.interior().busy, 3000);
    assert.strictEqual(cog.interior().busy, false, 'stdin closed: the mind was ended and its capability revoked');
  } finally { await s.close(); await alice.stop(); await cog.stop(); }
});

t('L6: a refusal is a refusal, not "unsupported"; a closed bound connection detaches the mind, which never reconnects', async () => {
  const { cog, alice, sock, start } = await cogWithMind({ id: 'mission-8', kinds: ['observe'] });
  const mind = start();
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: sock, SYM_INTERIOR_CAPABILITY_FILE: capFile(mind.capability) } });
  try {
    await s.initialize();
    // The node ends the mind; the connection stays, and every request is refused, not unknown.
    assert.strictEqual(cog.interior().endMind(mind.mindId), true);
    const rec = (await s.call('sym_recall', { query: '' })).text;
    assert.match(rec, /^The node refused the recall: this mind's capability is not live/);
    assert.doesNotMatch((await s.call('sym_status')).text, /recall no \(/, 'a refusal says nothing about what the node serves');
    // The node closes its interior: the bound connection is gone, so this mind is detached for good,
    // even when the node listens again with a new mind.
    cog.interior().close();
    await new Promise((r) => setTimeout(r, 200));
    await cog.interior().listen();
    cog.interior().startMind({ id: 'mission-9', kinds: ['observe'] });
    const after = await s.call('sym_publish', { kind: 'observe', focus: 'after the node closed' });
    assert.strictEqual(after.isError, true);
    assert.match(after.text, /detached/);
    assert.match((await s.call('sym_status')).text, /DETACHED: the node closed the interior connection/);
    assert.strictEqual(cog.interior().stats().submitted, 0, 'nothing was submitted on a second connection');
  } finally { await s.close(); await alice.stop(); await cog.stop(); }
});

t('a node whose interior serves no read side is said to, which is not an empty inbox', async () => {
  // The one stub: an interior that takes submit and end and answers unknown-request to the rest.
  const sockPath = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'stub-')), 's.sock');
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const reply = req.type === 'submit' ? { type: 'submitted', key: `cmb-${'9'.repeat(64)}`, assertionId: 'asrt-stub' }
          : req.type === 'end' ? { type: 'ended' } : { type: 'refused', reason: 'unknown-request' };
        c.write(JSON.stringify({ id: req.id, ...reply }) + '\n');
      }
    });
  });
  await new Promise((r) => server.listen(sockPath, r));
  const s = new h.McpSession({ env: { SYM_INTERIOR_SOCKET: sockPath, SYM_INTERIOR_CAPABILITY: 'cap', SYM_INTERIOR_KINDS: 'observe' } });
  try {
    await s.initialize();
    assert.match(s.instructions, /does not serve its deliveries \(it answered unknown-request\)/);
    assert.match((await s.call('sym_receive')).text, /does not serve deliveries \(the node answered unknown-request\).*That is not an empty inbox/);
    assert.match((await s.call('sym_status')).text, /The node serves: deliveries no \(it answered unknown-request\)/);
    assert.match((await s.call('sym_publish', { focus: 'still submits' })).text, /^Submitted as kind 'observe'/);
    assert.match((await s.call('sym_peers')).text, /not available in interior mode/);
  } finally { await s.close(); await new Promise((r) => server.close(r)); }
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
  // A real node refuses a capability that is not its mind's.
  const { cog, alice, sock, start } = await cogWithMind({ id: 'mission-10', kinds: ['observe'] });
  start();
  const host = new InteriorHost({ socketPath: sock, capability: 'wrong', defaultKind: 'observe' });
  try {
    await host.start();
    const out = await host.emitRecord({ categories: { focus: 'x' } });
    assert.strictEqual(out.outcome, 'refused');
    assert.strictEqual(out.reason, 'no-live-capability');
    assert.match(out.text, /capability is not live/);
  } finally { await host.stop(); await alice.stop(); await cog.stop(); }
});

t.run();
