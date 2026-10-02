'use strict';

// The test sandbox starts clean (design D12, review M5 and r9). A run started from inside an XMesh mind
// session, or a pinned agent's shell, must not reach the real node or identity: the harness and the
// runner refuse to start, and every child gets an environment built from an allowlist.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanEnv, dangerous } = require('./_clean-env.js');

const root = path.join(__dirname, '..');
const base = cleanEnv({ HOME: process.env.HOME || require('node:os').tmpdir() });

test('r9: the harness refuses to start under an XMesh mind\'s or a pinned agent\'s variables', () => {
  for (const [k, v] of [['SYM_INTERIOR_SOCKET', '/tmp/real-node.sock'], ['SYM_INTERIOR_CAPABILITY', 'cap'], ['SYM_IDENTITY_DIR', '/x'], ['SYM_NODE_ID', '01a0fd15-0000-7000-8000-000000000001'], ['SYM_ALLOWED_PEERS', 'x']]) {
    const r = spawnSync(process.execPath, ['-e', "require('./test/_harness.js')"], { cwd: root, env: { ...base, [k]: v }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${k}: the harness must not load`);
    assert.match(r.stderr, new RegExp(`refuses to start: ${k}`));
  }
});

test('the runner refuses too, before running any file', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'test', 'run.js')], { cwd: root, env: { ...base, SYM_INTERIOR_SOCKET: '/tmp/x.sock' }, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /test\/run\.js refuses to start: SYM_INTERIOR_SOCKET/);
  assert.ok(!/── /.test(r.stdout), 'no test file ran');
});

test('a child environment is built from an allowlist: none of the session\'s variables pass', () => {
  const env = cleanEnv({ HOME: '/sandbox' }, { PATH: '/bin', CLAUDE_CODE_SESSION_ID: 's', SYM_INTERIOR_SOCKET: '/x', SYM_RELAY_TOKEN: 't', NODE_OPTIONS: '--require evil', HOME: '/real' });
  assert.deepStrictEqual(env, { PATH: '/bin', HOME: '/sandbox' });
  assert.deepStrictEqual(dangerous({ SYM_INTERIOR_KIND: 'observe', SYM_ROOM: 'x' }), ['SYM_INTERIOR_KIND']);
});
