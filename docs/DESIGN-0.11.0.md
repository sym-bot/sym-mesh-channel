# mesh-channel 0.11.0: the channel shows what the node verified, and nothing else

**Date:** 2026-10-02 · **Author:** agent-a (core libs) · **Status:** v2. The independent review of
v1's implementation (d972837) was BLOCK, with repros r1-r12 and ten mutation checks. Section 3 is
rewritten on the design assumptions the review round decided; §4 lists what changed from v1 and
which finding each change answers.
**Target:** `@sym-bot/mesh-channel` 0.11.0 on `@sym-bot/sym` 0.14.0 Core Secure.
**Builds on:**
- the sym design `docs/DESIGN-core-secure-identity.md` (D1, D3, D5, D8, D9.3);
- the XMesh design `docs/DESIGN-cognitive-nodes.md` (C2: mesh-channel interior mode);
- the 2026-10-02 MMP conformance audit's channel findings (C-1.x to C-6.x);
- the MMP v2.0 spec: §8.8 records, §9.2.2 delivery, §9.3 mood, §14.3 lineage, §14.9 events, and the
  draft spec PRs #34 (only signed parts are admitted) and #35 (§15.7 gates only the remix path).

**Supersedes:** the unreleased branch `fix/0.10.2`. Its push detection is replaced by D5.

## 1. Why a redesign

sym 0.14.0 makes a peer a proven session. A record reaches a host only after §8.8.5 verification.
The channel in 0.10 was built for the opposite world:

- **It predates Core Secure.** It listened to the legacy `message` frame, which 0.14 retires. It read
  the SDK's store-local `<receiver>+<deliverer>` string to guess who sent a delivery, and it could not
  refuse an unverifiable record.
- **No lineage at the emit surface (audit C-3.1, C-3.2).** No `parents`, and no delivery showed its
  CMB key. §14.3: an agent MUST include lineage when it responds to mesh signals.
- **Names stood in for identity.** `to:`, the allowlist and the outbox matched names. A name is a
  label its sender chooses (§8.8.4).
- **Peer text at instruction level (C-2.12)**, **no mood-delivered surface (C-2.3)**, and **the
  re-send salt (C-6.1)**, which signed focus text the agent never wrote.
- **Push was inferred (root cause 4)** from Claude Code's launch line. The server cannot see the
  model, so the guess was never true.

## 2. The design assumptions, written down

1. **Provenance travels with the delivery.** The SDK hands the channel each delivery with the facts
   it verified about it. The channel renders those facts and nothing it derived, and keeps no second
   store of them. A delivery whose own facts do not make it verified is never shown as verified.
2. **A label is chosen by its sender; so is a nodeId.** Neither proves anything on its own (a UUID v7
   is chosen, not derived from the key). What a node has proven is the KEY behind a nodeId, so a
   line identifies a signer by its key, never by a truncated label or id.
3. **Peer text is data, never markup.** It never starts a line of the channel's own markup, it is
   bounded and escaped where the channel summarises it, and it is shown whole only inside a fence.
4. **Only the signed parts are rendered:** the seven CAT7 texts and the signed metadata.
5. **The session speaks for itself.** Whether pushes reach the model is stated by the model, with
   evidence only a received push carries.
6. **Lineage is never dropped.** The channel never advises sending without `parents`.
7. **One agent, one node.** Node mode or interior mode, never both; an interior has no mesh identity.
8. **A test touches nothing real.** Its processes start from a clean environment, and the suite
   checks afterwards that the real `~/.sym` and `~/.claude` were not touched.

## 3. Decisions

### D1. The SDK move

- `@sym-bot/sym` `^0.14.0`, Node.js `>=20`. Until 0.14.0 is on npm the branch depends on a tarball
  of the sym 0.14 branch at a named commit (now 341dafb, packed as `0.14.0-dev.341dafb` into the
  git-ignored `.sdk/`). **The release switches to `^0.14.0` from npm**; the release gate refuses a
  `file:` dependency.
- Only the public host API. The behavioural boundary test runs the node host against a real SymNode
  wrapped so that any channel read of an underscore member fails the test.

### D2. Provenance travels with the delivery (review H1, L2, L5)

**The target (sym, this round).** Every inbox entry, as `cmb-accepted` raises it and as `inbox()` and
`inboxGet()` return it, carries its provenance, persisted with the inbox:

| Field | Meaning |
|---|---|
| `verified` | `true` only when §8.8.5 passed on a Core Secure session |
| `profile` | `'core-secure'` or `'legacy-import'` |
| `assertionId` | the record's assertion identity |
| `verification` | the frozen facts `verified-record` gives: `suite`, `assertionId`, `authorNodeId`, `authorName`, `authorKey`, `authorKeySource`, `audience`, `room`, `to`, `relayed`, `anchor` |
| `session` | the delivering session's frozen facts: `nodeId`, `name`, `identityKey`, `transport`, `profile` |
| `author` | `{ name, nodeId, key, via: { name, nodeId } }` |

A Legacy Import record raises a separate event (`legacy-record`) and never enters this path.
`verified-record` fires once per record, after de-duplication and the in-flight check.

**The rule the channel applies to every entry** (`provenance.js`). An entry is shown as verified
only when all of these hold; otherwise it is withheld, named by id with the first failing reason:

1. `entry.verified === true` (else `unverified`);
2. `entry.profile === 'core-secure'` (`legacy-import` for that profile; `no-provenance` when absent);
3. facts are present (`no-provenance`);
4. the facts' author nodeId equals `entry.author.nodeId`, and the facts' author key equals
   `entry.author.key` when the entry carries one (`facts-mismatch`);
5. the facts' delivering session equals `entry.author.via.nodeId` when both are present
   (`facts-mismatch`).

**Until the SDK lands (interim).** The channel's in-memory join to `verified-record` remains, but
only as the source of the facts in step 3: the join is gated by steps 1, 2, 4 and 5 against the
entry, so a quarantined entry carrying a verified record's assertion id (review r2) is withheld. A
second `verified-record` for the same assertion never replaces the first; the candidate whose
session delivered the admitted copy is chosen (r11). There is no persistence: `delivery-facts.js`
and its ledger are deleted. After a restart, an entry the SDK did not stamp with facts is
`no-provenance`.

### D3. Identity display (review H2)

- A line identifies a signer by its **label and the shortest suffix of its key fingerprint that is
  unique among the key bindings this node knows**, at least 8 hex characters:
  `[alice ⟨…7f3a91c2⟩ →you]`. The fingerprint is SHA-256 of the raw Ed25519 public key.
- When a label is used by two or more known keys, the line says so and the suffix grows until it
  tells them apart: `[alice (2 keys) ⟨…7f3a91c2e0⟩ →you]`.
- When one key is seen under more than one nodeId (one holder running several identities), the line
  says that too: `[alice (one key, 2 nodeIds) ⟨…7f3a91c2⟩ →you]`.
- No nodeId or label is ever truncated for identity. `sym_fetch` gives the full nodeId and the full
  fingerprint.
- **The known bindings** are the SDK's (`node.keyBindings()`, this round). Until it lands, the
  channel uses the keys it holds facts for in this process and the keys of its sessions; the suffix is
  then unique among those.
- This node's own key comes from the SDK's accessor (`node.publicKey`), never from minting an invite.

### D4. Deliveries other than CMBs

- **Messages** (`message` event): a directed record of sym's message schema. Its facts come with the
  event (`assertionId`, `from` = the author's nodeId) and are gated like D2's.
- **Moods (review M1).** A mood is shown only when `mood-delivered` carries the record and the proven
  sender: `verified === true`, `key`, `assertionId`, `authorNodeId` and `deliveredBy.nodeId`. Anything
  else, a mood frame included, is withheld by id with the reason (a mood frame carries no signed
  record). The channel prints no name a frame claims, reads no `context`, rate-limits per proven
  sender, caps the text, and the fetch account says SVAF rejected the record and only its mood was
  delivered (§9.3). Valence and arousal are unsigned (spec draft #34) and never shown.
- Messages and moods are kept in the server's memory (an `m` id), not in the durable inbox.

### D5. Push, stated first-hand

- One push check with a random code when the host initialises; `sym_push_confirm {code}` confirms,
  `{}` sends a new check, `{reaching:false}` states pushes do not reach the session.
- Once confirmed, `sym_receive` names a delivery whose push went out instead of repeating it.
- No launch line or process tree is read.

### D6. Peer text is data (review M2, M3)

- **The push** is one line: the channel's tag, a lead of at most 100 characters escaped as a JSON
  string, and the id. The facts travel in the notification's structured `meta` (`delivery_id`,
  `signer_node_id`, `signer_key_fingerprint`, `audience`, `relayed_by`, `cmb_key`, `assertion_id`).
- **`sym_receive`** prints the same escaped lead (90 characters) on one line per delivery.
- **`sym_fetch`** prints the full text inside a fence whose end marker carries a nonce, so peer text
  cannot close it.
- **Only signed parts**: the body is built from the record's seven CAT7 texts and its signed
  application data. A non-CAT7 key, a mood's valence and arousal, and the SDK's rendered `content`
  string are never shown. The hidden-fields tag names CAT7 fields only.

### D7. Lineage, never dropped (review M6)

- `sym_send` and `sym_publish` take `parents` (keys or delivery ids) and emit through `remember()`.
  With spec draft #35, `remember(fields, parents)` is never gated; §15.7 applies to the remix path.
- On an SDK that still gates it, a refused reply is answered with the reason and "publish an
  observation of your own, then send it again with the same parents". The channel never advises
  sending without parents.
- A held reply is flushed through the same path. A flush the SDK refuses marks the item **stuck**
  with its reason; `sym_peers` reports it as stuck, not as "flushes when the peer returns".

### D8. Names are labels, never routes

- `to` takes a nodeId, or a delivery id meaning its verified signer. `SYM_ALLOWED_PEERS` lists
  nodeIds and fails closed when it lists none. The push rate counts per proven sender.
- The outbox and its roster are keyed by nodeId, files 0600. A nodeId becomes known only from a
  Core Secure session: `peer-joined` is taken only when `peers()` shows that nodeId's session as
  `core-secure` (sym 0.14 at 341dafb raises it for a Legacy Import session too; review L4).

### D9. Interior mode (XMesh C2, sym D8, D9.3)

- `SYM_INTERIOR_SOCKET` plus a capability. The capability file must be owned by this user and not
  readable by others, or it is refused; the `SYM_INTERIOR_CAPABILITY` variable is deleted from the
  environment once read.
- **The capability is bound to its connection** (sym, this round): the channel holds one connection,
  and when it closes the mind is detached and says so; it never reconnects with the capability.
- The read side (`deliveries`, `subscribe`, `ack`, `recall`, `mission`; §6) is used when served. A
  request is either served, unsupported (`unknown-request`), or refused with a reason, and the three
  are reported differently.
- An interior item is the node's own only when its author is the node's proven nodeId; one with no
  author is not "this node".

### D10. Instructions, invites, identity

- The instructions carry no record text, no raw `node.json` value and no unknown key name.
- Invites carry the issuer; `sym_join_room {invite}` pins the issuer before the room move.
- `node_id` / `SYM_NODE_ID` loads without minting.

### D11. Tool calls in arrival order (review L1)

One at a time. The hold timer of a call starts when the call **starts**, not when it is queued, so a
hung call releases only the next call after 60 s, and calls behind it still run in order.

### D12. Tests and the gate (review M4, M5)

- The harness builds every child environment from an allowlist and refuses to start when the parent
  has `SYM_INTERIOR_*`, `SYM_IDENTITY_DIR`, `SYM_NODE_ID` or `SYM_ALLOWED_PEERS` set. The suite ends
  with a check that no test wrote to the real `~/.sym` or `~/.claude`.
- The release gate seeds the outbox from a child process with the sandbox environment, asserts the
  real `~/.sym` is untouched, and refuses a `file:` dependency.

## 4. What v2 changes, by finding

| Finding | Change |
|---|---|
| H1, L2, L5, r2, r11 | D2: provenance from the entry, gated; the ledger and its persistence deleted |
| H2, r1 | D3: key fingerprint suffix, unique among known keys; shared labels said |
| M1, r3, r10 | D4: moods only with record and proven sender facts |
| M2, r4 | D6: escaped single-line leads, facts in meta, fenced fetch |
| M3, r8 | D6: only signed parts rendered |
| M4, r6 | D12: the gate seeds in a sandboxed child, checks the real home |
| M5, r9 | D12: clean child environment, refusal on interior and identity variables |
| M6, r12 | D7: no "send without parents"; stuck flushes reported |
| L1, r5 | D11: hold timer from the call's start; behavioural ordering test |
| L3, r7 | D9 and recall: "own" only by proven own nodeId |
| L4 | D8: `peer-joined` checked against `peers()` |
| L6 | D9: capability file checks, env deleted, unsupported vs refused, connection-bound |
| L7 | relay-auth-refused passes the content policy and is said in plain words |
| L8 | D10: no raw `node.json` values in the instructions |
| L9 | D8: outbox and roster files 0600 |
| L10 | `drain()` honours its limit across the inbox and the feed |
| L11 | dead code removed; own key from the accessor; source-text tests replaced by behaviour tests |
| L12 | SECURITY.md and CHANGELOG say only what is true |

## 5. The tool surface

| Tool | Node mode | Interior mode |
|---|---|---|
| `sym_send` / `sym_publish` | CMB through `remember()`, `parents`, `to` by nodeId or delivery id | submit with `kind` |
| `sym_receive` / `sym_fetch` | deliveries with their facts, escaped; fetch fenced | the same, when served |
| `sym_recall` | own records (by proven nodeId) and verified peer records | the node's recall, when served |
| `sym_push_confirm`, `sym_status` | as D5; status shows the key fingerprint from the accessor | as D5; the mind and socket |
| `sym_peers`, rooms, invites, outbox | D8, D10 | not available |

## 6. The host API the channel builds to

**Built this round by sym, used by the channel when present (feature-detected):**
1. Inbox entries carry provenance (D2 table), and Legacy Import records raise `legacy-record`.
2. `mood-delivered` carries `{ key, assertionId, authorNodeId, deliveredBy: { nodeId, name }, verified }`.
3. `verified-record` fires once, after de-duplication and the in-flight check.
4. The node's own key: `node.publicKey`.
5. Known bindings: `node.keyBindings()` → `[{ nodeId, key, source }]` (public keys only).
6. Non-CAT7 keys, valence and arousal dropped before admission (spec draft #34).
7. `remember(fields, parents)` never gated; `remix()` is (spec draft #35); a broadcast duplicate
   returns `{ key, duplicate: true }`.
8. The interior read side and a connection-bound capability:
   - `{type:'mission'}` → `{mindId, missionId, kinds, allowTo, ratePerMinute, nodeId, name, room}`;
   - `{type:'deliveries', after?, limit?, peek?}` → `{items:[entry with D2's provenance and an id], cursor, remaining}`;
   - `{type:'subscribe'}` → `{type:'subscribed'}`, then `{type:'delivery', item}` lines;
   - `{type:'ack', delivery}` → `{type:'acked'}`;
   - `{type:'recall', query, limit?}` → `{items:[{key, record, verified, storedAt, author}]}`;
   - the capability is bound to the first connection that presents it.

**Still a gap:** none of the above is in 341dafb except what the WIP has started; §7 lists what each
test ran against.

**Defect reported upstream:** a pinned key's source becomes `proven` once a session proves it (sym
D3 keeps the stronger source).

## 7. Tests

- Every test file runs from a clean, allowlisted environment in a sandbox; the last file checks the
  real home was not touched.
- **Against the real SDK (341dafb):** two servers through a loopback relay by the real handshake;
  interior mode against a real node's interior; the node host in process.
- **Against the SDK shapes this round adds:** the node host and the server driven with fake nodes that
  emit D2's entries, the new `mood-delivered`, `legacy-record`, `keyBindings()` and `publicKey`, and
  a stub interior that speaks §6 item 8 with a connection-bound capability.
- **Each review repro r1-r12 is a regression test**, and the ten mutation checks are re-run against
  the new code locations.

## 8. Release

- Order (sym D6): sym 0.14.0 and sym-relay 0.6.0, then this release on `^0.14.0` from npm, then XMesh.
- Before publishing: `^0.14.0`, a fresh lockfile, the release gate, and the full suite against the
  published SDK, with every §6 item present.

## 9. Known limits

- First contact with no invite, anchor or grant is trust on first proven use.
- `relay-auth` is unproven, so a relay token holder can evict a node (4004).
- Whether a push reaches the model is the model's own statement.
- Messages and moods are not durable.
