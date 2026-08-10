#!/usr/bin/env node
'use strict';

// RELEASE GATE — verify the PACKED ARTIFACT, not the checkout.
//
// 0.7.0 shipped a server.js requiring ./outbox.js while package.json's `files`
// whitelist omitted it. Every test passed, the repo was green, the plugin install
// worked (it installs from git) — and `npm i -g @sym-bot/mesh-channel` gave every
// user MODULE_NOT_FOUND at startup. The suite could not see it because every test
// runs against the working tree, where the file is trivially present.
//
// The artifact users receive is a DIFFERENT ARTIFACT from the one we test. This
// script closes that gap: npm pack → install the tarball into an empty directory
// → speak real MCP over stdio to the INSTALLED copy → exercise the three outbox
// cases. Anything less tests a file layout no user will ever have.
//
// Usage: node scripts/verify-packed-artifact.mjs

import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-channel-packgate-'));
let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.error(`  FAIL  ${m}`); failures++; };

console.log(`\nRelease gate — verifying the packed artifact in ${tmp}\n`);

// 1. Pack.
const tgzName = execFileSync('npm', ['pack', '--silent', '--pack-destination', tmp], {
  cwd: root, encoding: 'utf8',
}).trim().split('\n').pop();
const tgz = path.join(tmp, tgzName);
ok(`packed ${tgzName}`);

// 2. Install into an EMPTY directory — no working-tree files reachable.
const proj = path.join(tmp, 'consumer');
fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'c', version: '1.0.0' }));
execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', tgz], { cwd: proj, stdio: 'inherit' });
const installed = path.join(proj, 'node_modules', '@sym-bot', 'mesh-channel', 'server.js');
if (!fs.existsSync(installed)) { bad('server.js missing from the installed package'); process.exit(1); }
ok('installed into an empty consumer project');

// 3. Every local require of the INSTALLED server.js must resolve on disk.
const installedDir = path.dirname(installed);
const code = fs.readFileSync(installed, 'utf8');
for (const m of code.matchAll(/require\(\s*'(\.\/[^']+)'\s*\)/g)) {
  const rel = m[1].endsWith('.js') ? m[1] : `${m[1]}.js`;
  const target = path.join(installedDir, rel);
  if (fs.existsSync(target)) ok(`require('${m[1]}') resolves in the installed package`);
  else bad(`require('${m[1]}') is MISSING from the tarball — add it to package.json "files"`);
}

// 4. Speak real MCP to the installed copy and exercise the outbox contract.
const child = spawn(process.execPath, [installed], {
  env: { ...process.env, SYM_NODE_NAME: 'packgate-probe', SYM_ROOM: 'packgate-room' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
const responses = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { try { responses.push(JSON.parse(line)); } catch { /* not json */ } }
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packgate', version: '1' } } });
await wait(12000);

if (child.exitCode !== null) {
  bad(`the installed server EXITED before initialize (code ${child.exitCode}). stderr:\n${stderr.slice(0, 600)}`);
  process.exit(1);
}
if (responses.some((r) => r.id === 1 && r.result)) ok('MCP initialize succeeded against the installed package');
else bad(`no initialize response. stderr:\n${stderr.slice(0, 600)}`);

// Case A — unknown peer must be REFUSED, creating nothing.
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sym_send', arguments: { to: 'no-such-peer-packgate', focus: 'unknown must refuse' } } });
await wait(2500);
const a = responses.find((r) => r.id === 2)?.result?.content?.[0]?.text || '';
if (/never seen a peer by that name/i.test(a) && /nothing was queued/i.test(a)) ok('unknown peer is refused and nothing is queued');
else bad(`unknown-peer case wrong: ${a.slice(0, 160)}`);

// Case B — a peer this node HAS seen, while absent, must be HELD.
const outboxMod = path.join(installedDir, 'outbox.js');
if (fs.existsSync(outboxMod)) {
  const { rememberPeer } = await import(`file://${outboxMod}`);
  rememberPeer('packgate-probe', 'packgate-ghost', 'ghost-id');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sym_send', arguments: { to: 'packgate-ghost', focus: `held probe ${responses.length}` } } });
  await wait(2500);
  const b = responses.find((r) => r.id === 3)?.result?.content?.[0]?.text || '';
  if (/HELD AT SENDER/i.test(b) && /not delivered/i.test(b) && /packgate-ghost/.test(b)) {
    ok('known-but-absent peer is HELD, says not delivered, and names the peer');
  } else bad(`held case wrong: ${b.slice(0, 200)}`);
} else bad('outbox.js absent from the installed package — cannot verify the held case');

child.kill('SIGTERM');
fs.rmSync(path.join(os.homedir(), '.sym', 'nodes', 'packgate-probe'), { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\nRelease gate PASSED\n' : `\nRelease gate FAILED — ${failures} problem(s)\n`);
process.exit(failures === 0 ? 0 : 1);
