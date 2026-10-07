'use strict';

/**
 * node-host.js — NODE MODE: this session is the agent, and the agent is its own SymNode.
 *
 * Only sym 0.14's public host API: the constructor with `nodeId` / `create`, `remember`, `recall`,
 * `peers`, `status`, `canRemix`, `inbox` / `inboxGet` / `inboxAck` / `inboxStatus`, `inviteURL` /
 * `acceptInvite`, `awaitRelayOutcome`, `publicKey`, `keyBindings()`, `remix` when present (spec draft
 * #35), and the events `cmb-accepted`, `message`, `mood-delivered`, `legacy-record`, `peer-joined`,
 * `metric`, `relay-auth-refused` and `identity-collision`.
 *
 * Deliveries (design D2, D4). Every one is decided by provenance.js from the delivery itself:
 *   - `cmb-accepted`   → the SDK has put it in its durable inbox with its provenance and stamped
 *                        `inboxId` (its own listener runs first). The inbox item is read and gated;
 *                        its facts are persisted with it, so a restart decides the same.
 *   - `message`        → a directed message record. The event names its author, the delivering peer
 *                        and the record; the keys are the node's own bindings (provenance.eventFacts).
 *   - `mood-delivered` → shown only with the record and the proven sender (design D4), the same way.
 *   - `legacy-record`  → a Legacy Import record: listed by id, never shown.
 * Messages, moods and legacy records are kept in this host's own feed (an `m` id), PERSISTED with the
 * node (`channel-feed.log` in its directory; inbox-id bug, 2026-10): an id is assigned only once the
 * item is written, is unique for the life of the node's store, and always fetches what it announced,
 * across a hot-swap or a restart. A read item may be evicted; an unread one never is.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { createOutbox } = require('./outbox.js');
const { gate, entryFacts, eventFacts } = require('./provenance.js');
const { createKeyBook } = require('./key-display.js');
const { signedParts } = require('./signed-parts.js');
const cd = require('./channel-delivery.js');

const FEED_MAX = 200;
const MOOD_TEXT_MAX = 2000;

/**
 * The host's own feed, for deliveries the SDK inbox does not hold. With `file`, every change is
 * appended to it before it takes effect (an item before its id is announced, a read, the cursor), and
 * the feed is read back from it, so ids survive the host and are never reused. A read item may go
 * when the feed is past `max`; an unread one never does: past 4 x `max` unread, `add` returns null
 * (nothing is announced).
 */
function createLocalFeed(max = FEED_MAX, file = null) {
  let items = [];
  let seq = 0;
  let cursor = 0;
  const journal = (change) => {
    if (!file) return true;
    try { fs.appendFileSync(file, JSON.stringify(change) + '\n', { mode: 0o600 }); return true; } catch { return false; }
  };
  if (file) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { /* none yet */ }
    for (const line of lines) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; } // a torn last line never took effect
      if (o.add && Number.isSafeInteger(o.add.seq)) { if (o.add.seq > seq) seq = o.add.seq; items.push(o.add); }
      else if (typeof o.read === 'string') { const d = items.find((x) => x.id === o.read); if (d) d.acked = true; }
      else if (Number.isSafeInteger(o.cursor)) { if (o.cursor > cursor) cursor = o.cursor; }
      else if (Number.isSafeInteger(o.seqFloor) && o.seqFloor > seq) seq = o.seqFloor; // ids taken by evicted items
    }
    // Fold: keep what the bound keeps, written back whole, so the file does not grow without end.
    const read = (d) => d.seq <= cursor || d.acked;
    while (items.length > max && read(items[0])) items.shift();
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, [JSON.stringify({ seqFloor: seq }), JSON.stringify({ cursor }), ...items.map((d) => JSON.stringify({ add: d }))].join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* the journal as it is still reads back the same */ }
  }
  const unread = () => items.filter((d) => d.seq > cursor && !d.acked).length;
  return {
    add(partial) {
      if (unread() >= max * 4) return null;
      const next = seq + 1;
      const d = { ...partial, id: `m${String(next).padStart(3, '0')}`, seq: next, receivedAt: Date.now(), acked: false, local: true };
      if (!journal({ add: d })) return null;
      seq = next;
      items.push(d);
      while (items.length > max && (items[0].seq <= cursor || items[0].acked)) items.shift();
      return d;
    },
    peek(limit) { return items.filter((d) => d.seq > cursor).slice(0, limit); },
    pending() { return items.filter((d) => d.seq > cursor).length; },
    advanceTo(s) { if (s > cursor) { cursor = s; journal({ cursor: s }); } },
    get(id) { return items.find((d) => d.id === id) || null; },
    markRead(id) { const d = items.find((x) => x.id === id); if (d && !d.acked) { d.acked = true; journal({ read: id }); } return !!d; },
    unread,
    isUndrained(id) { const d = items.find((x) => x.id === id); return !!d && d.seq > cursor && !d.acked; },
  };
}

class NodeHost extends EventEmitter {
  /**
   * @param {object} o
   * @param {function(object): object} o.build — builds the SymNode (server.js owns the configuration)
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
    this.outbox = null;
    this.feed = createLocalFeed();
    this.keys = createKeyBook({ bindings: () => (this.node && typeof this.node.keyBindings === 'function' ? this.node.keyBindings() : []) });
    this._cfg = null;
  }

  /** Build the node (synchronous: an identity problem throws here, before anything starts). */
  open(cfg) {
    const node = this._build(cfg);
    this._cfg = { ...cfg, nodeId: node.nodeId, create: false };
    this.node = node;
    this.outbox = createOutbox(this._nodeDir(node.nodeId));
    // The feed lives with the node, so its ids outlive this host (inbox-id bug, 2026-10).
    try { this.feed = createLocalFeed(FEED_MAX, path.join(this._nodeDir(node.nodeId), 'channel-feed.log')); }
    catch { /* the in-memory feed stays */ }
    this._wire(node);
    const own = this.ownKey();
    if (own) this.keys.learn({ key: own, nodeId: node.nodeId, label: node.name });
    return node;
  }

  async start() { await this.node.start(); }
  async stop() { if (this.node) { try { await this.node.stop(); } catch { /* exiting */ } } }

  get nodeId() { return this.node ? this.node.nodeId : null; }
  get name() { return this.node ? this.node.name : null; }

  /** This node's own public key, from the SDK's accessor (design §6 item 4), or null where it has none. */
  ownKey() {
    const n = this.node;
    if (!n) return null;
    const k = typeof n.publicKey === 'function' ? n.publicKey() : n.publicKey;
    return typeof k === 'string' && k ? k : null;
  }

  _learn(facts) {
    if (!facts) return;
    if (facts.signer) this.keys.learn({ key: facts.signer.key, nodeId: facts.signer.nodeId, label: facts.signer.label });
    if (facts.deliverer) this.keys.learn({ key: facts.deliverer.key, nodeId: facts.deliverer.nodeId, label: facts.deliverer.label });
  }

  /** A delivery as every surface reads it, from an entry and what the gate decided. */
  _delivery(base, verdict) {
    const facts = verdict.facts || null;
    this._learn(facts);
    return { ...base, facts, withheld: facts ? null : verdict.withheld, directed: facts ? facts.audience === 'directed' : !!base.directed };
  }

  _wire(node) {
    node.on('cmb-accepted', (entry) => {
      try {
        if (!entry || !entry.inboxId) { this._log('a delivery came without an inbox id; it cannot be listed'); return; }
        const item = node.inboxGet(entry.inboxId);
        if (!item) return;
        this.emit('delivery', this._fromInbox(item));
      } catch (err) { this._log(`delivery bookkeeping failed: ${err && err.message}`); }
    });

    node.on('message', (fromName, text, meta) => {
      try {
        const m = meta || {};
        const verdict = this._eventVerdict({ assertionId: m.assertionId, key: m.key, authorNodeId: m.from, authorLabel: m.fromName, viaNodeId: m.via, audience: 'directed' }, 'no-provenance');
        const d = this.feed.add(this._delivery({ kind: 'message', text: typeof text === 'string' ? text : '', categories: {}, payload: null, key: typeof m.key === 'string' ? m.key : null, directed: true, remixed: false }, verdict));
        if (d) this.emit('delivery', d); else this._log('the feed is full of unread items (or not writable): a message was not announced');
      } catch (err) { this._log(`message bookkeeping failed: ${err && err.message}`); }
    });

    node.on('mood-delivered', (m) => {
      try {
        if (!m || typeof m.mood !== 'string' || !m.mood) return;
        const d = this.feed.add(this._delivery({ kind: 'mood', text: m.mood.slice(0, MOOD_TEXT_MAX), categories: {}, payload: null, key: null, directed: false, remixed: false }, this._moodVerdict(m)));
        if (!d) { this._log('the feed is full of unread items (or not writable): a mood was not announced'); return; }
        if (d.facts) d.key = d.facts.key;
        this.emit('delivery', d);
      } catch (err) { this._log(`mood bookkeeping failed: ${err && err.message}`); }
    });

    node.on('legacy-record', () => {
      try { const d = this.feed.add({ kind: 'cmb', facts: null, withheld: 'legacy-import', categories: {}, payload: null, key: null, directed: false }); if (d) this.emit('delivery', d); }
      catch (err) { this._log(`legacy bookkeeping failed: ${err && err.message}`); }
    });

    // A nodeId becomes known for the outbox only through a Core Secure session (review L4): the session
    // is checked in peers(), since peer-joined does not say which profile the session has.
    node.on('peer-joined', (p) => {
      try {
        if (!p || !p.id) return;
        const peer = node.peers().find((x) => x.peerId === p.id);
        const proven = !!peer && peer.profile === 'core-secure' && Array.isArray(peer.sessions) && peer.sessions.length > 0 && peer.sessions.every((s) => !s.legacy);
        if (!proven) return;
        this.outbox.rememberPeer(p.id, p.name);
        this._flushOutbox(p.id).catch(() => {});
      } catch { /* bookkeeping never breaks peer handling */ }
    });

    node.on('relay-auth-refused', (info) => this.emit('relay-auth-refused', info));
    node.on('identity-collision', (info) => this.emit('identity-collision', info));
  }

  /**
   * The verdict on a delivery sym raises as an event (a message, a mood), from what the event names:
   * the record's assertion id and key, its proven author and the peer that delivered it. The keys are
   * the node's own bindings for those nodeIds (design §6, mismatches 3 and 4); a delivering peer whose
   * session is Legacy Import is quarantined, as its records are.
   */
  _eventVerdict({ assertionId, key, authorNodeId, authorLabel, viaNodeId, viaLabel, audience }, missing) {
    if (typeof assertionId !== 'string' || !assertionId || typeof authorNodeId !== 'string' || !authorNodeId) return { withheld: missing };
    let peer = null;
    try { peer = (this.node.peers() || []).find((p) => p.peerId === viaNodeId) || null; } catch { peer = null; }
    if (peer && (peer.profile === 'legacy-import' || (Array.isArray(peer.sessions) && peer.sessions.some((x) => x.legacy)))) return { withheld: 'legacy-import' };
    const transport = peer && Array.isArray(peer.sessions) && peer.sessions[0] ? peer.sessions[0].transport : null;
    const facts = eventFacts({
      assertionId, key, authorNodeId, authorLabel, delivererNodeId: viaNodeId, delivererLabel: viaLabel ?? (peer ? peer.name : ''),
      transport, audience, bindingOf: (id) => this.keys.bindingFor(id),
    });
    return facts ? { facts } : { withheld: 'no-key-binding' };
  }

  /**
   * A mood is shown only with the record and the proven sender (design D4, review M1): the event names
   * the record (key, assertion), says it verified, and names the author and the session that
   * delivered it. The author's label is the deliverer's when they are one node; otherwise the event
   * carries none, and the line names the author by key.
   */
  _moodVerdict(m) {
    const by = m.deliveredBy && typeof m.deliveredBy === 'object' ? m.deliveredBy : null;
    if (m.verified !== true || typeof m.key !== 'string' || typeof m.assertionId !== 'string' || typeof m.authorNodeId !== 'string' || !by || typeof by.nodeId !== 'string') {
      return { withheld: 'mood-unattributed' };
    }
    const same = m.authorNodeId.toLowerCase() === by.nodeId.toLowerCase();
    return this._eventVerdict({ assertionId: m.assertionId, key: m.key, authorNodeId: m.authorNodeId, authorLabel: same ? by.name : '', viaNodeId: by.nodeId, viaLabel: by.name, audience: 'room' }, 'mood-unattributed');
  }

  // ── The delivery feed ──────────────────────────────────────

  /**
   * An inbox item as every surface reads it: gated on its own provenance (persisted with it), and
   * only the parts of its signed projection shown (`item.record`, the record as signed), never the
   * item's own `categories` and `payload` copies.
   */
  _fromInbox(item) {
    const verdict = gate(item, entryFacts(item));
    const parts = verdict.facts ? signedParts(item.record) : { categories: {}, payload: null };
    return this._delivery({
      id: item.id, kind: 'cmb', seq: item.seq, receivedAt: item.receivedAt,
      categories: parts.categories, payload: parts.payload,
      key: item.key || null, directed: !!item.directed, remixed: item.remixed, acked: item.acked === true,
    }, verdict);
  }

  /**
   * Drain the SDK inbox and this host's feed, oldest first, at most `limit` in all (review L10). Each
   * source is peeked, the batch is chosen, and only then is each source's cursor moved past what the
   * batch took from it.
   */
  drain({ peek = false, limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 50, 500));
    const a = this.node.inbox({ peek: true, limit: lim });
    const fromInbox = a.messages.map((m) => this._fromInbox(m));
    const feedPending = this.feed.pending();
    const fromFeed = this.feed.peek(lim);
    const batch = [...fromInbox, ...fromFeed].sort((x, y) => (x.receivedAt || 0) - (y.receivedAt || 0)).slice(0, lim);
    const tookInbox = batch.filter((d) => !d.local);
    const tookFeed = batch.filter((d) => d.local);
    if (!peek) {
      // inbox() drains oldest first, the same items the peek listed, up to this many unread ones.
      if (tookInbox.length) this.node.inbox({ limit: Math.max(1, tookInbox.filter((d) => !d.acked).length) });
      if (tookFeed.length) this.feed.advanceTo(tookFeed[tookFeed.length - 1].seq);
    }
    const remaining = (a.remaining || 0) + (fromInbox.length - tookInbox.length) + (feedPending - tookFeed.length);
    return { items: batch, remaining: Math.max(0, remaining) };
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

  /** Whether this SDK still gates a cited record with §15.7 (before spec draft #35, which adds `remix()`). */
  remixGated() { return !!this.node && typeof this.node.remix !== 'function'; }

  /**
   * One remember(), and the node's own account of it (channel-delivery.emitOutcome). Not `emit`: that
   * is EventEmitter's. A directed send to a nodeId with no session is held when this node has had a
   * Core Secure session with it — unless this SDK would refuse to send it at all (design D7).
   */
  emitRecord({ categories, to = null, parents = [], payload }) {
    const node = this.node;
    if (to) {
      const connected = node.peers().some((p) => p.peerId === to);
      if (!connected) {
        // The guard is checked at hold time: a held reply the SDK will refuse would never flush.
        if (parents.length && this.remixGated() && typeof node.canRemix === 'function' && !node.canRemix()) return { outcome: 'remix-refused' };
        return this._holdOrRefuse(to, { categories, parents, payload }, 'no-session');
      }
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

  /**
   * Flush what is held for a nodeId whose Core Secure session has just been confirmed. In order; never
   * past a failure. An item the SDK refuses to send is marked stuck, with its reason, and sym_peers
   * reports it as stuck rather than as waiting (design D7, review r12).
   */
  async _flushOutbox(nodeId) {
    const pending = this.outbox.pendingFor(nodeId).filter((i) => !i.stuck);
    if (!pending.length) return;
    const sent = [];
    for (const item of pending) {
      let out;
      try { out = this.emitRecord({ categories: item.categories, to: nodeId, parents: item.parents || [], payload: item.payload }); }
      catch (e) { this.outbox.markStuck(item.seq, `the SDK refused it: ${String(e && e.message).slice(0, 160)}`); break; }
      if (out.outcome === 'sent') { sent.push(item.seq); continue; }
      // An undelivered send held itself again; that copy goes, and the original stays held.
      if (out.held && out.held.seq) this.outbox.drop([out.held.seq]);
      if (out.outcome === 'remix-refused') this.outbox.markStuck(item.seq, 'this SDK refuses a record that cites a peer\'s (MMP §15.7, before spec draft #35) until this node publishes an observation of its own');
      break;
    }
    if (sent.length) {
      const left = this.outbox.drop(sent);
      this._log(`flushed ${sent.length} held CMB(s) to ${nodeId}, ${left} still held`);
      this.emit('outbox-flushed', { nodeId, sent: sent.length, left });
    }
  }

  /** Try again what is stuck for a peer with a session now (after this node published something new). */
  retryStuck() {
    for (const p of this.node.peers()) {
      const stuck = this.outbox.pendingFor(p.peerId).filter((i) => i.stuck);
      if (!stuck.length) continue;
      for (const i of stuck) this.outbox.clearStuck(i.seq);
      this._flushOutbox(p.peerId).catch(() => {});
    }
  }

  // ── Reading the node ───────────────────────────────────────

  recall(query) { return this.node.recall(query || ''); }
  peers() { return this.node.peers(); }
  status() { return this.node.status(); }
  memoryCount() { try { return this.node.memories(); } catch { return 0; } }

  // ── Rooms ──────────────────────────────────────────────────

  /** Move this node to another room with the same identity. A failure puts the previous room back. */
  async rebuild(next) {
    const prev = this._cfg;
    const old = this.node;
    try { await old.stop(); } catch (e) { return { ok: false, error: `failed to stop the current node: ${e && e.message}` }; }
    const attempt = async (cfg) => {
      let n;
      try { n = this._build({ ...cfg, nodeId: prev.nodeId, create: false }); }
      catch (e) {
        if (!e || e.code !== 'EIDENTITYLOCK') throw e;
        await new Promise((r) => setTimeout(r, 500));
        n = this._build({ ...cfg, nodeId: prev.nodeId, create: false });
      }
      this._wire(n);
      try { await n.start(); } catch (e) { try { await n.stop(); } catch { /* */ } throw e; }
      return n;
    };
    try {
      this.node = await attempt(next);
      this._cfg = { ...next, nodeId: prev.nodeId, create: false };
      return { ok: true };
    } catch (e) {
      const error = e && e.message ? e.message : String(e);
      try { this.node = await attempt(prev); return { ok: false, error, restored: true }; }
      catch (e2) { this.node = null; return { ok: false, error, restored: false, restoreError: e2 && e2.message ? e2.message : String(e2) }; }
    }
  }

  inviteURL(opts) { return this.node.inviteURL(opts); }
  acceptInvite(url) { return this.node.acceptInvite(url); }
  awaitRelayOutcome(ms) { return typeof this.node.awaitRelayOutcome === 'function' ? this.node.awaitRelayOutcome(ms) : Promise.resolve(null); }
}

module.exports = { NodeHost, createLocalFeed };
