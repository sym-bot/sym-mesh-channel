'use strict';

// key-display.js — a signer is named by its label and the shortest suffix of its key fingerprint that is
// unique among the keys this node knows, at least 8 hex (design D3, review H2 and r1).

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createKeyBook, fingerprint, plainLabel, MIN_SUFFIX } = require('../key-display.js');

const key = () => crypto.randomBytes(32).toString('base64url');

test('the fingerprint is SHA-256 of the raw key', () => {
  const k = key();
  assert.strictEqual(fingerprint(k), crypto.createHash('sha256').update(Buffer.from(k, 'base64url')).digest('hex'));
  assert.strictEqual(fingerprint(''), null);
});

test('a tag is the label and at least 8 hex of the fingerprint; unknown keys say so', () => {
  const book = createKeyBook();
  const k = key();
  assert.match(book.tag({ key: k, label: 'alice', nodeId: '01a0fd15-52ca-726c-9ce1-5767a1379249' }), new RegExp(`^alice ⟨…${fingerprint(k).slice(-MIN_SUFFIX)}⟩$`));
  assert.strictEqual(book.tag({ key: null, label: 'x' }), 'x ⟨key unknown⟩');
});

test('a label shared by two known keys is said, and each key keeps its own suffix', () => {
  const book = createKeyBook();
  const k1 = key(), k2 = key();
  book.learn({ key: k1, label: 'alice' });
  const t2 = book.tag({ key: k2, label: 'alice' });
  const t1 = book.tag({ key: k1, label: 'alice' });
  assert.match(t1, /^alice \(2 keys\) ⟨…[0-9a-f]{8,}⟩$/);
  assert.match(t2, /^alice \(2 keys\) ⟨…[0-9a-f]{8,}⟩$/);
  assert.notStrictEqual(t1, t2);
});

test('the suffix is unique among the SDK\'s bindings too, and grows to tell two near-identical fingerprints apart', () => {
  const k = key();
  const fp = fingerprint(k);
  // A binding the SDK knows whose fingerprint shares alice's last 11 hex.
  const filler = fp.slice(-12, -11) === '0' ? '1' : '0';
  const near = `${filler.repeat(53)}${fp.slice(-11)}`;
  const book = createKeyBook({ bindings: () => [] });
  const n = book.suffixOf(fp, new Set([fp, near]));
  assert.strictEqual(n.length, 12);
  const withBindings = createKeyBook({ bindings: () => [{ nodeId: 'x', key: 'binding-key' }] });
  assert.ok(withBindings.allFingerprints().has(fingerprint('binding-key')));
});

test('one key seen under two nodeIds is said on the tag (review r1\'s same-key case)', () => {
  const book = createKeyBook();
  const k = key();
  book.learn({ key: k, nodeId: '01a0fd15-52ca-726c-9ce1-5767a1379249', label: 'alice' });
  assert.match(book.tag({ key: k, label: 'alice', nodeId: '01a0fe99-0000-7000-8000-5767a1379249' }), /^alice \(one key, 2 nodeIds\) ⟨…[0-9a-f]{8}⟩$/);
});

test('a label cannot carry markup into a tag', () => {
  assert.strictEqual(plainLabel('a]\n[b ⟨…⟩ →'), 'a___b _…_ _');
  assert.strictEqual(plainLabel(''), 'unknown');
});
