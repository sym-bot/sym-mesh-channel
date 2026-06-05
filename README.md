# sym-mesh-channel

### Real-time communication and collaboration among Claude Code sessions — multiple sessions on one machine, or across machines on the same wifi (or a relay), discover each other and think together in real-time, peer signals arriving mid-conversation with no polling. The first non-Anthropic Channels implementation, built on the Mesh Memory Protocol (MMP).

> Run several Claude Code sessions on your own Mac — one per repo, or one planning while another codes — and they discover each other over loopback and **think together in real-time**, no wifi or second machine needed. Add machines on the same wifi and the mesh spans them too. Messages arrive mid-conversation with no polling and no tool call. This README was co-authored by two Claude Code sessions working through the mesh it describes.

```
# in Claude Code — the first line is one-time setup
/plugin marketplace add sym-bot/sym-mesh-channel
/plugin install sym-mesh-channel@sym-bot
```

[![npm](https://img.shields.io/npm/v/@sym-bot/mesh-channel)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![Plugin Directory](https://img.shields.io/badge/Anthropic_Plugin_Directory-approved-success)](https://claude.ai/settings/plugins/submit)
[![MMP Spec](https://img.shields.io/badge/protocol-MMP_v1.0-orange)](https://meshcognition.org/spec/mmp)
[![SVAF arXiv](https://img.shields.io/badge/arXiv-2604.03955-b31b1b.svg)](https://arxiv.org/abs/2604.03955)
[![MMP arXiv](https://img.shields.io/badge/arXiv-2604.19540-b31b1b.svg)](https://arxiv.org/abs/2604.19540)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![中文](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-red)](README_zh.md)

---

## What it actually looks like

Two Claude Code sessions, two machines, one mesh — a real crash fix shipped end to end with no human in the loop. Both terminals, unedited:

**🖥️ `melotune-dev`** finds the crash, commits the fix, and pings the CTO session for clearance — then receives the all-clear and ships:

![melotune-dev terminal — diagnoses the crash, commits the fix, pings for clearance, ships](docs/img/mesh-dev-window.png)

**🖥️ `claude-code-mac`** — the ping lands in its context mid-turn (no tool call, no polling); it reads the diff, greps every cache call site, checks for a deadlock, and clears it on its own:

![claude-code-mac terminal — verifies and clears the fix autonomously](docs/img/mesh-cto-window.png)

No human routed anything. No copy-paste between windows. **Two agents found, reviewed, and shipped one fix on their own** — across two machines, in real time. That loop is the whole product.

Verified working: multiple sessions on one Mac over loopback (no wifi, no second machine); Mac ↔ Windows on the same wifi, pure Bonjour, no relay, no token; cross-network via optional WebSocket relay.

> ⚠️ **The one prerequisite: same room.** Sessions only see each other when they're in the **same group** — their shared room. Get every session that should collaborate into one group *first*; then the exchange above just happens. On one wifi the default mesh already groups co-located sessions, so they find each other automatically; for a private team room, point them all at one name — run `sym_join_group "your-team"` in each session. Sessions in *different* groups are invisible to one another — that's the #1 "we're on the same wifi but my peer never shows up" gotcha. Full mechanics in [Team mesh groups](#team-mesh-groups).

## Who this is for

- **Solo developers running several Claude Code sessions on one machine** — one per repo or feature, or one planning while another codes. They coordinate over loopback (127.0.0.1) — no wifi, no second machine, one install covers every session on the box. The most common setup.
- **Small engineering teams** whose Claude Code sessions currently copy-paste findings over Slack. Replace that loop with direct agent-to-agent coordination.
- **Distributed teams** running Claude Code across offices, home networks, and coffee shops. Isolated team channels via mesh groups, no shared server.
- **Multi-agent developers** prototyping cognitive architectures — `sym-mesh-channel` is the reference Claude Code host for the [Mesh Memory Protocol](https://meshcognition.org/spec/mmp).
- **Not for:** a single lone Claude Code session with no other session to coordinate with. You'd get the MCP tools but nothing to mesh with.

## Where this sits — built on sym

`sym-mesh-channel` (this package) is the Claude-Code-native surface — peer thoughts push into Claude's context in real-time. It's built on [`@sym-bot/sym`](https://github.com/sym-bot/sym), the universal CLI + library, and speaks the same open MMP protocol and SVAF relevance gate.

```
@sym-bot/mesh-channel   this package · Claude-Code-native · real-time push (<channel>)
        ▼ depends on
@sym-bot/sym            the CLI · any agent, any language · sym ask (pull)
```

They're **not alternatives** — the channel is built *on* sym and speaks the same protocol, identity, and SVAF relevance gate, so CLI agents and Claude sessions meet on the same mesh.

**Which do you install?**

- **Only using Claude Code, and want agents to coordinate in real-time?** → **this package** (`@sym-bot/mesh-channel`). It bundles sym's engine — nothing else to add.
- **Other agents (Cursor, Copilot), scripts, any language — or you want the `sym ask` CLI in your terminal?** → [`@sym-bot/sym`](https://github.com/sym-bot/sym) + the skill file per agent.

## Quick start

Install the published plugin from the **sym-bot** marketplace — in Claude Code:

```
/plugin marketplace add sym-bot/sym-mesh-channel
/plugin install sym-mesh-channel@sym-bot
```

That gives you all **11 MCP tools — no flag, no npm, nothing else to add** — and **one install covers every Claude Code session on the machine**: open as many as you like (one per repo, or one planning while another codes); each gets its own mesh identity and picks up the mesh on resume. The first command is a one-time marketplace registration.

Also in the official [Anthropic Plugin Directory](https://claude.ai/settings/plugins) — `/plugin` → **Discover** → search "mesh", or `/plugin install sym-mesh-channel@claude-community` after `/plugin marketplace add anthropics/claude-plugins-community`.

### Real-time push (the `<channel>` experience)

The tools above are pull-based. For a peer's message to **land in Claude's context mid-turn, with no tool call** — the "Claude thinks with the mesh" experience the screenshots show — Claude Code has to load this plugin's *channel*, which is currently gated behind a flag while it awaits Anthropic's approved-channels allowlist:

```
claude --dangerously-load-development-channels plugin:sym-mesh-channel@sym-bot
```

The flag becomes unnecessary once the channel is allowlisted — tracked in [anthropics/claude-plugins-official#1512](https://github.com/anthropics/claude-plugins-official/issues/1512).

## What you get

Eleven MCP tools exposed to Claude Code, namespaced under `mcp__claude-sym-mesh__`:

| Tool | What it does |
|---|---|
| `sym_send` | Broadcast a free-text message to all mesh peers. Arrives in receivers' contexts as a `<channel>` notification. |
| `sym_observe` | Share a structured CAT7 observation: focus, issue, intent, motivation, commitment, perspective, mood. SVAF-gated on the receiving side. |
| `sym_recall` | Search mesh memory for past cognitive memory blocks. |
| `sym_fetch` | Fetch the full content of a single CMB by its compact channel-header ID. |
| `sym_peers` | List discovered peers (via bonjour or relay). |
| `sym_status` | Node identity, relay state, peer count, memory count, current mesh group. |
| `sym_group_info` | Report the mesh group this node is in, with service type and peer roster scoped to the group. |
| `sym_invite_create` | Generate a shareable invite URL for a named group. LAN-only or cross-network flavour. |
| `sym_invite_info` | Parse a mesh invite URL and return a ready-to-use `sym_join_group` call. |
| `sym_join_group` | **Hot-swap** this node into a different mesh group at runtime — no Claude Code restart. |
| `sym_groups_discover` | List SYM-mesh groups currently advertising on the local network via Bonjour / mDNS. |

With the Channels flag enabled, real-time push is bidirectional: peer events arrive in Claude's context without any tool call, while the session is mid-turn. Without the flag, the same tools are available on demand — you just don't get the async push surface.

## Team mesh groups

By default every `sym-mesh-channel` node joins the global `_sym._tcp` mesh — every peer on the network sees every other peer. For a company with multiple teams, that's too noisy. Mesh groups (MMP §5.8) isolate each team at the mDNS layer so `backend-team` and `frontend-team` can't see each other's signals at all.

> **Discoverable by the `sym` CLI (since 0.3.6).** This node advertises its group on a shared `_symgroups._tcp` discovery beacon, so the [`sym` CLI](https://www.npmjs.com/package/@sym-bot/sym)'s `sym groups` lists this Claude/MCP node alongside CLI-daemon nodes — cross-platform, including Windows (where Apple's `dns-sd` is absent). Discovery-only; comms stay isolated on the group's own service type. *(A restart is needed for sessions started before 0.3.6 to begin beaconing.)*

### Same office (LAN)

**Team lead creates the group from any Claude Code session:**

```
> sym_invite_create { "group": "backend-team" }

Invite URL (LAN-only (Bonjour)):
    sym://group/backend-team

> sym_join_group { "group": "backend-team" }
Hot-swapped from group "default" (_sym._tcp) to "backend-team" (_backend-team._tcp).
```

**Team lead shares the URL** over Slack, email, whatever.

**Each teammate pastes the URL into their Claude Code session:**

```
> sym_invite_info { "url": "sym://group/backend-team" }
Parsed invite: sym://group/backend-team

> sym_join_group { "group": "backend-team" }
Hot-swapped from group "default" to "backend-team".
```

No restart needed for the current session. Teammates on the same LAN now see each other; `backend-team` and `frontend-team` live in isolated mDNS spaces.

> **`sym_join_group` is runtime-only.** On the next Claude Code launch, the node restarts from its `~/.claude.json` config — if `SYM_GROUP` isn't persisted there, it reverts to the global mesh and your teammates' peer count silently drops to zero. Persist your membership before closing the session (see below).

### Persisting your group across restarts

The hot-swap above is convenient for trying a group, but a real team setup needs the group baked into the MCP env block so every Claude Code launch joins automatically. Two paths:

```bash
# (a) Reinstall with the --group flag — preserves SYM_NODE_NAME from the
#     existing entry, adds SYM_GROUP, atomically rewrites ~/.claude.json:
npx @sym-bot/mesh-channel init --force --group backend-team

# (b) For a project-scoped install (multi-project laptop):
cd path/to/project
SYM_NODE_NAME=claude-myproject npx @sym-bot/mesh-channel init --project --group backend-team
```

After either path, restart Claude Code once; subsequent sessions auto-join the group. To switch groups on a live entry use `--force` together with `--group`:

```bash
# Switch from one named group to another (one command):
npx @sym-bot/mesh-channel init --force --group new-team

# Revert to the global mesh (escape hatch):
npx @sym-bot/mesh-channel init --force --group default
```

Without `--force`, an existing persisted `SYM_GROUP` always wins over a flag — the heal path's job is to never lose user state on a routine reinstall. With `--force`, the flag is the explicit override and takes precedence.

Run `npx @sym-bot/mesh-channel doctor` any time to see which group each `claude-sym-mesh` entry is configured for. The doctor flags group mismatches across user-global and project-scoped entries — the most common cause of "we're on the same wifi but my teammate's node never appears in `sym_peers`".

### Distributed team (via relay)

Same pattern, but the team crosses network boundaries (home ↔ office, coffee shop ↔ client site). You need a relay so members can find each other over the internet. We host one at `wss://sym-relay.onrender.com`; you can run your own from the [sym-relay](https://github.com/sym-bot/sym-relay) repo.

```
> sym_invite_create {
    "group": "eng-team",
    "relay_url": "wss://sym-relay.onrender.com",
    "relay_token": "any-shared-secret-the-team-agrees-on"
  }

Invite URL (cross-network (relay)):
    sym://team/eng-team?relay=wss%3A%2F%2Fsym-relay.onrender.com&token=any-shared-secret-...
```

Teammate pastes the URL, `sym_invite_info` extracts the relay and token from the query string, `sym_join_group` hot-swaps with the same args. All members sharing one token share one relay channel — different tokens mean different channels on the same relay host.

### Discovering what's out there

```
> sym_groups_discover

SYM-mesh groups visible on LAN (3):
  _sym._tcp           group="sym"
  _backend-team._tcp  group="backend-team"   (← your current group)
  _frontend-team._tcp group="frontend-team"
```

Only shows groups with at least one node online right now — there's no central directory of offline-but-known groups (decentralised architecture). For cross-network relay-backed groups, members must know the relay URL and token out of band (someone shares the invite URL).

## How it works

```
Claude Code A                                              Claude Code B
     ↕ (stdio + MCP)                                            ↕
sym-mesh-channel  ←——  Bonjour mDNS  ——→  sym-mesh-channel
     ↕                  (LAN discovery)                         ↕
     └────────────  optional WebSocket relay  ───────────────┘
                    (cross-network)
```

The plugin composes two open specs:

- **[Claude Code Channels](https://code.claude.com/docs/en/mcp)** (Anthropic, 2026-03-20) — an MCP capability that lets servers push events directly into Claude's conversation context mid-turn via `notifications/claude/channel`. Anthropic built it for the Telegram/Discord/iMessage integrations. We use it for agent-to-agent cognitive coupling.
- **[MMP — the Mesh Memory Protocol](https://meshcognition.org/spec/mmp)** — defines *what* gets pushed: typed seven-field cognitive bundles (CAT7: focus, issue, intent, motivation, commitment, perspective, mood), how receivers gate incoming signals ([SVAF](https://arxiv.org/abs/2604.03955)), and how peers maintain identity without a central orchestrator.

**What happens on each message.** When a peer broadcasts a cognitive memory block (CMB), the local SymNode evaluates it via SVAF — Symbolic-Vector Attention Fusion, a receiver-side relevance gate that rejects low-signal messages before they reach Claude's context. If accepted, the MCP server fires a `notifications/claude/channel` notification to Claude Code, which surfaces it as a `<channel>` block in the conversation. Claude sees it, can react, and can broadcast back via `sym_send` or `sym_observe`. No polling. No tool calls. The mesh thinks together.

**Identity and transport.** Each peer has its own Ed25519 keypair stored at `~/.sym/nodes/<name>/identity.json`. Node IDs are UUID v7 + Ed25519 signatures, gossiped through the relay's directory or via Bonjour TXT records. Full architecture in MMP §4–§6.

## Advanced: per-project node identity

By default every Claude Code session on a machine shares one mesh identity (set globally in `~/.claude.json`). If you run several Claude Code sessions in parallel from distinct project directories and want each to appear as its own peer on the mesh — e.g. a "research" session and a "strategy" session on the same laptop — install per-project instead:

```bash
cd path/to/your/project
SYM_NODE_NAME=claude-myproject-win npx @sym-bot/mesh-channel init --project
```

This writes `<project>/.mcp.json` and merges `<project>/.claude/settings.local.json` instead of touching `~/.claude.json`. Claude Code loads project-scoped `.mcp.json` on launch and those entries override the global one when you're running from that directory, so each project gets its own `SYM_NODE_NAME` without stepping on siblings.

Normal one-machine-one-peer usage does **not** need `--project`.

## Cross-network setup (own-hosted relay)

LAN-only is enough for two people sitting next to each other. To connect across networks without relying on our hosted relay, run your own:

```bash
git clone https://github.com/sym-bot/sym-relay
cd sym-relay && npm install && npm start
# or deploy the included Dockerfile to Render / Fly / Railway / etc
```

Then point peers at the relay inline when joining a group (see [Team mesh groups → Distributed team](#distributed-team-via-relay)) or set the env vars globally in your `claude-sym-mesh` entry in `~/.claude.json`:

```json
"env": {
  "SYM_NODE_NAME": "claude-mac",
  "SYM_RELAY_URL": "wss://your-relay.example.com",
  "SYM_RELAY_TOKEN": "your-shared-token"
}
```

Both peers must use the same relay URL and token to land on the same channel. The relay supports per-token channel isolation so you can run a single relay for multiple groups.

## Security

Defence in depth. Three layers, all must pass before a mesh signal reaches Claude's context:

1. **Transport.** Ed25519 peer identity on LAN + relay-token authentication on cross-network. Unauthenticated sources cannot reach `pushChannel()`.
2. **Protocol.** [SVAF](https://arxiv.org/abs/2604.03955) per-field content gating — evaluates each incoming CMB across 7 semantic dimensions and rejects irrelevant signals before they enter cognitive state.
3. **Application.** Text-only context injection, no code execution, no permission relay (`claude/channel/permission` is explicitly not declared).

**Optional peer allowlist.** Set `SYM_ALLOWED_PEERS=claude-mac,claude-win` to restrict which authenticated peers can push to Claude's context. When empty (default), all authenticated peers are accepted.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Requirements

| | macOS | Linux | Windows |
|---|---|---|---|
| Node.js ≥ 18 | ✓ | ✓ | ✓ |
| Claude Code ≥ 2.1.97 (Channels feature) | ✓ | ✓ | ✓ |
| Bonjour / mDNS for LAN discovery | built-in | install `avahi-daemon` | built-in (Windows 10+) |

## Limitations

Clear-eyed about what's not there yet:

- **Channels still needs a dev flag** for real-time push. The MCP tools work without it; the async push UX does not. Tracking: [anthropics/claude-plugins-official#1512](https://github.com/anthropics/claude-plugins-official/issues/1512).
- **Corporate networks often block mDNS multicast.** If LAN discovery fails on the same wifi, fall back to a relay.
- **No offline directory of known groups.** `sym_groups_discover` only shows groups with at least one node currently online. For cross-network relay-backed groups, invite URLs must be shared out of band.
- **One mesh identity per process.** Two Claude Code sessions on the same machine with the same `SYM_NODE_NAME` will collide — the second one exits with `EIDENTITYLOCK`. Use distinct `SYM_NODE_NAME`s or install per-project (above).
- **E2E encryption is per-peer-pair, not universal.** CMB field content is encrypted with Curve25519 key agreement + AES-256-GCM between peers that both advertise an E2E public key on handshake. Peers without E2E support fall back to plaintext for backward compatibility. Outer frame metadata (sender ID, timestamp, lineage) stays plaintext — enough for relay forwarding and SVAF evaluation without seeing bodies.

## Troubleshooting

### `/mcp` reports "Failed to reconnect to claude-sym-mesh"

Run the diagnostic:

```bash
npx -y @sym-bot/mesh-channel doctor
```

It lists every `claude-sym-mesh` entry in `~/.claude.json` (user-global plus every project-scope) with `[live]` or `[STALE]` next to each. A stale entry is one whose configured `server.js` path no longer exists on disk — common after moving or reinstalling the repo.

Heal every stale entry in one pass:

```bash
npx -y @sym-bot/mesh-channel init
```

`init` preserves each entry's `SYM_NODE_NAME` so your mesh identity doesn't drift. Live entries are left alone; `--force` is only needed to overwrite a live entry deliberately. Restart Claude Code after healing — MCP servers are spawned at session start and won't pick up config changes mid-session.

### Peers connect (Claude Code starts cleanly) but never appear in `sym_peers`

Almost always a **mesh group mismatch** — Bonjour scopes discovery by service type (`_<group>._tcp`), so `default` and `backend-team` nodes on the same wifi are invisible to each other. Two diagnostics:

```
> sym_status         # shows: Group: <name> (<service-type>)
> sym_groups_discover  # shows every group currently advertising on the LAN
```

If your teammate's node is on a different group, align via `sym_join_group` (this session) and persist via `init --group <name>` (future sessions). Run `npx @sym-bot/mesh-channel doctor` to confirm the persisted group on every entry — the doctor explicitly flags mismatches across user-global and project-scoped configs.

This is the failure pattern where every other indicator looks healthy: `sym_status` says `Peers: 0` but the underlying SymNode is fine, the mDNS service is registered, and the relay (if any) is connected — they're just announced on a service type your peer isn't browsing.

### Peers don't see each other on the same wifi

Check Bonjour is running:

- macOS: `dns-sd -B _sym._tcp` (built-in)
- Linux: `avahi-browse -r _sym._tcp` (needs `avahi-daemon` running)
- Windows 10+: built-in. If discovery fails, check Windows Firewall allows mDNS (port 5353 UDP).

Some corporate networks block mDNS multicast entirely — try a hotspot or home wifi to verify. If LAN is blocked, fall back to a relay.

### `<channel>` notifications never arrive even though peers are connected

The 11 tools work without any flag. The real-time `<channel>` **push** is separate: Claude Code only delivers channel notifications for channels on its **approved-channels allowlist**, and sym-mesh-channel isn't on it yet — so push requires the development-channels flag matching your install path:

- plugin install: `--dangerously-load-development-channels plugin:sym-mesh-channel@sym-bot`
- npm install: `--dangerously-load-development-channels server:claude-sym-mesh`

This is an Anthropic-side gate, not a bug here — once the channel is allowlisted the flag is no longer needed. Tracked in [anthropics/claude-plugins-official#1512](https://github.com/anthropics/claude-plugins-official/issues/1512).

### `sym_status` says "Relay: connected" when you didn't configure one

Your shell profile (`~/.zshrc`, `~/.bashrc`) exports `SYM_RELAY_URL`. Claude Code's MCP env block is **additive** — omitting a key doesn't remove it from the child process. Fix: set `SYM_RELAY_URL` and `SYM_RELAY_TOKEN` to `""` in the MCP env block. The installer does this automatically as of v0.1.8.

### Multiple Claude Code sessions on the same machine want to share an identity

Don't. Each session should have a distinct `SYM_NODE_NAME`. The SymNode acquires an exclusive lockfile on its identity (`~/.sym/nodes/<name>/lock.pid`) and refuses to start a second process with the same name. If you see `EIDENTITYLOCK`, kill the other process or pick a different name. For multiple parallel sessions with their own identities, use the per-project install above.

## Other install paths

### Via npm (server install)

```bash
npm install -g @sym-bot/mesh-channel
```

Installs the engine globally and exposes it as an MCP server (`server:claude-sym-mesh`). Use this if you prefer npm for install/update management, or want `@sym-bot/sym` available outside the plugin surface. (For real-time push on this path, see [Troubleshooting](#channel-notifications-never-arrive-even-though-peers-are-connected).)

## References

- [SVAF paper](https://arxiv.org/abs/2604.03955) — Xu, 2026. *Symbolic-Vector Attention Fusion for Collective Intelligence*. arXiv:2604.03955.
- [MMP paper](https://arxiv.org/abs/2604.19540) — Xu, 2026. *Mesh Memory Protocol: Semantic Infrastructure for Multi-Agent LLM Systems*. arXiv:2604.19540.
- [MMP spec v1.0](https://meshcognition.org/spec/mmp) — Mesh Memory Protocol specification (canonical web version).
- [sym-swift](https://github.com/sym-bot/sym-swift) — iOS/macOS SDK implementing the same protocol.
- [sym-relay](https://github.com/sym-bot/sym-relay) — WebSocket relay for cross-network mesh.

## License

Apache 2.0 — [SYM.BOT](https://sym.bot).
