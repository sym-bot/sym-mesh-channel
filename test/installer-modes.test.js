'use strict';

// R4-4: the installer never leaves a config file more readable than it was. ~/.claude.json carries the
// relay token (SYM_RELAY_TOKEN); 0.11.0 rewrote it through a tmp file made with the default mode, so a
// 0600 file came back 0644, readable by every account on the machine. Every write site is checked here,
// in a sandbox home only: ~/.claude.json and its backup, a project's .mcp.json and
// .claude/settings.local.json, and the folder's .sym/node.json.

const h = require('./_harness.js'); // sandbox first
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanEnv } = require('./_clean-env.js');

const SERVER = path.join(__dirname, '..', 'server.js');
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
const TOKEN = 'TOPSECRET-relay-token-0123456789abcdef';

function run(args, { home, cwd }) {
  process.umask(0o022);   // the usual umask: a file made with the default mode is 0644
  // `start` launches Claude Code at the end: a stand-in that exits at once.
  const bin = fs.mkdtempSync(path.join(home, 'bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = cleanEnv({ HOME: home, USERPROFILE: home, SYM_STATE_DIR: path.join(home, '.sym'), PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const r = spawnSync(process.execPath, [SERVER, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, `installer exited ${r.status}: ${r.stderr}`);
  return r;
}

test('R4-4: ~/.claude.json keeps its owner-only mode and its relay token; the backup is owner-only too', () => {
  const home = h.stateDir('home');
  const cj = path.join(home, '.claude.json');
  fs.writeFileSync(cj, JSON.stringify({ mcpServers: { 'claude-sym-mesh': { command: 'node', args: [SERVER], env: { SYM_NODE_NAME: 'x', SYM_RELAY_URL: 'ws://127.0.0.1:9', SYM_RELAY_TOKEN: TOKEN } } } }, null, 2), { mode: 0o600 });
  fs.chmodSync(cj, 0o600);
  run(['init', '--no-pin', '--force'], { home, cwd: home });
  assert.ok(fs.readFileSync(cj, 'utf8').includes(TOKEN), 'the token is kept');
  assert.strictEqual(mode(cj), '600', 'the file is still owner-only');
  const backups = fs.readdirSync(home).filter((f) => f.startsWith('.claude.json.bak-'));
  assert.ok(backups.length >= 1, 'a backup was made');
  for (const b of backups) assert.strictEqual(mode(path.join(home, b)), '600', `${b} holds the token too`);
  assert.ok(!fs.readdirSync(home).some((f) => f.includes('.tmp-')), 'no tmp file is left behind');
});

test('R4-4: a ~/.claude.json the installer writes a token into is made owner-only even when it was not', () => {
  const home = h.stateDir('home');
  const cj = path.join(home, '.claude.json');
  fs.writeFileSync(cj, JSON.stringify({ projects: {} }, null, 2));
  fs.chmodSync(cj, 0o644);
  run(['init', '--no-pin', '--force'], { home, cwd: home });
  assert.strictEqual(mode(cj), '600');
});

test('R4-4: a project\'s .mcp.json, settings.local.json and .sym/node.json keep the mode they had', () => {
  const home = h.stateDir('home');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n', { mode: 0o600 });
  const proj = fs.mkdtempSync(path.join(home, 'proj-'));
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.mkdirSync(path.join(proj, '.sym'));
  const mcp = path.join(proj, '.mcp.json');
  const settings = path.join(proj, '.claude', 'settings.local.json');
  const nodeJson = path.join(proj, '.sym', 'node.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { other: { command: 'x', env: { API_KEY: 'another-secret' } } } }));
  fs.writeFileSync(settings, JSON.stringify({ permissions: {} }));
  fs.writeFileSync(nodeJson, JSON.stringify({ room: 'old-room' }));
  for (const f of [mcp, settings, nodeJson]) fs.chmodSync(f, 0o600);
  run(['init', '--project', '--room', 'team-r44', '--force'], { home, cwd: proj });
  assert.ok(JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers['claude-sym-mesh'], 'the entry was written');
  for (const f of [mcp, settings]) assert.strictEqual(mode(f), '600', `${path.basename(f)} kept 0600`);
  // `start` writes the folder's .sym/node.json and turns the plugin off in settings.local.json.
  run(['start', '--room', 'team-r44'], { home, cwd: proj });
  assert.strictEqual(JSON.parse(fs.readFileSync(nodeJson, 'utf8')).room, 'team-r44', 'node.json was rewritten');
  assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).enabledPlugins, 'settings.local.json was rewritten');
  for (const f of [mcp, settings, nodeJson]) assert.strictEqual(mode(f), '600', `${path.basename(f)} kept 0600`);
  assert.strictEqual(mode(path.join(home, '.claude.json')), '600');
  for (const f of fs.readdirSync(proj).filter((x) => x.startsWith('.mcp.json.bak-'))) assert.strictEqual(mode(path.join(proj, f)), '600', `${f} kept 0600`);
  // A file that was 0644 stays 0644: the installer narrows only what carries a secret it writes.
  fs.chmodSync(settings, 0o644);
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: [] } }));
  run(['init', '--project', '--room', 'team-r44b', '--force'], { home, cwd: proj });
  assert.strictEqual(mode(settings), '644');
});
