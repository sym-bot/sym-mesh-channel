# Changelog

## 0.3.0

### Added

- **Startup remix-memory primer — automates agent memory recall on
  session/agent restart (MMP §4.2 O2, rejoin-without-replay).** As the
  final step of plugin initialisation (after `node.start()` and before
  the MCP transport connects), the plugin calls
  `node.buildStartupPrimer()` and appends the returned text to the MCP
  server's `instructions` field. A fresh Claude Code session wakes
  with the agent's own remix memory — own observations plus peer
  observations admitted by SVAF — already loaded into context. No
  first-turn `sym_recall` required; agent acts from prior state
  immediately.

  Default caps: last 24 hours OR 20 most recent CMBs, whichever is
  tighter. The primer lists each entry as `[timestamp] source · key —
  focus` and surfaces a dropped-count line when caps elide older
  entries. Empty store is a silent no-op.

### Changed

- **`@sym-bot/sym` dep bumped to `^0.5.0`** to pick up the
  `buildStartupPrimer` helper and to keep every plugin on the
  sym.day platform pinned to the same substrate SDK version
  (no drift across mesh-channel / melotune-plugin / future
  specialised plugins).

## 0.2.0

### Breaking

- **`sym_send` tool signature change.** `sym_send` now emits a structured
  CAT7 CMB (MMP §4.2) instead of a raw-text `type:'message'` frame, and
  accepts an optional `to` parameter for targeted single-peer delivery
  per MMP §4.4.4.

  Old signature: `sym_send(message: string)`
  New signature: `sym_send(focus: string (required), issue?, intent?,
  motivation?, commitment?, perspective?, mood?, to?)`

  Migration: agents that previously called `sym_send({message: "..."})`
  should now pass the CAT7 fields explicitly, with `focus` carrying the
  task anchor for the send. Prior ephemeral text-broadcast behaviour is
  no longer exposed at the tool surface — `sym_send` and `sym_observe`
  both emit CMBs now, receivers run SVAF per §9.2, and admitted CMBs are
  remix-stored with lineage. The low-level `node.send(text)` SDK API is
  unchanged but no longer surfaced as a tool.

### Added

- **Targeted CMB send.** `sym_send` resolves `to` against connected
  peers by full nodeId first, then display name, then 8-char prefix.
  Ambiguous matches return an error asking for the full nodeId; a
  disconnected target returns an error and suggests `sym_peers`.
- **Tool descriptions** for `sym_send` and `sym_observe` now explicitly
  call out the SVAF receive path and lineage semantics, and the MCP
  server's `instructions` string reflects the new division of labour.
- **`@sym-bot/sym` dependency bumped to `^0.3.81`** for
  `remember(fields, {to})` targeted variant and `peers().peerId`.

## 0.1.23

### Added

- **`sym_join_group(group, relay_url?, relay_token?)`** — hot-swap this
  node into a different mesh group at runtime, no Claude Code restart.
  Stops the current SymNode, reconstructs it on the new service type
  (and optional relay), re-registers event handlers, restarts. The
  "smooth way to join" that was missing in 0.1.22.

- **`sym_invite_create(group, relay_url?, relay_token?)`** — generate
  a shareable invite URL for a named group. Two flavors:
  - LAN-only: `sym://group/{name}` (Bonjour isolation only)
  - Cross-network: `sym://team/{name}?relay=...&token=...` (routes via
    a WebSocket relay so teammates on different networks can join).
  Validates kebab-case group names, rejects token without URL.

- **`sym_invite_info(url)`** extended to parse the new `sym://team/`
  path and the `relay=` + `token=` query-string parameters.
  Output now includes a ready-to-paste `sym_join_group` call as JSON.

- **`sym_groups_discover()`** — enumerate SYM-mesh groups currently
  advertising on the local LAN via Bonjour / mDNS. Shell-outs to
  `dns-sd` (macOS/Windows) or `avahi-browse` (Linux) with a 2-second
  timeout, filters to service types matching the SYM protocol family
  (global `_sym._tcp`, named groups, `{app}-{id}` rooms). Peer-to-peer
  means only groups with live members right now are visible — no
  central directory.

- **README — "Dev-team groups" walkthrough** with two concrete scenarios:
  LAN dev-team group (single office) and cross-network team group via
  the public `wss://sym-relay.onrender.com` relay. Shows exact tool
  calls from both the team lead and each teammate.

- **13 new tests** covering invite URL parse, generate, round-trip, and
  validation (kebab-case, token-requires-URL guard). Test suite now at
  35 tests total.

### Changed

- Module-level `node`, `GROUP`, `SERVICE_TYPE`, `RELAY_URL`,
  `RELAY_TOKEN` declared as `let` (was `const`) so the hot-swap path
  can re-bind them. All node event handlers (`identity-collision`,
  `cmb-accepted`, `message`) extracted into a single
  `registerNodeHandlers(n)` function so the hot-swap path re-attaches
  them without duplicating logic.

- Tool count in README corrected to 11 (was 8 in 0.1.22):
  + sym_invite_create, sym_join_group, sym_groups_discover.

## 0.1.22

### Added

- **Plugin marketplace distribution**: `.claude-plugin/marketplace.json`
  enables direct install via the Claude Code plugin marketplace without
  waiting on the Anthropic Plugin Directory propagation pipeline:

  ```
  /plugin marketplace add sym-bot/sym-mesh-channel
  /plugin install sym-mesh-channel@sym-mesh-channel
  ```

  Validates cleanly with `claude plugin validate .` and installs
  end-to-end with no manual steps.

- **`LICENSE`** file (Apache-2.0). `package.json` already declared
  Apache-2.0 but no LICENSE text was present in the repo; this
  aligns the distribution with SPDX expectations.

- **MMP §5.8 mesh-group support** — LAN isolation via Bonjour service
  type so Claude Code sessions can join app-specific meshes (e.g.
  MeloTune mood rooms on `_melotune._tcp`) instead of the global
  `_sym._tcp` mesh. Enables cross-app CMB delivery without cross-app
  noise: nodes in different groups never discover each other at mDNS.

  Config surface (two equivalent paths):
  - `SYM_GROUP=<name>`       → service type `_<name>._tcp`
  - `SYM_SERVICE_TYPE=<st>`  → explicit override (`_foo._tcp` form)

  Default remains `_sym._tcp` / `group=default` — backward compatible.

- **Two new MCP tools for mesh-group operations**:
  - `sym_group_info` — reports current group + service type + peer
    roster scoped to this group.
  - `sym_invite_info` — parses app-specific invite URLs
    (`melotune://room/{id}/{name}`, `sym://group/{name}`) into service
    type + group + room name. Read-only inspection; caller opens a
    new session/env to join.

  `sym_status` output now includes `Group` + service type.

### Fixed

- **`plugin.json` validation failure on install.** The three
  `channels[0].userConfig` entries (`relay_url`, `relay_token`,
  `allowed_peers`) were missing the required `type` and `title`
  fields per the Claude Code plugin schema. Install failed with:

  ```
  channels.0.userConfig.relay_url.type: Invalid option
  channels.0.userConfig.relay_url.title: expected string, received undefined
  ```

  Added `type: "string"` and a human-readable `title` to all three.
  Likely one of the root causes of the 10 Apr 2026 submission
  showing "Published" on the Anthropic submissions portal but not
  propagating to the public `claude-plugins-official` marketplace.

### Changed

- **README**: self-hosted plugin-marketplace install path promoted to
  the primary install recommendation (works today, independent of
  Anthropic directory propagation). npm path kept as alternative.
  Tool table updated 5 → 8 entries to reflect the current surface.
  Clarified that plugin-directory approval and Channels-allowlist
  inclusion are independent gates — the MCP tools work without the
  `--dangerously-load-development-channels` flag; the flag is only
  needed for the `<channel>` async-push behaviour.

- Pairs with `@sym-bot/sym` ≥ 0.3.78 which added the
  `discoveryServiceType` and `group` constructor params consumed by
  the mesh-group tools.

## 0.1.21

### Changed

- **README: accurate `sym_status` / `sym_peers` example output.** The
  Quick Start sample output was a stylized one-line compression; the
  real output is multi-line with additional fields (nodeId suffix,
  Relay, Memories, one peer per line). Updated so users see in the
  README exactly what their terminal will show. Doc-only — no code
  changes.

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
