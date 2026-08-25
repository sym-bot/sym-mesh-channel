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
