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

/** An invite, parsed by the SDK. `{ error }` for anything that is not one. */
function parseInviteURL(url) {
  const p = sdk.invite.parseInvite(url);
  if (p.error) {
    return {
      error:
        `${p.error}\n\nExpected shapes:\n` +
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

module.exports = { isRoom, roomRefusalReason, parseInviteURL, keyFingerprint };
