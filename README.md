# sym-mesh-channel

[![npm](https://img.shields.io/npm/v/@sym-bot/mesh-channel)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![MMP Spec](https://img.shields.io/badge/protocol-MMP_v0.2.2-purple)](https://sym.bot/spec/mmp)
[![arXiv](https://img.shields.io/badge/arXiv-2604.03955-b31b1b.svg)](https://arxiv.org/abs/2604.03955)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

> MCP server that turns any Claude Code session into a peer node on the [SYM mesh](https://sym.bot). LAN-first via Bonjour mDNS — no relay required for users on the same wifi.

Two Claude Code instances on the same network discover each other automatically and exchange structured cognitive state in real-time. Each side is a full peer with its own cryptographic identity, its own SVAF receiver-side gating, and its own memory — not a thin client.

This is the reference implementation of MMP (the Mesh Memory Protocol) for Claude Code hosts. See:

- **SVAF paper**: [arxiv.org/abs/2604.03955](https://arxiv.org/abs/2604.03955)
- **MMP spec**: [sym.bot/spec/mmp](https://sym.bot/spec/mmp)
- **Source**: [github.com/sym-bot/sym-mesh-channel](https://github.com/sym-bot/sym-mesh-channel)

## Quick start (LAN, two minutes)

You and one other person on the same wifi each run:

```bash
# 1. Install
npm install -g @sym-bot/mesh-channel

# 2. Configure Claude Code (writes ~/.claude.json for the current project)
SYM_NODE_NAME=claude-mac npx @sym-bot/mesh-channel init
#                ^^^^^^ pick a unique name per machine: claude-mac, claude-win, claude-linux, anything

# 3. Launch Claude Code with the Channels dev flag
claude --dangerously-load-development-channels server:claude-sym-mesh
```

Inside Claude Code, ask it:

> verify the mesh: run sym_status and sym_peers, then sym_send "hello"

Within a few seconds the other peer should see your message arrive in their Claude Code context as a real-time `<channel>` notification — no polling, no `sym_recall`. That's it: cross-machine Claude-to-Claude collective intelligence over a typed cognitive protocol.

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

**Multiple Claude Code sessions on the same machine want to share an identity.** Don't. Each session should have a distinct `SYM_NODE_NAME`. As of `@sym-bot/sym 0.3.70`, the SymNode acquires an exclusive lockfile on its identity (`~/.sym/nodes/<name>/lock.pid`) and refuses to start a second process with the same name. If you see `EIDENTITYLOCK`, find and kill the other process or pick a different name.

## License

Apache 2.0 — SYM.BOT Ltd
