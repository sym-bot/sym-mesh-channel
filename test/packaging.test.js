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
    if (r === 'package.json') continue;   // npm always ships package.json
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
  const queue = localRequiresOf('server.js').filter((r) => r !== 'package.json').map(r => (r.endsWith('.js') ? r : `${r}.js`));
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !fs.existsSync(path.join(root, f))) continue;
    seen.add(f);
    const covered = pkg.files.some(w => w === f || (w.endsWith('/') && f.startsWith(w)));
    assert.ok(covered, `${f} is reachable from server.js but is not in package.json "files"`);
    for (const r of localRequiresOf(f)) queue.push(r.endsWith('.js') ? r : `${r}.js`);
  }
});

// R4-14: what ships is what a user needs, and every link in a shipped document opens. 0.11.0 shipped the
// release script and the packed-artifact gate (scripts/), and its README pointed at docs/ images and pages
// that are not in the tarball, so on npm they were broken.
const shipped = (f) => pkg.files.some((w) => w === f || (w.endsWith('/') && f.startsWith(w))) || ['package.json', 'README.md', 'LICENSE'].includes(f);

test('R4-14: no development script ships: the release script and the packed-artifact gate stay in the repository', () => {
  for (const f of ['scripts/release.mjs', 'scripts/verify-packed-artifact.mjs', 'test/run.js', 'docs/DESIGN-0.11.0.md']) {
    assert.ok(!shipped(f), `${f} is in package.json "files"`);
  }
});

test('R4-14: every relative link and image in a shipped document resolves to a file that ships', () => {
  const docs = pkg.files.filter((f) => f.endsWith('.md'));
  assert.ok(docs.includes('README.md') && docs.includes('SECURITY.md'), `shipped documents: ${docs.join(', ')}`);
  let links = 0;
  for (const doc of docs) {
    const text = fs.readFileSync(path.join(root, doc), 'utf8');
    for (const m of text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(?:img|a)\s[^>]*(?:src|href)="([^"]+)"/g)) {
      const target = m[1] || m[2];
      if (/^(https?:|mailto:|#)/i.test(target)) continue;
      links++;
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(doc), target.split('#')[0]));
      assert.ok(fs.existsSync(path.join(root, file)), `${doc} links to ${target}, which does not exist`);
      assert.ok(shipped(file), `${doc} links to ${target}, which is not in the published package (package.json "files"): make it an absolute GitHub URL or ship it`);
    }
  }
  assert.ok(links > 0, 'the check saw the relative links that do ship (LICENSE, SECURITY.md)');
});

// 0.11.1 review S10: the check above reads server.js only. bin/install.js (the `start` command) required ../claude-bin.js,
// and nothing in the suite would have noticed that file missing from the tarball. Walk EVERY shipped JavaScript file.
function shippedFiles() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).isDirectory()) { for (const e of fs.readdirSync(abs)) walk(path.posix.join(rel, e)); } else out.push(rel);
  };
  for (const f of pkg.files) { if (fs.existsSync(path.join(root, f))) walk(f.replace(/\/$/, '')); }
  return out;
}

test('every relative require in every shipped JavaScript file resolves to a file that ships (0.11.1 review S10)', () => {
  const shipped = new Set([...shippedFiles(), 'package.json']);
  const js = [...shipped].filter((f) => /\.(js|mjs|cjs)$/.test(f));
  assert.ok(js.includes('bin/install.js') && js.includes('server.js'), 'the walk found the entry points');
  const problems = [];
  for (const file of js) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of code.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
      const found = [target, `${target}.js`, `${target}.json`, `${target}/index.js`].find((c) => shipped.has(c));
      if (!found) problems.push(`${file} requires '${m[2]}' (${target}), which the tarball does not ship`);
    }
  }
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});
