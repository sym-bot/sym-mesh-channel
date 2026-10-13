'use strict';

// The suite's last file (run.js runs files in name order): nothing this run did reached the real home
// (design D12, review M5). Every file ran with HOME, USERPROFILE and SYM_STATE_DIR in a temp dir and an
// allowlisted environment; this checks the result in the REAL ~/.sym and ~/.claude, found through the
// OS user record rather than HOME: no node directory or name-index entry under a name this suite uses,
// no relay credential for one of its rooms, and no mention of a test sandbox in Claude Code's files,
// written since the run started.

const { test } = require('node:test');
const assert = require('node:assert');
const { realHome, realHomeTraces, refuseDangerous } = require('./_clean-env.js');

test('the real ~/.sym and ~/.claude carry nothing this run wrote', () => {
  refuseDangerous();
  const home = realHome();
  assert.ok(home, 'the real home is known');
  assert.notStrictEqual(require('os').homedir(), home, 'this file itself runs with a sandboxed HOME');
  const since = Number(process.env.MESH_CHANNEL_RUN_STARTED_AT) || Date.now() - 24 * 3600 * 1000;
  const traces = realHomeTraces(since);
  assert.deepStrictEqual(traces, [], `the run reached the real home: ${traces.join(', ')}`);
});
