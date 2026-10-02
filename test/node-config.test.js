#!/usr/bin/env node
'use strict';

/**
 * The folder's identity and room, through the MCP surface (design D10): `.sym/node.json` keys this
 * server does not read are named, never silently ignored; a pinned nodeId loads without minting, and
 * one that is not on this host leaves the server running without a node, saying why on every tool.
 */

const h = require('./_harness.js');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sdk = require('@sym-bot/sym');

const t = h.suite('node.json and the pinned identity — MCP surface');

function project(cfg) {
  const dir = fs.mkdtempSync(path.join(process.env.HOME, 'proj-'));
  fs.mkdirSync(path.join(dir, '.sym'));
  fs.writeFileSync(path.join(dir, '.sym', 'node.json'), JSON.stringify(cfg));
  return dir;
}

t('the pre-rename "group" key, an unknown key and an unusable name are each named, with the fix', async () => {
  const s = new h.McpSession({ cwd: project({ node_name: 'bad/name', group: 'team-x', colour: 'blue' }), env: { SYM_NODE_NAME: '' } });
  try {
    await s.initialize();
    assert.match(s.instructions, /sets a node_name that must not contain path separators/);
    assert.match(s.instructions, /sets a "group" key, the name this project used before the rename to "room"\. It is not read/);
    assert.match(s.instructions, /Rename the key to "room"/);
    assert.ok(!/bad\/name|team-x/.test(s.instructions), 'the file\'s own values never reach the instructions (L8)');
  } finally { await s.close(); }
  const u = new h.McpSession({ cwd: project({ room: 'cfg-room', colour: 'blue' }), env: { SYM_NODE_NAME: '' } });
  try {
    await u.initialize();
    assert.match(u.instructions, /contains 1 key\(s\) this plugin does not read\. Only "node_name", "room" and "node_id" are honoured/);
    assert.ok(!/colour/.test(u.instructions), 'nor its unknown key names (L8)');
    assert.match((await u.call('sym_room_info')).text, /room: cfg-room\n {2}room source: .*node\.json/);
  } finally { await u.close(); }
});

t('a pinned node_id that is not on this host: no node is minted, and every tool says why', async () => {
  const ghost = '01a0fd15-0000-7000-8000-00000000dead';
  const s = new h.McpSession({ cwd: project({ node_name: 'pinned-ghost', node_id: ghost }), env: { SYM_NODE_NAME: '', SYM_STATE_DIR: process.env.SYM_STATE_DIR } });
  try {
    await s.initialize();
    assert.match(s.instructions, /^MESH NODE NOT RUNNING: node_id in .*node\.json names an identity that is not on this host, and this server does not mint a replacement/);
    for (const tool of ['sym_status', 'sym_publish', 'sym_receive']) {
      const r = await s.call(tool, tool === 'sym_publish' ? { focus: 'x' } : {});
      assert.strictEqual(r.isError, true, tool);
      assert.match(r.text, /MESH NODE NOT RUNNING/, tool);
    }
  } finally { await s.close(); }
  assert.strictEqual(sdk.identity.nodeIdForName('pinned-ghost'), null, 'nothing was minted under the name either');
});

t('a pinned node_id that is on this host is loaded as itself, and status says so', async () => {
  const id = sdk.identity.loadIdentity({ name: 'pinned-real', create: true }).nodeId;
  const s = new h.McpSession({ cwd: project({ node_name: 'pinned-real', node_id: id }), env: { SYM_NODE_NAME: '', SYM_STATE_DIR: process.env.SYM_STATE_DIR } });
  try {
    await s.initialize();
    assert.match(s.instructions, new RegExp(`node 'pinned-real', nodeId ${id}`));
    const st = (await s.call('sym_status')).text;
    assert.match(st, new RegExp(`^Node: pinned-real — nodeId ${id}, key fingerprint ([0-9a-f]{64}|\\(this SDK has no accessor for the node's own key\\))`), 'from the SDK accessor, never a minted invite');
    assert.ok(!/Pin this folder's agent/.test(st), 'already pinned');
  } finally { await s.close(); }
  const u = new h.McpSession({ env: { SYM_NODE_NAME: 'unpinned' } });
  try {
    await u.initialize();
    assert.match((await u.call('sym_status')).text, /Pin this folder's agent so it is never re-minted: add "node_id": "[0-9a-f-]{36}" to /);
  } finally { await u.close(); }
});

t.run();
