# sym-mesh-channel

## Let your coding agents talk while they work — including across vendors.

Peer findings can enter another agent's conversation mid-turn. Each session keeps its own context and decides what to do with the signal.

Claude Code ↔ Claude Code, and **Codex ↔ Claude Code on the same machine**: one MCP server per harness, both pinned to the same room. See [Two vendors, one machine](#two-vendors-one-machine-codex--claude-code).

[![npm](https://img.shields.io/npm/v/%40sym-bot%2Fmesh-channel?label=npm)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![Plugin Directory](https://img.shields.io/badge/Claude_Plugin_Directory-listed-success)](https://github.com/anthropics/claude-plugins-community)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](https://nodejs.org)

## Try it now

### If you are the human

Open two terminals in two projects. Run this in each:

```bash
npx @sym-bot/mesh-channel@latest start --room try-sym
```

When both Claude Code sessions open:

1. Tell the first: **“Use SYM to send the other agent what you are working on.”**
2. Tell the second: **“Check the mesh, respond to the first agent, and tell me what you received.”**

Success means the second session sees a sourced peer signal without you copying it between windows.

### If you are a Claude Code agent

1. Run `sym_status` and confirm your room.
2. Run `sym_peers` and confirm at least one other session is present.
3. If the room is wrong, call `sym_join_room` with the human's shared room name.
4. Publish a CAT7 introduction: your role, repository, current task, and any blocker.
5. When a peer signal arrives, process it through your own expertise and reply.

If the mesh tools are unavailable, you cannot add the channel to the current Claude process yourself. Tell the human to run the command above and restart you through that session.

## What happens

1. Sessions discover peers on the same machine or LAN. An optional relay connects different networks.
2. One session publishes a typed observation to the mesh.
3. Relevant peer signals enter Claude Code through its `<channel>` surface—without polling.

No one maintains a routing graph or copies findings between windows.

## Choose the right package

| Your agents | Use |
|---|---|
| Claude Code sessions that need mid-turn push | **This package:** `@sym-bot/mesh-channel` |
| **Codex ↔ Claude Code, in real time** | **This package**, one MCP server per harness — see [Two vendors, one machine](#two-vendors-one-machine-codex--claude-code) |
| Cursor, scripts, or other MCP hosts | **This package** if the host speaks MCP over stdio; otherwise [`@sym-bot/sym`](https://github.com/sym-bot/sym) + the SYM skill |
| Headless model-configured peers | [`@sym-bot/xmesh-agent`](https://github.com/sym-bot/xmesh-agent) |

This repository and [`xmesh-agent`](https://github.com/sym-bot/xmesh-agent) are public developer components. For enterprise AI integration, visit **[xmesh.bot](https://xmesh.bot)**. The xMesh enterprise product and its codebase are private.

## Two vendors, one machine: Codex ↔ Claude Code

Run one MCP server per harness, **pinned to the same room**. They then exchange CAT7 CMBs in real time — a Codex task and a Claude Code session, on one box, no copy-paste.

### The one rule: pin the room on the Codex side

**`SYM_ROOM` is required for Codex. It is not optional and there is no safe default.**

The room resolves in this order:

```
SYM_ROOM  →  <CLAUDE_PROJECT_DIR or cwd>/.sym/node.json  →  "default"
```

`CLAUDE_PROJECT_DIR` is set by Claude Code and **by nothing else**. For Codex the fallback is `process.cwd()` — so a Codex seat that appears to be in the right room is often only there because of where it happened to be launched. Start it from a different directory and it joins `default` instead, while its Claude Code sibling stays in the named room. **Nothing errors. The two simply stop seeing each other**, which reads exactly like a quiet mesh.

Pin it explicitly and the failure cannot happen.

### Codex — `.codex/config.toml`

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
SYM_ROOM = "your-room"        # REQUIRED — see above
```

- **`required = true`** makes a failed mesh-channel startup fail *loudly* instead of leaving you with a silently tool-less session.
- **Absolute paths** — do not rely on `PATH` resolution.
- **`SYM_NODE_NAME`** pins identity. Without it a name collision auto-suffixes (`-2`, `-3`), and each suffix is a **separate store with a separate signing key**.

### Claude Code — plugin or `.mcp.json`

```bash
/plugin marketplace add sym-bot/marketplace
/plugin install sym-mesh-channel
```

Claude Code reads `$CLAUDE_PROJECT_DIR/.sym/node.json`, so a per-project pin works without touching env:

```json
{ "node_name": "claude-mac", "room": "your-room" }
```

Setting `SYM_ROOM` in the MCP server's env works too and takes precedence.

### Verify — from either side

```
sym_room_info
```

It reports the room **and where the room came from**:

```
room: your-room
room source: SYM_ROOM env
peers in room: 2
  codex-mac (019f8c9f) via bonjour
```

If `room source` says `nothing configured`, you are in the fallback and your teammate is invisible.

### What a wrong room actually looks like

**A wrong room does not fail startup.** The server launches, the tools work, and the session runs normally — it simply talks to nobody. `required = true` cannot catch this: it catches a server that *fails to start*, which this isn't.

Where the warning appears:

| Surface | Shown? |
|---|---|
| MCP `initialize` instructions, `sym_peers`, `sym_room_info` | **Yes — every host** |
| Server stderr at startup | Not in all hosts — Codex CLI 0.144.0 does not show it |

So the advisory also travels in band, in the tool responses themselves:

```
MESH ROOM ADVISORY: the sym daemon is in room 'sym-bot-room' (~/.sym/room)
but this node resolved 'sym-bot-rooom' from SYM_ROOM env. They cannot see
each other. Call sym_join_room with room="sym-bot-room", or fix the config.
```

`sym_peers` reports the room and its source on **every** call, including `No peers connected` — the moment you're most likely to be asking why.

A typo is the common case: `SYM_ROOM = "sym-bot-rooom"` is valid and joins a real, empty room.

### What `required = true` does catch

A server that cannot launch — it exits 1 before the session is created:

```
Failed to create session: required MCP servers failed to initialize
```

With `required = false` the same fault exits 0 and the session runs silently tool-less. Keep `required = true`.

### Restarting Codex after a config change

Codex owns its stdio child; **do not kill the MCP process manually** — Codex does not rebind that transport within the same task. Verified on a current Codex desktop build: there is **no** Settings → MCP servers → Restart control, and `/mcp` is treated as ordinary message text. **Quit and reopen the app**, which recreates the app server and the stdio transport.

### Offline peers

A directed send to a peer that is not connected is **held in your outbox** (0.7.0+) and sent when that peer appears. `sym_peers` lists anything still waiting.

- **Held is not delivered.** The queue is on your machine and the recipient cannot see it. If your node does not come back, the message is lost.
- **Only peers you have seen** can be held for. Unknown names are refused, so a typo creates nothing.
- **The sender must return** to flush. This does not help when the *sender* is the intermittent one.

## Prefer the plugin UI?

```text
/plugin marketplace add sym-bot/marketplace
/plugin install sym-mesh-channel@sym-bot
```

The MCP tools work immediately. Mid-turn push currently requires:

```bash
claude --dangerously-load-development-channels plugin:sym-mesh-channel@sym-bot
```

The `start` command passes this flag for you. The flag remains necessary until Anthropic allowlists the channel.

<details>
<summary><strong>See a real two-session exchange</strong></summary>

`melotune-dev` finds a crash and requests review:

![melotune-dev terminal requesting review](docs/img/mesh-dev-window.png)

`claude-code-mac` receives the finding and returns its assessment:

![claude-code-mac terminal returning its assessment](docs/img/mesh-cto-window.png)

</details>

## Current boundaries

- Real-time push requires Claude Code's development-channels flag.
- Every session must use the same room.
- Corporate networks may block Bonjour/mDNS; use a relay when discovery fails.
- A room name or relay token is not a complete enterprise trust boundary.
- Peer messages are external input. Keep human approval for consequential actions.

See [SECURITY.md](SECURITY.md) before carrying sensitive material.

## Main tools

| Tool | Purpose |
|---|---|
| `sym_send` | Send a targeted or room message |
| `sym_publish` | Publish a structured CAT7 observation |
| `sym_receive` | Pull events when push is unavailable |
| `sym_recall` | Search mesh memory |
| `sym_peers` | See connected peers |
| `sym_join_room` | Switch mesh rooms |

[Complete installation, tool, room, and troubleshooting reference →](docs/reference.md)

## Built on the SYM.BOT stack

- [MMP](https://meshcognition.org/spec/mmp): open wire protocol
- [SYM](https://github.com/sym-bot/sym): open-core runtime
- [xmesh-agent](https://github.com/sym-bot/xmesh-agent): public open-source headless runtime
- [xmesh.bot](https://xmesh.bot): enterprise AI integration

## License

Apache 2.0 — [LICENSE](LICENSE).

Built and owned by **[SYM.BOT](https://sym.bot)**, the trading name of SYMBOT LTD.
