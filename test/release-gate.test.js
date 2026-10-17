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

// ── RELEASE: the @sym-bot/sym this release is built and tested on ──────────────────────────────────────
// Set it here AND in package.json "dependencies", then relock (npm install) so package-lock.json resolves
// it from the registry. The tests below hold the three together, and test the sym that is actually
// installed against it (review R4-12: they used to demand the lockfile's exact version of whatever was
// installed, so a newer sym in node_modules failed the gate while every other test ran on it).
const SYM_RANGE = '^0.14.2';

/** Whether `version` satisfies a caret range `^M.m.p` (npm's caret: below 1.0 the minor is fixed). */
function satisfiesCaret(version, range) {
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range || '');
  if (!v || !r) return false;
  const [vm, vn, vp] = v.slice(1).map(Number);
  const [rm, rn, rp] = r.slice(1).map(Number);
  if (rm > 0) return vm === rm && (vn > rn || (vn === rn && vp >= rp));
  if (rn > 0) return vm === 0 && vn === rn && vp >= rp;
  return vm === 0 && vn === 0 && vp === rp;
}

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

test('this package depends on the published @sym-bot/sym it names, the lockfile resolves it from the registry, and the installed one satisfies it', () => {
  assert.strictEqual(pkg.dependencies['@sym-bot/sym'], SYM_RANGE, `package.json depends on @sym-bot/sym ${SYM_RANGE} (set at release, with SYM_RANGE above)`);
  for (const [name, range] of Object.entries(pkg.dependencies)) assert.ok(!/^(file|link|git|github):/.test(range) && !range.includes('.sdk'), `${name}@${range} is a registry range`);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.packages[''].dependencies['@sym-bot/sym'], SYM_RANGE, 'the lockfile was regenerated for this range (npm install)');
  const entry = lock.packages['node_modules/@sym-bot/sym'];
  assert.match(entry.version, /^0\.14\.\d+$/, 'a release, never a development snapshot');
  assert.ok(satisfiesCaret(entry.version, SYM_RANGE), `the locked sym ${entry.version} satisfies ${SYM_RANGE}`);
  assert.strictEqual(entry.resolved, `https://registry.npmjs.org/@sym-bot/sym/-/sym-${entry.version}.tgz`);
  assert.match(entry.integrity, /^sha512-/);
  assert.ok(!JSON.stringify(lock).includes('.sdk/'), 'no lockfile entry points at the vendored snapshot directory');
  assert.ok(!fs.existsSync(path.join(root, '.sdk')), 'the vendored snapshot is gone');
  assert.ok(!/\.sdk/.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')), 'and so is the ignore line that hid it');
  assert.ok(!pkg.files.some((f) => f.includes('.sdk')), 'and nothing ships it');
  // What every other test ran on: the installed copy, which npm ci makes the locked one and a consumer's
  // install makes the newest in range. It must satisfy the range; it is named, so a run says what it tested.
  const installed = require('@sym-bot/sym/package.json').version;
  assert.ok(satisfiesCaret(installed, SYM_RANGE), `the installed sym ${installed} satisfies ${SYM_RANGE}`);
  console.log(`  (tested on the installed @sym-bot/sym ${installed}; the lockfile pins ${entry.version})`);
});

test('the caret check is npm\'s', () => {
  assert.ok(satisfiesCaret('0.14.3', '^0.14.3') && satisfiesCaret('0.14.9', '^0.14.3'));
  assert.ok(!satisfiesCaret('0.14.2', '^0.14.3') && !satisfiesCaret('0.15.0', '^0.14.3') && !satisfiesCaret('1.0.0', '^0.14.0'));
  assert.ok(satisfiesCaret('1.2.0', '^1.1.9') && !satisfiesCaret('2.0.0', '^1.1.9'));
  assert.ok(!satisfiesCaret('0.14.0-dev.1', '^0.14.0'), 'a prerelease is not a release');
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
