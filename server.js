#!/usr/bin/env node
'use strict';

// Subcommand dispatch: CLI subcommands run the installer/launcher, not the MCP server. (When
// Claude Code spawns the server there is no subcommand, so this falls through.)
if (['init', 'doctor', 'start'].includes(process.argv[2])) {
  require('./bin/install.js');
  return;
}

// ── stdout discipline ───────────────────────────────────────────────────────
// MCP frames JSON-RPC on stdout. Any non-JSON write there — ours or a dependency's load banner —
// corrupts the stream. Lines that look like JSON-RPC pass; everything else goes to stderr.
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
 * sym-mesh-channel 0.11 — the MCP server through which a Claude Code session joins the SYM mesh,
 * on sym 0.14 Core Secure (docs/DESIGN-0.11.0.md).
 *
 * Two modes, never both (design §2.5):
 *   NODE MODE (default)  — this session is the agent, and the agent is its own SymNode (node-host.js).
 *   INTERIOR MODE        — SYM_INTERIOR_SOCKET is set: this session is an existing node's mind, with
 *                          no mesh identity; it submits drafts the node signs (interior-host.js).
 *
 * The channel shows what the node verified, and nothing else (design D2): every delivery names its
 * signer, its audience and its relay, and one with no verification is named by id and reason only.
 *
 * Copyright (c) 2026 SYM.BOT. Apache 2.0 License.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const sdk = require('@sym-bot/sym');
const deliveryPolicy = require('./delivery-policy.js');
const cd = require('./channel-delivery.js');
const { resolveIdentity, nodeNameProblem, isNodeId, shortId } = require('./identity.js');
const { loadRelay, saveRelay, forgetRelay } = require('./relay-store.js');
const { ageDays, MAX_ITEMS: OUTBOX_MAX_ITEMS } = require('./outbox.js');
const { NodeHost } = require('./node-host.js');
const { InteriorHost, readCapability } = require('./interior-host.js');
const push = require('./push-statement.js');

const PKG_VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();

// ── Rooms and invites: the SDK's one grammar (room-names.js) ──
const { isCanonicalRoom, roomRefusalReason, parseInviteURL, keyFingerprint, roomServiceType, serviceTypeToRoom } = require('./room-names.js');

// ── Bonjour discovery of live SYM rooms (observation only) ───
async function discoverRooms() {
  const { spawn } = require('child_process');
  const platform = process.platform;
  const [cmd, argv] = platform === 'darwin' || platform === 'win32'
    ? ['dns-sd', ['-B', '_services._dns-sd._udp', 'local.']]
    : ['avahi-browse', ['-t', '-a', '-p']];
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      return resolve({ isError: true, text: `Could not run discovery command '${cmd}': ${e?.message || e}\n\n` +
        (platform === 'linux' ? 'On Linux, install avahi-utils: sudo apt install avahi-utils' : 'Bonjour should be built-in on macOS and Windows 10+.') });
    }
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.on('error', (e) => resolve({ isError: true, text: `Discovery command failed: ${e?.message || e}` }));
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 2000);
    child.on('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      const typeRe = /_([a-z0-9][a-z0-9-]+)\._tcp/gi;
      const seen = new Set();
      let m;
      while ((m = typeRe.exec(text)) !== null) {
        const full = `_${m[1]}._tcp`;
        if (/^_(sym|[a-z]+-[a-z0-9]+|[a-z]+-team|.*-team)\._tcp$/i.test(full)) seen.add(full);
      }
      if (seen.size === 0) {
        return resolve({ text: 'No SYM-mesh rooms visible on the local network right now.\n\n' +
          'This only shows rooms with at least one node currently online; there is no central directory.\n\n' +
          `Your node is on: ${SERVICE_TYPE} (room "${ROOM}").` });
      }
      const lines = [`SYM-mesh rooms visible on LAN (${seen.size}):`];
      for (const st of Array.from(seen).sort()) {
        const name = st.replace(/^_/, '').replace(/\._tcp$/, '');
        lines.push(`  ${st}   room="${name}"${st === SERVICE_TYPE ? '  (← your current room)' : ''}`);
      }
      lines.push('', 'To join one, call sym_join_room with room="<name>".');
      resolve({ text: lines.join('\n') });
    });
  });
}

// ── Engineering-domain field weights (SVAF α_f) ──────────────
const CATEGORY_WEIGHTS = { focus: 2.0, issue: 2.0, intent: 1.5, motivation: 1.0, commitment: 1.5, perspective: 0.5, mood: 0.8 };

// ── The folder's identity and room ───────────────────────────

// The session default: `claude-<repo>-<session6>` under Claude Code, the hostname otherwise.
function defaultNodeName() {
  const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const sid = clean(process.env.CLAUDE_CODE_SESSION_ID).slice(0, 6);
  if (sid) {
    const repo = clean(path.basename(process.env.CLAUDE_PROJECT_DIR || process.cwd())) || 'session';
    return `claude-${repo}-${sid}`;
  }
  return `claude-${clean(os.hostname())}`;
}

// `<project>/.sym/node.json`: node_name, room and (0.11) node_id. A key this server does not read is
// named, never silently ignored; a malformed file is named on stderr.
function projectNodeConfig() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = path.join(dir, '.sym', 'node.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const clean = (s) => (typeof s === 'string' && s.trim()) ? s.trim() : undefined;
    const known = new Set(['node_name', 'room', 'node_id']);
    const unknown = Object.keys(cfg).filter((k) => !known.has(k));
    let nodeName = clean(cfg.node_name);
    const badNodeName = nodeName && nodeNameProblem(nodeName) ? { value: nodeName, problem: nodeNameProblem(nodeName) } : undefined;
    if (badNodeName) {
      process.stderr.write(`sym-mesh-channel: ${file} node_name ${JSON.stringify(nodeName)} ${badNodeName.problem}; ignoring it.\n`);
      nodeName = undefined;
    }
    const nodeIdRaw = clean(cfg.node_id);
    const badNodeId = nodeIdRaw && !isNodeId(nodeIdRaw) ? nodeIdRaw : undefined;
    return {
      node_name: nodeName, badNodeName,
      node_id: nodeIdRaw && !badNodeId ? nodeIdRaw : undefined, badNodeId,
      room: clean(cfg.room), file, unknownKeys: unknown,
      legacyGroup: clean(cfg.room) ? undefined : clean(cfg.group),
    };
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      process.stderr.write(`sym-mesh-channel: ${file} exists but could not be read (${e.message}). Ignoring it — this node will NOT use the room or name it declares.\n`);
    }
    return { file };
  }
}

const INTERIOR_SOCKET = (process.env.SYM_INTERIOR_SOCKET || '').trim() || null;
const MODE = INTERIOR_SOCKET ? 'interior' : 'node';
const PROJECT_CFG = MODE === 'node' ? projectNodeConfig() : { file: null };
const IDENTITY = resolveIdentity({
  pinnedName: process.env.SYM_NODE_NAME || PROJECT_CFG.node_name,
  pinnedNodeId: process.env.SYM_NODE_ID || PROJECT_CFG.node_id,
  defaultName: defaultNodeName(),
});
const NODE_NAME = IDENTITY.name;

function resolveServiceType() {
  if (process.env.SYM_SERVICE_TYPE) return process.env.SYM_SERVICE_TYPE;
  return roomServiceType(process.env.SYM_ROOM || PROJECT_CFG.room);
}
function resolveRoom(serviceType) {
  if (process.env.SYM_ROOM) return { room: process.env.SYM_ROOM, source: 'SYM_ROOM env' };
  if (PROJECT_CFG.room) return { room: PROJECT_CFG.room, source: PROJECT_CFG.file };
  const fromServiceType = serviceTypeToRoom(serviceType);
  if (fromServiceType !== 'default') return { room: fromServiceType, source: 'SYM_SERVICE_TYPE env' };
  return { room: 'default', source: 'nothing configured — this is the fallback, not a choice' };
}
let SERVICE_TYPE = resolveServiceType();
let { room: ROOM, source: ROOM_SOURCE } = resolveRoom(SERVICE_TYPE);

function resolveRelay(room) {
  if (process.env.SYM_RELAY_URL) return { url: process.env.SYM_RELAY_URL, token: process.env.SYM_RELAY_TOKEN || null, source: 'SYM_RELAY_URL env' };
  const saved = loadRelay(room);
  if (saved) return { url: saved.relay_url, token: saved.relay_token, source: `remembered for room '${room}' (${saved.file})` };
  return { url: null, token: null, source: null };
}
let { url: RELAY_URL, token: RELAY_TOKEN, source: RELAY_SOURCE } = resolveRelay(ROOM);

const HOSTED_RELAY_URL = process.env.SYM_HOSTED_RELAY_URL || 'wss://sym-relay.onrender.com';
const HOSTED_RELAY_MIN_TOKEN = 32;
// SYM_LAN=off: a relay-only node (no Bonjour, no loopback discovery).
const LAN_OFF = /^(off|0|false|no)$/i.test(String(process.env.SYM_LAN || '').trim());

// One constructor for the startup node and every room move (design D10: a nodeId loads without minting).
function buildNode({ serviceType, room, relay, relayToken, nodeId, create }) {
  return new sdk.SymNode({
    name: NODE_NAME,
    ...(nodeId ? { nodeId, create: create === true } : {}),
    cognitiveProfile: 'Engineering node. Code, architecture, debugging, technical decisions.',
    svafFieldWeights: CATEGORY_WEIGHTS,
    svafFreshnessSeconds: 7200,
    discoveryServiceType: serviceType,
    room,
    relay: relay || undefined,
    relayToken: relayToken || undefined,
    relayOnly: LAN_OFF,
    silent: true,
  });
}

/** The words for a node that could not be built, by cause. Null for an error that is not about identity. */
function identityFault(err) {
  if (!err) return null;
  const where = process.env.SYM_NODE_ID ? 'SYM_NODE_ID' : (PROJECT_CFG.node_id ? `node_id in ${PROJECT_CFG.file}` :
    (process.env.SYM_NODE_NAME ? 'SYM_NODE_NAME in this MCP server\'s env' : (PROJECT_CFG.node_name ? `node_name in ${PROJECT_CFG.file}` : 'the default name')));
  if (err.code === 'EIDENTITYLOCK') {
    return `MESH NODE NOT RUNNING: node identity '${NODE_NAME}' (from ${where}) is already held by a live process ` +
      `(PID ${err.holderPid ?? 'unknown'}). One agent is one node, so this server started without one; every mesh tool ` +
      'reports this until it is fixed. If that process is an older copy of this agent, close it. If it is a different agent ' +
      'sharing the name, give this one its own name (node_name in <project>/.sym/node.json, or SYM_NODE_NAME). Then restart this MCP server.';
  }
  if (err.code === 'EIDENTITYABSENT') {
    return `MESH NODE NOT RUNNING: ${where} names an identity that is not on this host, and this server does not mint a ` +
      `replacement (that would be a different agent). ${err.message} Restore it, or remove the pin to start a new agent.`;
  }
  if (err.code === 'EIDENTITYTOMBSTONED') return `MESH NODE NOT RUNNING: ${err.message}`;
  if (err.name === 'IdentityHaltError') return `MESH NODE NOT RUNNING: ${err.message}`;
  return null;
}

// ── The host: this session's node, or a node's interior ──────

let NODE_FAULT = null;
let host = null;
let selfNodeId = null;
const stderrLog = (m) => { try { process.stderr.write(`sym-mesh-channel: ${m}\n`); } catch {} };

if (MODE === 'interior') {
  const cap = readCapability();
  if (cap.error || !cap.capability) {
    NODE_FAULT = `INTERIOR MODE NOT ATTACHED: SYM_INTERIOR_SOCKET is set, but ${cap.error || 'no capability was given (SYM_INTERIOR_CAPABILITY_FILE, or SYM_INTERIOR_CAPABILITY)'}. ` +
      'The node issues a capability when it starts a mind for a mission; without it every submission is refused.';
  } else {
    if (cap.warning) stderrLog(`interior: ${cap.warning}`);
    host = new InteriorHost({
      socketPath: INTERIOR_SOCKET,
      capability: cap.capability,
      defaultKind: (process.env.SYM_INTERIOR_KIND || '').trim() || null,
      kinds: String(process.env.SYM_INTERIOR_KINDS || '').split(',').map((s) => s.trim()).filter(Boolean),
      endOnExit: !/^(0|false|no|off)$/i.test(String(process.env.SYM_INTERIOR_END_ON_EXIT || '').trim()),
      log: stderrLog,
    });
  }
} else {
  if (PROJECT_CFG.badNodeId) stderrLog(`${PROJECT_CFG.file} node_id ${JSON.stringify(PROJECT_CFG.badNodeId)} is not a nodeId (a UUID); ignoring it.`);
  if (process.env.SYM_NODE_ID && !isNodeId(process.env.SYM_NODE_ID)) stderrLog(`SYM_NODE_ID ${JSON.stringify(process.env.SYM_NODE_ID)} is not a nodeId (a UUID); ignoring it.`);
  const nh = new NodeHost({ build: buildNode, nodeDir: (id) => sdk.identity.nodeDirById(id), log: stderrLog });
  try {
    nh.open({ serviceType: SERVICE_TYPE, room: ROOM, relay: RELAY_URL, relayToken: RELAY_TOKEN, nodeId: IDENTITY.nodeId, create: false });
    host = nh;
    selfNodeId = nh.nodeId;
  } catch (err) {
    NODE_FAULT = identityFault(err);
    if (!NODE_FAULT) throw err;
    stderrLog(NODE_FAULT);
  }
}

// ── Delivery policy (delivery-policy.js) ─────────────────────
const ALLOWED = deliveryPolicy.readAllowedPeers(process.env.SYM_ALLOWED_PEERS);
if (ALLOWED.ignored.length) {
  stderrLog(`SYM_ALLOWED_PEERS entries that are not nodeIds are ignored (names are labels since 0.11): ${ALLOWED.ignored.map((s) => JSON.stringify(s)).join(', ')}` +
    (ALLOWED.failClosed ? '. The list holds no nodeId, so it allows nothing until it lists nodeIds.' : ''));
}
const MAX_PAYLOAD = deliveryPolicy.readMaxPayloadBytes(process.env.SYM_MAX_PAYLOAD_BYTES);
if (MAX_PAYLOAD.invalid !== undefined) stderrLog(`SYM_MAX_PAYLOAD_BYTES=${JSON.stringify(MAX_PAYLOAD.invalid)} is not a whole number of bytes; using the default of ${deliveryPolicy.DEFAULT_MAX_PAYLOAD_BYTES}.`);
const policy = deliveryPolicy.createDeliveryPolicy({ allowedPeers: ALLOWED.nodeIds, failClosed: ALLOWED.failClosed, maxPayloadBytes: MAX_PAYLOAD.bytes });
const RATE = deliveryPolicy.readRateLimit(process.env.SYM_RATE_LIMIT);
if (RATE.invalid !== undefined) stderrLog(`SYM_RATE_LIMIT=${JSON.stringify(RATE.invalid)} is not a whole number of pushes per minute; using the default of ${deliveryPolicy.DEFAULT_RATE_LIMIT}.`);
const pushRate = deliveryPolicy.createRateLimiter({ limit: RATE.limit });

function securityAudit(surface, reason, peer, excerpt, id) {
  process.stderr.write(deliveryPolicy.auditLine(surface, reason, peer, excerpt, id));
}

// ── The push statement (design D5) ───────────────────────────
const pushState = push.createPushStatement();
const pushedIds = new Set();      // deliveries whose notification was written
const pushesInFlight = new Set();

// ── Advisories, in band ──────────────────────────────────────
// Some hosts show none of a child's stderr, and a wrong room starts perfectly well, so the warnings
// travel where the agent reads: the instructions, and the tools it calls when the mesh is quiet.
let daemonRoomSaid = null;   // the room pair last said, so the daemon advisory is said once per change
function roomAdvisory({ remember = true } = {}) {
  if (MODE !== 'node') return [];
  const lines = [];
  if (PROJECT_CFG.badNodeName) {
    lines.push(`MESH NODE ADVISORY: ${PROJECT_CFG.file} sets node_name ${JSON.stringify(PROJECT_CFG.badNodeName.value)}, which ` +
      `${PROJECT_CFG.badNodeName.problem}. It was ignored, so this node runs as '${NODE_NAME}'. Fix the name in that file.`);
  }
  if (PROJECT_CFG.badNodeId) {
    lines.push(`MESH NODE ADVISORY: ${PROJECT_CFG.file} sets node_id ${JSON.stringify(PROJECT_CFG.badNodeId)}, which is not a nodeId (a UUID). It was ignored.`);
  }
  if (PROJECT_CFG.legacyGroup) {
    lines.push(`MESH ROOM ADVISORY: ${PROJECT_CFG.file} sets "group": "${PROJECT_CFG.legacyGroup}", the name this project used ` +
      `before the rename to "room". It is not read, so this node fell back to '${ROOM}'. Rename the key to "room".`);
  } else if (PROJECT_CFG.unknownKeys && PROJECT_CFG.unknownKeys.length) {
    lines.push(`MESH ROOM ADVISORY: ${PROJECT_CFG.file} contains ${PROJECT_CFG.unknownKeys.map((k) => `"${k}"`).join(', ')}, which this ` +
      'plugin does not read. Only "node_name", "room" and "node_id" are honoured.');
  }
  if (ROOM === 'default' && !process.env.SYM_ROOM) {
    lines.push('MESH ROOM ADVISORY: this node is in room \'default\', which nothing configured — it is the fallback. Peers in a named ' +
      'room are invisible from here and no error will be raised. Set SYM_ROOM in this MCP server\'s env, or call sym_join_room.');
  }
  if (ALLOWED.ignored.length) {
    lines.push(`MESH PEER ADVISORY: SYM_ALLOWED_PEERS lists ${ALLOWED.ignored.length} entr${ALLOWED.ignored.length === 1 ? 'y' : 'ies'} that ` +
      `${ALLOWED.ignored.length === 1 ? 'is' : 'are'} not a nodeId, ignored: names are labels, not identities.` +
      (ALLOWED.failClosed ? ' It lists no nodeId, so it allows nothing until it does (sym_peers shows nodeIds).' : ''));
  }
  try {
    const daemonRoom = fs.readFileSync(path.join(process.env.SYM_STATE_DIR || path.join(os.homedir(), '.sym'), 'room'), 'utf8').trim();
    const pair = `${daemonRoom}|${ROOM}`;
    if (daemonRoom && daemonRoom !== ROOM && (!remember || daemonRoomSaid !== pair)) {
      if (remember) daemonRoomSaid = pair;
      lines.push(`MESH ROOM ADVISORY: the sym daemon is in room '${daemonRoom}' but this node resolved '${ROOM}' from ${ROOM_SOURCE}. ` +
        `They cannot see each other. Call sym_join_room with room="${daemonRoom}", or fix the config to match.`);
    }
  } catch { /* no daemon room file: the normal single-node case */ }
  return lines;
}

// ONE AGENT, ONE NODE. The plugin's .mcp.json sets SYM_CHANNEL_HOST=plugin, so this server knows which it is.
const IS_PLUGIN_HOST = process.env.SYM_CHANNEL_HOST === 'plugin';
function dualNodeAdvisory() {
  if (MODE !== 'node') return [];
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    if (IS_PLUGIN_HOST) {
      const cj = readJson(path.join(os.homedir(), '.claude.json')) || {};
      const where = [];
      if (cj.mcpServers && cj.mcpServers['claude-sym-mesh']) where.push('~/.claude.json (user scope)');
      if (cj.projects?.[projectDir]?.mcpServers?.['claude-sym-mesh']) where.push(`~/.claude.json (project ${projectDir})`);
      const projEntry = readJson(path.join(projectDir, '.mcp.json'))?.mcpServers?.['claude-sym-mesh'];
      if (projEntry && projEntry.env?.SYM_CHANNEL_HOST !== 'plugin') where.push(`${path.join(projectDir, '.mcp.json')}`);
      if (!where.length) return [];
      return [`MESH NODE ADVISORY: this is the sym-mesh-channel plugin's node, and a 'claude-sym-mesh' MCP server is also configured in ` +
        `${where.join(' and ')}. Claude Code runs both, so this agent is two mesh nodes (MMP §3.2 requires one). Keep one: disable the ` +
        'plugin for this project, or remove the \'claude-sym-mesh\' entry.'];
    }
    let enabled = false;
    for (const f of [path.join(os.homedir(), '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json')]) {
      const ep = readJson(f)?.enabledPlugins;
      if (!ep || typeof ep !== 'object') continue;
      for (const [k, v] of Object.entries(ep)) if (k.startsWith('sym-mesh-channel@')) enabled = v === true;
    }
    if (!enabled) return [];
    return [`MESH NODE ADVISORY: the sym-mesh-channel plugin is enabled for this project, and this '${NODE_NAME}' node is a separate ` +
      '\'claude-sym-mesh\' MCP server. Claude Code runs both, so this agent is two mesh nodes (MMP §3.2 requires one). Keep one: set ' +
      '"enabledPlugins": {"sym-mesh-channel@<marketplace>": false} in .claude/settings.local.json, or remove this server.'];
  } catch { return []; }
}

let startupAdvisory = [];
try { startupAdvisory = [...roomAdvisory({ remember: false }), ...dualNodeAdvisory()]; }
catch (e) { stderrLog(`startup advisory skipped: ${e?.message || e}`); }

// ── The instructions: who this node is and how the tools work. No record text (design D8). ──
function memoryLine() {
  if (MODE !== 'node' || !host) return '';
  const n = host.memoryCount();
  return n > 0 ? ` This node's memory holds ${n} record(s); sym_recall "" lists the newest, as data.` : '';
}

function instructions() {
  if (NODE_FAULT) return `${NODE_FAULT}\n\n`;
  const common =
    'A delivery line opens with who signed it and how it came: [label·last 8 of its nodeId →you] was directed to you, ' +
    '[… →room] was bound to the room and admitted by this node\'s SVAF, and "via label·…" names the session that relayed it. ' +
    'The label is the signer\'s own choice; the nodeId is the identity. A delivery this node cannot verify is listed by id and ' +
    'reason, never shown. Each line ends with its id ([in0042]) and its CMB key. sym_fetch <id> gives the full verification ' +
    'account and the body, in parts when long. ' +
    'Pushes: deliveries are pushed as <channel> notifications when your host shows them. This server cannot see whether it does, ' +
    'so it sends one push check carrying a code; if you received it, call sym_push_confirm with that code. Until then sym_receive ' +
    'lists every delivery, so call it at the start of a turn and while coordinating. ' +
    'Lineage: when you respond to a delivery, cite it — parents: ["<id or key>"] (MMP §14.3). Only the categories you give are sent.';
  if (MODE === 'interior') {
    const who = host && (host.name || host.nodeId) ? `the SYM mesh node ${host.name || ''}${host.nodeId ? ` (${host.nodeId})` : ''}` : 'a SYM mesh node';
    const reads = host && host.supports.deliveries === true;
    return `You are the mind of ${who}, attached to its interior (interior mode). You have no mesh identity of your own: ` +
      'sym_send and sym_publish submit drafts to the node, which checks them against its mission, signs them as itself and sends them. ' +
      `${host && host.kinds().length ? `The mission's submission kinds: ${host.kinds().join(', ')}. ` : 'Name the kind of each submission (kind). '}` +
      (reads ? common : 'This node\'s interior does not serve its deliveries (sym 0.14\'s interior socket takes submit and end only), so you can submit but not read what the node admits; sym_receive says so. ' +
        'Lineage: cite what a submission builds on in parents, as CMB keys of records the node holds (MMP §14.3). Only the categories you give are sent.');
  }
  return `You are a peer node on the SYM mesh: node '${NODE_NAME}', nodeId ${selfNodeId}. Peers' records reach you only after this ` +
    'node has verified them (MMP v2.0 Core Secure). ' + common + ' ' +
    'sym_send {to: "<nodeId or delivery id>", …} speaks to one peer; `to` never takes a name. sym_publish shares your own state with the room. ' +
    'sym_recall searches this node\'s memory.' + memoryLine();
}

// The MCP server is built once the host has started (main): the instructions say who this node is,
// and in interior mode only the node can say that. The SDK reads `instructions` at construction.
let mcp = null;

// ── Tools ────────────────────────────────────────────────────

const CAT7_PROPS = {
  focus: { type: 'string', description: 'What this CMB is about. Required, and not blank.' },
  issue: { type: 'string' },
  intent: { type: 'string' },
  motivation: { type: 'string' },
  commitment: { type: 'string' },
  perspective: { type: 'string' },
  mood: { type: 'object', properties: { text: { type: 'string' }, valence: { type: 'number' }, arousal: { type: 'number' } } },
};
const PARENTS_PROP = {
  type: 'array', items: { type: 'string' },
  description: 'Lineage (MMP §14.3): the CMBs this one responds to or builds on — delivery ids (e.g. "in0042") or CMB keys ("cmb-" and 64 hex). Cite what you answer.',
};
const PAYLOAD_PROP = {
  description: 'Optional structured data beyond CAT7 (any JSON value). It rides inside the signed record as its application section (MMP §8.8.3), so it is signed with the categories. Receivers read it with sym_fetch.',
};
const KIND_PROP = { type: 'string', description: 'The submission kind, one the mission declared (interior mode).' };

function toolList() {
  const interior = MODE === 'interior';
  const extra = interior ? { kind: KIND_PROP } : {};
  const tools = [
    {
      name: 'sym_send',
      description: interior
        ? 'Submit a CAT7 CMB to the node for one recipient (`to`, a nodeId the mission allows) or for the room (no `to`). The node checks it, signs it as itself and sends it.'
        : 'Send a CAT7 CMB to one peer (`to`: its nodeId, or a delivery id meaning that delivery\'s verified signer) or to the room (no `to`). ' +
          'A name is never a route. Receivers run SVAF (MMP §9.2); a directed CMB is surfaced to its recipient whatever SVAF decides (§9.2.2). ' +
          'Cite what you answer in `parents`. A peer with no session now is held in the outbox if this node has had one with it.',
      inputSchema: {
        type: 'object',
        properties: {
          ...CAT7_PROPS,
          to: { type: 'string', description: interior ? 'Recipient nodeId (must be in the mission\'s allowlist). Omit for the room.' : 'Recipient: a nodeId (sym_peers lists them) or a delivery id such as "in0042" (its verified signer). Omit to send to the room.' },
          parents: PARENTS_PROP,
          payload: PAYLOAD_PROP,
          ...extra,
        },
        required: ['focus'],
      },
    },
    {
      name: 'sym_publish',
      description: interior
        ? 'Submit a CAT7 CMB for the node\'s room: a projection of the work this mind is doing. The node checks it, signs it as itself and sends it.'
        : 'Publish a CAT7 CMB — a projection of your own state — to the room. Each receiver runs SVAF (MMP §9.2) and, if it admits it, stores it with lineage. Cite what it builds on in `parents`.',
      inputSchema: { type: 'object', properties: { ...CAT7_PROPS, parents: PARENTS_PROP, payload: PAYLOAD_PROP, ...extra }, required: ['focus'] },
    },
    {
      name: 'sym_receive',
      description: 'The deliveries the mesh has brought you since the last call: directed CMBs and messages addressed to you, admitted room broadcasts, and moods (MMP §9.3). ' +
        'Each line names its verified signer, its audience and its relay, its id and its CMB key. A delivery this node cannot verify, or withholds by its content policy, ' +
        'is listed by id and reason, never counted as nothing. Once you have confirmed pushes reach you (sym_push_confirm), a delivery already pushed is named, not repeated. ' +
        'A live delivery feed, not a memory search (that is sym_recall).',
      inputSchema: { type: 'object', properties: { peek: { type: 'boolean', description: 'Do not advance the read cursor.' }, limit: { type: 'number', description: 'Most deliveries to return (default 50).' } } },
    },
    {
      name: 'sym_fetch',
      description: `A delivery in full, by id: the whole verification account (signer nodeId and key source, audience, relay, assertion, room, whether it was stored) and the body. A body longer than ${deliveryPolicy.FETCH_PAGE_CHARS.toLocaleString('en-US')} characters comes in parts; each part names the offset of the next.`,
      inputSchema: { type: 'object', properties: { msg_id: { type: 'string', description: 'Delivery id, e.g. "in0042" or "m007".' }, offset: { type: 'number', description: 'Character position to read from (default 0).' } }, required: ['msg_id'] },
    },
    {
      name: 'sym_recall',
      description: 'Search this node\'s memory. Shows this node\'s own records and peers\' records that were verified when admitted; others are counted, not shown.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query (empty for the newest).' } }, required: ['query'] },
    },
    {
      name: 'sym_push_confirm',
      description: 'State, first-hand, whether this server\'s <channel> pushes reach you. Pass the code from a push-check notification you actually received ({code}); pass {} to have a new check sent; pass {reaching: false} if pushes do not reach you. ' +
        'This server never guesses: until you confirm, sym_receive lists every delivery, pushed or not.',
      inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'The code in the push-check notification, e.g. "K7QX-29FM".' }, reaching: { type: 'boolean', description: 'false: pushes do not reach this session.' } } },
    },
    {
      name: 'sym_status',
      description: interior
        ? 'Interior status: the node and mission this mind is attached to, the socket, what the node serves, submissions and refusals, and the push statement.'
        : 'Node status: identity (nodeId, key fingerprint), room, relay state with the fix when refused, Core Secure sessions and key conflicts, peers, memory, and the push statement.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  if (interior) return tools;
  tools.push(
    { name: 'sym_peers', description: 'Peers with a proven Core Secure session: each one\'s label, full nodeId, where its key came from, and its sessions. Also what the outbox holds.', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'sym_outbox_discard',
      description: 'Discard CMBs held for a peer that is not coming back: names the peer and reports what was dropped and how long it had been held. Held mail is never evicted on its own.',
      inputSchema: { type: 'object', properties: { peer: { type: 'string', description: 'The nodeId the outbox holds for (sym_peers names it), or for a 0.10 item held under a label, that label.' } }, required: ['peer'] },
    },
    { name: 'sym_room_info', description: 'The mesh room this node is in (MMP §5.8): service type, room name and source, and its peers.', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'sym_invite_create',
      description: 'An invite URL for a room. It names this node and its key as the issuer, so whoever accepts it pins this node\'s key (sym D5). LAN invite: room only. Cross-network: cross_network=true (hosted relay, token minted here), or relay_url / relay_token. The URL is a secret (a team invite carries the relay token) and integrity-sensitive.',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Kebab-case room name.' },
          cross_network: { type: 'boolean' },
          relay_url: { type: 'string' },
          relay_token: { type: 'string' },
        },
        required: ['room'],
      },
    },
    {
      name: 'sym_invite_info',
      description: 'Parse an invite URL: room, service type, relay credentials, and the issuer\'s nodeId and key fingerprint. Read-only; sym_join_room {invite} joins and pins the issuer.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    {
      name: 'sym_join_room',
      description: 'Move this node into another room at runtime (same identity). With `invite`, joins the invite\'s room and relay and pins the issuer\'s key when that nodeId is unbound here (a conflict is reported, never overridden). With a relay, the answer is the relay\'s (admitted / refused with the fix / unreachable), waited for up to 10 s. room="default" returns to the global mesh.',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Kebab-case room name, or "default".' },
          invite: { type: 'string', description: 'An invite URL (sym://room/… or sym://team/…); its room and relay are used.' },
          relay_url: { type: 'string' },
          relay_token: { type: 'string' },
          lan_only: { type: 'boolean', description: 'Join LAN-only and forget any relay credential remembered for this room.' },
        },
      },
    },
    { name: 'sym_rooms_discover', description: 'SYM rooms advertising on the local network now (Bonjour / mDNS). Observation only.', inputSchema: { type: 'object', properties: {} } },
  );
  return tools;
}


// ── The unread footer: one count, only when > 0, on every tool answer. Not a wake, not a push. ──
function unreadNow() {
  if (!host) return 0;
  let n = 0;
  try { n = host.unreadCount(); } catch { return 0; }
  if (pushState.confirmed()) {
    for (const id of pushedIds) { try { if (host.isUndrained(id)) n--; } catch { /* */ } }
  }
  return Math.max(0, n);
}
function withInboxAdvisory(result) {
  const n = unreadNow();
  if (!n || !result || !Array.isArray(result.content)) return result;
  const line = `Mesh inbox: ${n} unread — call sym_receive.`;
  const last = result.content[result.content.length - 1];
  if (last && last.type === 'text') return { ...result, content: [...result.content.slice(0, -1), { ...last, text: `${last.text}\n\n${line}` }] };
  return { ...result, content: [...result.content, { type: 'text', text: line }] };
}

// ONE TOOL CALL AT A TIME, IN ARRIVAL ORDER (design D11). A call that never settles holds the queue
// for at most TOOL_QUEUE_HOLD_MS, so one hung call costs order, not every later call.
const TOOL_QUEUE_HOLD_MS = 60_000;
let toolQueue = Promise.resolve();
function onToolCall(request) {
  const run = toolQueue.then(async () => withInboxAdvisory(await dispatchTool(request)));
  toolQueue = Promise.race([run.catch(() => undefined), new Promise((r) => { const t = setTimeout(r, TOOL_QUEUE_HOLD_MS); t.unref?.(); })]);
  return run;
}

/** Wait (at most 2 s) for pushes still being written, so their credit is settled before a drain. */
async function settlePushes(ms = 2000) {
  if (!pushesInFlight.size) return;
  await Promise.race([Promise.allSettled([...pushesInFlight]), new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); })]);
}

const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function dispatchTool(request) {
  try {
    return await routeTool(request);
  } catch (e) {
    const answer = cd.notSentAnswer(request.params && request.params.name, e);
    if (answer) return answer;
    throw e;
  }
}

// ── input hygiene: a dropped parameter is a dropped meaning ──
function vetCmbArgs(args, extraKeys) {
  const known = new Set(['focus', 'issue', 'intent', 'motivation', 'commitment', 'perspective', 'mood', 'payload', 'content', 'parents', ...extraKeys]);
  const unknown = Object.keys(args || {}).filter((k) => !known.has(k));
  if (unknown.length) {
    const hint = MODE === 'node' && unknown.includes('kind') ? ' (`kind` applies only in interior mode)' : '';
    return `Unknown parameter(s): ${unknown.join(', ')}${hint}. Allowed: ${[...known].join(', ')}. Nothing was sent — fix the call (a dropped parameter is a dropped meaning).`;
  }
  if (args && args.content && !args.focus) args.focus = String(args.content);
  if (args && args.focus !== undefined && (typeof args.focus !== 'string' || !args.focus.trim())) {
    return 'focus is required and must not be blank: it is what the CMB is about. Nothing was sent.';
  }
  return null;
}

function peerTag(nodeId) {
  if (!host || MODE !== 'node') return shortId(nodeId);
  const p = host.peers().find((x) => x.peerId === nodeId);
  const label = p ? p.name : host.outbox.knownLabel(nodeId);
  return label ? deliveryPolicy.whoTag(label, nodeId) : shortId(nodeId);
}

function lineageNote(parents) {
  return parents.length ? ` Lineage: ${parents.length} parent(s) cited (${parents.map((k) => `${k.slice(0, 16)}…`).join(', ')}).` : '';
}

function emitAnswer(out, { to, parents }) {
  const lin = lineageNote(parents);
  switch (out.outcome) {
    case 'sent': {
      const peer = host.peers().find((p) => p.peerId === to);
      return text(`Sent CMB ${out.key} (assertion ${out.assertionId}) to ${peerTag(to)} (${to}); handed to its session — MMP has no delivery receipt.` +
        (out.duplicate ? ' This node\'s memory already held this cognition, so this is a new signed assertion of it.' : '') + lin + cd.staleNote(peer));
    }
    case 'published':
      return text(`Published CMB ${out.key} (assertion ${out.assertionId}) to room '${ROOM}'${out.dispatched !== null ? `; handed to ${out.dispatched} session(s)` : ''}. Each receiver's SVAF decides whether to admit it.${lin}`);
    case 'no-peers':
      return text(`Published locally: CMB ${out.key} is in this node's memory, but no peer has a session with this node, so no one received it.${lin}`);
    case 'already-in-memory':
      return text('Already in memory: this node\'s store holds identical CAT7 cognition (one content address, MMP §8.8.2), so nothing new went out. ' +
        'That is not an error. To say something new, change what you say.');
    case 'already-said':
      return text(`Already said: identical to this node's latest record (${out.key}), so it is cited, not minted again (MMP §7.5). Nothing new went out.`);
    case 'remix-refused':
      return text('Not sent: MMP §15.7 — a remix of a peer\'s record needs new domain data, and this node\'s last emission already remixed one. ' +
        'Publish an observation of your own first (no parents), or send this without parents.', true);
    case 'undelivered': {
      const why = cd.NOT_SENT_SAID[out.reason] || out.reason || 'no session took the frame';
      const base = `NOT DELIVERED — ${why}; CMB ${out.key} is in this node's memory only.`;
      if (out.held) return text(`${base} HELD AT SENDER in this node's outbox (#${out.held.seq}) and re-sent when ${peerTag(to)}'s session returns. The queue is invisible to the recipient; if this node does not come back, it is lost.`);
      return text(`${base} ${out.holdRefused && out.holdRefused.outcome === 'unknown-peer' ? 'It was not held: this node has never had a session with that nodeId.' : `The outbox could not hold it either (${out.holdRefused ? out.holdRefused.reason : 'unknown'}).`}`, true);
    }
    case 'held': {
      const s = host.outbox.summary();
      const forPeer = s.byPeer[to] ? s.byPeer[to].count : 1;
      return text(`HELD AT SENDER — not delivered. ${peerTag(to)} (${to}) has no session with this node now, so the CMB is queued in this node's outbox ` +
        `(#${out.seq}; ${forPeer} waiting for it, ${s.total} in all) and is sent when its session returns. The queue is invisible to the recipient; if this node does not come back, it is lost.`);
    }
    case 'unknown-peer':
      return text(`Not sent: ${to} has no session with this node, and this node has never had one with it, so nothing was queued (an unknown nodeId is refused, so a typo creates no state). sym_peers lists the peers with a session.`, true);
    case 'hold-refused':
      return text(`Not sent and not held: ${peerTag(to)} has no session now, and the outbox could not hold the CMB (${out.reason}). A full outbox refuses rather than evicting.`, true);
    case 'submitted':
      return text(`Submitted as kind '${out.kind}': the node signed and sent CMB ${out.key} (assertion ${out.assertionId}) to its room.${lin}`);
    case 'submitted-directed':
      return text(`Submitted as kind '${out.kind}': the node signed and sent CMB ${out.key} (assertion ${out.assertionId}) to ${to}.${lin}`);
    case 'refused':
      return text(`Not submitted: ${out.text}.`, true);
    default:
      return text(`The node answered ${JSON.stringify(out.outcome)}.`, true);
  }
}

async function emitTool(name, args) {
  const extra = name === 'sym_send' ? ['to'] : [];
  if (MODE === 'interior') extra.push('kind');
  const argErr = vetCmbArgs(args, extra);
  if (argErr) return text(argErr, true);
  const categories = cd.givenCategories(args);
  if (!categories.focus) return text('focus is required and must not be blank: it is what the CMB is about. Nothing was sent.', true);
  const par = cd.resolveParents(args.parents, (id) => host.keyOf(id));
  if (par.error) return text(`Not sent: ${par.error}`, true);
  let to = null;
  if (name === 'sym_send' && args.to !== undefined && args.to !== null && args.to !== '') {
    const r = cd.resolveTo(args.to, {
      signerOf: (id) => host.signerOf(id),
      peersLabelled: (label) => (MODE === 'node' ? host.peers().filter((p) => p.name === label).map((p) => ({ nodeId: p.peerId })) : []),
    });
    if (r.error) return text(`Not sent: ${r.error}`, true);
    to = r.nodeId;
    if (selfNodeId && to === selfNodeId) return text('Not sent: that nodeId is this node itself.', true);
  }
  const out = await host.emitRecord({ categories, to, parents: par.keys, payload: args.payload, kind: args.kind });
  return emitAnswer(out, { to, parents: par.keys });
}

async function routeTool(request) {
  const { name } = request.params;
  const args = request.params.arguments || {};
  if (!host) return text(NODE_FAULT || 'MESH NODE NOT RUNNING.', true);

  if (name === 'sym_push_confirm') return pushConfirmTool(args);
  if (name === 'sym_send' || name === 'sym_publish') return emitTool(name, args);
  if (name === 'sym_receive') return receiveTool(args);
  if (name === 'sym_fetch') return fetchTool(args);
  if (name === 'sym_recall') return recallTool(args);
  if (name === 'sym_status') return statusTool();
  if (MODE === 'interior') {
    if (['sym_peers', 'sym_outbox_discard', 'sym_room_info', 'sym_invite_create', 'sym_invite_info', 'sym_join_room', 'sym_rooms_discover'].includes(name)) {
      return text(`${name} is not available in interior mode: the node owns its room, its peers and its outbox; this mind only submits and reads.`, true);
    }
    return text(`Unknown tool: ${name}`, true);
  }
  switch (name) {
    case 'sym_peers': return peersTool();
    case 'sym_outbox_discard': return outboxDiscardTool(args);
    case 'sym_room_info': return roomInfoTool();
    case 'sym_invite_create': return inviteCreateTool(args);
    case 'sym_invite_info': return inviteInfoTool(args);
    case 'sym_join_room': return joinRoomTool(args);
    case 'sym_rooms_discover': { const r = await discoverRooms(); return text(r.text, r.isError); }
    default: return text(`Unknown tool: ${name}`, true);
  }
}

// ── sym_push_confirm ─────────────────────────────────────────
async function pushConfirmTool(args) {
  const unknown = Object.keys(args).filter((k) => k !== 'code' && k !== 'reaching');
  if (unknown.length) return text(`Unknown parameter(s): ${unknown.join(', ')}. Allowed: code, reaching.`, true);
  if (args.reaching === false) {
    pushState.answer({ reaching: false });
    return text('Recorded: pushes do not reach this session. sym_receive lists every delivery; call it at the start of a turn and while coordinating.');
  }
  if (args.code === undefined || args.code === null || args.code === '') {
    const ok = await sendPushCheck();
    return text(ok
      ? 'A push check was sent just now as a <channel> notification. If it reaches you, call sym_push_confirm with its code. If nothing arrives, pushes do not reach this session: sym_receive lists every delivery.'
      : 'A push check could not be written to the host just now. sym_receive lists every delivery.');
  }
  const r = pushState.answer({ code: args.code });
  if (!r.ok) return text('That is not a code this server sent. The code appears only in a push-check <channel> notification; nothing changed. sym_push_confirm {} sends a new check.', true);
  return text('Confirmed, first-hand: pushes from this server reach you. sym_receive now names a delivery it already pushed instead of repeating it (sym_fetch reads one again), and the unread count leaves those out.');
}

async function sendPushCheck() {
  const code = pushState.issue();
  const label = MODE === 'interior' ? `the interior of ${host && host.name ? host.name : 'its node'}` : `node '${NODE_NAME}'`;
  const ok = await pushChannel('push-check', push.checkText(code, label));
  if (ok) pushState.sent();
  return ok;
}

// ── sym_receive ──────────────────────────────────────────────
async function receiveTool(args) {
  await settlePushes();
  const r = await host.drain({ peek: !!args.peek, limit: typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50 });
  if (r.unsupported) return text(r.unsupported);
  const now = Date.now();
  const shown = [], withheld = [], unverified = [], own = [], alreadyRead = [], alreadyPushed = [];
  const notAllowed = new Map();
  const confirmed = pushState.confirmed();
  for (const d of r.items) {
    if (d.acked) { alreadyRead.push(d.id); continue; }
    if (confirmed && pushedIds.has(d.id)) { alreadyPushed.push(d.id); if (!args.peek) pushedIds.delete(d.id); continue; }
    const line = deliveryPolicy.receiveLine(d, { policy, selfNodeId, now, pushed: pushedIds.has(d.id) });
    if (!args.peek) pushedIds.delete(d.id);
    if (line.audit) securityAudit('receive', line.audit[0], d.facts ? d.facts.signer.nodeId : (d.moodFrom || 'unverified'), line.audit[1], d.id);
    if (line.bucket === 'shown') shown.push(line.line);
    else if (line.bucket === 'withheld') withheld.push(line.line);
    else if (line.bucket === 'unverified') unverified.push(line.line);
    else if (line.bucket === 'not-allowed') notAllowed.set(line.who, (notAllowed.get(line.who) || 0) + 1);
    else own.push(d.id);
  }
  return text(deliveryPolicy.receiveReport({ shown, withheld, unverified, notAllowed, own, alreadyRead, alreadyPushed, remaining: r.remaining, peek: !!args.peek }));
}

// ── sym_fetch ────────────────────────────────────────────────
async function fetchTool(args) {
  const rawId = typeof args.msg_id === 'string' ? args.msg_id.trim() : '';
  if (!rawId) {
    const got = Object.keys(args || {});
    return text('sym_fetch was called without msg_id, so no lookup was attempted — this is a malformed call, not a missing delivery. ' +
      'msg_id is required and takes an id from a channel notification or sym_receive, e.g. "in0042" or "m007". ' +
      (got.length ? `Received instead: ${got.join(', ')}.` : 'No parameters were received.'));
  }
  const at = deliveryPolicy.readOffset(args.offset);
  if (at.error) return text(at.error);
  const d = await host.get(rawId);
  if (!d) return text(`Delivery ${rawId} not found (expired, unknown, or not served by this node's interior).`);
  const j = deliveryPolicy.judgeDelivery(d, { policy, selfNodeId });
  if (j.bucket === 'unverified') {
    securityAudit('fetch', `unverified:${d.withheld}`, 'unverified', '', rawId);
    return text(`Withheld, so not shown: ${deliveryPolicy.unverifiedLine(d)}.`);
  }
  if (j.bucket === 'withheld' || j.bucket === 'not-allowed') {
    securityAudit('fetch', j.verdict.reason, d.facts ? d.facts.signer.nodeId : d.moodFrom, j.verdict.excerpt, rawId);
    return text(`Withheld, so not shown: ${deliveryPolicy.withheldLine(rawId, d.facts ? deliveryPolicy.whoTag(d.facts.signer.label, d.facts.signer.nodeId) : 'its sender', j.verdict)}.`);
  }
  const head = deliveryPolicy.fetchHead(d) + (j.bucket === 'own' ? '\nSigned by this node itself: its own record, relayed back.' : '');
  const prepared = deliveryPolicy.prepare({ content: d.content, categories: d.categories, payload: d.payload });
  const body = d.kind === 'mood'
    ? `mood: ${d.mood ? d.mood.text : d.content}`
    : deliveryPolicy.renderBody(d.content || '', prepared);
  const part = deliveryPolicy.fetchPart({ id: rawId, head, body, offset: at.offset });
  if (part.last) { try { await host.markRead(rawId); } catch { /* best effort */ } }
  return text(part.error || part.text);
}

// ── sym_recall ───────────────────────────────────────────────
async function recallTool(args) {
  const raw = await host.recall(args.query || '');
  if (raw && raw.unsupported) return text(raw.unsupported);
  const results = Array.isArray(raw) ? raw : (raw && raw.items) || [];
  if (!results.length) return text('No memories found.');
  const lines = [];
  let hidden = 0;
  for (const r of results) {
    if (lines.length >= 10) break;
    const out = deliveryPolicy.recallLine(r, { policy, selfName: NODE_NAME });
    if (out.bucket === 'unverified') { hidden++; continue; }
    if (out.audit) securityAudit('recall', out.audit[0], r.author && r.author.nodeId ? r.author.nodeId : 'self', out.audit[1]);
    lines.push(out.line);
  }
  const more = results.length - lines.length - hidden;
  return text((lines.length ? lines.join('\n\n') : 'No verified memory matched.') +
    (hidden ? `\n\n(${hidden} peer record(s) matched that were not verified when admitted — stored before Core Secure, or quarantined — not shown.)` : '') +
    (more > 0 ? `\n\n(+${more} more matched — narrow the query to see them)` : ''));
}

// ── sym_status ───────────────────────────────────────────────
async function statusTool() {
  const lines = [];
  if (MODE === 'interior') {
    const m = host.mission;
    lines.push(`Mode: interior — this session is the mind of ${host.name || 'a node'}${host.nodeId ? ` (${host.nodeId})` : ''}; it has no mesh identity of its own.`);
    lines.push(`Interior socket: ${host.socketPath}${host.closedReason ? ` — ${host.closedReason}` : ''}`);
    lines.push(m ? `Mission: ${m.missionId || '?'} (mind ${m.mindId || '?'}); kinds ${Array.isArray(m.kinds) ? m.kinds.join(', ') : '?'}; allowlist ${Array.isArray(m.allowTo) && m.allowTo.length ? m.allowTo.join(', ') : 'room only'}`
      : `Mission: not described by the node (sym 0.14's socket serves submit and end only)${host.kinds().length ? `; kinds from SYM_INTERIOR_KINDS: ${host.kinds().join(', ')}` : ''}${host.defaultKind ? `; default kind ${host.defaultKind}` : ''}`);
    const sup = (k) => (host.supports[k] === true ? 'yes' : host.supports[k] === false ? 'no (SDK gap)' : 'not asked yet');
    lines.push(`The node serves: deliveries ${sup('deliveries')}, push ${sup('subscribe')}, recall ${sup('recall')}`);
    lines.push(`Submissions: ${host.counts.submitted} signed and sent, ${host.counts.refused} refused${host.counts.refused ? ` (${Object.entries(host.counts.refusedByReason).map(([k, v]) => `${k} ×${v}`).join(', ')})` : ''}`);
    lines.push(`On exit: ${host.endOnExit ? 'ends this mind (revokes the capability)' : 'leaves the mind running (SYM_INTERIOR_END_ON_EXIT=0)'}`);
  } else {
    const s = host.status();
    const cs = s.coreSecure || {};
    // This node's own public key, through the public API: the issuer an invite of its own names
    // (there is no accessor for it, and reading identity.json would load the private key as well).
    let pub = null;
    try { pub = sdk.invite.parseInvite(host.inviteURL({ room: ROOM })).issuer.publicKey; } catch { /* */ }
    lines.push(`Node: ${NODE_NAME} — nodeId ${host.nodeId}, key fingerprint ${keyFingerprint(pub)}`);
    if (!IDENTITY.nodeId) lines.push(`  Pin this folder's agent so it is never re-minted: add "node_id": "${host.nodeId}" to ${PROJECT_CFG.file || '.sym/node.json'}.`);
    lines.push(`Room: ${ROOM} (${SERVICE_TYPE})${LAN_OFF ? ' — relay only (SYM_LAN=off)' : ''}`);
    lines.push(`Relay: ${s.relayStatus || (s.relayConnected ? 'connected' : (RELAY_URL ? 'disconnected' : 'not configured'))}`);
    if (RELAY_SOURCE) lines.push(`Relay credential: ${RELAY_SOURCE}`);
    const sessions = cs.sessions || {};
    lines.push(`Core Secure: ${sessions.confirmed || 0} confirmed session(s), ${sessions.authenticating || 0} authenticating; ${cs.keyBindings ?? '?'} key binding(s)` +
      (Array.isArray(cs.keyConflicts) && cs.keyConflicts.length ? `; ${cs.keyConflicts.length} KEY CONFLICT(S) for the operator: ${cs.keyConflicts.map((c) => c.nodeId || JSON.stringify(c)).join(', ')} (sym keys resolve)` : '; no key conflicts'));
    if (s.legacyImport && s.legacyImport.routes) lines.push(`Legacy Import: ${s.legacyImport.routes} route(s) — what they deliver is withheld here as unverified.`);
    lines.push(`Peers: ${s.peerCount || 0}`);
    lines.push(`Memories: ${s.memoryCount || 0}`);
  }
  if (ALLOWED.set) lines.push(`Allowlist: ${ALLOWED.nodeIds.length} nodeId(s)${ALLOWED.ignored.length ? `; ${ALLOWED.ignored.length} entr(ies) ignored (not nodeIds)` : ''}${ALLOWED.failClosed ? ' — it allows nothing until it lists nodeIds' : ''}`);
  lines.push(push.statusLine(pushState));
  for (const l of startupAdvisory.filter((x) => x.startsWith('MESH NODE ADVISORY'))) lines.push(l);
  for (const l of roomAdvisory().filter((x) => x.includes('sym daemon'))) lines.push(l);
  if (internalErrors) lines.push(`Internal errors survived: ${internalErrors} (last: ${lastInternalError}; stack on stderr)`);
  return text(lines.join('\n'));
}

// ── sym_peers ────────────────────────────────────────────────
const KEY_SOURCE_SHORT = { pinned: 'pinned', proven: 'proven', grant: 'grant-vouched', anchor: 'anchor' };
function outboxLines() {
  const ob = host.outbox.summary();
  if (!ob.total) return [];
  const per = Object.entries(ob.byPeer).map(([id, v]) => `${v.count} for ${v.label ? deliveryPolicy.whoTag(v.label, id) : shortId(id)} (${id})`);
  const labels = Object.entries(ob.byLabelOnly).map(([l, c]) => `${c} held by 0.10 for the label "${deliveryPolicy.displayName(l)}", which is not a route (discard it with sym_outbox_discard {peer: "${deliveryPolicy.displayName(l)}"})`);
  const stale = ob.oldestDays !== null && ob.oldestDays >= 7;
  return [`OUTBOX: ${ob.total} CMB(s) HELD AT THIS SENDER, not delivered — ${[...per, ...labels].join(', ')}` +
    (ob.oldestDays !== null ? `; oldest held ${ob.oldestDays} day(s)` : '') + '. ' +
    (stale ? `A peer gone this long is unlikely to return; these count against the ${OUTBOX_MAX_ITEMS}-item limit that refuses new mail. Clear them with sym_outbox_discard once you accept they are lost.`
      : 'They flush when the peer\'s session returns. If this node does not come back, they are lost.')];
}

function peersTool() {
  const peers = host.peers();
  const advisory = [...roomAdvisory(), ...outboxLines()];
  const advisoryText = advisory.length ? `\n\n${advisory.join('\n')}` : '';
  if (!peers.length) return text(`No peers with a proven session. (room '${ROOM}' — source: ${ROOM_SOURCE})${advisoryText}`);
  const lines = peers.map((p) => {
    const sessions = Array.isArray(p.sessions) && p.sessions.length ? p.sessions.map((x) => x.transport).join('+') : (p.source || '?');
    return `${deliveryPolicy.displayName(p.name)} — nodeId ${p.peerId}; key ${KEY_SOURCE_SHORT[p.keySource] || p.keySource || '?'}; ${sessions}${p.profile && p.profile !== 'core-secure' ? ` (${p.profile}: unverified)` : ''}`;
  });
  return text(`${peers.length} peer(s) in room '${ROOM}' (send to one with to: "<nodeId>"):\n${lines.join('\n')}${advisoryText}`);
}

function outboxDiscardTool(args) {
  const peer = String(args.peer || '').trim();
  if (!peer) return text('sym_outbox_discard needs a peer: the nodeId the OUTBOX line names (or, for a 0.10 item, its label).', true);
  const pending = isNodeId(peer) ? host.outbox.pendingFor(peer) : host.outbox.heldForLabel(peer);
  if (!pending.length) return text(`Nothing held for ${JSON.stringify(peer)}. sym_peers lists what the outbox holds.`);
  const now = Date.now();
  const ages = pending.map((i) => ageDays(i, now)).filter((a) => a !== null);
  const left = host.outbox.drop(pending.map((i) => i.seq));
  return text(`Discarded ${pending.length} CMB(s) held for ${JSON.stringify(peer)}${ages.length ? `, the oldest held ${Math.max(...ages)} day(s)` : ''}. ` +
    `They were never delivered and are gone. ${left} CMB(s) remain held for other peers.`);
}

function roomInfoTool() {
  const s = host.status();
  const peers = Array.isArray(s.peers) ? s.peers : [];
  const peerLines = peers.length ? peers.map((p) => `  ${deliveryPolicy.whoTag(p.name, p.peerId)} via ${(p.sessions || []).map((x) => x.transport).join('+') || p.source || '?'}`).join('\n') : '  (no peers in this room)';
  return text('Mesh room (MMP §5.8):\n' +
    `  room: ${ROOM}\n  room source: ${ROOM_SOURCE}\n  service type: ${SERVICE_TYPE}\n  node: ${NODE_NAME} (${host.nodeId})\n  peers in room: ${s.peerCount || 0}\n` +
    peerLines + '\n\n' +
    (ROOM === 'default' && !process.env.SYM_ROOM ? 'NOTE: \'default\' is the fallback, not a configured choice. A teammate in a named room is invisible from here.\n' : '') +
    'To change rooms, call sym_join_room.');
}

// ── Invites (design D9) ──────────────────────────────────────
function inviteCreateTool(args) {
  const room = args.room;
  if (!room || typeof room !== 'string') return text('Missing required argument: room', true);
  if (!isCanonicalRoom(room) || room === 'default') return text(`Invalid room name: "${room}" — ${roomRefusalReason(room)}.`, true);
  const crossNetwork = !!(args.cross_network || args.relay_url || args.relay_token);
  const relayUrl = crossNetwork ? (args.relay_url || HOSTED_RELAY_URL) : undefined;
  const minted = crossNetwork && !args.relay_token;
  const relayToken = crossNetwork ? (args.relay_token || crypto.randomBytes(32).toString('base64url')) : undefined;
  if (crossNetwork && relayUrl === HOSTED_RELAY_URL && relayToken.length < HOSTED_RELAY_MIN_TOKEN) {
    return text(`relay_token is ${relayToken.length} characters; the hosted relay admits ${HOSTED_RELAY_MIN_TOKEN} or more. Omit relay_token and one is minted for you.`, true);
  }
  const url = host.inviteURL({ room, relay: relayUrl, token: relayToken });
  const alreadyHere = ROOM === room && (!crossNetwork || (RELAY_URL === relayUrl && RELAY_TOKEN === relayToken));
  const joinCall = { room, ...(crossNetwork ? { relay_url: relayUrl, relay_token: relayToken } : {}) };
  return text(`Invite URL (${crossNetwork ? 'cross-network (relay)' : 'LAN-only (Bonjour)'}):\n\n    ${url}\n\n` +
    `It names this node as the issuer (nodeId ${host.nodeId}): whoever accepts it pins this node's key, so their node knows it is you (sym D5). ` +
    'Share it over a channel you trust for both secrecy and integrity: whoever edits it before it is accepted chooses whom the acceptor pins.' +
    (crossNetwork ? ` ${minted ? 'The token was minted just now; it' : 'The token'} names a channel on ${relayUrl}, and anyone holding the URL can join it — share it as you would a password. To lock a device out, mint a new invite.` : '') +
    '\n\nEach teammate calls sym_join_room {invite: "<this URL>"}.\n\n' +
    (alreadyHere ? `You're already on this room${crossNetwork ? ' through this relay channel' : ''}.` : `You are not on this ${crossNetwork ? 'relay channel' : 'room'} yet. To be reachable, call sym_join_room first:\n\n    ${JSON.stringify(joinCall)}`));
}

function inviteInfoTool(args) {
  const url = args.url;
  if (!url || typeof url !== 'string') return text('Missing required argument: url', true);
  const p = parseInviteURL(url);
  if (p.error) return text(p.error, true);
  const out = {
    app: p.appScheme, room: p.room, service_type: p.serviceType,
    room_id: p.appScheme === 'sym' ? undefined : p.roomId, room_name: p.appScheme === 'sym' ? undefined : p.roomName,
    relay_url: p.relayUrl || undefined, relay_token: p.relayToken || undefined,
    issuer_node_id: p.issuer ? p.issuer.nodeId : undefined, issuer_key_fingerprint: p.issuer ? keyFingerprint(p.issuer.publicKey) : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return text(`Parsed invite: ${url}\n\n${JSON.stringify(out, null, 2)}\n\n` +
    (p.issuer ? 'Joining with it pins the issuer\'s key for that nodeId, if this node has no key for it yet.\n\n' : 'This invite names no issuer, so joining pins no key: the first session with each peer is trusted on its own proof.\n\n') +
    `To join, call sym_join_room:\n\n    ${JSON.stringify({ invite: url })}`);
}

async function joinRoomTool(args) {
  let room = args.room;
  let relayUrl = args.relay_url || null;
  let relayToken = args.relay_token || null;
  let invite = null;
  if (args.invite) {
    invite = parseInviteURL(String(args.invite));
    if (invite.error) return text(invite.error, true);
    room = room || invite.room;
    if (room !== invite.room) return text(`room "${room}" and the invite's room "${invite.room}" differ; pass one.`, true);
    relayUrl = relayUrl || invite.relayUrl;
    relayToken = relayToken || invite.relayToken;
  }
  if (!room || typeof room !== 'string') return text('Missing required argument: room (or invite)', true);
  if (!isCanonicalRoom(room)) return text(`Invalid room name: "${room}" — ${roomRefusalReason(room)}.`, true);
  let relaySource = relayUrl ? (invite && !args.relay_url ? 'the invite' : 'this call') : null;
  if (args.lan_only) {
    relayUrl = null; relayToken = null;
    if (forgetRelay(room)) relaySource = 'forgotten';
  } else if (!relayUrl) {
    const saved = loadRelay(room);
    if (saved) { relayUrl = saved.relay_url; relayToken = saved.relay_token; relaySource = `remembered (${saved.file})`; }
  }
  if (relayUrl && relayToken && relayUrl === HOSTED_RELAY_URL && relayToken.length < HOSTED_RELAY_MIN_TOKEN) {
    return text(`relay_token is ${relayToken.length} characters; ${HOSTED_RELAY_URL} admits ${HOSTED_RELAY_MIN_TOKEN} or more, so this join would be refused on every attempt. ` +
      `Nothing was changed — this node is still in room '${ROOM}'.`, true);
  }
  const newServiceType = roomServiceType(room);
  const prevRoom = ROOM;
  const prevServiceType = SERVICE_TYPE;
  // The pin comes BEFORE the move, so it precedes the first session in the new room: a squatter
  // racing the issuer to that first session would otherwise be bound first. The key registry is
  // persisted in the node's directory, so the rebuilt node reads it.
  let pinLine = '';
  if (invite && invite.issuer) {
    const a = host.acceptInvite(String(args.invite));
    pinLine = a.pinned
      ? `Pinned the issuer's key for ${invite.issuer.nodeId} (fingerprint ${keyFingerprint(invite.issuer.publicKey)}): a session from that nodeId must prove this key.\n`
      : `The issuer's key was not pinned: ${a.reason || 'unknown reason'}${a.reason === 'conflict' ? ' — this node holds a different key for that nodeId; the operator resolves it (sym keys resolve)' : ''}.\n`;
  }
  const r = await host.rebuild({ serviceType: newServiceType, room, relay: relayUrl, relayToken });
  if (!r.ok) {
    if (r.restored) return text(`Could not join room "${room}": ${r.error}\n\nRestored the previous room "${prevRoom}"; this node is back where it was.`, true);
    NODE_FAULT = `MESH NODE NOT RUNNING: sym_join_room "${room}" failed (${r.error}) and the previous room "${prevRoom}" could not be restored (${r.restoreError}). Restart this MCP server.`;
    host = null;
    return text(NODE_FAULT, true);
  }
  ROOM = room;
  ROOM_SOURCE = 'sym_join_room at runtime (not persisted to this server\'s env)';
  SERVICE_TYPE = newServiceType;
  RELAY_URL = relayUrl;
  RELAY_TOKEN = relayToken;
  let remembered = null;
  if (relayUrl && (relaySource === 'this call' || relaySource === 'the invite')) {
    remembered = saveRelay(room, { relay_url: relayUrl, relay_token: relayToken });
    RELAY_SOURCE = remembered ? `remembered for room '${room}' (${remembered})` : 'sym_join_room (not persisted — the relays directory is not writable)';
  } else RELAY_SOURCE = relayUrl ? relaySource : null;
  publishRoomBeacon();

  const swapped = `Moved from room "${prevRoom}" (${prevServiceType}) to "${room}" (${newServiceType}), same identity.\n${pinLine}`;
  if (!relayUrl) {
    return text(swapped + (relaySource === 'forgotten' ? `The relay credential remembered for "${room}" has been forgotten; this node is LAN-only.\n` : '') +
      'Discovering peers in the new room. Call sym_peers in a moment to see who has a session.');
  }
  const credentialLine = remembered
    ? `Relay credential remembered for room "${room}" (${remembered}, mode 0600) — the next start re-joins it; sym_join_room {room, lan_only: true} forgets it.\n`
    : (relaySource && relaySource.startsWith('remembered') ? 'Relay credential restored from the one remembered for this room.\n' : '');
  const outcome = await host.awaitRelayOutcome(10000);
  const relayLine = host.status().relayStatus || `relay: ${relayUrl}`;
  const failed = outcome && (outcome.phase === 'refused' || outcome.phase === 'collision');
  const settled = outcome && outcome.phase === 'connected';
  return text(swapped + `Relay: ${relayLine}\n` + credentialLine +
    (settled ? 'Call sym_peers to see who has a session; teammates who join with the same invite appear as they arrive.'
      : failed ? `You are still in room "${room}" for LAN peers; nothing crosses the relay until this is fixed.`
        : 'The relay has not answered yet — it keeps retrying in the background. Call sym_status to see where it stands.'), failed);
}

// ── Mesh events → channel notifications ──────────────────────

// mcp.notification() is async: one that cannot go out (before connect) is not lost — the delivery is
// in the inbox. Resolves true once the notification was written.
function pushChannel(eventType, data) {
  let p;
  if (!mcp) return Promise.resolve(false);
  try {
    p = Promise.resolve(mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: typeof data === 'string' ? data : JSON.stringify(data), meta: { event_type: eventType, source: 'sym-mesh' } },
    })).then(() => true, () => false);
  } catch { p = Promise.resolve(false); }
  pushesInFlight.add(p);
  p.finally(() => pushesInFlight.delete(p));
  return p;
}

function onDelivery(d) {
  try {
    const j = deliveryPolicy.judgeDelivery(d, { policy, selfNodeId });
    if (j.bucket === 'own') { securityAudit('push', 'own-record', 'self', '', d.id); return; }
    const rateKey = d.facts ? (d.facts.deliverer ? d.facts.deliverer.nodeId : d.facts.signer.nodeId) : `unattributed:${d.moodFrom || d.withheld || '?'}`;
    if (j.bucket === 'unverified') {
      securityAudit('push', `unverified:${d.withheld}`, 'unverified', '', d.id);
      if (pushRate.admit(rateKey)) pushChannel('delivery-withheld', `⚠ delivery withheld, not verified [${d.id}] · ${deliveryPolicy.unverifiedLine(d).replace(/^\[[^\]]+\] withheld, not verified: /, '')} · sym_receive names it`);
      return;
    }
    const action = deliveryPolicy.pushAction(j.verdict, pushRate, rateKey);
    const who = d.facts ? d.facts.signer.nodeId : d.moodFrom;
    if (action !== 'push') {
      if (action === 'rate-held') securityAudit('push', 'rate-limit', who, `over ${pushRate.limit}/min from this session; push held, the delivery waits in the inbox`, d.id);
      else if (action !== 'silent') securityAudit('push', j.verdict.reason, who, j.verdict.excerpt, d.id);
      if (action === 'notice') pushChannel('delivery-withheld', `${deliveryPolicy.deliveryTag(d)} ⚠ delivery withheld · ${j.verdict.detail} [${d.id}] · sym_receive names it by id`);
      return;
    }
    const { header, risk, lead } = deliveryPolicy.pushHeader(d, j.prepared);
    if (risk && risk.risky) securityAudit('push', `classifier-risk:${risk.terms.join(',')}`, who, lead, d.id);
    const sent = pushChannel(d.kind === 'mood' ? 'mood' : 'cmb', `${header} [${d.id}]${deliveryPolicy.keyTag(d)}`);
    sent.then((ok) => { if (ok) { pushedIds.add(d.id); if (pushedIds.size > 2000) pushedIds.delete(pushedIds.values().next().value); } });
  } catch (err) { stderrLog(`push failed for ${d && d.id}: ${err && err.message}`); }
}

function wireHost(h) {
  h.on('delivery', onDelivery);
  h.on('relay-auth-refused', (info) => {
    const line = `Relay ${info.relayUrl} refused ${info.name} (${info.code}: ${info.reason}). The relay_token this session presents is not accepted by that relay — ` +
      'mint a fresh invite with sym_invite_create, or get the team\'s invite, then sym_join_room with it (or fix SYM_RELAY_TOKEN and restart). LAN peers are unaffected.';
    stderrLog(line);
    pushChannel('relay-auth-refused', { relayUrl: info.relayUrl, code: info.code, reason: info.reason, text: line });
  });
  h.on('identity-collision', (info) => {
    stderrLog(`identity collision on relay — another process is holding nodeId=${info.nodeId} name=${info.name}. Exiting.`);
    process.exit(2);
  });
}
if (host) wireHost(host);

function createMcpServer() {
  const server = new Server(
    { name: 'sym-mesh', version: PKG_VERSION },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions: instructions() + (startupAdvisory.length ? `\n\n${startupAdvisory.join('\n')}` : ''),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, onToolCall);
  // The push check goes out once the host has initialised (design D5).
  // An interior that serves no delivery stream has nothing to push, so it gets no check.
  server.oninitialized = () => { if (host && (MODE === 'node' || host.supports.subscribe === true)) sendPushCheck().catch(() => {}); };
  return server;
}

// ── Shutdown and survival ────────────────────────────────────
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopRoomBeacon();
  try { if (host) await host.stop(); } catch { /* exiting anyway */ }
  process.exit(0);
}

let internalErrors = 0;
let lastInternalError = null;
let mcpConnected = false;
function recordInternalError(kind, err) {
  if (err && err.code === 'EPIPE') { shutdown(); return; }
  if (!mcpConnected) {
    try { process.stderr.write(`sym-mesh-channel: ${kind} before the host connected: ${err?.stack || err}\n`); } catch {}
    process.exit(1);
  }
  internalErrors++;
  lastInternalError = `${kind}: ${err?.message || err}`;
  try { process.stderr.write(`sym-mesh-channel: ${kind} (server kept running): ${err?.stack || err}\n`); } catch {}
}
process.on('uncaughtException', (err) => recordInternalError('uncaught exception', err));
process.on('unhandledRejection', (err) => recordInternalError('unhandled rejection', err));
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('SIGHUP', () => shutdown());
// A stdio server whose stdin has closed can never be asked anything again: leave the mesh cleanly
// (and, in interior mode, end the mind).
process.stdin.on('end', () => shutdown());
process.stdin.on('close', () => shutdown());
process.stdin.on('error', () => shutdown());

// ── Room discovery beacon (MMP §5.8), node mode ──────────────
let roomBeacon = null;
function publishRoomBeacon() {
  if (MODE !== 'node' || LAN_OFF || !host) return;
  try {
    const { Bonjour } = require('bonjour-service');
    if (roomBeacon) { try { roomBeacon.unpublishAll(); roomBeacon.destroy(); } catch {} roomBeacon = null; }
    roomBeacon = new Bonjour();
    roomBeacon.publish({ name: NODE_NAME, type: 'symrooms', port: (host.status().port) || 7777, txt: { room: ROOM, node: NODE_NAME } });
  } catch (e) { stderrLog(`room beacon unavailable: ${e?.message || e}`); }
}
function stopRoomBeacon() {
  if (!roomBeacon) return;
  try { roomBeacon.unpublishAll(() => { try { roomBeacon.destroy(); } catch {} }); } catch {}
  roomBeacon = null;
}

function announce() {
  if (MODE === 'interior') { stderrLog(`interior mode: attached to ${INTERIOR_SOCKET}`); return; }
  stderrLog(`node '${NODE_NAME}' (${selfNodeId}) in room '${ROOM}' (${SERVICE_TYPE}) — room source: ${ROOM_SOURCE}`);
  if (RELAY_URL) stderrLog(`relay ${RELAY_URL} — credential source: ${RELAY_SOURCE}`);
  try {
    const ob = host.outbox.summary();
    if (ob.total) stderrLog(`OUTBOX carries ${ob.total} CMB(s) held from a previous run. They are NOT delivered; they flush when each peer's session returns.`);
  } catch { /* never block startup on bookkeeping */ }
}

async function main() {
  if (host) {
    try { await host.start(); }
    catch (e) {
      if (MODE !== 'interior') throw e;
      NODE_FAULT = `INTERIOR MODE NOT ATTACHED: could not open ${INTERIOR_SOCKET} (${e.code || e.message}). Is the node running, and listening on its interior?`;
      stderrLog(NODE_FAULT);
      host = null;
    }
    if (host) {
      if (MODE === 'interior' && host.nodeId) selfNodeId = host.nodeId;   // the node's own records are its own
      announce(); publishRoomBeacon();
    }
  }
  mcp = createMcpServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  mcpConnected = true;
}

main().catch((err) => {
  process.stderr.write(`sym-mesh-channel failed: ${err && err.message}\n`);
  process.exit(1);
});

