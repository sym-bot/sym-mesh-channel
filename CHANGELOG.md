# Changelog

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
