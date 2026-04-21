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
 * Copyright (c) 2026 SYM.BOT. Apache 2.0 License.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const force = args.includes('--force');
const isPostinstall = args.includes('--postinstall');
const isProject = args.includes('--project');
const cmd = args.find((a) => !a.startsWith('--')) || 'init';

if (cmd !== 'init') {
  process.stderr.write(`Unknown command: ${cmd}\nUsage: sym-mesh-channel init [--project] [--force]\n`);
  process.exit(1);
}

// --postinstall always runs global install (npm postinstall runs from
// npm's staging directory, not the user's project dir). If both flags
// are passed, the --project flag is ignored during postinstall.
const useProjectMode = isProject && !isPostinstall;

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

// Shared timestamp for backup filenames
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── Project-scoped install (--project flag) ───────────────────────
// Writes <cwd>/.mcp.json + merges <cwd>/.claude/settings.local.json
// instead of touching ~/.claude.json. Use this when you want multiple
// Claude Code sessions on one machine to appear as distinct mesh peers
// (one per project), each with its own SYM_NODE_NAME. Project-level
// .mcp.json overrides the global ~/.claude.json mcpServers entry when
// Claude Code is launched from that directory.

if (useProjectMode) {
  const projectDir = process.cwd();
  const mcpJsonPath = path.join(projectDir, '.mcp.json');
  const claudeDir = path.join(projectDir, '.claude');
  const settingsLocalPath = path.join(claudeDir, 'settings.local.json');

  // Read existing .mcp.json (if any)
  let mcpJson = null;
  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    } catch (e) {
      process.stderr.write(`ERROR: ${mcpJsonPath} is not valid JSON: ${e.message}\n`);
      process.stderr.write('Refusing to overwrite a corrupt file. Fix or remove it and retry.\n');
      process.exit(1);
    }
  }
  mcpJson = mcpJson || {};
  if (!mcpJson.mcpServers) mcpJson.mcpServers = {};

  // Refuse to overwrite an existing claude-sym-mesh entry without --force
  if (mcpJson.mcpServers['claude-sym-mesh'] && !force) {
    process.stderr.write(`'claude-sym-mesh' is already configured in ${mcpJsonPath}.\n`);
    process.stderr.write('Re-run with --force to overwrite, or remove the existing entry first.\n');
    process.exit(2);
  }

  // Build the MCP entry (identical shape to global mode)
  const projectEntry = {
    command: 'node',
    args: [serverJsPath],
    env: {
      SYM_NODE_NAME: nodeName,
      // Explicitly blank relay env vars — see comment on the global
      // install path below for why.
      SYM_RELAY_URL: '',
      SYM_RELAY_TOKEN: '',
    },
  };

  // Backup existing .mcp.json if present
  let mcpBackupPath = null;
  if (fs.existsSync(mcpJsonPath)) {
    mcpBackupPath = `${mcpJsonPath}.bak-${ts}`;
    fs.copyFileSync(mcpJsonPath, mcpBackupPath);
  }

  mcpJson.mcpServers['claude-sym-mesh'] = projectEntry;

  // Atomic write .mcp.json
  const mcpSerialized = JSON.stringify(mcpJson, null, 2) + '\n';
  try { JSON.parse(mcpSerialized); } catch (e) {
    process.stderr.write(`ERROR: serialization produced invalid JSON: ${e.message}\n`);
    process.exit(1);
  }
  const mcpTmpPath = `${mcpJsonPath}.tmp-${process.pid}`;
  fs.writeFileSync(mcpTmpPath, mcpSerialized);
  fs.renameSync(mcpTmpPath, mcpJsonPath);

  // Merge <projectDir>/.claude/settings.local.json. Claude Code gates
  // loading of project-scoped MCP servers on the enabledMcpjsonServers
  // allowlist in this file — without the merge, the .mcp.json we just
  // wrote would not actually be loaded.
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  let existingSettings = null;
  if (fs.existsSync(settingsLocalPath)) {
    try {
      existingSettings = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
    } catch (e) {
      process.stderr.write(`ERROR: ${settingsLocalPath} is not valid JSON: ${e.message}\n`);
      process.exit(1);
    }
  }

  // Snapshot serialized form BEFORE mutating so the change-detection
  // below can't be fooled by object aliasing (existingSettings and
  // settings point at the same object after the `|| {}`).
  const beforeSerialized = existingSettings ? JSON.stringify(existingSettings) : null;
  const settings = existingSettings || {};

  const enabled = new Set(Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : []);
  enabled.add('claude-sym-mesh');
  settings.enabledMcpjsonServers = Array.from(enabled);
  settings.enableAllProjectMcpServers = true;

  const afterSerialized = JSON.stringify(settings);
  const settingsChanged = beforeSerialized !== afterSerialized;

  let settingsBackupPath = null;
  if (settingsChanged) {
    if (existingSettings) {
      settingsBackupPath = `${settingsLocalPath}.bak-${ts}`;
      fs.copyFileSync(settingsLocalPath, settingsBackupPath);
    }
    const settingsSerialized = JSON.stringify(settings, null, 2) + '\n';
    const settingsTmpPath = `${settingsLocalPath}.tmp-${process.pid}`;
    fs.writeFileSync(settingsTmpPath, settingsSerialized);
    fs.renameSync(settingsTmpPath, settingsLocalPath);
  }

  // Print next steps
  const launchCmdProject = `claude --dangerously-load-development-channels server:claude-sym-mesh`;
  const lines = [
    '',
    `✓ sym-mesh-channel configured for project: ${projectDir}`,
    '',
    `  Node name:     ${nodeName}`,
    `  Server path:   ${serverJsPath}`,
    `  Wrote:         ${mcpJsonPath}`,
  ];
  if (mcpBackupPath) lines.push(`  Backup:        ${mcpBackupPath}`);
  if (settingsChanged) {
    lines.push(`  Updated:       ${settingsLocalPath}`);
    if (settingsBackupPath) lines.push(`  Backup:        ${settingsBackupPath}`);
  }
  lines.push(
    '',
    'Launch Claude Code from this directory:',
    '',
    `  ${launchCmdProject}`,
    '',
    'Project-level .mcp.json overrides the global ~/.claude.json entry',
    'when Claude Code runs from this directory. To give each project its',
    'own mesh identity, run `sym-mesh-channel init --project` from each',
    'project root with a distinct SYM_NODE_NAME.',
    '',
  );
  console.log(lines.join('\n'));
  process.exit(0);
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

// `ts` was defined above, shared with project-mode install
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
