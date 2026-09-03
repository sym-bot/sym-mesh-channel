#!/usr/bin/env node
/**
 * The relay's state must reach the session — the Claude behind the plugin — through the
 * surface it already reads: tool results and channel notifications. Before this, a session
 * whose token a relay refused saw `Relay: disconnected` and "Discovering peers" while the
 * relay's log filled with its rejections; the only party who could see the fault was the
 * relay operator, and the only party who could apply the fix was the session.
 *
 * Real JSON-RPC over stdio against a real (fake) relay on a loopback port: the tool text is
 * what a session reads, so that is what is asserted.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const { WebSocketServer } = require('ws');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

/** A relay that answers every auth the same way. */
function fakeRelay(answer) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => ws.on('message', () => answer(ws)));
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise((r) => wss.close(() => r())) };
}

/** One MCP session over stdio. Collects responses AND notifications. */
function mcpCall(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, SYM_NODE_NAME: 'relay-surface-test', SYM_ROOM: 'relay-surface-test-room', SYM_RELAY_URL: '', SYM_RELAY_TOKEN: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP server did not answer in time')); }, 40000);
    // Requests go one at a time, each after the previous answer: the server handles calls
    // concurrently, and a sym_status sent alongside a sym_join_room would be answered by the
    // node the join is in the middle of replacing.
    let sent = 0;
    const sendNext = () => { if (sent < requests.length) child.stdin.write(JSON.stringify(requests[sent++]) + '\n'); };
    child.stdout.on('data', (d) => {
      out += String(d);
      const parsed = [];
      for (const l of out.split('\n').filter(Boolean)) { try { parsed.push(JSON.parse(l)); } catch { /* partial */ } }
      const answered = parsed.filter((p) => p.id !== undefined).length;
      if (answered >= requests.length + 1) {
        clearTimeout(timer); child.kill(); resolve(parsed);
      } else if (answered === sent + 1) {
        sendNext();
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'relay-surface-test', version: '1' } },
    }) + '\n');
  });
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const textOf = (byId, id) => {
  const r = byId.get(id);
  const c = r && r.result && r.result.content;
  return Array.isArray(c) && c[0] ? String(c[0].text || '') : JSON.stringify(r);
};
const isError = (byId, id) => !!(byId.get(id) && byId.get(id).result && byId.get(id).result.isError);

(async () => {
  console.log('\nrelay state — MCP surface\n');

  // ── Invites mint the credential ─────────────────────────────
  {
    const responses = await mcpCall([
      call(1, 'sym_invite_create', { room: 'relay-surface-team', cross_network: true }),
      call(2, 'sym_invite_create', { room: 'relay-surface-team', relay_token: 'changeme' }),
      call(3, 'sym_invite_create', { room: 'relay-surface-team' }),
    ]);
    const byId = new Map(responses.filter((r) => r.id !== undefined).map((r) => [r.id, r]));

    check('cross_network=true mints a token ≥32 chars and points at the hosted relay', () => {
      const t = textOf(byId, 1);
      const m = t.match(/sym:\/\/team\/relay-surface-team\?relay=([^&\s]+)&token=([^\s]+)/);
      assert.ok(m, `no team invite in: ${t}`);
      assert.strictEqual(decodeURIComponent(m[1]), 'wss://sym-relay.onrender.com');
      const token = decodeURIComponent(m[2]);
      assert.ok(token.length >= 32, `token too short to be admitted: ${token.length}`);
      assert.ok(/^[A-Za-z0-9_-]+$/.test(token), 'base64url alphabet');
      assert.ok(/minted just now/.test(t), 'says the token was minted here');
      assert.ok(/no per-device revocation/.test(t), 'says what rotation is and is not');
      assert.ok(t.includes('"relay_token"'), 'gives the sym_join_room call the creator must make to be reachable');
    });

    check('a short caller-supplied token for the hosted relay is refused here, before the relay refuses it', () => {
      assert.ok(isError(byId, 2), 'isError');
      assert.ok(/8 characters; the hosted relay admits 32 or more/.test(textOf(byId, 2)), textOf(byId, 2));
    });

    check('a LAN invite is unchanged: no relay, no token', () => {
      const t = textOf(byId, 3);
      assert.ok(/sym:\/\/room\/relay-surface-team\b/.test(t));
      assert.ok(!/token/.test(t));
    });
  }

  // ── Refused: the join result IS the refusal, the status repeats it, the channel is told ──
  {
    const refusing = fakeRelay((ws) => {
      ws.send(JSON.stringify({ type: 'relay-error', kind: 'auth', code: 4003, message: 'Token is a documentation example — mint your own (sym_invite_create does)' }));
      ws.close(4003, 'Token is a documentation example — mint your own (sym_invite_create does)');
    });
    const responses = await mcpCall([
      call(1, 'sym_join_room', { room: 'relay-surface-team', relay_url: refusing.url, relay_token: 'x'.repeat(40) }),
      call(2, 'sym_status', {}),
    ]);
    await refusing.close();
    const byId = new Map(responses.filter((r) => r.id !== undefined).map((r) => [r.id, r]));
    const notes = responses.filter((r) => r.method === 'notifications/claude/channel');

    check('sym_join_room over a refusing relay returns isError with the relay\'s reason and the fix', () => {
      assert.ok(isError(byId, 1), `isError expected: ${textOf(byId, 1)}`);
      const t = textOf(byId, 1);
      assert.ok(/Relay: REFUSED by ws:\/\/127\.0\.0\.1:\d+ \(4003: Token is a documentation example/.test(t), t);
      assert.ok(/sym_invite_create/.test(t) && /sym_join_room/.test(t), 'the fix is in the result');
      assert.ok(/nothing crosses the relay until this is fixed/.test(t));
      assert.ok(!/Discovering peers/.test(t), 'no false "discovering peers"');
      assert.ok(!t.includes('x'.repeat(40)), 'the token is not echoed');
    });

    check('sym_status repeats the same line', () => {
      assert.ok(/^Relay: REFUSED by ws:/m.test(textOf(byId, 2)), textOf(byId, 2));
    });

    check('one relay-auth-refused channel notification reaches the session, with the fix, without the token', () => {
      const r = notes.filter((n) => n.params && n.params.meta && n.params.meta.event_type === 'relay-auth-refused');
      assert.strictEqual(r.length, 1, `expected exactly one, got ${r.length}`);
      const body = JSON.parse(r[0].params.content);
      assert.strictEqual(body.code, 4003);
      assert.ok(/sym_invite_create/.test(body.text));
      assert.ok(!r[0].params.content.includes('x'.repeat(40)));
    });
  }

  // ── Admitted: the join result says connected ────────────────
  {
    const admitting = fakeRelay((ws) => ws.send(JSON.stringify({ type: 'relay-peers', peers: [] })));
    const responses = await mcpCall([
      call(1, 'sym_join_room', { room: 'relay-surface-team', relay_url: admitting.url, relay_token: 'y'.repeat(40) }),
      call(2, 'sym_status', {}),
    ]);
    await admitting.close();
    const byId = new Map(responses.filter((r) => r.id !== undefined).map((r) => [r.id, r]));

    check('sym_join_room over an admitting relay reports connected, not isError', () => {
      assert.ok(!isError(byId, 1));
      assert.ok(/Relay: connected to ws:\/\/127\.0\.0\.1:\d+ for \d+s, 0 relay peer\(s\)/.test(textOf(byId, 1)), textOf(byId, 1));
    });
    check('sym_status agrees', () => {
      assert.ok(/^Relay: connected to ws:/m.test(textOf(byId, 2)), textOf(byId, 2));
    });
  }

  // ── Unreachable: bounded wait, then the honest state ────────
  {
    const gone = fakeRelay(() => {});
    const url = gone.url;
    await gone.close();
    const t0 = Date.now();
    const responses = await mcpCall([
      call(1, 'sym_join_room', { room: 'relay-surface-team', relay_url: url, relay_token: 'z'.repeat(40) }),
    ]);
    const byId = new Map(responses.filter((r) => r.id !== undefined).map((r) => [r.id, r]));
    check('sym_join_room over an unreachable relay returns within the bound, says unreachable and that LAN is unaffected', () => {
      assert.ok(Date.now() - t0 < 25000, 'bounded');
      const t = textOf(byId, 1);
      assert.ok(!isError(byId, 1), 'transient, so not an error');
      assert.ok(/Relay: unreachable: ws:\/\/127\.0\.0\.1:\d+ \(last (close|error)/.test(t), t);
      assert.ok(/LAN peers are unaffected/.test(t));
      assert.ok(/keeps retrying in the background/.test(t));
    });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
