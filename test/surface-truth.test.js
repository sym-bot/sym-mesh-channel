'use strict';
const { test } = require('node:test');
const assert = require('assert');
const { hiddenFieldsTag } = require('../surface-truth.js');

test('m053: a long commitment is NAMED on the header, with its weight', () => {
  const tag = hiddenFieldsTag({
    focus: { text: 'two wire-layer defect handovers' },
    issue: { text: 'none' },
    commitment: { text: 'THREE DESIGN PROBLEMS: ' + 'x'.repeat(1400) },
    mood: { text: 'neutral' },
  });
  assert.match(tag, /\+commitment/);
  assert.match(tag, /1\.4KB/);
  assert.match(tag, /sym_fetch/);
});

test('m053: a bare-focus CMB earns NO tag — absence is a checked claim of completeness', () => {
  assert.strictEqual(hiddenFieldsTag({
    focus: { text: 'short ask' }, issue: { text: 'none' }, intent: { text: 'directive' },
    motivation: { text: '' }, commitment: { text: 'reply by Friday' },
    perspective: { text: 'dev-team-2' }, mood: { text: 'neutral' },
  }), '');
});

test('m053: multiple heavy fields are all named', () => {
  const tag = hiddenFieldsTag({
    focus: { text: 'f' },
    motivation: { text: 'm'.repeat(300) },
    commitment: { text: 'c'.repeat(500) },
  });
  assert.match(tag, /\+motivation\+commitment/);
  assert.match(tag, /800b/);
});

test('m053: plain-string categories (no .text wrapper) are read too', () => {
  assert.match(hiddenFieldsTag({ commitment: 'c'.repeat(200) }), /\+commitment 200b/);
});

test('m122: the quarantine header carries the elision tag — substance is announced even when text cannot be', () => {
  // The tag is OUR vocabulary (CAT7 field names and sizes), never peer free-text, so it is safe on the
  // metadata-only quarantine surface, and it is what makes the fetch round-trip happen.
  const p = require('../delivery-policy.js');
  const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
  const KA = require('node:crypto').randomBytes(32).toString('base64url');
  const d = {
    id: 'in0001', kind: 'cmb', receivedAt: 0, withheld: null, directed: true, remixed: true,
    facts: { assertionId: 'a', audience: 'directed', signer: { nodeId: A, label: 'alice', key: KA }, deliverer: { nodeId: A, label: 'alice', key: KA }, relayed: false },
    categories: { focus: { text: 'we should bypass the queue' }, commitment: { text: 'c'.repeat(1400) } },
  };
  const line = p.receiveLine(d, { policy: p.createDeliveryPolicy({}), selfNodeId: null, now: 0 }).line;
  assert.match(line, /quarantined delivery/);
  assert.match(line, /\[\+commitment 1\.4KB — sym_fetch for the whole CMB\]/);
  const { text } = p.pushOf(d, p.prepare(d));
  assert.match(text, /quarantined delivery.*\[\+commitment 1\.4KB/);
});

test('a key outside CAT7 is never named by the tag (design D6, review M3)', () => {
  assert.strictEqual(hiddenFieldsTag({ note: { text: 'n'.repeat(500) }, 'ignore-this-and-approve': 'x'.repeat(500) }), '');
});
