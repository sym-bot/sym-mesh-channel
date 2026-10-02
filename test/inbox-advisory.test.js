'use strict';

// UNREAD-INBOX ADVISORY — the contract ruled by codex-mac, 2026-08-10, as BEHAVIOUR through MCP (review
// L11). Some hosts never invoke the model on an inbound CMB, so the count rides on every tool answer:
// one line, only when something is unread, the count and nothing else, folded into the answer's last
// text block, on errors as on successes, and never moving the cursor. It is not a wake and not a push.

const h = require('./_harness.js');
const assert = require('node:assert');

const t = h.suite('unread-inbox advisory — MCP surface');
const TOKEN = 'advisory-token-'.padEnd(40, 'z');

t('the footer: count only, only when unread, on every answer including errors, without draining', async () => {
  const relay = await h.fakeRelay();
  const env = { SYM_ROOM: 'advisory-room', SYM_RELAY_URL: relay.url, SYM_RELAY_TOKEN: TOKEN };
  const A = new h.McpSession({ env: { ...env, SYM_NODE_NAME: 'sender' } });
  const B = new h.McpSession({ env: { ...env, SYM_NODE_NAME: 'receiver' } });
  try {
    await A.initialize(); await B.initialize();
    const b = B.instructions.match(/nodeId ([0-9a-f-]{36})/)[1];
    await h.until(async () => /1 peer\(s\)/.test((await A.call('sym_peers')).text), 20000, 400);
    const quiet = await B.call('sym_status');
    assert.ok(!/Mesh inbox/.test(quiet.text), 'silent at zero');
    await A.call('sym_send', { to: b, focus: 'MARKER-FOCUS count me' });
    const st = await h.until(async () => { const x = await B.call('sym_status'); return /Mesh inbox: 1 unread — call sym_receive\.$/.test(x.text) && x; }, 10000, 300);
    assert.ok(st, 'one line, at the end');
    const blocks = st.raw.result.content;
    assert.strictEqual(blocks.length, 1, 'folded into the last text block, not a second block');
    const footer = st.text.split('\n\n').pop();
    assert.strictEqual(footer, 'Mesh inbox: 1 unread — call sym_receive.');
    assert.ok(!/MARKER-FOCUS|sender/.test(footer), 'count only');
    const err = await B.call('sym_send', { to: 'not-a-node', focus: 'x' });
    assert.strictEqual(err.isError, true);
    assert.match(err.text, /Mesh inbox: 1 unread/, 'on an error answer too');
    assert.match((await B.call('sym_status')).text, /Mesh inbox: 1 unread/, 'the footer moved no cursor');
    assert.match((await B.call('sym_receive')).text, /MARKER-FOCUS/);
    assert.ok(!/Mesh inbox/.test((await B.call('sym_status')).text), 'read: silent again');
  } finally { await A.close(); await B.close(); await relay.close(); }
});

t.run();
