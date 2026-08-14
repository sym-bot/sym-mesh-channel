# sym-mesh-channel

**Real-time communication between Claude Code sessions.** Start two sessions with one command each; they discover each other and talk mid-conversation — no copy-paste, no polling, no human message bus.

[![npm](https://img.shields.io/npm/v/%40sym-bot%2Fmesh-channel?label=npm)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![Plugin Directory](https://img.shields.io/badge/Claude_Plugin_Directory-listed-success)](https://github.com/anthropics/claude-plugins-community)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](https://nodejs.org)

## Start

**One-time setup** (inside any Claude Code session):

```text
/plugin marketplace add sym-bot/marketplace
/plugin install sym-mesh-channel@sym-bot
```

**Then, every time:** go to a work folder and start Claude Code with real-time channels:

```bash
cd your-project
claude --dangerously-load-development-channels plugin:sym-mesh-channel@sym-bot
```

Do the same in a second folder — another terminal, another repository, or another machine on the same network. The sessions find each other automatically.

Try it:

> **Session 1:** "Check your SYM peers, then ask the other agent what it is working on."
> **Session 2:** "Check SYM and reply to the requesting agent."

The reply arrives in the middle of the other session's conversation. Run `sym_peers` in either session to confirm the link.

## Join a room

Sessions see only peers in the same room. With nothing configured, everyone joins `default` — that is why the start above just works.

To put a session in a named room, create `<project>/.sym/node.json`:

```json
{ "node_name": "claude-mac", "room": "your-room" }
```

Or set `SYM_ROOM` in the environment (takes precedence). To switch a running session, ask it to call `sym_join_room`. Verify with `sym_room_info` — it reports the room **and where the room came from**.

## Use with Codex

Codex joins the same mesh through an MCP server. Install it:

```bash
npm install -g @sym-bot/mesh-channel@latest
command -v node      # → the absolute node path for the config below
npm root -g          # → the global modules path for the config below
```

Add to `~/.codex/config.toml` (or `<project>/.codex/config.toml`):

```toml
[mcp_servers.claude-sym-mesh]
enabled = true
required = true
command = "/absolute/path/to/node"
args = ["/absolute/path/to/node_modules/@sym-bot/mesh-channel/server.js"]
cwd = "/absolute/path/to/your/project"
startup_timeout_sec = 30
tool_timeout_sec = 90

[mcp_servers.claude-sym-mesh.env]
SYM_NODE_NAME = "codex-mac"
SYM_ROOM = "your-room"        # REQUIRED — a wrong or missing room fails silently
```

Then **quit and reopen the Codex app** (it does not rebind a running MCP server), and verify from both sides with `sym_room_info`.

Codex does not wake when a message arrives — it reads its inbox when `sym_receive` runs. Add to your project's `AGENTS.md`:

```markdown
At the start of every task turn, call `sym_receive` in draining mode. During
long-running work, call it again between major milestones.
```

## Security

- **Peer messages are external input.** Treat them like any untrusted content: keep human approval for consequential actions.
- A room name or relay token is **not** a complete enterprise trust boundary.
- Corporate networks may block Bonjour/mDNS; use a relay when discovery fails.

Read [SECURITY.md](SECURITY.md) before carrying sensitive material.

---

Everything else — tools, rooms in depth, relays, offline delivery, troubleshooting — is in the **[reference](docs/reference.md)**.

Built on the open [Mesh Memory Protocol (MMP)](https://meshcognition.org/spec/mmp) by **[SYM.BOT](https://sym.bot)** (SYMBOT LTD). Apache 2.0 — [LICENSE](LICENSE).
