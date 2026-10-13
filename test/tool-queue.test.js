'use strict';

// tool-queue.js — tool calls run one at a time, in arrival order (design D11). The hold of a hung call
// starts when the call STARTS: review r5 showed v1's timer started at enqueue, so once a call hung past
// the hold every call behind it was released at once and they ran together, a sym_fetch beside the
// sym_receive sent before it.

const { test } = require('node:test');
const assert = require('node:assert');
const { createToolQueue } = require('../tool-queue.js');

function harness(holdMs) {
  const enqueue = createToolQueue({ holdMs });
  const t0 = Date.now();
  const log = [];
  let running = 0, overlapAfterHung = 0;
  const call = (name, ms, { hung = false } = {}) => enqueue(async () => {
    running++;
    if (!hung && running > 2) overlapAfterHung++;
    log.push(['start', name, Date.now() - t0, running]);
    await new Promise((r) => setTimeout(r, ms));
    log.push(['end', name, Date.now() - t0]);
    running--;
    return name;
  });
  return { call, log, overlap: () => overlapAfterHung };
}

test('calls run one at a time, in the order they arrived', async () => {
  const h = harness(5000);
  const out = await Promise.all([h.call('sym_receive', 60), h.call('sym_fetch', 10), h.call('sym_status', 5)]);
  assert.deepStrictEqual(out, ['sym_receive', 'sym_fetch', 'sym_status']);
  const starts = h.log.filter((e) => e[0] === 'start');
  assert.deepStrictEqual(starts.map((e) => e[1]), ['sym_receive', 'sym_fetch', 'sym_status']);
  assert.ok(starts.every((e) => e[3] === 1), 'never two at once');
});

test('r5: a hung call releases only the NEXT call after the hold, and the calls behind it still run in order', async () => {
  const h = harness(150);
  const done = [];
  const hung = h.call('hung sym_join_room', 900, { hung: true }).then((n) => done.push(n));
  const recv = h.call('sym_receive', 80).then((n) => done.push(n));
  const fetch = h.call('sym_fetch in0042', 20).then((n) => done.push(n));
  await Promise.all([hung, recv, fetch]);
  const start = (name) => h.log.find((e) => e[0] === 'start' && e[1] === name)[2];
  const end = (name) => h.log.find((e) => e[0] === 'end' && e[1] === name)[2];
  assert.ok(start('sym_receive') >= 140, `the next call waits out the hold: ${start('sym_receive')}`);
  assert.ok(start('sym_fetch in0042') >= end('sym_receive'), `sym_fetch starts after sym_receive ends: ${start('sym_fetch in0042')} < ${end('sym_receive')}`);
  assert.strictEqual(h.overlap(), 0, 'no two queued calls ever ran together');
});

test('a failing call releases the queue as a finished one does', async () => {
  const enqueue = createToolQueue({ holdMs: 5000 });
  const a = enqueue(async () => { throw new Error('boom'); });
  const b = enqueue(async () => 'after');
  await assert.rejects(a, /boom/);
  assert.strictEqual(await b, 'after');
});

test('the server runs every tool call through this queue', () => {
  // The one structural fact the behaviour above depends on: server.js has no second path to a tool.
  const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(src, /server\.setRequestHandler\(CallToolRequestSchema, onToolCall\)/);
  assert.match(src, /return enqueueTool\(async \(\) => withDaemonRoomAdvisory\(withInboxAdvisory\(await dispatchTool\(request\)\), /);
});
