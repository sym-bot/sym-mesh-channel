# mesh-channel 0.11.0: the channel shows what the node verified, and nothing else

**Date:** 2026-10-02, updated 2026-10-13 · **Author:** agent-a (core libs) · **Status:** v2, built on
the published `@sym-bot/sym` 0.14.0 (it was built on development snapshots, the last 569cad5, until
2026-10-13). The independent review of v1's implementation (d972837) was BLOCK, with repros r1-r12
and ten mutation checks. Section 3 is rewritten on the design assumptions the review round decided;
§4 lists what changed from v1 and which finding each change answers. §6 records where sym differs
from what this design asked for, D13 adds the XMesh World requests of 2026-10-07, and D14 what moving
from the snapshot onto 0.14.0 as published changed.
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
4. **Only the signed parts are rendered:** the seven CAT7 texts and the signed metadata. One
   exception, written down on 2026-10-07: a mood frame (MMP §9.3) has no signed part at all. Its text
   is shown as the word of the session's proven peer and labelled unsigned on every surface, never
   presented as a signed record (D4).
5. **The session speaks for itself.** Whether pushes reach the model is stated by the model, with
   evidence only a received push carries.
6. **Lineage is never dropped.** The channel never advises sending without `parents`.
7. **One agent, one node.** Node mode or interior mode, never both; an interior has no mesh identity.
8. **A test touches nothing real.** Its processes start from a clean environment, and the suite
   checks afterwards that the real `~/.sym` and `~/.claude` were not touched.

## 3. Decisions

### D1. The SDK move

- `@sym-bot/sym` `^0.14.0` from npm, Node.js `>=20`. sym 0.14.0 was published on 2026-10-13 (npm tag
  `next`; `latest` stays 0.13.17; the range resolves because the version exists). Until then the branch
  depended on a tarball of the sym 0.14 branch at a named commit (last 569cad5) in a git-ignored
  `.sdk/`; that directory, its ignore line and every reference are gone, and the lockfile resolves from
  the registry. The release gate refuses a `file:` dependency, and a test pins the dependency, the
  lockfile and the absence of `.sdk/`.
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

**As built (sym 0.14.0).** sym puts these fields on every inbox item and persists them with the
inbox, together with `record`, the record's signed projection. The channel reads the item, gates it,
and shows only the projection's parts. The interim build's in-memory join to `verified-record` is
deleted, so there is one path. After a restart an item decides the same as before it, because its
facts are persisted with it. A delivery sym raises as an event rather than an inbox item (a message,
a mood) carries the same frozen facts by the same names, and is gated by the same rule (D4).

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
- **The known bindings** are the SDK's (`node.keyBindings()`), read when a line is rendered, plus the
  keys learned from verified facts in this process. The suffix is unique among all of them. A key the
  SDK binds under two nodeIds is said as "(one key, 2 nodeIds)". An interior mind has no node, so it
  uses only the keys it learned.
- **The full fingerprint is sym's form**, `sha256:<64 hex>` (`node.fingerprint`). The tag's suffix is
  the end of the same hex.
- This node's own key comes from the SDK's accessor (`node.publicKey`), never from minting an invite.

### D4. Deliveries other than CMBs

- **Messages** (`message` event): a directed record of sym's message schema. The event's meta carries
  `verified`, `profile`, `verification` and `session`, frozen, by the inbox entry's names (sym
  0.14.0), and is gated by D2's rule with `from` as the author and `via` as the delivering session.
  Nothing is looked up: the key is the one the facts name.
- **Moods (review M1)** come two ways, and the line says which:
  - *From a record SVAF rejected* (§9.3): the event carries the record's `key`, `assertionId`,
    `authorNodeId`, `deliveredBy` and the same frozen facts, gated by D2's rule; the facts' assertion
    must be the event's. The fetch account says SVAF rejected the record and only its mood was
    delivered.
  - *A mood frame* carries no record, so nothing in it is signed. Since sym 0.14.0 the frame is
    `{type, mood ≤ 1024, context ≤ 4096 | null, timestamp}` and names no sender (a frame carrying `from`
    or `fromName` is refused); the receiver labels it with the session's proven name. sym gives it
    `verification: null` and the facts of the Core Secure session it travelled sealed on, which means
    "this session's proven peer sent it". The channel attributes it to that peer, by the key the session proved, and
    labels it unsigned on every surface: `[alice ⟨…7f3a91c2⟩ mood, unsigned]`, `signed: "no"` in the
    push meta, "Unsigned: …" in the fetch account. It has no key to cite.
  - Anything else (no facts, a sender that is not the session's peer, a Legacy Import session) is
    withheld by id with the reason.
  The channel prints no name a frame claims beyond the session's label, reads no `context`,
  rate-limits per proven sender and caps the text. Valence and arousal are unsigned (spec draft #34)
  and never shown.
- `node.keyBindings()` is read only for display: the shortest unique fingerprint suffix (D3).
- Messages, moods and Legacy Import records are kept in the host's own feed (an `m` id), journalled
  in the node's directory (`channel-feed.log`, 0600). An id is assigned only once its item is
  written, is never reused, and fetches what it announced across a restart or a new host. A read item
  may be evicted; an unread one never is.

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
  `core-secure`, because the event does not say which profile the session has (review L4).

### D9. Interior mode (XMesh C2, sym D8, D9.3)

- `SYM_INTERIOR_SOCKET` plus a capability. The capability file must be owned by this user and not
  readable by others, or it is refused; the `SYM_INTERIOR_CAPABILITY` variable is deleted from the
  environment once read.
- **The capability is bound to its connection**: sym binds it to the first connection that presents
  it and refuses it on any other (`capability-bound-to-another-connection`). The channel holds one
  connection; when it closes, the mind is detached and says so, and it never reconnects with the
  capability.
- **The read side is the mission's** (sym's interior rule C). A mind reads only what arrived after it started
  (a directed delivery only from a nodeId the mission may address), with its own cursor and acks;
  its recall and its `parents` are limited to that view, its own submissions and the mission's
  context. The instructions say so.
- **The kind is signed.** The node writes the submission's kind as the record's intent and refuses a
  differing intent (`intent-is-not-the-kind`); the tool description says to leave intent out.
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

### D13. What XMesh World asked for (agent-c, 2026-10-07)

- **`sym_status` names the versions loaded:** `@sym-bot/mesh-channel` from its package, and
  `@sym-bot/sym` as the node says it (`node.version`), else the loaded package's version. In
  interior mode the node is another process, so the line names the copy this server loaded and says
  the node's own is not reported.
- **The daemon-room advisory is said once per session**, in the first tool answer, and again only
  when the pair of rooms changes. It is not in the instructions, because a host may show those again
  with every turn. `sym_status` always says it.
- **A withheld delivery names its reason category** on every line of ours (`withheld ·
  injection-pattern — …`, `withheld, not verified · no-provenance: …`, `quarantined delivery ·
  classifier-risk (2 flagged terms)`), never the peer's text. The operator's audit line on stderr
  carries the category and our own counts (`flagged=2`, `bytes=…`) and no excerpt, because a host
  may show that log to a model. The content policy itself is unchanged.

### D14. Moving from the snapshot onto sym 0.14.0 as published (2026-10-13)

sym 0.14.0 changed a good deal after 569cad5: it aligned with MMP 2.0 update 1 (the drafts the earlier
rounds waited on, #34 and #35 among them, are folded into it) and dropped a pile of 0.13 behaviour. What
touches a channel, and what the channel does about each:

| sym 0.14.0 | The channel |
|---|---|
| The sealed mood frame is `{type, mood ≤ 1024, context ≤ 4096 \| null, timestamp}` with no `from` or `fromName`; a frame carrying them is refused; the receiver labels it with the session's proven peer and name | Unchanged in kind: the label was always the session's. A mood over its bound is refused by the *sender's* node (`EMOODFRAME`), so the node-host test no longer sends one; the channel's 2,000-character cap now only bounds moods that arrive as a record's mood text. The frame's `context` is never read. |
| `cmb-fetch` names one `key` and has no `from`; `cmb-fetch-result` has no `timestamp`; `fetchCMB()` returns a verified record or only its categories with `verified: false` | The channel never calls `fetchCMB()` and sends no `cmb-fetch`: `sym_fetch` reads the node's own inbox by delivery id. Nothing to port. |
| A room is an MMP §5.8 identifier (`[a-z0-9._-]`, 1 to 64); `SymNode` throws `EBADROOM` otherwise; `sym` is refused | The channel asks the SDK and keeps no grammar of its own. Two copies of the kebab-case one are gone (`relay-store.js`, `bin/install.js`). A configured room that is not a room stops the node before it is built (building mints an identity; a fallback to `default` is the global mesh), with the cause on every tool and the value not repeated. |
| Discovery: every node advertises on `_sym._tcp` with TXT `room` and `mmp=2.0`, and dials only advertisements whose TXT room is its own and whose `mmp` lists 2.0; `_<room>._tcp` is the legacy mapping | The channel built a per-room service type in three places. `buildNode` no longer passes `discoveryServiceType` (a per-room type would make the node invisible to every 0.14 node); `sym_rooms_discover` browses `_sym._tcp` and groups by TXT room instead of scanning service types with `dns-sd` or `avahi-browse`; the status, room-info, join and invite answers carry no service type. The `_symrooms._tcp` beacon that `sym rooms` lists is kept. `SYM_SERVICE_TYPE` is read only as a room name, and said. |
| `remix()` is asynchronous and §15.8-tethered; `remember(fields, parents)` is never gated (MMP §15.7 is `remix()`'s) | No caller exists in the channel. The pre-0.14 gating paths (`remixGated`, the `canRemix` check at hold time, the `remix-refused` outcome) were dead against 0.14 and are deleted. `remember()` returning null now means the store could not write (0.13 returned null for a duplicate; 0.14 returns `{ key, duplicate: true }`), and the answer is "Not sent: … could not write", not "already in memory". |
| A delivery ledger (`cmbs/.delivered-marks`, written before a delivery is announced) and a journalled inbox: an id is assigned only once durable and never reused; nothing is surfaced twice | Nothing to build; shown end to end by `test/redelivery-e2e.test.js` (§7). The inbox's new `dropped` count (a delivery got no id because the inbox was full of unread ones) is shown by `sym_status`. |
| `message` and `mood-delivered` carry `verified`, `profile`, `verification` and `session`; `node.version` exists | Already the channel's basis (D2, D4, D13). |
| Authority is the §6.6 store: an anchor pin (the node's `anchor` option or `SYM_FOUNDER_ANCHOR`), `node.authorityStatus()`; 0.13 role grants confer nothing until re-issued; a pin that does not parse stops the node | The channel passes no pin and decides nothing from roles. The pin is the operator's, in this server's environment; `.sym/node.json` cannot set one, since a file in a repository would choose its own root of trust. `sym_status` prints what the store says. A pin that does not parse stops the node, with the cause on every tool. |
| 0.13.17 peers cannot form Core Secure sessions on the LAN (Legacy Import routes only) | Documented as the breaking change it is (CHANGELOG, README, SECURITY): upgrade every node of a room together. |

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
| `sym_push_confirm`, `sym_status` | as D5; status shows the key fingerprint from the accessor and the versions loaded | as D5; the mind, the socket and the versions loaded |
| `sym_peers`, rooms, invites, outbox | D8, D10 | not available |

## 6. The host API the channel builds to

**Built this round by sym, used by the channel when present (feature-detected):**
1. Inbox entries carry provenance (D2 table), and Legacy Import records raise `legacy-record`.
2. `mood-delivered` carries `{ key, assertionId, authorNodeId, deliveredBy: { nodeId, name }, verified }`.
3. `verified-record` fires once, after de-duplication and the in-flight check. (Built; the channel no
   longer listens to it, since the facts are on the entry.)
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

**Status at sym 0.14.0:** every item above is in sym. The defect reported upstream at 341dafb (a
pinned key's source became `proven` once a session proved it) is fixed: `pinned` now outranks
`proven`. Item 7 holds as written, with one change to `remix()`: it is asynchronous and §15.8-tethered.

**Where sym differs from this section** (1-8 found at 72daeb6, 9-12 at 914d264 and 595a651; 3 and
4 resolved at 569cad5; all of it as published in 0.14.0) (recorded, not adapted to silently; the channel takes
sym's names, one name and no aliases):

1. **The interior refusal name** is `capability-bound-to-another-connection` (this design said
   `capability-bound-elsewhere`). The channel uses sym's name only.
2. **The interior delivery item** is `{ seq, id, kind: 'directed'|'broadcast', record, verified,
   profile, assertionId, verification, session, author, remixed, receivedAt }`. `kind` is the
   audience, not cmb/message/mood: the interior serves inbox items (CMBs) only, never messages or
   moods. `record` is the signed projection. Items carry no `payload` (it is in
   `record.metadata.application`). Since 914d264 they carry the mind's own `acked`.
3. **The `message` event** carried no `verification` and no `session` at 72daeb6, so the channel
   resolved the author's key through `node.keyBindings()`. *Resolved at 569cad5:* the meta carries
   `verified`, `profile`, `verification` and `session` by the inbox entry's names; the channel
   decides from them, and the key lookup and its reason (`no-key-binding`) are gone.
4. **`mood-delivered`** carried the author's nodeId but not the author's key. *Resolved at 569cad5*
   the same way. A mood frame carries `verification: null` with the session's facts, which the
   channel shows as the session peer's unsigned mood (D4).
5. **The fingerprint form.** `node.fingerprint` is `sha256:<hex>`, and the channel printed bare hex
   of the same hash. The channel now prints sym's form wherever it prints a full fingerprint; the
   suffix in a tag is the end of the same hex.
6. **Inbox items carry `record`**, the signed projection, beside the raw `categories` and `payload`.
   The channel shows only the projection's parts.
7. **The kind is signed.** The node writes the submission's kind as the record's intent and refuses
   a submission whose intent differs (`intent-is-not-the-kind`).
8. **Windows:** interior `listen` refuses without `{ allowDefaultPipeAcl: true }`.
9. **The interior read side is scoped to the mission** (sym's interior rule C, after 72daeb6): a mind reads
   only deliveries that arrived after it started, a directed one only from a nodeId in the mission's
   `allowTo`; recall and `parents` are limited to that view, its own submissions and the mission's
   `context`. Reads are rate-limited (refused `rate`), and an ack outside the view is refused
   `not-in-view`. The channel says each in plain words (D9).
10. **A first-contact peer's key source is `session`** until an admitted verified record earns it a
   binding (`proven`). `sym_peers` and the fetch account say `session` until then.
11. **`node.version`** is the `version` of the package loaded with the node (also `status().version` and
   `require('@sym-bot/sym').version`): `0.14.0` with the published package. `sym_status` shows it.
12. **The inbox is journalled** (`inbox.log`), with durable de-duplication and ids that are never
   reused. `inbox.json` is still read as the snapshot, so a 0.13 inbox entry is still listed, and
   withheld.

## 7. Tests

- Every test file runs from a clean, allowlisted environment in a sandbox; the last file checks the
  real home was not touched.
- **Against the real SDK (`@sym-bot/sym` 0.14.0 from npm), everywhere it can be:**
  - two servers through a loopback relay by the real handshake;
  - the node host in process: provenance on the inbox entry, and the same after a restart; a message
    and a mood (from a record a rejecting SVAF evaluator turned away) with their keys from
    the facts their events carry; mood frames attributed to the session's peer, unsigned; the feed's
    ids across hosts; the own key and
    fingerprint (`node.publicKey`, `node.fingerprint`); the tag suffix from `node.keyBindings()`;
  - interior mode against a real node's interior: the mission, the scoped read view, push, fetch,
    citing a delivery, recall, the kind as the intent, the refusals, sym's
    `capability-bound-to-another-connection` on a second connection, a mind the node ended, and a
    detached mind that never reconnects.
- **Two small stand-ins remain, where no real path exists:** a fake node for L4, since a Legacy
  Import session needs a 0.13 peer, and a raised `legacy-record` event in sym's shape on a real node;
  and a stub interior that serves no read side, so "unsupported" is told from "refused".
- **Added with the move onto the published 0.14.0:**
  - `redelivery-e2e`: two spawned servers over a loopback relay; the sender is restarted, then the
    receiver, then the receiver is moved to another room and back (`sym_join_room`), each followed by a
    restart of the sender so its anchor replay reaches the new session (the relay's tap counts the
    sealed record frames). Nothing is surfaced again, every id fetches what it announced, and the next
    delivery takes the next id. A second case removes the receiver's stored records and leaves only
    sym's ledger; with the ledger removed too it fails with the field bug (the record comes back as a
    new id);
  - a mood frame end to end through a spawned server, from a real `SymNode` peer;
  - `rooms-surface`: bad rooms and bad pins stop the node (and mint nothing), §5.8 rooms start it,
    `SYM_SERVICE_TYPE`, join and invite on dotted rooms, the pin line, `sym_rooms_discover` on a
    relay-only node;
  - `room-discovery` and `relay-store`: no network, hostile advertisements, bounds, §5.8 credentials;
  - `lan-discovery` (opt in, `MESH_CHANNEL_LAN_PROOF=1`, since it advertises a made-up room on the real
    LAN): three servers, the pair in one room meet by `_sym._tcp` + TXT room (the loopback registration
    and an mDNS browse show `serviceType: _sym._tcp`, `room`, `mmp: 2.0`) and exchange records both
    ways; the third, in another room, is not dialled.
- **Each review repro r1-r12 is a regression test.** r2 and r11 are now provenance tests, because
  the entry decides. The mutation checks are in `test/mutation-checks.mjs` (§7a).

### 7a. Mutation checks

`npm run mutation` (`test/mutation-checks.mjs`, a heavy job: it runs the test files it names, each twice,
and the full run takes about three minutes) breaks one production decision at a time on a throw-away copy
of the tree and requires the named test file to fail; a check whose target has moved fails loudly, and a
test file that fails unmutated invalidates its checks. There are 31: the review's findings (H1, H2, r2-r12
and the like, M01 to M15), the host and outbox (M16, M17, M20, M21, M30), and what the move onto 0.14.0
added (M18, M19, M22 to M29, M31). The 21 checks the earlier rounds spoke of were run by hand and their
list was not kept; these were rebuilt from the review's findings, and the first full run found one
survivor, M20 (the host feed's floor for ids taken by evicted items), which had no test and now has one.

## 8. Release

- Order (sym D6): sym 0.14.0 and sym-relay 0.6.0, then this release on `^0.14.0` from npm, then XMesh.
- Done on the branch: `^0.14.0` from npm with a lockfile that resolves from the registry, and the full
  suite and the release gate (`npm run verify:packed`: pack, install into an empty directory, speak MCP
  to the installed copy) against the published SDK, with every §6 item present.
- Left to the release: the version bump (`package.json` stays 0.10.1 until `npm run release` bumps it
  together with `.mcp.json`'s launch pin and the plugin manifest), the tag, the publish.
- Not tested here: the hosted relay. The relay path runs against a fake relay (relay-auth, relay-peers,
  envelope routing and fan-out), because the live relay is not for tests; sym-relay 0.6.0 is the relay
  build that matches sym 0.14.

## 9. Known limits

- A TXT room is a claim by whoever advertises it: it decides who a node dials, never who is admitted,
  and a room name is not a trust boundary.
- A LAN advertisement and a 0.13 node: a 0.13.17 node advertises no `mmp`, so it is never dialled, and
  over a relay the Core Secure handshake with it never completes. It is reached only through a Legacy
  Import route on the sym side.
- First contact with no invite, anchor or grant is trust on first proven use.
- `relay-auth` is unproven, so a relay token holder can evict a node (4004).
- Whether a push reaches the model is the model's own statement.
- Messages, moods and Legacy Import listings live in the host's own feed (`channel-feed.log`), not in
  sym's inbox.
- An interior mind sees no messages or moods: the interior serves inbox items only.

## Parked 2026-10-02, resumed 2026-10-07, finished 2026-10-13

Parked on 2026-10-02 with the move onto sym 72daeb6 half done (WIP 56f992d). It was resumed on
2026-10-07 and merged with `fix/0.11.0-feed-ids` (9340d31, the journalled
feed). Every step of the parked list was done on 2026-10-07:

1. The tests are on the new code: the provenance tests have no join, and test the event facts and
   the session-only mood; the interior tests use sym's names and item shape; full fingerprints are
   `sha256:<hex>`.
2. The fake-node tests in `node-host.test.js` are real-SDK tests (§7). These were the four that failed
   at 56f992d: the restart test, r2, r11 and r3.
3. Interior mode runs against a real node's interior (§7).
4. The invite issuer's key is asserted as `pinned`.
5. §7, the CHANGELOG, SECURITY and the reference name the build and its behaviour.
6. The mutations were re-run, then the full suite under the heavy lock.
7. On sym 569cad5 (2026-10-07), messages and moods decide from their events' facts; the key lookup
   is gone, and a mood frame is its session peer's, unsigned.

**The state on 2026-10-13** (what the 2026-10-07 list was waiting on):
- Spec drafts #34 and #35 merged, folded into MMP 2.0 update 1 (meshcognition-website PR #43, merged at
  c07ff20).
- sym 0.14.0 is on npm (tag `next`; `latest` stays 0.13.17). The branch depends on `^0.14.0` from the
  registry; the `.sdk/` snapshot is gone; the suite, the mutation checks, `npm pack --dry-run` and the
  release gate run against the published package (D14 and §7 say what that changed).
- Still open, and not this branch's to close: the release itself (bump, tag, publish; sym-relay 0.6.0
  first, per sym D6), and a test against the hosted relay.
