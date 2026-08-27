# Changelog

## 0.9.0 (2026-08-27)

### Changed — one room grammar, and a dependency range that can actually reach it

`@sym-bot/sym` moves to `^0.13.0`. The previous range was `^0.11.3`, and for a **0.x**
package caret means `<0.12.0` — so this package could never resolve past 0.11.x however
often the SDK shipped. That range, not lag, is why a local copy of the room grammar existed
here at all.

`server.js` now declares no room grammar and no room-to-service-type mapping of its own;
`isValidRoom`, `roomServiceType` and `serviceTypeToRoom` all come from the SDK, which is
their single source of truth. Collapsing them removed three separate inline
`` `_${room}._tcp` `` constructions — in `sym_join_room`, in `resolveRoom`'s hand-rolled
inverse, and in the invite parser, which built the room and the service type as two parallel
expressions that had to agree and had no reason to. Deriving one from the other fixed a
user-visible bug in passing: a `sym://default` invite produced `_default._tcp` rather than
the global mesh.

`bin/install.js` keeps one guarded mirror of the grammar, because install has to validate a
room name in situations where the SDK cannot be resolved. A test asserts the mirror is
character-identical to the SDK's regex, so it fails the day they diverge rather than the day
someone joins a room.

### Added — room names must be canonical

Founder ruling, 2026-08-27: one name per room, one room per name. Both join gates now
require the round trip through the service type to be identity, so **`sym` is refused** — it
satisfies the grammar but maps to `_sym._tcp`, whose inverse is `default`, so joining it put
this node in the global mesh while it reported being somewhere specific.

The check is written as the **property**, computed from the SDK's mapping in both directions,
rather than as a second copy of the grammar — which is what let it work before the SDK
enforced canonicity itself, and what makes it merely redundant now rather than wrong.

A refusal now names the reason that applies to the name refused. `sym` **is** kebab-case, so
the old "must be kebab-case" sent its author to fix something that was never wrong; a
non-canonical name is now told which room it actually resolves to.

### Fixed

- The plugin manifest and the `.mcp.json` launch pin move with the package version. Bumping
  `package.json` alone left the plugin advertising the previous version and the launch line
  pinning it, so an install would have fetched the old server while the repo claimed the new
  one. Two guard tests catch this; they earned their place on this release.

## 0.8.1 (2026-08-26)

### Changed

- **The read surface says what it cannot show.** `sym_receive` lines, push headers and
  quarantine headers carry an explicit tag when the receiving membrane muted individual
  fields of a message — an entry that shows less than its sender wrote now says so instead
  of reading as complete. Landed in source on 2026-08-25; this is its first published
  release, because this package's own publish gate refused to ship until the new module was
  actually in the tarball. The published 0.8.0 predates the feature and was never affected.
- **Tenant-suffixed room names are legal in `sym_invite_create` and the installer.** Both
  copies of the room grammar (server and `bin/install.js` — the persistence path) accept a
  double hyphen as a segment separator, in lockstep with sym 0.12.3; the validator's error
  message and tool descriptions now describe the grammar they enforce. A user can invite,
  join AND persist an xMesh tenant-scoped room.


## 0.7.2 (2026-08-10)

### Added — unread-inbox advisory

Some MCP hosts never invoke the model on an inbound CMB. Measured on Codex: a directed CMB was
verified and durable at `cursor 4 / seq 5` and surfaced only when the next user turn called
`sym_receive`. So **any mesh tool could succeed while directed mail sat unread.**

Every tool response now carries one line, and only when there is something to say:

```
Mesh inbox: 3 unread — call sym_receive.
```

**This is not a wake and not a push.** Nothing here invokes anyone — it is a count on a reply the
caller was already reading. An MCP server cannot make a host run its model.

Contract, kept deliberately narrow (ruled by codex-mac):

- Exactly one line, **only when unread > 0** — silent at zero.
- **Count only.** No sender, no focus, no payload.
- **Never advances the cursor** — it reads `inboxStatus()`, which is read-only, not `inbox()`,
  which drains. Reporting mail must not consume it.
- Labelled distinctly from held sender-outbox state: `Mesh inbox:` is mail waiting for *this* node
  to read, `OUTBOX:` is mail this node holds for someone else. Different facts.
- Applied through **one wrapper** around tool dispatch, so success and error responses behave the
  same and a newly added tool cannot miss it.

## 0.7.1 (2026-08-10)

### Fixed — 0.7.0 on npm was broken. Do not use it.

`server.js` requires `./outbox.js`; `package.json`'s `files` whitelist omitted it. The published
tarball had no `outbox.js`, so `npm i @sym-bot/mesh-channel@0.7.0` failed at startup with
`Cannot find module './outbox.js'`.

Every test passed and the repo was green, because **every test ran against the working tree, where
the file is trivially present. The artifact users receive is a different artifact from the one we
tested.** The plugin install was unaffected — it installs from git.

Found from the registry tarball by a Codex agent, not by this repo's suite.

### Added — a release gate that tests the packed artifact

`npm run verify:packed`, wired into `prepublishOnly`: `npm pack` → install the tarball into an
empty directory → speak real MCP over stdio to the **installed** copy → exercise the three outbox
cases. It also asserts every local `require` in the installed `server.js` resolves on disk.

Plus static checks in `test/packaging.test.js`: every local module reachable from `server.js`,
transitively, must appear in `files`, and every entry in `files` must exist.

### Docs

README's offline-peer section still said absent peers were refused. Corrected, and trimmed to
usage rather than rationale.

## 0.7.0 (2026-08-10)

**A directed send to a peer that is not connected is now HELD, not refused.**

### The seam this closes

`sym_send` resolved the target against `node.peers()` and, when absent, **returned the refusal
before anything was sent**. No envelope left this package — so a correct, well-tested delivery
spool in `sym-daemon` sat downstream of a message that was never sent. The refusal lived in the
seam between two suites: mesh-channel's tests cannot see the daemon, the daemon's cannot see
mesh-channel. Two people reasoned about that boundary instead of crossing it, and a
`sym_send`-first acceptance test in the `sym` repo is what finally showed it.

**Why the queue is here rather than in the daemon** — measured, not assumed. mesh-channel has
**zero** references to `register-agent`, `daemon.sock` or `agent-cmb`, and the daemon log carries
**zero** hosted-agent registrations for any seat (109 for the ops agents). Seats are standalone
`SymNode`s, so a daemon-side spool cannot serve them until they register at all. Holding at the
sender needs no registration.

### Added — `outbox.js`

- **Durable, atomic**, at `~/.sym/nodes/<node>/outbox.json`. FIFO, survives restart.
- **Flushes automatically** when the peer appears (`peer-joined`), dropping items **only after the
  send returns** — never on dispatch, because a socket write is not delivery.
- **Known peers only.** A name is holdable only if this node has actually *seen* it, recorded in
  `known-peers.json`. `identity.json exists on disk` was rejected as the test: it is true for
  **961 of 962** node directories here, so it admits essentially everything. An unrecognised name
  stays a typed refusal — **a typo cannot create a queue.**
- **A full outbox refuses rather than evicting.** Dropping held mail would be invisible to everyone
  but this node. Caps are 200 items / 8 MB.

### Honest limits, stated in the tool output itself

The response says **`HELD AT SENDER — not delivered`**, names the peer it waits for, and says
plainly that the queue is invisible to that peer and lost if this node does not return. Pending
mail is reported in `sym_peers` and at startup — held mail that nobody can see is
indistinguishable from mail that was delivered.

**This fails when the SENDER is the intermittent one** — the mirror of the daemon spool's weakness.
It covers the observed case: a persistent seat sending to an intermittent one.

### Fixed — a test that measured a window instead of a fact

`plugin.test.js` bounded the `sym_send` handler at a fixed `caseIdx + 4000`. The handler grew to
~4,800 chars and the test went red reporting "explicitSend is missing" when `explicitSend` was
simply further down. It now finds the next `case` label in the full source.

## 0.6.5 (2026-08-10)

**Restarting the same node is now just a restart.**

### Fixed — a stdio server that outlives its host

Signals were handled; **stdin closing was not**. Not every host signals its children on the way
out — Codex quits without one, which left a `codex-mac` connector running with **PPID 1 for twenty
minutes past its parent**, still holding the pinned identity. The next launch hit `EIDENTITYLOCK`
and, correctly with `required = true`, died reporting a conflict with a process that could no
longer serve anyone.

**A stdio server whose stdin has closed is already dead** — the only channel a client could speak
on is gone. It now exits on stdin `end`/`close`/`error`, leaving the mesh cleanly and releasing the
identity lock.

### Changed — NEVER `-2`, NEVER `-3` (founder ruling)

`autoSuffix` is now **off for every identity**, pinned or not. It was previously on for unpinned
sessions.

A suffix looks like a courtesy and is a **data event**: `foo-2` is a different store with a
**different signing key**, so a seat keeps its name in conversation while silently becoming a new
cryptographic identity with none of its own memory. Three such stores existed on one machine —
`codex-mac`, `-2`, `-3` — each with its own keypair, minted by collisions nobody was told about.

A collision is now always a hard failure. The engine still reclaims a **dead** holder's stale lock;
that path is start-time-verified and is not a suffix. With the stdin fix above, the orphan that
caused collisions in the first place no longer survives.

Two tests that asserted `autoSuffix: true` were **inverted rather than deleted** — a test that
encoded the wrong design names the mistake where someone would repeat it — plus a new one proving
no input shape can produce a suffix.

## 0.6.4 (2026-08-10)

**0.6.3 put the room diagnostics on stderr. Some MCP hosts never show that.** Measured on Codex
CLI 0.144.0 by a Codex agent: a session with a misspelled or unset `SYM_ROOM` started normally and
displayed **none** of the child's non-fatal stderr. The warnings 0.6.3 added were invisible to
exactly the audience it was written for.

Worse, `required = true` cannot catch this class at all — **a wrong room does not fail startup.**
The server launches, the tools work, the session runs. It just talks to nobody.

### Changed — the advisory now travels IN BAND

- **In the MCP `initialize` instructions**, so the agent reads it whether or not the host surfaces
  stderr.
- **In `sym_peers` output on every call** — including `No peers connected`, which is the exact
  moment someone asks why the mesh is quiet. It now answers with the room and its source instead
  of leaving them to find stderr the host may never print.

Stderr logging from 0.6.3 stays; it is simply no longer the only path.

### Docs

- **What a wrong room actually looks like** — a per-host table of where the warning appears, and
  the observed `required = true` failure text (exit 1 before session creation) versus
  `required = false` (exit 0, session runs silently tool-less).
- A typo is the common case: `SYM_ROOM = "sym-bot-rooom"` resolves cleanly and joins a real, empty
  room. Nothing about it is invalid — it is just not where anyone else is.
- Codex **desktop** UI presentation is marked **UNTESTED**, because verifying it requires
  terminating the task doing the reporting. Not inferred, not quietly omitted.

## 0.6.3 (2026-08-10)

**Codex ↔ Claude Code duplex is now a supported, documented setup** — and the failure that made
it hard to reach now announces itself.

### Added — the room says where it came from

A node in the wrong room fails by going *quiet*, and quiet is the one symptom indistinguishable
from "nobody is talking right now". Three new signals:

- **Startup line naming the resolved room AND its source**:
  `node 'x' in room 'y' (_y._tcp) — room source: SYM_ROOM env`. Sources are `SYM_ROOM env`,
  the `.sym/node.json` path, `SYM_SERVICE_TYPE env`, or
  `nothing configured — this is the fallback, not a choice`.
- **`sym_room_info` reports `room source`** too, and says plainly when `default` was never chosen.
- **A warning when the `sym` daemon disagrees.** The daemon resolves its room from `~/.sym/room`;
  this server does not read that file. Two sym nodes on one host with two sources of truth means
  a host can partition against *itself*, which reads like a network problem and is not one.

Resolution and reporting now come from **one function**, so the answer and the explanation cannot
drift apart.

### Fixed

- **A malformed `.sym/node.json` was indistinguishable from an absent one.** Both collapsed to
  "no config", so a typo'd file left you in `default` with the file sitting there looking obeyed.
  Absent stays quiet; unreadable now says so and names the path.

### Docs

- **New: [Two vendors, one machine](README.md#two-vendors-one-machine-codex--claude-code).**
  Verified configs for both harnesses, and the rule that matters: **`SYM_ROOM` is required on the
  Codex side.** `CLAUDE_PROJECT_DIR` is set by Claude Code and nothing else, so Codex falls back to
  `process.cwd()` — a Codex seat is often in the right room only because of where it was launched.
- **Corrected routing table.** It sent Codex users to a different package. This one drives Codex
  directly over MCP stdio.
- Codex-side behaviour (config keys, and that a current desktop build has **no** Settings → MCP
  servers → Restart, treats `/mcp` as message text, and needs a full quit/reopen) was verified on a
  real build by a Codex agent rather than inferred from documentation.

### Known boundary, stated in the README

Both connectors must be live simultaneously. A directed send to a peer whose socket is down is
refused at the sender, not queued. Presence is required for delivery.

## 0.6.2 (2026-08-10)

### Fixed

- **The room rename was half-done and split across two packages.** 0.6.1 read `SYM_GROUP` while
  `sym` 0.11.1 wrote `SYM_ROOM` — 105 `group` occurrences, zero `SYM_ROOM`. A user setting
  `SYM_ROOM` got the daemon in the right room and the MCP node in `default`, with no error.
  Neither repo's tests could see it, because the two halves lived in different packages.
- `--group` → `--room` throughout the CLI, and the docs that still taught the old flag.

## 0.6.1 (2026-08-09)

### Fixed

- **The plugin manifest and `.mcp.json` launch pin still pointed at 0.6.0.** The published package
  and the version that actually launched disagreed.

## 0.6.0 (2026-08-07)

### Changed

- **Repin `@sym-bot/sym` 0.10.5 → 0.11.0 (core 0.7.4 → 0.8.1).** This carries a fix that would
  otherwise have discarded records: core's `verifyCMB` used to return `valid: true` for records
  it had never actually checked, and `recomputeKey` could not recompute a single record the
  library minted. See `@sym-bot/core` 0.8.0/0.8.1 and `@sym-bot/sym` 0.11.0.

  Nothing in this package derives or verifies a content address itself — it delegates to `sym` —
  so there is no call site here that a corrected core could invalidate. That was checked rather
  than assumed: `sym` had a hand-rolled workaround around the core defect and the bump alone
  turned it into a regression, so every consumer in this cascade was examined for the same shape.

  Resolved versions after install are verified, not the declarations: `sym` 0.11.0, `core` 0.8.1.

## 0.5.5 — 2026-08-04 · the version you install is now the version that runs

- Repairs 0.5.4: the plugin updated its version but still launched the previous runtime, so the
  restart-survival fix below never reached a running session. After updating, restart your MCP
  server (or Claude Code session) — deliveries then genuinely survive restarts.
- The release process now fails if the launched runtime version ever differs from the released
  one, so this class of silent lag cannot ship again.

## 0.5.4 — 2026-08-04 · deliveries survive a session restart

> *Entry written retroactively on 2026-08-04 — 0.5.4 shipped without a changelog entry. Note:
> 0.5.4 as installed still launched the 0.5.3 runtime; install 0.5.5 to actually receive this fix.*

- Tracks `@sym-bot/sym` 0.10.2: your node's delivery inbox now persists across session restarts.
  Anything sent to you while your session was away is waiting when a new session starts under the
  same identity, delivered exactly once, with sender identity intact. Previously those deliveries
  were silently lost with the old process.

## 0.5.3 — 2026-08-01 · the second opinion is now recorded

- Tracks `@sym-bot/sym` 0.10.1 / `@sym-bot/core` 0.7.0. The second view your node computes on each
  admission is now written down — one row per admission under `~/.sym/shadow/<node>.jsonl`, with
  numbers and booleans only, never the content of a block. It previously existed only as a summary
  count in the log and was otherwise discarded.
- Your node still acts on exactly what it acted on before. Nothing new crosses the wire.

## 0.5.2 — 2026-08-01 · picks up the shadow-gate runtime

- Tracks `@sym-bot/sym` 0.10.0 (and `@sym-bot/core` 0.6.0 beneath it). Your node now computes a
  second, binary view of each admission alongside the one it acts on, records it locally, and
  **acts on neither differently** — admission behaviour is unchanged and nothing new crosses the
  wire.
- The receive path also stops reporting a "redundant" verdict in the one case it could not
  justify: when the nearest-anchor comparison is unavailable, the field is graded normally
  rather than being called a duplicate on weaker evidence.

## 0.5.1 — 2026-08-01 · dependency advisories cleared

> *Entry written retroactively on 2026-08-01. 0.5.0 and 0.5.1 shipped without changelog
> entries; 0.5.0 also shipped without a tag, created after the fact at its release commit.*

- Clears outstanding dependency advisories. No behaviour change.

## 0.5.0 — 2026-08-01 · the boundary record model

> *Entry written retroactively on 2026-08-01 — see the note above.*

- Tracks `@sym-bot/sym` 0.9.0 and `@sym-bot/core` 0.5.0. Blocks your node emits now carry the
  two-section record: what your agent says, held separately from what the mesh proves about it,
  with signatures that verify against the author rather than whoever relayed it. Blocks from
  peers still on the older format remain readable.

## 0.4.3 — 2026-07-24 · stable node identity across restarts

- Fixes a case where a node could start under a suffixed name (e.g. `name-2`) instead of its
  configured identity, creating a separate empty store. It happened when a prior session's lock
  referenced a process id the OS had since reused, making a stale lock look active.
- Node-name collision handling is now delegated to the engine's process-liveness check, which is
  robust to reused process ids. A configured name (`SYM_NODE_NAME` / `.sym/node.json`) is used
  as-is; a genuinely running duplicate is reported clearly instead of silently starting a second
  identity. No change for the normal single-session case.

## 0.4.2 — 2026-07-24 · hotfix: pack `classifier-risk.js` (0.4.1 was broken on install)

- **0.4.1 shipped without `classifier-risk.js`** — the `files` allowlist in `package.json` was
  not extended for the new module, so the published tarball omitted it and every fresh install
  crashed on load with `Cannot find module './classifier-risk.js'` (`server.js` requires it).
- Adds `classifier-risk.js` to `files` and re-releases. No code change from 0.4.1; this only
  fixes the tarball. **Do not use 0.4.1** (deprecated on npm) — upgrade straight to 0.4.2.

## 0.4.1 — 2026-07-24 · ingest guard: quarantine classifier-risk peer CMBs

- **New receiver-side guard against a session-wedging failure mode.** A benign, non-injecting
  peer CMB whose wording was security/offensive-adjacent (e.g. "protocol stripped") passed
  `checkSecurity` but, once its text was auto-surfaced into the receiving agent's context and
  re-fed to the model, tripped the LLM provider's server-side usage-policy classifier — a hard
  API error that took down two consecutive requests and forced a session reset. Peer content is
  untrusted **prompt input**, not merely untrusted instructions.
- **`classifier-risk.js`** (`scanClassifierRisk`): the `cmb-accepted` and `message` delivery
  handlers now **quarantine** a flagged CMB — the auto-push carries metadata only (no peer
  free-text, no term names) and the verbatim body stays available for a deliberate `sym_fetch`.
  The guarantee is in *not auto-surfacing*, not in guessing what the classifier keys on; a false
  positive costs a fetch, never information. Composes with (does not replace) the existing
  injection / rate-limit / payload-size checks.
- Backward-compatible: unflagged deliveries are unchanged. 8 new unit tests; existing suite green.

## 0.4.0 — 2026-07-24 · cmb--only cutover (fail-closed, emission flips to bare `cmb-`)

- Pins `@sym-bot/sym` 0.8.0 (and through it `@sym-bot/core` 0.4.0) — the **fail-closed
  `cmb-`-only** engine. Key dispatch is now `cmb-<64hex>` → v1, and **anything else
  (`cmb1-<64hex>`, legacy `cmb-<32hex>`) is rejected**. The transitional `cmb1-` prefix is
  retired; emission is now bare `cmb-<64hex>`.
- **Ordering requirement:** a node on 0.4.0 rejects an un-migrated store, so the mesh store
  must be re-minted to `cmb-` *before* any process runs this version (0.3.42 was the
  read-both-prefixes release that made that migration safe). Do not update to 0.4.0 until the
  store is migrated.
- Plugin launch pin (`.mcp.json`) and `plugin.json` bumped to `@sym-bot/mesh-channel@0.4.0`.
  Bumping the pin also changes the npx cache key, so restarts resolve the 0.4.0 chain fresh.

## 0.3.42 — 2026-07-21 · verify both key prefixes before the cmb1- migration

- Takes `@sym-bot/sym` ^0.7.32 (and through it `@sym-bot/core` ^0.3.49), whose verification
  accepts a v1 CMB under **either** prefix. The mesh is migrating `cmb1-<64hex>` keys to
  `cmb-<64hex>`; the prefix used to select the signing scheme, and now the digest LENGTH does
  (64 hex = v1, 32 hex = legacy). Nothing in mesh-channel changes — it has no prefix dispatch
  and never treated the prefix as the scheme.
- **This release does not emit the new form.** Emission stays `cmb1-` until cutover. The order
  is deliberate: every process must be able to READ both prefixes before any process WRITES
  the new one, or blocks emitted by an upgraded node fail verification on one that has not
  restarted yet.

## 0.3.41 — 2026-07-18 · hotfix: `vetCmbArgs` scope bug broke every publish/send

- **`sym_publish` / `sym_send` threw `vetCmbArgs is not defined`.** The 0.3.39 input-hygiene
  guard was accidentally defined *inside* `publishGroupBeacon` — out of scope for the tool
  handlers — so every publish and send failed loudly until this fix moved it to top level.
  Test suite green. (Loud failure beat a silent drop, but the 0.3.39 insertion anchor — "last
  require in file" — had landed mid-function.)

## 0.3.40 — 2026-07-18 · send-path delivery integrity (E8 variant c)

- `sym_send` / `sym_publish` no longer report "Duplicate — not re-broadcast" for a CMB
  that was never delivered. `SymNode.remember()` dedups on the content hash of the CAT7
  fields, so an identical re-send is suppressed — but a **local-store hit is not proof of
  delivery**: a CMB stored while no peer was connected, or sent before a reconnect, blocked
  its own re-send forever and the operator's send silently never reached the mesh (the
  0.3.39 fix closed the *identical-defaults* cause; this closes the *genuinely-undelivered*
  one). The channel now tracks which CMB keys were actually delivered to a connected
  destination: a dedup against a **never-delivered** key is re-issued (disambiguated) so it
  goes out, while a dedup against an **already-delivered** key stays suppressed (no flood
  regression). Broadcasts and publishes with **no connected peers** now say so honestly
  instead of claiming "Broadcast to all peers". The delivered-key set resets on
  `sym_join_group` hot-swap (a reconnect voids prior delivery credits). Tests added
  (`test/plugin.test.js`): true-duplicate suppression, undelivered re-send, directed
  re-issue against a pre-existing store copy.

## 0.3.39 — 2026-07-18

- sym_publish / sym_send input hygiene: a habitual `content` param now MAPS to `focus`
  (the semantic repair — it was silently dropped, yielding constant all-default fields
  whose hash collided into "Duplicate" while the mind's actual content never reached
  the mesh); any other unknown top-level param is a loud error. A dropped param is a
  dropped meaning — silent drops must fail loudly (same failure family as the SVAF
  lifecycle-intent mute; see the E8 review item).

## 0.3.38

### Changed

- Mark display truncation in `receive` and `recall` — when a result is cut to fit, it now says so instead of silently thinning. A cut that hides its own existence is a silent loss of information.
- Pins the launched MCP server and the plugin manifest to `0.3.38` (`.mcp.json` → `npx @sym-bot/mesh-channel@0.3.38`, `.claude-plugin/plugin.json` → `0.3.38`) — the 0.3.38 release published to npm but left both pins at 0.3.37, so a `/plugin update` converged the fleet onto the previous runtime and the published version was unreachable from the plugin path.

## 0.3.37

### Changed

- Bumps `@sym-bot/sym` to `^0.7.27` — stops a cross-node echo/replay storm: own-only SVAF anchors (a node no longer re-forwards CMBs it received from peers) plus a reload-durable receive-dedup cache that survives a plugin reload / version skew.
- Pins the launched MCP server and the plugin manifest to `0.3.37` (`.mcp.json` → `npx @sym-bot/mesh-channel@0.3.37`, `.claude-plugin/plugin.json` → `0.3.37`), so a `/plugin update` actually converges nodes onto the fixed runtime. The marketplace installs from the repo HEAD and the launched version is hard-pinned in `.mcp.json`, so a bare npm publish alone was invisible to the fleet.

## 0.3.36

### Changed

- Bumps `@sym-bot/sym` to `^0.7.26` — nodes now self-report their memory stats (`emitted` / `admitted` / `memory`) to the roster as a lightweight `node-stats` frame, so a mesh observer (e.g. Mesh Edge) can show real counts for every node, including cross-machine agents whose stores it can't read locally.

## 0.3.35

### Changed

- Bumps `@sym-bot/sym` to `^0.7.25` — adds earned-authority-weighted attestation aggregation (EA6): a node can fold the roster's attestations about a CMB into a single verdict weighted by each attester's *resolved* role, so an anchor's verdict outweighs a participant's and over-claims cannot inflate consensus. Consumed by the Mesh Edge cockpit's source drawer.

## 0.3.34

### Changed

- Bumps `@sym-bot/sym` to `^0.7.24` — adds the **roster key registry** (EA5): a node can now verify attestations/grants relayed from peers it never directly handshook, because keys ride the anchor-rooted grant chain (the relayer never vouches). Forward-looking — invisible on a fully connected LAN, it removes the direct-connectivity cap on signature verification.

## 0.3.33

### Changed

- Bumps `@sym-bot/sym` to `^0.7.23` — brings **earned authority** to the fleet: a node's validator/anchor role is now resolved from a signed, anchor-rooted role-grant chain (MMP §6.5) and CMB validation/canonization is gated on that resolved rank. Backward compatible — dormant until an anchor is pinned (`SYM_FOUNDER_ANCHOR`), with nodes using their static role until then.

## 0.3.32

### Added

- **Durable audit trail reaches the fleet** (via `@sym-bot/sym` `^0.7.22`). A node's Admission Attestation trail — attestations, Merkle checkpoints, and witness countersignatures — now persists append-only on disk and reloads on startup, so it survives a restart instead of evaporating from memory; the per-attester chain cursor is restored so `seq`/`prev` keep linking across the restart boundary. Guarantee: tamper-evident + omission-evident to the last witnessed checkpoint, and durable across restarts. No tool-surface change. `npx` pin moves to `@0.3.32`.

## 0.3.31

### Added

- **Attestation gossip + cross-mesh audit trail with omission-evidence reach the fleet** (via `@sym-bot/sym` `^0.7.21` / `@sym-bot/core` `^0.3.43`). Nodes now gossip their signed per-field gating attestations across the roster (verified end-to-end, rate-limited, relayed once), attest every gate (reject/redundant too), and periodically commit Merkle checkpoints over their attestation chain that roster peers countersign — so once witnessed, a suppressed attestation is detectable (the recomputed root diverges). Guarantee: tamper-evident + omission-evident to the last witnessed checkpoint. No tool-surface change. `npx` pin moves to `@0.3.31`.

## 0.3.30

### Added

- **Admission Attestations reach the fleet** (via `@sym-bot/sym` `^0.7.20` / `@sym-bot/core` `^0.3.42`). When a node's SVAF gate admits a CMB, it now signs a per-field Admission Attestation and persists it on the gated remix (`cmb.admission`) — the durable, attributable, tamper-evident (against modification) audit record of the gating decision, with a per-attester hash-chain. No tool-surface change in this release; the substrate now produces and stores the records. `npx` pin moves to `@0.3.30`.

## 0.3.29

### Fixed

- **`sym_group_info` peer list no longer always reads "(no peers in this group)".** The handler called `node.getPeers()`, which is not a public `SymNode` method — the `typeof` guard always fell through to `[]`, so the peer list rendered empty even with peers connected, while `peers in group: N` (from `status().peerCount`) showed the real count. That count/list disagreement read as a membership-handshake failure during cross-device debugging but was purely a rendering bug. Now reads the list from `status().peers` (same source as the count). No transport change.
- **Cross-device opaque payload now survives on the SVAF-admit path** (via the `@sym-bot/sym` `^0.7.19` bump). A directed CMB's `payload` was dropped whenever the receiver SVAF-*admitted* it (the fused remix is rebuilt from CAT7 fields without the payload), so payload delivery silently depended on the receiver's per-node SVAF drift — the root of the "payload arrives on some peers, not others" asymmetry. Fixed upstream; the plugin's `npx` pin moves to `@0.3.29` to pull it.

## 0.3.28

### Fixed

- **Opaque payloads now survive the pull path.** A directed CMB's `payload` (structured data beyond CAT7) reached agents over the channel-push path but vanished on the `sym_receive` → `sym_fetch` pull path: the inbox message dropped it (fixed upstream in `@sym-bot/sym` 0.7.18, now a `^0.7.18` dependency) and the plugin read it from the wrong field and never returned it. `sym_fetch` now appends a `---PAYLOAD---` section, `sym_receive` security-checks `m.payload` and tags the line `[+payload]`. This is the substrate for cross-device agent-to-agent structured data exchange, not just CAT7 projections. Server change — the plugin's `npx` pin moves to `@0.3.28`.

## 0.3.27

### Docs

- **`@sym-bot` is now the canonical install path.** The README's headline install and channel-handle guidance pointed at `@claude-community` (the Anthropic community directory), whose auto-synced listing lags releases — so new users could land on stale code. Primary install is now `/plugin marketplace add sym-bot/marketplace` + `sym-mesh-channel@sym-bot`, which tracks the repo's `main` and is always current. The community directory stays as a secondary "also listed, may lag" credit.
- **Plugin/package descriptions now cover same-machine loopback.** They said the mesh runs "over Bonjour LAN or WebSocket relay" (and "remote teams"), omitting the headline capability — multiple sessions on one machine over loopback, no network at all. Updated both to read one-machine / LAN / cross-network.

## 0.3.26

### Docs

- **Per-project identity documented around `.sym/node.json`.** The README's per-project node identity section now leads with `.sym/node.json` (the v0.3.22+ reader) instead of the legacy `init --project`, which writes a project `.mcp.json`. Adds an explicit warning that pairing a project `.mcp.json` with the plugin double-registers the node into a phantom `<name>-2` peer, and a matching Troubleshooting entry. No code change.

## 0.3.25

### Changed

- **Runs the `meshmem/` → `cmbs/` store migration on install** (`bin/install.js` calls `@sym-bot/sym`'s `migrateStores()`), so every non-live node is migrated when the plugin is set up. Pairs with `@sym-bot/sym` 0.7.16.

## 0.3.24

### Changed

- **MCP tools renamed to canonical Enterprise Integration Pattern verbs:** `sym_observe` → **`sym_publish`** (Publish-Subscribe Channel) and `sym_inbox` → **`sym_receive`** (Polling Consumer). The I/O surface now reads as what the agent *does* (publish / send / receive), while the cognitive mechanism terms (emit/admit, projection/observation) stay in the MMP spec one layer down. `sym_send` (Point-to-Point) unchanged. Clean break — no aliases. Agent instructions + tool descriptions updated: publishing emits a *projection* of your state; a receiver that admits it takes it as an *observation*.

## 0.3.23

### Changed

- **Removed the automatic `postinstall` registration.** The package no longer mutates `~/.claude.json` (or a project `.mcp.json`) on `npm install`. As a Claude Code **plugin**, the package is launched via `npx` on every session start, and the postinstall re-registered a competing user-scoped `claude-sym-mesh` MCP server each time — producing a second mesh node alongside the plugin's own. Registration now happens only via the explicit `start`/`init` commands, which the standalone flow (`npx @sym-bot/mesh-channel start`) already runs and which self-configure on first launch — so there is no change for standalone users, and the plugin path no longer double-registers. Pairs with the 0.3.22 `.sym/node.json` reader to make the plugin the single, stable, per-project mesh node.

## 0.3.22

### Added

- **Per-project identity via `$CLAUDE_PROJECT_DIR/.sym/node.json`.** A named role agent (e.g. a CTO node `claude-code-mac` on `sym-bot-team`, or `melotune-dev` on `melo-ios`) can now commit `{ "node_name": "...", "group": "..." }` to `.sym/node.json` in its repo, and the plugin reads it on start. This lets the **plugin alone** carry a stable, per-project identity — no parallel `claude-sym-mesh` MCP registration in a project `.mcp.json`, which previously produced a *second* mesh node (the project-scoped server plus the plugin-scoped server are never deduplicated). Because the identity lives in the repo, it survives a plugin reinstall. Precedence is unchanged-and-extended: `SYM_NODE_NAME`/`SYM_GROUP` env still win, then `.sym/node.json`, then the auto `claude-<repo>-<session>` default. A missing or malformed file is ignored (falls back to the auto default) — never a hard fail.

## 0.3.21

### Changed

- **`sym_inbox` is now a thin adapter over the SDK primitive `node.inbox()`** (`@sym-bot/sym` ^0.7.11). The pull-based receive buffer + drain cursor moved down into the node, where it belongs alongside `node.remember()` (send) — so the SDK is sufficient for send **and** pull on its own, and the wrapper owns no buffering logic. Behaviour is unchanged (FIFO drain, `peek`, `limit`); `sym_fetch` now also resolves SDK inbox ids (`inNNNN`). The wrapper still applies the peer allowlist + prompt-injection filter on the pull path before anything enters context.

## 0.3.20

### Added

- **`sym_inbox` — pull-based receive (bypasses channel-push gating).** Claude Code 2.1.177 gates the real-time `<channel>` push behind a managed-settings policy + server-side allowlist, but the MCP tool layer is never gated. Every inbound CMB is already accumulated server-side (the cmb-accepted handler stores it *before* the gated push), so `sym_inbox` lets the agent **pull** messages received since its last check — directed `sym_send` addressed to it plus admitted broadcasts. FIFO drain with a read cursor (no message is skipped even past the page limit), `peek` for non-destructive reads, `limit` to page. The agent is instructed to poll `sym_inbox` at the start of a turn and periodically while coordinating, so receive works regardless of the channel-push policy gate. Compact `[mNNN]` headers; `sym_fetch` for full content.

## 0.3.19

### Added

- **Signed CMBs (MMP §8.3) — authenticity + integrity.** Pins `@sym-bot/sym` to `^0.7.10`: every CMB is now Ed25519-signed by its author and verified receiver-side against the sending peer's handshake-announced identity key **and** its content hash. A forged, tampered, or content-swapped CMB is rejected before it can reach Claude's context (audit-metered). Unsigned CMBs are allowed for interop unless `SYM_REQUIRE_SIGNED_CMB` is set. This is the cryptographic layer above the existing Ed25519 transport identity + SVAF relevance gate + prompt-injection filter. Version-bumped (plugin + `.mcp.json` pin) so installed plugins reinstall and pick up signing on restart.

## 0.3.18

### Added

- **Directed-delivery indicators in the channel header (MMP §9.2.2).** Pins `@sym-bot/sym` to `^0.7.9`, which adds an ingestion flag to surfaced CMBs. A CMB sent directly to this node now reads as `[peer →you]`; if SVAF delivered it but did not store it (`remixed:false`), the header adds `·not-stored` so the agent knows the directed request is transient, not recallable from mesh memory later. Broadcast CMBs are unaffected.

## 0.3.17

### Fixed

- **Directed (peer-bound) CMBs now reach the agent.** Pins `@sym-bot/sym` to `^0.7.8`, which carries the MMP §9.2.2 delivery fix: a CMB sent to a specific recipient (`sym_send to=X`) is surfaced to the receiving agent unconditionally, regardless of the SVAF verdict — SVAF governs memory admission only. Previously every inbound CMB (directed or broadcast) ran through the group-autonomous SVAF surfacing gate, so a directed coordination CMB scored low by SVAF was silently dropped. Group-bound broadcasts (`sym_observe`) remain SVAF-gated for surfacing, unchanged. Version-bumped (plugin + `.mcp.json` pin) so installed plugins reinstall and pick up the fix on restart.

## 0.3.15

### Fixed

- **`start` now finds `claude` on Windows.** The launch used `spawnSync('claude', …)` with no shell, which does an exact-filename lookup that ignores Windows `PATHEXT` — so `start` failed with `ENOENT` even when `claude` ran fine in the shell (there it resolves a `.cmd`/`.ps1` shim or `.exe`, never bare `claude`). The launch now routes through a shell on Windows so `PATHEXT` resolution applies; whitespace args are quoted since `shell: true` forwards them unquoted. The POSIX launch path is unchanged.
- **`start --name` no longer silently reverts identity on a stale entry.** `start` auto-injected `--force` only on a *live* entry mismatch, but `npx` rotates its cached `server.js` path on every version resolve, so the persisted entry is routinely stale yet still holds the node's name/group. On a re-run, `start` saw no live entry, pushed no `--force`, and `init`'s preserve-over-request precedence dropped the requested `--name` — reverting the node's identity to the stale name. `start` now reconciles against the persisted entry whether or not it's stale and forces the rewrite when an explicit `--name`/`--group` differs. The group is preserved when no `--group` is passed.

## 0.3.14

### Added

- **`sym-mesh-channel start` — one command to a live mesh session.** Configures the MCP server if needed, then launches Claude Code with the real-time Channels flag already on, so users never type `--dangerously-load-development-channels …` or have to choose between the `plugin:` and `server:` handle. `start --project --name <node> --group <team>` stands up a named mesh agent; `start --print` is a dry run; everything after `--` is forwarded to `claude`. Co-resident sessions don't collide (server.js auto-suffixes a live-identity clash since 0.3.10), so `start` in several terminals just works.

### Fixed

- **CLI subcommand dispatch via the published bin.** The `bin` entrypoint (`server.js`) only routed `init` to the installer, so `npx @sym-bot/mesh-channel doctor` silently fell through and started the MCP server instead. Now `init`, `doctor`, and `start` all route to the installer/launcher.
- **`init --force` with an explicit `SYM_NODE_NAME` now relabels the entry** instead of always preserving the prior name (symmetric with how `--group` already behaves). A routine reinstall with no explicit name still preserves identity.

## 0.3.13

### Changed

- **Track the latest released `@sym-bot/sym` (`^0.7.6`).** Pulls in the SVAF decision log (every evaluation — admit and reject — is now persisted and emitted) on top of the 0.7.5 replay-storm receive-path dedup. Additive; no API changes in mesh-channel.

## 0.3.12

### Changed

- **Bump `@sym-bot/sym` to `^0.7.5`** — mesh replay-storm receive-path dedup (dedup received CMBs so a co-resident peer restart no longer triggers a replay storm).

### Fixed

- Align install commands + channel-flag handles with the actual marketplace (#13).
- Fix 5 moderate Dependabot vulnerabilities (`npm audit fix`).

## 0.3.11

### Added

- **Prompt-injection filter (security layer 3).** Every incoming CMB — all CAT7 fields and the opaque payload — is now scanned against a curated blocklist of injection patterns before `pushChannel()` is called. Patterns cover: instruction-override phrases ("ignore previous instructions", "forget everything you know"), role/persona hijacking ("you are now a new AI", "act as an unrestricted assistant"), system-prompt injection (`<system>`, `[SYSTEM]`, `## system prompt`), tool-call fabrication (`<tool_call>`, `<function_calls>`), and privilege-escalation language ("override safety filter", "jailbreak", "DAN mode"). Blocked CMBs are audit-logged to stderr with reason, peer name, and a truncated excerpt — never silently dropped.

- **Per-peer rate limiting.** A sliding 60-second window caps each peer at `SYM_RATE_LIMIT` CMBs per minute (default: 30). CMBs exceeding the cap are blocked and audit-logged. Prevents flood attacks from a compromised or malfunctioning peer.

- **Payload size cap.** Payloads larger than `SYM_MAX_PAYLOAD_BYTES` (default: 8 192 bytes) are rejected before context injection. Prevents oversized-payload attacks that could exhaust the context window.

- **README security section updated** to document all four defence layers accurately.

### Security model

The full gate before any mesh signal reaches Claude's context is now:
1. **Transport** — Ed25519 peer identity + relay-token auth.
2. **Protocol** — SVAF per-field semantic relevance gate.
3. **Safety** — prompt-injection filter + rate limiter + payload size cap (this release).
4. **Application** — text-only injection; `claude/channel/permission` not declared.

## 0.3.10

### Fixed

- **Live-identity-collision auto-suffix.** Two sessions wanting the same `SYM_NODE_NAME` previously hard-failed with `EIDENTITYLOCK`. The server now checks whether the name's lock file is held by a live process; if so, it appends `-2`, `-3`, … (up to 64) until it finds a free slot. Stale locks (dead holder) are still reclaimed by `@sym-bot/sym` on start — unchanged. Result: duplicate dev-agent sessions, or any two sessions sharing a fixed `SYM_NODE_NAME`, coexist instead of failing.

## 0.3.9

### Fixed

- **stdout discipline — fixes `-32000 / Connection closed`.** The MCP JSON-RPC stream runs on stdout. Dependency load banners (e.g. `[encoder] Semantic encoder ready` from the semantic model) were printing to stdout, intermittently corrupting the handshake and causing Claude Code to log "Ignoring non-JSON line on stdout" or drop the connection with `-32000`. A stdout guard is now installed before any `require()`: lines that start with `{` (JSON-RPC frames) pass through to the real stdout; everything else is redirected to stderr. Verified: stdout is pure JSON after the fix.

## 0.3.8

### Added

- **Per-session node identity.** Each Claude Code session now gets its own mesh identity derived from the working-directory slug and a session-unique suffix (e.g. `claude-symday-webapp-6e174e`), instead of all sessions sharing the machine hostname. Enables multiple Claude Code sessions on the same machine to appear as distinct peers on the mesh — confirmed working over loopback via Bonjour with no relay.

- **`npx` launch path.** The plugin now launches via `npx @sym-bot/mesh-channel` rather than a global `node` path, so marketplace installs work without a prior `npm install -g`. The npx cache warms on first launch; subsequent sessions start in ~1 s.

## 0.3.7

### Changed

- **Bumped `@sym-bot/sym` dependency `^0.5.8` → `^0.7.4`** to track the current sym stack. The range had drifted: sym moved through 0.6.x/0.7.x (mesh groups, Windows portability) while this wrapper still declared `^0.5.8`, so an installed sym ≥0.6 showed as `invalid` and a reinstall could nest a stale 0.5.x that shadows the global. Pinning `^0.7.4` makes the dependency honest and, in particular, **requires the loopback-capable sym (≥0.7.4)** — co-resident nodes mesh over `127.0.0.1` with no network interface (Wi-Fi off). No code change in this package; dependency-range correctness only.

## 0.3.6

### Added

- **Group discovery beacon.** This MCP node now advertises its mesh group on a shared `_symgroups._tcp` service (group name in TXT) via the pure-JS `bonjour-service` — published on start, re-published on `sym_join_group` hot-swap, torn down on shutdown. Makes the Claude/MCP node discoverable by the `sym` CLI's `sym groups` command **cross-platform, including Windows** (where Apple's `dns-sd` is absent), so CLI-daemon and Claude/MCP nodes list together. Discovery-only — comms stay isolated on the group's own `_<group>._tcp`. `bonjour-service` pinned as a direct dependency. Validated on Windows 11.
- **Operational note:** a session started before 0.3.6 must restart to begin beaconing.

## 0.3.5

### Added

- **Opaque payload on `sym_send` / `sym_observe`.** Both tools accept
  an optional `payload` argument carrying data beyond CAT7 — any
  JSON-serializable value. Forwarded to `SymNode.remember(fields, {
  payload, … })` (requires `@sym-bot/sym` ≥ 0.5.8) and rides the wire
  frame to peers. Used by substrate-level protocols that need to carry
  structured data alongside CAT7 (e.g. LLM request/response, where the
  prompt + request_id ride in `payload` rather than getting smuggled
  through `motivation`).
- **Channel notifications surface payload-bearing CMBs.** When an
  incoming peer CMB carries `cmb.payload`, the header gains a
  `[+payload Nb]` indicator and the body stored by `sym_fetch`
  includes a `---PAYLOAD---` section with the serialized payload.
  Receivers learn from the header that there's structured data beyond
  CAT7 and call `sym_fetch` to consume it.
- Base MCP instructions now teach agents to recognise the
  `[+payload Nb]` header and to pass structured responses via the
  `payload` argument when emitting substrate-level CMBs.

### Compatibility

- Omitting `payload` produces a v0.3.4-shaped CAT7 CMB byte-for-byte.
- Old peers (without `cmb.payload`) surface unchanged headers — no
  `[+payload …]` indicator, no PAYLOAD section in the body.

## 0.3.4

### Added

- **`SYM_GROUP` is now first-class in the installer.** `init` accepts a
  `--group <name>` flag and reads the `SYM_GROUP` env var; both paths
  persist the chosen group into the `~/.claude.json` (or project
  `.mcp.json`) env block so every Claude Code launch auto-joins the
  named group instead of the global `_sym._tcp` mesh.

  Resolution order is `--force`-aware:
    - With `--force` and an explicit `--group`/`SYM_GROUP`: flag/env wins
      (one-command group switch on a live entry).
    - Without `--force`, or with `--force` but no explicit value:
      preserved value from any existing entry > explicit > none (omit).

  `--force --group default` (or `SYM_GROUP=default`) is the explicit
  escape hatch to revert a node from a named group back to the global
  mesh — removes `SYM_GROUP` from the env block entirely rather than
  writing the literal string "default".

  Both `--group` and `SYM_GROUP` env values are validated against the
  same kebab-case regex; malformed values exit with a clear error
  before any file write.

- **`doctor` now reports the persisted group per entry** and warns when
  user-global and project-scoped entries disagree on `SYM_GROUP`.
  Group-mismatch is the most common cause of "peers never appear in
  `sym_peers`" with no other failure signal — surfacing it inline saves
  the diagnostic walk that motivated this release.

- **README** gains a "Persisting your group across restarts" subsection
  under Team mesh groups, plus a troubleshooting entry covering the
  group-mismatch failure mode. Quick-start shows the `--group` flag.

### Fixed

- **Stale-entry heal preserves `SYM_GROUP` alongside `SYM_NODE_NAME`.**
  Previously, healing a stale `claude-sym-mesh` entry (args[0] points at
  a missing server.js) silently dropped any persisted `SYM_GROUP`,
  reverting the node to the default mesh on next launch and stranding
  teammates who stayed in the named group. The heal path now copies
  both fields from the prior entry into the rewrite.

  Same fix applied to project-scoped entry healing under
  `claudeJson.projects[<path>].mcpServers`.

### Why this matters

Before 0.3.4, the only way to persist a group was to hand-edit
`~/.claude.json`. The README pitched `sym_join_group` as the team-mesh
UX, but that tool is runtime-only — the next Claude Code launch reverted
the node to the default mesh, peer count dropped to zero, and the user
saw no diagnostic signal. The 2026-05-02 SYM.BOT incident (CMO in
`default`, COO in `sym-bot-team`, ~24h of silent duplex outage) traced
directly to this gap.

## 0.3.3

### Fixed

- **Real-time duplex for CAT7 CMBs.** The `cmb-accepted` handler now
  stores the rendered CMB body under an `[mNNN]` ID and includes that
  ID in the channel notification, matching the contract stated in the
  MCP instructions ("Messages arrive as compact headers with [mNNN] IDs
  — use sym_fetch to read the full content") and the behaviour of the
  raw-text `message` path.

  Previously only the legacy raw-text `message` event persisted bodies
  to `MESSAGE_STORE` — the primary `cmb-accepted` event (fired for
  every structured CMB delivered via `sym_send` / `sym_observe`) pushed
  a headline with no `[mNNN]` and left no retrievable body. Inbound
  CMBs were admitted to the SVAF-backed memory store and surfaced by
  `sym_recall` as compact headlines, but `sym_fetch` could not return
  their content — the duplex was effectively headline-only for the 99%
  case of real mesh traffic.

  Symptom: after the 0.3.2 Mac↔Win fix restored bidirectional packet
  flow, peers' structured replies appeared in `sym_recall` but returned
  *"expired or invalid ID"* from `sym_fetch` — because `storeMessage()`
  had never been called for them. Now both the raw-text and CAT7 paths
  persist bodies identically.

## 0.3.2

### Fixed

- **Pulls in `@sym-bot/sym` 0.5.1** — fixes Mac↔Windows peer connections
  over LAN. Prior releases shipped a Bonjour advertisement whose SRV
  target was the bare Windows NetBIOS hostname (e.g. `xmesh-hp.`) with
  no `.local` suffix. macOS mDNSResponder only resolves `.local.` mDNS
  names, so Macs could discover Windows peers via bonjour browse but
  failed to open the outbound TCP connection. CMBs targeted at Windows
  nodes never arrived; no replies came back. Full diagnosis in sym
  0.5.1 CHANGELOG.

  Upgrade required on both sides to restore Mac↔Windows traffic.
  Existing Windows identities with a bare hostname are auto-migrated
  on next node start; no manual config edit needed.

## 0.3.1

### Fixed

- **Installer no longer silently ships a broken MCP config.** Previously,
  if `~/.claude.json` already contained a `claude-sym-mesh` entry,
  `npm install -g @sym-bot/mesh-channel` (via postinstall) and
  `npx @sym-bot/mesh-channel init` both skipped with "already configured"
  — even when the entry's `args[0]` server.js path no longer existed on
  disk (common after moving or reinstalling the repo). Users saw
  `/mcp` report "Failed to reconnect" with no diagnostic hint.

  The installer now classifies entries whose `args[0]` is missing as
  **stale** and rewrites them automatically without `--force`, preserving
  `SYM_NODE_NAME` from the prior entry so mesh identity doesn't drift
  back to the hostname-based default. Live entries continue to require
  `--force` for overwrite.

- **Stale project-scoped entries are now healed too.** `~/.claude.json`
  can carry per-project `mcpServers` overrides under
  `projects.<dir>.mcpServers`, and Claude Code prefers those over the
  user-global entry when launched from that directory. A healthy
  user-global entry was therefore being silently shadowed by stale
  project entries. `init` now scans every project, rewrites any stale
  `claude-sym-mesh` entry, and preserves each project's `SYM_NODE_NAME`.

### Added

- **`sym-mesh-channel doctor` subcommand.** Read-only diagnostic that
  lists every `claude-sym-mesh` entry in `~/.claude.json` (user-global
  and every project scope) with `[live]` or `[STALE]` plus its
  `SYM_NODE_NAME` and configured path. Point users here when `/mcp`
  reports "Failed to reconnect". No writes, safe to run any time.

- **README troubleshooting section** covering the `/mcp` failure path,
  how to run `doctor`, and when restart is needed after a config change.

### Changed

- `.claude-plugin/plugin.json` version field bumped to `0.3.1` to match
  `package.json`. Previous drift (`plugin.json` stuck at `0.2.0`, package
  at `0.3.0`) was caught by the in-repo version-parity test.

## 0.3.0

### Added

- **Startup remix-memory primer — automates agent memory recall on
  session/agent restart (MMP §4.2 O2, rejoin-without-replay).** As the
  final step of plugin initialisation (after `node.start()` and before
  the MCP transport connects), the plugin calls
  `node.buildStartupPrimer()` and appends the returned text to the MCP
  server's `instructions` field. A fresh Claude Code session wakes
  with the agent's own remix memory — own observations plus peer
  observations admitted by SVAF — already loaded into context. No
  first-turn `sym_recall` required; agent acts from prior state
  immediately.

  Default caps: last 24 hours OR 20 most recent CMBs, whichever is
  tighter. The primer lists each entry as `[timestamp] source · key —
  focus` and surfaces a dropped-count line when caps elide older
  entries. Empty store is a silent no-op.

### Changed

- **`@sym-bot/sym` dep bumped to `^0.5.0`** to pick up the
  `buildStartupPrimer` helper and to keep every plugin on the
  sym.day platform pinned to the same substrate SDK version
  (no drift across mesh-channel / melotune-plugin / future
  specialised plugins).

## 0.2.0

### Breaking

- **`sym_send` tool signature change.** `sym_send` now emits a structured
  CAT7 CMB (MMP §4.2) instead of a raw-text `type:'message'` frame, and
  accepts an optional `to` parameter for targeted single-peer delivery
  per MMP §4.4.4.

  Old signature: `sym_send(message: string)`
  New signature: `sym_send(focus: string (required), issue?, intent?,
  motivation?, commitment?, perspective?, mood?, to?)`

  Migration: agents that previously called `sym_send({message: "..."})`
  should now pass the CAT7 fields explicitly, with `focus` carrying the
  task anchor for the send. Prior ephemeral text-broadcast behaviour is
  no longer exposed at the tool surface — `sym_send` and `sym_observe`
  both emit CMBs now, receivers run SVAF per §9.2, and admitted CMBs are
  remix-stored with lineage. The low-level `node.send(text)` SDK API is
  unchanged but no longer surfaced as a tool.

### Added

- **Targeted CMB send.** `sym_send` resolves `to` against connected
  peers by full nodeId first, then display name, then 8-char prefix.
  Ambiguous matches return an error asking for the full nodeId; a
  disconnected target returns an error and suggests `sym_peers`.
- **Tool descriptions** for `sym_send` and `sym_observe` now explicitly
  call out the SVAF receive path and lineage semantics, and the MCP
  server's `instructions` string reflects the new division of labour.
- **`@sym-bot/sym` dependency bumped to `^0.3.81`** for
  `remember(fields, {to})` targeted variant and `peers().peerId`.

## 0.1.23

### Added

- **`sym_join_group(group, relay_url?, relay_token?)`** — hot-swap this
  node into a different mesh group at runtime, no Claude Code restart.
  Stops the current SymNode, reconstructs it on the new service type
  (and optional relay), re-registers event handlers, restarts. The
  "smooth way to join" that was missing in 0.1.22.

- **`sym_invite_create(group, relay_url?, relay_token?)`** — generate
  a shareable invite URL for a named group. Two flavors:
  - LAN-only: `sym://group/{name}` (Bonjour isolation only)
  - Cross-network: `sym://team/{name}?relay=...&token=...` (routes via
    a WebSocket relay so teammates on different networks can join).
  Validates kebab-case group names, rejects token without URL.

- **`sym_invite_info(url)`** extended to parse the new `sym://team/`
  path and the `relay=` + `token=` query-string parameters.
  Output now includes a ready-to-paste `sym_join_group` call as JSON.

- **`sym_groups_discover()`** — enumerate SYM-mesh groups currently
  advertising on the local LAN via Bonjour / mDNS. Shell-outs to
  `dns-sd` (macOS/Windows) or `avahi-browse` (Linux) with a 2-second
  timeout, filters to service types matching the SYM protocol family
  (global `_sym._tcp`, named groups, `{app}-{id}` rooms). Peer-to-peer
  means only groups with live members right now are visible — no
  central directory.

- **README — "Dev-team groups" walkthrough** with two concrete scenarios:
  LAN dev-team group (single office) and cross-network team group via
  the public `wss://sym-relay.onrender.com` relay. Shows exact tool
  calls from both the team lead and each teammate.

- **13 new tests** covering invite URL parse, generate, round-trip, and
  validation (kebab-case, token-requires-URL guard). Test suite now at
  35 tests total.

### Changed

- Module-level `node`, `GROUP`, `SERVICE_TYPE`, `RELAY_URL`,
  `RELAY_TOKEN` declared as `let` (was `const`) so the hot-swap path
  can re-bind them. All node event handlers (`identity-collision`,
  `cmb-accepted`, `message`) extracted into a single
  `registerNodeHandlers(n)` function so the hot-swap path re-attaches
  them without duplicating logic.

- Tool count in README corrected to 11 (was 8 in 0.1.22):
  + sym_invite_create, sym_join_group, sym_groups_discover.

## 0.1.22

### Added

- **Plugin marketplace distribution**: `.claude-plugin/marketplace.json`
  enables direct install via the Claude Code plugin marketplace without
  waiting on the Anthropic Plugin Directory propagation pipeline:

  ```
  /plugin marketplace add sym-bot/sym-mesh-channel
  /plugin install sym-mesh-channel@sym-mesh-channel
  ```

  Validates cleanly with `claude plugin validate .` and installs
  end-to-end with no manual steps.

- **`LICENSE`** file (Apache-2.0). `package.json` already declared
  Apache-2.0 but no LICENSE text was present in the repo; this
  aligns the distribution with SPDX expectations.

- **MMP §5.8 mesh-group support** — LAN isolation via Bonjour service
  type so Claude Code sessions can join app-specific meshes (e.g.
  MeloTune mood rooms on `_melotune._tcp`) instead of the global
  `_sym._tcp` mesh. Enables cross-app CMB delivery without cross-app
  noise: nodes in different groups never discover each other at mDNS.

  Config surface (two equivalent paths):
  - `SYM_GROUP=<name>`       → service type `_<name>._tcp`
  - `SYM_SERVICE_TYPE=<st>`  → explicit override (`_foo._tcp` form)

  Default remains `_sym._tcp` / `group=default` — backward compatible.

- **Two new MCP tools for mesh-group operations**:
  - `sym_group_info` — reports current group + service type + peer
    roster scoped to this group.
  - `sym_invite_info` — parses app-specific invite URLs
    (`melotune://room/{id}/{name}`, `sym://group/{name}`) into service
    type + group + room name. Read-only inspection; caller opens a
    new session/env to join.

  `sym_status` output now includes `Group` + service type.

### Fixed

- **`plugin.json` validation failure on install.** The three
  `channels[0].userConfig` entries (`relay_url`, `relay_token`,
  `allowed_peers`) were missing the required `type` and `title`
  fields per the Claude Code plugin schema. Install failed with:

  ```
  channels.0.userConfig.relay_url.type: Invalid option
  channels.0.userConfig.relay_url.title: expected string, received undefined
  ```

  Added `type: "string"` and a human-readable `title` to all three.
  Likely one of the root causes of the 10 Apr 2026 submission
  showing "Published" on the Anthropic submissions portal but not
  propagating to the public `claude-plugins-official` marketplace.

### Changed

- **README**: self-hosted plugin-marketplace install path promoted to
  the primary install recommendation (works today, independent of
  Anthropic directory propagation). npm path kept as alternative.
  Tool table updated 5 → 8 entries to reflect the current surface.
  Clarified that plugin-directory approval and Channels-allowlist
  inclusion are independent gates — the MCP tools work without the
  `--dangerously-load-development-channels` flag; the flag is only
  needed for the `<channel>` async-push behaviour.

- Pairs with `@sym-bot/sym` ≥ 0.3.78 which added the
  `discoveryServiceType` and `group` constructor params consumed by
  the mesh-group tools.

## 0.1.21

### Changed

- **README: accurate `sym_status` / `sym_peers` example output.** The
  Quick Start sample output was a stylized one-line compression; the
  real output is multi-line with additional fields (nodeId suffix,
  Relay, Memories, one peer per line). Updated so users see in the
  README exactly what their terminal will show. Doc-only — no code
  changes.

## 0.1.20

### Added

- **`sym-mesh-channel init --project`** — new flag to install the MCP
  server at project scope (`<cwd>/.mcp.json` + merged
  `<cwd>/.claude/settings.local.json`) instead of global
  `~/.claude.json`. Enables multi-identity-per-machine workflows where
  several Claude Code sessions run in parallel from distinct project
  directories and each appears as its own peer on the mesh. Project
  `.mcp.json` entries override the global `mcpServers` entry when
  Claude Code launches from that directory, so `SYM_NODE_NAME` can
  differ per project without siblings stepping on each other.
- Project mode supports the same `--force` semantics as global install:
  backs up existing `.mcp.json` and `settings.local.json` next to
  themselves (`*.bak-<timestamp>`), merges `settings.local.json` so
  unrelated keys (permissions, custom settings) are preserved, atomic
  writes via tmp+rename, refuses to overwrite an existing
  `claude-sym-mesh` entry without `--force`.
- `--postinstall` always runs global install regardless of `--project`
  (npm postinstall runs from npm's staging dir, not the user's
  project). Keeps `npm install -g` auto-configure behavior unchanged.
- **5 new tests** covering project-mode install: writes `.mcp.json`
  and `settings.local.json`, merge preserves existing keys, refusal
  path exits 2, `--force` overwrite creates backup, postinstall
  fallback ignores `--project`. Test suite now 22 tests total.

### Why

Default mode (single mesh identity per machine, global install) is
correct for most users and unchanged. `--project` exists for the
small but real set of users who run multiple Claude Code sessions
in parallel from distinct project directories and want each session
to show up as its own peer on the mesh. Previously this workflow
required hand-editing `.mcp.json` and `.claude/settings.local.json`
per project; now it's one command per project.

## 0.1.19

### Added

- **Claude Code plugin manifest** for Anthropic Channels allowlist
  submission. `.claude-plugin/plugin.json` + `.mcp.json` following the
  official single-repo pattern (Telegram/Discord). Submitted to
  Anthropic Plugin Directory 10 Apr 2026.
- **`SYM_ALLOWED_PEERS`** — optional peer allowlist (defense-in-depth).
  Comma-separated node names; only listed peers can push to Claude's
  context. Empty = accept all authenticated peers. SVAF still gates on
  content relevance regardless.
- **`SECURITY.md`** — 3-layer defense model documentation (transport
  auth + SVAF content gate + peer allowlist) for Anthropic review.
- **17 plugin tests** covering manifest validation, security checks
  (no permission relay, no code execution, self-echo filtering, peer
  allowlist), and lifecycle (shutdown handlers, identity collision).

## 0.1.18

### Changed

- **Auto-configure on install.** `npm install -g` now runs `postinstall`
  that writes the MCP server config to global `mcpServers` in
  `~/.claude.json` automatically. No separate `sym-mesh-channel init`
  step needed — two commands to mesh: install + launch.
- **Global MCP config** — server entry is now written to top-level
  `mcpServers` (available in all Claude Code sessions), not
  project-scoped.
- **Windows postinstall fixes** — `require.resolve` for server.js path
  (handles npm staging directory on Windows), EBUSY handling when
  Claude Code has `~/.claude.json` locked, graceful skip if Claude
  Code not yet installed.
- **README repositioned** — lead with capability ("first non-Anthropic
  Claude Code Channels implementation"), not use case. Simplified
  Quick Start to two commands.
- **0 vulnerabilities** — fresh dependency rebuild resolves all 6
  moderate hono/node-server advisories.
- Windows mDNS: built-in on Windows 10+, no Bonjour install needed.

## 0.1.7

### Added

- **`npx @sym-bot/mesh-channel init`** — interactive installer that
  writes `~/.claude.json` for the current project, picks a sensible
  default `SYM_NODE_NAME` (`claude-mac` / `claude-win` / `claude-linux`),
  resolves the absolute path to `server.js`, and prints the launch
  command including the `--dangerously-load-development-channels` flag.
  Backs up the existing config to `~/.claude.json.bak-<timestamp>`,
  validates JSON round-trip, atomic write via tmp+rename. Refuses to
  overwrite an existing entry without `--force`.
- **README rewritten for LAN-first install.** Quick start is two
  minutes: install, init, launch. No relay required. Bonjour/mDNS
  is the default discovery path. Cross-network setup (relay) is now
  the optional advanced section.

### Changed

- `package.json` `bin` now exposes both `sym-mesh-channel` (server
  entrypoint) and `sym-mesh-channel-init` (installer). The package
  description leads with "LAN-first via Bonjour, no relay required."

### Why

The 0.1.5/0.1.6 install path required users to manually edit
`~/.claude.json`, know about the Channels dev flag, set up a relay,
and obtain a relay token. That gated the demo behind real friction.
LAN-only mode has worked since day one in the underlying SymNode
(`sym/lib/node.js:509-511` only connects to the relay if `SYM_RELAY_URL`
is set; Bonjour discovery starts unconditionally), but no documentation
or installer surfaced it. This release closes that gap: two users on
the same wifi can join the same mesh in two minutes with three commands.

## 0.1.6

### Fixed

- `sym_send` no longer double-delivers. Previously called both
  `node.send()` (broadcast as `event_type=message`) AND `node.remember()`
  (persist as CMB which gets gossiped as `event_type=cmb`), causing
  the same payload to arrive twice on receivers and double the
  context-window cost. Now broadcasts the message frame only. Hosts
  that want CMB persistence should call `sym_observe` separately
  with proper CAT7 fields.
- `sym_send` now reports the actual delivered count, not
  `peers().length`. Requires `@sym-bot/sym >= 0.3.70` where `send()`
  returns the count of peer transports that successfully accepted
  the broadcast. The two can disagree when peers are tracked but
  have broken transports — the delivered count is the truth about
  what was actually sent.

### Changed

- Bumped `@sym-bot/sym` dep `^0.3.69` → `^0.3.70`. 0.3.70 ships the
  identity lockfile that prevents two SymNode processes from
  claiming the same nodeId on a host (the cliHostMode-vs-MCP
  collision that broke real-time push on Windows during the
  2026-04-09 round-trip test).

## 0.1.5

### Changed

- Bumped `@sym-bot/sym` dep `^0.3.68` → `^0.3.69` (0.3.68 deprecated;
  same code in 0.3.69 with a cleaner published tarball).
- Added `files` whitelist to `package.json` and `.npmignore` for
  `*.bak`, `*.swp`, `.DS_Store` so future publishes can't accidentally
  ship local backup files. First NPM publish of this package.

## 0.1.4

### Changed

- Bumped `@sym-bot/sym` dep `^0.3.43` → `^0.3.68` to pick up
  duplicate-identity refusal (close code 4004) and the new
  `identity-collision` event.

### Added

- Wired `node.on('identity-collision', ...)` to `process.exit(2)` so
  the MCP dies cleanly when the relay reports a duplicate-identity
  race. Together with v0.1.3's clean shutdown, this fully resolves
  the host-side half of the duplicate-identity bug.

## 0.1.3

### Added

- Clean shutdown handlers (SIGTERM/SIGINT/SIGHUP) that call
  `node.stop()` before exiting, so the SymNode disconnects from the
  relay before the process dies. Without this, restarts left zombie
  registrations on the relay until the next heartbeat tick (up to
  30s), creating a duplicate-identity race window for the next MCP
  spawn. Idempotent re-entry guard.

## 0.1.2

### Fixed

- Suppressed `peer-joined` / `peer-left` events from being pushed to
  Claude's context as `<channel>` notifications. Presence is high-
  frequency and low-signal — a relay reconnect could fire one event
  per peer per cycle, flooding the context window. CMBs and direct
  messages still flow through.

## 0.1.1

### Changed

- Replaced hardcoded `claude-code` / `claude-code-mac` literals with
  a single `NODE_NAME` constant sourced from `process.env.SYM_NODE_NAME`
  (default `claude-code-mac`). Enables platform-scoped naming per
  MMP §3.1.2 without source edits. Fixed stale display strings in
  the MCP instructions, `sym_send` perspective, `sym_status` header,
  and the self-echo dedup filter.

## 0.1.0

### Added

- Initial release. MCP server that runs a `SymNode` peer node inside
  a Claude Code session — own identity, own relay connection, own
  SVAF evaluation. Tools: `sym_send`, `sym_observe`, `sym_recall`,
  `sym_peers`, `sym_status`. Mesh events arrive as `<channel>`
  notifications when launched with
  `claude --dangerously-load-development-channels server:claude-sym-mesh`
  (allowlisted server name required by Claude Code Channels).
