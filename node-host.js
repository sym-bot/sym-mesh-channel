'use strict';

/**
 * node-host.js — NODE MODE: this session is the agent, and the agent is its own SymNode (design §2.5).
 *
 * Everything here goes through sym 0.14's public host API (design D1): the constructor with
 * `nodeId` / `create`, `remember`, `recall`, `peers`, `status`, `inbox` / `inboxGet` / `inboxAck` /
 * `inboxStatus`, `inviteURL` / `acceptInvite`, `awaitRelayOutcome`, and the events `verified-record`,
 * `cmb-accepted`, `message`, `mood-delivered`, `peer-joined`, `metric`, `relay-auth-refused` and
 * `identity-collision`. No underscore field, no frame handler, no daemon IPC.
 *
 * Deliveries (design D2) are the node's admission joined to its verification:
 *   - `verified-record` → the facts wait in the ledger by assertion id;
 *   - `cmb-accepted`    → the SDK has put the delivery in its durable inbox (its own listener runs
 *                         first and stamps `inboxId`); the facts are attached to that inbox id;
 *   - `message`         → a directed message record: kept in this host's own feed (mNNN);
 *   - `mood-delivered`  → §9.3: kept in the feed, attributed only when the join is exact.
 * Every one is announced as 'delivery' for the server to push.
 */

const EventEmitter = require('events');
const { createFactsLedger } = require('./delivery-facts.js');
const { createOutbox } = require('./outbox.js');
const cd = require('./channel-delivery.js');

const FEED_MAX = 200;

/** The host's own feed, for deliveries the SDK inbox does not hold (messages, moods). In memory. */
function createLocalFeed(max = FEED_MAX) {
  const items = [];
  let seq = 0;
  let cursor = 0;
  return {
    add(partial) {
      seq += 1;
      const d = { ...partial, id: `m${String(seq).padStart(3, '0')}`, seq, receivedAt: Date.now(), acked: false, local: true };
      items.push(d);
      while (items.length > max) items.shift();
      return d;
    },
    drain({ peek = false, limit = 50 } = {}) {
      const fresh = items.filter((d) => d.seq > cursor);
      const slice = fresh.slice(0, limit);
      if (!peek && slice.length) cursor = slice[slice.length - 1].seq;
      return { items: slice, remaining: fresh.length - slice.length };
    },
    get(id) { return items.find((d) => d.id === id) || null; },
    markRead(id) { const d = items.find((x) => x.id === id); if (d) d.acked = true; return !!d; },
    unread() { return items.filter((d) => d.seq > cursor && !d.acked).length; },
    isUndrained(id) { const d = items.find((x) => x.id === id); return !!d && d.seq > cursor && !d.acked; },
  };
}

class NodeHost extends EventEmitter {
  /**
   * @param {object} o
   * @param {function(object): object} o.build — builds the SymNode for { room, serviceType, relay,
   *   relayToken, nodeId, create } (server.js owns the configuration)
   * @param {function(string): string} o.nodeDir — sym's identity.nodeDirById
   * @param {function(string): void} [o.log]
   */
  constructor({ build, nodeDir, log = () => {} }) {
    super();
    this.mode = 'node';
    this._build = build;
    this._nodeDir = nodeDir;
    this._log = log;
    this.node = null;
    this.ledger = null;
    this.outbox = null;
    this.feed = createLocalFeed();
    this._cfg = null;
  }

  /** Build the node (synchronous: an identity problem throws here, before anything starts). */
  open(cfg) {
    const node = this._build(cfg);
    this._cfg = { ...cfg, nodeId: node.nodeId, create: false };
    this.node = node;
    const dir = this._nodeDir(node.nodeId);
    let seq = 0;
    try { seq = node.inboxStatus().seq; } catch { /* an engine without an inbox status */ }
    this.ledger = createFactsLedger({ dir, inboxSeq: seq });
    this.outbox = createOutbox(dir);
    this._wire(node);
    return node;
  }

  async start() { await this.node.start(); }

  async stop() {
    if (this.ledger) this.ledger.flush();
    if (this.node) { try { await this.node.stop(); } catch { /* exiting */ } }
  }

  get nodeId() { return this.node ? this.node.nodeId : null; }
  get name() { return this.node ? this.node.name : null; }

  _wire(node) {
    node.on('verified-record', (e) => { try { this.ledger.noteVerified(e); } catch { /* a bad event must not stop verification */ } });

    node.on('cmb-accepted', (entry) => {
      try {
        const aid = entry && entry.cmb && entry.cmb.metadata ? entry.cmb.metadata.assertionId : null;
        const facts = this.ledger.take(aid);
        let d;
        if (entry && entry.inboxId) {
          this.ledger.recordInbox(entry.inboxId, facts, { profile: entry.profile });
          const item = node.inboxGet(entry.inboxId);
          d = item ? this._fromInbox(item) : null;
        }
        if (!d) {
          // An engine that did not stamp an inbox id: the delivery is kept in this host's feed.
          d = this.feed.add({
            kind: 'cmb', facts, withheld: facts ? null : (entry && entry.profile === 'legacy-import' ? 'legacy-import' : 'unverified'),
            content: entry && entry.content, categories: entry && entry.cmb && entry.cmb.categories, payload: entry && entry.cmb ? entry.cmb.payload : null,
            key: (facts && facts.key) || (entry && entry.key) || null, directed: facts ? facts.audience === 'directed' : !!(entry && entry.directed), remixed: entry && entry.remixed,
          });
        }
        this.emit('delivery', d);
      } catch (err) { this._log(`delivery bookkeeping failed: ${err && err.message}`); }
    });

    node.on('message', (fromName, text, meta) => {
      try {
        const facts = this.ledger.take(meta && meta.assertionId);
        const d = this.feed.add({
          kind: 'message', facts, withheld: facts ? null : 'unverified',
          content: typeof text === 'string' ? text : '', categories: null, payload: null,
          key: (meta && meta.key) || (facts && facts.key) || null, directed: true, remixed: false,
        });
        this.emit('delivery', d);
      } catch (err) { this._log(`message bookkeeping failed: ${err && err.message}`); }
    });

    node.on('mood-delivered', (m) => {
      try {
        if (!m || typeof m.mood !== 'string' || !m.mood) return;
        const fromRejected = typeof m.context === 'string' && /rejected/i.test(m.context);
        const facts = fromRejected ? this.ledger.moodSource(m.from, m.mood) : null;
        const d = this.feed.add({
          kind: 'mood', facts, withheld: null,
          mood: { text: m.mood, valence: m.valence, arousal: m.arousal },
          moodFrom: typeof m.from === 'string' ? m.from : '',
          content: m.mood, categories: { mood: { text: m.mood } }, payload: null,
          key: facts ? facts.key : null, directed: false, remixed: false,
        });
        this.emit('delivery', d);
      } catch (err) { this._log(`mood bookkeeping failed: ${err && err.message}`); }
    });

    // A nodeId becomes known for the outbox only through a proven session: sym 0.14 raises
    // peer-joined for a confirmed §5.2 session and for nothing else.
    node.on('peer-joined', (p) => {
      try {
        if (!p || !p.id) return;
        this.outbox.rememberPeer(p.id, p.name);
        this._flushOutbox(p.id).catch(() => {});
      } catch { /* bookkeeping never breaks peer handling */ }
    });

    node.on('relay-auth-refused', (info) => this.emit('relay-auth-refused', info));
    node.on('identity-collision', (info) => this.emit('identity-collision', info));
  }

  // ── The delivery feed ──────────────────────────────────────

  _fromInbox(item) {
    const k = this.ledger.forInbox(item);
    const facts = k.facts || null;
    return {
      id: item.id, kind: 'cmb', seq: item.seq, receivedAt: item.receivedAt,
      facts, withheld: facts ? null : k.withheld,
      content: item.content, categories: item.categories, payload: item.payload,
      key: (facts && facts.key) || item.key || null,
      directed: facts ? facts.audience === 'directed' : !!item.directed,
      remixed: item.remixed, acked: item.acked === true,
    };
  }

  /** Drain the SDK inbox and this host's feed. Every item comes back; the caller accounts for each. */
  drain({ peek = false, limit = 50 } = {}) {
    const r = this.node.inbox({ peek, limit });
    const a = r.messages.map((m) => this._fromInbox(m));
    const b = this.feed.drain({ peek, limit });
    const items = [...a, ...b.items].sort((x, y) => (x.receivedAt || 0) - (y.receivedAt || 0));
    return { items, remaining: (r.remaining || 0) + b.remaining };
  }

  get(id) {
    if (typeof id !== 'string') return null;
    if (id.startsWith('in')) {
      const item = this.node.inboxGet(id);
      return item ? this._fromInbox(item) : null;
    }
    return this.feed.get(id);
  }

  /** Read in full: the engine persists it (inboxAck), so it is not repeated or counted as unread. */
  markRead(id) {
    if (id.startsWith('in')) { try { return this.node.inboxAck(id); } catch { return false; } }
    return this.feed.markRead(id);
  }

  unreadCount() {
    let n = 0;
    try { n = this.node.inboxStatus().undrained || 0; } catch { /* none */ }
    return n + this.feed.unread();
  }

  /** Whether `id` is still waiting: held, not acknowledged, past the drain cursor. */
  isUndrained(id) {
    if (!id.startsWith('in')) return this.feed.isUndrained(id);
    try {
      const m = this.node.inboxGet(id);
      if (!m || m.acked) return false;
      return m.seq > this.node.inboxStatus().cursor;
    } catch { return false; }
  }

  /** The CMB key of a VERIFIED delivery, for `parents`. */
  keyOf(id) {
    const d = this.get(id);
    return d && d.facts ? (d.key || d.facts.key || null) : null;
  }

  /** The verified signer of a delivery, for `to`. */
  signerOf(id) {
    const d = this.get(id);
    return d && d.facts ? d.facts.signer.nodeId : null;
  }

  // ── Emitting ───────────────────────────────────────────────

  /**
   * One remember(), and the node's own account of it (channel-delivery.emitOutcome). Not `emit`: that is EventEmitter's. A directed send
   * to a nodeId with no session is held when this node has had a proven session with it.
   * @returns {object} an outcome: { outcome, key?, assertionId?, dispatched?, reason?, held? }
   */
  emitRecord({ categories, to = null, parents = [], payload }) {
    const node = this.node;
    if (to) {
      const connected = node.peers().some((p) => p.peerId === to);
      if (!connected) return this._holdOrRefuse(to, { categories, parents, payload }, 'no-session');
    }
    const metrics = [];
    const onMetric = (m) => { metrics.push(m && m.type); };
    node.on('metric', onMetric);
    let entry;
    try {
      entry = node.remember(categories, {
        ...(to ? { to } : {}),
        ...(parents.length ? { parents: parents.map((key) => ({ key })) } : {}),
        ...(payload !== undefined && payload !== null ? { payload } : {}),
      });
    } finally {
      node.removeListener('metric', onMetric);
    }
    const out = cd.emitOutcome(entry, metrics, !!to);
    if (out.outcome === 'undelivered') {
      const h = this._holdOrRefuse(to, { categories, parents, payload }, out.reason || 'undelivered');
      return { ...out, held: h.held === true ? h : null, holdRefused: h.held === true ? null : h };
    }
    return out;
  }

  _holdOrRefuse(to, envelope, why) {
    if (!this.outbox.isKnown(to)) return { outcome: 'unknown-peer', to, why };
    const h = this.outbox.hold(to, envelope);
    if (!h.held) return { outcome: 'hold-refused', to, reason: h.reason, why };
    return { outcome: 'held', to, seq: h.seq, queued: h.queued, held: true, label: this.outbox.knownLabel(to), why };
  }

  /** Flush what is held for a nodeId whose session has just been confirmed. In order; never past a failure. */
  async _flushOutbox(nodeId) {
    const pending = this.outbox.pendingFor(nodeId);
    if (!pending.length) return;
    const sent = [];
    for (const item of pending) {
      let out;
      try { out = this.emitRecord({ categories: item.categories, to: nodeId, parents: item.parents || [], payload: item.payload }); }
      catch (e) { this._log(`outbox flush failed for #${item.seq}: ${e && e.message}`); break; }
      // emitRecord() holds an undelivered send again; the copy it just made is dropped with the original.
      if (out.outcome !== 'sent') {
        if (out.held && out.held.seq) this.outbox.drop([out.held.seq]);
        break;
      }
      sent.push(item.seq);
    }
    if (sent.length) {
      const left = this.outbox.drop(sent);
      this._log(`flushed ${sent.length} held CMB(s) to ${nodeId}, ${left} still held`);
      this.emit('outbox-flushed', { nodeId, sent: sent.length, left });
    }
  }

  // ── Reading the node ───────────────────────────────────────

  recall(query) { return this.node.recall(query || ''); }
  peers() { return this.node.peers(); }
  status() { return this.node.status(); }
  memoryCount() { try { return this.node.memories(); } catch { return 0; } }

  // ── Rooms ──────────────────────────────────────────────────

  /**
   * Move this node to another room: stop it, build it again with the same identity, start it. A
   * failure puts the previous room back. Returns { ok, error?, restored? }.
   */
  async rebuild(next) {
    const prev = this._cfg;
    const old = this.node;
    try { await old.stop(); } catch (e) { return { ok: false, error: `failed to stop the current node: ${e && e.message}` }; }
    const attempt = async (cfg) => {
      let n;
      try { n = this._build({ ...cfg, nodeId: prev.nodeId, create: false }); }
      catch (e) {
        // Our own stopped node can hold the lock for a moment: wait once, then retry.
        if (!e || e.code !== 'EIDENTITYLOCK') throw e;
        await new Promise((r) => setTimeout(r, 500));
        n = this._build({ ...cfg, nodeId: prev.nodeId, create: false });
      }
      this._wire(n);
      try { await n.start(); } catch (e) { try { await n.stop(); } catch { /* */ } throw e; }
      return n;
    };
    try {
      const n = await attempt(next);
      this.node = n;
      this._cfg = { ...next, nodeId: prev.nodeId, create: false };
      return { ok: true };
    } catch (e) {
      const error = e && e.message ? e.message : String(e);
      try {
        this.node = await attempt(prev);
        return { ok: false, error, restored: true };
      } catch (e2) {
        this.node = null;
        return { ok: false, error, restored: false, restoreError: e2 && e2.message ? e2.message : String(e2) };
      }
    }
  }

  inviteURL(opts) { return this.node.inviteURL(opts); }
  acceptInvite(url) { return this.node.acceptInvite(url); }
  awaitRelayOutcome(ms) { return typeof this.node.awaitRelayOutcome === 'function' ? this.node.awaitRelayOutcome(ms) : Promise.resolve(null); }
}

module.exports = { NodeHost, createLocalFeed };
