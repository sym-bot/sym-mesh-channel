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
 * Copyright (c) 2026 SYM.BOT. Apache 2.0 License.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { SymNode } = require('@sym-bot/sym');

// Kebab-case validator shared by group-related tools.
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Invite URL parsing (shared by sym_invite_info and the internal
//    validation path for sym_join_group when passed a URL). Exposed as
//    a module-level function so it's trivially unit-testable and the
//    same regex doesn't drift between two call sites.

const INVITE_URL_RE = /^([a-z][a-z0-9-]+):\/\/(?:room|group|team)\/([^/?#]+)(?:\/([^?#]+))?(?:\?(.+))?$/i;

function parseInviteURL(url) {
  const m = INVITE_URL_RE.exec(url);
  if (!m) {
    return {
      error:
        `Unrecognised invite URL: ${url}\n\n` +
        `Expected shapes:\n` +
        `  sym://group/{name}                        (LAN-only)\n` +
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
  // For sym:// the path element IS the group name. For app-scoped URLs
  // (melotune://, melomove://, etc.) the path is the room id and the
  // group is prefixed with the app name to avoid collisions.
  const serviceType = appScheme === 'sym' ? `_${rawId}._tcp` : `_${appScheme}-${rawId}._tcp`;
  const group = appScheme === 'sym' ? rawId : `${appScheme}-${rawId}`;
  return {
    appScheme,
    group,
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

async function discoverGroups() {
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
        // Filter to the SYM protocol family: global sym, named groups, and
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
            `No SYM-mesh groups visible on the local network right now.\n\n` +
            `This only shows groups with at least one node currently online. ` +
            `Groups you or teammates have used before are not persisted anywhere ` +
            `(p2p architecture — no central directory).\n\n` +
            `Your node is on: ${SERVICE_TYPE} (group "${GROUP}").`,
        });
      }
      const lines = [];
      lines.push(`SYM-mesh groups visible on LAN (${seen.size}):`);
      for (const st of Array.from(seen).sort()) {
        const name = st.replace(/^_/, '').replace(/\._tcp$/, '');
        const isSelf = st === SERVICE_TYPE ? '  (← your current group)' : '';
        lines.push(`  ${st}   group="${name}"${isSelf}`);
      }
      lines.push('');
      lines.push(`To join one, call sym_join_group with group="<name>".`);
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
// Mutable so sym_join_group can hot-swap the node at runtime without a
// Claude Code restart. Declaring as `let` rather than `const` is the
// smallest change that makes hot-swap possible.
let SERVICE_TYPE = resolveServiceType();
let GROUP = process.env.SYM_GROUP || (SERVICE_TYPE !== '_sym._tcp'
  ? SERVICE_TYPE.replace(/^_/, '').replace(/\._tcp$/, '')
  : 'default');
let RELAY_URL = process.env.SYM_RELAY_URL || null;
let RELAY_TOKEN = process.env.SYM_RELAY_TOKEN || null;

let node = new SymNode({
  name: NODE_NAME,
  cognitiveProfile: 'Engineering node. Code, architecture, debugging, technical decisions.',
  svafFieldWeights: FIELD_WEIGHTS,
  svafFreshnessSeconds: 7200, // 2hr — session-length context
  discoveryServiceType: SERVICE_TYPE,
  group: GROUP,
  relay: RELAY_URL,
  relayToken: RELAY_TOKEN,
  silent: true,
});

// Event handlers are extracted into a single registration function so the
// hot-swap path in sym_join_group can re-register them on the new node.
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
    const focus = entry.cmb?.fields?.focus?.text || entry.content || '';
    const mood = entry.cmb?.fields?.mood?.text || '';
    pushChannel('cmb', `[${source}] ${focus}${mood && mood !== 'neutral' ? ` (mood: ${mood})` : ''}`);
  });

  n.on('message', (from, content) => {
    if (!isPeerAllowed(from)) return;
    const msgId = storeMessage(from, content);
    const header = extractCompactHeader(from, content);
    pushChannel('message', `[${from}] ${header} [${msgId}]`);
  });
}

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
      'When you see a CMB from another node, respond via sym_send targeted at that node by name if the reply is for that specific peer (MMP §4.4.4 targeted CMB). ' +
      'Share observations about your own state with the whole mesh via sym_observe (MMP §9.2 receiver-autonomous SVAF evaluation). ' +
      'Both sym_send and sym_observe emit CAT7 CMBs; receivers run SVAF and, if admitted, remix-store with lineage pointing back to your CMB. ' +
      'Search mesh memory via sym_recall. ' +
      'Messages arrive as compact headers with [mNNN] IDs — use sym_fetch to read the full content when the header is relevant to your current task.',
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
        'use sym_observe when sharing your own state with the whole mesh.',
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
        },
        required: ['focus'],
      },
    },
    {
      name: 'sym_observe',
      description:
        'Broadcast a structured CAT7 observation about your own state to all mesh peers. ' +
        'Receivers run SVAF (MMP §9.2) and admitted CMBs are remix-stored with lineage. ' +
        'Equivalent to sym_send with "to" omitted — kept as a separate tool because self-observation is the common case and does not need peer selection.',
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
      name: 'sym_invite_create',
      description: 'Generate a shareable invite URL for a named mesh group. Team leads use this to let teammates join their dev-team mesh. LAN-only invite: pass group only, returns sym://group/{name}. Cross-network invite: pass relay_url + relay_token too, returns sym://team/{name}?relay=...&token=... — teammates on different networks join through the relay.',
      inputSchema: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'Kebab-case group name, e.g. "backend-team".' },
          relay_url: { type: 'string', description: 'Optional WebSocket relay URL, e.g. wss://sym-relay.onrender.com. Include for cross-network teams.' },
          relay_token: { type: 'string', description: 'Optional relay authentication token (shared secret for this team channel).' },
        },
        required: ['group'],
      },
    },
    {
      name: 'sym_invite_info',
      description: 'Parse a mesh invite URL and return everything the invitee needs to join: group name, service type, and any relay credentials. Read-only; does NOT switch the current node (use sym_join_group for that). Works on LAN group invites (sym://group/{name}), cross-network team invites (sym://team/{name}?relay=&token=), and app-specific room invites (e.g. melotune://room/{id}/{name}).',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Invite URL, e.g. sym://group/backend-team' } },
        required: ['url'],
      },
    },
    {
      name: 'sym_join_group',
      description: 'Hot-swap this node into a different mesh group at runtime — no Claude Code restart needed. Stops the current SymNode, reconstructs it with the new group (and optional relay credentials), and restarts it. Teammates on the same group/relay will discover this node via Bonjour (LAN) or the relay (cross-network). To leave a group, pass group="default" which reverts to the global _sym._tcp mesh.',
      inputSchema: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'Kebab-case group name, e.g. "backend-team". Pass "default" to return to the global mesh.' },
          relay_url: { type: 'string', description: 'Optional WebSocket relay URL for cross-network teams. Leave empty for LAN-only.' },
          relay_token: { type: 'string', description: 'Optional relay authentication token.' },
        },
        required: ['group'],
      },
    },
    {
      name: 'sym_groups_discover',
      description: 'List SYM-mesh groups currently advertising on the local network. Uses Bonjour / mDNS to find service types matching the SYM protocol. Only shows groups with at least one node online right now — there is no central directory of offline-but-known groups. macOS and Windows have Bonjour built in; Linux requires avahi-daemon.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'sym_send': {
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

      const entry = node.remember(fields, targetPeerId ? { to: targetPeerId } : {});
      if (!entry) {
        return { content: [{ type: 'text', text: 'Duplicate — CMB already in memory, not re-broadcast.' }] };
      }
      const summary = targetPeerId
        ? `Sent CMB ${entry.key} to ${args.to}`
        : `Broadcast CMB ${entry.key} to all peers`;
      return { content: [{ type: 'text', text: summary }] };
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

    case 'sym_invite_create': {
      const group = args?.group;
      const relayUrl = args?.relay_url;
      const relayToken = args?.relay_token;
      if (!group || typeof group !== 'string') {
        return { content: [{ type: 'text', text: 'Missing required argument: group' }], isError: true };
      }
      if (!KEBAB_CASE_RE.test(group)) {
        return {
          content: [{
            type: 'text',
            text: `Invalid group name: "${group}". Must be kebab-case (lowercase alphanumerics + single hyphens), e.g. "backend-team".`,
          }],
          isError: true,
        };
      }
      // LAN-only flavor: sym://group/{name}
      // Cross-network flavor: sym://team/{name}?relay=...&token=...
      let url;
      let flavor;
      if (relayUrl || relayToken) {
        if (!relayUrl) return { content: [{ type: 'text', text: 'relay_token requires relay_url' }], isError: true };
        const params = [`relay=${encodeURIComponent(relayUrl)}`];
        if (relayToken) params.push(`token=${encodeURIComponent(relayToken)}`);
        url = `sym://team/${group}?${params.join('&')}`;
        flavor = 'cross-network (relay)';
      } else {
        url = `sym://group/${group}`;
        flavor = 'LAN-only (Bonjour)';
      }
      const youRunning = GROUP === group
        ? `You're already on this group — teammates who join will see you.`
        : `You are currently on group "${GROUP}". To be reachable, call sym_join_group with group="${group}" (+ same relay creds if cross-network) before sharing.`;
      return {
        content: [{
          type: 'text',
          text: `Invite URL (${flavor}):\n\n    ${url}\n\n` +
            `Share this URL with teammates. Each pastes it into Claude Code and calls sym_join_group (or sym_invite_info for a dry run first).\n\n` +
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
      const { appScheme, group, serviceType, roomId, roomName, relayUrl, relayToken } = parsed;

      const out = {
        app: appScheme,
        group,
        service_type: serviceType,
        room_id: appScheme === 'sym' ? undefined : roomId,
        room_name: appScheme === 'sym' ? undefined : roomName,
        relay_url: relayUrl || undefined,
        relay_token: relayToken || undefined,
      };
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];

      const joinCall = {
        group,
        ...(relayUrl && { relay_url: relayUrl }),
        ...(relayToken && { relay_token: relayToken }),
      };

      return {
        content: [{
          type: 'text',
          text: `Parsed invite: ${url}\n\n` +
            JSON.stringify(out, null, 2) + `\n\n` +
            `To join, call sym_join_group:\n\n    ${JSON.stringify(joinCall)}\n\n` +
            `This hot-swaps your node into the ${relayUrl ? 'relay channel' : 'LAN group'} — no Claude Code restart needed.`,
        }],
      };
    }

    case 'sym_join_group': {
      const group = args?.group;
      const relayUrl = args?.relay_url || null;
      const relayToken = args?.relay_token || null;
      if (!group || typeof group !== 'string') {
        return { content: [{ type: 'text', text: 'Missing required argument: group' }], isError: true };
      }
      if (!KEBAB_CASE_RE.test(group) && group !== 'default') {
        return {
          content: [{ type: 'text', text: `Invalid group name: "${group}". Must be kebab-case or "default".` }],
          isError: true,
        };
      }

      const newServiceType = group === 'default' ? '_sym._tcp' : `_${group}._tcp`;
      const prevGroup = GROUP;
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
        cognitiveProfile: 'Engineering node. Code, architecture, debugging, technical decisions.',
        svafFieldWeights: FIELD_WEIGHTS,
        svafFreshnessSeconds: 7200,
        discoveryServiceType: newServiceType,
        group,
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
            text: `Failed to start new node on group "${group}": ${e?.message || e}\n\n` +
              `Previous node already stopped. To recover, call sym_join_group with group="${prevGroup}".`,
          }],
          isError: true,
        };
      }

      // Swap module-level references only after successful start.
      node = newNode;
      GROUP = group;
      SERVICE_TYPE = newServiceType;
      RELAY_URL = relayUrl;
      RELAY_TOKEN = relayToken;

      return {
        content: [{
          type: 'text',
          text: `Hot-swapped from group "${prevGroup}" (${prevServiceType}) to "${group}" (${newServiceType}).\n` +
            (relayUrl ? `Relay: ${relayUrl}\n` : '') +
            `Discovering peers on the new service type. Call sym_peers in a moment to see who's online.`,
        }],
      };
    }

    case 'sym_groups_discover': {
      const result = await discoverGroups();
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

// All node.on(...) handlers live in registerNodeHandlers(n) above so the
// hot-swap path in sym_join_group can attach them to a freshly-constructed
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
