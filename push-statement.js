'use strict';

/**
 * push-statement.js — whether pushes reach the model, as the model states it (design D5).
 *
 * The server can see that it wrote a `<channel>` notification. It cannot see whether the model read
 * it: Claude Code may not show channels at all (launched without the development-channels flag
 * naming this server, the feature off for the account, a provider without it), and it does not tell
 * the server. 0.10 and the 0.10.2 branch guessed from Claude Code's launch line, and every review
 * round found another way the guess was wrong. The guess is gone.
 *
 * Instead the server sends one PUSH CHECK: a notification carrying a random code that exists nowhere
 * else. A model that read it can quote the code back through `sym_push_confirm`, and that is a
 * first-hand statement with its evidence attached. A model that never saw it cannot produce the
 * code, so it cannot confirm by accident or by assumption.
 *
 * States:
 *   unconfirmed — no check answered. sym_receive lists every delivery, pushed or not.
 *   confirmed   — the code came back. sym_receive names a pushed delivery instead of repeating it.
 *   stated-off  — the session said pushes do not reach it. sym_receive lists every delivery.
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: a code is read and retyped

function newCode(rand = crypto.randomBytes) {
  const b = rand(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Case, spaces and the dash do not matter when a code is retyped. */
function normal(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function createPushStatement({ now = Date.now, rand } = {}) {
  let state = 'unconfirmed';
  let code = null;
  let sentAt = null;
  let stateAt = null;
  let checksSent = 0;
  const codesIssued = new Set();   // every code this process issued: an older check, answered late, still proves receipt

  return {
    /** Issue a fresh code for a check about to be sent. */
    issue() {
      code = newCode(rand);
      codesIssued.add(normal(code));
      return code;
    },
    /** The check went out (its notification was written). */
    sent() { sentAt = now(); checksSent++; },
    get code() { return code; },

    /**
     * The session's answer. Returns { ok, state, reason? }.
     *   { code }            — confirmed when the code is one this process issued
     *   { reaching: false } — stated off
     */
    answer({ code: given, reaching } = {}) {
      if (reaching === false) {
        state = 'stated-off';
        stateAt = now();
        return { ok: true, state };
      }
      if (given === undefined || given === null || given === '') return { ok: false, state, reason: 'no-code' };
      if (!codesIssued.has(normal(given))) return { ok: false, state, reason: 'wrong-code' };
      state = 'confirmed';
      stateAt = now();
      return { ok: true, state };
    },

    /** True only when the session confirmed, first-hand, that pushes reach it. */
    confirmed() { return state === 'confirmed'; },
    state() { return state; },
    facts() { return { state, stateAt, sentAt, checksSent }; },
  };
}

/** The check's own text. Our words only: it carries no peer text. */
function checkText(code, nodeLabel) {
  return `Push check from the SYM mesh server for ${nodeLabel}. If you can read this, pushes reach you: ` +
    `call sym_push_confirm {"code":"${code}"} once. Until you do, sym_receive lists every delivery, pushed or not.`;
}

/** The sym_status line: only what the session stated, and when. */
function statusLine(p) {
  const f = p.facts();
  const at = f.stateAt ? new Date(f.stateAt).toISOString() : null;
  if (f.state === 'confirmed') {
    return `Push: confirmed by this session at ${at} (it answered a push check's code). sym_receive does not repeat a delivery it pushed; sym_fetch reads one again.`;
  }
  if (f.state === 'stated-off') {
    return `Push: this session stated at ${at} that pushes do not reach it. sym_receive lists every delivery.`;
  }
  const sent = f.sentAt ? `a push check was sent at ${new Date(f.sentAt).toISOString()} and has not been answered` : 'no push check has been sent yet';
  return `Push: not confirmed — ${sent}. This server cannot see whether its <channel> notifications reach you; only you can. ` +
    'If one reached you, call sym_push_confirm with its code; sym_push_confirm {} sends a new check. Until then sym_receive lists every delivery.';
}

module.exports = { createPushStatement, checkText, statusLine, newCode, normal };
