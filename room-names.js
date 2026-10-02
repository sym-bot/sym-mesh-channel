'use strict';

/**
 * room-names.js — room names and invite URLs, through the SDK's one grammar.
 *
 * A room name IS the Bonjour service type (MMP §5.8), so a validator that disagrees with the SDK's by
 * one character means two nodes disagree about whether a room exists. This file keeps no copy of the
 * grammar: it asks the SDK (`rooms`, `invite`), and only adds the words for a refusal. Invites are
 * sym 0.14's (design D9): they carry the issuer's nodeId and key, which an acceptor pins.
 */

const crypto = require('crypto');
const sdk = require('@sym-bot/sym');

const { isValidRoom, roomServiceType, serviceTypeToRoom, KEBAB_CASE_RE } = sdk.rooms;

/** A room name is canonical: one name per room, one room per name (the SDK's mapping, both ways). */
function isCanonicalRoom(room) {
  return isValidRoom(room) && serviceTypeToRoom(roomServiceType(room)) === room;
}

/** Why a room name was refused, in the reader's terms: the cause that applies, never a wrong one. */
function roomRefusalReason(room) {
  if (typeof room !== 'string' || room === '') return 'a room name cannot be empty';
  const grammatical = room === 'default' || KEBAB_CASE_RE.test(room);
  if (!grammatical) {
    return 'must be lowercase alphanumerics in segments joined by single or double hyphens '
      + '(e.g. "backend-team", or "x-review--team-<id>" for a tenant-scoped room), or "default"';
  }
  const collidesWith = serviceTypeToRoom(roomServiceType(room));
  if (collidesWith !== room) {
    return `it resolves to ${roomServiceType(room)}, which is the room "${collidesWith}" — `
      + `"${room}" is a second name for it, so joining it would put this node in "${collidesWith}" `
      + 'while reporting otherwise. Room names must be canonical: one name per room';
  }
  return 'it is not a room name this build accepts';
}

/** An invite, parsed by the SDK, with its service type. `{ error }` for anything that is not one. */
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
  return { ...p, serviceType: roomServiceType(p.room) };
}

/** A short fingerprint of an identity key, for lines a person compares. */
function keyFingerprint(key) {
  if (typeof key !== 'string' || !key) return '?';
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

module.exports = { isCanonicalRoom, roomRefusalReason, parseInviteURL, keyFingerprint, roomServiceType, serviceTypeToRoom };
