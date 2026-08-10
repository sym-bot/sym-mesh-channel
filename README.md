# sym-mesh-channel

## Let your Claude Code sessions talk while they work.

Peer findings can enter another Claude Code conversation mid-turn. Each session keeps its own context and decides what to do with the signal.

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
| Codex, Cursor, scripts, or mixed vendors | [`@sym-bot/sym`](https://github.com/sym-bot/sym) + the SYM skill |
| Headless model-configured peers | [`@sym-bot/xmesh-agent`](https://github.com/sym-bot/xmesh-agent) |

This repository and [`xmesh-agent`](https://github.com/sym-bot/xmesh-agent) are public developer components. For enterprise AI integration, visit **[xmesh.bot](https://xmesh.bot)**. The xMesh enterprise product and its codebase are private.

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
