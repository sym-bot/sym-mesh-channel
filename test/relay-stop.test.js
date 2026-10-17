'use strict';

// relay-stop.js — a relay close 4004 / 4006 is said, never a reason to exit (review R4-1), for sym 0.14.2's
// permanent stop and for sym 0.14.3's retry on a long backoff and its ping-pong detector alike.

const { test } = require('node:test');
const assert = require('node:assert');
const { createRelayStops } = require('../relay-stop.js');

function rig(state) {
  const pushes = [], said = [], logs = [];
  let t = 1_000_000;
  const stops = createRelayStops({
    relayState: () => state.value, room: () => 'r4-room',
    push: (type, line, meta) => pushes.push({ type, line, meta }), advise: (k, l) => said.push([k, l]), log: (m) => logs.push(m),
    defer: (f) => f(), now: () => t, repeatMs: 600_000,
  });
  return { stops, pushes, said, logs, tick: (ms) => { t += ms; }, now: () => t };
}

test('sym 0.14.2: a 4004 is pushed once and said once, with no retry, and the way back is named', () => {
  const state = { value: { phase: 'collision', nextRetryAt: null, stopped: { code: 4004 } } };
  const r = rig(state);
  assert.strictEqual(r.stops.onStop({ code: 4004, kind: 'replaced' }), true);
  assert.strictEqual(r.pushes.length, 1);
  assert.strictEqual(r.pushes[0].type, 'relay-stopped');
  assert.match(r.pushes[0].line, /replaced: another connection authenticated as this node's nodeId \(code 4004\)/);
  assert.match(r.pushes[0].line, /anyone holding the relay token/);
  assert.match(r.pushes[0].line, /sym does not dial the relay again on its own after this close: sym_join_room \{room: "r4-room"\}/);
  assert.deepStrictEqual(r.said.map((x) => x[0]), ['relay-stop']);
  assert.match(r.logs[0], /relay stop \(code 4004\)/);
  assert.strictEqual(r.pushes[0].meta.ping_pong, 'no');
});

test('sym 0.14.3: a retry on the backoff is said as such; a repeat is not pushed again; a ping-pong is', () => {
  const r0 = rig({ value: null });
  const state = { value: { phase: 'collision', nextRetryAt: 0, stopped: { code: 4006, closes: 1 } } };
  const r = rig(state);
  state.value.nextRetryAt = r.now() + 60_000;
  r.stops.onStop({ code: 4006, kind: 'duplicate-rejected', pingPong: false, retryInMs: 60_000 });
  assert.match(r.pushes[0].line, /refused as a duplicate/);
  assert.match(r.pushes[0].line, /sym dials the relay again on its own \(next attempt in 60 s\)/);
  r.tick(60_000);
  assert.strictEqual(r.stops.onStop({ code: 4006, pingPong: false }), false, 'the same stop again soon: stderr only');
  assert.strictEqual(r.pushes.length, 1);
  assert.strictEqual(r.logs.length, 2);
  state.value.stopped = { code: 4006, closes: 3, pingPong: true };
  r.tick(60_000);
  assert.strictEqual(r.stops.onStop({ code: 4006, pingPong: true, retryInMs: 1_800_000 }), true, 'a ping-pong found is pushed');
  assert.strictEqual(r.pushes.length, 2);
  assert.match(r.pushes[1].line, /PING-PONG suspected: .*\(code 4006, 3 times in 30 min\)\. Another process is probably running as this agent/);
  assert.strictEqual(r.pushes[1].meta.ping_pong, 'yes');
  assert.match(r.stops.line(), /PING-PONG/, 'and stays the state');
  r.tick(60_000);
  assert.strictEqual(r.stops.onStop({ code: 4006, pingPong: true }), false, 'not pushed twice');
  // Past the repeat window a stop is a new stop.
  r.tick(700_000);
  assert.strictEqual(r.stops.onStop({ code: 4006, pingPong: true }), true);
  state.value = { phase: 'connected' };
  assert.match(r.stops.line(), /The relay is connected again\./);
  r.stops.reset();
  assert.strictEqual(r.stops.line(), null);
  assert.strictEqual(r0.stops.line(), null);
});

test('an event without a code is read as a 4004, and a state that cannot be read says sym does not retry', () => {
  const r = rig({ value: null });
  r.stops.onStop(undefined);
  assert.match(r.pushes[0].line, /\(code 4004\)/);
  const bad = createRelayStops({ relayState: () => { throw new Error('closed'); }, room: () => 'x', push: () => {}, advise: () => {}, defer: (f) => f() });
  bad.onStop({ code: 4004 });
  assert.match(bad.line(), /does not dial the relay again/);
});
