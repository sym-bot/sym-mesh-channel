# Security Model

sym-mesh-channel implements defense in depth with three layers. No
single layer is the sole gate — all three must pass before a mesh
signal reaches Claude's conversation context.

## Layer 1: Transport and peer identity (MMP v2.0 Core Secure, sym 0.14)

- **A peer is a proven session.** Peers meet over loopback, Bonjour on the LAN, or a relay, and a
  peer exists only after the §5.2 handshake has proven its nodeId and identity key on that session.
  Nothing per-peer exists before that proof, and a failed handshake keeps no state.
- **Every record is signed and verified.** A record is a signed `mmp-sig-v2.0` record; the
  receiving node resolves the author's key by its signed `createdByNodeId` and verifies the
  signature, the application bytes, the assertion identity and the audience (§8.8.5) before the
  record reaches the channel. An unsigned or unverifiable record is refused by the node.
- **Every record travels sealed** per session (`cmb-encrypted`), on every transport. A relay forwards
  sealed frames by their envelope and stores nothing; it still admits a connection by its token
  (`SYM_RELAY_TOKEN`), and channels on different tokens cannot see each other.
- **Keys are bound once.** The first proven session binds a nodeId to its key. An invite pins its
  issuer's key out of band (`sym_join_room {invite}`), and a different key for a bound nodeId is a
  conflict the operator resolves (`sym_status` lists conflicts), never an override.

**Trust on first proven use.** With no invite, anchor or grant, a peer you have never met is bound
to the key its first session proves. Join with an invite from someone you trust to remove that risk.

**What the channel adds (design D2, D6).**

- A delivery reaches the session only with the verification facts the node gave for it (signer
  nodeId and key source, directed or room-bound, relayed or direct). A delivery without them — one
  that arrived on a Legacy Import session, one received before this node ran Core Secure, or one with
  no verification — is listed by id and reason and never shown, on every surface.
- Names are labels. `to`, the allowlist, the own-record check and the outbox key on nodeIds; the
  push rate counts per delivering session. A line prints the signer's label beside the last 8
  characters of its nodeId, so two nodes that share a label are told apart.

**Known limits (sym design §5).** `relay-auth` is not yet proven, so whoever holds a relay token can
evict a node from that relay (it then re-handshakes, and the evicting party gets no session). There
is no key rotation. A process running as the same user can read identity files.

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
- **Own-record filtering**: a record signed by this node's own nodeId and relayed back is counted,
  never pushed (prevents feedback loops).
- **No peer text at instruction level**: the MCP instructions say who this node is and how the tools
  work. They carry no record text; `sym_recall` returns memory as a tool result, through the policy
  below.
- **Push is stated, not guessed**: whether `<channel>` notifications reach the model is stated by the
  model, with the code from a push check it received (`sym_push_confirm`). The server reads no
  process tree and no launch line.

## Receiver-side content policy

Every delivery is judged the same way wherever its text could enter the
session: the real-time channel push, `sym_receive`, `sym_fetch` and
`sym_recall` (a peer's stored memory).

- **Verified**: a delivery with no verification facts is withheld (Layer 1).
- **Signer**: when `SYM_ALLOWED_PEERS` is set, a signer outside it is not shown.
- **Payload size**: a payload larger than `SYM_MAX_PAYLOAD_BYTES` (default
  1048576) is not shown. The payload is the record's signed application section, which MMP bounds
  at 512 KiB.
- **Prompt-injection patterns**: the text of every CAT7 field, the message's
  content string and the payload are matched against known instruction-override
  phrasings (persona overrides, fabricated system or tool-call markup,
  "ignore previous instructions" and the like).

A delivery that fails a check is **withheld**: the session sees its id, the
sender's name and the reason, and none of the message. It is never left out of
the count. `sym_receive` lists each withheld delivery (deliveries from senders
outside the allowlist are counted by sender), `sym_fetch` on its id answers with
the reason, and an audit line goes to stderr. The delivery stays in the node's
inbox, which keeps the newest 500 deliveries across restarts, so raising
`SYM_MAX_PAYLOAD_BYTES` and restarting makes an over-limit message readable
while it is still there. A message (a directed record of sym's message schema) and a mood are kept
in the channel's own memory, not the durable inbox, so a restart loses those that were not read.

A sender chooses its own label, so every line prints it with line breaks,
brackets, control characters and this server's own line markers replaced, and the audit line drops
control characters and quotes from its excerpt. A record signed by this node's own nodeId is not
shown in `sym_receive`; its id is listed.

A payload within the limit is announced on the header with its size and read on
demand. `sym_fetch` returns a long message in parts of at most 48,000
characters, each naming the offset of the next.

`SYM_RATE_LIMIT` (default 30) is how many deliveries from one session per minute
are pushed in real time, withheld-delivery notices included. Beyond it the push
is held back, not the delivery: the message waits for `sym_receive`.

Wording that tends to trip a model's usage-policy classifier is quarantined on
the push and in `sym_receive`: the line shows the sender and a count of flagged
terms, and the text is read only through a deliberate `sym_fetch`.

Limits: pattern matching catches known phrasings, not every attempt. A verified signature proves
who wrote a message, not that it is safe to act on. Treat every peer message as external input.

## Optional: Peer Allowlist

Set `SYM_ALLOWED_PEERS` (comma-separated **nodeIds**) to restrict whose records can reach Claude's
context. It is judged against the verified signer, so a listed peer's record relayed by another
peer is still that peer's. When set, only listed signers pass, and `sym_receive` counts the rest by
signer, so a delivery from an unlisted peer is never reported as no delivery. When empty (default),
every peer this node verified is eligible — SVAF still gates on content relevance.

Names are labels, not identities, so an entry that is not a nodeId is ignored and reported. A list
that holds no nodeId at all allows **nothing**: an operator who set it meant to restrict, and a 0.10
list of names must not silently allow everyone. `sym_peers` shows each peer's nodeId.

Example:
```
SYM_ALLOWED_PEERS=01a0fd15-52ca-726c-9ce1-5767a1379249,01a0fd15-52ca-77cd-bc1c-8eef67a748e6
```

## Interior mode

With `SYM_INTERIOR_SOCKET` set, the channel is a node's mind (sym design D8, D9.3): it holds no key
and no store, and submits drafts the node checks (audience, size, rate, declared kinds, parents in
its store) and signs as itself.

- The capability is a bearer token for one mission. Prefer `SYM_INTERIOR_CAPABILITY_FILE` (mode
  0600; the channel warns when it is readable by others) over `SYM_INTERIOR_CAPABILITY`, since a
  process's environment is readable by its user.
- The socket is the node's (0600). When the host's stdin closes, the channel ends the mind, which
  revokes the capability.
- sym 0.14's interior serves no read side, so in interior mode the mind cannot read the node's
  deliveries; `sym_receive` says so.

## Token Handling

- `SYM_RELAY_TOKEN`: passed via environment variable, never logged,
  never included in CMBs or channel notifications. In the plugin
  manifest, marked `sensitive: true` (stored in system keychain).
- Ed25519 private key: stored at `~/.sym/nodes/by-id/<nodeId>/identity.json` (sym 0.14; the name is
  an index), never transmitted. The handshake proves possession of it without sending it.
- An invite URL is a secret: a team invite carries the relay token. It is also integrity-sensitive:
  whoever edits its `key` before it is accepted chooses whom the acceptor pins.

## Identity Collision

An identity is held by one live process at a time, through a lock in its node directory. A
`node_id` in `.sym/node.json` (or `SYM_NODE_ID`) pins the folder's agent: the identity is loaded
without minting, and a missing or tombstoned one stops the node instead of creating a replacement.

- **A second process with the same name on this machine:** the server starts without a mesh node,
  so it never forks a second identity. Its instructions and every mesh tool say which name is held,
  by which PID, and how to fix it.
- **Windows:** the lock cannot yet tell a live holder from a crashed session whose PID has been
  reused. If no process with that PID is this agent, delete the lock file named in the message.
- **Relay:** when the relay reports another connection holding this node's identity (close code
  4004), the server exits with code 2 rather than competing for it.

## References

- [MMP v2.0 Specification](https://meshcognition.org/spec/mmp) — Sections 5 (Connection), 8 (CAT7 and §8.8 records), 9 (SVAF, §9.2.2 delivery), 18 (Core Secure)
- [docs/DESIGN-0.11.0.md](docs/DESIGN-0.11.0.md) — the channel's design on sym 0.14
- [SVAF Paper](https://arxiv.org/abs/2604.03955) — Xu, 2026
