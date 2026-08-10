'use strict';

// PACKAGING — every local module server.js requires must actually ship.
//
// 0.7.0 shipped a server.js that required ./outbox.js while package.json's
// `files` whitelist omitted it. The repo was green, the tests passed, the plugin
// install worked (it installs from git), and the npm tarball was broken: anyone
// running `npm i -g @sym-bot/mesh-channel` got MODULE_NOT_FOUND at startup.
//
// Nothing in the suite could see it, because every test runs against the WORKING
// TREE, where the file is obviously present. The artifact users receive is a
// different artifact from the one we test. This test reads the whitelist as data
// and compares it against what the code actually requires.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function localRequiresOf(file) {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  const out = new Set();
  for (const m of code.matchAll(/require\(\s*'(\.\/[^']+)'\s*\)/g)) out.add(m[1].replace(/^\.\//, ''));
  return [...out];
}

test('every local module required by server.js is in the files whitelist', () => {
  const required = localRequiresOf('server.js');
  assert.ok(required.length > 0, 'expected server.js to require at least one local module');
  for (const r of required) {
    const withExt = r.endsWith('.js') ? r : `${r}.js`;
    const covered = pkg.files.some(f => f === withExt || f === r || (f.endsWith('/') && withExt.startsWith(f)));
    assert.ok(
      covered,
      `server.js requires './${r}' but package.json "files" does not ship it — ` +
      `the published tarball would fail with MODULE_NOT_FOUND. Add "${withExt}" to files.`,
    );
  }
});

test('every file in the whitelist actually exists', () => {
  for (const f of pkg.files) {
    const p = path.join(root, f);
    assert.ok(fs.existsSync(p), `package.json "files" lists ${f}, which does not exist`);
  }
});

test('transitively: local modules required BY those modules also ship', () => {
  const seen = new Set(['server.js']);
  const queue = localRequiresOf('server.js').map(r => (r.endsWith('.js') ? r : `${r}.js`));
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !fs.existsSync(path.join(root, f))) continue;
    seen.add(f);
    const covered = pkg.files.some(w => w === f || (w.endsWith('/') && f.startsWith(w)));
    assert.ok(covered, `${f} is reachable from server.js but is not in package.json "files"`);
    for (const r of localRequiresOf(f)) queue.push(r.endsWith('.js') ? r : `${r}.js`);
  }
});
