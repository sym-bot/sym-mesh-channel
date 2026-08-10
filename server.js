#!/usr/bin/env node
'use strict';

// Subcommand dispatch: CLI subcommands run the installer/launcher, not the
// MCP server. (When Claude Code spawns the server there is no subcommand, so
// argv[2] is undefined and this falls through to the MCP server below.)
if (['init', 'doctor', 'start'].includes(process.argv[2])) {
  require('./bin/install.js');
  return;
}

// ── stdout discipline (v0.3.9) ──────────────────────────────────────────────
// MCP frames JSON-RPC on stdout. Any non-JSON write there — ours or, far more
// often, a dependency's load banner (e.g. "[encoder] Semantic encoder ready"
// from the semantic model) — corrupts the stream and makes Claude Code drop the
// connection (-32000) or log "Ignoring non-JSON line on stdout". Guard it: lines
// that look like JSON-RPC (start with '{') pass through to the real stdout;
// everything else is redirected to stderr. Installed before any require so it
// catches dependency output at load time.
const __realStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
  try {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (s.trimStart().startsWith('{')) return __realStdoutWrite(chunk, ...rest);
    return process.stderr.write(chunk, ...rest);
  } catch {
    return __realStdoutWrite(chunk, ...rest);
  }
};

/**
 * sym-mesh-channel — MCP server that makes Claude Code a peer node on the SYM mesh.
 *
 * Architecture (MMP Section 13.9: Local Event Interface):
 *   SymNode (own identity, own SVAF field weights) → relay → mesh
 *   MCP channel notifications → Claude Code (real-time push)
 *   MCP tools → SymNode methods (send, publish, recall)
 *
 * This is a PEER NODE, not a client of the daemon. It has its own identity,
 * its own relay connection, and its own SVAF evaluation with engineering-domain
 * field weights. Per MMP Section 3: every participant is a peer.
 *
 * Copyright (c) 2026 SYM.BOT. Apache 2.0 License.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { SymNode } = require('@sym-bot/sym');
const { scanClassifierRisk, quarantineHeader } = require('./classifier-risk.js');
const { resolveIdentity } = require('./identity.js');

// Kebab-case validator shared by room-related tools.
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Invite URL parsing (shared by sym_invite_info and the internal
//    validation path for sym_join_room when passed a URL). Exposed as
//    a module-level function so it's trivially unit-testable and the
//    same regex doesn't drift between two call sites.

const INVITE_URL_RE = /^([a-z][a-z0-9-]+):\/\/(?:room|room|team)\/([^/?#]+)(?:\/([^?#]+))?(?:\?(.+))?$/i;

function parseInviteURL(url) {
  const m = INVITE_URL_RE.exec(url);
  if (!m) {
    return {
      error:
        `Unrecognised invite URL: ${url}\n\n` +
        `Expected shapes:\n` +
        `  sym://room/{name}                        (LAN-only)\n` +
        `  sym://team/{name}?relay=...&token=...     (cross-network via relay)\n` +
        `  melotune://room/{id}/{name}               (app-specific room)`,
    };
  }
  const appScheme = m[1].toLowerCase();
  const rawId = decodeURIComponent(m[2]);
  const rawName = m[3] ? decodeURIComponent(m[3]) : rawId;
  const queryStr = m[4] || '';
  const query = Object.fromEntries(
    queryStr.split('&').filter(Boolean).map(kv => {
      const [k, v = ''] = kv.split('=');
      return [decodeURIComponent(k), decodeURIComponent(v)];
    })
  );
  // For sym:// the path element IS the room name. For app-scoped URLs
  // (melotune://, melomove://, etc.) the path is the room id and the
  // room is prefixed with the app name to avoid collisions.
  const serviceType = appScheme === 'sym' ? `_${rawId}._tcp` : `_${appScheme}-${rawId}._tcp`;
  const room = appScheme === 'sym' ? rawId : `${appScheme}-${rawId}`;
  return {
    appScheme,
    room,
    serviceType,
    roomId: rawId,
    roomName: rawName,
    relayUrl: query.relay || null,
    relayToken: query.token || null,
  };
}

// ── Bonjour discovery of live SYM-related service types.
//    Runs `dns-sd -B _services._dns-sd._udp local.` (macOS / Windows with
//    Bonjour) or `avahi-browse -at` (Linux) for 2 seconds, filters to
//    service types that look SYM-ish, and reports them. Pure observation,
//    no node state changes.

async function discoverRooms() {
  const { spawn } = require('child_process');
  const platform = process.platform;

  let cmd, argv;
  if (platform === 'darwin' || platform === 'win32') {
    cmd = 'dns-sd';
    argv = ['-B', '_services._dns-sd._udp', 'local.'];
  } else {
    cmd = 'avahi-browse';
    argv = ['-t', '-a', '-p']; // terminate after cache, all services, parseable
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({
        isError: true,
        text:
          `Could not run discovery command '${cmd}': ${e?.message || e}\n\n` +
          (platform === 'linux'
            ? `On Linux, install avahi-utils: sudo apt install avahi-utils`
            : `Bonjour should be built-in on macOS and Windows 10+.`),
      });
    }
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.on('error', (e) => resolve({ isError: true, text: `Discovery command failed: ${e?.message || e}` }));

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, 2000);
    child.on('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      const typeRe = /_([a-z0-9][a-z0-9-]+)\._tcp/gi;
      const seen = new Set();
      let m;
      while ((m = typeRe.exec(text)) !== null) {
        const full = `_${m[1]}._tcp`;
        // Filter to the SYM protocol family: global sym, named rooms, and
        // app-scoped rooms (melotune-<id>, melomove-<id>, etc). Anything
        // that looks like generic infra (_services._dns-sd, _tcp, _udp,
        // printer protocols, etc.) is ignored.
        if (/^_(sym|[a-z]+-[a-z0-9]+|[a-z]+-team|.*-team)\._tcp$/i.test(full)) {
          seen.add(full);
        }
      }
      if (seen.size === 0) {
        return resolve({
          text:
            `No SYM-mesh rooms visible on the local network right now.\n\n` +
            `This only shows rooms with at least one node currently online. ` +
            `Rooms you or teammates have used before are not persisted anywhere ` +
            `(p2p architecture — no central directory).\n\n` +
            `Your node is on: ${SERVICE_TYPE} (room "${ROOM}").`,
        });
      }
      const lines = [];
      lines.push(`SYM-mesh rooms visible on LAN (${seen.size}):`);
      for (const st of Array.from(seen).sort()) {
        const name = st.replace(/^_/, '').replace(/\._tcp$/, '');
        const isSelf = st === SERVICE_TYPE ? '  (← your current room)' : '';
        lines.push(`  ${st}   room="${name}"${isSelf}`);
      }
      lines.push('');
      lines.push(`To join one, call sym_join_room with room="<name>".`);
      resolve({ text: lines.join('\n') });
    });
  });
}

// ── Engineering-domain field weights (SVAF α_f) ──────────────

const FIELD_WEIGHTS = {
  focus: 2.0,       // code, architecture, technical decisions
  issue: 2.0,       // bugs, blockers, technical debt
  intent: 1.5,      // what needs building
  motivation: 1.0,  // why it matters
  commitment: 1.5,  // deadlines, dependencies
  perspective: 0.5,  // viewpoint — low for engineering
  mood: 0.8,        // user fatigue affects code quality
};

// ── SymNode — full peer on the mesh ──────────────────────────

// Default: hostname-based identity, unique per machine. The old default
// ('claude-code-mac') caused ghost-peer bugs when another machine ran
// without SYM_NODE_NAME set — both machines claimed the same name with
// different nodeIds, creating phantom peers that absorbed messages.
// Per-session default (v0.3.8): keep co-resident Claude Code sessions from all
// claiming one shared identity and colliding on the identity lock. Each Claude
// Code session exposes CLAUDE_CODE_SESSION_ID (stable across `--resume`) and
// CLAUDE_PROJECT_DIR, so the default becomes `claude-<repo>-<session6>` —
// unique even for two sessions in the same repo, readable, and stable across
// resume. Bare-npm use (no session id) keeps the hostname default. Named agents
// override with SYM_NODE_NAME (e.g. claude-code-mac, melotune-dev).
function defaultNodeName() {
  const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const sid = clean(process.env.CLAUDE_CODE_SESSION_ID).slice(0, 6);
  if (sid) {
    const repo = clean(require('path').basename(process.env.CLAUDE_PROJECT_DIR || process.cwd())) || 'session';
    return `claude-${repo}-${sid}`;
  }
  return `claude-${clean(require('os').hostname())}`;
}
// Node-name collision handling is delegated to the engine (see identity.js). The old plugin-side
// resolver checked liveness with a bare `process.kill(pid, 0)`, which can't distinguish a live
// holder from a recycled PID, so a stale lock could force a -2/-3 suffix and a fresh identity.
// Removed; identity resolution now goes through resolveIdentity + the engine's robust check.
// Per-project identity (v0.3.22): a named role agent (CTO, melotune-dev, …) commits
// its node name + room to `$CLAUDE_PROJECT_DIR/.sym/node.json`, so the plugin alone
// carries a stable per-project identity — no parallel MCP registration, and it
// survives a plugin reinstall because the config lives in the repo, not the plugin.
// Env (SYM_NODE_NAME/SYM_ROOM) still wins; this only overrides the auto default.
// Missing/malformed file → {} → auto default; never a hard fail.
function projectNodeConfig() {
  const fs = require('fs'), path = require('path');
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.sym', 'node.json'), 'utf8'));
    const clean = (s) => (typeof s === 'string' && s.trim()) ? s.trim() : undefined;
    return { node_name: clean(cfg.node_name), room: clean(cfg.room) };
  } catch { return {}; }
}
const PROJECT_CFG = projectNodeConfig();
const { name: NODE_NAME, autoSuffix: NODE_AUTOSUFFIX } = resolveIdentity({
  pinnedName: process.env.SYM_NODE_NAME || PROJECT_CFG.node_name,
  defaultName: defaultNodeName(),
});

// ── Mesh room (MMP §5.8) ──────────────────────────────────
//
// LAN isolation by Bonjour service type. `_sym._tcp` is the default
// (backward compatible). A named room `<foo>` maps to service type
// `_foo._tcp`. Passing a full `_foo._tcp` service type explicitly also
// works. Nodes in different rooms never discover each other at mDNS.
// See MeloTune's MoodRoom model for the per-room pattern
// (`_melotune-{id}._tcp`).
function resolveServiceType() {
  const explicit = process.env.SYM_SERVICE_TYPE;
  if (explicit) return explicit;
  const room = process.env.SYM_ROOM || PROJECT_CFG.room;
  if (room && room !== 'default') return `_${room}._tcp`;
  return '_sym._tcp';
}
// Mutable so sym_join_room can hot-swap the node at runtime without a
// Claude Code restart. Declaring as `let` rather than `const` is the
// smallest change that makes hot-swap possible.
let SERVICE_TYPE = resolveServiceType();
let ROOM = process.env.SYM_ROOM || PROJECT_CFG.room || (SERVICE_TYPE !== '_sym._tcp'
  ? SERVICE_TYPE.replace(/^_/, '').replace(/\._tcp$/, '')
  : 'default');
let RELAY_URL = process.env.SYM_RELAY_URL || null;
let RELAY_TOKEN = process.env.SYM_RELAY_TOKEN || null;

let node = new SymNode({
  name: NODE_NAME,
  autoSuffix: NODE_AUTOSUFFIX,   // engine handles collision (start-time-verified); off for pinned names
  cognitiveProfile: 'Engineering node. Code, architecture, debugging, technical decisions.',
  svafFieldWeights: FIELD_WEIGHTS,
  svafFreshnessSeconds: 7200, // 2hr — session-length context
  discoveryServiceType: SERVICE_TYPE,
  room: ROOM,
  relay: RELAY_URL,
  relayToken: RELAY_TOKEN,
  silent: true,
});

// ── Send-path delivery integrity (E8 variant c) ──────────────────────────────
// SymNode.remember() dedups on the content hash of the CAT7 fields, returning null
// when identical fields are already in the LOCAL store — and the send/publish
// handlers reported that null as "Duplicate — not re-broadcast". But a local-store
// hit is NOT proof of delivery: a CMB stored while this node had no connected peer,
// or on a prior send before a reconnect, blocks its own identical re-send forever,
// so an explicit operator send silently never reaches the mesh (root-caused
// 2026-07-18; same fail-loudly family as the 0.3.39 unknown-param fix). We record
// which CMB keys were actually delivered to a connected destination: a dedup
// against a NEVER-DELIVERED key is re-issued (disambiguated with the same salt the
// commission loop uses) so the send goes out, while a dedup against an
// already-delivered key stays suppressed — no flood regression. The delivered set
// is channel-internal, so it uses its own stable content hash, not the store's key.
const crypto = require('crypto');

// ── input hygiene (0.3.39) — silent semantic drops must fail loudly ──────────────
// Root-caused 2026-07-18: minds habitually call sym_publish/sym_send with a single
// `content` param; the schema tolerated it as an unknown property and DROPPED it,
// producing constant all-default fields whose hash collides — every call after the
// first answered "Duplicate" while the mind's actual content never reached the mesh.
// Two rails: `content` maps to `focus` (the semantic repair — the habitual call now
// carries meaning), and any OTHER unknown top-level param is a loud error.
function vetCmbArgs(args, extraKeys) {
  const known = new Set(['focus', 'issue', 'intent', 'motivation', 'commitment', 'perspective', 'mood', 'payload', 'content', ...extraKeys]);
  const unknown = Object.keys(args || {}).filter(k => !known.has(k));
  if (unknown.length) {
    return `Unknown parameter(s): ${unknown.join(', ')}. Allowed: ${[...known].join(', ')}. Nothing was published — fix the call (a dropped param is a dropped meaning).`;
  }
  if (args && args.content && !args.focus) args.focus = String(args.content);
  return null;
}

let deliveredCmbKeys = new Set();   // reset on hot-swap (sym_join_room)

function cmbContentKey(fields) {
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 32);
}
// Directed deliveries are tagged per (contentKey, target) so identical content can
// still be delivered to a different peer; broadcasts are tagged by content key only.
function deliveryTag(fields, targetPeerId) {
  return targetPeerId ? `${cmbContentKey(fields)}|${targetPeerId}` : cmbContentKey(fields);
}
function connectedPeerCount(n) {
  try { const s = n.status && n.status(); return (s && s.peerCount) || (n.peers && n.peers().length) || 0; }
  catch { return 0; }
}
// An explicit operator send (sym_send / sym_publish): remember() the CMB, but treat
// a content-dedup miss as "already delivered" ONLY when we actually delivered this
// key to a connected destination before. A dedup against a never-delivered key
// (stored while disconnected, or before a reconnect) is re-issued with a
// disambiguating salt so the operator's send reaches the mesh. okSummary(entry,
// connected) builds the happy-path text so each caller keeps its verb; `now` is
// injectable for deterministic tests. Returns { text, isError? }.
function explicitSend(n, delivered, fields, sendOpts, okSummary, now) {
  const stamp = now || (() => new Date().toISOString());
  const targetPeerId = sendOpts.to || null;
  // A directed send resolved its target from the connected-peer list already, so its
  // target is connected by construction; a broadcast reaches someone only if a peer
  // is connected to receive the fanned-out frame.
  const connected = targetPeerId ? true : connectedPeerCount(n) > 0;

  const entry = n.remember(fields, sendOpts);
  if (entry) {
    if (connected) delivered.add(deliveryTag(fields, targetPeerId));
    return { text: okSummary(entry, connected) };
  }
  if (delivered.has(deliveryTag(fields, targetPeerId))) {
    return { text: `Duplicate — identical CMB already delivered${targetPeerId ? '' : ' to the room'}, not re-broadcast.` };
  }
  const salted = Object.assign({}, fields, { focus: `${fields.focus} [re-sent ${stamp()}]` });
  const retry = n.remember(salted, sendOpts);
  if (!retry) {
    return { text: 'Send failed: the prior copy was undelivered and the disambiguated re-send did not store (persist error). Nothing broadcast.', isError: true };
  }
  if (connected) delivered.add(deliveryTag(salted, targetPeerId));
  return { text: `Re-sent CMB ${retry.key}${targetPeerId ? '' : ' to the room'} — a prior identical copy was in the local store but had never been delivered; content-addressed dedup would otherwise have silently suppressed this send.` };
}

// Event handlers are extracted into a single registration function so the
// hot-swap path in sym_join_room can re-register them on the new node.
// The function reads module-level `NODE_NAME`, `isPeerAllowed`, `pushChannel`,
// `storeMessage`, and `extractCompactHeader` via closure; those don't change
// across swaps.
function registerNodeHandlers(n) {
  // Identity collision (added in @sym-bot/sym 0.3.68): the relay told us
  // another process is holding our nodeId. Don't try to reconnect — that
  // caused the peer-flap loop documented in v0.1.2/v0.1.3 commit messages.
  // Exit so Claude Code can decide whether to respawn (with the freshness
  // window now elapsed) or surface the failure to the user.
  n.on('identity-collision', (info) => {
    process.stderr.write(
      `sym-mesh-channel: identity collision on relay — another process is holding ` +
      `nodeId=${info.nodeId} name=${info.name}. Exiting.\n`
    );
    process.exit(2);
  });

  n.on('cmb-accepted', (entry) => {
    if (entry.source === NODE_NAME || entry.cmb?.createdBy === NODE_NAME) return;
    const source = entry.source || entry.cmb?.createdBy || 'unknown';
    if (!isPeerAllowed(source)) return;
    const fields = entry.cmb?.categories || {};
    const payload = entry.cmb?.payload;
    const sec = checkSecurity(source, fields, payload);
    if (!sec.safe) { securityAudit(sec.reason, source, sec.excerpt); return; }
    const focus = fields?.focus?.text || entry.content || '';
    const mood = fields?.mood?.text || '';
    const moodSuffix = mood && mood !== 'neutral' ? ` (mood: ${mood})` : '';
    // Store the rendered CMB body so the agent can sym_fetch it by [mNNN] ID.
    // When the CMB carries an opaque payload alongside CAT7 fields, append a
    // PAYLOAD section to the stored body so sym_fetch returns it intact;
    // header gains a [+payload Nb] indicator so the receiver knows there's
    // structured data beyond CAT7 and should sym_fetch to consume it.
    const hasPayload = payload !== undefined && payload !== null;
    let body = entry.content || focus;
    let payloadSuffix = '';
    if (hasPayload) {
      const serialized = (() => {
        try { return JSON.stringify(payload, null, 2); }
        catch { return String(payload); }
      })();
      body = `${body}\n\n---PAYLOAD---\n${serialized}`;
      payloadSuffix = ` [+payload ${serialized.length}b]`;
    }
    // Directed (peer-bound) delivery indicator (MMP §9.2.2). A directed CMB was
    // addressed to THIS node — surface it as sent-to-you so the agent knows to
    // respond. `remixed:false` means SVAF delivered it but did not ingest it
    // into memory (transient request, not stored) — flag it so the agent does
    // not assume it is recallable later.
    const dirTag = entry.directed ? ' →you' : '';
    const memTag = entry.directed && entry.remixed === false ? ' ·not-stored' : '';
    // Classifier-risk guard (2026-07-24): checkSecurity cleared this CMB of injection, but a benign
    // CMB whose wording is offensive-security/policy-adjacent can still wedge OUR model the instant
    // its text is auto-surfaced. Scan what we're about to surface; if flagged, quarantine — auto-push
    // metadata only (quarantineHeader carries no peer free-text), keep the verbatim body stored for a
    // deliberate sym_fetch. Guarantee is in NOT auto-surfacing, not in guessing the classifier.
    const risk = scanClassifierRisk(`${focus}\n${body}`);
    let header;
    if (risk.risky) {
      securityAudit(`classifier-risk:${risk.terms.join(',')}`, source, focus);
      header = quarantineHeader(source, dirTag, risk.terms.length, `${memTag}${payloadSuffix}`);
    } else {
      header = `[${source}${dirTag}] ${focus}${moodSuffix}${memTag}${payloadSuffix}`;
    }
    const msgId = storeMessage(source, body, header);
    pushChannel('cmb', `${header} [${msgId}]`);
  });

  n.on('message', (from, content) => {
    if (!isPeerAllowed(from)) return;
    const sec = checkSecurity(from, { focus: { text: content } }, null);
    if (!sec.safe) { securityAudit(sec.reason, from, sec.excerpt); return; }
    // Same classifier-risk quarantine as cmb-accepted, for legacy direct messages.
    const risk = scanClassifierRisk(content);
    let header;
    if (risk.risky) {
      securityAudit(`classifier-risk:${risk.terms.join(',')}`, from, content.slice(0, 120));
      header = quarantineHeader(from, '', risk.terms.length, '');
    } else {
      header = `[${from}] ${extractCompactHeader(from, content)}`;
    }
    const msgId = storeMessage(from, content, header);
    pushChannel('message', `${header} [${msgId}]`);
  });
}

// ── MCP Server ───────────────────────────────────────────────

// Base instructions shown to the agent at every MCP initialize.
const BASE_INSTRUCTIONS =
  `You are a peer node on the SYM mesh (identity: ${NODE_NAME}). ` +
  'The mesh is publish-subscribe: peers deliver CMBs to you in real-time the instant they publish, as <channel> notifications. That real-time push can be gated by Claude Code policy, so call sym_receive to surface any deliveries the push did not bring into your context (directed sym_send + admitted broadcasts) — a live delivery feed, not a memory query. Call sym_receive at the start of your turn and periodically while coordinating with peers, so no delivery is missed. ' +
  'When you receive a CMB from another node, respond via sym_send targeted at that node by name if the reply is for that specific peer (MMP §4.4.4 targeted CMB). ' +
  'Publish a CMB to your whole room via sym_publish — a projection of your own state (MMP §9.2 receiver-autonomous SVAF evaluation). ' +
  'Both sym_send and sym_publish emit a CAT7 CMB (your projection); each receiver runs SVAF and, if it admits the CMB as an observation, remix-stores it with lineage back to yours. ' +
  'Search mesh memory via sym_recall. ' +
  'sym_receive and <channel> notifications give compact headers with [mNNN] IDs — use sym_fetch to read the full content when relevant to your current task.';

// Final startup step (MMP §4.2 O2 — rejoin-without-replay). The SymNode
// constructor builds the memory-store index from disk, so the primer is
// available synchronously without needing node.start(). Appending it to
// the MCP instructions payload means a fresh Claude Code session wakes
// with prior remix memory — own observations plus peer observations
// admitted by SVAF — already loaded into context, zero first-turn
// sym_recall overhead.
//
// MCP SDK reads `instructions` at Server construction time (storing it in
// a private field) and emits it only on initialize-response; mutations on
// the public property after construction are ignored. Compute once, pass in.
let primerText = '';
try {
  const primer = node.buildStartupPrimer();
  if (primer && primer.count > 0) primerText = `\n\n${primer.text}`;
} catch (err) {
  process.stderr.write(`sym-mesh-channel startup primer skipped: ${err?.message || err}\n`);
}

const mcp = new Server(
  { name: 'sym-mesh', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: BASE_INSTRUCTIONS + primerText,
  },
);

// ── Tools ────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'sym_send',
      description:
        'Send a structured CAT7 CMB to a specific mesh peer (targeted) or to all peers (broadcast, when "to" is omitted). ' +
        'Receivers evaluate the CMB per-field via SVAF (MMP §9.2) and, if admitted, remix-store it with lineage pointing back to this CMB. ' +
        'Use sym_send when the CMB is for a specific peer (e.g. a peer-review gating request directed at the reviewer role); ' +
        'use sym_publish when publishing your own state to the whole room.',
      inputSchema: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'The task anchor / what this CMB is about. Required.' },
          issue: { type: 'string' },
          intent: { type: 'string' },
          motivation: { type: 'string' },
          commitment: { type: 'string' },
          perspective: { type: 'string' },
          mood: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              valence: { type: 'number' },
              arousal: { type: 'number' },
            },
          },
          to: {
            type: 'string',
            description:
              'Target peer: either the peer display name (e.g. "claude-research-win") or the full nodeId. ' +
              'Call sym_peers first if unsure which peers are connected. Omit to broadcast to all peers.',
          },
          payload: {
            description:
              'Optional opaque payload riding alongside CAT7 fields. Use when carrying data beyond ' +
              'CAT7 — e.g. an LLM request/response substrate protocol puts the prompt + request_id ' +
              'in `payload` rather than smuggling JSON through `motivation` (which is reserved for ' +
              'CAT7 semantics). Receivers see the payload via sym_fetch on the channel notification. ' +
              'Any JSON-serializable value.',
          },
        },
        required: ['focus'],
      },
    },
    {
      name: 'sym_publish',
      description:
        'Publish a structured CAT7 CMB — a projection of your own state — to all peers in your room. ' +
        'Each receiver runs SVAF (MMP §9.2) and, if it admits the CMB as an observation, remix-stores it with lineage. ' +
        'Equivalent to sym_send with "to" omitted — kept as a separate tool because publishing your own state is the common case and does not need peer selection.',
      inputSchema: {
        type: 'object',
        properties: {
          focus: { type: 'string' },
          issue: { type: 'string' },
          intent: { type: 'string' },
          motivation: { type: 'string' },
          commitment: { type: 'string' },
          perspective: { type: 'string' },
          mood: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              valence: { type: 'number' },
              arousal: { type: 'number' },
            },
          },
          payload: {
            description:
              'Optional opaque payload riding alongside CAT7 fields. Use when broadcasting data ' +
              'beyond CAT7 (e.g. llm-capability-advertise carrying served_capabilities). ' +
              'Any JSON-serializable value.',
          },
        },
        required: ['focus'],
      },
    },
    {
      name: 'sym_recall',
      description: 'Search mesh memory for relevant CMBs.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query (empty for all)' } },
        required: ['query'],
      },
    },
    {
      name: 'sym_peers',
      description: 'List connected mesh peers.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sym_status',
      description: 'Get mesh node status — relay connection, peer count, memory count.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sym_fetch',
      description: 'Fetch full content of a mesh message by ID. Use when a compact channel notification needs deeper reading.',
      inputSchema: {
        type: 'object',
        properties: { msg_id: { type: 'string', description: 'Message ID (e.g., m007)' } },
        required: ['msg_id'],
      },
    },
    {
      name: 'sym_receive',
      description: 'Surface the CMBs the mesh has delivered to you in real-time — directed sym_send addressed to you, plus admitted broadcasts published to your room. The mesh is publish-subscribe: peers deliver the instant they publish, pushed as <channel> notifications. Because that push can be gated by Claude Code policy, sym_receive surfaces any deliveries it missed so none is lost — a live delivery feed, NOT a store query (use sym_recall to search stored memory). Call it at the start of a turn and periodically while coordinating so no delivery is missed. Returns compact headers with [mNNN] IDs (newest last); use sym_fetch for full content, reply via sym_send.',
      inputSchema: {
        type: 'object',
        properties: {
          peek: { type: 'boolean', description: 'If true, do not advance the read cursor (same items return next call). Default false — draining.' },
          limit: { type: 'number', description: 'Max messages to return (default 50, newest last).' },
        },
      },
    },
    {
      name: 'sym_room_info',
      description: 'Report the mesh room this node is in (MMP §5.8). Shows service type + room name + peer count.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sym_invite_create',
      description: 'Generate a shareable invite URL for a named mesh room. Team leads use this to let teammates join their dev-team mesh. LAN-only invite: pass room only, returns sym://room/{name}. Cross-network invite: pass relay_url + relay_token too, returns sym://team/{name}?relay=...&token=... — teammates on different networks join through the relay.',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Kebab-case room name, e.g. "backend-team".' },
          relay_url: { type: 'string', description: 'Optional WebSocket relay URL, e.g. wss://sym-relay.onrender.com. Include for cross-network teams.' },
          relay_token: { type: 'string', description: 'Optional relay authentication token (shared secret for this team channel).' },
        },
        required: ['room'],
      },
    },
    {
      name: 'sym_invite_info',
      description: 'Parse a mesh invite URL and return everything the invitee needs to join: room name, service type, and any relay credentials. Read-only; does NOT switch the current node (use sym_join_room for that). Works on LAN room invites (sym://room/{name}), cross-network team invites (sym://team/{name}?relay=&token=), and app-specific room invites (e.g. melotune://room/{id}/{name}).',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Invite URL, e.g. sym://room/backend-team' } },
        required: ['url'],
      },
    },
    {
      name: 'sym_join_room',
      description: 'Hot-swap this node into a different mesh room at runtime — no Claude Code restart needed. Stops the current SymNode, reconstructs it with the new room (and optional relay credentials), and restarts it. Teammates on the same room/relay will discover this node via Bonjour (LAN) or the relay (cross-network). To leave a room, pass room="default" which reverts to the global _sym._tcp mesh.',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Kebab-case room name, e.g. "backend-team". Pass "default" to return to the global mesh.' },
          relay_url: { type: 'string', description: 'Optional WebSocket relay URL for cross-network teams. Leave empty for LAN-only.' },
          relay_token: { type: 'string', description: 'Optional relay authentication token.' },
        },
        required: ['room'],
      },
    },
    {
      name: 'sym_rooms_discover',
      description: 'List SYM-mesh rooms currently advertising on the local network. Uses Bonjour / mDNS to find service types matching the SYM protocol. Only shows rooms with at least one node online right now — there is no central directory of offline-but-known rooms. macOS and Windows have Bonjour built in; Linux requires avahi-daemon.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'sym_send': {
      {
        const argErr = vetCmbArgs(args, ['to']);
        if (argErr) return { content: [{ type: 'text', text: argErr }], isError: true };
      }
      // Emit a structured CAT7 CMB per MMP §4.2. When args.to names a peer,
      // route as a targeted send (§4.4.4); otherwise broadcast. Receivers
      // run SVAF (§9.2) and remix-store on accept — no separate "message"
      // frame path, no raw-text channel.
      const fields = {
        focus: args.focus || 'directive',
        issue: args.issue || 'none',
        intent: args.intent || 'directive',
        motivation: args.motivation || '',
        commitment: args.commitment || '',
        perspective: args.perspective || NODE_NAME,
        mood: args.mood || { text: 'neutral', valence: 0, arousal: 0 },
      };

      let targetPeerId = null;
      if (args.to) {
        const peers = node.peers();
        // Exact full-nodeId match first (unambiguous).
        const byNodeId = peers.filter(p => p.peerId === args.to);
        // Name match second.
        const byName = peers.filter(p => p.name === args.to);
        // Short-id prefix match last (for human-typed 8-char prefixes).
        const byPrefix = peers.filter(p => p.id === args.to);

        let matches;
        if (byNodeId.length > 0) matches = byNodeId;
        else if (byName.length > 0) matches = byName;
        else if (byPrefix.length > 0) matches = byPrefix;
        else matches = [];

        if (matches.length === 0) {
          return {
            content: [{ type: 'text', text: `Peer "${args.to}" not connected. Call sym_peers to see connected peers.` }],
            isError: true,
          };
        }
        if (matches.length > 1) {
          const names = matches.map(p => `${p.name} (${p.peerId})`).join(', ');
          return {
            content: [{ type: 'text', text: `Peer "${args.to}" is ambiguous — matches: ${names}. Pass the full nodeId.` }],
            isError: true,
          };
        }
        targetPeerId = matches[0].peerId;
      }

      const sendOpts = {};
      if (targetPeerId) sendOpts.to = targetPeerId;
      if (args.payload !== undefined && args.payload !== null) sendOpts.payload = args.payload;
      const r = explicitSend(node, deliveredCmbKeys, fields, sendOpts, (entry, connected) =>
        targetPeerId
          ? `Sent CMB ${entry.key} to ${args.to}`
          : (connected
              ? `Broadcast CMB ${entry.key} to all peers`
              : `Stored CMB ${entry.key} locally, but NO peers are connected — it was not delivered (not silently dropped; re-sendable once a peer connects).`));
      return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
    }

    case 'sym_publish': {
      {
        const argErr = vetCmbArgs(args, []);
        if (argErr) return { content: [{ type: 'text', text: argErr }], isError: true };
      }
      const fields = {
        focus: args.focus || 'observation',
        issue: args.issue || 'none',
        intent: args.intent || 'observation',
        motivation: args.motivation || '',
        commitment: args.commitment || '',
        perspective: args.perspective || NODE_NAME,
        mood: args.mood || { text: 'neutral', valence: 0, arousal: 0 },
      };
      const observeOpts = {};
      if (args.payload !== undefined && args.payload !== null) observeOpts.payload = args.payload;
      const r = explicitSend(node, deliveredCmbKeys, fields, observeOpts, (entry, connected) =>
        connected
          ? `Published: ${entry.key}`
          : `Published locally: ${entry.key} — but NO peers are connected, so no one received it (not silently dropped).`);
      return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
    }

    case 'sym_recall': {
      const results = node.recall(args.query || '');
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }
      const lines = results.slice(0, 10).map(r => {
        const focus = r.cmb?.categories?.focus?.text || r.content || '';
        const source = r.source || r.cmb?.createdBy || 'unknown';
        const time = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
        const cut = focus.length > 150 ? '\u2026 [truncated \u2014 sym_fetch for full]' : '';
        return `[${source}] ${time}\n  ${focus.slice(0, 150)}${cut}`;
      });
      const more = results.length > 10
        ? `\n\n(+${results.length - 10} more matched — narrow the query to see them)`
        : '';
      return { content: [{ type: 'text', text: lines.join('\n\n') + more }] };
    }

    case 'sym_peers': {
      const peers = node.peers();
      if (peers.length === 0) {
        return { content: [{ type: 'text', text: 'No peers connected.' }] };
      }
      const lines = peers.map(p => `${p.name} via ${p.source || 'unknown'}`);
      return { content: [{ type: 'text', text: `${peers.length} peer(s):\n${lines.join('\n')}` }] };
    }

    case 'sym_fetch': {
      // A MALFORMED CALL AND A MISSING MESSAGE ARE DIFFERENT FACTS. Without this guard an
      // absent msg_id (a caller sending some other parameter name) fell through to a store
      // lookup on `undefined` and answered "Message undefined not found (expired or invalid
      // ID)" — which names a cause that did not happen, sends the caller hunting for an
      // expired message, and hides the one thing they could actually fix. Cost three
      // round-trips of misdiagnosis on 2026-08-06, including a peer concluding the tool was
      // broken mesh-wide when their call simply used the wrong key.
      const rawId = typeof args.msg_id === 'string' ? args.msg_id.trim() : '';
      if (!rawId) {
        const got = Object.keys(args || {});
        return { content: [{ type: 'text', text:
          `sym_fetch was called without msg_id, so no lookup was attempted — this is a malformed call, not a missing message. ` +
          `msg_id is required and takes an ID from a channel notification or sym_receive, e.g. "m007" or "in0003". ` +
          (got.length ? `Received instead: ${got.join(', ')}.` : `No parameters were received.`) }] };
      }
      // inNNNN → SDK delivery inbox (pull path); mNNN → channel-push store.
      if (rawId.startsWith('in')) {
        const m = node.inboxGet(rawId);
        if (!m) return { content: [{ type: 'text', text: `Message ${rawId} not found (expired or invalid ID).` }] };
        // Append the opaque payload (now preserved on the inbox message) so the
        // pull path returns structured data intact, exactly like the channel-push
        // store does — otherwise sym_fetch on a directed CMB silently loses it.
        let body = m.content || '';
        if (m.payload !== undefined && m.payload !== null) {
          let serialized;
          try { serialized = JSON.stringify(m.payload, null, 2); } catch { serialized = String(m.payload); }
          body = `${body}\n\n---PAYLOAD---\n${serialized}`;
        }
        return { content: [{ type: 'text', text: `[${m.from}] ${new Date(m.receivedAt).toISOString()}\n\n${body}` }] };
      }
      const entry = MESSAGE_STORE.get(rawId);
      if (!entry) {
        return { content: [{ type: 'text', text: `Message ${rawId} not found (expired or invalid ID).` }] };
      }
      return {
        content: [{
          type: 'text',
          text: `[${entry.from}] ${new Date(entry.timestamp).toISOString()}\n\n${entry.content}`,
        }],
      };
    }

    case 'sym_receive': {
      // Thin adapter over the SDK primitive: the node owns the delivery buffer
      // + drain cursor (node.inbox()). This wrapper only formats for display.
      const { messages, remaining } = node.inbox({ peek: !!args.peek, limit: args.limit });
      if (!messages.length) {
        return { content: [{ type: 'text', text: 'Caught up — nothing new delivered since your last sym_receive.' }] };
      }
      const now = Date.now();
      const lines = messages.map((m) => {
        if (m.from === NODE_NAME) return null; // never surface our own deliveries
        // The security layer still gates the pull path: peer allowlist +
        // prompt-injection filter run on every message before it enters context.
        if (!isPeerAllowed(m.from)) return null;
        // payload lives at m.payload (sibling of fields), not m.categories.payload.
        const sec = checkSecurity(m.from, m.categories || {}, m.payload);
        if (!sec.safe) { securityAudit(sec.reason, m.from, sec.excerpt); return null; }
        const age = Math.round((now - m.receivedAt) / 1000);
        const focus = m.categories?.focus?.text || m.content || '';
        const dirTag = m.directed ? ' →you' : '';
        const memTag = m.directed && m.remixed === false ? ' ·not-stored' : '';
        // Flag structured data so the agent knows to sym_fetch the full body.
        const payTag = (m.payload !== undefined && m.payload !== null) ? ' [+payload]' : '';
        const flat = String(focus).replace(/\s+/g, ' ');
        const cutTag = flat.length > 90 ? '\u2026' : '';
        return `[${m.from}${dirTag}] ${flat.slice(0, 90)}${cutTag}${memTag}${payTag} [${m.id}] (${age}s ago)`;
      }).filter(Boolean);
      if (!lines.length) {
        return { content: [{ type: 'text', text: 'Caught up — nothing new delivered since your last sym_receive.' }] };
      }
      const moreNote = remaining > 0 ? ` (+${remaining} more — call sym_receive again)` : '';
      return {
        content: [{
          type: 'text',
          text: `${lines.length} new mesh message(s)${args.peek ? ' (peek — not drained)' : ''}${moreNote}:\n${lines.join('\n')}\n\nUse sym_fetch <id> for full content; reply via sym_send to=<peer>.`,
        }],
      };
    }

    case 'sym_status': {
      const s = node.status();
      return {
        content: [{
          type: 'text',
          text: `Node: ${NODE_NAME} (${node.nodeId?.slice(0, 8) || '?'})\n` +
            `Room: ${ROOM} (${SERVICE_TYPE})\n` +
            `Relay: ${s.relayConnected ? 'connected' : 'disconnected'}\n` +
            `Peers: ${s.peerCount || 0}\n` +
            `Memories: ${s.memoryCount || 0}`,
        }],
      };
    }

    case 'sym_room_info': {
      const s = node.status();
      // Read the connected-peer list from status() — `node.getPeers` is not a
      // public method, so the old call always fell through to `[]` and printed
      // "(no peers in this room)" even when peers were connected, while the
      // count below (s.peerCount) showed the real number. That count/list
      // disagreement looked like a membership-handshake failure but was purely
      // this rendering bug. `status().peers` is the same source as peerCount.
      const peers = Array.isArray(s.peers) ? s.peers : [];
      const peerLines = peers.length
        ? peers.map(p => `  ${p.name} (${(p.peerId || '').slice(0, 8)}) via ${p.source || '?'}`).join('\n')
        : '  (no peers in this room)';
      return {
        content: [{
          type: 'text',
          text: `Mesh room (MMP §5.8):\n` +
            `  room: ${ROOM}\n` +
            `  service type: ${SERVICE_TYPE}\n` +
            `  node: ${NODE_NAME} (${node.nodeId?.slice(0, 8) || '?'})\n` +
            `  peers in room: ${s.peerCount || 0}\n` +
            peerLines + `\n\n` +
            `To join a different room, restart the sym-mesh-channel MCP server with env var SYM_ROOM=<name> or SYM_SERVICE_TYPE=<_foo._tcp>.`,
        }],
      };
    }

    case 'sym_invite_create': {
      const room = args?.room;
      const relayUrl = args?.relay_url;
      const relayToken = args?.relay_token;
      if (!room || typeof room !== 'string') {
        return { content: [{ type: 'text', text: 'Missing required argument: room' }], isError: true };
      }
      if (!KEBAB_CASE_RE.test(room)) {
        return {
          content: [{
            type: 'text',
            text: `Invalid room name: "${room}". Must be kebab-case (lowercase alphanumerics + single hyphens), e.g. "backend-team".`,
          }],
          isError: true,
        };
      }
      // LAN-only flavor: sym://room/{name}
      // Cross-network flavor: sym://team/{name}?relay=...&token=...
      let url;
      let flavor;
      if (relayUrl || relayToken) {
        if (!relayUrl) return { content: [{ type: 'text', text: 'relay_token requires relay_url' }], isError: true };
        const params = [`relay=${encodeURIComponent(relayUrl)}`];
        if (relayToken) params.push(`token=${encodeURIComponent(relayToken)}`);
        url = `sym://team/${room}?${params.join('&')}`;
        flavor = 'cross-network (relay)';
      } else {
        url = `sym://room/${room}`;
        flavor = 'LAN-only (Bonjour)';
      }
      const youRunning = ROOM === room
        ? `You're already on this room — teammates who join will see you.`
        : `You are currently on room "${ROOM}". To be reachable, call sym_join_room with room="${room}" (+ same relay creds if cross-network) before sharing.`;
      return {
        content: [{
          type: 'text',
          text: `Invite URL (${flavor}):\n\n    ${url}\n\n` +
            `Share this URL with teammates. Each pastes it into Claude Code and calls sym_join_room (or sym_invite_info for a dry run first).\n\n` +
            youRunning,
        }],
      };
    }

    case 'sym_invite_info': {
      const url = args?.url;
      if (!url || typeof url !== 'string') {
        return { content: [{ type: 'text', text: 'Missing required argument: url' }], isError: true };
      }
      const parsed = parseInviteURL(url);
      if (parsed.error) {
        return { content: [{ type: 'text', text: parsed.error }], isError: true };
      }
      const { appScheme, room, serviceType, roomId, roomName, relayUrl, relayToken } = parsed;

      const out = {
        app: appScheme,
        room,
        service_type: serviceType,
        room_id: appScheme === 'sym' ? undefined : roomId,
        room_name: appScheme === 'sym' ? undefined : roomName,
        relay_url: relayUrl || undefined,
        relay_token: relayToken || undefined,
      };
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];

      const joinCall = {
        room,
        ...(relayUrl && { relay_url: relayUrl }),
        ...(relayToken && { relay_token: relayToken }),
      };

      return {
        content: [{
          type: 'text',
          text: `Parsed invite: ${url}\n\n` +
            JSON.stringify(out, null, 2) + `\n\n` +
            `To join, call sym_join_room:\n\n    ${JSON.stringify(joinCall)}\n\n` +
            `This hot-swaps your node into the ${relayUrl ? 'relay channel' : 'LAN room'} — no Claude Code restart needed.`,
        }],
      };
    }

    case 'sym_join_room': {
      const room = args?.room;
      const relayUrl = args?.relay_url || null;
      const relayToken = args?.relay_token || null;
      if (!room || typeof room !== 'string') {
        return { content: [{ type: 'text', text: 'Missing required argument: room' }], isError: true };
      }
      if (!KEBAB_CASE_RE.test(room) && room !== 'default') {
        return {
          content: [{ type: 'text', text: `Invalid room name: "${room}". Must be kebab-case or "default".` }],
          isError: true,
        };
      }

      const newServiceType = room === 'default' ? '_sym._tcp' : `_${room}._tcp`;
      const prevRoom = ROOM;
      const prevServiceType = SERVICE_TYPE;

      // Stop the current node cleanly so peers see us leave, then construct
      // a fresh one on the new service type. Any failure during restart is
      // reported; the previous node will already be stopped, so the caller
      // is in a known-disconnected state and can retry.
      try {
        await node.stop();
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Failed to stop current node: ${e?.message || e}` }],
          isError: true,
        };
      }

      const newNode = new SymNode({
        name: NODE_NAME,
        autoSuffix: NODE_AUTOSUFFIX,   // same stable identity across a room hot-swap
        cognitiveProfile: 'Engineering node. Code, architecture, debugging, technical decisions.',
        svafFieldWeights: FIELD_WEIGHTS,
        svafFreshnessSeconds: 7200,
        discoveryServiceType: newServiceType,
        room,
        relay: relayUrl,
        relayToken,
        silent: true,
      });
      registerNodeHandlers(newNode);

      try {
        await newNode.start();
      } catch (e) {
        return {
          content: [{
            type: 'text',
            text: `Failed to start new node on room "${room}": ${e?.message || e}\n\n` +
              `Previous node already stopped. To recover, call sym_join_room with room="${prevRoom}".`,
          }],
          isError: true,
        };
      }

      // Swap module-level references only after successful start.
      node = newNode;
      // A reconnect voids prior delivery credits: peers must re-establish, and a CMB
      // delivered to the old room's peers may never reach the new room — so a
      // dedup after the swap must be re-issued, not suppressed (E8 variant c).
      deliveredCmbKeys = new Set();
      ROOM = room;
      SERVICE_TYPE = newServiceType;
      RELAY_URL = relayUrl;
      RELAY_TOKEN = relayToken;

      publishRoomBeacon();   // re-advertise the new room on _symrooms._tcp

      return {
        content: [{
          type: 'text',
          text: `Hot-swapped from room "${prevRoom}" (${prevServiceType}) to "${room}" (${newServiceType}).\n` +
            (relayUrl ? `Relay: ${relayUrl}\n` : '') +
            `Discovering peers on the new service type. Call sym_peers in a moment to see who's online.`,
        }],
      };
    }

    case 'sym_rooms_discover': {
      const result = await discoverRooms();
      return {
        content: [{
          type: 'text',
          text: result.text,
        }],
        isError: result.isError || false,
      };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
});

// ── Compact Channel — message store for lazy-load (v0.1) ────
// Per COO spec cmb_compact_channel_v0.1.md: push compact headers,
// store full content for on-demand sym_fetch retrieval. ~10% token
// savings on mesh traffic without context loss.
const MESSAGE_STORE = new Map(); // channel-push surface (mNNN) for sym_fetch when channels are enabled
let msgSeq = 0;
const MAX_STORED = 200;

function storeMessage(from, content, header) {
  const msgId = `m${String(++msgSeq).padStart(3, '0')}`;
  MESSAGE_STORE.set(msgId, { from, content, header: header || null, timestamp: Date.now() });
  while (MESSAGE_STORE.size > MAX_STORED) {
    const oldest = MESSAGE_STORE.keys().next().value;
    MESSAGE_STORE.delete(oldest);
  }
  return msgId;
}

function extractCompactHeader(from, content) {
  const lines = content.split('\n').filter(l => l.trim());
  const focusMatch = content.match(/focus[=:]\s*([^\n\]]{0,80})/i);
  const bracketMatch = content.match(/\[([^\]]{0,120})\]/);

  const hasHalt = /\bhalt\b/i.test(content);
  const hasDirective = /\bdirective\b/i.test(content);
  const hasResults = /\bresult|complete|landed|done\b/i.test(content);
  const hasAck = /\back\b/i.test(content);

  let signal = '';
  if (hasHalt) signal = 'HALT';
  else if (hasDirective) signal = 'DIRECTIVE';
  else if (hasResults) signal = 'RESULT';
  else if (hasAck) signal = 'ACK';

  const parts = [];
  if (signal) parts.push(signal);
  if (focusMatch) parts.push(`focus=${focusMatch[1].trim()}`);
  else if (bracketMatch) parts.push(bracketMatch[1].trim());
  else if (lines[0]) parts.push(lines[0].slice(0, 100) + (lines[0].length > 100 ? '\u2026' : ''));

  const approxTokens = Math.round(content.length / 4);
  return parts.join(' | ') + ` (~${approxTokens}tok)`;
}

// ── Peer Allowlist (optional, defense-in-depth) ─────────────
// SYM_ALLOWED_PEERS is a comma-separated list of peer node names.
// When set, only CMBs and messages from listed peers are pushed to
// Claude's context. When empty/unset, all authenticated peers are
// accepted (SVAF still gates on content relevance).
const ALLOWED_PEERS = (process.env.SYM_ALLOWED_PEERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isPeerAllowed(peerName) {
  if (ALLOWED_PEERS.length === 0) return true; // no allowlist = accept all
  return ALLOWED_PEERS.includes(peerName);
}

// ── Security: Prompt-Injection Filter (v0.3.11) ──────────────
// SVAF gates on semantic relevance; this layer gates on safety.
// It runs on every CAT7 field and payload before pushChannel —
// the last line of defence before content enters Claude's context.
//
// Attack model: a peer with a valid Ed25519 identity sends a CMB
// whose fields look topically relevant (passes SVAF) but whose
// content contains instruction-override patterns designed to hijack
// the receiving Claude session ("ignore previous instructions",
// role-play overrides, tool-call fabrication, etc.).
//
// Strategy: pattern-match on the serialized content of all CAT7
// fields and the opaque payload. On match: block + audit-log to
// stderr. Never silently drop — the operator must be able to see
// what was rejected and why.

const INJECTION_PATTERNS = [
  // Classic instruction overrides
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?|guidelines?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?)/i,
  /forget\s+(everything|all)\s+(you('ve)?\s+)?(know|been\s+told|learned)/i,

  // Role / persona hijacking
  /you\s+are\s+now\s+(a\s+|an\s+)?(new\s+)?(ai|assistant|model|system|gpt|claude|llm)/i,
  /act\s+as\s+(a\s+|an\s+)?(different|new|unrestricted|jailbroken|evil|rogue)/i,
  /pretend\s+(you\s+)?(are|have\s+no)\s+(restrictions?|rules?|guidelines?|ethics?)/i,
  /new\s+(persona|personality|mode|role)\s*:/i,

  // System prompt injection
  /<\s*system\s*>/i,
  /\[SYSTEM\]/,
  /##\s*system\s+prompt/i,
  /---\s*system\s*---/i,

  // Tool / function call fabrication
  /<\s*tool_call\s*>/i,
  /<\s*function_calls?\s*>/i,
  /\{"type"\s*:\s*"tool_use"/,

  // Privilege / capability escalation
  /you\s+(now\s+)?(have|possess)\s+(full|unrestricted|admin|root|elevated)\s+(access|permissions?|capabilities?)/i,
  /override\s+(safety|content|ethical?|policy)\s+(filter|check|guard|restriction)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

const PAYLOAD_SIZE_LIMIT = parseInt(process.env.SYM_MAX_PAYLOAD_BYTES || '8192', 10);

// Per-peer rate limiter: sliding window, default 30 CMBs/min.
const RATE_LIMIT = parseInt(process.env.SYM_RATE_LIMIT || '30', 10);
const RATE_WINDOW_MS = 60_000;
const peerWindows = new Map(); // peerName → timestamp[]

function isRateLimited(peer) {
  const now = Date.now();
  const window = (peerWindows.get(peer) || []).filter(t => now - t < RATE_WINDOW_MS);
  window.push(now);
  peerWindows.set(peer, window);
  return window.length > RATE_LIMIT;
}

function securityAudit(reason, peer, excerpt) {
  const safe = String(excerpt).replace(/[\r\n]+/g, ' ').slice(0, 120);
  process.stderr.write(`[sym-security] BLOCKED reason=${reason} peer=${peer} excerpt="${safe}"\n`);
}

// Returns { safe: true } or { safe: false, reason, excerpt }.
function checkSecurity(peer, fields, payload) {
  // 1. Rate limit
  if (isRateLimited(peer)) {
    return { safe: false, reason: 'rate-limit', excerpt: `>${RATE_LIMIT} CMBs/min` };
  }

  // 2. Payload size cap
  if (payload !== undefined && payload !== null) {
    const size = JSON.stringify(payload).length;
    if (size > PAYLOAD_SIZE_LIMIT) {
      return { safe: false, reason: 'payload-too-large', excerpt: `${size}b > ${PAYLOAD_SIZE_LIMIT}b limit` };
    }
  }

  // 3. Prompt injection scan across all text surfaces
  const surfaces = [
    ...Object.values(fields || {}).map(v =>
      typeof v === 'string' ? v : (typeof v === 'object' && v?.text ? v.text : '')
    ),
    payload !== undefined && payload !== null
      ? (typeof payload === 'string' ? payload : JSON.stringify(payload))
      : '',
  ].filter(Boolean);

  for (const surface of surfaces) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(surface)) {
        return { safe: false, reason: 'injection-pattern', excerpt: surface.slice(0, 200) };
      }
    }
  }

  return { safe: true };
}

// ── Mesh Events → Channel Notifications ──────────────────────

function pushChannel(eventType, data) {
  try {
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: typeof data === 'string' ? data : JSON.stringify(data),
        meta: { event_type: eventType, source: 'sym-mesh' },
      },
    });
  } catch {}
}

// All node.on(...) handlers live in registerNodeHandlers(n) above so the
// hot-swap path in sym_join_room can attach them to a freshly-constructed
// SymNode without duplicating logic. This call wires up the initial node.
registerNodeHandlers(node);

// Peer presence events are intentionally NOT pushed to Claude's context.
// They're high-frequency, low-signal (peers flap on relay reconnects, daemon
// restarts, NAT keepalive blips), and a flood will eat the context window.
// Use sym_peers / sym_status on demand instead. Only CMBs and direct messages
// are surfaced as channel notifications — those carry actual cognitive payload.

// ── Start ────────────────────────────────────────────────────

// Clean shutdown — disconnect from the relay before exiting so other peers
// see us leave immediately, and so a fast restart of this MCP doesn't race
// our own zombie connection on the relay (which would trigger the relay's
// duplicate-nodeId replacement path and cause peer flap loops).
//
// Idempotent: Claude Code may send SIGTERM and then SIGKILL; we want the
// first signal to get us cleanly off the relay even if the second one
// arrives before stop() resolves.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopRoomBeacon();
  try {
    await node.stop();
  } catch {
    // Best effort — we're exiting anyway. Don't block on cleanup errors.
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));

// ── Room discovery beacon (MMP §5.8) ──────────────────────────
// Mirror the sym CLI daemon: advertise this node's room on the shared
// `_symrooms._tcp` service (room name in TXT) via the pure-JS bonjour-service,
// so `sym rooms` lists this Claude/MCP node cross-platform alongside
// CLI-daemon nodes. Discovery-only — comms stay on the room's own
// `_<room>._tcp`. Re-published on room hot-swap; torn down on shutdown.
let roomBeacon = null;
function publishRoomBeacon() {
  try {
    const { Bonjour } = require('bonjour-service');

    if (roomBeacon) { try { roomBeacon.unpublishAll(); roomBeacon.destroy(); } catch {} roomBeacon = null; }
    roomBeacon = new Bonjour();
    roomBeacon.publish({ name: NODE_NAME, type: "symrooms", port: (node && node._port) || 7777, txt: { room: ROOM, node: NODE_NAME } });
  } catch (e) {
    process.stderr.write(`room beacon unavailable: ${e?.message || e}\n`);
  }
}
function stopRoomBeacon() {
  if (!roomBeacon) return;
  try { roomBeacon.unpublishAll(() => { try { roomBeacon.destroy(); } catch {} }); } catch {}
  roomBeacon = null;
}

async function main() {
  // Start SymNode — connects to relay as a peer. The startup primer is
  // computed at module-load time (see BASE_INSTRUCTIONS above) and is
  // already embedded in the MCP server's initialize-response payload.
  await node.start();

  publishRoomBeacon();

  // Start MCP server — communicates with Claude Code via stdio
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  if (err && err.code === 'EIDENTITYLOCK') {
    // A pinned identity is a singleton: some live process already holds this node's identity.
    // We intentionally do NOT fork a -2/-3 identity (that would start a separate empty store).
    // Surface the conflict instead. A stale lock from a dead holder is not this — the engine
    // reclaims those (start-time-verified), so reaching here means a genuinely live holder.
    process.stderr.write(
      `sym-mesh-channel: node identity '${NODE_NAME}' is already held by a live process ` +
      `(PID ${err.holderPid ?? 'unknown'}). A pinned role is one node — not starting a second ` +
      `copy. Close the other session, or run this one under a distinct SYM_NODE_NAME.\n`
    );
    process.exit(3);
  }
  process.stderr.write(`sym-mesh-channel failed: ${err.message}\n`);
  process.exit(1);
});
