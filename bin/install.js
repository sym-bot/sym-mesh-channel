#!/usr/bin/env node
'use strict';

/**
 * sym-mesh-channel install — interactive setup for the MCP server.
 *
 * Run: npx @sym-bot/mesh-channel init
 *
 * What it does:
 *   1. Detects the platform and the host name suggestion (claude-mac /
 *      claude-win / claude-linux), or accepts an override.
 *   2. Resolves the absolute path to the installed server.js so Claude
 *      Code can spawn it.
 *   3. Reads ~/.claude.json (the Claude Code settings file), backs it
 *      up, adds an `mcpServers` entry under the current project for
 *      `claude-sym-mesh`, atomically writes the result.
 *   4. Prints the launch command including the Channels dev flag.
 *
 * Safety:
 *   - Backs up ~/.claude.json to ~/.claude.json.bak-<timestamp> before
 *     any write.
 *   - Validates JSON parses round-trip before writing.
 *   - Atomic via write-to-tmp + rename.
 *   - Refuses to overwrite an existing claude-sym-mesh entry without
 *     --force.
 *
 * Copyright (c) 2026 SYM.BOT Ltd. Apache 2.0 License.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const force = args.includes('--force');
const isPostinstall = args.includes('--postinstall');
const cmd = args.find((a) => !a.startsWith('--')) || 'init';

if (cmd !== 'init') {
  process.stderr.write(`Unknown command: ${cmd}\nUsage: npx @sym-bot/mesh-channel init [--force]\n`);
  process.exit(1);
}

// ── Detect platform & defaults ────────────────────────────────────

// Default: hostname-based identity, unique per machine. Prevents
// the ghost-peer bug where two machines with the same default name
// create phantom peers that absorb messages.
const defaultNodeName = `claude-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

// SYM_NODE_NAME from env wins over default
const nodeName = process.env.SYM_NODE_NAME || defaultNodeName;

// ── Resolve server.js path ────────────────────────────────────────

// Resolve server.js from the installed package location. require.resolve
// returns the actual installed path regardless of where postinstall runs
// from (npm on Windows may run postinstall from a temp staging directory).
let serverJsPath;
try {
  serverJsPath = require.resolve('@sym-bot/mesh-channel/server.js');
} catch {
  // Fallback for local development / cloned repo
  serverJsPath = path.resolve(__dirname, '..', 'server.js');
}
if (!fs.existsSync(serverJsPath)) {
  process.stderr.write(`ERROR: cannot find server.js at ${serverJsPath}\n`);
  process.stderr.write('This installer must be run from a published @sym-bot/mesh-channel package.\n');
  process.exit(1);
}

// ── Locate Claude Code settings file ──────────────────────────────

const claudeJsonPath = path.join(os.homedir(), '.claude.json');

if (!fs.existsSync(claudeJsonPath)) {
  if (isPostinstall) {
    // During postinstall, skip silently if Claude Code isn't installed yet
    console.log('sym-mesh-channel: ~/.claude.json not found — run `sym-mesh-channel init` after installing Claude Code.');
    process.exit(0);
  }
  process.stderr.write(`ERROR: ${claudeJsonPath} not found.\n`);
  process.stderr.write('Claude Code does not appear to be installed (or has not been launched yet).\n');
  process.stderr.write('Install Claude Code from https://claude.com/code first, launch it once, then re-run this installer.\n');
  process.exit(1);
}

// ── Read and back up ──────────────────────────────────────────────

let claudeJson;
try {
  const raw = fs.readFileSync(claudeJsonPath, 'utf8');
  claudeJson = JSON.parse(raw);
} catch (e) {
  process.stderr.write(`ERROR: ${claudeJsonPath} is not valid JSON: ${e.message}\n`);
  process.stderr.write('Refusing to overwrite a corrupt Claude Code settings file.\n');
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupPath = `${claudeJsonPath}.bak-${ts}`;
fs.copyFileSync(claudeJsonPath, backupPath);

// ── Find the MCP servers entry to insert into ───────────────────
// Write to global mcpServers (available in all Claude Code sessions),
// not project-scoped. A mesh node should be available everywhere.

if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

// ── Refuse to overwrite without --force ──────────────────────────

if (claudeJson.mcpServers['claude-sym-mesh'] && !force) {
  if (isPostinstall) {
    // During postinstall, silently skip if already configured
    console.log('sym-mesh-channel: already configured in ~/.claude.json (skipping)');
    process.exit(0);
  }
  process.stderr.write(`'claude-sym-mesh' is already configured in ~/.claude.json.\n`);
  process.stderr.write('Re-run with --force to overwrite, or remove the existing entry first.\n');
  process.exit(2);
}

// ── Build the entry ───────────────────────────────────────────────

const entry = {
  command: 'node',
  args: [serverJsPath],
  env: {
    SYM_NODE_NAME: nodeName,
    // Explicitly blank the relay vars so the MCP doesn't inherit them
    // from the parent shell (e.g. ~/.zshrc exports). Claude Code's env
    // block is ADDITIVE — omitting a key doesn't remove it from the
    // child process. Setting to '' makes process.env.SYM_RELAY_URL
    // falsy in JS, so the SymNode skips the relay and runs LAN-only.
    //
    // To enable cross-network connectivity later, replace these empty
    // values with your relay URL and token (see README).
    SYM_RELAY_URL: '',
    SYM_RELAY_TOKEN: '',
  },
};

claudeJson.mcpServers['claude-sym-mesh'] = entry;

// ── Atomic write ──────────────────────────────────────────────────

const serialized = JSON.stringify(claudeJson, null, 2);

// Validate round-trip parses
try {
  JSON.parse(serialized);
} catch (e) {
  process.stderr.write(`ERROR: serialization produced invalid JSON: ${e.message}\n`);
  process.stderr.write(`Backup is at ${backupPath} — your original file is unchanged.\n`);
  process.exit(1);
}

const tmpPath = `${claudeJsonPath}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tmpPath, serialized);
  fs.renameSync(tmpPath, claudeJsonPath);
} catch (e) {
  // EBUSY on Windows when Claude Code has ~/.claude.json locked
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    try { fs.unlinkSync(tmpPath); } catch {}
    if (isPostinstall) {
      console.log('sym-mesh-channel: ~/.claude.json is locked (Claude Code may be running).');
      console.log('Run `sym-mesh-channel init` after quitting Claude Code.');
      process.exit(0);
    }
    process.stderr.write(`ERROR: ${claudeJsonPath} is locked — Claude Code may be running.\n`);
    process.stderr.write('Quit Claude Code, then re-run: sym-mesh-channel init\n');
    process.stderr.write(`Backup is at ${backupPath}\n`);
    process.exit(1);
  }
  throw e;
}

// ── Print next steps ──────────────────────────────────────────────

const launchCmd = `claude --dangerously-load-development-channels server:claude-sym-mesh`;

console.log(`
✓ sym-mesh-channel configured globally in ~/.claude.json

  Node name:     ${nodeName}
  Server path:   ${serverJsPath}
  Backup:        ${backupPath}

Launch Claude Code with the Channels flag:

  ${launchCmd}

Inside Claude Code, verify:

  sym_status   →  node id, relay state, peer count
  sym_peers    →  discovered peers via Bonjour or relay
  sym_send "hello mesh"   →  broadcast to all peers
`);
