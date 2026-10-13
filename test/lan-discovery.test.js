'use strict';

// LAN discovery, end to end, real @sym-bot/sym 0.14.0: three spawned channel servers with the LAN ON. Two are
// in one room and must find each other by what sym advertises (`_sym._tcp`, TXT room and mmp=2.0, plus the
// same-host loopback registry), exchange records both ways, and not see the third, which is in another room.
//
// OPT IN. This starts real mDNS (multicast) advertisements of a made-up room on this machine's network, so it
// is not part of `npm test`: run it with MESH_CHANNEL_LAN_PROOF=1. Its state is a temp HOME and SYM_STATE_DIR,
// its rooms are made up and unique, and it never joins a real room or a relay.

if (process.env.MESH_CHANNEL_LAN_PROOF !== '1') {
  console.log('lan-discovery: skipped (opt in with MESH_CHANNEL_LAN_PROOF=1: it advertises a made-up room on the real LAN)');
  process.exit(0);
}

const h = require('./_harness.js'); // sandbox first
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const rd = require('../room-discovery.js');

const t = h.suite('LAN discovery (opt in): _sym._tcp with TXT room');
const tag = Math.random().toString(36).slice(2, 8);
const ROOM = `lan-proof-${tag}`;
const OTHER = `lan-proof-other-${tag}`;
const STATE = h.stateDir('lan-shared');       // one state root: the loopback registry is under it
const idOf = (s) => s.instructions.match(/nodeId ([0-9a-f-]{36})/)[1];
const inId = (text, needle) => { const l = text.split('\n').find((x) => x.includes(needle)); return l && (l.match(/\[(in\d{4})\]/) || [])[1]; };
let A, B, C;
const mk = (name, room) => new h.McpSession({ env: { SYM_LAN: 'on', SYM_ROOM: room, SYM_NODE_NAME: name, SYM_STATE_DIR: STATE } });

t('setup: two nodes in one room and one in another', async () => {
  A = mk(`lan-a-${tag}`, ROOM); B = mk(`lan-b-${tag}`, ROOM); C = mk(`lan-c-${tag}`, OTHER);
  await Promise.all([A.initialize(), B.initialize(), C.initialize()]);
});

t('the pair in one room finds each other; the node in the other room is not dialled by either', async () => {
  const idA = idOf(A), idB = idOf(B);
  const ok = await h.until(async () => (await A.call('sym_peers')).text.includes(idB) && (await B.call('sym_peers')).text.includes(idA), 60000, 1000);
  assert.ok(ok, `A and B did not meet.\nA: ${(await A.call('sym_peers')).text}\nB: ${(await B.call('sym_peers')).text}\nA stderr:\n${A.stderr}`);
  await new Promise((r) => setTimeout(r, 8000));      // a few registry scans and mDNS announcements more
  assert.ok(!(await A.call('sym_peers')).text.includes(idOf(C)), 'A does not have C');
  assert.ok(!(await B.call('sym_peers')).text.includes(idOf(C)), 'B does not have C');
  assert.match((await C.call('sym_peers')).text, /^No peers with a proven session\./);
});

t('what the node advertises: _sym._tcp, TXT room and mmp=2.0, and the loopback registration says the same', async () => {
  const reg = path.join(STATE, 'loopback');
  const rec = JSON.parse(fs.readFileSync(path.join(reg, `${idOf(A)}.json`), 'utf8'));
  assert.strictEqual(rec.serviceType, '_sym._tcp', 'no per-room service type');
  assert.strictEqual(rec.room, ROOM);
  assert.strictEqual(rec.mmp, '2.0');
  const seen = await rd.browseServices({ ms: 4000 });
  assert.ok(!seen.error, seen.error);
  const mine = seen.services.map((s) => rd.txtOf(s)).find((x) => x.get('node-id') === idOf(A));
  assert.ok(mine, 'A is advertised on _sym._tcp over mDNS');
  assert.strictEqual(mine.get('room'), ROOM);
  assert.strictEqual(mine.get('mmp'), '2.0');
});

t('sym_rooms_discover lists the made-up rooms from their TXT, and nothing else a peer chose', async () => {
  let text = '';
  const ok = await h.until(async () => { text = (await A.call('sym_rooms_discover')).text; return text.includes(OTHER); }, 30000, 2000);
  assert.ok(ok, `the other room is listed:\n${text}`);
  assert.match(text, new RegExp(`^ {2}${OTHER} {3}1 node\\(s\\)$`, 'm'));
  assert.match(text, new RegExp(`^ {2}${ROOM} {3}1 node\\(s\\).*\\(← your current room\\)$`, 'm'));
  assert.ok(!text.includes(`lan-b-${tag}`) && !text.includes(`lan-c-${tag}`), 'no node name is printed');
  const room = (await A.call('sym_room_info')).text;
  assert.match(room, /LAN: _sym\._tcp with TXT room=lan-proof-[a-z0-9]+, mmp=2\.0; dials only advertisements whose TXT room is this room and whose mmp lists 2\.0/);
});

t('records go both ways: directed and broadcast, and a delivery is fetched in full', async () => {
  const idA = idOf(A), idB = idOf(B);
  assert.match((await A.call('sym_send', { to: idB, focus: 'directed from A: please look at the export job' })).text, /^Sent CMB/);
  assert.match((await B.call('sym_send', { to: idA, focus: 'directed from B: the export job is fine' })).text, /^Sent CMB/);
  const ra = await h.until(async () => { const x = (await A.call('sym_receive')).text; return /export job is fine/.test(x) && x; }, 30000, 500);
  const rb = await h.until(async () => { const x = (await B.call('sym_receive')).text; return /look at the export job/.test(x) && x; }, 30000, 500);
  assert.ok(ra && rb, 'both directed records arrived');
  assert.match(ra, /\[lan-b-[a-z0-9]+ ⟨…[0-9a-f]{8,}⟩ →you\]/);
  const full = (await A.call('sym_fetch', { msg_id: inId(ra, 'export job is fine') })).text;
  assert.match(full, /Audience: directed to this node/);
  assert.match(full, /focus: directed from B: the export job is fine/);
  assert.match((await A.call('sym_publish', { focus: 'A broadcasts: nightly backup completed' })).text, /^Published CMB/);
  const rb2 = await h.until(async () => { const x = (await B.call('sym_receive')).text; return /nightly backup completed/.test(x) && x; }, 30000, 500);
  assert.ok(rb2, 'the broadcast reached B');
});

t('teardown', async () => { await Promise.all([A, B, C].map((s) => s && s.close())); });

t.run();
