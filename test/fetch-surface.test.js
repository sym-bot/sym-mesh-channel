#!/usr/bin/env node
'use strict';

/**
 * sym_fetch, driven THROUGH THE MCP SURFACE — the protocol, not the handler function.
 *
 * The defect this locks down was a caller sending the wrong parameter name: only a real JSON-RPC
 * tools/call over stdio exercises what a peer actually sends. Locked behaviours:
 *   1. the declared parameter is msg_id, and it is required;
 *   2. a call with NO msg_id is a MALFORMED CALL — not a missing or expired message, no `undefined`;
 *   3. a well-formed but unknown id IS a missing delivery;
 *   4. the two answers are distinguishable by their text alone.
 */

const h = require('./_harness.js');
const assert = require('node:assert');

const t = h.suite('sym_fetch — MCP surface');

t('msg_id is declared and required; a malformed call and a missing delivery are told apart', async () => {
  const s = new h.McpSession({ env: { SYM_NODE_NAME: 'fetch-surface-test', SYM_ROOM: 'fetch-surface-test-room' } });
  try {
    await s.initialize();
    const fetchTool = (await s.tools()).find((x) => x.name === 'sym_fetch');
    assert.ok(fetchTool.inputSchema.properties.msg_id);
    assert.deepStrictEqual(fetchTool.inputSchema.required, ['msg_id']);
    const malformed = (await s.call('sym_fetch', { id: 'm007' })).text;
    assert.match(malformed, /malformed call/i);
    assert.match(malformed, /no lookup was attempted/i);
    assert.ok(!/undefined/.test(malformed) && !/expired/i.test(malformed), malformed);
    assert.match(malformed, /Received instead: id\./);
    const missing = (await s.call('sym_fetch', { msg_id: 'm999' })).text;
    assert.match(missing, /not found/i);
    assert.match(missing, /m999/);
    assert.ok(!/malformed/i.test(missing));
    assert.notStrictEqual(malformed, missing);
    const badOffset = (await s.call('sym_fetch', { msg_id: 'in0001', offset: -1 })).text;
    assert.match(badOffset, /No lookup was attempted/);
  } finally { await s.close(); }
});

t.run();
