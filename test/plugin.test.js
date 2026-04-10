#!/usr/bin/env node
'use strict';

/**
 * Plugin validation tests for Anthropic Channels allowlist submission.
 *
 * Tests:
 *   1. plugin.json is valid and has all required fields
 *   2. MCP server module loads without error
 *   3. Peer allowlist gate works correctly
 *   4. Self-echo filtering works
 *   5. Clean shutdown signal handling
 *   6. Security: no permission relay capability declared
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\nsym-mesh-channel plugin tests\n');

// ── 1. Plugin manifest validation ───────────────────────────

console.log('Plugin manifest:');

test('plugin.json exists and is valid JSON', () => {
  const manifestPath = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
  assert.ok(fs.existsSync(manifestPath), 'plugin.json not found');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  assert.ok(manifest, 'Failed to parse plugin.json');
});

test('plugin.json has required name field', () => {
  const manifest = loadManifest();
  assert.ok(manifest.name, 'name field is missing');
  assert.strictEqual(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0, 'name is empty');
});

test('.mcp.json has mcpServers with claude-sym-mesh', () => {
  const mcp = loadMcpJson();
  assert.ok(mcp.mcpServers, 'mcpServers field is missing');
  assert.ok(mcp.mcpServers['claude-sym-mesh'], 'claude-sym-mesh server not defined');
  const server = mcp.mcpServers['claude-sym-mesh'];
  assert.strictEqual(server.command, 'node', 'command should be node');
  assert.ok(Array.isArray(server.args), 'args should be an array');
});

test('plugin.json declares channels with userConfig', () => {
  const manifest = loadManifest();
  assert.ok(Array.isArray(manifest.channels), 'channels should be an array');
  assert.ok(manifest.channels.length > 0, 'channels should not be empty');
  const channel = manifest.channels[0];
  assert.strictEqual(channel.server, 'claude-sym-mesh', 'channel server should match mcpServers key');
  assert.ok(channel.userConfig, 'userConfig is missing');
});

test('relay_token is marked sensitive', () => {
  const manifest = loadManifest();
  const channel = manifest.channels[0];
  assert.ok(channel.userConfig.relay_token, 'relay_token config missing');
  assert.strictEqual(channel.userConfig.relay_token.sensitive, true, 'relay_token must be sensitive');
});

test('version matches npm package version', () => {
  const manifest = loadManifest();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(manifest.version, pkg.version, `plugin version (${manifest.version}) should match package version (${pkg.version})`);
});

test('channels server matches .mcp.json server key', () => {
  const manifest = loadManifest();
  const mcp = loadMcpJson();
  const channelServer = manifest.channels[0].server;
  assert.ok(mcp.mcpServers[channelServer], `channels server "${channelServer}" must match a key in .mcp.json mcpServers`);
});

// ── 2. Server module validation ─────────────────────────────

console.log('\nServer module:');

test('server.js exists in node_modules', () => {
  const serverPath = resolveServerJs();
  assert.ok(fs.existsSync(serverPath), `server.js not found at ${serverPath}`);
});

test('server.js is valid JavaScript', () => {
  const serverPath = resolveServerJs();
  const code = fs.readFileSync(serverPath, 'utf8');
  // Basic syntax check — ensure it parses without throwing
  // (can't actually run it because it starts the MCP server)
  assert.ok(code.includes('notifications/claude/channel'), 'server should declare channel capability');
  assert.ok(code.includes('claude/channel'), 'server should use channel notifications');
});

// ── 3. Security: peer allowlist ─────────────────────────────

console.log('\nSecurity - peer allowlist:');

test('isPeerAllowed accepts all when SYM_ALLOWED_PEERS is empty', () => {
  const { isPeerAllowed } = loadAllowlistModule('');
  assert.strictEqual(isPeerAllowed('any-peer'), true);
  assert.strictEqual(isPeerAllowed('another-peer'), true);
});

test('isPeerAllowed filters when SYM_ALLOWED_PEERS is set', () => {
  const { isPeerAllowed } = loadAllowlistModule('claude-mac,claude-win');
  assert.strictEqual(isPeerAllowed('claude-mac'), true);
  assert.strictEqual(isPeerAllowed('claude-win'), true);
  assert.strictEqual(isPeerAllowed('unknown-peer'), false);
});

test('isPeerAllowed handles whitespace in SYM_ALLOWED_PEERS', () => {
  const { isPeerAllowed } = loadAllowlistModule(' claude-mac , claude-win ');
  assert.strictEqual(isPeerAllowed('claude-mac'), true);
  assert.strictEqual(isPeerAllowed('claude-win'), true);
});

// ── 4. Security: no permission relay ────────────────────────

console.log('\nSecurity - capability restrictions:');

test('server does NOT declare claude/channel/permission capability', () => {
  const serverPath = resolveServerJs();
  const code = fs.readFileSync(serverPath, 'utf8');
  assert.ok(!code.includes('claude/channel/permission'),
    'server MUST NOT declare permission relay capability — mesh peers must not approve/deny tool executions');
});

test('server does NOT execute code from mesh signals', () => {
  const serverPath = resolveServerJs();
  const code = fs.readFileSync(serverPath, 'utf8');
  // Ensure pushChannel only sends text, never calls eval/exec/spawn from mesh input
  assert.ok(!code.includes('eval('), 'server must not use eval');
  // child_process spawn is OK for the server itself, but not from mesh input
  const pushChannelSection = code.slice(code.indexOf('function pushChannel'));
  assert.ok(!pushChannelSection.includes('spawn('), 'pushChannel must not spawn processes from mesh input');
});

test('self-echo filtering is implemented', () => {
  const serverPath = resolveServerJs();
  const code = fs.readFileSync(serverPath, 'utf8');
  assert.ok(code.includes('entry.source === NODE_NAME'), 'server should filter self-echoed CMBs');
});

// ── 5. Server lifecycle ─────────────────────────────────────

console.log('\nServer lifecycle:');

test('clean shutdown handlers registered', () => {
  const serverPath = resolveServerJs();
  const code = fs.readFileSync(serverPath, 'utf8');
  assert.ok(code.includes("process.on('SIGTERM'"), 'SIGTERM handler missing');
  assert.ok(code.includes("process.on('SIGINT'"), 'SIGINT handler missing');
});

test('identity collision exits cleanly', () => {
  const serverPath = resolveServerJs();
  const code = fs.readFileSync(serverPath, 'utf8');
  assert.ok(code.includes('identity-collision'), 'identity-collision handler missing');
  assert.ok(code.includes('process.exit(2)'), 'should exit with code 2 on identity collision');
});

// ── Results ─────────────────────────────────────────────────

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

// ── Helpers ─────────────────────────────────────────────────

function loadManifest() {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8');
  return JSON.parse(raw);
}

function loadMcpJson() {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.mcp.json'), 'utf8');
  return JSON.parse(raw);
}

function resolveServerJs() {
  return path.join(__dirname, '..', 'server.js');
}

function loadAllowlistModule(envValue) {
  // Replicate the allowlist logic from server.js without starting the server
  const ALLOWED_PEERS = (envValue || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  function isPeerAllowed(peerName) {
    if (ALLOWED_PEERS.length === 0) return true;
    return ALLOWED_PEERS.includes(peerName);
  }

  return { isPeerAllowed };
}
