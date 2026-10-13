'use strict';

/**
 * room-discovery.js — which rooms are live on this LAN (observation only), and the room beacon.
 *
 * MMP 2.0 update 1, §5.1: every node advertises on ONE service type, `_sym._tcp`, with its room in the TXT
 * `room` key and `mmp=2.0`, and dials only advertisements whose TXT room is its own. sym 0.14 does this for
 * a node built without its own service type, which is how this channel builds it. The per-room type
 * `_<room>._tcp` is the legacy mapping and is neither advertised nor browsed here.
 *
 * What this lists is what the LAN says, so it is data: a TXT room is shown only if it is a room (the SDK's
 * grammar), nothing else of an advertisement is printed (no node name, no key), and the count is by distinct
 * node-id. A node that advertises no `mmp` list containing 2.0 is a 0.13 or older node; it cannot form a Core
 * Secure session with this one, and is counted apart.
 *
 * The room beacon (`_symrooms._tcp`, TXT room and node) is the rendezvous the `sym rooms` command of the sym
 * CLI browses. It is kept for that listing only; it carries no session.
 */

const { isValidRoom } = require('@sym-bot/sym').rooms;

const MAX_ROOMS_SHOWN = 50;

/**
 * A service's TXT as RFC 6763 §6.4 and MMP §5.1 read it: keys case-insensitive, the first occurrence wins,
 * from the raw strings when the browser kept them (bonjour-service 1.4), else from its parsed object.
 */
function txtOf(service) {
  const strings = service && Array.isArray(service.rawTxt)
    ? service.rawTxt.map((s) => (Buffer.isBuffer(s) ? s.toString('utf8') : (typeof s === 'string' ? s : null)))
    : Object.entries((service && service.txt && typeof service.txt === 'object') ? service.txt : {}).map(([k, v]) => `${k}=${v}`);
  const out = new Map();
  for (const str of strings) {
    if (typeof str !== 'string' || str.length === 0 || str[0] === '=') continue;
    const eq = str.indexOf('=');
    const key = (eq === -1 ? str : str.slice(0, eq)).toLowerCase();
    if (out.has(key)) continue;
    out.set(key, eq === -1 ? null : str.slice(eq + 1));
  }
  return out;
}

/** Whether an `mmp` TXT value lists protocol version 2.0 (a comma-separated list, §5.1). */
const lists20 = (mmp) => typeof mmp === 'string' && mmp.split(',').includes('2.0');

/**
 * Group browsed `_sym._tcp` services by TXT room.
 * @returns {{ rooms: {room: string, nodes: number, coreSecure: number}[], noRoom: number, badRoom: number, others: number }}
 *   `rooms`: each valid room with the distinct other nodes advertising it (`coreSecure`: those that list mmp 2.0).
 *   `noRoom`: other nodes advertising no room; `badRoom`: other nodes advertising a room name that is not a
 *   room; `others`: all other nodes seen. The last two are counted, never shown.
 */
function summarizeRooms(services, { ownNodeId = null } = {}) {
  const seen = new Map();                   // node-id (or service name) -> { room, core }
  let badRoom = 0, noRoom = 0;
  for (const s of Array.isArray(services) ? services : []) {
    const txt = txtOf(s);
    const id = txt.get('node-id') || (s && typeof s.name === 'string' ? s.name : null);
    if (!id || id === ownNodeId || seen.has(id)) continue;
    const core = lists20(txt.get('mmp'));
    const room = txt.get('room');
    if (typeof room !== 'string' || room === '') { noRoom++; seen.set(id, { room: null, core }); continue; }
    if (!isValidRoom(room)) { badRoom++; seen.set(id, { room: null, core }); continue; }
    seen.set(id, { room, core });
  }
  const by = new Map();
  for (const { room, core } of seen.values()) {
    if (!room) continue;
    const r = by.get(room) || { room, nodes: 0, coreSecure: 0 };
    r.nodes++; if (core) r.coreSecure++;
    by.set(room, r);
  }
  const rooms = [...by.values()].sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : 0));
  return { rooms, noRoom, badRoom, others: seen.size };
}

/** The text sym_rooms_discover answers with. */
function roomsReport(summary, { ownRoom, ownNodeId }) {
  const lines = [];
  const { rooms } = summary;
  if (!rooms.length) {
    lines.push('No other SYM node is advertising a room on this LAN right now.');
  } else {
    const shown = rooms.slice(0, MAX_ROOMS_SHOWN);
    lines.push(`Rooms advertised on this LAN (_sym._tcp, TXT room), by the other nodes visible now (${rooms.length}):`);
    for (const r of shown) {
      const legacy = r.nodes - r.coreSecure;
      lines.push(`  ${r.room}   ${r.nodes} node(s)${legacy ? ` (${legacy} without mmp 2.0: cannot form a Core Secure session with this node)` : ''}${r.room === ownRoom ? '  (← your current room)' : ''}`);
    }
    if (rooms.length > shown.length) lines.push(`  (+${rooms.length - shown.length} more not listed)`);
    lines.push('', 'To join one, call sym_join_room with room="<name>". A node dials only an advertisement whose TXT room is its own, and the handshake is what admits.');
  }
  if (summary.badRoom || summary.noRoom) {
    lines.push('', `Not listed: ${[summary.badRoom ? `${summary.badRoom} node(s) advertising a room name that is not a room (MMP §5.8)` : '', summary.noRoom ? `${summary.noRoom} node(s) advertising no room` : ''].filter(Boolean).join('; ')}.`);
  }
  lines.push('', `Your node is in room "${ownRoom}"${ownNodeId ? ` (nodeId ${ownNodeId})` : ''}. This only shows rooms with at least one other node online; there is no central directory.`);
  return lines.join('\n');
}

/**
 * A bonjour-service instance whose mDNS failures reach `onError` and are never thrown: given no error
 * callback it throws a failed send from inside the socket's callback, where nothing can catch it (the sym
 * daemon's own beacon died of `send EHOSTUNREACH` that way, September 2026).
 */
function makeBonjour(onError) {
  const { Bonjour } = require('bonjour-service');
  const bonjour = new Bonjour(undefined, onError);
  const mdns = (bonjour.server && bonjour.server.mdns) || bonjour.mdns;
  if (mdns && typeof mdns.on === 'function') mdns.on('error', onError);
  return bonjour;
}

/** Browse `_sym._tcp` for `ms` and resolve with the services seen. Never rejects: `{ error }` says why. */
function browseServices({ ms = 2000, make = makeBonjour } = {}) {
  return new Promise((resolve) => {
    const services = [];
    let bonjour, browser, done = false;
    const finish = (error) => {
      if (done) return; done = true;
      try { if (browser && browser.stop) browser.stop(); } catch { /* */ }
      try { if (bonjour) bonjour.destroy(); } catch { /* */ }
      resolve(error ? { error, services } : { services });
    };
    try {
      bonjour = make((err) => finish(`LAN discovery error: ${err && err.message ? err.message : err}`));
      browser = bonjour.find({ type: 'sym' }, (svc) => { services.push(svc); });
    } catch (e) { return finish(`could not start LAN discovery: ${e && e.message ? e.message : e}`); }
    const t = setTimeout(() => finish(null), ms);
    if (t.unref) t.unref();
  });
}

/** The room beacon: published on start and on a room move, torn down on exit. `log` hears failures. */
function createRoomBeacon({ log = () => {}, make = makeBonjour } = {}) {
  let beacon = null;
  const stop = () => {
    if (!beacon) return;
    const b = beacon; beacon = null;
    try { b.unpublishAll(() => { try { b.destroy(); } catch { /* */ } }); } catch { try { b.destroy(); } catch { /* */ } }
  };
  return {
    publish({ name, port, room }) {
      try {
        stop();
        beacon = make((err) => log(`room beacon: ${err && err.message ? err.message : err}`));
        beacon.publish({ name, type: 'symrooms', port: port || 7777, txt: { room, node: name } });
      } catch (e) { log(`room beacon unavailable: ${e && e.message ? e.message : e}`); }
    },
    stop,
  };
}

module.exports = { txtOf, lists20, summarizeRooms, roomsReport, browseServices, makeBonjour, createRoomBeacon, MAX_ROOMS_SHOWN };
