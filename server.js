#!/usr/bin/env node
'use strict';

// Subcommand dispatch: `sym-mesh-channel init` runs the installer.
if (process.argv[2] === 'init') {
  require('./bin/install.js');
  return;
}

/**
 * sym-mesh-channel — MCP server that makes Claude Code a peer node on the SYM mesh.
 *
 * Architecture (MMP Section 13.9: Local Event Interface):
 *   SymNode (own identity, own SVAF field weights) → relay → mesh
 *   MCP channel notifications → Claude Code (real-time push)
 *   MCP tools → SymNode methods (send, observe, recall)
 *
 * This is a PEER NODE, not a client of the daemon. It has its own identity,
 * its own relay connection, and its own SVAF evaluation with engineering-domain
 * field weights. Per MMP Section 3: every participant is a peer.
 *
 * Copyright (c) 2026 SYM.BOT Ltd. Apache 2.0 License.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { SymNode } = require('@sym-bot/sym');

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
const NODE_NAME = process.env.SYM_NODE_NAME || `claude-${require('os').hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

// ── Mesh group (MMP §5.8) ──────────────────────────────────
//
// LAN isolation by Bonjour service type. `_sym._tcp` is the default
// (backward compatible). A named group `<foo>` maps to service type
// `_foo._tcp`. Passing a full `_foo._tcp` service type explicitly also
// works. Nodes in different groups never discover each other at mDNS.
// See MeloTune's MoodRoom model for the per-room pattern
// (`_melotune-{id}._tcp`).
function resolveServiceType() {
  const explicit = process.env.SYM_SERVICE_TYPE;
  if (explicit) return explicit;
  const group = process.env.SYM_GROUP;
  if (group && group !== 'default') return `_${group}._tcp`;
  return '_sym._tcp';
}
const SERVICE_TYPE = resolveServiceType();
const GROUP = process.env.SYM_GROUP || (SERVICE_TYPE !== '_sym._tcp'
  ? SERVICE_TYPE.replace(/^_/, '').replace(/\._tcp$/, '')
  : 'default');

const node = new SymNode({
  name: NODE_NAME,
  cognitiveProfile: 'Engineering node. Code, architecture, debugging, technical decisions.',
  svafFieldWeights: FIELD_WEIGHTS,
  svafFreshnessSeconds: 7200, // 2hr — session-length context
  discoveryServiceType: SERVICE_TYPE,
  group: GROUP,
  relay: process.env.SYM_RELAY_URL || null,
  relayToken: process.env.SYM_RELAY_TOKEN || null,
  silent: true,
});

// Identity collision (added in @sym-bot/sym 0.3.68): the relay told us
// another process is holding our nodeId. Don't try to reconnect — that
// caused the peer-flap loop documented in v0.1.2/v0.1.3 commit messages.
// Exit so Claude Code can decide whether to respawn (with the freshness
// window now elapsed) or surface the failure to the user.
node.on('identity-collision', (info) => {
  process.stderr.write(
    `sym-mesh-channel: identity collision on relay — another process is holding ` +
    `nodeId=${info.nodeId} name=${info.name}. Exiting.\n`
  );
  process.exit(2);
});

// ── MCP Server ───────────────────────────────────────────────

const mcp = new Server(
  { name: 'sym-mesh', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions:
      `You are a peer node on the SYM mesh (identity: ${NODE_NAME}). ` +
      'Mesh events arrive as <channel> notifications in real-time. ' +
      'When you see a message or CMB from another node, respond via the sym_send tool if actionable. ' +
      'Share observations about the user\'s state via sym_observe. ' +
      'Search mesh memory via sym_recall. ' +
      'Messages arrive as compact headers with [mNNN] IDs — use sym_fetch to read the full content when the header is relevant to your current task.',
  },
);

// ── Tools ────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'sym_send',
      description: 'Send a message to all mesh peers. Stored as a persistent CMB and broadcast via relay.',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: 'Message to broadcast' } },
        required: ['message'],
      },
    },
    {
      name: 'sym_observe',
      description: 'Share a structured CAT7 observation with the mesh. Extract fields from what you observe.',
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
      name: 'sym_group_info',
      description: 'Report the mesh group this node is in (MMP §5.8). Shows service type + group name + peer count.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sym_invite_info',
      description: 'Return the service type + group + optional relay token encoded in an app-specific mesh invite URL (e.g. melotune://room/{id}/{name}). Read-only inspection; does NOT switch the current node.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Invite URL, e.g. melotune://room/abc123/Kitchen' } },
        required: ['url'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'sym_send': {
      // Direct inter-node message — broadcast as type:'message' frame only.
      // Do NOT also persist as a CMB via node.remember(): that caused
      // double-delivery on receivers, who saw the same payload arrive once
      // as event_type='message' (from this broadcast) and again as
      // event_type='cmb' (from CMB gossip replication). One tool, one job:
      // sym_send is for ephemeral inter-node messages; sym_observe is for
      // structured CAT7 CMBs. Hosts that want both should call both.
      //
      // Report the actual delivered count (the number of peer transports
      // that successfully accepted the broadcast), not peers().length.
      // The two can disagree when peers are in _peers but their transports
      // are broken — counting peers().length would lie about delivery.
      // Requires @sym-bot/sym >= 0.3.70 where send() returns the count.
      const msg = args.message;
      const delivered = node.send(msg);
      return { content: [{ type: 'text', text: `Message delivered to ${delivered} peer(s).` }] };
    }

    case 'sym_observe': {
      const fields = {
        focus: args.focus || 'observation',
        issue: args.issue || 'none',
        intent: args.intent || 'observation',
        motivation: args.motivation || '',
        commitment: args.commitment || '',
        perspective: args.perspective || NODE_NAME,
        mood: args.mood || { text: 'neutral', valence: 0, arousal: 0 },
      };
      const entry = node.remember(fields);
      return { content: [{ type: 'text', text: entry ? `Observed: ${entry.key}` : 'Duplicate — already in memory.' }] };
    }

    case 'sym_recall': {
      const results = node.recall(args.query || '');
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }
      const lines = results.slice(0, 10).map(r => {
        const focus = r.cmb?.fields?.focus?.text || r.content || '';
        const source = r.source || r.cmb?.createdBy || 'unknown';
        const time = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
        return `[${source}] ${time}\n  ${focus.slice(0, 150)}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
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
      const entry = MESSAGE_STORE.get(args.msg_id);
      if (!entry) {
        return { content: [{ type: 'text', text: `Message ${args.msg_id} not found (expired or invalid ID).` }] };
      }
      return {
        content: [{
          type: 'text',
          text: `[${entry.from}] ${new Date(entry.timestamp).toISOString()}\n\n${entry.content}`,
        }],
      };
    }

    case 'sym_status': {
      const s = node.status();
      return {
        content: [{
          type: 'text',
          text: `Node: ${NODE_NAME} (${node.nodeId?.slice(0, 8) || '?'})\n` +
            `Group: ${GROUP} (${SERVICE_TYPE})\n` +
            `Relay: ${s.relayConnected ? 'connected' : 'disconnected'}\n` +
            `Peers: ${s.peerCount || 0}\n` +
            `Memories: ${s.memoryCount || 0}`,
        }],
      };
    }

    case 'sym_group_info': {
      const s = node.status();
      const peers = typeof node.getPeers === 'function' ? node.getPeers() : [];
      const peerLines = peers.length
        ? peers.map(p => `  ${p.name} (${(p.peerId || '').slice(0, 8)}) via ${p.transport || '?'}`).join('\n')
        : '  (no peers in this group)';
      return {
        content: [{
          type: 'text',
          text: `Mesh group (MMP §5.8):\n` +
            `  group: ${GROUP}\n` +
            `  service type: ${SERVICE_TYPE}\n` +
            `  node: ${NODE_NAME} (${node.nodeId?.slice(0, 8) || '?'})\n` +
            `  peers in group: ${s.peerCount || 0}\n` +
            peerLines + `\n\n` +
            `To join a different group, restart the sym-mesh-channel MCP server with env var SYM_GROUP=<name> or SYM_SERVICE_TYPE=<_foo._tcp>.`,
        }],
      };
    }

    case 'sym_invite_info': {
      const url = args?.url;
      if (!url || typeof url !== 'string') {
        return { content: [{ type: 'text', text: 'Missing required argument: url' }], isError: true };
      }
      // Supported scheme examples:
      //   melotune://room/{id}/{percent-encoded name}     (per MoodRoom.inviteURL in sym-swift)
      //   sym://group/{name}
      const m = url.match(/^([a-z][a-z0-9-]+):\/\/(?:room|group)\/([^/?#]+)(?:\/([^?#]+))?/i);
      if (!m) {
        return { content: [{ type: 'text', text: `Unrecognised invite URL: ${url}` }], isError: true };
      }
      const appScheme = m[1].toLowerCase();
      const rawId = decodeURIComponent(m[2]);
      const rawName = m[3] ? decodeURIComponent(m[3]) : rawId;
      // Map to service type + group.
      const serviceType = appScheme === 'sym'
        ? `_${rawId}._tcp`
        : `_${appScheme}-${rawId}._tcp`;
      const group = appScheme === 'sym' ? rawId : `${appScheme}-${rawId}`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            app: appScheme,
            group,
            service_type: serviceType,
            room_id: rawId,
            room_name: rawName,
            join_hint: `Set env vars: SYM_GROUP=${group} SYM_SERVICE_TYPE=${serviceType} — then restart the MCP server.`,
          }, null, 2),
        }],
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
const MESSAGE_STORE = new Map();
let msgSeq = 0;
const MAX_STORED = 200;

function storeMessage(from, content) {
  const msgId = `m${String(++msgSeq).padStart(3, '0')}`;
  MESSAGE_STORE.set(msgId, { from, content, timestamp: Date.now() });
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
  else if (lines[0]) parts.push(lines[0].slice(0, 100));

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

node.on('cmb-accepted', (entry) => {
  // Don't echo back our own CMBs
  if (entry.source === NODE_NAME || entry.cmb?.createdBy === NODE_NAME) return;

  const source = entry.source || entry.cmb?.createdBy || 'unknown';

  // Peer allowlist gate (defense-in-depth, see SECURITY.md)
  if (!isPeerAllowed(source)) return;

  const focus = entry.cmb?.fields?.focus?.text || entry.content || '';
  const mood = entry.cmb?.fields?.mood?.text || '';
  pushChannel('cmb', `[${source}] ${focus}${mood && mood !== 'neutral' ? ` (mood: ${mood})` : ''}`);
});

node.on('message', (from, content) => {
  // Peer allowlist gate
  if (!isPeerAllowed(from)) return;

  // Compact channel: store full content, push only header + msg_id.
  // Agent calls sym_fetch(msg_id) for full content when needed.
  const msgId = storeMessage(from, content);
  const header = extractCompactHeader(from, content);
  pushChannel('message', `[${from}] ${header} [${msgId}]`);
});

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

async function main() {
  // Start SymNode — connects to relay as a peer
  await node.start();

  // Start MCP server — communicates with Claude Code via stdio
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`sym-mesh-channel failed: ${err.message}\n`);
  process.exit(1);
});
