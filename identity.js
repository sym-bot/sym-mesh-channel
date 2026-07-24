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
//   - PINNED (SYM_NODE_NAME or .sym/node.json): used verbatim, autoSuffix OFF — the engine reclaims a
//     dead holder's stale lock and only hard-fails (EIDENTITYLOCK) on a genuinely live holder.
//   - UNPINNED session: the caller's default name with autoSuffix ON, so a real collision is resolved
//     by the engine's start-time-verified resolver.

/**
 * @param {{ pinnedName?: string|null, defaultName: string }} opts
 * @returns {{ name: string, autoSuffix: boolean, pinned: boolean }}
 */
function resolveIdentity({ pinnedName, defaultName } = {}) {
  const pinned = (typeof pinnedName === 'string' && pinnedName.trim()) ? pinnedName.trim() : null;
  if (pinned) return { name: pinned, autoSuffix: false, pinned: true };
  return { name: defaultName, autoSuffix: true, pinned: false };
}

module.exports = { resolveIdentity };
