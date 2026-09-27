#!/usr/bin/env node
'use strict';

// Runs every test/*.test.js, one process each, and fails if any file fails or if none ran.
//
// The gate used to be a hand-written list in package.json. It had fallen to 7 of the 13 files in
// this directory: six test files, the unread-inbox advisory's among them, sat in the repo and never
// ran in `npm test` or in the release. A file added here is now in the gate by being here.

const { readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const files = readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
if (!files.length) {
  console.error('no test files found in test/: nothing ran, so nothing passed');
  process.exit(1);
}

const failed = [];
for (const f of files) {
  console.log(`\n── ${f}`);
  const r = spawnSync(process.execPath, [join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(`${f} (${r.signal || `exit ${r.status}`})`);
}

console.log(`\n${files.length - failed.length} of ${files.length} test files passed.`);
if (failed.length) {
  console.error(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
