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
const cmd = args.find((a) => !a.startsWith('--')) || 'init';

if (cmd !== 'init') {
  process.stderr.write(`Unknown command: ${cmd}\nUsage: npx @sym-bot/mesh-channel init [--force]\n`);
  process.exit(1);
}

// ── Detect platform & defaults ────────────────────────────────────

const platform = process.platform;
const platformSuffix = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
const defaultNodeName = `claude-${platformSuffix}`;

// SYM_NODE_NAME from env wins over default
const nodeName = process.env.SYM_NODE_NAME || defaultNodeName;

// ── Resolve server.js path ────────────────────────────────────────

// __dirname is .../node_modules/@sym-bot/mesh-channel/bin in npm install,
// or .../sym-mesh-channel/bin if running from a clone. server.js is one
// level up either way.
const serverJsPath = path.resolve(__dirname, '..', 'server.js');
if (!fs.existsSync(serverJsPath)) {
  process.stderr.write(`ERROR: cannot find server.js at ${serverJsPath}\n`);
  process.stderr.write('This installer must be run from a published @sym-bot/mesh-channel package.\n');
  process.exit(1);
}

// ── Locate Claude Code settings file ──────────────────────────────

const claudeJsonPath = path.join(os.homedir(), '.claude.json');

if (!fs.existsSync(claudeJsonPath)) {
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

// ── Find the project entry to insert into ────────────────────────

const projectDir = process.cwd();
if (!claudeJson.projects) claudeJson.projects = {};
if (!claudeJson.projects[projectDir]) {
  claudeJson.projects[projectDir] = {};
}
const project = claudeJson.projects[projectDir];
if (!project.mcpServers) project.mcpServers = {};

// ── Refuse to overwrite without --force ──────────────────────────

if (project.mcpServers['claude-sym-mesh'] && !force) {
  process.stderr.write(`'claude-sym-mesh' is already configured for this project (${projectDir}).\n`);
  process.stderr.write('Re-run with --force to overwrite, or remove the existing entry first.\n');
  process.exit(2);
}

// ── Build the entry ───────────────────────────────────────────────

const entry = {
  command: 'node',
  args: [serverJsPath],
  env: {
    SYM_NODE_NAME: nodeName,
    // Relay env vars are intentionally NOT set by default. Without
    // them, the SymNode runs in LAN-only mode and discovers other
    // peers via Bonjour mDNS. To enable cross-network connectivity,
    // add SYM_RELAY_URL and SYM_RELAY_TOKEN to this env block manually
    // (see README for details on running your own relay).
  },
};

project.mcpServers['claude-sym-mesh'] = entry;

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
fs.writeFileSync(tmpPath, serialized);
fs.renameSync(tmpPath, claudeJsonPath);

// ── Print next steps ──────────────────────────────────────────────

const launchCmd = `claude --dangerously-load-development-channels server:claude-sym-mesh`;

console.log(`
✓ sym-mesh-channel installed for project: ${projectDir}

  Node name:     ${nodeName}
  Server path:   ${serverJsPath}
  Backup:        ${backupPath}

Next steps:

  1. Launch Claude Code from this directory with the Channels flag:

     ${launchCmd}

     The flag is required because this MCP server is not yet on
     Anthropic's public Channels allowlist. Without the flag, the
     MCP loads but inbound real-time push notifications are silently
     dropped.

  2. Inside Claude Code, verify the mesh is up:

       sym_status   →  shows your node id, relay state, peer count
       sym_peers    →  lists discovered peers via Bonjour or relay

  3. Have a friend on the same wifi run the same install with a
     different SYM_NODE_NAME (e.g. claude-mac vs claude-win). Within
     a few seconds you should see each other in sym_peers.

  4. Send a message:

       sym_send "hello mesh"

     The other peer should see it land in their Claude Code context
     as a real-time channel notification — no polling.

LAN-only mode is the default. To connect across networks, add
SYM_RELAY_URL and SYM_RELAY_TOKEN to the env block in
${claudeJsonPath} (see README for relay setup).
`);
