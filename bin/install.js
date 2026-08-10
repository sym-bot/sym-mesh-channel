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

// --room <name>: persist a SYM_ROOM env entry into the written .mcp.json /
// ~/.claude.json so the node joins that room on every Claude Code launch.
// Without this flag, the env block omits SYM_ROOM and the node falls back
// to the default _sym._tcp mesh on startup. Runtime sym_join_room hot-swaps
// only last for the current session — without persistence, peers in named
// rooms silently revert to default and become invisible to teammates.
const roomArgIdx = args.indexOf('--room');
const roomArg = roomArgIdx !== -1 ? args[roomArgIdx + 1] : null;

if (cmd !== 'init' && cmd !== 'doctor' && cmd !== 'start') {
  process.stderr.write(`Unknown command: ${cmd}\nUsage: sym-mesh-channel start [--project] [--name <node>] [--room <name>] [-- <claude args>]\n       sym-mesh-channel init [--project] [--force] [--room <name>]\n       sym-mesh-channel doctor\n`);
  process.exit(1);
}

// One-time bulk store migration (meshmem/ → cmbs/) for all non-live nodes, run
// on install so readers use the cmbs/ name with no fallback. Idempotent.
try {
  const n = require('@sym-bot/sym').migrateStores();
  if (n) process.stderr.write(`[sym-mesh-channel] migrated ${n} node store(s): meshmem → cmbs\n`);
} catch { /* SDK not resolvable or nothing to do — non-fatal */ }

const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validateRoomValue(value, source) {
  if (!value) return;
  if (value === 'default') return;
  if (!KEBAB_CASE_RE.test(value)) {
    process.stderr.write(`ERROR: ${source} "${value}" must be kebab-case (e.g. backend-team) or "default".\n`);
    process.exit(1);
  }
}
validateRoomValue(roomArg, '--room');
// Apply the same gate to the env-var path. Pre-0.3.4-followup, a malformed
// SYM_ROOM=' ' or SYM_ROOM=Backend_Team value flowed through unvalidated
// and got written into the .mcp.json env block as-is, producing an mDNS
// service type the SymNode would silently fail to register on. Now both
// inputs share the validator with the same error message shape.
validateRoomValue(process.env.SYM_ROOM, 'SYM_ROOM');

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

// preserveRoom: return the SYM_ROOM from an existing entry's env so
// rewrites keep the mesh room. Same shape as preserveNodeName — without
// this, healing a stale entry would drop a previously-persisted room
// and silently downgrade the node to the default _sym._tcp mesh,
// stranding teammates who stay in the named room.
function preserveRoom(entry) {
  if (!entry || !entry.env || typeof entry.env.SYM_ROOM !== 'string') return null;
  const g = entry.env.SYM_ROOM.trim();
  return g || null;
}

// ── start: one command to a live mesh session ─────────────────────
// `sym-mesh-channel start` configures the MCP server (only if needed)
// and then launches Claude Code with the real-time Channels flag
// already on — so the user never types `--dangerously-load-development-
// channels …` or has to choose between the plugin: and server: handle.
// The npx / MCP-server install path always exposes the channel as a raw
// server, so the handle is deterministically `server:claude-sym-mesh`.
//
//   sym-mesh-channel start                       # this dir, real-time push on
//   sym-mesh-channel start --project --name cto --room my-team
//   sym-mesh-channel start --print               # show the command, don't launch
//   sym-mesh-channel start -- --resume           # pass args through to claude
//
// Co-resident sessions sharing one config don't collide: server.js
// auto-suffixes a live-identity clash (since 0.3.10), so each session
// becomes its own peer.
if (cmd === 'start') {
  const { spawnSync } = require('child_process');

  const nameArgIdx = args.indexOf('--name');
  const nameArg = nameArgIdx !== -1 ? args[nameArgIdx + 1] : null;
  const printOnly = args.includes('--print') || args.includes('--dry-run');

  // Everything after `--` is forwarded verbatim to `claude`.
  const dashDash = args.indexOf('--');
  const passthrough = dashDash !== -1 ? args.slice(dashDash + 1) : [];

  const launchDir = process.cwd();

  const handle = 'server:claude-sym-mesh';
  const claudeArgs = ['--dangerously-load-development-channels', handle, ...passthrough];

  // --print is a pure dry-run: show the launch command, change nothing.
  if (printOnly) {
    console.log(`claude ${claudeArgs.join(' ')}`);
    process.exit(0);
  }

  // Is the scope Claude Code will actually read already configured with a
  // LIVE entry?  --project → <cwd>/.mcp.json ; otherwise → ~/.claude.json
  // Reconcile identity against the persisted entry whether or not its
  // server.js path is stale. npx rotates the cached server.js path on every
  // version resolve (…/_npx/<hash>/…), so the entry is routinely stale yet
  // still carries the node's name/room. Comparing only against a *live*
  // entry let an explicit --name lose to the stale name on the heal path:
  // start saw no live entry, pushed no --force, and init's non-force
  // precedence (preserve-over-request) kept the old identity.
  function rawEntryInScope() {
    try {
      const p = isProject
        ? path.join(launchDir, '.mcp.json')
        : path.join(os.homedir(), '.claude.json');
      if (!fs.existsSync(p)) return null;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (j && j.mcpServers && j.mcpServers['claude-sym-mesh']) || null;
    } catch { return null; }
  }

  const existing = rawEntryInScope();
  const stale = existing ? isStaleEntry(existing) : false;
  const wantName = nameArg || null;
  const wantRoom = roomArg || null;
  const mismatch = !!existing && (
    (wantName && preserveNodeName(existing) !== wantName) ||
    (wantRoom && (preserveRoom(existing) || 'default') !== wantRoom)
  );

  // Configure when there's nothing persisted yet, the persisted server.js
  // path is stale (heal), an explicit --name/--room differs, or --force.
  // Otherwise launch straight away — `start` stays cheap to run every
  // session.
  if (!existing || stale || mismatch || force) {
    const initArgs = ['init'];
    if (isProject) initArgs.push('--project');
    if (roomArg) initArgs.push('--room', roomArg);
    // --force makes init honor the explicit --name/--room over the
    // persisted value. Required on the rename path AND on stale-heal with
    // an explicit --name, where init would otherwise preserve the old name
    // and silently drop the request. Force alone never clobbers an
    // unspecified room: resolveRoom() still preserves when no --room.
    if (existing && (mismatch || force)) initArgs.push('--force');
    const childEnv = Object.assign({}, process.env);
    if (nameArg) childEnv.SYM_NODE_NAME = nameArg;
    const r = spawnSync(process.execPath, [__filename, ...initArgs], {
      stdio: 'inherit', env: childEnv, cwd: launchDir,
    });
    if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);
  }

  console.log(`\n▶ Launching Claude Code on the SYM mesh — real-time push on.\n  (channel: ${handle}; the dev flag is temporary until Anthropic allowlists it)\n`);
  // On Windows the `claude` CLI is a `.cmd`/`.ps1` shim (npm) or `.exe`
  // (native installer). Node's spawn does an exact-filename lookup that
  // ignores PATHEXT, so bare `spawnSync('claude', …)` returns ENOENT even
  // when `claude` runs fine in the user's shell. Route through a shell on
  // Windows so PATHEXT resolution kicks in; quote args that contain spaces
  // since shell:true forwards the args unquoted.
  const isWindows = process.platform === 'win32';
  const spawnArgs = isWindows
    ? claudeArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a))
    : claudeArgs;
  const run = spawnSync('claude', spawnArgs, { stdio: 'inherit', cwd: launchDir, shell: isWindows });
  if (run.error && run.error.code === 'ENOENT') {
    process.stderr.write('ERROR: `claude` was not found on your PATH.\n');
    process.stderr.write('Install Claude Code (https://claude.com/code), make sure `claude` runs in your terminal, then re-run `sym-mesh-channel start`.\n');
    process.exit(127);
  }
  process.exit(run.status == null ? 0 : run.status);
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

// Capture the user's *explicit* room intent for this install, distinct
// from "user didn't ask, use existing or default":
//   null            → user didn't pass --room or SYM_ROOM
//   'default'       → user explicitly wants the global _sym._tcp mesh
//                     (escape hatch: revert from a named room, with --force)
//   '<kebab-name>'  → user explicitly wants this named room
const explicitRoom = roomArg !== null ? roomArg
                    : (process.env.SYM_ROOM || null);

// resolveRoom: per-scope room resolution that respects both the user's
// explicit intent AND the existing entry's persisted state.
//
//   With --force AND an explicit value: flag/env wins. The user is
//     deliberately overriding state. `--force --room new-team` switches
//     rooms; `--force --room default` reverts to the global mesh.
//
//   Without --force, OR with --force but no explicit value: preserve
//     from the existing entry (heal-path job is to NOT lose user state).
//     Falls back to the explicit value, then to none.
//
// Returns the SYM_ROOM value to write, or null to omit the key entirely
// (which the caller maps to "leave SYM_ROOM out of the env block, node
// uses default _sym._tcp on launch").
function resolveRoom(existingEntry) {
  const preserved = preserveRoom(existingEntry);
  if (force && explicitRoom !== null) {
    return explicitRoom === 'default' ? null : explicitRoom;
  }
  if (preserved) return preserved;
  if (explicitRoom && explicitRoom !== 'default') return explicitRoom;
  return null;
}

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

  // --force + an explicit SYM_NODE_NAME deliberately relabels this entry
  // (symmetric with resolveRoom). Otherwise preserve the prior name so the
  // mesh identity doesn't drift back to the hostname default on a reinstall.
  const projectNodeName = (force && process.env.SYM_NODE_NAME)
    ? process.env.SYM_NODE_NAME
    : (preserveNodeName(existingProjectEntry) || nodeName);

  // Room resolution priority — see resolveRoom() at top of file.
  // Summary: --force + explicit flag/env wins; otherwise preserve, then
  // explicit, then omit. `--room default` with --force = revert to mesh.
  const projectRoom = resolveRoom(existingProjectEntry);

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
  // SYM_ROOM is only written when explicitly set. Omitting it (rather than
  // writing an empty string) keeps the JSON file minimal for the common
  // single-team case AND avoids the "default room accidentally pinned"
  // failure mode where a blank value masks the server.js fallback.
  if (projectRoom) projectEntry.env.SYM_ROOM = projectRoom;

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
    `  Mesh room:    ${projectRoom || 'default (global _sym._tcp mesh)'}`,
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
      room: preserveRoom(topEntry) || 'default',
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
      room: preserveRoom(e) || 'default',
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
    console.log(`           room: ${r.room}`);
    console.log(`           path:  ${r.path}`);
  }
  const staleCount = rows.filter((r) => !r.live).length;

  // Heuristic: if multiple entries reference the same Claude identity
  // (same machine) but disagree on room, peers will see each other as
  // disconnected — same incident pattern that cost ~24h of duplex outage
  // at SYM.BOT (CMO=default vs COO=sym-bot-team, 2026-05-02). Surface as
  // a warning so users can spot the mismatch before reaching for the
  // troubleshooting section.
  const rooms = new Set(rows.map((r) => r.room));
  const roomMismatch = rows.length > 1 && rooms.size > 1;

  console.log('');
  if (staleCount > 0) {
    console.log(`${staleCount} stale entr${staleCount === 1 ? 'y' : 'ies'} — run \`sym-mesh-channel init\` to heal.`);
  } else {
    console.log('All entries are live.');
  }
  if (roomMismatch) {
    console.log('');
    console.log(`⚠ Room mismatch across entries: ${Array.from(rooms).join(', ')}.`);
    console.log('  Nodes in different rooms cannot discover each other on Bonjour.');
    console.log('  If teammates expect to see each other, align the SYM_ROOM env var.');
    console.log('  See README "Team mesh rooms → Persisting your room across restarts".');
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
const topNodeName = (force && process.env.SYM_NODE_NAME)
  ? process.env.SYM_NODE_NAME
  : (preserveNodeName(existingTopEntry) || nodeName);

// Resolve SYM_ROOM for the global entry — see resolveRoom() at top.
// Heal-path default preserves; --force lets the user explicitly switch
// rooms (or back to default mesh) in one command.
const topRoom = resolveRoom(existingTopEntry);

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
// SYM_ROOM only emitted when explicitly chosen — see project-mode comment
// for the rationale. Omitted = node uses the global _sym._tcp default.
if (topRoom) entry.env.SYM_ROOM = topRoom;

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
  // Preserve SYM_ROOM on stale-heal — same reason as preserveNodeName.
  // The user explicitly chose this room at some prior install; healing a
  // path issue must not silently revert their room membership.
  const projRoomName = preserveRoom(projEntry);
  const healedEntry = {
    command: 'node',
    args: [serverJsPath],
    env: {
      SYM_NODE_NAME: projNodeName,
      SYM_RELAY_URL: projEntry.env && typeof projEntry.env.SYM_RELAY_URL === 'string' ? projEntry.env.SYM_RELAY_URL : '',
      SYM_RELAY_TOKEN: projEntry.env && typeof projEntry.env.SYM_RELAY_TOKEN === 'string' ? projEntry.env.SYM_RELAY_TOKEN : '',
    },
  };
  if (projRoomName) healedEntry.env.SYM_ROOM = projRoomName;
  proj.mcpServers['claude-sym-mesh'] = healedEntry;
  healedProjects.push({ path: projPath, node: projNodeName, room: projRoomName });
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
    healedProjects.map((p) => `    • ${p.path}  (node: ${p.node}${p.room ? `, room: ${p.room}` : ''})`).join('\n') + '\n'
  : '';

const nodeNameSuffix = topEntryIsStale ? ' (preserved from stale entry)' : '';

console.log(`
✓ sym-mesh-channel configured globally in ~/.claude.json

  Node name:     ${topNodeName}${nodeNameSuffix}
  Mesh room:    ${topRoom || 'default (global _sym._tcp mesh)'}
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
