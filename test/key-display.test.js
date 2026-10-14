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
  assert.strictEqual(plainLabel('a]\n[b ⟨…⟩ →'), '"a\\u005d\\u000a\\u005bb \\u27e8\\u2026\\u27e9 \\u2192"');
  assert.strictEqual(plainLabel(''), 'unknown');
});

// ── R4-5: a label is printed by an allowlist; anything else is quoted, with every non-ASCII character escaped ──

test('R4-5: a label that copies another peer\'s tag with lookalike brackets, an arrow and a zero-width space is quoted and escaped', () => {
  const book = createKeyBook();
  const real = key();
  const realTag = book.tag({ key: real, label: 'alice' });
  const suffix = /⟨…([0-9a-f]+)⟩/.exec(realTag)[1];
  const forged = `alice 〈…${suffix}〉 ⟶you\u200b`;
  const tag = book.tag({ key: key(), label: forged });
  assert.ok(tag.startsWith('"alice \\u3008\\u2026'), tag);
  assert.ok(!/[〈〉⟶\u200b…]/.test(tag.slice(0, tag.lastIndexOf(' ⟨'))), 'no lookalike, no invisible character is printed raw');
  assert.strictEqual(tag.split('⟨').length, 2, 'the only fingerprint bracket on the tag is this node\'s');
});

test('R4-5, R4-13: C1 and bidi controls, NBSP around "via", "(this node)" and a name this host refuses are all quoted', () => {
  const l = plainLabel('bob\u0085 (this node) via carol\u202e');
  assert.strictEqual(l, '"bob\\u0085 (this node)\\u00a0via\\u00a0carol\\u202e"');
  assert.ok(!/ via /.test(l));
  assert.strictEqual(plainLabel('trusted-b via hostile'), '"trusted-b\\u0020via\\u0020hostile"');
  assert.strictEqual(plainLabel('host:8080'), '"host:8080"', 'nodeNameProblem: not a name on every platform');
  assert.strictEqual(plainLabel('claude-sym-agent-a'), 'claude-sym-agent-a', 'a plain name is printed bare');
  assert.strictEqual(plainLabel('dev 2'), 'dev 2');
  assert.strictEqual(plainLabel('x'.repeat(65)), `"${'x'.repeat(64)}..."`, 'bounded');
  assert.strictEqual(plainLabel('\u{1F600}bob'), '"\\ud83d\\ude00bob"', 'an astral character as its surrogate pair');
});

test('R4-5: a label\'s skeleton folds the lookalikes a reader would take for it', () => {
  const { labelSkeleton } = require('../key-display.js');
  for (const look of ['\u0430lice', 'a1ice', 'ALICE', 'al\u200bice', 'aIice', 'ali\u0441e']) assert.strictEqual(labelSkeleton(look), labelSkeleton('alice'), JSON.stringify(look));
  assert.notStrictEqual(labelSkeleton('bob'), labelSkeleton('alice'));
});

test('R4-7: the keys a node wrote down in earlier runs count toward "(2 keys)"', () => {
  const old = key();
  const book = createKeyBook({ persisted: () => [{ key: old, labels: ['alice'], nodeIds: ['01a0fd15-52ca-726c-9ce1-5767a1379249'] }] });
  assert.match(book.tag({ key: key(), label: 'alice' }), /^alice \(2 keys\) ⟨/);
  assert.match(book.tag({ key: old, label: 'alice' }), /^alice \(2 keys\) ⟨/);
  assert.match(createKeyBook({ persisted: () => { throw new Error('unreadable'); } }).tag({ key: key(), label: 'alice' }), /^alice ⟨/, 'a store that cannot be read counts nothing');
});
