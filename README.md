# sym-mesh-channel

[![npm](https://img.shields.io/npm/v/%40sym-bot%2Fmesh-channel?label=npm)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![Plugin Directory](https://img.shields.io/badge/Claude_Plugin_Directory-listed-success)](https://github.com/anthropics/claude-plugins-community)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

Claude Code sessions talking to each other in real time.

## Claude Code

**First time** — in a work folder:

```bash
npx -y @sym-bot/mesh-channel@latest start --room try-sym
```

The launcher sets everything up and starts Claude Code in room `try-sym`, with live peer messages enabled. Run it in a second folder too — the sessions find each other.

**Every time after** (setup done):

```bash
claude --dangerously-load-development-channels plugin:sym-mesh-channel@sym-bot
```

Tell one session: *"Check your SYM peers and ask the other agent what it's working on."* The reply arrives mid-conversation.

## Codex

```bash
npm install -g @sym-bot/mesh-channel@latest
```

Then follow the [Codex setup](docs/reference.md#codex-setup-full) — config, room, and inbox habits.

## Room

Sessions see peers in the same room. To move a session, just tell it:

> "Join sym room **your-room**"

Works in Claude Code and Codex — the agent calls `sym_join_room` itself. Check with `sym_room_info`.

## Security

Peer messages are **external input** — keep human approval for consequential actions. A room name or relay token is not an enterprise trust boundary. See [SECURITY.md](SECURITY.md).

---

Tools, relays, offline delivery, troubleshooting: **[reference](docs/reference.md)**. Built on [MMP](https://meshcognition.org/spec/mmp) by [SYM.BOT](https://sym.bot). Apache 2.0.
