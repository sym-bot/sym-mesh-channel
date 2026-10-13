'use strict';

/**
 * Rooms, discovery and authority through the MCP surface, against the real @sym-bot/sym 0.14.0.
 *
 * A room is an MMP §5.8 identifier. A node in a configured room that is not one is not built (building a node
 * mints an identity, and falling back to 'default' would put the agent in the global mesh), and the cause is
 * said on every tool. Dotted and underscored rooms are rooms. The node advertises on `_sym._tcp` with its
 * room in TXT (the SDK's default), and this channel builds no service type of its own. Authority is sym's
 * §6.6 store: the pin comes from SYM_FOUNDER_ANCHOR, and sym_status shows what the store says.
 *
 * Every server here runs with SYM_LAN=off (the harness default): nothing touches the network.
 */

const h = require('./_harness.js');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sdk = require('@sym-bot/sym');

const t = h.suite('rooms, discovery and authority — MCP surface');

function project(cfg) {
  const dir = fs.mkdtempSync(path.join(process.env.HOME, 'proj-'));
  fs.mkdirSync(path.join(dir, '.sym'));
  fs.writeFileSync(path.join(dir, '.sym', 'node.json'), JSON.stringify(cfg));
  return dir;
}
const FAULT = /^MESH NODE NOT RUNNING: the room named by (.+) is not a room: /;

t('a configured room that is not a room: no node is built, nothing is minted, no fallback, and every tool says why', async () => {
  const cases = [
    { env: { SYM_ROOM: 'Upper_Case', SYM_NODE_NAME: 'badroom-env' }, source: /SYM_ROOM env/, reason: /1 to 64 characters from a-z, 0-9, "\.", "_" and "-", all lowercase \(MMP §5\.8\)/ },
    { env: { SYM_ROOM: 'sym', SYM_NODE_NAME: 'badroom-sym' }, source: /SYM_ROOM env/, reason: /"sym" is reserved/ },
    { env: { SYM_ROOM: 'a'.repeat(65), SYM_NODE_NAME: 'badroom-long' }, source: /SYM_ROOM env/, reason: /at most 64 characters \(this one is 65\)/ },
    { cwd: project({ room: 'Bad Room', node_name: 'badroom-file' }), env: { SYM_NODE_NAME: '' }, source: /node\.json/, reason: /1 to 64 characters/, name: 'badroom-file' },
  ];
  for (const c of cases) {
    const s = new h.McpSession({ ...(c.cwd ? { cwd: c.cwd } : {}), env: { SYM_STATE_DIR: process.env.SYM_STATE_DIR, ...c.env } });
    try {
      await s.initialize();
      const m = s.instructions.match(FAULT);
      assert.ok(m, `the instructions say the room is not a room:\n${s.instructions}`);
      assert.match(m[1], c.source, 'and name where it came from');
      assert.match(s.instructions, c.reason);
      assert.match(s.instructions, /does not fall back to 'default' \(that is the global mesh\)/);
      assert.ok(!/Bad Room|Upper_Case|aaaaaaaa/.test(s.instructions), 'the value is not repeated: it may come from a file in a repository');
      for (const tool of ['sym_status', 'sym_publish', 'sym_receive', 'sym_peers']) {
        const r = await s.call(tool, tool === 'sym_publish' ? { focus: 'x' } : {});
        assert.strictEqual(r.isError, true, tool);
        assert.match(r.text, /MESH NODE NOT RUNNING/, tool);
      }
    } finally { await s.close(); }
    assert.strictEqual(sdk.identity.nodeIdForName(c.name || c.env.SYM_NODE_NAME), null, 'building the node would have minted an identity; it was never built');
  }
});

t('a dotted, an underscored and a tenant-suffixed room are rooms: the node starts in each, and sym_room_info says how it is advertised', async () => {
  for (const room of ['acme.prod', 'team_x', 'x-review--team-02779b950c3d8d7378fd11d6']) {
    const s = new h.McpSession({ env: { SYM_ROOM: room, SYM_NODE_NAME: 'rooms-surface-a' } });
    try {
      await s.initialize();
      assert.ok(!/MESH NODE NOT RUNNING/.test(s.instructions));
      const info = (await s.call('sym_room_info')).text;
      assert.match(info, new RegExp(`room: ${room.replace(/\./g, '\\.')}\n`));
      assert.match(info, /LAN: off \(relay only, SYM_LAN=off\)/);
      assert.ok(!/service type/i.test(info), 'a room is not a service type');
      const st = (await s.call('sym_status')).text;
      assert.match(st, new RegExp(`^Room: ${room.replace(/\./g, '\\.')} — relay only \\(SYM_LAN=off\\)$`, 'm'));
    } finally { await s.close(); }
  }
});

t('SYM_SERVICE_TYPE is read only as a room name, and said; SYM_ROOM wins and it is said to be ignored', async () => {
  const a = new h.McpSession({ env: { SYM_SERVICE_TYPE: '_myteam._tcp', SYM_NODE_NAME: 'rooms-surface-b' } });
  try {
    await a.initialize();
    assert.match(a.instructions, /MESH ROOM ADVISORY: SYM_SERVICE_TYPE is set\. A node is advertised on _sym\._tcp with its room in TXT, never on a per-room service type \(sym 0\.14\), so this server reads it only as a room name: room 'myteam'\. Set SYM_ROOM instead\./);
    assert.match((await a.call('sym_room_info')).text, /room: myteam\n {2}room source: SYM_SERVICE_TYPE env \(read as a room name\)/);
  } finally { await a.close(); }
  const b = new h.McpSession({ env: { SYM_SERVICE_TYPE: '_myteam._tcp', SYM_ROOM: 'chosen-room', SYM_NODE_NAME: 'rooms-surface-c' } });
  try {
    await b.initialize();
    assert.match(b.instructions, /SYM_SERVICE_TYPE is set and ignored: a node is advertised on _sym\._tcp with its room in TXT \(sym 0\.14\), and this node's room comes from SYM_ROOM env\./);
    assert.match((await b.call('sym_room_info')).text, /room: chosen-room\n/);
  } finally { await b.close(); }
  const bad = new h.McpSession({ env: { SYM_SERVICE_TYPE: '_Bad Type._tcp', SYM_NODE_NAME: 'rooms-surface-d' } });
  try {
    await bad.initialize();
    assert.match(bad.instructions, /^MESH NODE NOT RUNNING: the room named by SYM_SERVICE_TYPE env \(read as a room name\) is not a room/);
  } finally { await bad.close(); }
});

t('sym_join_room takes every §5.8 room and refuses the rest with the cause; sym_invite_create too', async () => {
  const s = new h.McpSession({ env: { SYM_ROOM: 'start-room', SYM_NODE_NAME: 'rooms-surface-e' } });
  try {
    await s.initialize();
    for (const [room, why] of [['Bad_Room', /1 to 64 characters/], ['sym', /"sym" is reserved/], ['a'.repeat(65), /at most 64 characters/], ['has space', /1 to 64 characters/], ['', /Missing required argument/]]) {
      const r = await s.call('sym_join_room', { room });
      assert.strictEqual(r.isError, true, JSON.stringify(room.slice(0, 10)));
      assert.match(r.text, why);
    }
    const bad = await s.call('sym_join_room', { room: 'x'.repeat(200) });
    assert.ok(bad.text.length < 600, 'a long refused name is bounded in the answer');
    const odd = await s.call('sym_invite_create', { room: 'ev\u001bil name' });
    assert.match(odd.text, /Invalid room name: "ev\\u001bil name"/, 'escaped, so no control character reaches the answer');
    assert.match((await s.call('sym_invite_create', { room: 'default' })).text, /an invite needs a named room/);
    for (const room of ['acme.prod', 'team_x']) {
      const r = await s.call('sym_join_room', { room });
      assert.strictEqual(r.isError, false, r.text);
      assert.match(r.text, new RegExp(`^Moved from room "(start-room|acme\\.prod)" to "${room.replace(/\./g, '\\.')}", same identity\\.`));
      assert.ok(!/_tcp|service type/.test(r.text), 'no service type in the answer');
      assert.match((await s.call('sym_room_info')).text, new RegExp(`room: ${room.replace(/\./g, '\\.')}\n`));
    }
    const inv = (await s.call('sym_invite_create', { room: 'acme.prod' })).text;
    assert.match(inv, /sym:\/\/room\/acme\.prod\?node=/);
    const info = (await s.call('sym_invite_info', { url: inv.match(/(sym:\/\/room\/\S+)/)[1] })).text;
    assert.match(info, /"room": "acme\.prod"/);
    assert.ok(!/service_type/.test(info), 'an invite names a room, not a service type');
  } finally { await s.close(); }
});

t('sym_rooms_discover on a relay-only node browses nothing and says so', async () => {
  const s = new h.McpSession({ env: { SYM_ROOM: 'discover-room', SYM_NODE_NAME: 'rooms-surface-f' } });
  try {
    await s.initialize();
    const r = await s.call('sym_rooms_discover');
    assert.strictEqual(r.isError, false);
    assert.match(r.text, /^LAN discovery is off on this node \(SYM_LAN=off, relay only\), so it browses nothing\. Your node is in room "discover-room"\./);
  } finally { await s.close(); }
});

t('a malformed anchor pin stops the node with the cause, and a valid pin is shown by sym_status; no pin says nothing is in force', async () => {
  const bad = new h.McpSession({ env: { SYM_FOUNDER_ANCHOR: 'not-a-pin', SYM_NODE_NAME: 'rooms-surface-g' } });
  try {
    await bad.initialize();
    assert.match(bad.instructions, /^MESH NODE NOT RUNNING: the anchor pin in SYM_FOUNDER_ANCHOR does not parse \(anchor pin: expected "nodeId:publicKey" or a JSON pin\)/);
    assert.match(bad.instructions, /Every mesh tool reports this until then\./);
    assert.strictEqual((await bad.call('sym_status')).isError, true);
  } finally { await bad.close(); }
  const json = new h.McpSession({ env: { SYM_FOUNDER_ANCHOR: '{"threshold":', SYM_NODE_NAME: 'rooms-surface-h' } });
  try {
    await json.initialize();
    assert.match(json.instructions, /^MESH NODE NOT RUNNING: the anchor pin in SYM_FOUNDER_ANCHOR does not parse/);
  } finally { await json.close(); }

  const holder = sdk.identity.loadIdentity({ name: 'anchor-holder', create: true });   // a real Ed25519 key, in the sandbox's state root
  const pinned = new h.McpSession({ env: { SYM_FOUNDER_ANCHOR: `${holder.nodeId}:${holder.publicKey}`, SYM_NODE_NAME: 'rooms-surface-i' } });
  try {
    await pinned.initialize();
    const st = (await pinned.call('sym_status')).text;
    assert.match(st, /^Authority \(MMP §6\.6\): anchor pinned \(digest [0-9a-f]{16}…\); 0 statement\(s\) in force of 0 held; root [0-9a-f]{16}…; this node's roles: participant\.$/m);
  } finally { await pinned.close(); }

  const none = new h.McpSession({ env: { SYM_NODE_NAME: 'rooms-surface-j' } });
  try {
    await none.initialize();
    const st = (await none.call('sym_status')).text;
    assert.match(st, /^Authority \(MMP §6\.6\): no anchor pinned, so no statement is in force and every peer, this node included, resolves as a participant\. Pin one out of band with SYM_FOUNDER_ANCHOR/m);
    assert.match(st, /Role grants signed by sym 0\.13 confer nothing\./);
  } finally { await none.close(); }
});

t.run();
