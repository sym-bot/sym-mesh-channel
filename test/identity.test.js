#!/usr/bin/env node
'use strict';

// identity.js — the folder's agent identity (design D10). The name is an index; a nodeId pins the
// agent and loads it without minting. Never -2, never -3: sym 0.14 has no suffixing at all, and this
// layer inspects no lock and no pid. Lines print the LAST 8 of a nodeId: the first 8 of a UUID v7
// are its timestamp, shared by nodes minted within about a minute of each other.

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveIdentity, nodeNameProblem, isNodeId, shortId } = require('../identity.js');

const ID = '01a0fd15-52ca-726c-9ce1-5767a1379249';

test('a pinned name is used verbatim and trimmed; an unpinned session takes the default', () => {
  assert.deepStrictEqual(resolveIdentity({ pinnedName: '  cto  ', defaultName: 'claude-x' }), { name: 'cto', nodeId: null, pinned: true });
  assert.deepStrictEqual(resolveIdentity({ pinnedName: '   ', defaultName: 'claude-x' }), { name: 'claude-x', nodeId: null, pinned: false });
  assert.deepStrictEqual(resolveIdentity({ defaultName: 'claude-x' }), { name: 'claude-x', nodeId: null, pinned: false });
});

test('a nodeId pins the agent; anything that is not a nodeId pins nothing', () => {
  assert.strictEqual(resolveIdentity({ pinnedNodeId: ID.toUpperCase(), defaultName: 'x' }).nodeId, ID);
  assert.strictEqual(resolveIdentity({ pinnedNodeId: 'alice', defaultName: 'x' }).nodeId, null);
  assert.strictEqual(resolveIdentity({ pinnedNodeId: `${ID}x`, defaultName: 'x' }).nodeId, null);
});

test('no input shape produces a suffixed or second identity', () => {
  for (const pinnedName of [undefined, null, '', 'a', 'a-2']) {
    const r = resolveIdentity({ pinnedName, defaultName: 'base' });
    assert.ok(!('autoSuffix' in r), 'there is no suffix setting to turn on');
    assert.ok(r.name === (pinnedName && pinnedName.trim() ? pinnedName.trim() : 'base'));
  }
});

test('isNodeId and shortId: the tail is printed, because the head is a timestamp', () => {
  assert.ok(isNodeId(ID));
  assert.ok(!isNodeId('claude-agent-a'));
  assert.strictEqual(shortId(ID), 'a1379249');
  const sameMinute = '01a0fd15-52ca-77cd-bc1c-8eef67a748e6';
  assert.strictEqual(ID.slice(0, 8), sameMinute.slice(0, 8), 'two nodes minted within a minute share their first 8');
  assert.notStrictEqual(shortId(ID), shortId(sameMinute));
});

test('nodeNameProblem: the §3.1.2 bounds plus file-name safety, shared by installer and server', () => {
  assert.strictEqual(nodeNameProblem('claude-agent-a'), null);
  assert.match(nodeNameProblem(''), /1–64 bytes/);
  assert.match(nodeNameProblem('x'.repeat(65)), /1–64 bytes/);
  assert.match(nodeNameProblem(' a'), /whitespace/);
  assert.match(nodeNameProblem('a\u200bb'), /zero-width/);
  assert.match(nodeNameProblem('../x'), /path separators/);
  assert.match(nodeNameProblem('a:b'), /not valid in a file name/);
  assert.match(nodeNameProblem('CON'), /Windows reserves/);
  assert.match(nodeNameProblem('a.'), /end with a dot/);
});
