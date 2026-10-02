'use strict';

/**
 * Test harness: a sandboxed state root, a real MCP session over stdio against server.js, a loopback
 * fake relay that routes envelopes between nodes (so two servers meet through the real Core Secure
 * handshake without touching the LAN), and an in-memory pipe for in-process SymNodes.
 *
 * SANDBOX FIRST. Requiring this file moves HOME, USERPROFILE and SYM_STATE_DIR into a temp dir
 * unless they already are in one (test/run.js sets them for every file), and refuses to go on if
 * they are not: no test may write an identity, a key or a store into the real ~/.sym.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.realpathSync(os.tmpdir());
const within = (p) => { try { const r = fs.realpathSync(p); return r === TMP || r.startsWith(TMP + path.sep); } catch { return false; } };

function ensureSandbox() {
  if (!process.env.HOME || !within(process.env.HOME) || !process.env.SYM_STATE_DIR || !path.resolve(process.env.SYM_STATE_DIR).startsWith(TMP)) {
    const box = fs.mkdtempSync(path.join(TMP, 'mesh-channel-test-'));
    process.env.HOME = box;
    process.env.USERPROFILE = box;
    process.env.SYM_STATE_DIR = path.join(box, '.sym');
    fs.mkdirSync(process.env.SYM_STATE_DIR, { recursive: true });
    process.once('exit', () => { try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* */ } });
  }
  if (!within(process.env.HOME)) throw new Error(`refusing to run: HOME ${process.env.HOME} is not under ${TMP}`);
}
ensureSandbox();

/** A fresh state root inside the sandbox, for one server. */
function stateDir(label = 'node') {
  const d = fs.mkdtempSync(path.join(process.env.HOME, `${label}-`));
  return d;
}

const SERVER = path.join(__dirname, '..', 'server.js');

/**
 * One MCP session against a spawned server.js. `env` is merged over a sandboxed base: its own state
 * root (unless given), no relay unless given, LAN off unless given.
 */
class McpSession {
  constructor({ env = {}, cwd } = {}) {
    const base = {
      ...process.env,
      SYM_STATE_DIR: env.SYM_STATE_DIR || stateDir('srv'),
      SYM_RELAY_URL: '', SYM_RELAY_TOKEN: '', SYM_LAN: 'off', SYM_ALLOWED_PEERS: '',
      CLAUDE_PROJECT_DIR: cwd || fs.mkdtempSync(path.join(process.env.HOME, 'proj-')),
    };
    delete base.CLAUDE_CODE_SESSION_ID;
    this.env = { ...base, ...env };
    this.child = spawn(process.execPath, [SERVER], { env: this.env, cwd: this.env.CLAUDE_PROJECT_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.notifications = [];
    this._buf = '';
    this._pending = new Map();
    this._id = 0;
    this._waiters = [];
    this.child.stderr.on('data', (d) => { this.stderr += String(d); });
    this.child.stdout.on('data', (d) => this._onData(d));
    this.exited = new Promise((r) => this.child.on('exit', (code, signal) => r({ code, signal })));
  }

  _onData(d) {
    this._buf += String(d);
    let i;
    while ((i = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        p(msg);
      } else if (msg.method) {
        this.notifications.push(msg);
        for (const w of [...this._waiters]) w();
      }
    }
  }

  request(method, params, timeoutMs = 30000) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._pending.delete(id); reject(new Error(`no answer to ${method} in ${timeoutMs} ms. stderr:\n${this.stderr.slice(-2000)}`)); }, timeoutMs);
      this._pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize() {
    const r = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mesh-channel-test', version: '1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.instructions = r.result && r.result.instructions;
    return r;
  }

  async tools() { return (await this.request('tools/list', {})).result.tools; }

  /** Call a tool; returns { text, isError, raw }. */
  async call(name, args = {}, timeoutMs) {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (r.error) return { text: `PROTOCOL ERROR: ${r.error.message}`, isError: true, raw: r };
    const content = (r.result && r.result.content) || [];
    return { text: content.map((c) => c.text).join('\n'), isError: !!r.result.isError, raw: r };
  }

  /** The channel notifications' contents so far. */
  pushes() {
    return this.notifications.filter((n) => n.method === 'notifications/claude/channel').map((n) => ({ text: n.params.content, type: n.params.meta && n.params.meta.event_type }));
  }

  async waitForPush(pred, ms = 10000) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.pushes().find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) return null;
      await new Promise((r) => { const w = () => { this._waiters = this._waiters.filter((x) => x !== w); r(); }; this._waiters.push(w); setTimeout(w, 100); });
    }
  }

  async close() {
    try { this.child.stdin.end(); } catch { /* */ }
    const done = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (!done) { try { this.child.kill('SIGKILL'); } catch { /* */ } await this.exited; }
  }
}

async function until(cond, ms = 10000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await cond(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * A fake sym-relay: relay-auth, relay-peers, relay-peer-joined/left, and envelope routing
 * ({ to, payload } → { from, fromName, payload }). Enough for the Core Secure relay handshake.
 * Resolves once it listens.
 */
async function fakeRelay({ tap } = {}) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const conns = new Map();
  const send = (ws, m) => { try { ws.send(JSON.stringify(m)); } catch { /* closed */ } };
  wss.on('connection', (ws) => {
    let me = null;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!me) {
        if (msg.type !== 'relay-auth') return;
        me = { nodeId: msg.nodeId, name: msg.name, ws };
        const prev = conns.get(me.nodeId);
        if (prev) { try { prev.ws.close(4004, 'Replaced by new connection'); } catch { /* */ } }
        conns.set(me.nodeId, me);
        send(ws, { type: 'relay-peers', peers: [...conns.values()].filter((c) => c.nodeId !== me.nodeId).map((c) => ({ nodeId: c.nodeId, name: c.name, offline: false })) });
        for (const c of conns.values()) if (c.nodeId !== me.nodeId) send(c.ws, { type: 'relay-peer-joined', nodeId: me.nodeId, name: me.name });
        return;
      }
      if (msg.type === 'relay-pong' || msg.type === 'relay-ping') return;
      const route = (to, payload) => {
        if (tap && tap({ from: me.nodeId, to, payload }) === false) return;
        const t = conns.get(to);
        if (t) send(t.ws, { from: me.nodeId, fromName: me.name, payload });
      };
      if (Array.isArray(msg.fanout)) { for (const e of msg.fanout) route(e.to, e.payload); return; }
      if (msg.to) route(msg.to, msg.payload);
      else if (msg.payload) for (const c of conns.values()) if (c.nodeId !== me.nodeId) route(c.nodeId, msg.payload);
    });
    ws.on('close', () => {
      if (!me || conns.get(me.nodeId) !== me) return;
      conns.delete(me.nodeId);
      for (const c of conns.values()) send(c.ws, { type: 'relay-peer-left', nodeId: me.nodeId, name: me.name });
    });
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    conns,
    close: () => new Promise((r) => { for (const c of conns.values()) { try { c.ws.terminate(); } catch { /* */ } } wss.close(() => r()); }),
  };
}

/** Two transports joined back to back, for SymNode.connectTransport (the public way to attach one). */
function memoryPipe() {
  const mk = () => {
    const L = {};
    return {
      _closed: false,
      on(e, f) { (L[e] ||= []).push(f); return this; },
      once(e, f) { const w = (...a) => { this.off(e, w); f(...a); }; return this.on(e, w); },
      off(e, f) { L[e] = (L[e] || []).filter((x) => x !== f); return this; },
      removeListener(e, f) { return this.off(e, f); },
      removeAllListeners(e) { if (e) L[e] = []; else for (const k of Object.keys(L)) L[k] = []; return this; },
      emit(e, ...a) { for (const f of [...(L[e] || [])]) f(...a); },
    };
  };
  const a = mk(); const b = mk();
  for (const [s, o] of [[a, b], [b, a]]) {
    s.trySend = (frame) => {
      if (s._closed) return { ok: false, reason: 'not-connected' };
      const copy = JSON.parse(JSON.stringify(frame));
      setImmediate(() => { if (!o._closed) o.emit('message', copy); });
      return { ok: true };
    };
    s.send = (f) => s.trySend(f).ok;
    s.close = () => {
      if (s._closed) return;
      s._closed = true;
      setImmediate(() => s.emit('close'));
      if (!o._closed) { o._closed = true; setImmediate(() => o.emit('close')); }
    };
    s.destroy = s.close;
  }
  return [a, b];
}

/** Join two in-process SymNodes through the real handshake; resolves when each lists the other. */
async function connectNodes(client, server) {
  const [tc, ts] = memoryPipe();
  server.connectTransport(ts, { role: 'server' });
  client.connectTransport(tc, { role: 'client', expectNodeId: server.nodeId });
  const ok = await until(() => client.peers().some((p) => p.peerId === server.nodeId) && server.peers().some((p) => p.peerId === client.nodeId), 5000, 10);
  if (!ok) throw new Error('connectNodes: the pair did not confirm');
  return { tc, ts };
}

/** A tiny runner with the 0.10 suite's output shape. */
function suite(title) {
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });
  t.run = async () => {
    console.log(`\n${title}\n`);
    let passed = 0, failed = 0;
    for (const { name, fn } of tests) {
      try { await fn(); passed++; console.log(`  ✓ ${name}`); }
      catch (e) { failed++; console.log(`  ✗ ${name}\n    ${(e && e.stack) || e}`); }
    }
    console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  };
  return t;
}

module.exports = { McpSession, until, fakeRelay, memoryPipe, connectNodes, stateDir, suite, SERVER, within };
