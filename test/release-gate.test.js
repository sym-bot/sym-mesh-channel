'use strict';

// The release gate (design D12, review M4 and r6). It cannot run to completion until sym 0.14.0 is on
// npm, because a packed package cannot depend on a path on the publisher's disk — which is exactly what
// its first check refuses. That refusal is run here; the rest is checked in its source, since the gate's
// own job is to run against the published SDK.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanEnv } = require('./_clean-env.js');

const root = path.join(__dirname, '..');
const gate = path.join(root, 'scripts', 'verify-packed-artifact.mjs');
const src = fs.readFileSync(gate, 'utf8');

test('the gate refuses a file: dependency before it packs anything', { skip: !/^file:/.test(require('../package.json').dependencies['@sym-bot/sym']) && 'the dependency is from npm' }, () => {
  const r = spawnSync(process.execPath, [gate], { cwd: root, env: cleanEnv({ HOME: process.env.HOME }), encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /package\.json depends on a local path: @sym-bot\/sym@file:/);
  assert.match(r.stderr, /"@sym-bot\/sym": "\^0\.14\.0"/);
  assert.ok(!/PASS  packed /.test(r.stdout), 'nothing was packed');
});

test('r6: the gate seeds its outbox from a child process with the sandbox environment, never in its own process', () => {
  assert.match(src, /execFileSync\(process\.execPath, \['-e', seed\], \{ cwd: installedDir, env: sandboxEnv/);
  assert.ok(!/req\('\.\/outbox\.js'\)/.test(src) && !/createRequire\(installed\)/.test(src), 'no in-process write through sym, whose state root is this process\'s');
  assert.match(src, /const sandboxEnv = \{ HOME: sandbox, USERPROFILE: sandbox, SYM_STATE_DIR:/, 'built from scratch, not from process.env');
});

test('the gate checks the real ~/.sym afterwards', () => {
  assert.match(src, /os\.userInfo\(\)\.homedir/);
  assert.match(src, /the real ~\/\.sym is untouched by the gate/);
});
