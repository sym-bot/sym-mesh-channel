'use strict';

/**
 * Where a relay credential lives between restarts.
 *
 * A relay join used to live only in the MCP server's memory: quit Claude Code on the home
 * Mac, reopen it, and the node was LAN-only again while the session on the road saw
 * "0 relay peer(s)" and no error. The invite path (mint → paste → join) had no persistent
 * end, so the on-the-road ↔ home case broke at the first restart.
 *
 * The credential is stored per ROOM, under the engine's state root — never in the project:
 * `.sym/node.json` is committed with the repo, and a token in a repo is a leak waiting for a
 * push. `<SYM_STATE_DIR|~/.sym>/relays/<room>.json`, mode 0600, holds `relay_url` and
 * `relay_token`; the room name is the key, so a project that pins its room in node.json
 * re-joins the same channel on every start with nothing else configured. Env
 * (SYM_RELAY_URL / SYM_RELAY_TOKEN) still wins when set — explicit configuration is not
 * overridden by a remembered one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function relaysDir() {
  return path.join(process.env.SYM_STATE_DIR || path.join(os.homedir(), '.sym'), 'relays');
}

// The room is a path segment. Rooms are validated kebab-case before they get here, but the
// store must not be the place that trusts that.
function fileFor(room) {
  if (typeof room !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(room)) return null;
  return path.join(relaysDir(), `${room}.json`);
}

/** The remembered credential for a room, or null. Never throws; a malformed file is null. */
function loadRelay(room) {
  const file = fileFor(room);
  if (!file) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof cfg.relay_url !== 'string' || !cfg.relay_url) return null;
    return { relay_url: cfg.relay_url, relay_token: typeof cfg.relay_token === 'string' ? cfg.relay_token : null, saved_at: cfg.saved_at || null, file };
  } catch {
    return null;
  }
}

/** Remember a credential for a room. Atomic, 0600. Returns the file path, or null if it could not be written. */
function saveRelay(room, { relay_url, relay_token }) {
  const file = fileFor(room);
  if (!file || !relay_url) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ relay_url, relay_token: relay_token || null, saved_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

/** Forget a room's credential. True if something was removed. */
function forgetRelay(room) {
  const file = fileFor(room);
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

module.exports = { loadRelay, saveRelay, forgetRelay, relaysDir };
