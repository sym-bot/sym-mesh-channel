# Changelog

## 0.1.20

### Added

- **`sym-mesh-channel init --project`** — new flag to install the MCP
  server at project scope (`<cwd>/.mcp.json` + merged
  `<cwd>/.claude/settings.local.json`) instead of global
  `~/.claude.json`. Enables multi-identity-per-machine workflows where
  several Claude Code sessions run in parallel from distinct project
  directories and each appears as its own peer on the mesh. Project
  `.mcp.json` entries override the global `mcpServers` entry when
  Claude Code launches from that directory, so `SYM_NODE_NAME` can
  differ per project without siblings stepping on each other.
- Project mode supports the same `--force` semantics as global install:
  backs up existing `.mcp.json` and `settings.local.json` next to
  themselves (`*.bak-<timestamp>`), merges `settings.local.json` so
  unrelated keys (permissions, custom settings) are preserved, atomic
  writes via tmp+rename, refuses to overwrite an existing
  `claude-sym-mesh` entry without `--force`.
- `--postinstall` always runs global install regardless of `--project`
  (npm postinstall runs from npm's staging dir, not the user's
  project). Keeps `npm install -g` auto-configure behavior unchanged.
- **5 new tests** covering project-mode install: writes `.mcp.json`
  and `settings.local.json`, merge preserves existing keys, refusal
  path exits 2, `--force` overwrite creates backup, postinstall
  fallback ignores `--project`. Test suite now 22 tests total.

### Why

Default mode (single mesh identity per machine, global install) is
correct for most users and unchanged. `--project` exists for the
small but real set of users who run multiple Claude Code sessions
in parallel from distinct project directories and want each session
to show up as its own peer on the mesh. Previously this workflow
required hand-editing `.mcp.json` and `.claude/settings.local.json`
per project; now it's one command per project.

## 0.1.19

### Added

- **Claude Code plugin manifest** for Anthropic Channels allowlist
  submission. `.claude-plugin/plugin.json` + `.mcp.json` following the
  official single-repo pattern (Telegram/Discord). Submitted to
  Anthropic Plugin Directory 10 Apr 2026.
- **`SYM_ALLOWED_PEERS`** — optional peer allowlist (defense-in-depth).
  Comma-separated node names; only listed peers can push to Claude's
  context. Empty = accept all authenticated peers. SVAF still gates on
  content relevance regardless.
- **`SECURITY.md`** — 3-layer defense model documentation (transport
  auth + SVAF content gate + peer allowlist) for Anthropic review.
- **17 plugin tests** covering manifest validation, security checks
  (no permission relay, no code execution, self-echo filtering, peer
  allowlist), and lifecycle (shutdown handlers, identity collision).

## 0.1.18

### Changed

- **Auto-configure on install.** `npm install -g` now runs `postinstall`
  that writes the MCP server config to global `mcpServers` in
  `~/.claude.json` automatically. No separate `sym-mesh-channel init`
  step needed — two commands to mesh: install + launch.
- **Global MCP config** — server entry is now written to top-level
  `mcpServers` (available in all Claude Code sessions), not
  project-scoped.
- **Windows postinstall fixes** — `require.resolve` for server.js path
  (handles npm staging directory on Windows), EBUSY handling when
  Claude Code has `~/.claude.json` locked, graceful skip if Claude
  Code not yet installed.
- **README repositioned** — lead with capability ("first non-Anthropic
  Claude Code Channels implementation"), not use case. Simplified
  Quick Start to two commands.
- **0 vulnerabilities** — fresh dependency rebuild resolves all 6
  moderate hono/node-server advisories.
- Windows mDNS: built-in on Windows 10+, no Bonjour install needed.

## 0.1.7

### Added

- **`npx @sym-bot/mesh-channel init`** — interactive installer that
  writes `~/.claude.json` for the current project, picks a sensible
  default `SYM_NODE_NAME` (`claude-mac` / `claude-win` / `claude-linux`),
  resolves the absolute path to `server.js`, and prints the launch
  command including the `--dangerously-load-development-channels` flag.
  Backs up the existing config to `~/.claude.json.bak-<timestamp>`,
  validates JSON round-trip, atomic write via tmp+rename. Refuses to
  overwrite an existing entry without `--force`.
- **README rewritten for LAN-first install.** Quick start is two
  minutes: install, init, launch. No relay required. Bonjour/mDNS
  is the default discovery path. Cross-network setup (relay) is now
  the optional advanced section.

### Changed

- `package.json` `bin` now exposes both `sym-mesh-channel` (server
  entrypoint) and `sym-mesh-channel-init` (installer). The package
  description leads with "LAN-first via Bonjour, no relay required."

### Why

The 0.1.5/0.1.6 install path required users to manually edit
`~/.claude.json`, know about the Channels dev flag, set up a relay,
and obtain a relay token. That gated the demo behind real friction.
LAN-only mode has worked since day one in the underlying SymNode
(`sym/lib/node.js:509-511` only connects to the relay if `SYM_RELAY_URL`
is set; Bonjour discovery starts unconditionally), but no documentation
or installer surfaced it. This release closes that gap: two users on
the same wifi can join the same mesh in two minutes with three commands.

## 0.1.6

### Fixed

- `sym_send` no longer double-delivers. Previously called both
  `node.send()` (broadcast as `event_type=message`) AND `node.remember()`
  (persist as CMB which gets gossiped as `event_type=cmb`), causing
  the same payload to arrive twice on receivers and double the
  context-window cost. Now broadcasts the message frame only. Hosts
  that want CMB persistence should call `sym_observe` separately
  with proper CAT7 fields.
- `sym_send` now reports the actual delivered count, not
  `peers().length`. Requires `@sym-bot/sym >= 0.3.70` where `send()`
  returns the count of peer transports that successfully accepted
  the broadcast. The two can disagree when peers are tracked but
  have broken transports — the delivered count is the truth about
  what was actually sent.

### Changed

- Bumped `@sym-bot/sym` dep `^0.3.69` → `^0.3.70`. 0.3.70 ships the
  identity lockfile that prevents two SymNode processes from
  claiming the same nodeId on a host (the cliHostMode-vs-MCP
  collision that broke real-time push on Windows during the
  2026-04-09 round-trip test).

## 0.1.5

### Changed

- Bumped `@sym-bot/sym` dep `^0.3.68` → `^0.3.69` (0.3.68 deprecated;
  same code in 0.3.69 with a cleaner published tarball).
- Added `files` whitelist to `package.json` and `.npmignore` for
  `*.bak`, `*.swp`, `.DS_Store` so future publishes can't accidentally
  ship local backup files. First NPM publish of this package.

## 0.1.4

### Changed

- Bumped `@sym-bot/sym` dep `^0.3.43` → `^0.3.68` to pick up
  duplicate-identity refusal (close code 4004) and the new
  `identity-collision` event.

### Added

- Wired `node.on('identity-collision', ...)` to `process.exit(2)` so
  the MCP dies cleanly when the relay reports a duplicate-identity
  race. Together with v0.1.3's clean shutdown, this fully resolves
  the host-side half of the duplicate-identity bug.

## 0.1.3

### Added

- Clean shutdown handlers (SIGTERM/SIGINT/SIGHUP) that call
  `node.stop()` before exiting, so the SymNode disconnects from the
  relay before the process dies. Without this, restarts left zombie
  registrations on the relay until the next heartbeat tick (up to
  30s), creating a duplicate-identity race window for the next MCP
  spawn. Idempotent re-entry guard.

## 0.1.2

### Fixed

- Suppressed `peer-joined` / `peer-left` events from being pushed to
  Claude's context as `<channel>` notifications. Presence is high-
  frequency and low-signal — a relay reconnect could fire one event
  per peer per cycle, flooding the context window. CMBs and direct
  messages still flow through.

## 0.1.1

### Changed

- Replaced hardcoded `claude-code` / `claude-code-mac` literals with
  a single `NODE_NAME` constant sourced from `process.env.SYM_NODE_NAME`
  (default `claude-code-mac`). Enables platform-scoped naming per
  MMP §3.1.2 without source edits. Fixed stale display strings in
  the MCP instructions, `sym_send` perspective, `sym_status` header,
  and the self-echo dedup filter.

## 0.1.0

### Added

- Initial release. MCP server that runs a `SymNode` peer node inside
  a Claude Code session — own identity, own relay connection, own
  SVAF evaluation. Tools: `sym_send`, `sym_observe`, `sym_recall`,
  `sym_peers`, `sym_status`. Mesh events arrive as `<channel>`
  notifications when launched with
  `claude --dangerously-load-development-channels server:claude-sym-mesh`
  (allowlisted server name required by Claude Code Channels).
