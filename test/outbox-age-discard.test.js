'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * outbox-age-discard.test.js — a held CMB must know how old it is, and there must be a way out.
 *
 * dev-team-4, 2026-09-14: sym_peers reported one CMB held for "mission-28c163-doer-1-mind", a doer
 * that died on 4 September, advising that it would "flush when the peer appears". The peer was ten
 * days gone and the project shelved. Two defects underneath: `heldAt` was in the item shape from
 * the start and never populated, so nothing could tell waiting from abandoned; and the queue
 * refuses new mail at MAX_ITEMS rather than evicting, so mail for the dead eventually blocks mail
 * for the living, with no command to clear it.
 */

// SYM_HOME must be set before the module loads, or the store is the operator's real ~/.sym.
process.env.SYM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-outbox-age-'));
const outbox = require('../outbox.js');

const NODE = 'test-node';

test('a held item is stamped with the time it was held', () => {
  const before = Date.now();
  const r = outbox.hold(NODE, 'ghost-peer', { focus: 'mail for a peer that never returns' }, {});
  assert.ok(r.held, 'the hold must succeed');
  const [item] = outbox.pendingFor(NODE, 'ghost-peer');
  assert.equal(typeof item.heldAt, 'number', 'heldAt must be populated, not null');
  assert.ok(item.heldAt >= before, 'and must be the moment it was held');
});

test('age is reported, and an item stamped before this fix reads as unknown rather than zero', () => {
  const now = Date.now();
  assert.equal(outbox.ageDays({ heldAt: now - 10 * 86400000 }, now), 10);
  assert.equal(outbox.ageDays({ heldAt: null }, now), null, 'an unstamped legacy item must not claim to be new');
  const s = outbox.summary(NODE, now);
  assert.ok('oldestDays' in s, 'the summary must carry the oldest age');
});

test('discarding a peer\'s mail removes exactly that peer\'s items', () => {
  outbox.hold(NODE, 'live-peer', { focus: 'mail for someone still here' }, {});
  const ghost = outbox.pendingFor(NODE, 'ghost-peer');
  assert.equal(ghost.length, 1);
  const left = outbox.drop(NODE, ghost.map((i) => i.seq));
  assert.equal(outbox.pendingFor(NODE, 'ghost-peer').length, 0, 'the dead peer\'s mail is gone');
  assert.equal(outbox.pendingFor(NODE, 'live-peer').length, 1, 'the live peer\'s mail is untouched');
  assert.equal(left, 1);
});
