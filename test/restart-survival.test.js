'use strict';

/**
 * Restart survival through the PLUGIN's own surface (sym 0.10.2 durable
 * inbox). The plugin is where sessions actually live, and the failure this
 * pins is the one that hit production 2026-08-03/04: a session restarts,
 * the node shows live on bonjour, and everything delivered to the previous
 * process is gone — four gate requests in one documented case, five
 * broadcasts in another. With @sym-bot/sym 0.10.2 the delivery feed (ring +
 * seq + cursor) persists in the node dir and a new session holding the same
 * node identity drains it.
 *
 * Same construction the plugin's server.js uses: a SymNode with a pinned
 * name, torn down, then constructed again — "the session restarted."
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

// Isolate: HOME → sandbox BEFORE any lib/config load (mirrors sym's own
// _isolate-home; the plugin repo runs tests against the installed package).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-restart-'));
process.env.HOME = sandbox;

const { SymNode } = require('@sym-bot/sym');

const NAME = 'smc-restart-test';
const mk = () => new SymNode({ name: NAME, autoStart: false, silent: true });
const settle = () => new Promise((r) => setTimeout(r, 1300)); // persist is 1/s trailing

test('a restarted plugin session drains what the mesh delivered to its node', async () => {
  const before = mk();
  before._pushInbox({
    source: 'claude-sym-cto@test',
    content: 'gate request — merged, releasing',
    cmb: { fields: { focus: { text: 'gate request — merged, releasing' } }, metadata: { key: 'cmb-restart-1' } },
  });
  await settle();

  // The restart: a fresh process-lifetime construct of the SAME node —
  // exactly what server.js does when a session comes back.
  const after = mk();
  const got = after.inbox();
  assert.strictEqual(got.drained, 1, 'delivery must survive the session, not the process');
  assert.strictEqual(got.messages[0].content, 'gate request — merged, releasing');
  assert.strictEqual(got.messages[0].from, 'claude-sym-cto@test',
    'sender identity survives too — a drained backlog you cannot attribute is half a fix');

  await settle(); // cursor persist
  assert.strictEqual(mk().inbox().drained, 0, 'and the next session does not replay it');
});
