'use strict';

// End to end, real @sym-bot/sym 0.14.0: a delivery is surfaced once for the life of the store, and an
// inbox id is assigned only once its item is durable and is never reused (sym 0.14.0, "Redelivery and
// inbox ids"). The field report this answers: deliveries came back as new ones, under new ids, after a
// restart or a room move, and an id announced to the agent was later given to another record.
//
// Two spawned channel servers meet through a loopback fake relay (no LAN). Everything is asserted on what a
// session reads: tool results. The sender is restarted again and again, so its anchor replay (MMP §9.4:
// `cmb-anchors`, which makes a receiver offer its newest room records to a new session) puts the same
// records in front of the receiver each time; the relay's tap counts the sealed record frames that really
// went, so "nothing new" is not the answer of a quiet network.

const h = require('./_harness.js'); // sandbox first
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const t = h.suite('Redelivery and inbox ids (two servers, one relay)');
const TOKEN = 'redelivery-token-'.padEnd(40, 'x');
const ROOM = 'redelivery-room';
let relay;
const frames = [];                      // sealed record frames the relay carried: { from, to }
const idOf = (s) => s.instructions.match(/nodeId ([0-9a-f-]{36})/)[1];
const inIds = (text) => [...text.matchAll(/\[(in\d{4})\]/g)].map((m) => m[1]);
// A fetch fences the peer text with a marker that carries a fresh nonce each time; the rest must be identical.
const unfence = (x) => x.replace(/(PEER TEXT in\d{4}) [0-9a-f]{12}/g, '$1 <nonce>');
const idFor = (text, needle) => { const l = text.split('\n').find((x) => x.includes(needle)); return l && (l.match(/\[(in\d{4})\]/) || [])[1]; };

function persistent(name, label) {
  const state = h.stateDir(label);
  const cwd = fs.mkdtempSync(path.join(process.env.HOME, `${label}-proj-`));
  // The nodeId is pinned after the first start, as a folder's .sym/node.json pins it, so a restart is the same agent.
  return { name, env: { SYM_ROOM: ROOM, SYM_RELAY_TOKEN: TOKEN, SYM_NODE_NAME: name, SYM_STATE_DIR: state, CLAUDE_PROJECT_DIR: cwd } };
}
const start = async (p) => {
  const s = new h.McpSession({ env: { ...p.env, SYM_RELAY_URL: relay.url } });
  await s.initialize();
  return s;
};
const meets = (A, B) => h.until(async () => /1 peer\(s\)/.test((await A.call('sym_peers')).text) && /1 peer\(s\)/.test((await B.call('sym_peers')).text), 30000, 400);

t('setup: a relay that counts sealed record frames', async () => {
  relay = await h.fakeRelay({ tap: ({ from, to, payload }) => { if (payload && payload.type === 'cmb-encrypted') frames.push({ from, to }); } });
});

t('deliveries are surfaced once and ids are never reused, across the sender\'s restarts, the receiver\'s, and a room move', async () => {
  const pa = persistent('alice', 'alice-redeliver');
  const pb = persistent('bob', 'bob-redeliver');
  let A = await start(pa); let B = await start(pb);
  try {
    assert.ok(await meets(A, B), `the pair did not meet.\nA: ${A.stderr}\nB: ${B.stderr}`);
    const a = idOf(A), b = idOf(B);

    // Three deliveries: two room broadcasts bob's SVAF admits (its memory is empty) and one directed message.
    assert.match((await A.call('sym_publish', { focus: 'the relay was healthy through the whole night' })).text, /^Published CMB/);
    assert.match((await A.call('sym_publish', { focus: 'the relay queue stayed empty through the whole night' })).text, /^Published CMB/);
    assert.match((await A.call('sym_send', { to: b, focus: 'please review the outbox migration before noon' })).text, /^Sent CMB/);
    let first = '';
    const got = await h.until(async () => { first += (await B.call('sym_receive')).text + '\n'; return inIds(first).length >= 3 && first; }, 30000, 500);
    assert.ok(got, `bob did not receive three deliveries:\n${first}\nB stderr:\n${B.stderr}`);
    const ids = { one: idFor(first, 'healthy through'), two: idFor(first, 'queue stayed empty'), three: idFor(first, 'outbox migration') };
    assert.deepStrictEqual(Object.values(ids), ['in0001', 'in0002', 'in0003'].map((x) => x), `ids are assigned in order and once: ${JSON.stringify(ids)}`);
    // Bob reads the first in full: it is acknowledged, and must stay read.
    assert.match((await B.call('sym_fetch', { msg_id: ids.one })).text, /healthy through the whole night/);
    const fetched = {};
    for (const [k, id] of Object.entries(ids)) fetched[k] = (await B.call('sym_fetch', { msg_id: id })).text;

    // The sender restarts, and its new session replays its newest room records to bob (the relay saw the
    // sealed frames; a sender offers a non-empty replay to one peer at most once a minute, so only a NEW
    // sender process replays again). Bob must show nothing new: no id, no unread, the same texts. Then the
    // same after the receiver restarts, and after it moves rooms and back (sym_join_room: a new node for the
    // same identity).
    const fenceless = {};
    const replayRound = async (label) => {
      const before = frames.filter((f) => f.from === a && f.to === b).length;
      await A.close();
      A = await start(pa);
      assert.strictEqual(idOf(A), a, 'the same agent after a restart');
      assert.ok(await meets(A, B), `${label}: the pair did not meet again`);
      const replayed = await h.until(() => frames.filter((f) => f.from === a && f.to === b).length >= before + 2, 20000, 200);
      assert.ok(replayed, `${label}: the restarted sender's anchor replay reached the receiver (${frames.filter((f) => f.from === a && f.to === b).length - before} sealed record frame(s))`);
      await new Promise((r) => setTimeout(r, 1500));        // let bob's node take, de-duplicate and journal the frames
      const r = (await B.call('sym_receive')).text;
      assert.ok(!/new mesh delivery/.test(r), `${label}: nothing is surfaced again:\n${r}`);
      assert.match(r, /Caught up|Already read with sym_fetch, not repeated/, `${label}: ${r}`);
      assert.ok(!/Mesh inbox/.test((await B.call('sym_status')).text), `${label}: nothing is counted unread after the replay`);
      for (const [k, id] of Object.entries(ids)) {
        const again = unfence((await B.call('sym_fetch', { msg_id: id })).text);
        fenceless[k] = fenceless[k] || unfence(fetched[k]);
        assert.strictEqual(again, fenceless[k], `${label}: ${id} fetches what it announced`);
      }
    };
    await replayRound('sender restart 1');
    await replayRound('sender restart 2');

    await B.close();
    B = await start(pb);
    assert.strictEqual(idOf(B), b);
    await replayRound('receiver restarted, then the sender restarted');

    const away = await B.call('sym_join_room', { room: 'redelivery-away', relay_url: relay.url, relay_token: TOKEN });
    assert.strictEqual(away.isError, false, away.text);
    const back = await B.call('sym_join_room', { room: ROOM, relay_url: relay.url, relay_token: TOKEN });
    assert.strictEqual(back.isError, false, back.text);
    await replayRound('receiver moved room and back (hot-swap), then the sender restarted');

    // A new delivery takes the next id: no id is reused.
    assert.match((await A.call('sym_send', { to: b, focus: 'a fourth, genuinely new request about the dashboard' })).text, /^Sent CMB/);
    let fourth = '';
    const got4 = await h.until(async () => { fourth += (await B.call('sym_receive')).text + '\n'; return /dashboard/.test(fourth) && fourth; }, 20000, 400);
    assert.ok(got4, `the new delivery arrived:\n${fourth}`);
    assert.strictEqual(idFor(fourth, 'the dashboard'), 'in0004', 'the next id, never one announced before');
    assert.strictEqual(inIds(fourth).filter((x) => x !== 'in0004').length, 0, 'and only that one');
    for (const [k, id] of Object.entries(ids)) assert.ok((await B.call('sym_fetch', { msg_id: id })).text.includes(k === 'one' ? 'healthy through' : k === 'two' ? 'queue stayed empty' : 'outbox migration'), `${id} still fetches its own record`);
  } finally { await A.close(); await B.close(); }
});

t('the delivery ledger alone keeps a delivered record from surfacing again, when the node\'s memory of it is gone', async () => {
  // Memory normally protects too (a replayed record the store holds is a duplicate). The ledger is for what
  // memory does not hold: a record delivered but never stored, or a store lost or pruned. Here the receiver's
  // stored records and its older dedup file are removed between runs and only the ledger is left (sym keeps
  // it in cmbs/.delivered-marks, append-only, written before a delivery is announced).
  const pa = persistent('alice', 'alice-ledger');
  const pb = persistent('bob', 'bob-ledger');
  let A = await start(pa); let B = await start(pb);
  try {
    assert.ok(await meets(A, B), `the pair did not meet.\nA: ${A.stderr}\nB: ${B.stderr}`);
    const a = idOf(A), b = idOf(B);
    assert.match((await A.call('sym_publish', { focus: 'the ledger probe: the nightly export finished cleanly' })).text, /^Published CMB/);
    let seen = '';
    assert.ok(await h.until(async () => { seen += (await B.call('sym_receive')).text + '\n'; return /nightly export/.test(seen); }, 30000, 500), `no delivery:\n${seen}`);
    assert.strictEqual(idFor(seen, 'nightly export'), 'in0001');
    await new Promise((r) => setTimeout(r, 1500));          // the node journals before it announces; give its snapshot a beat
    await B.close();

    const dir = (() => { const root = pb.env.SYM_STATE_DIR; const stack = [root]; while (stack.length) { const d = stack.pop(); for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory() && e.name === 'cmbs' && d.includes(b)) return path.join(d, e.name); if (e.isDirectory()) stack.push(path.join(d, e.name)); } } return null; })();
    assert.ok(dir, 'the receiver\'s cmbs directory');
    assert.ok(fs.existsSync(path.join(dir, '.delivered-marks')), 'sym\'s ledger is where this test expects it');
    for (const f of fs.readdirSync(dir)) if (f !== '.delivered-marks') fs.rmSync(path.join(dir, f), { force: true });
    assert.deepStrictEqual(fs.readdirSync(dir), ['.delivered-marks'], 'only the ledger is left');

    B = await start(pb);
    assert.strictEqual(idOf(B), b);
    const before = frames.filter((f) => f.from === a && f.to === b).length;
    await A.close();
    A = await start(pa);
    assert.ok(await meets(A, B));
    assert.ok(await h.until(() => frames.filter((f) => f.from === a && f.to === b).length >= before + 1, 20000, 200), 'the replay reached the receiver');
    await new Promise((r) => setTimeout(r, 2000));
    const r = (await B.call('sym_receive')).text;
    assert.ok(!/nightly export/.test(r) && !/new mesh delivery/.test(r), `the ledger kept it from surfacing again:\n${r}`);
    assert.match((await B.call('sym_fetch', { msg_id: 'in0001' })).text, /nightly export finished cleanly/, 'and in0001 still fetches what it announced: the inbox is durable');
    assert.ok(!/Mesh inbox/.test((await B.call('sym_status')).text));
  } finally { await A.close(); await B.close(); }
});

t('teardown', async () => { await relay.close(); });

t.run();
