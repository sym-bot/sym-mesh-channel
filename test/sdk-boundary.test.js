'use strict';

// The SDK boundary (design D1): the channel uses sym 0.14's public host API only. No shipped file
// reaches an SDK underscore field or deep-imports sym's lib/, and none uses what Core Secure retired:
// the frame handler, the per-peer secrets, the identity-key accessor, the 'frame-received' event, the
// daemon's register / register-agent / agent-cmb IPC.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shipped = require('../package.json').files
  .flatMap((f) => (f.endsWith('/') ? fs.readdirSync(path.join(root, f)).filter((x) => /\.(m?js)$/.test(x)).map((x) => path.join(f, x)) : [f]))
  .filter((f) => /\.(m?js)$/.test(f));

test('the shipped files are the ones scanned', () => {
  for (const f of ['server.js', 'node-host.js', 'interior-host.js', 'delivery-facts.js', 'bin/install.js']) assert.ok(shipped.includes(f), f);
});

test('no SDK internal, no retired event, no daemon IPC, no deep import', () => {
  const RETIRED = [/_frameHandler/, /_identityKey/, /_peerSharedSecrets/, /frame-received/, /register-agent/, /agent-cmb/, /daemon\.sock/, /@sym-bot\/sym\/lib\//];
  // An SDK object's underscore member: node._x, n._x, this.node._x, host.node._x, sdk._x.
  const UNDERSCORE = /\b(?:node|n|sdk|symNode|this\.node|host\.node)\._[A-Za-z]/;
  for (const f of shipped) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const re of RETIRED) assert.ok(!re.test(src), `${f} uses ${re}`);
    const lines = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
    const hit = lines.find((l) => UNDERSCORE.test(l));
    assert.ok(!hit, `${f} reaches an SDK underscore field: ${hit && hit.trim()}`);
  }
});

test('the legacy message frame is not listened for: messages are directed CMBs, raised as the SDK\'s message event', () => {
  const host = fs.readFileSync(path.join(root, 'node-host.js'), 'utf8');
  assert.ok(host.includes("node.on('verified-record'"), 'deliveries are joined to verified-record');
  assert.ok(host.includes("node.on('message', (fromName, text, meta)"), 'the 0.14 message event, with its assertion id');
  assert.ok(host.includes('this.ledger.take(meta && meta.assertionId)'));
});

test('the instructions are built without record text (audit C-2.12)', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(!/buildStartupPrimer/.test(server), 'no startup primer in the instructions');
  const fn = server.slice(server.indexOf('function instructions()'), server.indexOf('// The MCP server is built once'));
  assert.ok(!/recall\(/.test(fn) && !/\.content\b/.test(fn) && !/\.categories/.test(fn), 'the instructions read no record');
});
