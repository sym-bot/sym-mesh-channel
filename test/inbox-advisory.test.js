'use strict';

// UNREAD-INBOX ADVISORY — the contract ruled by codex-mac, 2026-08-10.
//
// Some MCP hosts never invoke the model on an inbound CMB, so any mesh tool can
// succeed while directed mail sits unread. The advisory puts the count on every
// tool response. It is not a wake and not a push.
//
// These assert the SHAPE and the constraints. The end-to-end behaviour against a
// packed install is covered by scripts/verify-packed-artifact.mjs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('the advisory is emitted only when unread > 0 — silent at zero', () => {
  const fn = src.slice(src.indexOf('function inboxAdvisoryLine'), src.indexOf('function withInboxAdvisory'));
  assert.match(fn, /if \(!s \|\| !s\.undrained\) return null/, 'zero unread must produce no line at all');
});

test('it uses inboxStatus(), which does NOT advance the cursor', () => {
  const fn = src.slice(src.indexOf('function inboxAdvisoryLine'), src.indexOf('function withInboxAdvisory'));
  assert.match(fn, /node\.inboxStatus\(\)/, 'must read via inboxStatus()');
  // inbox() advances the cursor unless peek is set; reading the count must never
  // consume the mail it is reporting.
  assert.ok(!/node\.inbox\(/.test(fn), 'must NOT call inbox(), which drains and moves the cursor');
});

test('COUNT ONLY — no sender, focus, or payload leaks into the line', () => {
  const fn = src.slice(src.indexOf('function inboxAdvisoryLine'), src.indexOf('function withInboxAdvisory'));
  for (const leak of ['fromName', '.from', 'focus', 'payload', 'categories', 'content']) {
    assert.ok(!fn.includes(leak), `advisory must not reference ${leak} — it is count-only`);
  }
  assert.match(fn, /Mesh inbox: \$\{s\.undrained\} unread — call sym_receive\./);
});

test('one central wrapper covers every tool, success and error alike', () => {
  // Applying this per-case would drift the moment a tool is added.
  assert.match(
    src,
    /setRequestHandler\(CallToolRequestSchema, async \(request\) => \{\s*return withInboxAdvisory\(await dispatchTool\(request\)\)/,
    'every tool response must pass through the single wrapper',
  );
  assert.equal(
    (src.match(/inboxAdvisoryLine\(\)/g) || []).length, 2,
    'the advisory should be computed in exactly one place (its definition + the wrapper)',
  );
});

test('the advisory appends to the existing text block, not a second block', () => {
  const fn = src.slice(src.indexOf('function withInboxAdvisory'), src.indexOf('mcp.setRequestHandler(CallToolRequestSchema'));
  assert.match(fn, /content\.slice\(0, -1\)/, 'must fold into the last text block');
  assert.match(fn, /\$\{last\.text\}\\n\\n\$\{line\}/, 'appended after the existing text');
});

test('inbox-unread and outbox-held are labelled as different facts', () => {
  // One is mail waiting for THIS node to read; the other is mail this node is
  // holding for someone else. Conflating them would misreport both.
  assert.ok(src.includes('Mesh inbox:'), 'inbox unread label present');
  assert.ok(src.includes('OUTBOX:'), 'outbox held label present');
  assert.ok(!/OUTBOX[^\n]*unread/.test(src), 'the outbox line must not describe itself as unread');
});

test('it is not described as a wake or a push', () => {
  const region = src.slice(src.indexOf('// UNREAD-INBOX ADVISORY'), src.indexOf('mcp.setRequestHandler(CallToolRequestSchema'));
  assert.ok(/NOT a wake and NOT a push/.test(region), 'the comment must state what this is not');
});
