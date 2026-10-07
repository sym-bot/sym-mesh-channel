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

**What the channel adds (design D2, D3, D8).**

- **Provenance travels with the delivery.** A delivery is shown as verified only when its own entry
  says so: marked verified, on a Core Secure session, with facts whose author nodeId and key match the
  entry's author and whose delivering session matches the one that delivered it. Anything else — a
  Legacy Import record, an entry with no Core Secure provenance, facts that do not match — is listed
  by id and reason and never shown, on every surface. sym persists the facts with the inbox item, and
  the channel keeps no second store of them. A message or a mood, which sym raises as an event, is
  shown as verified only when the event names its verified author and the node binds a key to that
  author (`node.keyBindings()`); a mood frame, which carries no signed record, never is.
- **A signer is identified by its key, never by a truncated label or nodeId.** A label is chosen by
  its sender, and so is a nodeId (a UUID v7 a node picks, not one derived from its key): anyone can
  mint a nodeId whose last characters equal another node's. A line shows the signer's label and the
  shortest suffix of its key fingerprint (SHA-256 of the public key) that is unique among the key
  bindings this node knows, at least 8 hex characters. When two known keys use the same label, the
  line says so ("alice (2 keys)") and shows the longer suffix that tells them apart; when one key is
  seen or bound under two nodeIds, it says that ("one key, 2 nodeIds"). `sym_fetch` shows the full
  nodeId and the full fingerprint, `sha256:<hex>` as sym gives it. A first-contact peer's key is held
  for its session only until a verified record from it is admitted, and the fetch account says so.
- Names are labels. `to`, the allowlist, the own-record check and the outbox key on nodeIds; the
  push rate counts per proven sender.

**Known limits (sym design §5).** `relay-auth` is not yet proven, so whoever holds a relay token can
evict a node from that relay (it then re-handshakes, and the evicting party gets no session). There
is no key rotation. A process running as the same user can read identity files.

## Layer 2: Protocol-Level Content Gating (SVAF)

Every incoming CMB is evaluated by Symbolic-Vector Attention Fusion
before it enters cognitive state. SVAF computes per-field drift across
7 semantic dimensions (CAT7: focus, issue, intent, motivation,
commitment, perspective, mood) and operates in three regimes:

- **A room-bound CMB** that SVAF admits (aligned or guarded) is stored and delivered. One it rejects
  is neither stored nor delivered (§9.2.2); the node records the decision in its own decision log.
  Its mood alone is still delivered (§9.3), and the channel shows that mood only when the SDK ties it
  to the verified record and its proven sender.
- **A directed CMB** (addressed to this node) is always delivered (§9.2.2); SVAF decides only whether
  it is stored, and a line marks one that was not (`·not-stored`).

Low-relevance broadcasts are gated out so Claude's context window doesn't drown; a peer that
addresses this node is always heard.

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
- **Peer text is data, never markup** (design D6): a push is one line of the channel's own markup
  with a quoted, JSON-escaped excerpt of the signed focus (at most 100 characters), and the facts
  travel as structured notification meta. `sym_receive` escapes the same way. The full signed text
  (the seven CAT7 texts, and a payload as the signed application data it is) is shown only by
  `sym_fetch`, between fence markers carrying a random nonce that peer text cannot close.
- **Only signed parts are shown**: a category key outside CAT7, a mood's valence and arousal, and
  the SDK's rendered content string are never shown; none is covered by the record's signature.
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
sender's name and the reason, named by its category (`injection-pattern`,
`payload-over-limit`, `no-provenance`, and so on), and none of the message. It is never left out of
the count. `sym_receive` lists each withheld delivery (deliveries from senders
outside the allowlist are counted by sender), `sym_fetch` on its id answers with
the reason, and an audit line goes to stderr. The audit line carries the category and this server's
own counts (`flagged=2`, `bytes=…`), never an excerpt of the peer's text, because a host may show
that log to a model. The delivery stays in the node's inbox, which never evicts an unread delivery,
so raising `SYM_MAX_PAYLOAD_BYTES` and restarting makes an over-limit message readable while it is
still there. A message (a directed record of sym's message schema) and a mood are kept in the
channel's own feed, journalled in the node's directory (`channel-feed.log`, 0600), so their ids
survive a restart and are never reused.

A record whose wording may trip the model's own safety classifier (offensive-security or
policy-adjacent terms) is **quarantined** rather than withheld: its push and its `sym_receive` line
name the category and how many terms were flagged (`classifier-risk (2 flagged terms)`), never its
text, and `sym_fetch` shows it on request.

A sender chooses its own label, so every line prints it with line breaks,
brackets, control characters and this server's own line markers replaced, and so does the audit
line. A record signed by this node's own nodeId is not
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
and no store, and submits drafts the node checks (audience, size, rate, declared kinds, the kind as
the record's signed intent, parents in the mind's scope) and signs as itself.

- The capability is a bearer token for one mission. Prefer `SYM_INTERIOR_CAPABILITY_FILE`: the file
  must be a regular file owned by this user and readable by no one else, or it is refused. A
  capability given in `SYM_INTERIOR_CAPABILITY` is removed from the server's environment once read,
  so nothing the server starts inherits it.
- The capability is bound to the one connection the channel opens; sym refuses it on any other
  (`capability-bound-to-another-connection`). When that connection closes, the mind is detached and
  every tool says so; the channel never presents the capability again.
  When the host's stdin closes, the channel ends the mind, which revokes the capability.
- Deliveries the node serves through its interior are gated exactly as in node mode: shown as
  verified only when their own facts make them so. The node serves a mind only what arrived for its
  mission while it runs (sym ruling C). A node that does not serve its deliveries is reported as
  such, never as an empty inbox.

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
