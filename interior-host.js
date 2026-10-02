'use strict';

/**
 * interior-host.js — INTERIOR MODE: this session is a node's mind, not a node (design D7; XMesh C2;
 * sym D8, D9.3).
 *
 * The node holds the key, the store and the learned admission profile. Its mind — this Claude
 * session — has no mesh identity: it submits drafts over the node's local interior socket with the
 * per-mind capability the node issued for one mission, and the node checks (audience, size, rate,
 * declared kinds, parents in its own store), signs as itself and sends. No SymNode starts here.
 *
 * Wire (sym 0.14, lib/interior.js): newline-delimited JSON on a Unix socket (a named pipe on
 * Windows); each request carries an `id`, echoed in its reply.
 *   → { id, type:'submit', capability, kind, categories, to?, parents?, payload? }
 *   ← { id, type:'submitted', key, assertionId } | { id, type:'refused', reason }
 *   → { id, type:'end', capability }  ← { id, type:'ended' }
 *
 * THE READ SIDE IS AN SDK GAP (design §6 item 1). sym 0.14's socket serves only submit and end. The
 * requests below are this design's proposal; the channel sends them, and a node that answers
 * `unknown-request` is reported as not serving them — never as an empty inbox:
 *   → { id, type:'mission', capability }   ← { id, type:'mission', mindId, missionId, kinds, allowTo, ratePerMinute, nodeId, name, room }
 *   → { id, type:'deliveries', capability, after?, limit?, peek? }
 *                                          ← { id, type:'deliveries', items:[{ seq, id, kind, record, verification, session, payload?, remixed, receivedAt, acked? }], cursor, remaining }
 *   → { id, type:'ack', capability, delivery }  ← { id, type:'acked' }
 *   → { id, type:'recall', capability, query, limit? }  ← { id, type:'recall', items:[{ key, record, verified, storedAt, author? }] }
 *   → { id, type:'subscribe', capability }  ← { id, type:'subscribed' }, then { type:'delivery', item } lines
 */

const EventEmitter = require('events');
const net = require('net');
const fs = require('fs');
const { factsFrom } = require('./delivery-facts.js');

const REQUEST_TIMEOUT_MS = 5000;
const SERVED_MAX = 500;

/** The node's refusal reasons, in words a model can act on. */
const REFUSAL_SAID = {
  'no-live-capability': 'this mind\'s capability is not live: the node ended this mind, restarted, or was given another capability',
  'kind-not-declared': 'the mission did not declare that kind of submission',
  'audience-not-allowed': 'the mission\'s allowlist does not include that recipient',
  'not-a-cat7-category': 'a category is not one of the seven CAT7 categories',
  'categories-too-large': 'the categories hold more than 64 KiB of text',
  'application-too-large': 'the payload is over 512 KiB',
  'parent-not-in-store': 'a parent is not a record the node holds; cite only records in its store',
  rate: 'the mission\'s submission rate is used up; wait and submit again',
  malformed: 'the node could not read the submission',
  'not-minted': 'the node did not mint a record for it (identical cognition is already stored, or the remix guard declined it)',
  'emit-failed': 'the node could not sign or send it',
  ECMBSIZE: 'the record would be over a size bound',
  ESIGN: 'the node could not sign it',
  'not-json': 'the request was not JSON',
  'unknown-request': 'the node does not serve this request',
};

function said(reason) {
  return REFUSAL_SAID[reason] || `the node refused it (${String(reason).slice(0, 80)})`;
}

/** The capability: from SYM_INTERIOR_CAPABILITY_FILE (preferred: the environment is readable by the user's processes), or the env itself. */
function readCapability(env = process.env) {
  if (env.SYM_INTERIOR_CAPABILITY_FILE) {
    try {
      const st = fs.statSync(env.SYM_INTERIOR_CAPABILITY_FILE);
      const text = fs.readFileSync(env.SYM_INTERIOR_CAPABILITY_FILE, 'utf8').trim();
      const loose = process.platform !== 'win32' && (st.mode & 0o077) !== 0;
      return { capability: text || null, source: 'file', warning: loose ? 'the capability file is readable by other users (chmod 600 it)' : null };
    } catch (e) {
      return { capability: null, source: 'file', error: `cannot read SYM_INTERIOR_CAPABILITY_FILE: ${e.code || e.message}` };
    }
  }
  const c = (env.SYM_INTERIOR_CAPABILITY || '').trim();
  return { capability: c || null, source: c ? 'env' : null };
}

class InteriorHost extends EventEmitter {
  constructor({ socketPath, capability, defaultKind = null, kinds = [], endOnExit = true, log = () => {} }) {
    super();
    this.mode = 'interior';
    this.socketPath = socketPath;
    this._capability = capability;
    this.defaultKind = defaultKind;
    this.envKinds = kinds;
    this.endOnExit = endOnExit;
    this._log = log;
    this._sock = null;
    this._buf = '';
    this._seq = 0;
    this._pending = new Map();
    this._served = new Map();     // delivery id → Delivery, for fetch / parents / to
    this.mission = null;          // what the node said about the mission, when it says
    this.supports = { mission: null, deliveries: null, recall: null, subscribe: null, ack: null };
    this.closedReason = null;
    this.counts = { submitted: 0, refused: 0, refusedByReason: {} };
    this.nodeId = null;
    this.name = null;
  }

  _connect() {
    if (this._sock && !this._sock.destroyed) return Promise.resolve(this._sock);
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const fail = (e) => { reject(e); };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        sock.on('error', (e) => { this.closedReason = `socket error: ${e.code || e.message}`; });
        sock.on('close', () => {
          if (!this.closedReason) this.closedReason = 'the node closed the interior socket (it stopped, or ended this mind)';
          for (const [, p] of this._pending) p.reject(new Error(this.closedReason));
          this._pending.clear();
          this._sock = null;
        });
        sock.on('data', (chunk) => this._onData(chunk));
        this._sock = sock;
        this.closedReason = null;
        resolve(sock);
      });
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    if (this._buf.length > 8 * 1024 * 1024) { this._sock.destroy(); return; }
    let i;
    while ((i = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.type === 'delivery' && msg.item && (msg.id === undefined || msg.id === null)) {
        const d = this._fromServed(msg.item);
        if (d) this.emit('delivery', d);
        continue;
      }
      const p = msg && msg.id !== undefined ? this._pending.get(msg.id) : null;
      if (p) { this._pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  async request(body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const sock = await this._connect();
    const id = `c${++this._seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`the node did not answer ${body.type} within ${timeoutMs} ms`)); }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, { resolve, reject, timer });
      sock.write(JSON.stringify({ id, ...body, capability: this._capability }) + '\n');
    });
  }

  /** Ask a proposed request; remember whether the node serves it. Returns the reply, or null when not served. */
  async _ask(kind, body) {
    if (this.supports[kind] === false) return null;
    const r = await this.request(body);
    if (r && r.type === 'refused' && r.reason === 'unknown-request') { this.supports[kind] = false; return null; }
    this.supports[kind] = true;
    return r;
  }

  async start() {
    await this._connect();
    try {
      const m = await this._ask('mission', { type: 'mission' });
      if (m && m.type === 'mission') {
        this.mission = m;
        this.nodeId = typeof m.nodeId === 'string' ? m.nodeId : null;
        this.name = typeof m.name === 'string' ? m.name : null;
      }
    } catch (e) { this._log(`interior mission request failed: ${e.message}`); }
    try { await this._ask('subscribe', { type: 'subscribe' }); } catch (e) { this._log(`interior subscribe failed: ${e.message}`); }
    // Whether the node serves its deliveries at all, so the instructions can say so (a peek moves nothing).
    try { await this._ask('deliveries', { type: 'deliveries', peek: true, limit: 1 }); } catch (e) { this._log(`interior delivery read failed: ${e.message}`); }
  }

  async stop() {
    if (this.endOnExit && this._capability) {
      try { await this.request({ type: 'end' }, 1500); } catch { /* the node may already be gone */ }
    }
    if (this._sock) { try { this._sock.end(); } catch { /* */ } }
  }

  kinds() {
    if (this.mission && Array.isArray(this.mission.kinds) && this.mission.kinds.length) return this.mission.kinds;
    return this.envKinds;
  }

  /** Submit one draft. Returns an outcome in the same vocabulary as node mode. */
  async emitRecord({ kind, categories, to = null, parents = [], payload }) {
    const k = kind || this.defaultKind || (this.kinds().length === 1 ? this.kinds()[0] : null);
    if (!k) {
      return { outcome: 'refused', reason: 'no-kind', text: `this mind must name a submission kind (the mission's kinds${this.kinds().length ? `: ${this.kinds().join(', ')}` : ' are not known here'}); pass kind, or set SYM_INTERIOR_KIND` };
    }
    const body = { type: 'submit', kind: k, categories };
    if (to) body.to = to;
    if (parents.length) body.parents = parents;
    if (payload !== undefined && payload !== null) body.payload = payload;
    let r;
    try { r = await this.request(body); }
    catch (e) { return { outcome: 'refused', reason: 'socket', text: `the node's interior did not take it: ${e.message}` }; }
    if (r && r.type === 'submitted') {
      this.counts.submitted++;
      return { outcome: to ? 'submitted-directed' : 'submitted', key: r.key || null, assertionId: r.assertionId || null, kind: k };
    }
    const reason = r && r.reason ? r.reason : 'unknown';
    this.counts.refused++;
    this.counts.refusedByReason[reason] = (this.counts.refusedByReason[reason] || 0) + 1;
    return { outcome: 'refused', reason, text: said(reason), kind: k };
  }

  _fromServed(it) {
    if (!it || typeof it !== 'object') return null;
    const facts = factsFrom({ record: it.record, verification: it.verification, session: it.session });
    const cats = it.record && it.record.categories ? it.record.categories : null;
    const focus = cats && cats.focus ? (typeof cats.focus === 'string' ? cats.focus : cats.focus.text) : '';
    const id = typeof it.id === 'string' && /^(in\d{4,}|m\d{3,})$/.test(it.id) ? it.id : `in${String(it.seq || 0).padStart(4, '0')}`;
    const d = {
      id, kind: it.kind === 'message' || it.kind === 'mood' ? it.kind : 'cmb', seq: it.seq, receivedAt: it.receivedAt || Date.now(),
      facts, withheld: facts ? null : 'unverified',
      content: typeof it.content === 'string' ? it.content : (focus || ''), categories: cats, payload: it.payload ?? null,
      key: (it.record && it.record.metadata && it.record.metadata.key) || null,
      directed: facts ? facts.audience === 'directed' : false, remixed: it.remixed, acked: it.acked === true,
      mood: it.kind === 'mood' && it.mood ? it.mood : undefined, moodFrom: it.moodFrom,
    };
    this._served.delete(d.id);
    this._served.set(d.id, d);
    while (this._served.size > SERVED_MAX) this._served.delete(this._served.keys().next().value);
    return d;
  }

  async drain({ peek = false, limit = 50 } = {}) {
    let r;
    try { r = await this._ask('deliveries', { type: 'deliveries', limit, peek }); }
    catch (e) { return { unsupported: `The node's interior could not be read: ${e.message}.` }; }
    if (!r) return { unsupported: 'This node\'s interior does not serve deliveries: sym 0.14\'s interior socket takes submit and end only, so this mind cannot read what the node admits. That is an SDK gap (mesh-channel design §6 item 1), not an empty inbox.' };
    if (r.type !== 'deliveries' || !Array.isArray(r.items)) return { unsupported: `The node answered the delivery read with ${JSON.stringify(r.type || r.reason || 'nothing')}.` };
    const items = r.items.map((it) => this._fromServed(it)).filter(Boolean);
    return { items, remaining: Number.isInteger(r.remaining) ? r.remaining : 0 };
  }

  get(id) { return this._served.get(id) || null; }

  async markRead(id) {
    const d = this._served.get(id);
    if (d) d.acked = true;
    try { await this._ask('ack', { type: 'ack', delivery: id }); } catch { /* best effort */ }
    return !!d;
  }

  unreadCount() { return 0; }
  isUndrained(id) { const d = this._served.get(id); return !!d && !d.acked; }
  keyOf(id) { const d = this.get(id); return d && d.facts ? (d.key || d.facts.key) : null; }
  signerOf(id) { const d = this.get(id); return d && d.facts ? d.facts.signer.nodeId : null; }

  async recall(query, limit = 10) {
    let r;
    try { r = await this._ask('recall', { type: 'recall', query: query || '', limit }); }
    catch (e) { return { unsupported: `The node's interior could not be asked: ${e.message}.` }; }
    if (!r) return { unsupported: 'This node\'s interior does not serve recall (sym 0.14\'s socket takes submit and end only; design §6 item 1).' };
    const items = Array.isArray(r.items) ? r.items.map((it) => ({
      key: it.key, peerId: it.author && it.author.nodeId && it.author.nodeId !== this.nodeId ? it.author.nodeId : null,
      verified: it.verified === true, author: it.author || null, cmb: it.record || null,
      content: it.record && it.record.categories && it.record.categories.focus ? it.record.categories.focus.text : '',
      storedAt: it.storedAt,
    })) : [];
    return { items };
  }
}

module.exports = { InteriorHost, readCapability, REFUSAL_SAID, said };
