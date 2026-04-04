# sym-mesh-channel

MCP server that makes Claude Code a peer node on the [SYM mesh](https://sym.bot).

This is a **peer node**, not a client. It has its own identity, its own relay connection, and its own SVAF evaluation with domain-specific field weights.

## Setup

### 1. Install

```bash
git clone https://github.com/sym-bot/sym-mesh-channel.git
cd sym-mesh-channel
npm install
```

### 2. Configure Claude Code

Add to `~/.claude/mcp.json` (macOS/Linux) or `%USERPROFILE%\.claude\mcp.json` (Windows):

```json
{
  "mcpServers": {
    "sym-mesh-channel": {
      "command": "node",
      "args": ["/absolute/path/to/sym-mesh-channel/server.js"],
      "env": {
        "SYM_RELAY_URL": "wss://your-relay-url",
        "SYM_RELAY_TOKEN": "your-token"
      }
    }
  }
}
```

### 3. Restart Claude Code

The MCP server loads on startup. Run `/mcp` to verify connection.

## Tools

| Tool | Description |
|------|-------------|
| `sym_send` | Broadcast a message to all mesh peers |
| `sym_observe` | Share a structured CAT7 observation |
| `sym_recall` | Search mesh memory |
| `sym_peers` | List connected peers |
| `sym_status` | Node status — relay, peers, memory count |

## Architecture

```
Claude Code ←stdio→ sym-mesh-channel (SymNode) ←wss→ relay ←wss→ other peers
```

- **Outbound**: Claude Code calls MCP tools → SymNode sends to mesh
- **Inbound**: Mesh events → SymNode → MCP channel notifications → Claude Code

## Requirements

- Node.js >= 18
- Claude Code with MCP support
- A SYM relay server (see [sym-relay](https://github.com/sym-bot/sym-relay))

## License

Apache 2.0 — SYM.BOT Ltd
