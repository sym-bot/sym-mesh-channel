'use strict';

// UNREAD-INBOX ADVISORY — the contract ruled by codex-mac, 2026-08-10. Some MCP hosts never invoke the
// model on an inbound CMB, so the count rides on every tool answer. It is not a wake and not a push.
// The behaviour end to end is in core-secure-e2e.test.js ("the unread footer counts what waits"); these
// pin the shape: count only, read without draining, one wrapper for every tool, folded into the last
// text block, and — 0.11 — a delivery pushed into a session that CONFIRMED push is not counted.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, '..', 'node-host.js'), 'utf8');
const region = (s, from, to) => s.slice(s.indexOf(from), s.indexOf(to));

test('the count reads inboxStatus(), which does not move the cursor, and says nothing but the count', () => {
  const fn = region(host, '  unreadCount() {', '  /** Whether `id` is still waiting');
  assert.match(fn, /inboxStatus\(\)\.undrained/);
  assert.ok(!/inbox\(\{/.test(fn), 'must not call inbox(), which drains');
  const line = region(src, 'function withInboxAdvisory', '// ONE TOOL CALL AT A TIME');
  assert.match(line, /`Mesh inbox: \$\{n\} unread — call sym_receive\.`/);
  for (const leak of ['focus', 'payload', 'categories', 'facts', 'label']) assert.ok(!line.includes(`.${leak}`), `count only: ${leak}`);
  assert.match(line, /if \(!n \|\| !result/, 'silent at zero');
});

test('pushed deliveries leave the count only once the session confirmed push, first-hand', () => {
  const fn = region(src, 'function unreadNow', 'function withInboxAdvisory');
  assert.match(fn, /if \(pushState\.confirmed\(\)\)/);
  assert.match(fn, /host\.isUndrained\(id\)/, 'and only while the engine still holds it unread');
});

test('one wrapper covers every tool, success and error alike, folded into the last text block', () => {
  assert.match(src, /toolQueue\.then\(async \(\) => withInboxAdvisory\(await dispatchTool\(request\)\)\)/);
  assert.strictEqual((src.match(/withInboxAdvisory\(/g) || []).length, 2, 'its definition and the one call');
  const fn = region(src, 'function withInboxAdvisory', '// ONE TOOL CALL AT A TIME');
  assert.match(fn, /content\.slice\(0, -1\)/);
  assert.match(fn, /\$\{last\.text\}\\n\\n\$\{line\}/);
});

test('inbox-unread and outbox-held are different facts, labelled apart', () => {
  assert.ok(src.includes('Mesh inbox:'));
  assert.ok(src.includes('OUTBOX:'));
  assert.ok(!/OUTBOX[^\n]*unread/.test(src));
  assert.match(src, /Not a wake, not a push/);
});
