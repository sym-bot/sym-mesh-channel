'use strict';

// A test-only preload (NODE_OPTIONS=--require): the registry cannot be read in this process.
//
// `start` looks for `claude` in the PATH the system holds NOW, which on Windows is read with `reg.exe query` (claude-bin.js systemPathDirs).
// The end-to-end cases that say "claude is NOT on PATH" or "there is no claude anywhere" built a clean PATH and a clean home, but that query
// still reaches the REAL registry, so on a developer machine that really has Claude Code installed they found it (and, with an npm
// shim whose claude.exe an update had removed, ran it). Node cannot start without the real SystemRoot, so the root is not faked; the query
// is made to fail instead, which `start` treats as "the registry could not be read" and goes on to the install folders.
const cp = require('node:child_process');
const real = cp.spawnSync;
cp.spawnSync = function (command, ...rest) {
  if (/(^|[\\/])reg(\.exe)?$/i.test(String(command))) return { status: 1, signal: null, stdout: '', stderr: 'registry not readable in this test', output: [null, '', ''], pid: 0 };
  return real.call(this, command, ...rest);
};
