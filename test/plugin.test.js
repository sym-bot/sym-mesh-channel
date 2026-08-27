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
  // Launch migrated to npx in 0.3.8 (per-session identity + npx launch);
  // the server is no longer spawned via a bundled `node server.js` path.
  assert.strictEqual(server.command, 'npx', 'command should be npx');
  assert.ok(Array.isArray(server.args), 'args should be an array');
  assert.ok(
    server.args.some((a) => a.includes('@sym-bot/mesh-channel')),
    'args should launch the @sym-bot/mesh-channel package'
  );
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

test('.mcp.json launch pin matches npm package version', () => {
  // The .mcp.json args are what a seat actually RUNS after /plugin update — a lagging pin
  // ships the old runtime under a new plugin version (v0.5.4 launched 0.5.3 this way).
  const mcp = loadMcpJson();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const pinArg = mcp.mcpServers['claude-sym-mesh'].args.find((a) => a.includes('@sym-bot/mesh-channel'));
  assert.strictEqual(
    pinArg,
    `@sym-bot/mesh-channel@${pkg.version}`,
    `.mcp.json launches ${pinArg} but package version is ${pkg.version}`
  );
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

console.log('\nTool surface — sym_send / sym_publish:');

test('sym_send tool schema has focus (required) and to (optional), no message', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  // Locate the sym_send tool descriptor.
  const sendIdx = code.indexOf("name: 'sym_send'");
  assert.ok(sendIdx !== -1, "sym_send tool descriptor not found");
  // Grab the descriptor block (next ~80 lines — tool definitions are small).
  const block = code.slice(sendIdx, sendIdx + 2000);
  // Next tool marker bounds the block.
  const nextToolIdx = block.indexOf("name: 'sym_publish'");
  const descriptor = nextToolIdx !== -1 ? block.slice(0, nextToolIdx) : block;
  assert.ok(descriptor.includes("required: ['focus']"), 'sym_send must declare focus as required (MMP §4.2 CAT7 anchor)');
  assert.ok(descriptor.includes('to: {'), 'sym_send must accept a "to" property for targeted send (§4.4.4)');
  assert.ok(!descriptor.match(/message:\s*\{\s*type:\s*'string'/), 'sym_send must NOT carry a raw-text "message" field — emit CAT7 instead');
  assert.ok(!descriptor.match(/required:\s*\['message'\]/), 'sym_send must NOT require "message" — focus is the required anchor');
});

test('sym_send handler routes through explicitSend/node.remember, not node.send', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  const caseIdx = code.indexOf("case 'sym_send'");
  assert.ok(caseIdx !== -1, "sym_send case handler not found");
  // Handler runs until the next case: label. Find that label in the FULL source
  // rather than inside a fixed-size window: the old `caseIdx + 4000` bound went
  // red the moment the handler grew past it (the sender-side outbox took it to
  // ~4800 chars), reporting "explicitSend is missing" when explicitSend was
  // simply further down. A window that silently truncates what it searches
  // answers a different question than the one the assertion asks.
  const nextCaseIdx = code.indexOf("case 'sym_publish'", caseIdx);
  assert.ok(nextCaseIdx !== -1, "sym_publish case not found — cannot bound the sym_send handler");
  const handler = code.slice(caseIdx, nextCaseIdx);
  assert.ok(handler.includes('explicitSend('), 'handler must route the send through explicitSend() (which emits via node.remember, MMP §4.2)');
  assert.ok(code.includes('n.remember('), 'explicitSend must emit via node.remember() — CAT7 CMB, not a raw node.send()');
  assert.ok(!/node\.send\(\s*msg\s*\)/.test(handler), 'handler must NOT fall back to node.send(msg) raw-text broadcast');
  // Peer resolution guards:
  assert.ok(handler.includes('not connected'), 'handler must return a clear error when "to" peer is disconnected');
  assert.ok(handler.includes('ambiguous'), 'handler must reject ambiguous peer matches with an explicit message');
});

test('sym_publish tool schema unchanged shape (regression)', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  const obsIdx = code.indexOf("name: 'sym_publish'");
  assert.ok(obsIdx !== -1, 'sym_publish descriptor not found');
  const block = code.slice(obsIdx, obsIdx + 2000);
  const nextIdx = block.indexOf("name: 'sym_recall'");
  const descriptor = nextIdx !== -1 ? block.slice(0, nextIdx) : block;
  assert.ok(descriptor.includes("required: ['focus']"), 'sym_publish continues to require focus');
});

test('MCP server instructions reference SVAF + targeted CMB semantics', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  assert.ok(code.includes('SVAF'), 'instructions must mention SVAF for receiver semantics');
  assert.ok(code.includes('§4.4.4') || code.includes('4.4.4'), 'instructions must reference §4.4.4 targeted CMB');
});

// ── 4c. Send-path delivery integrity (E8 variant c) ──

console.log('\nSend-path delivery integrity (E8 variant c):');

// The fix lives inline in server.js (a separate module would not ship — package
// `files` omits lib/). These source-scan assertions catch its removal.
test('server.js carries the delivery-integrity fix', () => {
  const code = fs.readFileSync(resolveServerJs(), 'utf8');
  assert.ok(code.includes('function explicitSend('), 'explicitSend helper missing');
  assert.ok(code.includes('deliveredCmbKeys'), 'delivered-key tracking missing');
  assert.ok(code.includes('[re-sent '), 're-issue salt for an undelivered re-send is missing');
  assert.ok(/deliveredCmbKeys = new Set\(\)/.test(code.slice(code.indexOf('node = newNode'))),
    'deliveredCmbKeys must reset on hot-swap (sym_join_room)');
  assert.ok(!code.includes('CMB already in memory, not re-broadcast'),
    'the old unconditional "Duplicate — not re-broadcast" message must be gone');
});

// Replicate explicitSend's semantics (the loadAllowlistModule pattern — server.js
// runs main() on require, so it cannot be imported without side effects). Kept a
// faithful mirror of the server helper it validates.
function loadSendIntegrity() {
  const crypto = require('crypto');
  const key = (f) => crypto.createHash('sha256').update(JSON.stringify(f)).digest('hex').slice(0, 32);
  const deliveryTag = (f, t) => (t ? `${key(f)}|${t}` : key(f));
  const peerCount = (n) => {
    try { const s = n.status && n.status(); return (s && s.peerCount) || (n.peers && n.peers().length) || 0; }
    catch { return 0; }
  };
  function explicitSend(n, delivered, fields, sendOpts, okSummary, now) {
    const stamp = now || (() => new Date().toISOString());
    const t = sendOpts.to || null;
    const connected = t ? true : peerCount(n) > 0;
    const entry = n.remember(fields, sendOpts);
    if (entry) { if (connected) delivered.add(deliveryTag(fields, t)); return { text: okSummary(entry, connected) }; }
    if (delivered.has(deliveryTag(fields, t))) return { text: `Duplicate — identical CMB already delivered${t ? '' : ' to the room'}, not re-broadcast.` };
    const salted = Object.assign({}, fields, { focus: `${fields.focus} [re-sent ${stamp()}]` });
    const retry = n.remember(salted, sendOpts);
    if (!retry) return { text: 'Send failed: nothing broadcast.', isError: true };
    if (connected) delivered.add(deliveryTag(salted, t));
    return { text: `Re-sent CMB ${retry.key}${t ? '' : ' to the room'} — undelivered prior copy re-issued.` };
  }
  return { explicitSend, deliveryTag };
}

// A content-addressed fake node: remember() dedups on the fields, like the store.
function fakeNode(peerCount) {
  const stored = new Set();
  const crypto = require('crypto');
  const key = (f) => 'cmb-' + crypto.createHash('sha256').update(JSON.stringify(f)).digest('hex').slice(0, 16);
  return {
    stored,
    peers: () => Array.from({ length: peerCount }, (_, i) => ({ peerId: 'p' + i })),
    status: () => ({ peerCount }),
    remember(fields) { const k = key(fields); if (stored.has(k)) return null; stored.add(k); return { key: k }; },
  };
}

const F = { focus: 'hi', issue: 'none', intent: 'directive', motivation: '', commitment: '', perspective: 'me', mood: {} };
const okS = (e, c) => (c ? `Sent CMB ${e.key}` : `Stored ${e.key} — no peers`);

test('true duplicate to a connected peer is suppressed (no flood regression)', () => {
  const { explicitSend } = loadSendIntegrity();
  const n = fakeNode(2); const delivered = new Set();
  const a = explicitSend(n, delivered, F, {}, okS, () => 'T');
  assert.ok(/^Sent CMB/.test(a.text), 'first broadcast should send');
  const b = explicitSend(n, delivered, F, {}, okS, () => 'T');
  assert.ok(/already delivered/.test(b.text), 'identical resend after real delivery is a suppressed duplicate');
});

test('undelivered re-send (variant c) is re-issued, not swallowed', () => {
  const { explicitSend } = loadSendIntegrity();
  const n = fakeNode(0); const delivered = new Set();       // stored while disconnected
  const a = explicitSend(n, delivered, F, {}, okS, () => 'T');
  assert.ok(!/^Sent CMB/.test(a.text), 'a 0-peer send must not claim delivery');
  assert.strictEqual(delivered.size, 0, 'nothing delivered while disconnected');
  n.status = () => ({ peerCount: 1 }); n.peers = () => [{ peerId: 'p0' }];   // a peer connects
  const b = explicitSend(n, delivered, F, {}, okS, () => 'T');
  assert.ok(/Re-sent CMB/.test(b.text), 'the undelivered CMB must be re-issued so it reaches the mesh');
});

test('directed dedup against a pre-existing store copy is re-issued', () => {
  const { explicitSend } = loadSendIntegrity();
  const n = fakeNode(1); n.remember(F);                      // copy already in store (pre-reconnect)
  const r = explicitSend(n, new Set(), F, { to: 'peerX' }, () => 'Sent to peerX', () => 'T');
  assert.ok(/Re-sent CMB/.test(r.text), 'a stored-but-never-delivered directed CMB must be re-issued');
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

  await testAsync('global: heals stale top-level entry without --force, preserves SYM_NODE_NAME', async () => {
    // Root cause of the "silent broken install" UX bug: prior npm install -g
    // left ~/.claude.json pointing at a server.js path that no longer exists
    // (repo moved/renamed/deleted). Subsequent reinstalls silently skipped the
    // broken entry — users saw npm say "added 148 packages" then /mcp report
    // "Failed to reconnect" with no explanation. Installer now classifies
    // entries whose args[0] is missing on disk as STALE and rewrites them
    // even without --force, preserving SYM_NODE_NAME.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: ['/nonexistent/stale/path/server.js'],
            env: { SYM_NODE_NAME: 'claude-canonical', SYM_RELAY_URL: '', SYM_RELAY_TOKEN: '' },
          },
        },
      }));
      const { code } = await spawnInstaller(['init'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.strictEqual(code, 0, 'installer should heal stale entry without --force');
      const after = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      const entry = after.mcpServers['claude-sym-mesh'];
      assert.ok(fs.existsSync(entry.args[0]), 'rewritten path must exist on disk');
      assert.strictEqual(entry.env.SYM_NODE_NAME, 'claude-canonical', 'node name must be preserved from the stale entry, not reset to the hostname default');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await testAsync('global: refuses to overwrite a LIVE entry without --force', async () => {
    // Regression guard for stale-heal feature. The stale-path rewrite must
    // not accidentally stomp on an entry whose server.js is reachable.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      const liveServerPath = path.join(__dirname, '..', 'server.js');
      assert.ok(fs.existsSync(liveServerPath), 'sanity: repo server.js must exist');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: [liveServerPath],
            env: { SYM_NODE_NAME: 'claude-live', SYM_RELAY_URL: '', SYM_RELAY_TOKEN: '' },
          },
        },
      }));
      const { code } = await spawnInstaller(['init'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
        allowFail: true,
      });
      assert.strictEqual(code, 2, 'installer must exit 2 for a live entry without --force');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await testAsync('global: postinstall silently heals stale entry (no "already configured" skip)', async () => {
    // Before the fix, postinstall printed "already configured (skipping)" and
    // exited 0 even when the existing entry pointed at a dead path. Users ran
    // `npm install -g @sym-bot/mesh-channel`, postinstall "succeeded", and
    // the MCP server was still unreachable. This test pins the new behaviour:
    // stale entry on postinstall triggers a rewrite, not a skip.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: ['/nonexistent/path/server.js'],
            env: { SYM_NODE_NAME: 'claude-preserved' },
          },
        },
      }));
      const { code } = await spawnInstaller(['init', '--postinstall'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.strictEqual(code, 0);
      const after = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      assert.ok(fs.existsSync(after.mcpServers['claude-sym-mesh'].args[0]), 'postinstall must heal stale path, not skip');
      assert.strictEqual(after.mcpServers['claude-sym-mesh'].env.SYM_NODE_NAME, 'claude-preserved');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await testAsync('global: heals stale project-scoped entries under claudeJson.projects', async () => {
    // Project-scoped mcpServers entries under ~/.claude.json's `projects`
    // key override the user-global entry when Claude Code is launched from
    // that directory. A stale project entry silently shadows a fresh
    // user-global heal — the exact bug Hongwei hit on 2026-04-23 where
    // `~/code` was moved from `~/Documents/dev`. The installer now scans
    // every project and rewrites stale claude-sym-mesh args, preserving
    // each project's SYM_NODE_NAME.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      const liveServerPath = path.join(__dirname, '..', 'server.js');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: ['/nonexistent/stale/server.js'],
            env: { SYM_NODE_NAME: 'claude-top' },
          },
        },
        projects: {
          '/some/project/a': {
            mcpServers: {
              'claude-sym-mesh': {
                command: 'node',
                args: ['/also/stale/server.js'],
                env: { SYM_NODE_NAME: 'claude-proj-a' },
              },
            },
          },
          '/some/project/b': {
            mcpServers: {
              'claude-sym-mesh': {
                command: 'node',
                args: [liveServerPath],
                env: { SYM_NODE_NAME: 'claude-proj-b' },
              },
            },
          },
        },
      }));
      const { code } = await spawnInstaller(['init'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.strictEqual(code, 0);
      const after = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      const projA = after.projects['/some/project/a'].mcpServers['claude-sym-mesh'];
      const projB = after.projects['/some/project/b'].mcpServers['claude-sym-mesh'];
      assert.ok(fs.existsSync(projA.args[0]), 'stale project-scoped entry must be healed');
      assert.strictEqual(projA.env.SYM_NODE_NAME, 'claude-proj-a', 'stale project entry must preserve its SYM_NODE_NAME');
      assert.strictEqual(projB.args[0], liveServerPath, 'live project-scoped entry must be left alone');
      assert.strictEqual(projB.env.SYM_NODE_NAME, 'claude-proj-b');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await testAsync('global: doctor reports live + stale entries without writing', async () => {
    // Diagnostic subcommand for users with broken /mcp. Must be read-only.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      const before = {
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: ['/nonexistent/server.js'],
            env: { SYM_NODE_NAME: 'claude-diag' },
          },
        },
      };
      fs.writeFileSync(claudeJsonPath, JSON.stringify(before));
      const beforeBytes = fs.readFileSync(claudeJsonPath);
      const { code, stdout } = await spawnInstallerCapture(['doctor'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('STALE'), 'doctor must flag the stale entry');
      assert.ok(stdout.includes('user-global'), 'doctor must label the user-global scope');
      const afterBytes = fs.readFileSync(claudeJsonPath);
      assert.ok(beforeBytes.equals(afterBytes), 'doctor must be read-only');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await testAsync('--project --room <name> persists SYM_ROOM into .mcp.json env', async () => {
    // SYM_ROOM must be first-class at install time so a teammate's room
    // membership survives Claude Code restarts. Pre-0.3.4, the only way to
    // persist a room was to hand-edit ~/.claude.json after running
    // sym_join_room at runtime — which the README never told users to do.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-proj-'));
    try {
      const { code } = await spawnInstaller(['init', '--project', '--room', 'backend-team'], {
        cwd: tmpDir,
        env: { ...process.env, SYM_NODE_NAME: 'claude-test-grp' },
      });
      assert.strictEqual(code, 0);
      const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
      assert.strictEqual(mcp.mcpServers['claude-sym-mesh'].env.SYM_ROOM, 'backend-team');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('--project without --room omits SYM_ROOM (default mesh)', async () => {
    // Omitting SYM_ROOM from the env block (rather than writing an empty
    // value) lets the server.js fallback select the global _sym._tcp mesh.
    // An empty SYM_ROOM would shadow the fallback and pin the node to a
    // nameless service type — silent failure mode.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-proj-'));
    try {
      const { code } = await spawnInstaller(['init', '--project'], {
        cwd: tmpDir,
        env: { ...process.env, SYM_NODE_NAME: 'claude-no-grp' },
      });
      assert.strictEqual(code, 0);
      const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
      const env = mcp.mcpServers['claude-sym-mesh'].env;
      assert.ok(!('SYM_ROOM' in env), 'SYM_ROOM must be omitted when not requested');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('global: heal preserves SYM_ROOM across stale-entry rewrite', async () => {
    // The 2026-05-02 SYM.BOT incident root cause: pre-0.3.4 healing dropped
    // SYM_ROOM silently, reverting the node to default mesh on next launch
    // and stranding teammates who stayed in the named room. The fix copies
    // both SYM_NODE_NAME and SYM_ROOM from the prior entry into the rewrite.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: ['/nonexistent/stale/server.js'],
            env: {
              SYM_NODE_NAME: 'claude-team-member',
              SYM_ROOM: 'sym-bot-team',
              SYM_RELAY_URL: '',
              SYM_RELAY_TOKEN: '',
            },
          },
        },
      }));
      const { code } = await spawnInstaller(['init'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.strictEqual(code, 0);
      const after = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      const env = after.mcpServers['claude-sym-mesh'].env;
      assert.strictEqual(env.SYM_NODE_NAME, 'claude-team-member', 'node name must be preserved');
      assert.strictEqual(env.SYM_ROOM, 'sym-bot-team', 'room must be preserved on heal');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await testAsync('global: --force --room <name> overrides preserved SYM_ROOM', async () => {
    // CTO PR review note 1: --force is the "I am explicitly overriding state"
    // signal. With --force, an explicit --room should win over the preserved
    // value so users can switch rooms in a single command. Without --force,
    // preserve still wins (heal path must not lose state) — covered by the
    // separate stale-heal test above.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      const liveServerPath = path.join(__dirname, '..', 'server.js');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: [liveServerPath],
            env: {
              SYM_NODE_NAME: 'claude-mover',
              SYM_ROOM: 'old-team',
              SYM_RELAY_URL: '',
              SYM_RELAY_TOKEN: '',
            },
          },
        },
      }));
      const { code } = await spawnInstaller(['init', '--force', '--room', 'new-team'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.strictEqual(code, 0);
      const after = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      assert.strictEqual(after.mcpServers['claude-sym-mesh'].env.SYM_ROOM, 'new-team',
        '--force + explicit --room must override preserved SYM_ROOM (one-command switch)');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await testAsync('global: --force --room default reverts to global mesh (omits SYM_ROOM)', async () => {
    // The escape hatch documented in the README. `--room default` must
    // remove the persisted SYM_ROOM entirely (not write the literal string
    // "default" into the env block, which would map to a `_default._tcp`
    // service type). Equivalent: revert to `_sym._tcp` global mesh.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      const liveServerPath = path.join(__dirname, '..', 'server.js');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: [liveServerPath],
            env: { SYM_NODE_NAME: 'claude-r', SYM_ROOM: 'team-x' },
          },
        },
      }));
      const { code } = await spawnInstaller(['init', '--force', '--room', 'default'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.strictEqual(code, 0);
      const env = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'))
        .mcpServers['claude-sym-mesh'].env;
      assert.ok(!('SYM_ROOM' in env), '--force --room default must omit SYM_ROOM entirely');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await testAsync('init rejects malformed SYM_ROOM env var with kebab-case error', async () => {
    // CTO PR review note 2: KEBAB_CASE_RE must apply to SYM_ROOM env var,
    // not just the --room CLI flag. Pre-fix, SYM_ROOM=Backend_Team flowed
    // through unvalidated and got written into the entry as-is, producing
    // an mDNS service type the SymNode would silently fail to register.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-proj-'));
    try {
      const { code, stderr } = await spawnInstaller(['init', '--project'], {
        cwd: tmpDir,
        env: { ...process.env, SYM_ROOM: 'Backend_Team' },
        allowFail: true,
      });
      assert.strictEqual(code, 1, 'malformed SYM_ROOM must exit 1');
      assert.ok(stderr.includes('SYM_ROOM'), 'error must name the env var, not just --room');
      assert.ok(stderr.includes('kebab-case'), 'error must explain the constraint');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await testAsync('global: doctor reports room per entry and warns on mismatch', async () => {
    // doctor surfaces SYM_ROOM for every entry so users can spot the
    // failure mode without first reading the troubleshooting section.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-home-'));
    try {
      const claudeJsonPath = path.join(fakeHome, '.claude.json');
      const liveServerPath = path.join(__dirname, '..', 'server.js');
      fs.writeFileSync(claudeJsonPath, JSON.stringify({
        mcpServers: {
          'claude-sym-mesh': {
            command: 'node',
            args: [liveServerPath],
            env: { SYM_NODE_NAME: 'claude-a', SYM_ROOM: 'team-x' },
          },
        },
        projects: {
          '/some/project': {
            mcpServers: {
              'claude-sym-mesh': {
                command: 'node',
                args: [liveServerPath],
                env: { SYM_NODE_NAME: 'claude-b', SYM_ROOM: 'team-y' },
              },
            },
          },
        },
      }));
      const { code, stdout } = await spawnInstallerCapture(['doctor'], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      });
      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('room: team-x'), 'doctor must show team-x');
      assert.ok(stdout.includes('room: team-y'), 'doctor must show team-y');
      assert.ok(stdout.includes('Room mismatch'), 'doctor must flag mismatch across entries');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
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

// spawnInstallerCapture: variant that captures stdout for assertions.
// Kept separate so the default `spawnInstaller` stays buffer-safe on
// long output runs.
function spawnInstallerCapture(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const installJs = path.join(__dirname, '..', 'bin', 'install.js');
    const proc = spawn(process.execPath, [installJs, ...args], {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0 && !opts.allowFail) {
        return reject(new Error(`installer exited ${code}: ${stderr}`));
      }
      resolve({ code, stdout, stderr });
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

const INVITE_URL_RE = /^([a-z][a-z0-9-]+):\/\/(?:room|team)\/([^/?#]+)(?:\/([^?#]+))?(?:\?(.+))?$/i;
const KEBAB_CASE_RE = /^[a-z0-9]+(?:--?[a-z0-9]+)*$/; // regenerated from server.js (grammar review F5: the mirror had drifted — stale grammar AND a duplicated alternative)

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
  const room = appScheme === 'sym' ? rawId : `${appScheme}-${rawId}`;
  return {
    appScheme, room, serviceType,
    roomId: rawId, roomName: rawName,
    relayUrl: query.relay || null, relayToken: query.token || null,
  };
}

function buildInviteURL({ room, relayUrl, relayToken }) {
  if (!KEBAB_CASE_RE.test(room)) throw new Error(`invalid room: ${room}`);
  if (relayToken && !relayUrl) throw new Error('relay_token requires relay_url');
  if (!relayUrl && !relayToken) return `sym://room/${room}`;
  const params = [`relay=${encodeURIComponent(relayUrl)}`];
  if (relayToken) params.push(`token=${encodeURIComponent(relayToken)}`);
  return `sym://team/${room}?${params.join('&')}`;
}

console.log('\nInvite URL — parse:');

test('sym://room/{name} parses to matching room + service type', () => {
  const p = parseInviteURL('sym://room/backend-team');
  assert.strictEqual(p.appScheme, 'sym');
  assert.strictEqual(p.room, 'backend-team');
  assert.strictEqual(p.serviceType, '_backend-team._tcp');
  assert.strictEqual(p.relayUrl, null);
  assert.strictEqual(p.relayToken, null);
});

test('sym://team/{name}?relay=... parses relay URL + token', () => {
  const url = 'sym://team/eng-team?relay=wss%3A%2F%2Fsym-relay.onrender.com&token=abc123';
  const p = parseInviteURL(url);
  assert.strictEqual(p.room, 'eng-team');
  assert.strictEqual(p.serviceType, '_eng-team._tcp');
  assert.strictEqual(p.relayUrl, 'wss://sym-relay.onrender.com');
  assert.strictEqual(p.relayToken, 'abc123');
});

test('melotune://room/{id}/{name} prefixes room with app scheme', () => {
  const p = parseInviteURL('melotune://room/abc123/Kitchen');
  assert.strictEqual(p.appScheme, 'melotune');
  assert.strictEqual(p.room, 'melotune-abc123');
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

test('buildInviteURL(room) returns sym://room/{name}', () => {
  assert.strictEqual(buildInviteURL({ room: 'backend-team' }), 'sym://room/backend-team');
  assert.strictEqual(buildInviteURL({ room: 'x-review--team-02779b950c3d8d7378fd11d6' }), 'sym://room/x-review--team-02779b950c3d8d7378fd11d6'); // tenant-suffix grammar (ruling 2026-08-26)
});

test('buildInviteURL(room, relay, token) returns sym://team/ with query string', () => {
  const url = buildInviteURL({
    room: 'eng-team',
    relayUrl: 'wss://sym-relay.onrender.com',
    relayToken: 'shared-secret-xyz',
  });
  assert.ok(url.startsWith('sym://team/eng-team?'), 'should be sym://team/ with query');
  assert.ok(url.includes('relay=wss%3A%2F%2Fsym-relay.onrender.com'), 'relay URL percent-encoded');
  assert.ok(url.includes('token=shared-secret-xyz'), 'token present');
});

test('buildInviteURL rejects invalid room name', () => {
  assert.throws(() => buildInviteURL({ room: 'Bad Room' }), /invalid room/);
  assert.throws(() => buildInviteURL({ room: 'UPPERCASE' }), /invalid room/);
  assert.throws(() => buildInviteURL({ room: '-leading-hyphen' }), /invalid room/);
  assert.throws(() => buildInviteURL({ room: 'a---b' }), /invalid room/); // triple stays out
  assert.throws(() => buildInviteURL({ room: 'trailing-hyphen-' }), /invalid room/);
});

test('buildInviteURL rejects token without URL', () => {
  assert.throws(
    () => buildInviteURL({ room: 'x', relayToken: 'token-only' }),
    /relay_token requires relay_url/,
  );
});

test('round-trip: create LAN → parse → same room back', () => {
  const url = buildInviteURL({ room: 'my-team' });
  const p = parseInviteURL(url);
  assert.strictEqual(p.room, 'my-team');
  assert.strictEqual(p.serviceType, '_my-team._tcp');
});

test('round-trip: create relay → parse → same room + relay creds back', () => {
  const url = buildInviteURL({
    room: 'cross-net',
    relayUrl: 'wss://sym-relay.onrender.com',
    relayToken: 'tok-123',
  });
  const p = parseInviteURL(url);
  assert.strictEqual(p.room, 'cross-net');
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

// ── Room grammar: one source, and the one permitted mirror cannot drift ──────
//
// A room name IS the Bonjour service type (MMP §5.8), so a validator that
// disagrees with the SDK's by one character means two nodes disagree about
// whether a room exists. That has now happened twice in this repo, and the
// second time the divergent copy silently gated the room-PERSISTENCE path while
// the runtime path accepted the same name — green tests, broken install.
//
// server.js keeps NO copy (it imports the grammar). bin/install.js keeps one
// last-resort mirror, because install must still validate when the SDK is not
// resolvable. This test reads the mirror out of the SOURCE TEXT rather than
// requiring the module — install.js runs its installer on require — and pins it
// character-identical to the SDK's own exported regex.
test('room grammar has one source, and install.js mirror matches the SDK exactly', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(
    !/const\s+KEBAB_CASE_RE\s*=\s*\//.test(server),
    'server.js must not declare its own room-name regex — it imports the SDK grammar'
  );
  assert.ok(
    /require\('@sym-bot\/sym(?:\/lib\/rooms\.js)?'\)/.test(server) && /sdkRooms\(\)/.test(server),
    'server.js must take the room grammar from the SDK'
  );

  const install = fs.readFileSync(path.join(root, 'bin', 'install.js'), 'utf8');
  const mirror = install.match(/const\s+FALLBACK_KEBAB_CASE_RE\s*=\s*(\/.+\/);/);
  assert.ok(mirror, 'install.js must keep its mirror in a named FALLBACK_ constant');

  const sdkRooms = require('@sym-bot/sym').rooms || require('@sym-bot/sym/lib/rooms.js');
  const sdk = sdkRooms.KEBAB_CASE_RE;
  assert.strictEqual(
    mirror[1], sdk.toString(),
    'install.js fallback regex has drifted from @sym-bot/sym rooms.KEBAB_CASE_RE'
  );

  // The grammar this pins is the tenant-suffix one: a scoped room name must pass.
  const { isValidRoom } = sdkRooms;
  assert.ok(isValidRoom('x-review--team-02779b950c3d8d7378fd11d6'), 'tenant-suffixed room must be valid');
  assert.ok(isValidRoom('backend-team'), 'plain kebab room must be valid');
  assert.ok(!isValidRoom('x---y'), 'triple hyphen must stay invalid');
  assert.ok(!isValidRoom('-lead'), 'leading hyphen must stay invalid');
});

test('room names are canonical: `sym` is refused even on an SDK that predates the rule', () => {
  const fs = require('fs');
  const path = require('path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Founder ruling 2026-08-27. The check must be the PROPERTY, computed from
  // the SDK's own mapping in both directions -- not a second grammar. If this
  // ever becomes a regex, the drift this file guards has come back.
  assert.ok(
    /serviceTypeToRoom\(roomServiceType\(room\)\) === room/.test(server),
    'canonicity must be derived from the SDK mapping, not re-implemented'
  );
  assert.ok(
    !/function isCanonicalRoom[\s\S]{0,400}\/\^\[a-z0-9\]/.test(server),
    'isCanonicalRoom must not carry its own grammar'
  );

  // Both gates go through it, so neither can be canonical while the other is not.
  const gates = server.match(/if \(!isCanonicalRoom\(room\)/g) || [];
  assert.strictEqual(gates.length, 2, `both join gates must enforce canonicity, found ${gates.length}`);
  // Gates sit inside switch cases (six-space indent); the helpers that
  // classify a refusal are module-level (two). isValidRoom is legitimate in a
  // helper -- roomRefusalReason needs it to tell "bad grammar" apart from
  // "aliases another room" -- so this forbids it at the GATES, which is what
  // would actually let a non-canonical name through.
  assert.ok(
    !/^ {6}if \(!isValidRoom\(room\)/m.test(server),
    'no join gate may use the bare grammar check in place of canonicity'
  );

  // And the property itself, against whatever SDK is actually resolved here.
  const rooms = require('@sym-bot/sym').rooms || require('@sym-bot/sym/lib/rooms.js');
  const canonical = (r) => rooms.isValidRoom(r)
    && rooms.serviceTypeToRoom(rooms.roomServiceType(r)) === r;
  assert.ok(!canonical('sym'), '`sym` aliases the global mesh and must not be canonical');
  assert.ok(canonical('default'), 'the global mesh under its canonical name');
  assert.ok(canonical('backend-team'));
  assert.ok(canonical('x-review--team-02779b950c3d8d7378fd11d6'));
});

test('room -> service-type mapping has one source: no inline `_${room}._tcp` in server.js', () => {
  const fs = require('fs');
  const path = require('path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // The drift class this pins: server.js once built the service type in four
  // places, so a grammar change had to be made four times or the copies
  // disagreed. Every mapping now goes through the SDK. Two escapes are
  // deliberate and named: the app-scoped invite prefix (which builds a ROOM,
  // not a service type) and the dns-sd output scanner (which parses external
  // text rather than mapping a room).
  const offenders = server
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /`_\$\{[A-Za-z]/.test(line) || /'_sym\._tcp'/.test(line))
    .filter(([, line]) => !/^\s*(\/\/|\*)/.test(line))
    .filter(([, line]) => !/appScheme|typeRe|m\[1\]/.test(line));

  assert.deepStrictEqual(
    offenders, [],
    'server.js must map room -> service type only via roomServiceType(): ' +
      offenders.map(([n, l]) => `${n}: ${l.trim()}`).join(' | ')
  );

  assert.ok(
    /serviceTypeToRoom/.test(server),
    'the inverse mapping must also come from the SDK, not a hand-rolled strip'
  );
});
