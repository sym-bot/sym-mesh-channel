'use strict';

/**
 * The environment every test process and every server a test starts runs with (design D12, review M5).
 *
 * BUILT FROM AN ALLOWLIST, never from the developer's environment: a run started from inside an XMesh
 * mind session carries SYM_INTERIOR_SOCKET and a capability, and a server inheriting them would attach
 * to the REAL node, submit test emissions it signs and sends, and end the real mind on exit (review r9).
 * SYM_IDENTITY_DIR, SYM_NODE_ID and SYM_ALLOWED_PEERS change what a server is in the same way, and
 * Claude Code's own variables change its default name.
 *
 * DANGEROUS_PARENT names the variables whose presence in the parent stops the suite before it starts:
 * a developer who has them set is in exactly the session this must never touch.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const PASS = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'NODE_TEST_CONTEXT', 'MESH_CHANNEL_RUN_STARTED_AT'];
const DANGEROUS_PARENT = /^(SYM_INTERIOR_[A-Z_]*|SYM_IDENTITY_DIR|SYM_NODE_ID|SYM_ALLOWED_PEERS)$/;

/** The names of the variables in `env` that must not be set where tests run. */
function dangerous(env = process.env) {
  return Object.keys(env).filter((k) => DANGEROUS_PARENT.test(k) && env[k] !== undefined && env[k] !== '');
}

function refuseDangerous(env = process.env, who = 'the test suite') {
  const bad = dangerous(env);
  if (bad.length) {
    throw new Error(`${who} refuses to start: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} set in this environment. ` +
      'Run the tests from a shell that is not an XMesh mind or a pinned agent session (unset them first).');
  }
}

/** A child environment: the allowlisted variables of `from`, then `extra`. */
function cleanEnv(extra = {}, from = process.env) {
  const env = {};
  for (const k of PASS) if (from[k] !== undefined) env[k] = from[k];
  return { ...env, ...extra };
}

/** The real home of the user running the suite, whatever HOME says. */
function realHome() {
  try { return os.userInfo().homedir; } catch { return null; }
}

/** Node names and rooms this suite uses: what a leak into the real home would be called. */
const TEST_NAME_RE = /^(alice|bob|carol|issuer|invitee|sender|receiver|upgraded|pinned-real|pinned-ghost|unpinned|outbox-e2e|fetch-surface-test|relay-surface-test|packgate-probe|cog|probe-[ab]|smoke-a|ghost)(-[0-9a-z]+)*$/;

/**
 * What this run left in the real home since `since` (ms): node directories or name-index entries under
 * a test name, relay credentials for a test room, and any mention of a sandbox in ~/.claude.json.
 */
function realHomeTraces(since) {
  const home = realHome();
  if (!home) return [];
  const traces = [];
  const newer = (p) => { try { return fs.statSync(p).mtimeMs >= since; } catch { return false; } };
  const sym = path.join(home, '.sym');
  const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const n of list(path.join(sym, 'nodes'))) if (TEST_NAME_RE.test(n) && newer(path.join(sym, 'nodes', n))) traces.push(`~/.sym/nodes/${n}`);
  for (const f of list(path.join(sym, 'nodes', 'by-name'))) {
    const name = decodeURIComponent(f.replace(/\.json$/, ''));
    if (TEST_NAME_RE.test(name) && newer(path.join(sym, 'nodes', 'by-name', f))) traces.push(`~/.sym/nodes/by-name/${f}`);
  }
  for (const f of list(path.join(sym, 'relays'))) if (/(e2e|relay-surface|withheld|packgate|outbox|upgraded|cog|smoke)/.test(f) && newer(path.join(sym, 'relays', f))) traces.push(`~/.sym/relays/${f}`);
  try {
    const cj = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    if (/mesh-channel-(run|test)-[A-Za-z0-9]{6}/.test(cj)) traces.push('~/.claude.json mentions a test sandbox');
  } catch { /* none */ }
  for (const f of ['settings.json', 'settings.local.json']) {
    try { if (/mesh-channel-(run|test)-/.test(fs.readFileSync(path.join(home, '.claude', f), 'utf8'))) traces.push(`~/.claude/${f} mentions a test sandbox`); } catch { /* none */ }
  }
  return traces;
}

module.exports = { cleanEnv, refuseDangerous, dangerous, realHome, realHomeTraces, TEST_NAME_RE, PASS };
