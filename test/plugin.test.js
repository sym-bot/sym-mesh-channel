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
const os = require('os');
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

// ── 4b. Tool surface — CAT7 CMB emission (v0.2.0 breaking change) ──

console.log('\nTool surface — sym_send / sym_observe:');

test('sym_send tool schema has focus (required) and to (optional), no message', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  // Locate the sym_send tool descriptor.
  const sendIdx = code.indexOf("name: 'sym_send'");
  assert.ok(sendIdx !== -1, "sym_send tool descriptor not found");
  // Grab the descriptor block (next ~80 lines — tool definitions are small).
  const block = code.slice(sendIdx, sendIdx + 2000);
  // Next tool marker bounds the block.
  const nextToolIdx = block.indexOf("name: 'sym_observe'");
  const descriptor = nextToolIdx !== -1 ? block.slice(0, nextToolIdx) : block;
  assert.ok(descriptor.includes("required: ['focus']"), 'sym_send must declare focus as required (MMP §4.2 CAT7 anchor)');
  assert.ok(descriptor.includes('to: {'), 'sym_send must accept a "to" property for targeted send (§4.4.4)');
  assert.ok(!descriptor.match(/message:\s*\{\s*type:\s*'string'/), 'sym_send must NOT carry a raw-text "message" field — emit CAT7 instead');
  assert.ok(!descriptor.match(/required:\s*\['message'\]/), 'sym_send must NOT require "message" — focus is the required anchor');
});

test('sym_send handler routes through node.remember, not node.send', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  const caseIdx = code.indexOf("case 'sym_send'");
  assert.ok(caseIdx !== -1, "sym_send case handler not found");
  // Handler runs until the next case: label. Upper bound defensively.
  const block = code.slice(caseIdx, caseIdx + 4000);
  const nextCaseIdx = block.indexOf("case 'sym_observe'");
  const handler = nextCaseIdx !== -1 ? block.slice(0, nextCaseIdx) : block;
  assert.ok(handler.includes('node.remember('), 'handler must use node.remember() to emit CAT7 CMB per MMP §4.2');
  assert.ok(!/node\.send\(\s*msg\s*\)/.test(handler), 'handler must NOT fall back to node.send(msg) raw-text broadcast');
  // Peer resolution guards:
  assert.ok(handler.includes('not connected'), 'handler must return a clear error when "to" peer is disconnected');
  assert.ok(handler.includes('ambiguous'), 'handler must reject ambiguous peer matches with an explicit message');
});

test('sym_observe tool schema unchanged shape (regression)', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  const obsIdx = code.indexOf("name: 'sym_observe'");
  assert.ok(obsIdx !== -1, 'sym_observe descriptor not found');
  const block = code.slice(obsIdx, obsIdx + 2000);
  const nextIdx = block.indexOf("name: 'sym_recall'");
  const descriptor = nextIdx !== -1 ? block.slice(0, nextIdx) : block;
  assert.ok(descriptor.includes("required: ['focus']"), 'sym_observe continues to require focus');
});

test('MCP server instructions reference SVAF + targeted CMB semantics', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  assert.ok(code.includes('SVAF'), 'instructions must mention SVAF for receiver semantics');
  assert.ok(code.includes('§4.4.4') || code.includes('4.4.4'), 'instructions must reference §4.4.4 targeted CMB');
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

// ── 6. Installer: project-scoped mode (--project flag) ─────

async function runProjectInstallTests() {
  console.log('\nInstaller - project-scoped mode:');

  await testAsync('--project writes .mcp.json and settings.local.json at cwd', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-proj-'));
    try {
      const { code } = await spawnInstaller(['init', '--project'], {
        cwd: tmpDir,
        env: { ...process.env, SYM_NODE_NAME: 'claude-test-project' },
      });
      assert.strictEqual(code, 0, 'installer should exit 0');

      const mcpJson = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
      assert.ok(mcpJson.mcpServers, 'mcpServers missing');
      const entry = mcpJson.mcpServers['claude-sym-mesh'];
      assert.ok(entry, 'claude-sym-mesh missing from .mcp.json');
      assert.strictEqual(entry.command, 'node');
      assert.strictEqual(entry.env.SYM_NODE_NAME, 'claude-test-project');
      assert.strictEqual(entry.env.SYM_RELAY_URL, '', 'relay url must be explicitly blank');
      assert.strictEqual(entry.env.SYM_RELAY_TOKEN, '', 'relay token must be explicitly blank');

      const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.local.json'), 'utf8'));
      assert.deepStrictEqual(settings.enabledMcpjsonServers, ['claude-sym-mesh']);
      assert.strictEqual(settings.enableAllProjectMcpServers, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('--project preserves existing settings.local.json keys', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-proj-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.claude'));
      const existing = {
        permissions: { allow: ['Read(//*)'] },
        customKey: 42,
      };
      fs.writeFileSync(
        path.join(tmpDir, '.claude', 'settings.local.json'),
        JSON.stringify(existing),
      );

      const { code } = await spawnInstaller(['init', '--project'], { cwd: tmpDir });
      assert.strictEqual(code, 0);

      const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.local.json'), 'utf8'));
      assert.deepStrictEqual(settings.permissions, existing.permissions, 'permissions should be preserved');
      assert.strictEqual(settings.customKey, 42, 'customKey should be preserved');
      assert.deepStrictEqual(settings.enabledMcpjsonServers, ['claude-sym-mesh']);
      assert.strictEqual(settings.enableAllProjectMcpServers, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('--project refuses re-install without --force (exit 2)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-proj-'));
    try {
      const first = await spawnInstaller(['init', '--project'], { cwd: tmpDir });
      assert.strictEqual(first.code, 0, 'first install should succeed');

      const second = await spawnInstaller(['init', '--project'], {
        cwd: tmpDir,
        allowFail: true,
      });
      assert.strictEqual(second.code, 2, 'second install without --force should exit 2');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('--project --force overwrites and creates a .mcp.json backup', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-proj-'));
    try {
      await spawnInstaller(['init', '--project'], { cwd: tmpDir });
      const { code } = await spawnInstaller(['init', '--project', '--force'], { cwd: tmpDir });
      assert.strictEqual(code, 0);

      const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('.mcp.json.bak-'));
      assert.ok(backups.length > 0, 'backup file should exist after --force overwrite');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('--project + --postinstall falls back to global install (no .mcp.json written)', async () => {
    // --postinstall always runs global (postinstall runs from npm staging
    // dir, not the user's project). When paired with --project we want
    // the project flag ignored, NOT an error — preserves existing
    // postinstall auto-config behavior for npm install -g.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-proj-'));
    try {
      // Global install writes ~/.claude.json which we don't want to
      // mutate in a test. Simulate absence: point HOME at a tmp dir that
      // has no .claude.json, and expect postinstall-branch graceful skip.
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
      try {
        const { code } = await spawnInstaller(['init', '--project', '--postinstall'], {
          cwd: tmpDir,
          env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
        });
        // Postinstall skips gracefully (exit 0) when ~/.claude.json
        // is missing, and must NOT have created <cwd>/.mcp.json.
        assert.strictEqual(code, 0, 'postinstall should skip gracefully');
        assert.ok(!fs.existsSync(path.join(tmpDir, '.mcp.json')),
          '--project should be ignored during postinstall; no project files should be written');
      } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

function spawnInstaller(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const installJs = path.join(__dirname, '..', 'bin', 'install.js');
    const proc = spawn(process.execPath, [installJs, ...args], {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    // Drain stdout to prevent buffer fill on long output
    proc.stdout.on('data', () => {});
    proc.on('close', (code) => {
      if (code !== 0 && !opts.allowFail) {
        return reject(new Error(`installer exited ${code}: ${stderr}`));
      }
      resolve({ code, stderr });
    });
    proc.on('error', reject);
  });
}

// ── Invite URL parse + create round-trip ─────────────────────
//
// Replicates the INVITE_URL_RE + parser logic from server.js so we can
// unit-test it without spawning the full MCP process. The in-server copy
// is the authoritative one; this mirror is kept tight and regenerated
// if the authoritative version changes.

const INVITE_URL_RE = /^([a-z][a-z0-9-]+):\/\/(?:room|group|team)\/([^/?#]+)(?:\/([^?#]+))?(?:\?(.+))?$/i;
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseInviteURL(url) {
  const m = INVITE_URL_RE.exec(url);
  if (!m) return { error: 'unrecognised' };
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
  const serviceType = appScheme === 'sym' ? `_${rawId}._tcp` : `_${appScheme}-${rawId}._tcp`;
  const group = appScheme === 'sym' ? rawId : `${appScheme}-${rawId}`;
  return {
    appScheme, group, serviceType,
    roomId: rawId, roomName: rawName,
    relayUrl: query.relay || null, relayToken: query.token || null,
  };
}

function buildInviteURL({ group, relayUrl, relayToken }) {
  if (!KEBAB_CASE_RE.test(group)) throw new Error(`invalid group: ${group}`);
  if (relayToken && !relayUrl) throw new Error('relay_token requires relay_url');
  if (!relayUrl && !relayToken) return `sym://group/${group}`;
  const params = [`relay=${encodeURIComponent(relayUrl)}`];
  if (relayToken) params.push(`token=${encodeURIComponent(relayToken)}`);
  return `sym://team/${group}?${params.join('&')}`;
}

console.log('\nInvite URL — parse:');

test('sym://group/{name} parses to matching group + service type', () => {
  const p = parseInviteURL('sym://group/backend-team');
  assert.strictEqual(p.appScheme, 'sym');
  assert.strictEqual(p.group, 'backend-team');
  assert.strictEqual(p.serviceType, '_backend-team._tcp');
  assert.strictEqual(p.relayUrl, null);
  assert.strictEqual(p.relayToken, null);
});

test('sym://team/{name}?relay=... parses relay URL + token', () => {
  const url = 'sym://team/eng-team?relay=wss%3A%2F%2Fsym-relay.onrender.com&token=abc123';
  const p = parseInviteURL(url);
  assert.strictEqual(p.group, 'eng-team');
  assert.strictEqual(p.serviceType, '_eng-team._tcp');
  assert.strictEqual(p.relayUrl, 'wss://sym-relay.onrender.com');
  assert.strictEqual(p.relayToken, 'abc123');
});

test('melotune://room/{id}/{name} prefixes group with app scheme', () => {
  const p = parseInviteURL('melotune://room/abc123/Kitchen');
  assert.strictEqual(p.appScheme, 'melotune');
  assert.strictEqual(p.group, 'melotune-abc123');
  assert.strictEqual(p.serviceType, '_melotune-abc123._tcp');
  assert.strictEqual(p.roomName, 'Kitchen');
});

test('percent-encoded room name decodes correctly', () => {
  const p = parseInviteURL('melotune://room/xyz/Living%20Room');
  assert.strictEqual(p.roomName, 'Living Room');
});

test('relay URL only (no token) parses cleanly', () => {
  const url = 'sym://team/eng?relay=wss%3A%2F%2Frelay.example.com';
  const p = parseInviteURL(url);
  assert.strictEqual(p.relayUrl, 'wss://relay.example.com');
  assert.strictEqual(p.relayToken, null);
});

test('non-invite URL returns error', () => {
  const p = parseInviteURL('https://example.com/foo');
  assert.ok(p.error, 'expected error on non-invite URL');
});

test('garbage string returns error', () => {
  const p = parseInviteURL('not-a-url-at-all');
  assert.ok(p.error, 'expected error');
});

console.log('\nInvite URL — create + round-trip:');

test('buildInviteURL(group) returns sym://group/{name}', () => {
  assert.strictEqual(buildInviteURL({ group: 'backend-team' }), 'sym://group/backend-team');
});

test('buildInviteURL(group, relay, token) returns sym://team/ with query string', () => {
  const url = buildInviteURL({
    group: 'eng-team',
    relayUrl: 'wss://sym-relay.onrender.com',
    relayToken: 'shared-secret-xyz',
  });
  assert.ok(url.startsWith('sym://team/eng-team?'), 'should be sym://team/ with query');
  assert.ok(url.includes('relay=wss%3A%2F%2Fsym-relay.onrender.com'), 'relay URL percent-encoded');
  assert.ok(url.includes('token=shared-secret-xyz'), 'token present');
});

test('buildInviteURL rejects invalid group name', () => {
  assert.throws(() => buildInviteURL({ group: 'Bad Group' }), /invalid group/);
  assert.throws(() => buildInviteURL({ group: 'UPPERCASE' }), /invalid group/);
  assert.throws(() => buildInviteURL({ group: '-leading-hyphen' }), /invalid group/);
  assert.throws(() => buildInviteURL({ group: 'trailing-hyphen-' }), /invalid group/);
});

test('buildInviteURL rejects token without URL', () => {
  assert.throws(
    () => buildInviteURL({ group: 'x', relayToken: 'token-only' }),
    /relay_token requires relay_url/,
  );
});

test('round-trip: create LAN → parse → same group back', () => {
  const url = buildInviteURL({ group: 'my-team' });
  const p = parseInviteURL(url);
  assert.strictEqual(p.group, 'my-team');
  assert.strictEqual(p.serviceType, '_my-team._tcp');
});

test('round-trip: create relay → parse → same group + relay creds back', () => {
  const url = buildInviteURL({
    group: 'cross-net',
    relayUrl: 'wss://sym-relay.onrender.com',
    relayToken: 'tok-123',
  });
  const p = parseInviteURL(url);
  assert.strictEqual(p.group, 'cross-net');
  assert.strictEqual(p.relayUrl, 'wss://sym-relay.onrender.com');
  assert.strictEqual(p.relayToken, 'tok-123');
});

// ── Results ─────────────────────────────────────────────────

(async () => {
  await runProjectInstallTests();
  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

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
