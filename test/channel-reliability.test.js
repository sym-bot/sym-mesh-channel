#!/usr/bin/env node
'use strict';

// Phase 1 of the 2026-10-01 MMP audit: the channel's own reliability defects, found while two
// Claude sessions (sym-agent-a, sym-agent-b) were coordinating over this server.
//
//   I1  a node name held by a live process killed the server before it could say so
//   P2  a push and sym_receive named one delivery with two ids, and a fetched push stayed "unread"
//   P3  the sender printed as "<receiver>+<sender>"
//   P4  a directed send to a vanished peer said "Sent" and went nowhere
//
// Unit tests run against the shipped module (channel-delivery.js), not a copy of it. The end-to-end
// tests drive real servers over stdio, rooted in a throwaway state dir so nothing touches ~/.sym.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const cd = require('../channel-delivery.js');
const deliveryPolicy = require('../delivery-policy.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); }
}

// ── A fake engine, shaped like the parts of SymNode the channel uses ──────────
function fakeNode({ peers = 1, delivery = 'report', collapseOnce = false } = {}) {
  const stored = new Set();
  const crypto = require('crypto');
  const key = (f) => 'cmb-' + crypto.createHash('sha256').update(JSON.stringify(f)).digest('hex').slice(0, 16);
  let collapse = collapseOnce;
  return {
    peerCount: peers,
    peers() { return Array.from({ length: this.peerCount }, (_, i) => ({ peerId: 'p' + i })); },
    status() { return { peerCount: this.peerCount }; },
    remember(fields, opts = {}) {
      const k = key(fields);
      if (collapse) { collapse = false; return { key: k, collapsed: true }; }
      if (stored.has(k)) return null;
      stored.add(k);
      const entry = { key: k };
      if (delivery === 'report') {
        const dispatched = opts.to ? (this.peerCount > 0 ? 1 : 0) : this.peerCount;
        Object.defineProperty(entry, 'delivery', {
          value: { directed: !!opts.to, to: opts.to || null, dispatched, undelivered: !!opts.to && dispatched === 0 },
          enumerable: false,
        });
      }
      return entry;
    },
  };
}
const F = { focus: 'hi', issue: 'none', intent: 'directive', motivation: '', commitment: '', perspective: 'me', mood: {} };
const okS = (e, sent) => (sent ? `Sent CMB ${e.key}` : `Stored ${e.key} — no peers`);

async function unitTests() {
  console.log('\nchannel-delivery.js:');

  await test('senderOf: the deliverer, not "<receiver>+<deliverer>" (P3)', () => {
    assert.strictEqual(cd.senderOf({ source: 'claude-sym-agent-a+claude-sym-agent-b' }, 'claude-sym-agent-a'), 'claude-sym-agent-b');
    assert.strictEqual(cd.senderOf({ from: 'claude-sym-agent-a+claude-sym-agent-b' }, 'claude-sym-agent-a'), 'claude-sym-agent-b');
    assert.strictEqual(cd.senderOf({ source: 'claude-sym-agent-b' }, 'claude-sym-agent-a'), 'claude-sym-agent-b');
    // A name that merely contains a '+' is not our key and is left alone.
    assert.strictEqual(cd.senderOf({ source: 'x+y' }, 'claude-sym-agent-a'), 'x+y');
  });

  await test('senderOf: prefers entry.author.name when the engine supplies it (0.13.12)', () => {
    const e = { source: 'a+relay-node', author: { name: 'original-author', nodeId: null, via: { name: 'relay-node' } } };
    assert.strictEqual(cd.senderOf(e, 'a'), 'original-author');
  });

  await test('inboxIdFor: uses entry.inboxId when present, else the newest matching inbox item', () => {
    assert.strictEqual(cd.inboxIdFor({}, { inboxId: 'in0042' }), 'in0042');
    const inbox = { in0007: { id: 'in0007', content: 'hello', directed: true } };
    const n = { inboxStatus: () => ({ seq: 7 }), inboxGet: (id) => inbox[id] || null };
    assert.strictEqual(cd.inboxIdFor(n, { content: 'hello', directed: true }), 'in0007');
    assert.strictEqual(cd.inboxIdFor(n, { content: 'something else', directed: true }), null, 'a different newest item is not this delivery');
    assert.strictEqual(cd.inboxIdFor({ inboxStatus() { throw new Error('no inbox'); } }, { content: 'x' }), null);
  });

  await test('readTracker: a fetched item is read; the unread count drops; push alone marks nothing', () => {
    const items = { in0001: { id: 'in0001', seq: 1 }, in0002: { id: 'in0002', seq: 2 } };
    const n = { inboxGet: (id) => items[id] || null };
    const t = cd.createReadTracker();
    const status = { seq: 2, cursor: 0, undrained: 2 };
    assert.strictEqual(t.adjust(n, status).undrained, 2);
    t.markRead(n, 'in0002');
    assert.ok(t.isRead(items.in0002) && !t.isRead(items.in0001));
    assert.strictEqual(t.adjust(n, status).undrained, 1, 'the fetched item is no longer unread');
    assert.strictEqual(t.adjust(n, { seq: 2, cursor: 2, undrained: 0 }).undrained, 0, 'drained past it: nothing to subtract');
  });

  await test('readTracker: with engine inboxAck, the engine is told and its count is trusted as is', () => {
    const acked = [];
    const n = { inboxAck: (id) => acked.push(id), inboxGet: (id) => ({ id, seq: 3 }) };
    const t = cd.createReadTracker();
    t.markRead(n, 'in0003');
    assert.deepStrictEqual(acked, ['in0003']);
    assert.strictEqual(t.adjust(n, { seq: 3, cursor: 0, undrained: 2 }).undrained, 2, 'no double subtraction');
    assert.ok(t.isRead({ id: 'in0009', acked: true }), 'an item the engine marks acked is read');
  });

  await test('sendOutcome: the engine\'s report decides', () => {
    const withD = (d) => { const e = { key: 'k' }; Object.defineProperty(e, 'delivery', { value: d }); return e; };
    assert.strictEqual(cd.sendOutcome(withD({ directed: true, dispatched: 1 })), 'sent');
    assert.strictEqual(cd.sendOutcome(withD({ directed: true, dispatched: 0 })), 'undelivered');
    assert.strictEqual(cd.sendOutcome(withD({ directed: false, dispatched: 0 })), 'no-peers');
    assert.strictEqual(cd.sendOutcome({ key: 'k', collapsed: true }), 'collapsed');
    assert.strictEqual(cd.sendOutcome({ key: 'k' }), 'unknown');
  });

  await test('explicitSend: a directed send that reached no transport is NOT reported as sent (P4)', () => {
    const n = fakeNode({ peers: 0 });
    const delivered = new Set();
    const r = cd.explicitSend(n, delivered, F, { to: 'gone-peer' }, () => 'Sent to gone-peer', () => 'T');
    assert.ok(r.undelivered, 'flagged undelivered');
    assert.ok(/NOT DELIVERED/.test(r.text) && !/^Sent/.test(r.text), r.text);
    assert.strictEqual(delivered.size, 0, 'nothing is credited as delivered');
  });

  await test('explicitSend: true duplicate after a real dispatch is suppressed (no flood regression)', () => {
    const n = fakeNode({ peers: 2 }); const delivered = new Set();
    assert.ok(/^Sent CMB/.test(cd.explicitSend(n, delivered, F, {}, okS, () => 'T').text));
    assert.ok(/already delivered/.test(cd.explicitSend(n, delivered, F, {}, okS, () => 'T').text));
  });

  await test('explicitSend: an undelivered copy is re-issued once a peer connects (E8 variant c)', () => {
    const n = fakeNode({ peers: 0 }); const delivered = new Set();
    assert.ok(!/^Sent CMB/.test(cd.explicitSend(n, delivered, F, {}, okS, () => 'T').text));
    n.peerCount = 1;
    assert.ok(/Re-sent CMB/.test(cd.explicitSend(n, delivered, F, {}, okS, () => 'T').text));
  });

  await test('explicitSend: a collapsed (identical-to-HEAD) send is treated as a dedup, not as sent', () => {
    const n = fakeNode({ peers: 1, collapseOnce: true });
    const r = cd.explicitSend(n, new Set(), F, { to: 'p0' }, () => 'Sent to p0', () => 'T');
    assert.ok(/Re-sent CMB/.test(r.text), `a collapse sent nothing, so the salted re-send must go out: ${r.text}`);
  });

  await test('explicitSend: an engine with no delivery report keeps the old inference', () => {
    const n = fakeNode({ peers: 1, delivery: 'none' });
    assert.ok(/^Sent CMB/.test(cd.explicitSend(n, new Set(), F, {}, okS, () => 'T').text));
  });

  await test('staleNote: silent for a live peer, a warning past 30 s of silence', () => {
    const now = 1_000_000;
    assert.strictEqual(cd.staleNote({ name: 'b', lastSeen: now - 5000 }, now), '');
    assert.ok(/nothing has arrived from b for 45s/.test(cd.staleNote({ name: 'b', lastSeen: now - 45000 }, now)));
    assert.strictEqual(cd.staleNote(null, now), '');
  });

  console.log('\ndelivery-policy.js receive surface:');

  await test('receiveLine tags a delivery that already went out as a push', () => {
    const policy = deliveryPolicy.createDeliveryPolicy({ allowedPeers: [], maxPayloadBytes: 1 << 20 });
    const m = { id: 'in0001', from: 'b', content: 'hello', categories: { focus: { text: 'hello' } }, directed: true, receivedAt: Date.now() };
    assert.ok(/·pushed/.test(deliveryPolicy.receiveLine(m, { policy, selfName: 'a', pushed: true }).line));
    assert.ok(!/·pushed/.test(deliveryPolicy.receiveLine(m, { policy, selfName: 'a' }).line));
  });

  await test('receiveReport names deliveries already read with sym_fetch, once, without repeating them', () => {
    const r = deliveryPolicy.receiveReport({ shown: [], withheld: [], notAllowed: new Map(), alreadyRead: ['in0001'], remaining: 0, peek: false });
    assert.ok(/Already read with sym_fetch, not repeated: 1 \(in0001\)/.test(r), r);
    assert.ok(!/new mesh message/.test(r));
  });
}

// ── End to end: real servers over stdio ───────────────────────────────────────
const SERVER = path.join(__dirname, '..', 'server.js');

/** A live MCP session: send calls one at a time, collect every notification. */
function session(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SYM_RELAY_URL: '', SYM_RELAY_TOKEN: '', SYM_ALLOWED_PEERS: '', CLAUDE_PROJECT_DIR: env.SYM_STATE_DIR, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let stderr = '';
  const waiting = new Map();
  const notes = [];
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      else if (msg.method) notes.push(msg);
    }
  });
  let seq = 0;
  const request = (method, params, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out; stderr:\n${stderr.slice(-800)}`)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    const c = r.result && r.result.content;
    return { text: Array.isArray(c) && c[0] ? String(c[0].text || '') : JSON.stringify(r), isError: !!(r.result && r.result.isError) };
  };
  const init = () => request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'channel-reliability-test', version: '1' } });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const close = async () => { try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref(); await exited; };
  return { child, init, tool, notes, close, exited, stderr: () => stderr };
}

async function waitFor(pred, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await new Promise((r) => setTimeout(r, every)); }
  return null;
}

async function e2eTests() {
  console.log('\nend to end (real servers):');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-reliability-'));
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const room = `cr-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  try {
    await test('a name held by a live process: the second server starts, says why, and every tool says so (I1)', async () => {
      const env = { SYM_STATE_DIR: stateDir, SYM_NODE_NAME: `cr-holder-${suffix}`, SYM_ROOM: room };
      const first = session(env);
      await first.init();
      const second = session(env);
      try {
        const init = await Promise.race([second.init(), second.exited.then((c) => { throw new Error(`second server exited (${c}) instead of answering; stderr:\n${second.stderr().slice(-600)}`); })]);
        const instructions = String(init.result && init.result.instructions || '');
        assert.ok(/MESH NODE NOT RUNNING/.test(instructions), `instructions must name the conflict: ${instructions.slice(0, 200)}`);
        const s = await second.tool('sym_status');
        assert.ok(s.isError && /already held by a live process/.test(s.text), s.text);
        const p = await second.tool('sym_peers');
        assert.ok(p.isError && /MESH NODE NOT RUNNING/.test(p.text), 'every tool answers with the cause');
      } finally { await second.close(); await first.close(); }
    });

    await test('a directed send arrives as ONE id under the real sender, and a fetched push is not repeated (P2, P3)', async () => {
      const a = session({ SYM_STATE_DIR: stateDir, SYM_NODE_NAME: `cr-a-${suffix}`, SYM_ROOM: room });
      const b = session({ SYM_STATE_DIR: stateDir, SYM_NODE_NAME: `cr-b-${suffix}`, SYM_ROOM: room });
      try {
        await a.init(); await b.init();
        const seen = await waitFor(async () => /cr-b-/.test((await a.tool('sym_peers')).text), 30000, 1000);
        assert.ok(seen, 'the two nodes must discover each other on the LAN');
        const sent = await b.tool('sym_send', { to: `cr-a-${suffix}`, focus: `ping ${suffix}`, intent: 'test the push path' });
        assert.ok(/^Sent CMB .* \(handed to the transport; MMP has no delivery receipt\)/.test(sent.text), sent.text);

        const push = await waitFor(() => a.notes.find((n) => n.method === 'notifications/claude/channel' && n.params?.meta?.event_type === 'cmb'), 15000);
        assert.ok(push, 'agent-a must receive a channel notification');
        const header = push.params.content;
        assert.ok(header.startsWith(`[cr-b-${suffix} →you]`), `sender must be the peer alone, not "<us>+<them>": ${header}`);
        const id = (header.match(/\[(in\d{4})\]$/) || [])[1];
        assert.ok(id, `the push must carry the delivery's inbox id: ${header}`);

        const fetched = await a.tool('sym_fetch', { msg_id: id });
        assert.ok(fetched.text.startsWith(`[cr-b-${suffix}]`) && fetched.text.includes(`ping ${suffix}`), fetched.text);
        assert.ok(!/Mesh inbox: \d+ unread/.test(fetched.text), `a fetched delivery is not unread any more: ${fetched.text}`);

        const recv = await a.tool('sym_receive');
        assert.ok(new RegExp(`Already read with sym_fetch, not repeated: 1 \\(${id}\\)`).test(recv.text), recv.text);
        assert.ok(!recv.text.includes(`ping ${suffix}`), 'the fetched delivery is not shown a second time');
      } finally { await a.close(); await b.close(); }
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

(async () => {
  console.log('\nsym-mesh-channel channel reliability (audit phase 1)');
  await unitTests();
  if (process.env.SKIP_E2E === '1') console.log('\n(SKIP_E2E=1 — end-to-end tests skipped)');
  else await e2eTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
