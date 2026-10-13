'use strict';

/**
 * interior-host.js — INTERIOR MODE: this session is a node's mind, not a node (design D9; XMesh C2;
 * sym D8, D9.3).
 *
 * The node holds the key, the store and the learned admission profile. Its mind — this Claude session
 * — has no mesh identity: it submits drafts over the node's local interior socket with the per-mind
 * capability the node issued for one mission, and the node checks them, signs them as itself and
 * sends them. No SymNode starts here.
 *
 * Wire (sym 0.14, lib/interior.js): newline-delimited JSON on a Unix socket; each request carries an
 * `id`, echoed in its reply, and the capability.
 *   → { id, type:'submit', capability, kind, categories, to?, parents?, payload? }
 *   ← { id, type:'submitted', key, assertionId, duplicate? } | { id, type:'refused', reason }
 *   → { id, type:'end', capability }  ← { id, type:'ended' }
 * The read side (§6 item 8): `mission`, `deliveries`, `subscribe` (then unsolicited
 * `{ type:'delivery', item }` lines), `ack`, `recall`. Every request is SERVED, UNSUPPORTED
 * (`unknown-request`) or REFUSED with a reason, and the three are told apart (review L6).
 *
 * A delivery item is `{ seq, id, kind: 'directed'|'broadcast', record, verified, profile, assertionId,
 * verification, session, author, remixed, receivedAt, acked }` (§6, mismatch 2): the inbox item with
 * its provenance and its signed projection. It is gated by provenance.js exactly as node mode's are,
 * and only the projection's signed parts are shown.
 *
 * THE READ SIDE IS THE MISSION'S (sym ruling C). The node gives a mind only what arrived while it runs
 * (a directed delivery only from a nodeId the mission may address), its own cursor and acks, recall
 * within that scope, and `parents` within it. The channel shows what is served and says the rest.
 *
 * THE CAPABILITY IS BOUND TO ITS CONNECTION (§6 item 8). sym binds it to the first connection that
 * presents it and refuses it on any other (`capability-bound-to-another-connection`). The channel
 * opens one connection and never reconnects with the capability: when the connection closes, sym ends
 * the mind, this mind is detached, and every tool says so.
 *
 * THE KIND IS SIGNED. sym makes a submission's kind the record's intent category and refuses one
 * whose intent says otherwise (`intent-is-not-the-kind`). The channel adds no intent of its own; an
 * intent the agent gives is sent as given, and a refusal is said in those words.
 */

const EventEmitter = require('events');
const net = require('net');
const fs = require('fs');
const { entryFacts, gate } = require('./provenance.js');
const { createKeyBook } = require('./key-display.js');
const { signedParts } = require('./signed-parts.js');

const REQUEST_TIMEOUT_MS = 5000;
const SERVED_MAX = 500;

const REFUSAL_SAID = {
  'no-live-capability': 'this mind\'s capability is not live: the node ended this mind, restarted, or was given another capability',
  'capability-bound-to-another-connection': 'this capability is bound to another connection (sym binds it to the first connection that presents it)',
  'kind-not-declared': 'the mission did not declare that kind of submission',
  'intent-is-not-the-kind': 'the intent category must be the submission\'s kind (the node signs the kind as the intent); leave intent out',
  'audience-not-allowed': 'the mission\'s allowlist does not include that recipient',
  'not-a-cat7-category': 'a category is not one of the seven CAT7 categories',
  'categories-too-large': 'the categories hold more than 64 KiB of text',
  'application-too-large': 'the payload is over 512 KiB',
  'parent-not-in-store': 'a parent is not a record this mind may cite: only a delivery it was given while it ran, a record it submitted, or one in the mission\'s context',
  'not-in-view': 'that delivery is not in this mind\'s view (it arrived before the mind started, or for another mission)',
  rate: 'the mission\'s rate is used up (submissions, or reads); wait and try again',
  failed: 'the node failed to answer the request',
  malformed: 'the node could not read the submission',
  'not-minted': 'the node did not mint a record for it',
  'emit-failed': 'the node could not sign or send it',
  ECMBSIZE: 'the record would be over a size bound',
  ESIGN: 'the node could not sign it',
  'not-json': 'the request was not JSON',
};

function said(reason) {
  return REFUSAL_SAID[reason] || `the node refused it (${String(reason).replace(/[^\w .:-]/g, '_').slice(0, 80)})`;
}

/**
 * The capability (review L6). From SYM_INTERIOR_CAPABILITY_FILE, which must be a regular file owned by
 * this user and readable by no one else, or from SYM_INTERIOR_CAPABILITY. A file that fails is refused,
 * never used with a warning. The caller deletes the variable from the environment once read.
 */
function readCapability(env = process.env) {
  if (env.SYM_INTERIOR_CAPABILITY_FILE) {
    const f = env.SYM_INTERIOR_CAPABILITY_FILE;
    let st;
    try { st = fs.lstatSync(f); } catch (e) { return { capability: null, source: 'file', error: `cannot read SYM_INTERIOR_CAPABILITY_FILE: ${e.code || e.message}` }; }
    if (!st.isFile()) return { capability: null, source: 'file', error: 'SYM_INTERIOR_CAPABILITY_FILE is not a regular file' };
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { capability: null, source: 'file', error: 'SYM_INTERIOR_CAPABILITY_FILE is owned by another user' };
      if ((st.mode & 0o077) !== 0) return { capability: null, source: 'file', error: 'SYM_INTERIOR_CAPABILITY_FILE is readable or writable by other users (chmod 600 it)' };
    }
    try {
      const text = fs.readFileSync(f, 'utf8').trim();
      return text ? { capability: text, source: 'file' } : { capability: null, source: 'file', error: 'SYM_INTERIOR_CAPABILITY_FILE is empty' };
    } catch (e) { return { capability: null, source: 'file', error: `cannot read SYM_INTERIOR_CAPABILITY_FILE: ${e.code || e.message}` }; }
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
    this._opened = false;
    this._buf = '';
    this._seq = 0;
    this._pending = new Map();
    this._served = new Map();
    this.keys = createKeyBook();
    this.mission = null;
    this.supports = { mission: null, deliveries: null, recall: null, subscribe: null, ack: null };
    this.detached = null;     // why this mind is detached (its bound connection closed)
    this.counts = { submitted: 0, refused: 0, refusedByReason: {} };
    this.nodeId = null;
    this.name = null;
  }

  /** Open the one connection the capability is bound to. Never a second time (design D9). */
  _open() {
    if (this._opened) return Promise.reject(new Error(this.detached || 'the interior connection is not open'));
    this._opened = true;
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const fail = (e) => { this.detached = `could not open the interior socket (${e.code || e.message})`; reject(e); };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        sock.on('error', (e) => { if (!this.detached) this.detached = `the interior connection failed (${e.code || e.message})`; });
        sock.on('close', () => {
          if (!this.detached) this.detached = 'the node closed the interior connection (it stopped, or ended this mind); the capability was bound to that connection, so this mind is detached';
          for (const [, p] of this._pending) p.reject(new Error(this.detached));
          this._pending.clear();
          this._sock = null;
        });
        sock.on('data', (chunk) => this._onData(chunk));
        this._sock = sock;
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
    if (this.detached) throw new Error(this.detached);
    if (!this._sock) throw new Error('the interior connection is not open');
    const id = `c${++this._seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`the node did not answer ${body.type} within ${timeoutMs} ms`)); }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, { resolve, reject, timer });
      this._sock.write(JSON.stringify({ id, ...body, capability: this._capability }) + '\n');
    });
  }

  /**
   * A request of the read side: `{ served: reply }`, `{ unsupported: true }` (the node does not serve
   * it: `unknown-request`) or `{ refused: reason }` (it does, and refused this one). Only the first two
   * say anything about what the node serves.
   */
  async _ask(kind, body) {
    if (this.supports[kind] === false) return { unsupported: true };
    const r = await this.request(body);
    if (r && r.type === 'refused') {
      if (r.reason === 'unknown-request') { this.supports[kind] = false; return { unsupported: true }; }
      return { refused: String(r.reason || 'refused') };
    }
    this.supports[kind] = true;
    return { served: r };
  }

  async start() {
    await this._open();
    try {
      const m = await this._ask('mission', { type: 'mission' });
      if (m.served && m.served.type === 'mission') {
        this.mission = m.served;
        this.nodeId = typeof m.served.nodeId === 'string' ? m.served.nodeId.toLowerCase() : null;
        this.name = typeof m.served.name === 'string' ? m.served.name : null;
      }
    } catch (e) { this._log(`interior mission request failed: ${e.message}`); }
    try { await this._ask('subscribe', { type: 'subscribe' }); } catch (e) { this._log(`interior subscribe failed: ${e.message}`); }
    try { await this._ask('deliveries', { type: 'deliveries', peek: true, limit: 1 }); } catch (e) { this._log(`interior delivery read failed: ${e.message}`); }
  }

  async stop() {
    if (this.endOnExit && this._sock && !this.detached) {
      try { await this.request({ type: 'end' }, 1500); } catch { /* the node may already be gone */ }
    }
    if (this._sock) { try { this._sock.end(); } catch { /* */ } }
  }

  kinds() {
    if (this.mission && Array.isArray(this.mission.kinds) && this.mission.kinds.length) return this.mission.kinds;
    return this.envKinds;
  }

  async emitRecord({ kind, categories, to = null, parents = [], payload }) {
    const k = kind || this.defaultKind || (this.kinds().length === 1 ? this.kinds()[0] : null);
    if (!k) return { outcome: 'refused', reason: 'no-kind', text: `this mind must name a submission kind (the mission's kinds${this.kinds().length ? `: ${this.kinds().join(', ')}` : ' are not known here'}); pass kind, or set SYM_INTERIOR_KIND` };
    const body = { type: 'submit', kind: k, categories };
    if (to) body.to = to;
    if (parents.length) body.parents = parents;
    if (payload !== undefined && payload !== null) body.payload = payload;
    let r;
    try { r = await this.request(body); }
    catch (e) { return { outcome: 'refused', reason: 'socket', text: `the node's interior did not take it: ${e.message}` }; }
    if (r && r.type === 'submitted') {
      this.counts.submitted++;
      if (r.duplicate === true) return { outcome: 'already-in-memory', key: r.key || null, kind: k };
      return { outcome: to ? 'submitted-directed' : 'submitted', key: r.key || null, assertionId: r.assertionId || null, kind: k };
    }
    const reason = r && r.reason ? String(r.reason) : 'unknown';
    this.counts.refused++;
    this.counts.refusedByReason[reason] = (this.counts.refusedByReason[reason] || 0) + 1;
    return { outcome: 'refused', reason, text: said(reason), kind: k };
  }

  /**
   * A served item, gated by provenance.js like any entry (design D2), with only its signed parts. sym
   * serves only verified Core Secure items; the gate is applied all the same, so an item the node
   * should not have served is withheld rather than shown.
   */
  _fromServed(it) {
    if (!it || typeof it !== 'object') return null;
    const verdict = gate(it, entryFacts(it));
    const facts = verdict.facts || null;
    if (facts) {
      this.keys.learn({ key: facts.signer.key, nodeId: facts.signer.nodeId, label: facts.signer.label });
      if (facts.deliverer) this.keys.learn({ key: facts.deliverer.key, nodeId: facts.deliverer.nodeId, label: facts.deliverer.label });
    }
    const parts = facts ? signedParts(it.record) : { categories: {}, payload: null };
    const id = typeof it.id === 'string' && /^in\d{4,}$/.test(it.id) ? it.id : `in${String(Number.isSafeInteger(it.seq) ? it.seq : 0).padStart(4, '0')}`;
    const prior = this._served.get(id);
    const d = {
      id, kind: 'cmb', seq: it.seq, receivedAt: Number.isFinite(it.receivedAt) ? it.receivedAt : Date.now(),
      facts, withheld: facts ? null : verdict.withheld,
      categories: parts.categories, payload: parts.payload,
      key: (facts && facts.key) || null,
      // `kind` is the node's word for the audience; the signed `to` (in the facts) is what is shown.
      directed: facts ? facts.audience === 'directed' : it.kind === 'directed', remixed: it.remixed === true,
      // sym's items carry no read mark: what this mind acked stays acked here.
      acked: it.acked === true || !!(prior && prior.acked),
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
    if (r.unsupported) return { unsupported: 'This node\'s interior does not serve deliveries (the node answered unknown-request), so this mind cannot read what the node admits. That is not an empty inbox.' };
    if (r.refused) return { unsupported: `The node refused the delivery read: ${said(r.refused)}.` };
    const reply = r.served;
    if (!reply || reply.type !== 'deliveries' || !Array.isArray(reply.items)) return { unsupported: 'The node answered the delivery read with something that is not a list of deliveries.' };
    const items = reply.items.slice(0, Math.max(1, limit)).map((it) => this._fromServed(it)).filter(Boolean);
    return { items, remaining: Number.isInteger(reply.remaining) ? reply.remaining : 0 };
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

  /** The node's recall. An item with no author is not this node's own (review L3). */
  async recall(query, limit = 10) {
    let r;
    try { r = await this._ask('recall', { type: 'recall', query: query || '', limit }); }
    catch (e) { return { unsupported: `The node's interior could not be asked: ${e.message}.` }; }
    if (r.unsupported) return { unsupported: 'This node\'s interior does not serve recall (it answered unknown-request).' };
    if (r.refused) return { unsupported: `The node refused the recall: ${said(r.refused)}.` };
    const items = Array.isArray(r.served && r.served.items) ? r.served.items.map((it) => {
      const author = it.author && typeof it.author.nodeId === 'string' ? { name: it.author.name, nodeId: it.author.nodeId.toLowerCase(), key: it.author.key } : null;
      // `record` is the signed projection; its payload is read from the signed application section.
      const rec = it.record && typeof it.record === 'object' ? it.record : null;
      const parts = signedParts(rec);
      return { key: it.key, peerId: author ? author.nodeId : 'unattributed', verified: it.verified === true, author, cmb: rec ? { categories: parts.categories, metadata: rec.metadata || {}, payload: parts.payload } : null, storedAt: it.storedAt };
    }) : [];
    return { items };
  }
}

module.exports = { InteriorHost, readCapability, REFUSAL_SAID, said };
