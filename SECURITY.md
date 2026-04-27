# Security Model

sym-mesh-channel implements defense in depth with three layers. No
single layer is the sole gate — all three must pass before a mesh
signal reaches Claude's conversation context.

## Layer 1: Transport Authentication

Only authenticated peers can send signals to this node.

- **LAN (Bonjour)**: peers discover each other via mDNS on the local
  network. Each peer has an Ed25519 keypair generated at first run
  and stored at `~/.sym/nodes/<name>/identity.json`. Peer identity is
  verified via cryptographic handshake (MMP Section 5).
- **Relay (WebSocket)**: peers authenticate with a shared relay token
  (`SYM_RELAY_TOKEN`). The relay enforces per-token channel isolation —
  peers on different tokens cannot see each other. Unauthenticated
  connections are rejected at the transport level.

No unauthenticated source can reach `pushChannel()`.

## Layer 2: Protocol-Level Content Gating (SVAF)

Every incoming CMB is evaluated by Symbolic-Vector Attention Fusion
before it enters cognitive state. SVAF computes per-field drift across
7 semantic dimensions (CAT7: focus, issue, intent, motivation,
commitment, perspective, mood) and operates in three regimes:

- **Aligned** (drift < threshold): CMB is accepted and stored
- **Guarded** (drift moderate): only the mood field is delivered (protocol guarantee R5)
- **Rejected** (drift high): CMB is silently dropped

This is analogous to a content-aware firewall: it doesn't just check
who sent the signal — it evaluates whether the signal is semantically
relevant to the receiver's current context. Low-relevance CMBs are
gated out so Claude's context window doesn't drown.

SVAF field weights are configurable per node (`svafFieldWeights` in
server.js). The default weights are tuned for engineering-domain
Claude Code sessions.

## Layer 3: Application-Level Restrictions

- **No code execution**: incoming mesh signals are text-only CMB fields.
  No mesh peer can trigger Bash commands, file writes, or tool calls
  on this node.
- **No permission relay**: the `claude/channel/permission` capability is
  explicitly NOT declared. Mesh peers cannot approve or deny tool
  executions on this node.
- **No arbitrary content injection**: incoming CMBs are formatted as
  structured `[source] focus (mood)` text before being pushed to
  Claude's context. Raw JSON is never injected.
- **Self-echo filtering**: CMBs from this node's own identity are
  dropped before `pushChannel()` (prevents feedback loops).

## Optional: Peer Allowlist

Set `SYM_ALLOWED_PEERS` (comma-separated node names) to restrict which
authenticated peers can push to Claude's context. When set, only CMBs
and messages from listed peers pass the gate. When empty (default), all
authenticated peers are accepted — SVAF still gates on content relevance.

Example:
```
SYM_ALLOWED_PEERS=claude-code-mac,claude-code-win
```

This is an additional layer, not a replacement for transport auth or
SVAF. It provides explicit identity-level control for environments
that require it.

## Token Handling

- `SYM_RELAY_TOKEN`: passed via environment variable, never logged,
  never included in CMBs or channel notifications. In the plugin
  manifest, marked `sensitive: true` (stored in system keychain).
- Ed25519 private key: stored at `~/.sym/nodes/<name>/identity.json`,
  never transmitted. Only the public key is shared during handshake.

## Identity Collision

If another process is already running with the same node identity,
the relay returns close code 4004. The server exits cleanly with
exit code 2 rather than competing for the identity.

## References

- [MMP v1.0 Specification](https://meshcognition.org/spec/mmp) — Sections 5 (Connection), 8 (CAT7), 9 (SVAF)
- [SVAF Paper](https://arxiv.org/abs/2604.03955) — Xu, 2026
