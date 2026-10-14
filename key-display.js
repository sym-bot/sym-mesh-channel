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
const { nodeNameProblem } = require('./identity.js');

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

/**
 * A label as a line prints it, by an ALLOWLIST (review R4-5). A label is the peer's own choice, so it is
 * printed bare only when it is a plain name: words of `A-Z a-z 0-9 . _ @ + # -` joined by single spaces, at
 * most 64 characters, no word "via" (the relay marker), and a name this host would accept (identity.js
 * nodeNameProblem). Anything else is printed QUOTED, as a JSON string in which every character outside
 * printable ASCII is a \u escape: a lookalike bracket or arrow (U+3008, U+27F6), a zero-width or bidi
 * control, NBSP, a C1 control are all visible as what they are, and nothing in it reads as the line's
 * own markup (the brackets, the fingerprint, the arrow, "via", "(2 keys)"). A label is never dropped.
 */
const PLAIN_LABEL = /^[A-Za-z0-9._@+#-]+(?: [A-Za-z0-9._@+#-]+)*$/;
const LABEL_MAX = 64;

/** One code point as a JSON \u escape (an astral one as its surrogate pair). */
function uEscape(cp) {
  const hex = (n) => `\\u${n.toString(16).padStart(4, '0')}`;
  if (cp <= 0xffff) return hex(cp);
  const v = cp - 0x10000;
  return hex(0xd800 + (v >> 10)) + hex(0xdc00 + (v & 0x3ff));
}

function plainLabel(name) {
  const s = String(name ?? '');
  if (!s) return 'unknown';
  if (s.length <= LABEL_MAX && PLAIN_LABEL.test(s) && !/(?:^| )via(?: |$)/i.test(s) && !nodeNameProblem(s)) return s;
  const cps = [...s];
  const cut = cps.length > LABEL_MAX;
  let out = '';
  cps.slice(0, LABEL_MAX).forEach((c, i, arr) => {
    const cp = c.codePointAt(0);
    // The spaces around a word "via" are escaped too, so even a quoted label never reads " via ".
    const viaSpace = cp === 0x20 && ((/^via$/i.test(arr.slice(i + 1, i + 4).join('')) && (arr[i + 4] === undefined || arr[i + 4] === ' '))
      || (/^via$/i.test(arr.slice(i - 3, i).join('')) && (i - 4 < 0 || arr[i - 4] === ' ')));
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    // The line's own brackets are escaped too, so a quoted label cannot hold a bracket of the line.
    else if (cp >= 0x20 && cp <= 0x7e && !viaSpace && c !== '[' && c !== ']') out += c;
    else out += uEscape(cp);
  });
  return `"${out}${cut ? '...' : ''}"`;
}

/**
 * What a label LOOKS like, for counting the keys that use it (review R4-5, R4-7): Unicode-compatibility
 * folded, invisible and combining characters removed, lower-cased, and the common lookalikes of Latin
 * letters (Cyrillic, Greek, and the digits and capitals that pass for l and o) mapped to them. Two labels
 * with one skeleton are "the same label" to whoever reads the line, so "(2 keys)" says so.
 */
const CONFUSABLE = new Map(Object.entries({
  // Cyrillic
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u0451': 'e', '\u043a': 'k', '\u043c': 'm', '\u043d': 'h', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't', '\u0443': 'y', '\u0445': 'x',
  '\u0455': 's', '\u0456': 'l', '\u0457': 'l', '\u0458': 'j', '\u0501': 'd', '\u04bb': 'h', '\u051b': 'q', '\u051d': 'w', '\u04cf': 'l', '\u0578': 'n', '\u057d': 'u', '\u0585': 'o',
  // Greek
  '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b7': 'n', '\u03b9': 'l', '\u03ba': 'k', '\u03bd': 'v', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x', '\u03c9': 'w',
  // i, l, I, 1 and | pass for one another in many fonts, and 0 for o: each is one letter here.
  'i': 'l', '\u0131': 'l', '\u0261': 'g', '\u2113': 'l', '0': 'o', '1': 'l', '|': 'l', '\u01c0': 'l',
}));
function labelSkeleton(name) {
  let s = String(name ?? '').normalize('NFKC');
  s = s.replace(/[\p{Cf}\p{Cc}\p{Mn}\p{Me}]/gu, '');
  s = s.toLowerCase();
  s = [...s].map((c) => CONFUSABLE.get(c) || c).join('');
  return s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/\s+/g, ' ').trim();
}

/**
 * @param {{ bindings?: function(): Array<{ nodeId: string, key: string }>,
 *           persisted?: function(): Array<{ key: string, nodeId?: string, labels?: string[] }> }} [opts]
 *   — the SDK's known bindings, and the keys and labels this node wrote down in earlier runs
 *   (known-peers.json, outbox.js; review R4-7), both read at render time
 */
function createKeyBook({ bindings = () => [], persisted = () => [] } = {}) {
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
    if (typeof label === 'string' && label) { e.labels.add(labelSkeleton(label)); if (e.labels.size > 16) e.labels.delete(e.labels.values().next().value); }
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

  function persistedEntries() {
    let list = [];
    try { list = persisted() || []; } catch { list = []; }
    return Array.isArray(list) ? list.filter((p) => p && typeof p.key === 'string' && p.key) : [];
  }

  /**
   * How many known keys use this label, or one that looks the same (labelSkeleton): the keys learned in
   * this process and the ones written down in earlier runs, so a restart does not forget that a label is
   * another key's (review R4-7).
   */
  function keysWithLabel(label) {
    const l = labelSkeleton(label);
    const fps = new Set();
    for (const e of byFp.values()) if (e.labels.has(l)) fps.add(e.fp);
    for (const p of persistedEntries()) {
      if (!(Array.isArray(p.labels) ? p.labels : []).some((x) => typeof x === 'string' && labelSkeleton(x) === l)) continue;
      const fp = fingerprint(p.key);
      if (fp) fps.add(fp);
    }
    return fps.size;
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

module.exports = { createKeyBook, fingerprint, fullFingerprint, plainLabel, labelSkeleton, MIN_SUFFIX };
