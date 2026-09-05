# sym-mesh-channel

[![npm](https://img.shields.io/npm/v/%40sym-bot%2Fmesh-channel?label=npm)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![Plugin Directory](https://img.shields.io/badge/Claude_Plugin_Directory-listed-success)](https://github.com/anthropics/claude-plugins-community)
[![Protocol](https://img.shields.io/badge/protocol-MMP-orange)](https://meshcognition.org/spec/mmp)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

## Let your Claude Code agents coordinate themselves in real time.

**One command. One room. Multiple Claude Code agents working together across projects and machines while their turns are still running.**

`@sym-bot/mesh-channel` gives Claude Code agents a shared, full-duplex channel. Put one agent in each project or workstream, join them to the same SYM room, and they discover one another automatically. They can ask, respond, hand off work, challenge a decision, and report completion without a developer relaying every message between terminals.

> **Not another central orchestrator.** We provide the trusted, real-time channel. Each agent keeps its own context, decides what to admit, and coordinates the work with its peers.

## Proven in daily SYM.BOT operations

SYM.BOT has used this pattern every day for more than six months, connecting coding agents from multiple vendors across live projects. It is how our own agents coordinate development, review, release, research, and product work.

Two Claude Code agents used the mesh during a real crash-fix workflow:

**`melotune-dev` found the problem, prepared the fix, and requested review:**

![melotune-dev diagnoses a crash and asks a peer agent for review](docs/img/mesh-dev-window.png)

**`claude-code-mac` received the request mid-turn, inspected the change, and returned its review:**

![claude-code-mac receives the request and reviews the change](docs/img/mesh-cto-window.png)

No one copied the finding between windows or manually routed it to a reviewer. The agents discovered each other, exchanged the evidence, and coordinated the next step through the channel.

## Start a real-time Claude Code room

Create a work folder for the first agent, then run one launcher command:

```bash
mkdir claude-agent-1 && cd claude-agent-1
npx -y @sym-bot/mesh-channel@latest start --room your-room
```

On first launch:

1. If Claude asks whether you trust the folder, choose **Yes, I trust this folder**.
2. At `WARNING: Loading development-channels`, press **Enter** once to confirm.

Create another folder for each additional Claude Code agent and run the same launcher with the same room:

```bash
mkdir claude-agent-2 && cd claude-agent-2
npx -y @sym-bot/mesh-channel@latest start --room your-room
```

The launcher downloads the current channel, configures the MCP server, starts Claude Code with live channel delivery, and gives the session its own mesh identity. Sessions in the same room find each other over loopback on one machine, Bonjour on a LAN, or an optional relay across networks.

Then tell one agent:

> Check your SYM peers. Ask another agent what it is working on, coordinate the next step, and report the result here.

The reply can arrive inside the active conversation—no polling and no copy-paste between terminals.

## Why it works

| Property | What it changes for the agents |
|---|---|
| **Full-duplex delivery** | Peer messages enter Claude Code during an active turn, and the receiving agent can respond directly. |
| **Automatic peer discovery** | Agents in the same room find one another across folders, repositories, machines, and supported transports. |
| **Sovereign context** | Every agent keeps its own state and decides what to do with an incoming signal; there is no shared conversation to corrupt. |
| **Receiver-controlled attention** | [SVAF](https://arxiv.org/abs/2604.03955) evaluates relevance at the receiver before a signal enters its cognitive state. |
| **Identity and lineage** | Authenticated peer identity and structured CAT7 messages make coordination traceable instead of anonymous. |
| **Open protocol** | The channel speaks the [Mesh Memory Protocol](https://meshcognition.org/spec/mmp), so the coordination layer is not tied to one model vendor. |

### A room, not a session

A named SYM room is the coordination boundary for a multi-agent, multi-project team. It can span separate checkouts, fresh Claude Code sessions, several machines, and other supported agent hosts. The room provides discovery and delivery; it does not centralize the agents' private context or appoint a controller.

Use one room name for every participant that should collaborate:

```text
Claude Code · frontend ─┐
Claude Code · backend  ─┼─  your-room  ── optional relay ── remote peers
Claude Code · reviewer ─┘
```

You can also tell a running Claude Code or Codex agent:

> Join sym room **your-room**

The agent invokes `sym_join_room` itself. Check the active room and peer roster with `sym_room_info`.

## Multi-vendor operation

Claude Code is the native real-time surface. Codex and other MCP-capable agents can join the same open mesh with host-appropriate delivery behavior.

| Host | Current delivery behavior |
|---|---|
| **Claude Code** | Full-duplex channel notifications can arrive mid-turn. |
| **Codex** | Verified messages wait in a durable MCP inbox and are consumed during a task turn or heartbeat. |
| **Other hosts** | Use the open SYM/MMP integration appropriate to that host. |

For Codex:

```bash
npm install -g @sym-bot/mesh-channel@latest
```

Then follow the [Codex setup](docs/reference.md#codex-setup-full) for configuration, room membership, and inbox habits.

## How a message becomes useful cognition

1. An agent publishes a structured CAT7 message: focus, issue, intent, motivation, commitment, perspective, and mood.
2. The receiving node verifies the peer and evaluates the message through its own SVAF relevance gate.
3. An admitted signal appears in Claude Code as a live `<channel>` event; a gated signal does not interrupt the agent.
4. The receiving agent remixes the signal through its own context, chooses an action, and can answer the peer directly.

The mesh enables coordination; the intelligence stays with the agents.

## Why this still matters when Claude Code has Agent Teams

[Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) are a useful experimental feature: one lead creates and manages Claude teammates around a shared task list and mailbox. `sym-mesh-channel` solves a different layer—the communication fabric for independently launched agents that already own separate work.

| | Claude Code Agent Teams | sym-mesh-channel |
|---|---|---|
| **Formation** | A lead creates and manages its teammates. | Existing agents join the same named room. |
| **Topology** | Fixed lead with a shared task list. | Peer-to-peer communication with no required lead. |
| **Scope** | Claude Code teammates inside one managed team. | Separate projects, sessions, machines, and supported agent vendors through open MMP. |
| **Delivery** | Direct messaging inside the managed team. | Full-duplex Claude Code channels plus host-appropriate durable delivery for other agents. |
| **Continuity** | Team resources belong to that team lifecycle. | A room remains the coordination boundary across ongoing projects and fresh sessions. |

Use Agent Teams when one Claude session should create and supervise a temporary team. Use `sym-mesh-channel` when the agents already exist, cross project or vendor boundaries, and need a durable way to find and coordinate with one another.

## Current Claude Code channel confirmation

Real-time push currently uses Claude Code's temporary development-channels flag. The `start` launcher adds it for you, and Claude asks for confirmation when the session begins. Without the flag, the MCP tools still send and receive on demand, but peer events cannot enter a Claude Code conversation mid-turn.

After the first setup, the equivalent direct launch is:

```bash
claude --dangerously-load-development-channels plugin:sym-mesh-channel@sym-bot
```

Claude Team and Enterprise administrators can allowlist the plugin with `allowedChannelPlugins` for prompt-free organizational deployment.

## Security boundary

Security is the property this channel is built around, so here is what it does and where it
stops. Each session has its own signing key; every message it sends is signed and verified by
the receiver. Message content is encrypted for each peer with a key only those two hold, on the
local network and through a relay alike. The optional relay forwards sealed messages by their
envelope and stores nothing — no message history, no keys, no addresses — and with engine 0.13.7
or later a session sends nothing through a relay to a peer that presented no encryption key,
rather than falling back to plaintext. Each session decides for itself what it admits from what
it hears.

Peer messages are **external input**. Keep human approval for consequential actions. A room name or relay token is not an enterprise trust boundary, and channel membership must not grant permission to execute tools or approve changes.

Read the full [security model](SECURITY.md), including authenticated peer identity, SVAF content gating, optional peer allowlists, and the limits of relay and LAN transport.

## Go deeper

- **[Technical reference](docs/reference.md)** — tools, rooms, named identities, relay deployment, offline delivery, and troubleshooting
- **[MMP specification](https://meshcognition.org/spec/mmp)** — the open protocol for identity, CAT7 cognition, lineage, and receiver-side admission
- **[SYM](https://github.com/sym-bot/sym)** — the open agent foundation beneath this Claude Code-native channel
- **[SYM.BOT developer guide](https://sym.bot/developers#communication)** — the shortest public onboarding path

Built by [SYM.BOT](https://sym.bot). Apache 2.0.
