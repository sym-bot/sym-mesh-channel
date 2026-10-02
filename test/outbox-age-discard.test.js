'use strict';

// sym_outbox_discard, through the MCP surface: held mail must say how old it is, and there must be a
// way out (dev-team-4, 2026-09-14: one CMB held ten days for a doer that had died). In 0.11 the queue
// is keyed by nodeId; a 0.10 item held for a name that maps to no nodeId is reported, and discardable
// by that label.

const h = require('./_harness.js');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sdk = require('@sym-bot/sym');

const t = h.suite('outbox: age and discard (MCP surface)');
const A = '01a0fd15-52ca-726c-9ce1-5767a1379249';

t('sym_peers reports held mail with its age and the label-only 0.10 item; discard removes exactly one peer\'s', async () => {
  // The sandbox's own state root, which this process's sym reads too (sym reads it once, at load).
  const state = process.env.SYM_STATE_DIR;
  // The node's identity and a held outbox, as a 0.10 node would have left it, moved by sym's migration.
  const ident = sdk.identity.loadIdentity({ name: 'outbox-e2e', create: true });
  const dir = sdk.identity.nodeDirById(ident.nodeId);
  fs.writeFileSync(path.join(dir, 'known-peers.json'), JSON.stringify({ version: 2, peers: { [A]: { label: 'alice', lastSeen: 1 } }, byOldName: {} }));
  fs.writeFileSync(path.join(dir, 'outbox.json'), JSON.stringify({ seq: 2, items: [
    { seq: 1, to: A, label: 'alice', categories: { focus: 'old mail' }, parents: [], heldAt: Date.now() - 10 * 86400000 },
    { seq: 2, to: null, label: 'ghost', categories: { focus: 'mail for a name' }, parents: [] },
  ] }));
  const s = new h.McpSession({ env: { SYM_STATE_DIR: state, SYM_NODE_NAME: 'outbox-e2e', SYM_ROOM: 'outbox-room' } });
  try {
    await s.initialize();
    const peers = (await s.call('sym_peers')).text;
    assert.match(peers, /OUTBOX: 2 CMB\(s\) HELD AT THIS SENDER, not delivered/);
    assert.match(peers, new RegExp(`1 for alice \\(${A}\\)`));
    assert.match(peers, /held by 0.10 for a label that is not a route \(discard it with sym_outbox_discard \{peer: "ghost"\}\)/);
    assert.match(peers, /oldest held 10 day\(s\)/);
    assert.match(peers, /Clear them with sym_outbox_discard/);
    const d = (await s.call('sym_outbox_discard', { peer: A })).text;
    assert.match(d, /Discarded 1 CMB\(s\) held for .*the oldest held 10 day\(s\)\. They were never delivered and are gone\. 1 CMB\(s\) remain/);
    assert.match((await s.call('sym_outbox_discard', { peer: 'ghost' })).text, /Discarded 1 CMB\(s\)/);
    assert.match((await s.call('sym_outbox_discard', { peer: A })).text, /Nothing held for/);
  } finally { await s.close(); }
});

t.run();
