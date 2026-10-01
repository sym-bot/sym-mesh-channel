'use strict';

// identity.js — resolve a node's stable identity for SymNode construction.
//
// A node's on-disk store and its identity are keyed by its name, so if the name changes it becomes a
// separate, empty store. Collision handling therefore belongs to the engine, whose lock liveness is
// start-time-verified and thus safe against reused process ids. The plugin previously did its own
// check with a bare `process.kill(pid, 0)`, which can't distinguish a live holder from a recycled
// PID — a stale lock left by a dead session could read as "held" and force a `-2`/`-3` suffix,
// starting a fresh identity in place of the intended one. This module does no pid/lock inspection;
// that decision is delegated to the engine.
//
// NEVER -2, NEVER -3. autoSuffix is OFF for every
// identity, pinned or not. A suffix looks like a courtesy and is a data event:
// `foo-2` is a DIFFERENT store with a DIFFERENT signing key, so the seat keeps
// its name in conversation while silently becoming a new cryptographic identity
// with none of its own memory. We found three such stores on one machine
// (codex-mac, -2, -3), each with its own keypair, minted by collisions nobody
// was told about.
//
// A collision is now always a hard failure. The engine still reclaims a DEAD
// holder's stale lock — that path is start-time-verified and is not a suffix —
// so this only bites when a genuinely live process holds the name, which is a
// real conflict that deserves an error rather than a second identity.
//
//   - PINNED (SYM_NODE_NAME or .sym/node.json): used verbatim.
//   - UNPINNED session: the caller's default name.
//   Both: autoSuffix OFF. EIDENTITYLOCK on a live holder.

/**
 * @param {{ pinnedName?: string|null, defaultName: string }} opts
 * @returns {{ name: string, autoSuffix: boolean, pinned: boolean }}
 */
function resolveIdentity({ pinnedName, defaultName } = {}) {
  const pinned = (typeof pinnedName === 'string' && pinnedName.trim()) ? pinnedName.trim() : null;
  if (pinned) return { name: pinned, autoSuffix: false, pinned: true };
  return { name: defaultName, autoSuffix: false, pinned: false };
}

/**
 * Why a node name cannot be used, or null if it can. A name becomes a directory under
 * ~/.sym/nodes/, and MMP §3.1.2 bounds it to 1–64 bytes of printable characters. Shared by the
 * installer (--name) and the server (.sym/node.json), so a name planted in a config file meets the
 * same check as one typed on a command line.
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

module.exports = { resolveIdentity, nodeNameProblem };
