'use strict';

// channel-delivery.js — what an emit asks for (categories as given, parents, `to`) and what the node
// says it did (design D3, D4, D6). The salt is gone: content-addressed dedup is an answer, not an error.

const { test } = require('node:test');
const assert = require('node:assert');
const cd = require('../channel-delivery.js');

const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';
const KEY = `cmb-${'e'.repeat(64)}`;

test('only the categories the agent gave are sent: nothing invented, no measured-looking mood zeros', () => {
  assert.deepStrictEqual(cd.givenCategories({ focus: 'only focus' }), { focus: 'only focus' });
  assert.deepStrictEqual(cd.givenCategories({ focus: 'f', issue: '', mood: { text: 'tired' } }), { focus: 'f', mood: { text: 'tired' } });
  assert.deepStrictEqual(cd.givenCategories({ focus: 'f', mood: { text: 'calm', valence: 0.2, arousal: 'x' } }), { focus: 'f', mood: { text: 'calm', valence: 0.2 } });
  assert.deepStrictEqual(cd.givenCategories({ focus: 'f', mood: 'wired' }), { focus: 'f', mood: { text: 'wired' } });
  assert.deepStrictEqual(cd.givenCategories({ focus: 'f', mood: { valence: 1 } }), { focus: 'f' }, 'a mood with no text is no mood');
});

test('parents take CMB keys or delivery ids; an unresolvable one is refused before anything is minted', () => {
  const resolve = (id) => (id === 'in0042' ? KEY : null);
  assert.deepStrictEqual(cd.resolveParents(undefined, resolve), { keys: [] });
  assert.deepStrictEqual(cd.resolveParents(['in0042', KEY], resolve), { keys: [KEY] }, 'the same parent twice is cited once');
  assert.deepStrictEqual(cd.resolveParents('in0042', resolve), { keys: [KEY] });
  assert.match(cd.resolveParents(['in0099'], resolve).error, /in0099 is not a delivery this server can resolve/);
  assert.match(cd.resolveParents(['alice said so'], resolve).error, /neither a CMB key .* nor a delivery id/);
  assert.match(cd.resolveParents({ a: 1 }, resolve).error, /must be a list/);
  assert.match(cd.resolveParents(Array(17).fill(KEY), resolve).error, /at most 16/);
});

test('`to` is a nodeId or a delivery id (its verified signer), never a name', () => {
  assert.deepStrictEqual(cd.resolveTo(A.toUpperCase()), { nodeId: A });
  assert.deepStrictEqual(cd.resolveTo('in0042', { signerOf: (id) => (id === 'in0042' ? A : null) }), { nodeId: A, via: 'in0042' });
  assert.match(cd.resolveTo('in0099', { signerOf: () => null }).error, /names no one to send to/);
  const byName = cd.resolveTo('bob', { peersLabelled: () => [{ nodeId: A }] });
  assert.match(byName.error, /never a name: names are labels, not routes/);
  assert.match(byName.error, new RegExp(`Connected peers that use the label "bob": ${A}`), 'the identities behind the label are offered, not chosen');
  assert.match(cd.resolveTo('bob', { peersLabelled: () => [] }).error, /sym_peers lists/);
  assert.match(cd.resolveTo('  ').error, /empty/);
});

test('the node\'s own account decides the answer (design D4)', () => {
  const entry = (over) => ({ key: KEY, cmb: { metadata: { key: KEY, assertionId: 'asrt-9' } }, ...over });
  const delivery = (d) => Object.defineProperty(entry({}), 'delivery', { value: d, enumerable: false });
  assert.deepStrictEqual(cd.emitOutcome(null, false), { outcome: 'store-failed' }, 'sym 0.14: null is a store that could not write, never "already stored"');
  assert.deepStrictEqual(cd.emitOutcome(entry({ collapsed: true }), false), { outcome: 'already-said', key: KEY });
  assert.deepStrictEqual(cd.emitOutcome(delivery({ dispatched: 2 }), false), { outcome: 'published', key: KEY, assertionId: 'asrt-9', dispatched: 2 });
  assert.deepStrictEqual(cd.emitOutcome(delivery({ dispatched: 0 }), false), { outcome: 'no-peers', key: KEY, assertionId: 'asrt-9' });
  assert.deepStrictEqual(cd.emitOutcome(delivery({ directed: true, undelivered: true, reason: 'not-connected', dispatched: 0 }), true), { outcome: 'undelivered', key: KEY, assertionId: 'asrt-9', reason: 'not-connected' });
  assert.strictEqual(cd.emitOutcome(delivery({ directed: true, dispatched: 1 }), true).outcome, 'sent');
  const dup = Object.defineProperty(entry({ duplicate: true }), 'delivery', { value: { directed: true, dispatched: 1 }, enumerable: false });
  assert.strictEqual(cd.emitOutcome(dup, true).duplicate, true, 'a directed send of stored cognition is a new assertion of it');
});

test('the SDK\'s refusals to build a record are the tool\'s answer; any other error is not', () => {
  const size = Object.assign(new RangeError('a category is over its bound'), { code: 'ECMBSIZE' });
  assert.match(cd.notSentAnswer('sym_send', size).content[0].text, /^Not sent: a category is over its bound\. Nothing left this node\.$/);
  assert.ok(cd.notSentAnswer('sym_publish', Object.assign(new Error('CMB signing failed: x'), { code: 'ESIGN' })));
  assert.ok(cd.notSentAnswer('sym_send', new Error('remember() requires CAT7 categories — the agent LLM extracts categories')));
  assert.strictEqual(cd.notSentAnswer('sym_status', size), null, 'a tool that sends nothing');
  assert.strictEqual(cd.notSentAnswer('sym_send', new RangeError('Invalid string length')), null, 'a V8 error is not a refusal');
  assert.strictEqual(cd.notSentAnswer('sym_send', new Error('socket hang up')), null);
});

test('a directed send to a peer silent for over 30 s says its session may be gone', () => {
  assert.strictEqual(cd.staleNote({ lastSeen: 1000 }, 2000), '');
  assert.match(cd.staleNote({ lastSeen: 1000 }, 61_000), /nothing has arrived from this peer for 60s/);
  assert.strictEqual(cd.staleNote(null), '');
});

test('a broadcast duplicate names its key; a cited reply is never gated, so no outcome is a remix refusal', () => {
  assert.deepStrictEqual(cd.emitOutcome({ key: KEY, duplicate: true }, false), { outcome: 'already-in-memory', key: KEY });
  // sym 0.14.0: only remix() answers `{ refused: 'remix-without-new-domain-data' }`, and this channel never calls it.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'channel-delivery.js'), 'utf8');
  assert.ok(!/remix-refused|remix-rejected/.test(src), 'no pre-0.14 gating outcome is left in the outcome table');
});

test('the salt is gone: identical cognition is answered once, never re-sent with words the agent did not write', () => {
  const EventEmitter = require('node:events');
  const { NodeHost } = require('../node-host.js');
  const calls = [];
  const node = Object.assign(new EventEmitter(), {
    nodeId: '01a0fd15-0000-7000-8000-000000000001', name: 'n', peers: () => [], inboxStatus: () => ({ seq: 0, cursor: 0, undrained: 0 }),
    remember(categories) { calls.push(JSON.parse(JSON.stringify(categories))); return { key: KEY, duplicate: true }; },   // the store already holds it (sym 0.14: a broadcast duplicate names its key)
  });
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const host = new NodeHost({ build: () => node, nodeDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')) });
  host.open({});
  const out = host.emitRecord({ categories: { focus: 'the same words' } });
  assert.strictEqual(out.outcome, 'already-in-memory');
  assert.deepStrictEqual(calls, [{ focus: 'the same words' }], 'one remember(), with exactly what was given');
  node.remember = () => null;   // sym 0.14: the store could not write the record
  assert.strictEqual(host.emitRecord({ categories: { focus: 'unwritable' } }).outcome, 'store-failed');
});
