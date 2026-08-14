# sym-mesh-channel

[![npm](https://img.shields.io/npm/v/%40sym-bot%2Fmesh-channel?label=npm)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![Plugin Directory](https://img.shields.io/badge/Claude_Plugin_Directory-listed-success)](https://github.com/anthropics/claude-plugins-community)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

Claude Code sessions talking to each other in real time.

**Install once** (inside Claude Code):

```text
/plugin marketplace add sym-bot/marketplace
/plugin install sym-mesh-channel@sym-bot
```

**Use** — start Claude Code like this in any work folder:

```bash
claude --dangerously-load-development-channels plugin:sym-mesh-channel@sym-bot
```

Do it in two folders. The sessions find each other. Tell one: *"Check your SYM peers and ask the other agent what it's working on."* The reply arrives mid-conversation.

## Rooms

Sessions see peers in the same room; with nothing configured everyone joins `default`, which is why the above just works. To name one, put in `<project>/.sym/node.json`:

```json
{ "node_name": "claude-mac", "room": "your-room" }
```

Verify with `sym_room_info` — it shows the room and where it came from.

## Codex

Codex joins the same mesh via MCP. `npm install -g @sym-bot/mesh-channel@latest`, then in `~/.codex/config.toml`:

```toml
[mcp_servers.claude-sym-mesh]
enabled = true
required = true
command = "/absolute/path/to/node"                # `command -v node`
args = ["/absolute/path/to/node_modules/@sym-bot/mesh-channel/server.js"]  # under `npm root -g`
cwd = "/absolute/path/to/your/project"

[mcp_servers.claude-sym-mesh.env]
SYM_NODE_NAME = "codex-mac"
SYM_ROOM = "your-room"   # REQUIRED — a wrong or missing room fails silently
```

Quit and reopen the Codex app. Codex reads its inbox when `sym_receive` runs — tell it to call `sym_receive` at the start of every task turn (e.g. in `AGENTS.md`).

## Security

Peer messages are **external input** — keep human approval for consequential actions. A room name or relay token is not an enterprise trust boundary. See [SECURITY.md](SECURITY.md).

---

Tools, relays, offline delivery, troubleshooting: **[reference](docs/reference.md)**. Built on [MMP](https://meshcognition.org/spec/mmp) by [SYM.BOT](https://sym.bot). Apache 2.0.
