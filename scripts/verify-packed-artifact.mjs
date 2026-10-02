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

// 0. A published package cannot depend on a path on the publisher's disk. 0.11.0 was developed
//    against a tarball of the unpublished sym 0.14 worktree; the release depends on ^0.14.0 from npm.
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const local = Object.entries(pkgJson.dependencies || {}).filter(([, v]) => /^(file|link):/.test(String(v)));
if (local.length) {
  bad(`package.json depends on a local path: ${local.map(([k, v]) => `${k}@${v}`).join(', ')}. Switch to the published version (e.g. "@sym-bot/sym": "^0.14.0") and regenerate the lockfile.`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
ok('no dependency is a local path');

// Everything below runs in a sandboxed home and state root: the gate must never write an identity
// or a store into the operator's real ~/.sym.
const sandbox = path.join(tmp, 'home');
fs.mkdirSync(path.join(sandbox, '.sym'), { recursive: true });
const sandboxEnv = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, SYM_STATE_DIR: path.join(sandbox, '.sym') };

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
execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', tgz], { cwd: proj, stdio: 'inherit', env: sandboxEnv });
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

// 4. Speak real MCP to the installed copy and exercise the outbox contract (by nodeId, design D6).
const child = spawn(process.execPath, [installed], {
  env: { ...sandboxEnv, SYM_NODE_NAME: 'packgate-probe', SYM_ROOM: 'packgate-room', SYM_LAN: 'off', SYM_RELAY_URL: '', SYM_RELAY_TOKEN: '' },
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
const answer = async (id, ms = 5000) => { for (let t = 0; t < ms; t += 100) { const r = responses.find((x) => x.id === id); if (r) return r; await wait(100); } return null; };

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packgate', version: '1' } } });
const init = await answer(1, 15000);
if (child.exitCode !== null || !init || !init.result) {
  bad(`no initialize response from the installed server. stderr:\n${stderr.slice(0, 600)}`);
  child.kill('SIGTERM');
  process.exit(1);
}
ok('MCP initialize succeeded against the installed package');
const nodeId = (String(init.result.instructions || '').match(/nodeId ([0-9a-f-]{36})/) || [])[1];
const text = (r) => r?.result?.content?.[0]?.text || '';

// Case A — a name is never a route; an unknown nodeId is refused, and nothing is queued.
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sym_send', arguments: { to: 'no-such-peer-packgate', focus: 'a name must refuse' } } });
const a = text(await answer(2));
if (/never a name/.test(a)) ok('a name is refused as a route'); else bad(`name case wrong: ${a.slice(0, 160)}`);
const ghost = '01a0fd15-0000-7000-8000-00000000beef';
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sym_send', arguments: { to: ghost, focus: 'unknown must refuse' } } });
const b = text(await answer(3));
if (/never had one with it/.test(b) && /nothing was queued/.test(b)) ok('an unknown nodeId is refused and nothing is queued');
else bad(`unknown-nodeId case wrong: ${b.slice(0, 160)}`);

// Case B — a nodeId this node HAS had a session with, while absent, must be HELD.
try {
  const { createRequire } = await import('node:module');
  const req = createRequire(installed);
  const sdk = req('@sym-bot/sym');
  const { createOutbox } = req('./outbox.js');
  createOutbox(sdk.identity.nodeDirById(nodeId)).rememberPeer(ghost, 'packgate-ghost');
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sym_send', arguments: { to: ghost, focus: `held probe ${Date.now()}` } } });
  const c = text(await answer(4));
  if (/HELD AT SENDER/.test(c) && /not delivered/.test(c)) ok('a known-but-absent nodeId is HELD and says not delivered');
  else bad(`held case wrong: ${c.slice(0, 200)}`);
} catch (e) { bad(`could not exercise the held case: ${e.message}`); }

child.kill('SIGTERM');
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\nRelease gate PASSED\n' : `\nRelease gate FAILED — ${failures} problem(s)\n`);
process.exit(failures === 0 ? 0 : 1);
