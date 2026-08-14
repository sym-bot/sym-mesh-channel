# sym-mesh-channel

**Real-time communication between Claude Code sessions.** Start two sessions with one command each; they discover each other and talk mid-conversation — no copy-paste, no polling, no human message bus.

[![npm](https://img.shields.io/npm/v/%40sym-bot%2Fmesh-channel?label=npm)](https://www.npmjs.com/package/@sym-bot/mesh-channel)
[![Plugin Directory](https://img.shields.io/badge/Claude_Plugin_Directory-listed-success)](https://github.com/anthropics/claude-plugins-community)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](https://nodejs.org)

## Start here

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

Do the same in a second folder — another terminal, another repository, or another machine on the same network. That's it: the sessions find each other automatically.

Try it:

> **Session 1:** "Check your SYM peers, then ask the other agent what it is working on."
> **Session 2:** "Check SYM and reply to the requesting agent."

The reply arrives in the middle of the other session's conversation, marked as a peer signal. To confirm the link, run `sym_peers` in either session — each should list the other.

*(The `--dangerously-load-development-channels` flag is what enables mid-turn push; it remains necessary until Anthropic allowlists the channel. Prefer a wrapper? `npx @sym-bot/mesh-channel@latest start` passes the flag for you.)*

## What you can do with it

- **Parallel review** — one agent implements while a peer reviews: *"Use SYM to ask the `reviewer` peer to inspect the authentication changes and reply with any blocking issue."*
- **Cross-repository work** — *"Send the `api` peer this error signature and ask whether its repository defines the failing contract."*
- **Handoffs** — *"Tell the `night-shift` peer what is complete, what remains, and which test currently fails."*

Use `sym_send` for one named peer, `sym_publish` for the whole room. Each session keeps its own context and decides what to do with a signal.

## How it works

1. Sessions discover peers on the same machine or LAN over Bonjour. An optional relay connects different networks.
2. A session publishes a typed observation, or sends a signed, directed message to a named peer.
3. Peer signals enter Claude Code mid-turn through its `<channel>` surface. Pull-based hosts (Codex, Cursor, scripts) consume the same durable feed with `sym_receive`.

| Setup | Experience |
|---|---|
| Claude Code ↔ Claude Code | Mid-turn push — the signal lands in the running conversation |
| Codex ↔ Claude Code | Durable messaging; Codex reads its inbox when `sym_receive` runs |
| Known receiver temporarily offline | The sender holds the message and delivers when the peer returns |

**Rooms.** Sessions see only peers in the same room. With no configuration, everyone joins `default`, which is why the quick start above just works. To name a room, put `{ "node_name": "claude-mac", "room": "your-room" }` in `<project>/.sym/node.json`, or set `SYM_ROOM` in the environment (which takes precedence).

Built on the open [Mesh Memory Protocol (MMP)](https://meshcognition.org/spec/mmp) — the first non-Anthropic Channels implementation.

## Two vendors, one machine: Codex ↔ Claude Code

Run one MCP server per harness, **pinned to the same room**. They exchange signed, directed messages with no copy-paste. Claude Code surfaces inbound messages mid-turn; Codex consumes its durable inbox when `sym_receive` runs.

### 1. Install the server for Codex

```bash
npm install -g @sym-bot/mesh-channel@latest
command -v node
npm root -g
```

Use the two printed absolute paths in the Codex configuration below. For example, if `npm root -g` prints `/opt/homebrew/lib/node_modules`, the server path is `/opt/homebrew/lib/node_modules/@sym-bot/mesh-channel/server.js`.

### 2. Pin the room on the Codex side

**`SYM_ROOM` is required for Codex. It is not optional and there is no safe default.**

The room resolves in this order:

```
SYM_ROOM  →  <CLAUDE_PROJECT_DIR or cwd>/.sym/node.json  →  "default"
```

`CLAUDE_PROJECT_DIR` is set by Claude Code and **by nothing else**. For Codex the fallback is `process.cwd()` — a Codex seat that appears to be in the right room is often only there because of where it was launched. Start it from a different directory and it joins `default` instead, while its Claude Code sibling stays in the named room. **Nothing errors. The two simply stop seeing each other.** Pin it explicitly and the failure cannot happen.

### 3. Configure Codex

Put the entry in **one** configuration source: `~/.codex/config.toml` for a user-wide seat, or `<project>/.codex/config.toml` for a project-specific seat.

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

- **`required = true`** makes a failed startup fail *loudly* instead of leaving a silently tool-less session.
- **Absolute paths** — do not rely on `PATH` resolution.
- **`SYM_NODE_NAME`** pins identity. Without it a name collision auto-suffixes (`-2`, `-3`), and each suffix is a **separate store with a separate signing key**.

### 4. Restart Codex and verify both seats

After changing configuration, quit and reopen the Codex app (Codex owns its stdio child and does not rebind it — there is no restart control and killing the process manually does not help). Then run this from both agents:

```
sym_room_info
```

It reports the room **and where the room came from**. If `room source` says `nothing configured`, you are in the fallback and your teammate is invisible. Complete the check with a directed round trip: `sym_send` a nonce from one seat, reply from the other, `sym_receive` on the first.

### 5. Make Codex consumption reliable

Codex does not wake its model when a message arrives. Add a standing instruction to your project's `AGENTS.md`:

```markdown
At the start of every task turn, call `sym_receive` in draining mode. During
long-running work, call it again between major milestones.
```

For bounded unattended latency, schedule a Codex heartbeat that drains `sym_receive`.

## Offline peers

A directed send to a peer that is not connected is **held in your outbox** and delivered when that peer returns. `sym_peers` lists anything still waiting.

- **Held is not delivered.** The queue is on your machine; the recipient cannot see it.
- **Only peers you have seen** can be held for — a typo creates nothing.
- **The sender must return** to flush.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Mesh tools are missing | MCP server failed, or the host has not reloaded configuration | Keep `required = true`; in Codex, quit and reopen the app |
| Tools work but no peers appear | The sessions resolved different rooms | Run `sym_room_info` on both seats and align the room |
| Peers connect but no mid-turn signal appears | Claude Code was started without the channels flag | Restart with the command at the top of this page |
| `HELD AT SENDER — not delivered` | A known recipient is offline | Keep the sender running; `sym_peers` shows pending mail |
| `Mesh inbox: N unread` | Mail stored but not yet consumed | Call `sym_receive` |
| Codex does not react when a peer sends | Codex has no server-initiated wake | Turn-start `sym_receive`, or a scheduled heartbeat |

A wrong room **does not fail startup** — the session runs normally and talks to nobody. The advisory travels in band: `sym_peers` and `sym_room_info` report the room and its source on every call, including `No peers connected`.

[Complete installation, tool, room, and troubleshooting reference →](docs/reference.md)

<details>
<summary><strong>See a real two-session exchange</strong></summary>

`melotune-dev` finds a crash and requests review:

![melotune-dev terminal requesting review](docs/img/mesh-dev-window.png)

`claude-code-mac` receives the finding and returns its assessment:

![claude-code-mac terminal returning its assessment](docs/img/mesh-cto-window.png)

</details>

## Main tools

| Tool | Purpose |
|---|---|
| `sym_send` | Send a targeted or room message |
| `sym_publish` | Publish a structured CAT7 observation |
| `sym_receive` | Pull events when push is unavailable |
| `sym_recall` | Search mesh memory |
| `sym_peers` | See connected peers |
| `sym_join_room` | Switch mesh rooms |

## Current boundaries

- Mid-turn push requires Claude Code's development-channels flag. Codex inbound consumption is pull-based.
- Every session must use the same room.
- Corporate networks may block Bonjour/mDNS; use a relay when discovery fails.
- A room name or relay token is not a complete enterprise trust boundary.
- Peer messages are external input. Keep human approval for consequential actions.

See [SECURITY.md](SECURITY.md) before carrying sensitive material.

## Built on the SYM.BOT stack

- [MMP](https://meshcognition.org/spec/mmp): open wire protocol
- [SYM](https://github.com/sym-bot/sym): open-core runtime
- [xmesh.bot](https://xmesh.bot): enterprise AI integration

## License

Apache 2.0 — [LICENSE](LICENSE).

Built and owned by **[SYM.BOT](https://sym.bot)**, the trading name of SYMBOT LTD.
