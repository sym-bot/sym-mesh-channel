'use strict';

// push-statement.js — whether pushes reach the model is the model's own statement, with evidence only a
// received push carries (design D5). The server never infers it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const push = require('../push-statement.js');

test('a session starts unconfirmed, and only a code this process issued confirms it', () => {
  const p = push.createPushStatement();
  assert.strictEqual(p.state(), 'unconfirmed');
  assert.strictEqual(p.confirmed(), false);
  const code = p.issue();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.deepStrictEqual(p.answer({ code: 'ABCD-EFGH' }), { ok: false, state: 'unconfirmed', reason: 'wrong-code' });
  assert.deepStrictEqual(p.answer({}), { ok: false, state: 'unconfirmed', reason: 'no-code' });
  assert.strictEqual(p.answer({ code: ` ${code.toLowerCase().replace('-', '')} ` }).ok, true, 'case, spaces and the dash do not matter');
  assert.strictEqual(p.confirmed(), true);
});

test('an older check answered late still proves receipt; reaching:false states it off', () => {
  const p = push.createPushStatement();
  const first = p.issue();
  p.issue();
  assert.strictEqual(p.answer({ code: first }).ok, true);
  assert.strictEqual(p.answer({ reaching: false }).state, 'stated-off');
  assert.strictEqual(p.confirmed(), false);
});

test('codes do not repeat and carry no confusable characters', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = push.newCode();
    assert.ok(!/[01OIL]/.test(c), c);
    seen.add(c);
  }
  assert.ok(seen.size > 495);
});

test('the status line says only what the session stated: no guess, no "probably"', () => {
  let t = 1_000;
  const p = push.createPushStatement({ now: () => t });
  assert.match(push.statusLine(p), /^Push: not confirmed — no push check has been sent yet/);
  const code = p.issue(); p.sent();
  assert.match(push.statusLine(p), /a push check was sent at .* and has not been answered/);
  t = 2_000;
  p.answer({ code });
  assert.match(push.statusLine(p), /^Push: confirmed by this session at 1970-01-01T00:00:02.000Z/);
  assert.ok(!/probably/i.test(push.statusLine(p)));
});

test('the check is our own words and names the tool and the code', () => {
  const t = push.checkText('K7QX-29FM', "node 'alice'");
  assert.match(t, /sym_push_confirm \{"code":"K7QX-29FM"\}/);
  assert.match(t, /node 'alice'/);
});

test('no launch-line reader is left anywhere in the shipped code (root cause 4)', () => {
  const root = path.join(__dirname, '..');
  for (const f of require('../package.json').files.filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/SYM_CHANNEL_PUSH|SYM_CHANNEL_MCP_NAME|Win32_Process/.test(src), `${f} still reads a push setting or the process tree`);
    assert.ok(!/execFileSync\(\s*'ps'/.test(src), `${f} walks the process tree`);
  }
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(!/dangerously-load-development-channels/.test(server), 'server.js no longer reads the launch flag');
});
