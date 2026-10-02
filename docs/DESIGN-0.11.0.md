# mesh-channel 0.11.0: the channel shows what the node verified, and nothing else

**Date:** 2026-10-02 · **Author:** agent-a (core libs) · **Status:** v1, for review.
**Target:** `@sym-bot/mesh-channel` 0.11.0 on `@sym-bot/sym` 0.14.0 Core Secure.
**Builds on:**
- the sym design `docs/DESIGN-core-secure-identity.md` (D1, D5, D8, D9.3);
- the XMesh design `docs/DESIGN-cognitive-nodes.md` (C2: mesh-channel interior mode);
- the 2026-10-02 MMP conformance audit's channel findings (C-1.x to C-6.x);
- the MMP v2.0 spec: §8.8 records, §9.2.2 delivery, §9.3 mood, §14.3 lineage, §14.9 events.

**Supersedes:** the unreleased branch `fix/0.10.2`. Its push detection is replaced by D5. What
still holds from it is listed in D12.

## 1. Why a redesign

sym 0.14.0 makes a peer a proven session. A record reaches a host only after §8.8.5
verification, and the SDK says so through one public hook, `verified-record`. The channel in
0.10 was built for the opposite world:

- **It predates Core Secure.** It listened to the legacy `message` frame, which 0.14 retires. It
  read the SDK's store-local `<receiver>+<deliverer>` source string to guess who sent a delivery.
  It never showed whether a record was signed, and it had no way to refuse an unverifiable one.
- **No lineage at the emit surface (audit C-3.1, C-3.2).** `sym_send` and `sym_publish` took no
  `parents`, and no delivery showed its CMB key, so an agent could not cite what it answered.
  §14.3 says an agent MUST include lineage when it responds to mesh signals.
- **Names stood in for identity.** `to:` matched a display name first, the allowlist held names,
  and the outbox queued by name. A name is a label the sender chooses (§8.8.4: `createdBy` MUST
  NOT be used for identity resolution or routing).
- **Peer text at instruction level (C-2.12).** The startup primer put the store's newest records,
  peers' words included, into the MCP `instructions`, under "act accordingly".
- **No mood-delivered surface (C-2.3).** §9.3 and §14.9.1 require a mood from a rejected CMB to
  reach the application. The channel never listened for it.
- **The re-send salt (C-6.1).** When the store already held identical categories, the channel
  re-sent them with `[re-sent <time>]` appended to the focus. That is focus text the agent never
  wrote, signed in its name. Content-addressed dedup (§8.8.2) is not an error to work around.
- **Push was inferred (root cause 4).** 0.10 and the 0.10.2 branch read Claude Code's launch line
  from the process tree to guess whether `<channel>` notifications reached the model. Five review
  rounds patched the guess (Windows, wrong handles, inherited env, unreadable launch lines) and
  never made it true, because the server cannot see the model.

## 2. The design assumptions, written down

1. **The node verifies; the channel shows what was verified.** A delivery reaches the model only
   with the verification facts the SDK gave for it. A delivery without them is named by id and
   reason, never shown.
2. **Identity is the nodeId; a name is a label.** Routing, the allowlist, the outbox and the
   known-peer roster key on the proven nodeId. Names are printed, never matched.
3. **The session speaks for itself.** Whether pushes reach the model is stated by the model,
   with evidence only a received push carries. The server never infers it.
4. **The record carries everything it says.** Lineage rides in `parents`, a payload rides in the
   signed application section (§8.8.3), and the channel adds nothing to what the agent wrote.
5. **One agent, one node.** The channel is either the agent's node (node mode) or an existing
   node's interior (interior mode, D7). It is never both, and an interior has no mesh identity.

## 3. Decisions

### D1. The SDK move

- `@sym-bot/sym` `^0.14.0`. Until 0.14.0 is on npm, the branch depends on a tarball of the sym
  0.14 worktree (`feat/0.14.0-core-secure` at 28c0fdb, packed as `0.14.0-dev.28c0fdb` into the
  git-ignored `.sdk/`). **The release switches to `^0.14.0` from npm**, and the release gate
  refuses to pack while any dependency is a `file:` path.
- Node.js `>=20` (sym 0.14's floor).
- **Removed:** every SDK internal. The channel used none of `_frameHandler`, `_identityKey`,
  `_peerSharedSecrets`, `frame-received` or the daemon's `register`/`register-agent`/`agent-cmb`
  IPC, and it must not start. It did use:
  - the legacy `message` frame event, which 0.14 retires (a message is a directed CMB now);
  - `node._port` for the room beacon, replaced by `status().port`;
  - the store-local `source` string and the claimed `createdBy` for attribution, replaced by
    the verification facts (D2);
  - the SDK's `lib/rooms.js` deep import, replaced by the `rooms` export;
  - the channel's own invite regex, replaced by the SDK's `invite.parseInvite` and
    `node.inviteURL`.
- A test scans every shipped file for an SDK underscore field and for the retired names.

### D2. Deliveries: what the node verified, joined to what it admitted

Two separate facts make a delivery, and the SDK gives each through a public event:

| Fact | Source | Says |
|---|---|---|
| verified | `verified-record` `{ record, session, verification }` | §8.8.5 passed: who signed, with which key and where the key came from, directed or room-bound, the room, relayed or direct, the delivering session |
| delivered | `cmb-accepted` (and the node's durable inbox) | §9.2.2: SVAF admitted a room-bound record, or a directed record was surfaced unconditionally (`remixed` true or false) |
| delivered | `message` | a directed message record (sym's message schema), surfaced once, never stored |
| delivered | `mood-delivered` | §9.3: the mood of a record SVAF rejected, or a mood frame |

`verified-record` fires before admission, so it cannot be the feed on its own: a room-bound
record SVAF rejects MUST NOT be surfaced (§9.2.2). The admission events cannot be the feed on
their own either, because they do not carry the verification facts. So:

- **The join.** On `verified-record` the channel keeps the facts by the record's `assertionId`
  (bounded: 2,048 entries, ten minutes). When `cmb-accepted` or `message` fires for that
  assertion, the facts are attached to the delivery. The assertion identity is the right key: it
  names one authenticated assertion, while two authors who say the same words share a cognition
  key (§8.8.2).
- **Durable.** The SDK's inbox is durable across restarts and the facts map is not, so the facts
  of every inbox delivery are written beside the inbox, under the node's directory
  (`mesh-channel/deliveries.json`, bounded to the inbox's size). A restarted channel still shows
  who signed each delivery waiting in the inbox.
- **What is never shown.** An inbox delivery with no facts is withheld, named by id and reason,
  never by its text, on every surface (push, `sym_receive`, `sym_fetch`). The reasons are:
  - `legacy-import`: it arrived on a Legacy Import session (sym D7), quarantined and unverified;
  - `before-core-secure`: it was received before this node ran 0.14 (a 0.13 inbox entry);
  - `unverified`: no verification was given for it.

  The same rule holds for `sym_recall`: a peer's stored record that is not marked verified is
  counted, not shown.
- **What a delivery line shows.** Every surface says who signed, the audience, relayed or direct,
  the delivery id and the CMB key:

  ```
  [alice·3f9a2b1c →you] review the outbox migration [+payload 312 bytes] [in0042] key cmb-…(64 hex)
  [bob·77c0de11 →room via carol·0a1b2c3d] the relay is back ·not-stored [in0043] key cmb-…
  ```

  The name is the signer's own label, printed through the display filter. The 8 characters after
  the dot are the **last** 8 of its nodeId: the first 8 of a UUID v7 are its timestamp, and nodes
  minted within about a minute of each other share them. `sym_fetch` gives the whole account: the full nodeId, where
  its key came from (pinned by an invite, proven in a session, vouched by a grant), the suite and
  assertion, the room, the delivering session and its transport, and whether the record was
  stored.
- **The content policy stays** (`delivery-policy.js`): injection patterns, the payload limit, the
  classifier-risk quarantine and the push rate, on every surface. It now reads the payload from
  the signed application section, which is what the SDK gives back.

### D3. Lineage at the emit surface (audit C-3.1, C-3.2)

- `sym_send` and `sym_publish` take `parents`: CMB keys, or delivery ids (`in0042`, `m007`) that
  the channel resolves to their keys. A parent the channel cannot resolve is refused before
  anything is minted.
- Every delivery shows its key (D2). The instructions say: when you respond to a delivery, pass
  its key or id in `parents` (§14.3).
- The node applies §15.7's remix guard: a remix of a peer's record needs new domain data since
  the last one. When the SDK declines a remix for that reason, the answer says so ("Not sent")
  and names both ways forward: emit an observation of your own first, or send without parents.

### D4. Emit outcomes, without the salt (audit C-6.1)

The salt and the channel's own "already dispatched" set go. The answer is the node's own account
of the call:

| The node did | The answer |
|---|---|
| minted and dispatched to N sessions | Sent / Published, the key and the assertion id, "handed to N session(s); MMP has no delivery receipt" |
| minted, broadcast, nobody connected | Published locally, no peer connected |
| directed, no session took the frame | NOT DELIVERED, the reason; held in the outbox when the recipient is a known peer (D6) |
| the store already holds this cognition (broadcast) | "Already in memory": identical CAT7 cognition collapses to one key (§8.8.2), so nothing new went out. **Not an error.** Change what you say to say something new |
| the record equals this node's latest (HEAD) | "Already said": cited, not minted (§7.5). Not an error |
| a directed send of stored cognition | Sent, as a new signed assertion of the same cognition |
| refused (size, signing, remix guard, categories) | Not sent, with the SDK's reason, as the tool's answer |

Only the categories the agent gave are sent (ported from 0.10.2). The SDK records a missing
category as `neutral`; the channel invents nothing.

### D5. Push, stated first-hand (root cause 4)

The server can see that it wrote a notification. It cannot see whether the model read it. Only
the model can say, so the model says it, with evidence:

- **The push check.** When the host has initialised, the server sends one `<channel>`
  notification carrying a random code: "Push check: if you can read this, call
  `sym_push_confirm {"code":"K7QX-29FM"}`." The code exists nowhere else.
- **`sym_push_confirm {code}`** with the right code records that pushes reach this session,
  stated first-hand. A wrong code changes nothing. `sym_push_confirm {}` sends a fresh check.
  `sym_push_confirm {reaching: false}` records that they do not.
- **What it changes.** Once confirmed, `sym_receive` names a delivery whose push went out ("Already
  pushed into this session, not repeated: in0042, in0043") instead of listing it again, and the
  unread count leaves it out. Until then every delivery is listed, pushed ones tagged `·pushed`,
  because a duplicate is safer than a delivery hidden that never arrived.
- **Removed:** reading the process tree, the launch line, `SYM_CHANNEL_PUSH`,
  `SYM_CHANNEL_MCP_NAME`, and every "probably on" status. `sym_status` says only what the session
  stated, and when.
- A confirmation lasts for the server process. A restarted server sends a new check.

### D6. Names are labels, never routes

- **`to`** takes a nodeId, or a delivery id, which stands for that delivery's verified signer. A
  name is refused, and the answer lists the nodeIds of connected peers that use that label, so
  the agent can choose by identity.
- **`SYM_ALLOWED_PEERS`** lists nodeIds, judged against the verified signer. An entry that is not
  a nodeId is ignored and reported. A non-empty list with no nodeId in it allows nothing (it
  fails closed), because an operator who set it meant to restrict, and a 0.10 list of names
  would otherwise silently allow everyone.
- **The push rate** counts per delivering session (nodeId). **Own echo** is a delivery signed by
  this node's own nodeId.
- **The outbox** holds a directed send for a nodeId this node has had a proven session with
  (recorded on `peer-joined`, which fires only for a confirmed session), and flushes it when that
  nodeId's session returns. It lives in the node's directory by nodeId. A 0.10 item addressed by
  name is converted through the old roster's recorded id when there is one; otherwise it is
  reported as held for a label that is not a route, for the operator to discard.
- **`sym_peers`** lists each peer's label, full nodeId, key source and sessions.

### D7. Interior mode (XMesh C2, sym D8 and D9.3)

Given a node's interior socket and a capability, the channel attaches as that node's mind. It
starts no SymNode and has no mesh identity.

- **Configuration:** `SYM_INTERIOR_SOCKET` and the capability in `SYM_INTERIOR_CAPABILITY` or,
  better, a 0600 file named by `SYM_INTERIOR_CAPABILITY_FILE` (the environment of a process is
  readable by its user). `SYM_INTERIOR_KIND` is the default submission kind; `SYM_INTERIOR_KINDS`
  lists the mission's kinds when the node cannot say them.
- **Emitting:** `sym_send` and `sym_publish` submit drafts (`{kind, categories, to?, parents?,
  payload?}`). The node checks audience, size, rate, kind and parents, signs as itself and sends.
  A refusal is answered in plain words with the node's reason.
- **Reading:** the mind reads the node's admitted deliveries through the same socket. sym 0.14's
  socket serves only `submit` and `end`, so this is an SDK gap (§6). The channel asks with the
  requests §6 proposes; a node that answers `unknown-request` is reported plainly ("this node's
  interior does not serve deliveries"), never as an empty inbox.
- **Not available:** `sym_peers`, `sym_join_room`, the invite tools, `sym_rooms_discover` and the
  outbox. The node owns its room and its peers. They answer so.
- **Ending:** when the host's stdin closes (the mind's session is over), the channel sends `end`,
  which revokes the capability and lets the node start its next queued mission.
  `SYM_INTERIOR_END_ON_EXIT=0` leaves the mind running for a host that restarts the channel.
- One mind per node is the node's rule (EMINDBUSY), not the channel's.

### D8. The startup instructions carry no peer text (audit C-2.12)

The instructions say who this node is, how the tools work, and how many records the store
holds. They carry no record text. `sym_recall ""` returns the newest records as a tool result,
through the content policy, where data belongs.

### D9. Invites carry the issuer (sym D5)

- `sym_invite_create` uses `node.inviteURL`, so the URL names this node and its key. The answer
  says the URL is a secret (a team invite carries the relay token) and integrity-sensitive.
- `sym_invite_info` uses `invite.parseInvite` and shows the issuer's nodeId and key fingerprint.
- `sym_join_room {invite}` joins the invite's room and relay and accepts the invite, which pins the
  issuer's key only when that nodeId is unbound (`node.acceptInvite`). A conflict is reported, never
  overridden.

### D10. The folder's identity, loaded without minting

- The folder is the agent (0.10). Its `.sym/node.json` may now carry `node_id`, and `SYM_NODE_ID`
  may set it. With a nodeId the identity is loaded with `create: false`, so a missing identity
  stops the node and says why, instead of minting a replacement silently (sym D9.1).
- An absent (`EIDENTITYABSENT`), tombstoned (`EIDENTITYTOMBSTONED`) or locked (`EIDENTITYLOCK`)
  identity leaves the server running without a node, saying why in its instructions and on every
  tool, as the lock already did in 0.10.
- `sym_status` prints the nodeId and the line that pins it in `.sym/node.json`.

### D11. Tool calls run in arrival order (ported from 0.10.2)

The tools share the inbox cursor and the read and push records. A host may send calls together,
and a `sym_fetch` must not run before a `sym_receive` sent ahead of it. Calls run one at a time;
one that never settles holds the queue for at most 60 s. `sym_receive` waits at most 2 s for a
push still being written, so its credit is settled first.

### D12. What fix/0.10.2 leaves, and what goes

- **Ported:** only the categories given are sent (D4); "Not sent" for the SDK's refusals; the
  tool queue (D11); the bounded wait for a push in flight; "Already pushed, not repeated" (now
  behind the stated push, D5); the unread count subtracting only what the engine still holds;
  the honest wording about peer identity, rewritten for Core Secure (peers are now proven).
- **Not ported:** every launch-line reader (macOS, Linux and Windows), `SYM_CHANNEL_PUSH`,
  `SYM_CHANNEL_MCP_NAME`, and the salt's "undefined" fix (the salt is gone). The witness-storm pin
  (`^0.13.15`) is moot under `^0.14.0`.

## 4. What this removes

- the re-send salt and the channel's dispatched-key set;
- every name-based route: `to:` by name, the name allowlist, the outbox and roster by name;
- the legacy `message` frame handler and its compact-header heuristics;
- attribution from the store-local `source` string;
- peer text in the startup instructions;
- the launch-line push inference and its settings;
- the channel's own invite grammar.

## 5. The tool surface

| Tool | Node mode | Interior mode |
|---|---|---|
| `sym_send` | directed CMB to a nodeId or a delivery's signer; `parents`; held when the peer is known and absent | submit with `to`; `kind` |
| `sym_publish` | room-bound CMB; `parents` | submit without `to`; `kind` |
| `sym_receive` | the inbox and the channel's own feed (messages, moods), with facts | the node's deliveries, if it serves them |
| `sym_fetch` | the full delivery and its verification account | the same, if served |
| `sym_recall` | the store, verified records and own records only | the node's recall, if served |
| `sym_push_confirm` | the first-hand push statement | the same |
| `sym_status` | node, Core Secure sessions and key conflicts, relay, push statement | the mind, the socket, counts |
| `sym_peers` | label, nodeId, key source, sessions; the outbox | not available |
| `sym_room_info`, `sym_join_room`, `sym_invite_create`, `sym_invite_info`, `sym_rooms_discover`, `sym_outbox_discard` | as 0.10, with D6 and D9 | not available |

## 6. sym API gaps found (exact needs)

1. **The interior socket has no read side.** XMesh C2 says the mind reads the node's admitted
   deliveries through the same channel; sym 0.14's socket serves `submit` and `end` only. Needed,
   each authorised by the live capability:
   - `{id, type:'deliveries', capability, after?, limit?, peek?}` →
     `{id, type:'deliveries', items:[{seq, id, kind:'cmb'|'message'|'mood', record, verification,
     session, remixed, receivedAt}], cursor, remaining}`: the node's durable inbox, with the facts
     `verified-record` carried;
   - `{id, type:'subscribe', capability}`, then unsolicited `{type:'delivery', item}` lines: push;
   - `{id, type:'ack', capability, id}`: read in full, as `inboxAck`;
   - `{id, type:'recall', capability, query, limit?}` → `{id, type:'recall', items:[{key, record,
     verified, storedAt}]}`;
   - `{id, type:'mission', capability}` → `{id, type:'mission', mindId, missionId, kinds, allowTo,
     ratePerMinute, nodeId, name, room}`: so the mind can tell the model what it may submit.

   The channel implements its side of these requests and is tested against a stub that speaks
   them; against the real 0.14 node it reports the gap.
2. **Inbox entries do not carry the verification facts.** `node.inbox()` items have `author`,
   `verified`, `directed` and the cognition `key`, but not the assertion id, the suite, the key
   source or the delivering session's transport. The channel keeps its own durable copy (D2). The
   need: each inbox item carries `assertionId` and the frozen `verification` and `session` facts
   that `verified-record` gave, so no host has to join two events and persist a second store.
3. **`mood-delivered` names no record and no proven sender.** It carries `from` (the delivering
   peer's name, or for a mood frame a name the frame itself claims) and the mood. The need:
   `{ key, assertionId, authorNodeId, deliveredBy: { nodeId, name }, verified }` for a mood from a
   rejected record, and the proven session nodeId for a mood frame. Until then the channel
   attributes a mood only when exactly one recently verified record from that session carries the
   same mood text, and otherwise labels it unattributed.
4. **`remember()` returns `null` for two different things.** A broadcast of cognition the store
   already holds, and a remix the §15.7 guard declined, both return `null`. The channel tells
   them apart by the `remix-rejected` metric emitted during the call. The need: a result object
   `{ key, duplicate: true }` or `{ refused: 'remix-without-new-domain-data' }`.
5. **The interior capability is a bearer token.** It reaches the mind through its environment or
   a file. A per-mind socket (or a socket path the node creates per mind, 0600) would bind the
   capability to the connection instead.

## 7. Tests

Every test runs with HOME, USERPROFILE and SYM_STATE_DIR in a temp dir; `test/run.js` sets them
for every file, and the harness refuses to start a server outside one.

- **Unit:** the facts join and its persistence; the line and fetch rendering; the nodeId
  allowlist (including fail-closed); emit outcomes from the node's account; the push statement;
  `to` and `parents` resolution; the outbox by nodeId and its 0.10 migration; the interior
  client against a stub; the content policy (ported).
- **End to end, real SDK:** two spawned channel servers joined through a loopback fake relay by
  the real Core Secure handshake: a directed send arrives with its verification facts and key; a
  reply with `parents` carries lineage; `to` by name is refused; an identical broadcast is "Already
  in memory"; the push check and `sym_push_confirm`; a restart keeps the facts of an inbox
  delivery; a 0.13 inbox entry is withheld as `before-core-secure`.
- **Interior, real SDK:** a sym 0.14 node listening on its interior socket, a mind started, the
  channel in interior mode: `sym_publish` is signed by the node; a kind the mission did not
  declare is refused in plain words; `sym_receive` reports the read gap; `end` revokes the
  capability on stdin close.
- **Interior, stub:** the proposed read requests, end to end through the channel.
- **Source scans:** no SDK underscore field and no retired event in any shipped file; no peer text
  in the instructions; no launch-line reader.
- Ported: the installer suite, the room grammar, packaging, the content policy, the classifier
  guard, the surface-truth tags.

## 8. Release

- **Order (sym D6):** sym 0.14.0 and sym-relay 0.6.0, then this release on `^0.14.0` from npm, then
  XMesh.
- Before publishing: replace the `file:` dependency with `^0.14.0`, regenerate the lockfile, and
  run the release gate (which refuses a `file:` dependency) and the full suite against the
  published SDK.
- **Upgrade notes:**
  - `SYM_ALLOWED_PEERS` must list nodeIds. A list of names now allows nothing.
  - `to:` takes a nodeId (from `sym_peers`) or a delivery id.
  - A held 0.10 outbox item addressed by name is converted when its old id is known, otherwise
    reported for discarding.
  - Deliveries from authors this node never proved, and that no invite or grant vouches, no
    longer arrive (sym D4, §18.3.1).
  - 0.13 peers are not heard without a Legacy Import route on the sym side, and what such a route
    delivers is withheld here as unverified.

## 9. Known limits

- First contact with no invite, anchor or grant is trust on first proven use (sym §5).
- `relay-auth` is unproven, so a relay token holder can evict a node (4004) until the spec fixes
  it (sym §10, item 1).
- Whether a push reaches the model is the model's own statement. A model that confirms and then
  stops receiving pushes must restate it (`sym_push_confirm {reaching:false}`).
- Messages and moods are kept in the channel's memory, not in the SDK's durable inbox, so a
  restart loses those that were not read.
