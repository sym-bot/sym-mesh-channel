'use strict';

/**
 * key-display.js — how a line identifies a signer (design D3, review H2).
 *
 * A label is chosen by its sender, and so is a nodeId: MMP §3.1.1 makes it a UUID v7 the node picks,
 * not one derived from its key, and sym binds an unbound nodeId to whatever key its first session
 * proves. So a truncated nodeId identifies nobody: anyone can mint one with the same last 8 hex as
 * another node's (review r1). What a node has PROVEN is the key behind a nodeId, so a line names the
 * signer by its label and the shortest suffix of its key fingerprint that is unique among the key
 * bindings this node knows, at least 8 hex characters. When a label is used by more than one known
 * key, the line says so, and the suffix is long enough to tell them apart.
 *
 * The fingerprint is SHA-256 of the raw Ed25519 public key (base64url-decoded), in hex. An attacker
 * can grind a key whose fingerprint ends like another's, but the attacker's key is a binding this node
 * knows too (it is delivering), so the suffix grows past the shared part.
 *
 * The known bindings are the SDK's (`node.keyBindings()`, design §6 item 5), read at render time, and
 * the keys this book has learned from verified facts in this process (interior mode has no node, so
 * only those). A key the SDK binds under two nodeIds is said as such, as a key learned under two is.
 */

const crypto = require('crypto');

const MIN_SUFFIX = 8;
const MAX_KEYS = 20_000;

function fingerprint(key) {
  if (typeof key !== 'string' || !key) return null;
  let bytes;
  try { bytes = Buffer.from(key, 'base64url'); } catch { bytes = null; }
  if (!bytes || bytes.length !== 32) bytes = Buffer.from(key, 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * The full fingerprint as a line prints it, in the form sym gives (`node.fingerprint`):
 * `sha256:<64 hex>`. The suffix a tag shows is the end of the same hex.
 */
function fullFingerprint(key) {
  const fp = fingerprint(key);
  return fp ? `sha256:${fp}` : null;
}

/** A label as a line prints it: one line, no brackets, no control characters, no line markers. */
function plainLabel(name) {
  const s = String(name ?? '').replace(/[\r\n\t\v\f[\]\u0000-\u001f\u007f-\u009f\u2028\u2029→·⟨⟩"]/g, '_').replace(/ via /gi, ' via_').slice(0, 64);
  return s || 'unknown';
}

/**
 * @param {{ bindings?: function(): Array<{ nodeId: string, key: string }> }} [opts] — the SDK's known
 *   bindings, read at render time
 */
function createKeyBook({ bindings = () => [] } = {}) {
  const byFp = new Map();   // fingerprint → { key, labels: Set, nodeIds: Set }

  function entry(key) {
    const fp = fingerprint(key);
    if (!fp) return null;
    let e = byFp.get(fp);
    if (!e) {
      if (byFp.size >= MAX_KEYS) byFp.delete(byFp.keys().next().value);
      e = { key, fp, labels: new Set(), nodeIds: new Set() };
      byFp.set(fp, e);
    }
    return e;
  }

  /** Learn a key from verified facts: its nodeId and the label it was seen with. */
  function learn({ key, nodeId, label } = {}) {
    const e = entry(key);
    if (!e) return null;
    if (typeof nodeId === 'string' && nodeId) e.nodeIds.add(nodeId.toLowerCase());
    if (typeof label === 'string' && label) { e.labels.add(plainLabel(label)); if (e.labels.size > 16) e.labels.delete(e.labels.values().next().value); }
    return e.fp;
  }

  function sdkBindings() {
    let list = [];
    try { list = bindings() || []; } catch { list = []; }
    return Array.isArray(list) ? list.filter((b) => b && typeof b.key === 'string' && b.key && typeof b.nodeId === 'string' && b.nodeId) : [];
  }

  /** Every fingerprint this node knows: the SDK's bindings and the ones learned here. */
  function allFingerprints(list = sdkBindings()) {
    const out = new Set(byFp.keys());
    for (const b of list) { const fp = fingerprint(b.key); if (fp) out.add(fp); }
    return out;
  }

  /** The nodeIds a key is known under: the SDK's bindings of it and the ones learned here. */
  function nodeIdsOf(fp, list = sdkBindings()) {
    const ids = new Set(byFp.has(fp) ? byFp.get(fp).nodeIds : []);
    for (const b of list) if (fingerprint(b.key) === fp) ids.add(b.nodeId.toLowerCase());
    return ids;
  }

  /** The shortest suffix (≥ 8) of `fp` that no other known fingerprint ends with. */
  function suffixOf(fp, all = allFingerprints()) {
    let n = MIN_SUFFIX;
    for (const other of all) {
      if (other === fp) continue;
      while (n < fp.length && other.endsWith(fp.slice(-n))) n++;
    }
    return fp.slice(-n);
  }

  /** How many known keys use this label. */
  function keysWithLabel(label) {
    const l = plainLabel(label);
    let n = 0;
    for (const e of byFp.values()) if (e.labels.has(l)) n++;
    return n;
  }

  /**
   * The tag a line prints for a signer: `alice ⟨…7f3a91c2⟩`; `alice (2 keys) ⟨…7f3a91c2e0⟩` when the
   * label is shared by two known keys; `alice (one key, 2 nodeIds) ⟨…⟩` when one key was seen under two
   * nodeIds. A signer with no key is `alice ⟨key unknown⟩` (never shown as verified anyway).
   */
  function tag({ key, label, nodeId } = {}) {
    const fp = learn({ key, nodeId, label });
    const name = plainLabel(label);
    if (!fp) return `${name} ⟨key unknown⟩`;
    const shared = keysWithLabel(label);
    const list = sdkBindings();
    // One key under more than one nodeId is one holder running several identities: said, not hidden.
    const ids = nodeIdsOf(fp, list).size;
    return `${name}${shared > 1 ? ` (${shared} keys)` : ''}${ids > 1 ? ` (one key, ${ids} nodeIds)` : ''} ⟨…${suffixOf(fp, allFingerprints(list))}⟩`;
  }



  /** The key bound to a nodeId, from the SDK's bindings or what this book learned; null when unknown. */
  function keyForNode(nodeId) {
    const id = typeof nodeId === 'string' ? nodeId.toLowerCase() : '';
    const b = sdkBindings().find((x) => x.nodeId.toLowerCase() === id);
    if (b) return b.key;
    for (const e of byFp.values()) if (e.nodeIds.has(id)) return e.key;
    return null;
  }

  return { learn, tag, suffixOf, fingerprint, allFingerprints, nodeIdsOf, keysWithLabel, keyForNode, size: () => byFp.size };
}

module.exports = { createKeyBook, fingerprint, fullFingerprint, plainLabel, MIN_SUFFIX };
