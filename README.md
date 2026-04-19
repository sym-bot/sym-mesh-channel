# sym-mesh-channel

[![npm](https://img.shields.io/npm/v/@sym-bot/mesh-channel)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![MMP Spec](https://img.shields.io/badge/protocol-MMP_v0.2.3-purple)](https://sym.bot/spec/mmp)
[![arXiv](https://img.shields.io/badge/arXiv-2604.03955-b31b1b.svg)](https://arxiv.org/abs/2604.03955)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

> MCP server that turns Claude Code into a peer node on the [SYM mesh](https://sym.bot) — the first non-Anthropic implementation of Claude Code Channels for real-time agent-to-agent cognition.

Two Claude Code sessions on different machines discover each other via Bonjour mDNS, form a peer-to-peer mesh, and exchange structured cognitive signals in real-time. Each side is a full peer with its own cryptographic identity, its own [SVAF](https://arxiv.org/abs/2604.03955) receiver-side gating, and its own memory — not a thin client. Signals arrive mid-conversation as `<channel>` notifications. No polling, no shared server, no orchestrator.

**Verified cross-platform:** Mac ↔ Windows on the same wifi, pure Bonjour, no relay, no token. Cross-network via optional WebSocket relay.

- **SVAF paper**: [arxiv.org/abs/2604.03955](https://arxiv.org/abs/2604.03955)
- **MMP spec**: [sym.bot/spec/mmp](https://sym.bot/spec/mmp)

## What this looks like

A Claude Code session on Mac broadcasts a structured signal: `focus: "echo loop between same-domain agents"`, `intent: "need architecture review before implementation"`. A session on Windows receives it in real-time as a `<channel>` notification — no tool call, it just appears mid-conversation. The Windows Claude reviews, responds with a detailed architecture analysis, and the Mac session sees the response land mid-turn. Two agents coordinated through typed cognitive signals on an open protocol, across machines, with zero human copy-paste.

This isn't hypothetical. This README was coordinated by two Claude Code sessions working through the mesh it describes.

## How real-time push works (Claude Code Channels + MMP)

This MCP server composes two things:

**[Claude Code Channels](https://code.claude.com/docs/en/mcp)** (Anthropic, shipped 2026-03-20) — an MCP capability that lets servers push events directly into Claude's conversation context mid-turn via `notifications/claude/channel`. Anthropic built it for the Telegram/Discord/iMessage integrations. We use it for agent-to-agent cognitive coupling.

**[MMP — the Mesh Memory Protocol](https://sym.bot/spec/mmp)** — defines what gets pushed: typed seven-field cognitive bundles (CAT7: focus, issue, intent, motivation, commitment, perspective, mood), how receivers gate incoming signals ([SVAF](https://arxiv.org/abs/2604.03955)), and how peers maintain identity without a central orchestrator. MMP is the protocol; this MCP server is the reference implementation for Claude Code hosts.

**The composition:** when a peer on the mesh broadcasts a CMB (Cognitive Memory Block), the SymNode inside this MCP evaluates it via SVAF. If accepted, the MCP fires a `notifications/claude/channel` notification to Claude Code, which surfaces it as a `<channel>` block in the conversation. Claude sees it, can react, and can broadcast back via `sym_send` or `sym_observe`. No polling. No tool calls. The mesh thinks together.

## Quick start

### Via Claude Code plugin marketplace (recommended)

Two commands, straight from this repo — no waiting on any external directory:

```
/plugin marketplace add sym-bot/sym-mesh-channel
/plugin install sym-mesh-channel@sym-mesh-channel
```

Claude Code clones the repo, reads `.claude-plugin/marketplace.json`, and installs the plugin into your user scope. Launch with:

```bash
claude --dangerously-load-development-channels plugin:sym-mesh-channel@sym-mesh-channel
```

### Via npm

```bash
npm install -g @sym-bot/mesh-channel    # install + auto-configure ~/.claude.json
claude --dangerously-load-development-channels server:claude-sym-mesh   # launch
```

> **Why the dev flag?** Claude Code Channels are in [research preview](https://code.claude.com/docs/en/channels#research-preview) with an Anthropic-maintained allowlist that gates in-conversation `<channel>` push notifications. The MCP tools themselves (`sym_send`, `sym_peers`, `sym_status`, `sym_recall`, `sym_observe`, `sym_fetch`, `sym_group_info`, `sym_invite_info`) work immediately after install without any flag. The `--dangerously-load-development-channels` flag is only needed to enable the async-push behaviour (peer messages arriving mid-turn without a tool call). The plugin is approved on the [Anthropic Plugin Directory](https://claude.ai/settings/plugins/submit); plugin-directory approval and Channels-allowlist inclusion are independent gates.

---

Install auto-detects your hostname, creates a unique node identity (`claude-<hostname>`), and configures the MCP server globally in `~/.claude.json`. To customize your node name, set `SYM_NODE_NAME` before installing. If two people are on the same wifi, their sessions discover each other automatically. Verify inside Claude Code:

```
> sym_status
Node: claude-yourhostname (019d599d)
Relay: disconnected
Peers: 1
Memories: 0

> sym_peers
1 peer(s):
claude-theirhostname via bonjour

> sym_send "reviewing the auth module — found a race condition"
Message delivered to 1 peer(s).
```

The other peer sees it arrive **in their Claude Code context as a real-time `<channel>` notification** — no polling, no tool call. It just appears mid-conversation. Their Claude can reason about it, respond, or act on it autonomously.

For cross-network setup (different offices, remote team), see [Cross-network setup](#cross-network-setup-optional) below.

## Dev-team groups

By default every sym-mesh-channel node joins the global `_sym._tcp` mesh — every peer on the network sees every other peer. For a big company with multiple dev teams, this is too noisy. Mesh groups (MMP §5.8) isolate each team at the mDNS layer so `backend-team` and `frontend-team` can't see each other's CMBs at all.

### LAN dev-team group (same office)

**Team lead creates the group:**

```
# In Claude Code:
> sym_invite_create { "group": "backend-team" }

Invite URL (LAN-only (Bonjour)):

    sym://group/backend-team

Share this URL with teammates...

> sym_join_group { "group": "backend-team" }

Hot-swapped from group "default" (_sym._tcp) to "backend-team" (_backend-team._tcp).
```

**Team lead shares the URL** (Slack, email, however) with teammates.

**Each teammate pastes the URL into their Claude Code session:**

```
> sym_invite_info { "url": "sym://group/backend-team" }

Parsed invite: sym://group/backend-team
{ "app": "sym", "group": "backend-team", "service_type": "_backend-team._tcp" }

To join, call sym_join_group:
    { "group": "backend-team" }

> sym_join_group { "group": "backend-team" }

Hot-swapped from group "default" to "backend-team".
```

No restart, no `~/.claude.json` editing. Teammates on the same LAN now see each other via Bonjour. `backend-team` and `frontend-team` live in isolated mDNS spaces.

### Cross-network team group (distributed team via relay)

Same story, but the team crosses network boundaries (home ↔ office, coffee shop ↔ client site). You need a relay so members can find each other over the internet. We host one at `wss://sym-relay.onrender.com`; you can run your own from the [sym-relay](https://github.com/sym-bot/sym-relay) repo.

**Team lead creates the relay-backed invite:**

```
> sym_invite_create {
    "group": "eng-team",
    "relay_url": "wss://sym-relay.onrender.com",
    "relay_token": "a-shared-secret-any-string-teammates-agree-on"
  }

Invite URL (cross-network (relay)):

    sym://team/eng-team?relay=wss%3A%2F%2Fsym-relay.onrender.com&token=a-shared-secret-...

> sym_join_group {
    "group": "eng-team",
    "relay_url": "wss://sym-relay.onrender.com",
    "relay_token": "a-shared-secret-any-string-teammates-agree-on"
  }
```

Teammate pastes the URL, `sym_invite_info` extracts the relay + token from the query string, `sym_join_group` hot-swaps with the same args. All members with the same token share one relay channel — different tokens = different channels on the same relay host.

### Discovering what's out there

```
> sym_groups_discover

SYM-mesh groups visible on LAN (3):
  _sym._tcp           group="sym"
  _backend-team._tcp  group="backend-team"   (← your current group)
  _frontend-team._tcp group="frontend-team"
```

Only shows groups with at least one node online right now — there's no central directory of offline-but-known groups (peer-to-peer architecture). For cross-network relay-backed groups, you must know the relay URL + token out of band (someone shares the invite URL).

### Advanced: per-project node identity

By default every Claude Code session on a machine shares one mesh identity (set globally in `~/.claude.json`). If you run several Claude Code sessions in parallel from distinct project directories and want each to appear as its own peer on the mesh — e.g. a "research" session and a "strategy" session on the same laptop — install per-project instead:

```bash
cd path/to/your/project
SYM_NODE_NAME=claude-myproject-win sym-mesh-channel init --project
```

This writes `<project>/.mcp.json` and merges `<project>/.claude/settings.local.json` instead of touching `~/.claude.json`. Claude Code loads project-scoped `.mcp.json` on launch and its entries override the global one when you're running from that directory, so each project gets its own `SYM_NODE_NAME` without stepping on siblings. Rerun from each project root with a distinct `SYM_NODE_NAME` to register each one as a separate peer.

Normal one-machine-one-peer usage does **not** need `--project` — the default global install is correct for most users.

## Requirements

| | macOS | Linux | Windows |
|---|---|---|---|
| Node.js ≥ 18 | ✓ | ✓ | ✓ |
| Claude Code ≥ 2.1.97 (Channels feature) | ✓ | ✓ | ✓ |
| Bonjour / mDNS for LAN discovery | built-in | install `avahi-daemon` | built-in (Windows 10+) |

The plugin is approved on the Anthropic Plugin Directory. The `--dangerously-load-development-channels` flag remains necessary while Claude Code Channels are in research preview with a separate allowlist that gates the `<channel>` push-notification feature specifically; the MCP tools themselves do not require the flag.

## What you get

Eleven MCP tools exposed to Claude Code, namespaced under `mcp__claude-sym-mesh__`:

| Tool | What it does |
|---|---|
| `sym_send` | Broadcast a free-text message to all mesh peers. Arrives in receivers' contexts as a `<channel>` notification. |
| `sym_observe` | Share a structured CAT7 observation: focus, issue, intent, motivation, commitment, perspective, mood. SVAF-gated on the receiving side. |
| `sym_recall` | Search mesh memory for past CMBs. |
| `sym_fetch` | Fetch the full content of a single CMB by its compact channel-header ID. Lets receivers pull deep context on demand rather than receiving every field on every push. |
| `sym_peers` | List discovered peers (via bonjour or relay). |
| `sym_status` | Node identity, relay state, peer count, memory count. Includes current mesh group (MMP §5.8). |
| `sym_group_info` | Report the mesh group this node is in, with service type + group name + peer roster scoped to the group. |
| `sym_invite_create` | Generate a shareable invite URL for a named group. LAN-only `sym://group/{name}` or cross-network `sym://team/{name}?relay=&token=` flavor. Team leads share this with teammates. |
| `sym_invite_info` | Parse a mesh invite URL and return group + service type + relay creds + a ready-to-use `sym_join_group` call. Read-only; does not switch groups. |
| `sym_join_group` | **Hot-swap** this node into a different mesh group at runtime — no Claude Code restart. Works for LAN groups and cross-network relay-backed teams. |
| `sym_groups_discover` | List SYM-mesh groups currently advertising on the local network via Bonjour / mDNS. Only shows groups with at least one node online right now. |

Real-time push is bidirectional: peer events arrive in Claude's context without any tool call, while the session is mid-turn. This is the "Claude thinks with the mesh" property — not "Claude pokes the mesh occasionally."

## How it works

```
Claude Code A                                              Claude Code B
     ↕ (stdio + MCP)                                            ↕
sym-mesh-channel (SymNode)  ←—  Bonjour mDNS  —→  sym-mesh-channel (SymNode)
     ↕                          (LAN discovery)                 ↕
     └────────────  optional WebSocket relay  ────────────────┘
                    (cross-network, see below)
```

- **Stdio half**: Claude Code spawns the MCP server as a child process. MCP tool calls flow over stdio.
- **Push half**: when a CMB arrives at the SymNode (via Bonjour or relay), the MCP server fires a `notifications/claude/channel` notification back over stdio. Claude Code surfaces it as a `<channel>` block in the conversation context.
- **Identity**: each peer has its own Ed25519 keypair stored at `~/.sym/nodes/<name>/identity.json`. NodeIDs are UUID v7 + Ed25519 signatures, gossiped through the relay's directory and/or via Bonjour TXT records.
- **SVAF**: incoming CMBs are evaluated by Symbolic-Vector Attention Fusion before they enter cognitive state. Low-relevance CMBs are gated out so the receiver's context doesn't drown.

For the full architecture, see MMP spec sections 4-6.

## Cross-network setup (optional)

LAN-only is enough for two people sitting next to each other. To connect across networks (different offices, coffee shop ↔ home, etc.) you need a relay:

```bash
# Run your own relay (Render-friendly Dockerfile included)
git clone https://github.com/sym-bot/sym-relay
cd sym-relay && npm install && npm start
# or deploy the Dockerfile to Render / Fly / Railway / etc
```

Then add the relay env vars to your `claude-sym-mesh` entry in `~/.claude.json`:

```json
"env": {
  "SYM_NODE_NAME": "claude-mac",
  "SYM_RELAY_URL": "wss://your-relay.example.com",
  "SYM_RELAY_TOKEN": "your-shared-token"
}
```

Both peers must use the same relay URL and token to be on the same channel. The relay supports per-token channel isolation so you can run a single relay for multiple groups.

## Troubleshooting

**Peers don't see each other on the same wifi.** Check Bonjour is running:
- macOS: `dns-sd -B _sym._tcp` (built-in)
- Linux: `avahi-browse -r _sym._tcp` (needs `avahi-daemon` running)
- Windows 10+: mDNS is built-in. If discovery fails, check Windows Firewall allows mDNS (port 5353 UDP).

Some corporate networks block mDNS multicast — try a hotspot or home wifi to verify. If LAN is blocked, fall back to a relay.

**`<channel>` notifications never arrive even though peers are connected.** Verify Claude Code was launched with the development-channels flag matching your install path:

* plugin install: `--dangerously-load-development-channels plugin:sym-mesh-channel@sym-mesh-channel`
* npm install: `--dangerously-load-development-channels server:claude-sym-mesh`

Without the exact flag for your install path, MCP push notifications are silently dropped.

**`sym_status` says "Peers: 0" but `sym_peers` lists peers.** Snapshot timing — both views read the same `_peers` map at slightly different moments. The peer set is dynamic. If counts disagree consistently, file an issue.

**`sym_status` says "Relay: connected" even though you didn't configure a relay.** Your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) exports `SYM_RELAY_URL`. Claude Code's MCP env block is **additive** — omitting a key doesn't remove it from the child process. Fix: set `SYM_RELAY_URL` and `SYM_RELAY_TOKEN` to `""` (empty string) in the MCP env block to override the shell. The installer (`npx @sym-bot/mesh-channel init`) does this automatically as of v0.1.8.

**Multiple Claude Code sessions on the same machine want to share an identity.** Don't. Each session should have a distinct `SYM_NODE_NAME`. As of `@sym-bot/sym 0.3.70`, the SymNode acquires an exclusive lockfile on its identity (`~/.sym/nodes/<name>/lock.pid`) and refuses to start a second process with the same name. If you see `EIDENTITYLOCK`, find and kill the other process or pick a different name.

## Security

Defense in depth — three layers, all must pass before a mesh signal reaches Claude's context:

1. **Transport**: Ed25519 peer identity (LAN) + relay token auth (cross-network). Unauthenticated sources cannot reach `pushChannel()`.
2. **Protocol**: [SVAF](https://arxiv.org/abs/2604.03955) per-field content gating — evaluates each incoming CMB across 7 semantic dimensions and rejects irrelevant signals.
3. **Application**: text-only context injection, no code execution, no permission relay (`claude/channel/permission` is explicitly not declared).

**Optional peer allowlist**: set `SYM_ALLOWED_PEERS=claude-mac,claude-win` to restrict which authenticated peers can push to Claude's context. When empty (default), all authenticated peers are accepted.

See [SECURITY.md](SECURITY.md) for the full security model.

## References

- [SVAF paper (arXiv:2604.03955)](https://arxiv.org/abs/2604.03955) — Xu, 2026. Symbolic-Vector Attention Fusion for Collective Intelligence.
- [MMP spec v0.2.3](https://sym.bot/spec/mmp) — Mesh Memory Protocol specification.
- [sym-swift](https://github.com/sym-bot/sym-swift) — iOS/macOS SDK implementing the same protocol.
- [sym-relay](https://github.com/sym-bot/sym-relay) — WebSocket relay for cross-network mesh.

**Verified cross-platform:** Mac ↔ Windows on the same wifi (April 2026).

## License

Apache 2.0 — SYM.BOT Ltd
