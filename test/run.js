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

const { readdirSync } = require('fs');
const { join, relative } = require('path');
const { spawnSync } = require('child_process');

// The test files here when this floor was last set. Raise it with a new file; lower it only in the
// commit that removes one, so the removal is on the record.
const MIN_FILES = 16;

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
  const r = spawnSync(process.execPath, [f], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(`${name} (${r.signal || `exit ${r.status}`})`);
}

console.log(`\n${files.length - failed.length} of ${files.length} test files passed.`);
if (failed.length) {
  console.error(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
