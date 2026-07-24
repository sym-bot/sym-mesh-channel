#!/usr/bin/env node
'use strict';

// Regression tests for node-identity resolution (identity.js). The bug: the plugin's old
// resolveNodeName used a bare process.kill(pid,0) liveness check that misread a recycled PID as a
// live holder, so a dead session's stale lock triggered a -2/-3 suffix — forking a fresh identity
// and store off a still-valid node. The fix removes all plugin-side pid/lock inspection and
// delegates collision handling to the engine. These tests pin that: a pinned name is used verbatim
// (never suffixed, regardless of any lockfile), and the pid check is gone from this layer.

const assert = require('assert');
const { resolveIdentity } = require('../identity.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

test('a pinned name (SYM_NODE_NAME / .sym/node.json) is used verbatim — never suffixed', () => {
  const r = resolveIdentity({ pinnedName: 'claude-sym-research@hongwei-mac', defaultName: 'x' });
  assert.equal(r.name, 'claude-sym-research@hongwei-mac');
  assert.equal(r.pinned, true);
  assert.equal(r.autoSuffix, false, 'pinned identity must not auto-suffix — engine hard-fails on a real live collision');
  assert.ok(!/-\d+$/.test(r.name), 'no -N session suffix');
});

test('pinned resolution does not depend on any lockfile / pid state', () => {
  // The whole class of bug was a stale-but-reused PID lock forcing a suffix. This layer performs no
  // fs/pid inspection at all, so the returned name is byte-identical to the input no matter what
  // locks exist on disk — that is the regression guarantee.
  const name = 'claude-sym-cto@hongwei-mac';
  for (let i = 0; i < 5; i++) {
    assert.equal(resolveIdentity({ pinnedName: name, defaultName: 'd' }).name, name);
  }
  assert.equal(resolveIdentity.length <= 1, true, 'pure single-arg resolver — no pid/lock parameters');
});

test('an unpinned session falls back to the default name with engine auto-suffix ON', () => {
  const r = resolveIdentity({ pinnedName: undefined, defaultName: 'claude-xmesh-a1b2c3' });
  assert.equal(r.name, 'claude-xmesh-a1b2c3');
  assert.equal(r.pinned, false);
  assert.equal(r.autoSuffix, true, 'unpinned default delegates collision to the engine (start-time-verified)');
});

test('blank / whitespace pinned names are treated as unpinned', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const r = resolveIdentity({ pinnedName: blank, defaultName: 'def' });
    assert.equal(r.name, 'def', `blank ${JSON.stringify(blank)} should fall through to default`);
    assert.equal(r.pinned, false);
    assert.equal(r.autoSuffix, true);
  }
});

test('pinned names are trimmed but otherwise untouched', () => {
  const r = resolveIdentity({ pinnedName: '  melotune-dev  ', defaultName: 'd' });
  assert.equal(r.name, 'melotune-dev');
});

console.log(`\nidentity: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
