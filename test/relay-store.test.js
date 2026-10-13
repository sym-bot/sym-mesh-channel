'use strict';

// relay-store.js — a relay credential is remembered per ROOM, under the state root, mode 0600. The room is
// a path segment, so the store must not trust its callers; and it must not refuse a room a node may be in:
// a room is an MMP §5.8 identifier ([a-z0-9._-], 1 to 64 characters), and the store once kept a kebab-case
// pattern of its own, so a dotted room's credential was "not writable" and never remembered.

require('./_harness.js'); // sandbox first: the store writes under SYM_STATE_DIR
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRelay, saveRelay, forgetRelay, relaysDir } = require('../relay-store.js');

const CRED = { relay_url: 'wss://relay.example', relay_token: 'a-token-of-some-length' };

test('a credential is remembered, read back and forgotten for every kind of room §5.8 admits', () => {
  for (const room of ['backend-team', 'acme.prod', 'team_x', 'x-review--team-02779b950c3d8d7378fd11d6', 'default', '.', 'a'.repeat(64)]) {
    const file = saveRelay(room, CRED);
    assert.ok(file, `${room}: a credential for a room is saved`);
    assert.strictEqual(path.dirname(file), relaysDir(), 'inside the relays directory');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'private to this user');
    const back = loadRelay(room);
    assert.strictEqual(back.relay_url, CRED.relay_url);
    assert.strictEqual(back.relay_token, CRED.relay_token);
    assert.strictEqual(forgetRelay(room), true);
    assert.strictEqual(loadRelay(room), null);
  }
});

test('a name that is not a room is neither read nor written, and none can leave the directory', () => {
  const before = fs.existsSync(relaysDir()) ? fs.readdirSync(relaysDir()).sort() : [];
  for (const bad of ['', ' ', 'Backend', 'a b', 'a/b', '../escape', '..\\escape', 'sym', 'a'.repeat(65), null, undefined, 42, {}, 'café']) {
    assert.strictEqual(saveRelay(bad, CRED), null, `${JSON.stringify(bad)}: not saved`);
    assert.strictEqual(loadRelay(bad), null);
    assert.strictEqual(forgetRelay(bad), false);
  }
  const after = fs.existsSync(relaysDir()) ? fs.readdirSync(relaysDir()).sort() : [];
  assert.deepStrictEqual(after, before, 'nothing was written');
  assert.ok(!fs.existsSync(path.join(relaysDir(), '..', 'escape.json')) && !fs.existsSync(path.join(relaysDir(), 'escape.json')));
});
