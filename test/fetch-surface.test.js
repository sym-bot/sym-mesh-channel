#!/usr/bin/env node
'use strict';

/**
 * sym_fetch, driven THROUGH THE MCP SURFACE — the protocol, not the handler function.
 *
 * Why the surface and not a unit call: the defect this locks down was a caller sending the
 * wrong parameter name. A unit test that invokes the handler with `{msg_id}` can never see
 * that, and a unit test that tries both spellings proves only that the author thought of
 * both. Only a real JSON-RPC tools/call over stdio exercises what a peer actually sends.
 *
 * Locked behaviours:
 *   1. the declared parameter name is msg_id, and the schema says it is required
 *   2. a call with NO msg_id is answered as a MALFORMED CALL — it must not report a missing
 *      or expired message, and must not interpolate `undefined` into the answer
 *   3. a call with a well-formed but unknown msg_id IS a missing-message answer
 *   4. the two answers are distinguishable from each other by their text alone
 */

const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

/** One MCP session over stdio: initialize, then send each request, collect responses. */
function mcpCall(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, SYM_NODE_NAME: 'fetch-surface-test', SYM_GROUP: 'fetch-surface-test-room' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP server did not answer in time')); }, 20000);
    child.stdout.on('data', (d) => {
      out += String(d);
      const lines = out.split('\n').filter(Boolean);
      const parsed = [];
      for (const l of lines) { try { parsed.push(JSON.parse(l)); } catch { /* partial line */ } }
      if (parsed.filter((p) => p.id !== undefined).length >= requests.length + 1) {
        clearTimeout(timer); child.kill(); resolve(parsed);
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fetch-surface-test', version: '1' } },
    }) + '\n');
    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
  });
}

(async () => {
  console.log('\nsym_fetch — MCP surface\n');

  const responses = await mcpCall([
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    // The exact defect: a caller using a different key. `id` is the natural wrong guess.
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sym_fetch', arguments: { id: 'm007' } } },
    // Well-formed but unknown — this one IS a missing message.
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sym_fetch', arguments: { msg_id: 'm999' } } },
  ]);

  const byId = new Map(responses.filter((r) => r.id !== undefined).map((r) => [r.id, r]));
  const textOf = (id) => {
    const r = byId.get(id);
    const c = r && r.result && r.result.content;
    return Array.isArray(c) && c[0] ? String(c[0].text || '') : JSON.stringify(r);
  };

  check('the declared parameter is msg_id and is required', () => {
    const tools = byId.get(1).result.tools;
    const fetchTool = tools.find((t) => t.name === 'sym_fetch');
    assert.ok(fetchTool, 'sym_fetch is not exposed on the surface');
    assert.ok(fetchTool.inputSchema.properties.msg_id, 'msg_id is not a declared property');
    assert.deepStrictEqual(fetchTool.inputSchema.required, ['msg_id']);
  });

  check('a call without msg_id is answered as a malformed call, not a missing message', () => {
    const t = textOf(2);
    assert.ok(/malformed call/i.test(t), `expected a malformed-call answer, got: ${t}`);
    assert.ok(/no lookup was attempted/i.test(t), 'the answer must say no lookup happened');
    assert.ok(!/undefined/.test(t), `the answer must not interpolate undefined, got: ${t}`);
    assert.ok(!/expired/i.test(t), 'a malformed call must not be reported as an expired message');
    assert.ok(/\bid\b/.test(t), 'the answer should name what was received instead, to be self-diagnosing');
  });

  check('a well-formed unknown id IS reported as a missing message', () => {
    const t = textOf(3);
    assert.ok(/not found/i.test(t), `expected a not-found answer, got: ${t}`);
    assert.ok(/m999/.test(t), 'the answer should echo the id that was looked up');
    assert.ok(!/malformed/i.test(t), 'a real lookup must not be reported as malformed');
  });

  check('the two failure answers are distinguishable by text alone', () => {
    assert.notStrictEqual(textOf(2), textOf(3));
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
