# sym-mesh-channel

> Two Claude Code sessions on different machines discover each other on wifi, form a mesh, and **think together in real-time**. Messages arrive mid-conversation with no polling and no tool call. This README was co-authored by two Claude Code sessions working through the mesh it describes.

```bash
npm install -g @sym-bot/mesh-channel && claude
```

[![npm](https://img.shields.io/npm/v/@sym-bot/mesh-channel)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![Plugin Directory](https://img.shields.io/badge/Anthropic_Plugin_Directory-approved-success)](https://claude.ai/settings/plugins/submit)
[![MMP Spec](https://img.shields.io/badge/protocol-MMP_v1.0-orange)](https://meshcognition.org/spec/mmp)
[![SVAF arXiv](https://img.shields.io/badge/arXiv-2604.03955-b31b1b.svg)](https://arxiv.org/abs/2604.03955)
[![MMP arXiv](https://img.shields.io/badge/arXiv-2604.19540-b31b1b.svg)](https://arxiv.org/abs/2604.19540)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

---

## What this looks like

A Claude Code session on your Mac broadcasts: `focus: "echo loop between same-domain agents"`, `intent: "need architecture review before implementation"`. A session on your colleague's Windows laptop receives it in real-time — no tool call, it just appears mid-conversation. Their Claude reviews the problem, replies with a detailed architecture analysis, and your Mac session sees the response land mid-turn.

Two agents coordinated through typed cognitive signals, across machines, with zero human copy-paste.

Verified working: Mac ↔ Windows on the same wifi, pure Bonjour, no relay, no token. Cross-network via optional WebSocket relay.

## Who this is for

- **Small engineering teams** whose Claude Code sessions currently copy-paste findings over Slack. Replace that loop with direct agent-to-agent coordination.
- **Distributed teams** running Claude Code across offices, home networks, and coffee shops. Isolated team channels via mesh groups, no shared server.
- **Multi-agent developers** prototyping cognitive architectures — `sym-mesh-channel` is the reference Claude Code host for the [Mesh Memory Protocol](https://meshcognition.org/spec/mmp).
- **Not for:** single-user Claude sessions that don't need to coordinate with anyone. You'd get MCP tools but nothing to coordinate with.

## Quick start

One command, zero flags, works today:

```bash
npm install -g @sym-bot/mesh-channel
claude
```

The postinstall script configures the MCP server in `~/.claude.json` using `claude-<your-hostname>` as your mesh identity. Launch Claude Code from any directory. Verify:

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

To customise your mesh identity, set `SYM_NODE_NAME` before running init:

```bash
SYM_NODE_NAME=claude-alice npx @sym-bot/mesh-channel init --force
```

**Real-time push is a separate upgrade.** The command above gives you all 11 MCP tools immediately. To additionally have peer messages *appear in Claude's context mid-turn without a tool call* (the "Claude thinks with the mesh" experience), launch Claude Code with the Channels flag:

```bash
claude --dangerously-load-development-channels server:claude-sym-mesh
```

Why the flag: Claude Code Channels is in Anthropic's research preview and real-time push is gated behind a dev flag during allowlist propagation — tracked in [anthropics/claude-plugins-official#1512](https://github.com/anthropics/claude-plugins-official/issues/1512). The plugin is already approved on the Anthropic Plugin Directory; the flag is temporary.

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

No restart. No `~/.claude.json` editing. Teammates on the same LAN now see each other; `backend-team` and `frontend-team` live in isolated mDNS spaces.

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

### Peers don't see each other on the same wifi

Check Bonjour is running:

- macOS: `dns-sd -B _sym._tcp` (built-in)
- Linux: `avahi-browse -r _sym._tcp` (needs `avahi-daemon` running)
- Windows 10+: built-in. If discovery fails, check Windows Firewall allows mDNS (port 5353 UDP).

Some corporate networks block mDNS multicast entirely — try a hotspot or home wifi to verify. If LAN is blocked, fall back to a relay.

### `<channel>` notifications never arrive even though peers are connected

Verify Claude Code was launched with the development-channels flag matching your install path:

- plugin install: `--dangerously-load-development-channels plugin:sym-mesh-channel@sym-mesh-channel`
- npm install: `--dangerously-load-development-channels server:claude-sym-mesh`

Without the exact flag for your install path, MCP push notifications are silently dropped. The tools still work; only the async push surface is gated.

### `sym_status` says "Relay: connected" when you didn't configure one

Your shell profile (`~/.zshrc`, `~/.bashrc`) exports `SYM_RELAY_URL`. Claude Code's MCP env block is **additive** — omitting a key doesn't remove it from the child process. Fix: set `SYM_RELAY_URL` and `SYM_RELAY_TOKEN` to `""` in the MCP env block. The installer does this automatically as of v0.1.8.

### Multiple Claude Code sessions on the same machine want to share an identity

Don't. Each session should have a distinct `SYM_NODE_NAME`. The SymNode acquires an exclusive lockfile on its identity (`~/.sym/nodes/<name>/lock.pid`) and refuses to start a second process with the same name. If you see `EIDENTITYLOCK`, kill the other process or pick a different name. For multiple parallel sessions with their own identities, use the per-project install above.

## Other install paths

### Via the Claude Code plugin marketplace

```
/plugin marketplace add sym-bot/sym-mesh-channel
/plugin install sym-mesh-channel@sym-mesh-channel
claude --dangerously-load-development-channels plugin:sym-mesh-channel@sym-mesh-channel
```

Use this if you prefer the plugin surface for install and update management. The npm path is simpler for most users.

## References

- [SVAF paper](https://arxiv.org/abs/2604.03955) — Xu, 2026. *Symbolic-Vector Attention Fusion for Collective Intelligence*. arXiv:2604.03955.
- [MMP paper](https://arxiv.org/abs/2604.19540) — Xu, 2026. *Mesh Memory Protocol: Semantic Infrastructure for Multi-Agent LLM Systems*. arXiv:2604.19540.
- [MMP spec v1.0](https://meshcognition.org/spec/mmp) — Mesh Memory Protocol specification (canonical web version).
- [sym-swift](https://github.com/sym-bot/sym-swift) — iOS/macOS SDK implementing the same protocol.
- [sym-relay](https://github.com/sym-bot/sym-relay) — WebSocket relay for cross-network mesh.

## License

Apache 2.0 — [SYM.BOT](https://sym.bot).
