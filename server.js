#!/usr/bin/env node
'use strict';

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

const NODE_NAME = process.env.SYM_NODE_NAME || 'claude-code-mac';

const node = new SymNode({
  name: NODE_NAME,
  cognitiveProfile: 'Engineering node. Code, architecture, debugging, technical decisions.',
  svafFieldWeights: FIELD_WEIGHTS,
  svafFreshnessSeconds: 7200, // 2hr — session-length context
  relay: process.env.SYM_RELAY_URL || null,
  relayToken: process.env.SYM_RELAY_TOKEN || null,
  silent: true,
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
      'Search mesh memory via sym_recall.',
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
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'sym_send': {
      const msg = args.message;
      node.send(msg);
      node.remember({
        focus: msg,
        issue: 'none',
        intent: 'inter-node message',
        motivation: 'mesh communication',
        commitment: msg.slice(0, 120),
        perspective: `${NODE_NAME}, direct message`,
        mood: { text: 'neutral', valence: 0, arousal: 0 },
      });
      const peers = node.peers();
      return { content: [{ type: 'text', text: `Message sent to ${peers.length} peer(s).` }] };
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

    case 'sym_status': {
      const s = node.status();
      return {
        content: [{
          type: 'text',
          text: `Node: ${NODE_NAME} (${node.nodeId?.slice(0, 8) || '?'})\n` +
            `Relay: ${s.relayConnected ? 'connected' : 'disconnected'}\n` +
            `Peers: ${s.peerCount || 0}\n` +
            `Memories: ${s.memoryCount || 0}`,
        }],
      };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
});

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
  const focus = entry.cmb?.fields?.focus?.text || entry.content || '';
  const mood = entry.cmb?.fields?.mood?.text || '';
  pushChannel('cmb', `[${source}] ${focus}${mood && mood !== 'neutral' ? ` (mood: ${mood})` : ''}`);
});

node.on('message', (from, content) => {
  pushChannel('message', `[message from ${from}] ${content}`);
});

// Peer presence events are intentionally NOT pushed to Claude's context.
// They're high-frequency, low-signal (peers flap on relay reconnects, daemon
// restarts, NAT keepalive blips), and a flood will eat the context window.
// Use sym_peers / sym_status on demand instead. Only CMBs and direct messages
// are surfaced as channel notifications — those carry actual cognitive payload.

// ── Start ────────────────────────────────────────────────────

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
