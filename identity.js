'use strict';

// identity.js — the folder's agent identity, and the two ways a node is written down.
//
// THE FOLDER IS THE AGENT. Its name comes from SYM_NODE_NAME or `.sym/node.json` (`node_name`), or
// the session default. The name is the index of the identity on this host, never the identity: sym
// 0.14 keeps identities by nodeId (`nodes/by-id/<nodeId>/`) with the name as an index (sym D9.1).
//
// NEVER -2, NEVER -3. A collision is a hard failure, never a suffix: `foo-2` would be a different
// store with a different key under a familiar name. sym 0.14 has no suffixing at all.
//
// A NODE ID PINS THE AGENT. With `node_id` in `.sym/node.json`, or SYM_NODE_ID, the identity is loaded
// with `create: false`: a missing identity stops the node and says why, instead of minting a
// replacement silently (design D10, sym D9.1). Without one the name is looked up, and minted only the
// first time.

const NODE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `s` is a nodeId (MMP §3.1.1: a UUID). */
function isNodeId(s) {
  return typeof s === 'string' && NODE_ID_RE.test(s.trim());
}

/**
 * The 8 characters a line prints for a nodeId: its LAST 8. The first 8 of a UUID v7 are the top of
 * its timestamp, so nodes minted within about a minute of each other share them; the tail is random.
 */
function shortId(nodeId) {
  return typeof nodeId === 'string' && nodeId.length >= 8 ? nodeId.slice(-8) : String(nodeId || '?');
}

/**
 * @param {{ pinnedName?: string|null, pinnedNodeId?: string|null, defaultName: string }} opts
 * @returns {{ name: string, nodeId: string|null, pinned: boolean }}
 */
function resolveIdentity({ pinnedName, pinnedNodeId, defaultName } = {}) {
  const pinned = (typeof pinnedName === 'string' && pinnedName.trim()) ? pinnedName.trim() : null;
  const nodeId = isNodeId(pinnedNodeId) ? pinnedNodeId.trim().toLowerCase() : null;
  return { name: pinned || defaultName, nodeId, pinned: !!pinned };
}

/**
 * Why a node name cannot be used, or null if it can. A name is a directory-safe index on this host,
 * and MMP §3.1.2 bounds it to 1–64 bytes of printable characters. Shared by the installer (--name)
 * and the server (.sym/node.json), so a name planted in a config file meets the same check as one
 * typed on a command line.
 */
function nodeNameProblem(name) {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name, 'utf8') > 64) return 'must be 1–64 bytes and not blank';
  if (name !== name.trim()) return 'must not start or end with whitespace';
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/.test(name)) return 'must not contain control, zero-width or bidi characters';
  if (/[\\/]/.test(name) || name === '.' || name === '..') return 'must not contain path separators or be . or ..';
  if (/[:*?"<>|]/.test(name)) return 'must not contain any of : * ? " < > | (not valid in a file name on every platform)';
  // Windows refuses these as a directory name whatever the extension, and a trailing dot is dropped.
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) return 'must not be a name Windows reserves (CON, PRN, AUX, NUL, COM1–9, LPT1–9)';
  if (name.endsWith('.')) return 'must not end with a dot (Windows drops it, so two names would share one directory)';
  return null;
}

module.exports = { resolveIdentity, nodeNameProblem, isNodeId, shortId, NODE_ID_RE };
