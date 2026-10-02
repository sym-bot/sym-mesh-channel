#!/usr/bin/env node
'use strict';

// Runs every *.test.js under test/, one process each, and fails if any file fails or if fewer files
// are found than the gate was set to.
//
// The gate used to be a hand-written list in package.json. It had fallen to 7 of the 13 files in
// this directory: six test files, the unread-inbox advisory's among them, sat in the repo and never
// ran in `npm test` or in the release. A file added here is now in the gate by being here. The floor
// catches the other way out: a file renamed out of the *.test.js pattern, or moved somewhere this
// runner does not look, would otherwise leave the gate green with one test fewer.

const { readdirSync, mkdtempSync, mkdirSync, rmSync, realpathSync } = require('fs');
const { join, relative } = require('path');
const { tmpdir } = require('os');
const { spawnSync } = require('child_process');

// The test files here when this floor was last set. Raise it with a new file; lower it only in the
// commit that removes one, so the removal is on the record. 0.11.0: 27 (removed channel-reliability,
// restart-survival and receive-withheld-surface, whose cases moved to node-host, core-secure-e2e and
// withheld-surface; review round 2 removed delivery-facts with its module and added provenance,
// key-display, tool-queue, sandbox, release-gate and zz-real-home-untouched).
const MIN_FILES = 27;

// EVERY FILE RUNS SANDBOXED. HOME, USERPROFILE and SYM_STATE_DIR point into a temp dir made for that
// file, so no test can write an identity, a key or a store into the real ~/.sym, or read the real
// ~/.claude.json. test/_harness.js refuses to run outside one as well.
// Each file's environment is built from an allowlist (test/_clean-env.js), never the developer's, and the
// suite refuses to start where an XMesh mind's or a pinned agent's variables are set (review M5).
const { cleanEnv, refuseDangerous } = require('./_clean-env.js');
refuseDangerous(process.env, 'test/run.js');
const STARTED_AT = String(Date.now());
function sandboxEnv() {
  const box = mkdtempSync(join(realpathSync(tmpdir()), 'mesh-channel-run-'));
  mkdirSync(join(box, '.sym'), { recursive: true });
  return { box, env: cleanEnv({ HOME: box, USERPROFILE: box, SYM_STATE_DIR: join(box, '.sym'), MESH_CHANNEL_RUN_STARTED_AT: STARTED_AT }) };
}

function find(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...find(p));
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = find(__dirname).sort();
if (files.length < MIN_FILES) {
  console.error(`found ${files.length} test file(s) under test/, fewer than the ${MIN_FILES} this gate is set to: ` +
    'a file was renamed out of the *.test.js pattern, moved, or removed without lowering MIN_FILES in test/run.js');
  process.exit(1);
}

const failed = [];
for (const f of files) {
  const name = relative(__dirname, f);
  console.log(`\n── ${name}`);
  const { box, env } = sandboxEnv();
  const r = spawnSync(process.execPath, [f], { stdio: 'inherit', env });
  try { rmSync(box, { recursive: true, force: true }); } catch { /* the OS reaps temp dirs */ }
  if (r.status !== 0) failed.push(`${name} (${r.signal || `exit ${r.status}`})`);
}

console.log(`\n${files.length - failed.length} of ${files.length} test files passed.`);
if (failed.length) {
  console.error(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
