'use strict';

// The release gate (design D12, review M4 and r6) and what it guards: a published package cannot depend on a
// path on the publisher's disk. 0.11.0 was developed against a tarball of the unpublished sym 0.14 worktree;
// it depends on @sym-bot/sym ^0.14.0 from npm, and the gate's first check refuses anything else. Both are
// tested here: the refusal itself (run in a temp root whose package.json has a `file:` dependency, so it holds
// whatever this package depends on), and the dependency and lockfile as they are.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanEnv } = require('./_clean-env.js');

const root = path.join(__dirname, '..');
const gate = path.join(root, 'scripts', 'verify-packed-artifact.mjs');
const src = fs.readFileSync(gate, 'utf8');
const pkg = require('../package.json');

test('the gate refuses a file: dependency before it packs anything', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mesh-channel-gate-refusal-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.copyFileSync(gate, path.join(tmp, 'scripts', 'verify-packed-artifact.mjs'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { '@sym-bot/sym': 'file:.sdk/sym-bot-sym-0.14.0-dev.0000000.tgz' } }));
    const r = spawnSync(process.execPath, [path.join(tmp, 'scripts', 'verify-packed-artifact.mjs')], { cwd: tmp, env: cleanEnv({ HOME: process.env.HOME }), encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /package\.json depends on a local path: @sym-bot\/sym@file:/);
    assert.match(r.stderr, /"@sym-bot\/sym": "\^0\.14\.0"/);
    assert.ok(!/PASS  packed /.test(r.stdout), 'nothing was packed');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('this package depends on the published @sym-bot/sym ^0.14.0, and the lockfile resolves it from the registry', () => {
  assert.strictEqual(pkg.dependencies['@sym-bot/sym'], '^0.14.0');
  for (const [name, range] of Object.entries(pkg.dependencies)) assert.ok(!/^(file|link|git|github):/.test(range) && !range.includes('.sdk'), `${name}@${range} is a registry range`);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.packages[''].dependencies['@sym-bot/sym'], '^0.14.0');
  const entry = lock.packages['node_modules/@sym-bot/sym'];
  assert.match(entry.version, /^0\.14\.\d+$/, 'a release, never a development snapshot');
  assert.strictEqual(entry.resolved, `https://registry.npmjs.org/@sym-bot/sym/-/sym-${entry.version}.tgz`);
  assert.match(entry.integrity, /^sha512-/);
  assert.ok(!JSON.stringify(lock).includes('.sdk/'), 'no lockfile entry points at the vendored snapshot directory');
  assert.ok(!fs.existsSync(path.join(root, '.sdk')), 'the vendored snapshot is gone');
  assert.ok(!/\.sdk/.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')), 'and so is the ignore line that hid it');
  assert.ok(!pkg.files.some((f) => f.includes('.sdk')), 'and nothing ships it');
  assert.strictEqual(require('@sym-bot/sym/package.json').version, entry.version, 'the installed copy is the locked one');
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

test('the gate resolves a require by the file it names: server.js requires ./package.json, which is not ./package.json.js', () => {
  // The gate could not run to completion while the dependency was a file: path, so this was never seen: it
  // looked for `package.json.js` in the installed package and failed a correct tarball.
  assert.match(src, /\/\\\.\(js\|json\|mjs\|cjs\)\$\/\.test\(m\[1\]\)/);
  assert.ok(/require\(\s*'\.\/package\.json'\s*\)/.test(fs.readFileSync(path.join(root, 'server.js'), 'utf8')), 'server.js does require ./package.json');
});
