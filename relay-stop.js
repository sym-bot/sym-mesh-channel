'use strict';

/**
 * relay-stop.js — what this channel says when the relay closes this node's connection because another
 * connection claims its nodeId (review R4-1): 4004 "replaced", 4006 "duplicate rejected".
 *
 * relay-auth carries no key proof, so anyone holding the relay token can cause one, by authenticating as
 * this node's (public) nodeId. Until 0.11.1 the server exited with code 2 on it, which handed that token
 * holder every mesh tool of the session, LAN included. The server and its LAN node now stay up, and the
 * stop is said: on stderr, in ONE push, once in the next tool answer, and in sym_status while it lasts.
 *
 * sym's event differs by version, and both are read as they come:
 *   - sym 0.14.2 raises `identity-collision` once per relay connection and never dials again
 *     (relayState().nextRetryAt is null);
 *   - sym 0.14.3 raises it at the first close of an episode, retries on a long backoff (1 min, doubling
 *     to 30 min), and raises it again with `pingPong: true` when three closes in 30 min say two
 *     processes are replacing each other.
 * A stop is pushed once; the same stop again within `repeatMs` is said on stderr only; a newly found
 * ping-pong is always pushed.
 */

const STOP_WORDS = {
  4004: 'replaced: another connection authenticated as this node\'s nodeId',
  4006: 'refused as a duplicate: another connection already holds this node\'s nodeId',
};

/**
 * @param {object} o
 * @param {function(): object|null} o.relayState — sym's status().relayState now (null without a node)
 * @param {function(): string} o.room — the room this node is in now
 * @param {function(string, string, object): void} o.push — a channel push (event type, line, meta)
 * @param {function(string, string): void} o.advise — a line said once in the next tool answer
 * @param {function(string): void} [o.log] — stderr
 * @param {function(): string} [o.relayName] — the relay as a log line may name it (redacted)
 */
function createRelayStops({ relayState, room, push, advise, log = () => {}, relayName = () => 'the relay', repeatMs = 10 * 60_000, defer = setImmediate, now = Date.now } = {}) {
  let stop = null;   // { code, kind, at, pushedAt, pingPong, retryInMs }

  function state() { try { return relayState() || null; } catch { return null; } }

  /** What sym does next, from its own relay state. */
  function retryWords() {
    const st = state();
    if (st && st.phase === 'connected') return 'The relay is connected again.';
    if (st && (st.nextRetryAt || st.phase === 'reconnecting' || st.phase === 'connecting' || st.phase === 'authenticating')) {
      return `sym dials the relay again on its own${st.nextRetryAt ? ` (next attempt in ${Math.max(0, Math.round((st.nextRetryAt - now()) / 1000))} s)` : ''}; ` +
        `sym_join_room {room: "${room()}"} dials it now.`;
    }
    return `sym does not dial the relay again on its own after this close: sym_join_room {room: "${room()}"} dials it again (or restart this MCP server); ` +
      'if the other connection is another process of this agent, stop that one first.';
  }

  /** The stop in words, or null when there is none. */
  function line() {
    if (!stop) return null;
    if (stop.pingPong) {
      const st = state();
      const closes = st && st.stopped && Number.isInteger(st.stopped.closes) ? st.stopped.closes : null;
      return 'MESH RELAY ADVISORY: PING-PONG suspected: the relay keeps closing this node\'s connection because another connection claims its nodeId ' +
        `(code ${stop.code}${closes ? `, ${closes} times in 30 min` : ''}). Another process is probably running as this agent, with the same identity, and the two ` +
        'replace each other on the relay; stop one of them (sym_status in each says its nodeId). A holder of the relay token can also do this on purpose: ' +
        `the relay's authentication carries no key proof. This server and its LAN node keep running; nothing crosses the relay meanwhile. ${retryWords()}`;
    }
    const what = STOP_WORDS[stop.code] || `stopped (code ${stop.code})`;
    return `MESH RELAY ADVISORY: the relay closed this node's connection, ${what} (code ${stop.code}). That may be another process ` +
      'of this agent, or anyone holding the relay token: the relay\'s authentication carries no key proof, so a token is enough to do this. ' +
      'Nothing is accepted in this node\'s name by that (every session must prove this node\'s key). This server and its LAN node keep running ' +
      `and LAN peers are unaffected; nothing crosses the relay meanwhile. ${retryWords()}`;
  }

  /** sym's `identity-collision` event. */
  function onStop(info) {
    const code = Number.isInteger(info && info.code) ? info.code : 4004;
    const pingPong = !!(info && info.pingPong === true);
    const t = now();
    const again = !!stop && stop.code === code && !!stop.pushedAt && t - stop.pushedAt < repeatMs && !(pingPong && !stop.pingPong);
    stop = {
      code, kind: info && typeof info.kind === 'string' ? info.kind.slice(0, 32) : null, at: t,
      pushedAt: again ? stop.pushedAt : t, pingPong: pingPong || (again && stop.pingPong),
      retryInMs: info && Number.isFinite(info.retryInMs) ? info.retryInMs : null,
    };
    log(`relay stop (code ${code}${pingPong ? ', ping-pong suspected' : ''}): another connection claims this node's identity on ${relayName()}. ` +
      'The server and its LAN node keep running; sym_status says whether sym dials the relay again.');
    if (again) return false;
    // Said once sym has finished its own handling of the close (it schedules its retry after the
    // event), so the words say what it does next.
    defer(() => {
      const l = line();
      advise('relay-stop', l);
      push('relay-stopped', l, { code: String(code), ping_pong: pingPong ? 'yes' : 'no' });
    });
    return true;
  }

  return { onStop, line, current: () => stop, reset: () => { stop = null; } };
}

module.exports = { createRelayStops, STOP_WORDS };
