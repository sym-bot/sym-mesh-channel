# sym-mesh-channel

[![npm](https://img.shields.io/npm/v/@sym-bot/mesh-channel)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![MMP Spec](https://img.shields.io/badge/protocol-MMP_v0.2.2-purple)](https://sym.bot/spec/mmp)
[![arXiv](https://img.shields.io/badge/arXiv-2604.03955-b31b1b.svg)](https://arxiv.org/abs/2604.03955)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

> MCP server that turns any Claude Code session into a peer node on the [SYM mesh](https://sym.bot). LAN-first via Bonjour mDNS — no relay required for users on the same wifi.

Two Claude Code instances on the same network discover each other automatically and exchange structured cognitive state **in real-time**. Each side is a full peer with its own cryptographic identity, its own SVAF receiver-side gating, and its own memory — not a thin client.

**Verified cross-platform:** Mac ↔ Windows on the same wifi, pure Bonjour, no relay, no token. Bidirectional real-time push confirmed 2026-04-09 with `@sym-bot/sym 0.3.74`.

- **SVAF paper**: [arxiv.org/abs/2604.03955](https://arxiv.org/abs/2604.03955)
- **MMP spec**: [sym.bot/spec/mmp](https://sym.bot/spec/mmp)
- **Source**: [github.com/sym-bot/sym-mesh-channel](https://github.com/sym-bot/sym-mesh-channel)

## How real-time push works (Claude Code Channels + MMP)

This MCP server composes two things:

**[Claude Code Channels](https://code.claude.com/docs/en/mcp)** (Anthropic, shipped 2026-03-20) — an MCP capability that lets servers push events directly into Claude's conversation context mid-turn via `notifications/claude/channel`. Anthropic built it for the Telegram/Discord/iMessage integrations. We use it for agent-to-agent cognitive coupling.

**[MMP — the Mesh Memory Protocol](https://sym.bot/spec/mmp)** — defines what gets pushed: typed seven-field cognitive bundles (CAT7: focus, issue, intent, motivation, commitment, perspective, mood), how receivers gate incoming signals ([SVAF](https://arxiv.org/abs/2604.03955)), and how peers maintain identity without a central orchestrator. MMP is the protocol; this MCP server is the reference implementation for Claude Code hosts.

**The composition:** when a peer on the mesh broadcasts a CMB (Cognitive Memory Block), the SymNode inside this MCP evaluates it via SVAF. If accepted, the MCP fires a `notifications/claude/channel` notification to Claude Code, which surfaces it as a `<channel>` block in the conversation. Claude sees it, can react, and can broadcast back via `sym_send` or `sym_observe`. No polling. No tool calls. The mesh thinks together.

## Quick start (LAN, two minutes)

You and one other person on the same wifi each run:

```bash
# 1. Install
npm install -g @sym-bot/mesh-channel

# 2. Configure Claude Code (writes ~/.claude.json, prints the launch command)
sym-mesh-channel init
```

The installer auto-detects your hostname and creates a unique node identity (`claude-<hostname>`). It prints the exact launch command — copy-paste it:

```bash
# 3. Launch Claude Code with the Channels dev flag (printed by init)
claude --dangerously-load-development-channels server:claude-sym-mesh
```

Inside Claude Code, verify the mesh:

```
sym_status   →  Node: claude-yourhostname (...), Relay: disconnected, Peers: 1
sym_peers    →  1 peer(s): <other-peer> via bonjour
```

Then send a message:

```
sym_send "hello from Mac"
```

The other peer sees it arrive **in their Claude Code context as a real-time `<channel>` notification** — no polling, no `sym_recall`, no tool call. It just appears. They reply with `sym_send "hello from Windows"` and you see it land in your context the same way.

That's it: cross-machine Claude-to-Claude collective intelligence over a typed cognitive protocol, on the same wifi, in two minutes.

## Requirements

| | macOS | Linux | Windows |
|---|---|---|---|
| Node.js ≥ 18 | ✓ | ✓ | ✓ |
| Claude Code ≥ 2.1.97 (Channels feature) | ✓ | ✓ | ✓ |
| Bonjour / mDNS for LAN discovery | built-in | install `avahi-daemon` | install [Bonjour for Windows](https://support.apple.com/kb/DL999) (ships with iTunes) |

The `--dangerously-load-development-channels` flag is required because this MCP server is not yet on Anthropic's public Channels allowlist. The flag opts your local Claude Code into receiving `notifications/claude/channel` from a non-allowlisted MCP server. Without it, the MCP loads but real-time push is silently dropped.

## What you get

Five MCP tools exposed to Claude Code, namespaced under `mcp__claude-sym-mesh__`:

| Tool | What it does |
|---|---|
| `sym_send` | Broadcast a free-text message to all mesh peers. Arrives in receivers' contexts as a `<channel>` notification. |
| `sym_observe` | Share a structured CAT7 observation: focus, issue, intent, motivation, commitment, perspective, mood. SVAF-gated on the receiving side. |
| `sym_recall` | Search mesh memory for past CMBs. |
| `sym_peers` | List discovered peers (via bonjour or relay). |
| `sym_status` | Node identity, relay state, peer count, memory count. |

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
- Windows: ensure Bonjour Print Services or iTunes-bundled Bonjour is installed; check Services → Bonjour Service is running

Some corporate networks block mDNS multicast — try a hotspot or home wifi to verify. If LAN is blocked, fall back to a relay.

**`<channel>` notifications never arrive even though peers are connected.** Verify Claude Code was launched with `--dangerously-load-development-channels server:claude-sym-mesh`. Without that exact flag, MCP push notifications are silently dropped.

**`sym_status` says "Peers: 0" but `sym_peers` lists peers.** Snapshot timing — both views read the same `_peers` map at slightly different moments. The peer set is dynamic. If counts disagree consistently, file an issue.

**`sym_status` says "Relay: connected" even though you didn't configure a relay.** Your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) exports `SYM_RELAY_URL`. Claude Code's MCP env block is **additive** — omitting a key doesn't remove it from the child process. Fix: set `SYM_RELAY_URL` and `SYM_RELAY_TOKEN` to `""` (empty string) in the MCP env block to override the shell. The installer (`npx @sym-bot/mesh-channel init`) does this automatically as of v0.1.8.

**Multiple Claude Code sessions on the same machine want to share an identity.** Don't. Each session should have a distinct `SYM_NODE_NAME`. As of `@sym-bot/sym 0.3.70`, the SymNode acquires an exclusive lockfile on its identity (`~/.sym/nodes/<name>/lock.pid`) and refuses to start a second process with the same name. If you see `EIDENTITYLOCK`, find and kill the other process or pick a different name.

## License

Apache 2.0 — SYM.BOT Ltd
