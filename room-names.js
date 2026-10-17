'use strict';

/**
 * room-names.js — room names and invite URLs, through the SDK's one grammar.
 *
 * A room is an MMP §5.8 identifier: `[a-z0-9._-]`, 1 to 64 characters (MMP 2.0 update 1), and it is signed
 * into every record and the handshake, so a validator that disagrees with the SDK's by one character means
 * two nodes disagree about whether a room exists. This file keeps no copy of the grammar: it asks the SDK
 * (`rooms.isValidRoom`, which also refuses the one name the grammar admits but §5.1 reserves, `sym`), and
 * only adds the words for a refusal.
 *
 * A room is NOT a Bonjour service type (sym 0.14): every node advertises on `_sym._tcp` with its room in the
 * TXT `room` key and dials only advertisements whose TXT room is its own. This channel therefore builds no
 * per-room service type; the SDK's `roomServiceType` is a legacy mapping it never calls. Invites are sym
 * 0.14's (design D9): they carry the issuer's nodeId and key, which an acceptor pins.
 */

const sdk = require('@sym-bot/sym');
const { fullFingerprint } = require('./key-display.js');

const { isValidRoom } = sdk.rooms;

/** Whether `room` is a room this node may be in: "default", or a §5.8 identifier other than `sym`. */
function isRoom(room) {
  return isValidRoom(room);
}

/** Why a room name was refused, in the reader's terms: the cause that applies, never a wrong one. */
function roomRefusalReason(room) {
  if (typeof room !== 'string' || room === '') return 'a room name cannot be empty';
  if (room === 'sym') {
    return '"sym" is reserved: it is the service name every room is advertised under (_sym._tcp), and earlier releases '
      + 'mapped it to the default room, so a node asking for it would believe it is somewhere specific while it is not. '
      + 'Pick another name, or "default" for the global mesh';
  }
  if (room.length > 64) return `a room name is at most 64 characters (this one is ${room.length})`;
  return 'a room name is 1 to 64 characters from a-z, 0-9, ".", "_" and "-", all lowercase (MMP §5.8), e.g. '
    + '"backend-team" or "acme.prod", or "default" for the global mesh';
}

/**
 * A relay token in any text built from an invite or a relay URL, redacted (review R4-6): `token=<value>` as
 * a query parameter, and a `relay_token` JSON field. An invite is a secret; an error, a status line or a
 * parse result that repeats one hands the token to whatever reads the answer (the model, a transcript,
 * a log).
 */
function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(token=)[^&#\s"'<>]*/gi, '$1<redacted>')
    // a password in a URL's userinfo: ws://user:SECRET@host (0.11.1 review: it was printed as typed)
    .replace(/(\/\/)[^\/\s:@"'<>]+:[^\/\s@"'<>]*@/g, '$1<redacted>@')
    .replace(/("relay_token"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2');
}

/**
 * Why `url` is not a relay URL a node can dial, or null when it is one (R4-3): ws:// or wss://, or http:// or https://
 * (the WebSocket client dials those as ws and wss, and 0.11.0 accepted them; users paste https://), with a host.
 */
function relayUrlProblem(url) {
  if (typeof url !== 'string' || !url.trim()) return 'it is empty';
  let u;
  try { u = new URL(url.trim()); } catch { return /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? 'it does not parse as a URL' : 'it has no ws://, wss://, http:// or https:// scheme'; }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol)) return `its scheme is ${JSON.stringify(u.protocol.replace(/:$/, '').slice(0, 16))}, not ws, wss, http or https`;
  if (!u.hostname) return 'it names no host';
  return null;
}

/** What makes `text` not an invite, in the reader's terms; never the text itself (it may carry a token). */
function inviteShapeHint(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return 'it is empty';
  if (/^<.*>$/s.test(t)) return 'it is wrapped in < >; pass the URL alone';
  if (/\s/.test(t)) return 'it contains a line break or a space (a mail or chat client may have wrapped it; join it into one line)';
  if (t.includes('#')) return 'it has a #fragment, which an invite does not carry';
  if (!/^[a-z][a-z0-9-]+:\/\//i.test(t)) return 'it does not start with sym:// (or an app scheme)';
  return 'it does not have the shape of an invite';
}

/** An invite, parsed by the SDK. `{ error }` for anything that is not one; no error repeats a token (R4-6). */
function parseInviteURL(url) {
  // An invite never holds a space or a line break (every part is URL-encoded); sym's parser would take one
  // wrapped by a mail client, with the break inside the token.
  const p = typeof url === 'string' && /\s/.test(url.trim()) ? { error: 'not an invite URL' } : sdk.invite.parseInvite(url);
  if (p.error) {
    // sym's own words for "not an invite" repeat the first 120 characters of the text, token and all.
    const why = /^not an invite URL/.test(p.error)
      ? `Not an invite URL: ${inviteShapeHint(url)}. (The text is not repeated here: an invite can carry a relay token.)`
      : redactSecrets(p.error);
    return {
      error:
        `${why}\n\nExpected shapes:\n` +
        '  sym://room/{name}?node=…&key=…                        (LAN)\n' +
        '  sym://team/{name}?relay=…&token=…&node=…&key=…        (cross-network via relay)\n' +
        '  melotune://room/{id}/{name}                           (app-specific room)',
    };
  }
  return p;
}

/** An identity key's full fingerprint (`sha256:<hex>`, as sym gives it), the one every line's suffix ends (key-display.js). */
function keyFingerprint(key) {
  return fullFingerprint(key) || '?';
}

module.exports = { isRoom, roomRefusalReason, parseInviteURL, keyFingerprint, redactSecrets, relayUrlProblem, inviteShapeHint };
