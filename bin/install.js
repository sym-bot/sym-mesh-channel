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
 *   - Refuses to overwrite a LIVE claude-sym-mesh entry without --force.
 *     An entry whose args[0] server.js path no longer exists on disk is
 *     treated as STALE and rewritten in place — a stale entry guarantees
 *     a broken MCP transport, so "preserving" it is never what the user
 *     wants. SYM_NODE_NAME from the stale entry is preserved so the
 *     mesh identity doesn't drift to the hostname-based default.
 *   - Also scans every project-scoped mcpServers entry and rewrites any
 *     project entry whose claude-sym-mesh.args[0] path has gone stale,
 *     again preserving each project's SYM_NODE_NAME. This prevents the
 *     "ghost project" failure mode where user-global was fixed but
 *     project-scoped entries silently continue to point at the old path.
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

// --group <name>: persist a SYM_GROUP env entry into the written .mcp.json /
// ~/.claude.json so the node joins that group on every Claude Code launch.
// Without this flag, the env block omits SYM_GROUP and the node falls back
// to the default _sym._tcp mesh on startup. Runtime sym_join_group hot-swaps
// only last for the current session — without persistence, peers in named
// groups silently revert to default and become invisible to teammates.
const groupArgIdx = args.indexOf('--group');
const groupArg = groupArgIdx !== -1 ? args[groupArgIdx + 1] : null;

if (cmd !== 'init' && cmd !== 'doctor') {
  process.stderr.write(`Unknown command: ${cmd}\nUsage: sym-mesh-channel init [--project] [--force] [--group <name>]\n       sym-mesh-channel doctor\n`);
  process.exit(1);
}

const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
if (groupArg && !KEBAB_CASE_RE.test(groupArg) && groupArg !== 'default') {
  process.stderr.write(`ERROR: --group "${groupArg}" must be kebab-case (e.g. backend-team) or "default".\n`);
  process.exit(1);
}

// ── isStaleEntry: a claude-sym-mesh entry whose server.js path is gone ──
// Returns true when the entry exists but its args[0] path does not resolve
// to a file on disk. Such an entry can never spawn the MCP server — every
// launch yields "Failed to reconnect" in /mcp. Treating it as rewritable
// on postinstall means users who move or uninstall an old copy of the repo
// get healed automatically on the next `npm install -g @sym-bot/mesh-channel`
// without needing to know about --force.
function isStaleEntry(entry) {
  if (!entry || !Array.isArray(entry.args) || entry.args.length === 0) return false;
  const p = entry.args[0];
  if (typeof p !== 'string' || !p) return false;
  try { return !fs.existsSync(p); } catch { return true; }
}

// preserveNodeName: return the SYM_NODE_NAME from an existing entry's env
// so rewrites keep the mesh identity. Falls back to nothing if absent; the
// caller then uses the computed default.
function preserveNodeName(entry) {
  if (!entry || !entry.env || typeof entry.env.SYM_NODE_NAME !== 'string') return null;
  const n = entry.env.SYM_NODE_NAME.trim();
  return n || null;
}

// preserveGroup: return the SYM_GROUP from an existing entry's env so
// rewrites keep the mesh group. Same shape as preserveNodeName — without
// this, healing a stale entry would drop a previously-persisted group
// and silently downgrade the node to the default _sym._tcp mesh,
// stranding teammates who stay in the named group.
function preserveGroup(entry) {
  if (!entry || !entry.env || typeof entry.env.SYM_GROUP !== 'string') return null;
  const g = entry.env.SYM_GROUP.trim();
  return g || null;
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

// Resolution order for the new install's SYM_GROUP value:
//   1. --group <name> CLI flag
//   2. SYM_GROUP env var
//   3. nothing (env block omits SYM_GROUP; node uses default _sym._tcp)
// The "preserve from existing entry" path is handled separately below
// per scope, so a re-install/heal never silently drops a configured group.
const groupName = (groupArg && groupArg !== 'default') ? groupArg
                : (process.env.SYM_GROUP && process.env.SYM_GROUP !== 'default') ? process.env.SYM_GROUP
                : null;

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

  // Refuse to overwrite a LIVE claude-sym-mesh entry without --force.
  // Stale entries (args[0] missing on disk) are always rewritable —
  // see isStaleEntry comment above.
  const existingProjectEntry = mcpJson.mcpServers['claude-sym-mesh'];
  const projectEntryIsStale = isStaleEntry(existingProjectEntry);
  if (existingProjectEntry && !force && !projectEntryIsStale) {
    process.stderr.write(`'claude-sym-mesh' is already configured in ${mcpJsonPath}.\n`);
    process.stderr.write('Re-run with --force to overwrite, or remove the existing entry first.\n');
    process.exit(2);
  }

  // Preserve the prior node name on rewrite so mesh identity doesn't drift
  // back to the hostname default on every reinstall.
  const projectNodeName = preserveNodeName(existingProjectEntry) || nodeName;

  // Group resolution priority for project-mode rewrite:
  //   1. existing entry's SYM_GROUP (preserve across reinstalls/heals)
  //   2. --group flag or SYM_GROUP env (user-provided this run)
  //   3. nothing (omit SYM_GROUP; node falls back to default _sym._tcp)
  const projectGroup = preserveGroup(existingProjectEntry) || groupName;

  // Build the MCP entry (identical shape to global mode)
  const projectEntry = {
    command: 'node',
    args: [serverJsPath],
    env: {
      SYM_NODE_NAME: projectNodeName,
      // Explicitly blank relay env vars — see comment on the global
      // install path below for why.
      SYM_RELAY_URL: '',
      SYM_RELAY_TOKEN: '',
    },
  };
  // SYM_GROUP is only written when explicitly set. Omitting it (rather than
  // writing an empty string) keeps the JSON file minimal for the common
  // single-team case AND avoids the "default group accidentally pinned"
  // failure mode where a blank value masks the server.js fallback.
  if (projectGroup) projectEntry.env.SYM_GROUP = projectGroup;

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
    `  Node name:     ${projectNodeName}${projectEntryIsStale ? ' (preserved from stale entry)' : ''}`,
    `  Mesh group:    ${projectGroup || 'default (global _sym._tcp mesh)'}`,
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

// ── doctor: report-only scan, no writes ──────────────────────────
// Surface every claude-sym-mesh entry (user-global + every project-scope)
// with whether its server.js is reachable and what node name it uses.
// Useful when /mcp reports "Failed to reconnect" and the user wants to
// inspect scope conflicts without mutating state.

if (cmd === 'doctor') {
  const rows = [];
  const topEntry = claudeJson.mcpServers['claude-sym-mesh'];
  if (topEntry) {
    rows.push({
      scope: 'user-global',
      path: (topEntry.args || [])[0] || '(no path)',
      node: preserveNodeName(topEntry) || '(no SYM_NODE_NAME)',
      group: preserveGroup(topEntry) || 'default',
      live: !isStaleEntry(topEntry),
    });
  }
  const projects = claudeJson.projects && typeof claudeJson.projects === 'object' ? claudeJson.projects : {};
  for (const [projPath, proj] of Object.entries(projects)) {
    const e = proj && proj.mcpServers && proj.mcpServers['claude-sym-mesh'];
    if (!e) continue;
    rows.push({
      scope: `project ${projPath}`,
      path: (e.args || [])[0] || '(no path)',
      node: preserveNodeName(e) || '(no SYM_NODE_NAME)',
      group: preserveGroup(e) || 'default',
      live: !isStaleEntry(e),
    });
  }
  if (rows.length === 0) {
    console.log('No claude-sym-mesh entries found in ~/.claude.json.');
    console.log('Run `sym-mesh-channel init` to configure.');
    process.exit(0);
  }
  console.log('');
  console.log('claude-sym-mesh entries in ~/.claude.json:');
  console.log('');
  for (const r of rows) {
    console.log(`  [${r.live ? 'live ' : 'STALE'}] ${r.scope}`);
    console.log(`           node:  ${r.node}`);
    console.log(`           group: ${r.group}`);
    console.log(`           path:  ${r.path}`);
  }
  const staleCount = rows.filter((r) => !r.live).length;

  // Heuristic: if multiple entries reference the same Claude identity
  // (same machine) but disagree on group, peers will see each other as
  // disconnected — same incident pattern that cost ~24h of duplex outage
  // at SYM.BOT (CMO=default vs COO=sym-bot-team, 2026-05-02). Surface as
  // a warning so users can spot the mismatch before reaching for the
  // troubleshooting section.
  const groups = new Set(rows.map((r) => r.group));
  const groupMismatch = rows.length > 1 && groups.size > 1;

  console.log('');
  if (staleCount > 0) {
    console.log(`${staleCount} stale entr${staleCount === 1 ? 'y' : 'ies'} — run \`sym-mesh-channel init\` to heal.`);
  } else {
    console.log('All entries are live.');
  }
  if (groupMismatch) {
    console.log('');
    console.log(`⚠ Group mismatch across entries: ${Array.from(groups).join(', ')}.`);
    console.log('  Nodes in different groups cannot discover each other on Bonjour.');
    console.log('  If teammates expect to see each other, align the SYM_GROUP env var.');
    console.log('  See README "Team mesh groups → Persisting your group across restarts".');
  }
  process.exit(0);
}

// ── Classify the top-level entry ─────────────────────────────────

const existingTopEntry = claudeJson.mcpServers['claude-sym-mesh'];
const topEntryIsStale = isStaleEntry(existingTopEntry);

// Refuse to overwrite a LIVE entry without --force. A stale entry is
// always rewritable — see isStaleEntry comment at top of file.
if (existingTopEntry && !force && !topEntryIsStale) {
  if (isPostinstall) {
    // During postinstall, silently skip if already configured and live
    console.log('sym-mesh-channel: already configured in ~/.claude.json (skipping)');
    process.exit(0);
  }
  process.stderr.write(`'claude-sym-mesh' is already configured in ~/.claude.json.\n`);
  process.stderr.write('Re-run with --force to overwrite, or remove the existing entry first.\n');
  process.exit(2);
}

// Preserve the prior node name on rewrite so mesh identity doesn't drift.
const topNodeName = preserveNodeName(existingTopEntry) || nodeName;

// Preserve a previously-persisted SYM_GROUP across reinstalls/heals.
// Without this, healing a stale entry would silently drop the configured
// group and downgrade the node to the default _sym._tcp mesh — peers in
// the named group would no longer see this node, and the user would have
// no diagnostic signal beyond "they vanished from sym_peers".
const topGroup = preserveGroup(existingTopEntry) || groupName;

// ── Build the entry ───────────────────────────────────────────────

const entry = {
  command: 'node',
  args: [serverJsPath],
  env: {
    SYM_NODE_NAME: topNodeName,
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
// SYM_GROUP only emitted when explicitly chosen — see project-mode comment
// for the rationale. Omitted = node uses the global _sym._tcp default.
if (topGroup) entry.env.SYM_GROUP = topGroup;

claudeJson.mcpServers['claude-sym-mesh'] = entry;

// ── Heal stale project-scoped entries ─────────────────────────────
// ~/.claude.json can contain per-project mcpServers overrides under
// claudeJson.projects[<path>].mcpServers. Claude Code prefers project-scoped
// over user-global when launched from that directory, so a stale project
// entry silently shadows a fresh user-global heal. Scan every project,
// rewrite any claude-sym-mesh entry whose args[0] is missing on disk,
// preserving the project's SYM_NODE_NAME.

const healedProjects = [];
const projects = claudeJson.projects && typeof claudeJson.projects === 'object' ? claudeJson.projects : {};
for (const [projPath, proj] of Object.entries(projects)) {
  const projEntry = proj && proj.mcpServers && proj.mcpServers['claude-sym-mesh'];
  if (!projEntry) continue;
  if (!isStaleEntry(projEntry)) continue;
  const projNodeName = preserveNodeName(projEntry) || nodeName;
  // Preserve SYM_GROUP on stale-heal — same reason as preserveNodeName.
  // The user explicitly chose this group at some prior install; healing a
  // path issue must not silently revert their group membership.
  const projGroupName = preserveGroup(projEntry);
  const healedEntry = {
    command: 'node',
    args: [serverJsPath],
    env: {
      SYM_NODE_NAME: projNodeName,
      SYM_RELAY_URL: projEntry.env && typeof projEntry.env.SYM_RELAY_URL === 'string' ? projEntry.env.SYM_RELAY_URL : '',
      SYM_RELAY_TOKEN: projEntry.env && typeof projEntry.env.SYM_RELAY_TOKEN === 'string' ? projEntry.env.SYM_RELAY_TOKEN : '',
    },
  };
  if (projGroupName) healedEntry.env.SYM_GROUP = projGroupName;
  proj.mcpServers['claude-sym-mesh'] = healedEntry;
  healedProjects.push({ path: projPath, node: projNodeName, group: projGroupName });
}

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

const healedLines = healedProjects.length
  ? '\n  Healed stale project-scoped entries (now pointing at fresh server.js):\n' +
    healedProjects.map((p) => `    • ${p.path}  (node: ${p.node}${p.group ? `, group: ${p.group}` : ''})`).join('\n') + '\n'
  : '';

const nodeNameSuffix = topEntryIsStale ? ' (preserved from stale entry)' : '';

console.log(`
✓ sym-mesh-channel configured globally in ~/.claude.json

  Node name:     ${topNodeName}${nodeNameSuffix}
  Mesh group:    ${topGroup || 'default (global _sym._tcp mesh)'}
  Server path:   ${serverJsPath}
  Backup:        ${backupPath}
${healedLines}
Launch Claude Code with the Channels flag:

  ${launchCmd}

Inside Claude Code, verify:

  sym_status   →  node id, relay state, peer count
  sym_peers    →  discovered peers via Bonjour or relay
  sym_send "hello mesh"   →  broadcast to all peers

Troubleshoot a broken install with:

  sym-mesh-channel doctor
`);
