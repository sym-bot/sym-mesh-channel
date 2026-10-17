'use strict';

// `start` could not find Claude Code on Windows after an update: "'claude' is not recognized as an internal or
// external command". It ran the bare name `claude` through a shell, so it found Claude Code only where THIS
// process's PATH reached; an update or installer that moved Claude Code, a terminal opened before the PATH
// changed, or an alias or function that only the user's own shell defines, all left it unfound although `claude`
// runs in the user's prompt. claude-bin.js looks where Claude Code can be, and says where it looked. The Windows
// cases are decided here with the platform, the environment and the file system injected; the end-to-end cases run
// the real `start` with a stand-in `claude` that is installed but NOT on PATH.

const h = require('./_harness.js'); // sandbox first
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanEnv } = require('./_clean-env.js');
const cb = require('../claude-bin.js');

const SERVER = path.join(__dirname, '..', 'server.js');
const W = { platform: 'win32', homedir: 'C:\\Users\\micha' };
const winEnv = (extra = {}) => ({ USERPROFILE: 'C:\\Users\\micha', LOCALAPPDATA: 'C:\\Users\\micha\\AppData\\Local', APPDATA: 'C:\\Users\\micha\\AppData\\Roaming', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.PS1', PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs', ...extra });
const files = (...list) => { const set = new Set(list.map((p) => p.toLowerCase())); return (p) => set.has(String(p).toLowerCase()); };
// what `reg query HKCU\Environment /v Path` prints
const regOut = (value, type = 'REG_EXPAND_SZ') => ({ status: 0, stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${type}    ${value}\r\n\r\n` });
const regRunner = (user, machine) => (command, args) => {
  assert.match(command, /^C:\\Windows\\System32\\reg\.exe$/i, 'reg.exe by absolute path: a bare name is searched in the current folder first on Windows');
  if (args[1] === 'HKCU\\Environment') return user === null ? { status: 1, stdout: '' } : regOut(user);
  return machine === null ? { status: 1, stdout: '' } : regOut(machine);
};

test('a claude on this process PATH is used as it is, and nothing else is consulted', () => {
  const exe = 'C:\\Tools\\claude.exe';
  let regCalls = 0;
  const r = cb.resolveClaude({ ...W, env: winEnv({ PATH: 'C:\\Windows;C:\\Tools' }), exists: files(exe), run: () => { regCalls++; return { status: 1, stdout: '' }; } });
  assert.deepStrictEqual({ path: r.path, source: r.source }, { path: exe, source: 'PATH' });
  assert.strictEqual(regCalls, 0, 'the registry is read only when PATH had nothing');
});

test('an npm .cmd shim is found by PATHEXT; a bare `claude` file or a .ps1 cannot be started and are not taken', () => {
  const cmd = 'C:\\Users\\micha\\AppData\\Roaming\\npm\\claude.cmd';
  const env = winEnv({ PATH: 'C:\\Windows;C:\\Users\\micha\\AppData\\Roaming\\npm' });
  assert.strictEqual(cb.resolveClaude({ ...W, env, exists: files(cmd) }).path, cmd);
  const noise = files('C:\\Users\\micha\\AppData\\Roaming\\npm\\claude', 'C:\\Users\\micha\\AppData\\Roaming\\npm\\claude.ps1');
  assert.strictEqual(cb.resolveClaude({ ...W, env, exists: noise, run: () => ({ status: 1, stdout: '' }) }).path, null);
});

test('THE REPORTED CASE: this terminal\'s PATH is stale, the system PATH has the new folder: found there', () => {
  // Claude Code moved to the native install; the installer put %USERPROFILE%\.local\bin on the user PATH in the
  // registry; the terminal and the npx process started from it never saw it.
  const exe = 'C:\\Users\\micha\\.local\\bin\\claude.exe';
  const r = cb.resolveClaude({ ...W, env: winEnv(), exists: files(exe), run: regRunner('C:\\Users\\micha\\AppData\\Roaming\\npm;%USERPROFILE%\\.local\\bin', 'C:\\Windows') });
  assert.strictEqual(r.path, exe, '%USERPROFILE% in the registry value is expanded');
  assert.match(r.source, /system PATH/);
});

test('an alias or a function (invisible to a program the shell starts) is not needed: the install folder is searched', () => {
  const exe = 'C:\\Users\\micha\\.local\\bin\\claude.exe';
  const r = cb.resolveClaude({ ...W, env: winEnv(), exists: files(exe), run: regRunner(null, null) });
  assert.deepStrictEqual({ path: r.path, source: r.source }, { path: exe, source: 'an install folder' });
  const local = 'C:\\Users\\micha\\.claude\\local\\claude.cmd';
  assert.strictEqual(cb.resolveClaude({ ...W, env: winEnv(), exists: files(local), run: regRunner(null, null) }).path, local);
});

test('SYM_CLAUDE_BIN wins; set wrongly it is an error, never a silent fall-through to another claude', () => {
  const mine = 'D:\\apps\\claude.exe';
  const other = 'C:\\Tools\\claude.exe';
  const env = winEnv({ PATH: 'C:\\Tools', SYM_CLAUDE_BIN: mine });
  assert.strictEqual(cb.resolveClaude({ ...W, env, exists: files(mine, other) }).path, mine);
  const bad = cb.resolveClaude({ ...W, env, exists: files(other) });
  assert.strictEqual(bad.path, null, 'a claude on PATH was used although the operator named another');
  assert.strictEqual(bad.override, mine);
  assert.match(cb.notFoundMessage(bad, { platform: 'win32' }), /SYM_CLAUDE_BIN is set to D:\\apps\\claude\.exe, which was not found as an executable file/);
  assert.strictEqual(cb.resolveClaude({ ...W, env: winEnv({ SYM_CLAUDE_BIN: '"D:\\apps\\claude.exe"' }), exists: files(mine) }).path, mine, 'quotes around the value are ignored');
});

test('CLAUDE_CODE_EXECPATH is the last resort: a launcher on PATH or in an install folder beats a versioned file an update may have removed', () => {
  const versioned = 'C:\\Users\\micha\\AppData\\Local\\claude\\versions\\2.1.302\\claude.exe';
  const launcher = 'C:\\Users\\micha\\.local\\bin\\claude.exe';
  const env = winEnv({ CLAUDE_CODE_EXECPATH: versioned });
  assert.strictEqual(cb.resolveClaude({ ...W, env, exists: files(versioned, launcher), run: regRunner(null, null) }).path, launcher);
  assert.strictEqual(cb.resolveClaude({ ...W, env, exists: files(versioned), run: regRunner(null, null) }).path, versioned);
});

test('POSIX: the exact name, executable, on PATH; then ~/.local/bin and the other install folders', () => {
  const env = { PATH: '/usr/bin:/bin' };
  const isExec = (set) => (p) => set.includes(p);
  assert.strictEqual(cb.resolveClaude({ platform: 'linux', env: { PATH: '/opt/x:/usr/bin' }, homedir: '/home/u', exists: isExec(['/opt/x/claude']) }).path, '/opt/x/claude');
  const r = cb.resolveClaude({ platform: 'darwin', env, homedir: '/Users/u', exists: isExec(['/Users/u/.local/bin/claude']) });
  assert.deepStrictEqual({ path: r.path, source: r.source }, { path: '/Users/u/.local/bin/claude', source: 'an install folder' });
  assert.strictEqual(cb.resolveClaude({ platform: 'linux', env, homedir: '/home/u', exists: () => false }).path, null);
});

test('not found: the message lists where it looked and the three ways out; Windows names Get-Command and the alias trap', () => {
  const r = cb.resolveClaude({ ...W, env: winEnv(), exists: () => false, run: regRunner('C:\\x', 'C:\\y') });
  assert.strictEqual(r.path, null);
  const text = cb.notFoundMessage(r, { platform: 'win32' });
  for (const must of ['could not find the `claude` command', 'PATH (2 folders)', 'the system PATH from the registry (2 folders)', '.local\\bin\\claude.exe', 'Get-Command claude', 'Alias or Function', '$env:SYM_CLAUDE_BIN', 'NEW terminal']) assert.ok(text.includes(must), `missing: ${must}\n${text}`);
  const posix = cb.notFoundMessage(cb.resolveClaude({ platform: 'linux', env: { PATH: '/bin' }, homedir: '/home/u', exists: () => false }), { platform: 'linux' });
  assert.ok(posix.includes('command -v claude') && posix.includes('SYM_CLAUDE_BIN=/path/to/claude'));
});

test('the registry is read from both hives, skips a hive it cannot read, and never on another platform', () => {
  const dirs = cb.systemPathDirs({ platform: 'win32', env: winEnv(), run: regRunner('C:\\u1;"C:\\u 2"', null) });
  assert.deepStrictEqual(dirs, ['C:\\u1', 'C:\\u 2']);
  assert.deepStrictEqual(cb.systemPathDirs({ platform: 'win32', env: winEnv(), run: () => { throw new Error('reg.exe missing'); } }), []);
  assert.deepStrictEqual(cb.systemPathDirs({ platform: 'linux', env: {}, run: () => assert.fail('reg ran on linux') }), []);
  assert.strictEqual(cb.expandWindowsVars('%userprofile%\\a;%NOPE%', { USERPROFILE: 'C:\\U' }), 'C:\\U\\a;%NOPE%');
});

test('launching: a .exe or POSIX file directly with no shell; an npm .cmd through cmd.exe, escaped for both parsers', () => {
  assert.deepStrictEqual(cb.launchSpec('C:\\a b\\claude.exe', ['--x', 'server:y'], { platform: 'win32' }), { command: 'C:\\a b\\claude.exe', args: ['--x', 'server:y'], options: { shell: false } });
  assert.deepStrictEqual(cb.launchSpec('/Users/u/.local/bin/claude', ['--resume'], { platform: 'darwin' }), { command: '/Users/u/.local/bin/claude', args: ['--resume'], options: { shell: false } });
  const s = cb.launchSpec('C:\\Users\\micha\\AppData\\Roaming\\npm\\claude.cmd', ['--dangerously-load-development-channels', 'server:claude-sym-mesh'], { platform: 'win32' });
  assert.strictEqual(s.options.shell, true);
  assert.deepStrictEqual(s.args, []);
  assert.strictEqual(s.command, 'C:\\Users\\micha\\AppData\\Roaming\\npm\\claude.cmd ^^^"--dangerously-load-development-channels^^^" ^^^"server:claude-sym-mesh^^^"');
  assert.strictEqual(cb.launchSpec('C:\\Program Files\\x\\claude.bat', [], { platform: 'win32' }).command, 'C:\\Program^ Files\\x\\claude.bat', 'a space in the program path is caret-escaped (it is not quoted)');
});

test('cmd.exe escaping: the C-runtime rules (quotes, trailing backslashes) then the cmd metacharacters, twice for a shim that forwards %*', () => {
  const e = (a, doubleEscape = false) => cb.escapeCmdArgument(a, { doubleEscape });
  assert.strictEqual(e('plain'), '^"plain^"');
  assert.strictEqual(e(''), '^"^"');
  assert.strictEqual(e('a b'), '^"a^ b^"');
  assert.strictEqual(e('C:\\My Projects\\'), '^"C:\\My^ Projects\\\\^"', 'a trailing backslash is doubled so it cannot escape the closing quote');
  assert.strictEqual(e('say "hi"'), '^"say^ \\^"hi\\^"^"', 'a quote is escaped for the C runtime, and its caret for cmd.exe');
  assert.strictEqual(e('back\\slash'), '^"back\\slash^"', 'a backslash not before a quote is literal');
  for (const [raw, want] of [['100%', '%'], ['%PATH%', '%'], ['a&b', '&'], ['x^y', '^'], ['!bang', '!'], ['(p)', '(']]) assert.ok(e(raw).includes(`^${want}`), `${raw}: ${want} is caret-escaped`);
  assert.strictEqual(e('a b', true), '^^^"a^^^ b^^^"');
});

test('SYM_CLAUDE_BIN may be a path, a path without its extension (Windows), or a bare name looked up on PATH', () => {
  const real = 'D:\\apps\\claude.exe';
  const r = cb.resolveClaude({ ...W, env: winEnv({ SYM_CLAUDE_BIN: 'D:\\apps\\claude' }), exists: files(real) });
  assert.deepStrictEqual({ path: r.path, source: r.source }, { path: real, source: 'SYM_CLAUDE_BIN' });
  const dev = '/opt/dev/claude-dev';
  assert.strictEqual(cb.resolveClaude({ platform: 'linux', env: { PATH: '/opt/dev:/usr/bin', SYM_CLAUDE_BIN: 'claude-dev' }, homedir: '/h', exists: (p) => p === dev }).path, dev);
  assert.strictEqual(cb.resolveClaude({ platform: 'linux', env: { PATH: '/usr/bin', SYM_CLAUDE_BIN: 'claude-dev' }, homedir: '/h', exists: () => false }).override, 'claude-dev');
});

// ── the real `start`, end to end (POSIX: the stand-in is a shell script) ──
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX stand-in' : false };

function runStart(args, { home, binDirs = [], extraEnv = {} }) {
  const env = cleanEnv({ HOME: home, USERPROFILE: home, SYM_STATE_DIR: path.join(home, '.sym'), PATH: [...binDirs, '/usr/bin', '/bin'].join(path.delimiter), ...extraEnv });
  const cwd = fs.mkdtempSync(path.join(home, 'proj-'));
  return { cwd, r: spawnSync(process.execPath, [SERVER, 'start', ...args], { cwd, env, encoding: 'utf8', timeout: 60000 }) };
}
function standIn(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'claude');
  fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nexit 7\n`, { mode: 0o755 });
  return f;
}

test('start: claude installed in ~/.local/bin but NOT on PATH is found and launched with the channels flag', posixOnly, () => {
  const home = h.stateDir('home');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n', { mode: 0o600 });
  const record = path.join(home, 'argv.txt');
  const bin = standIn(path.join(home, '.local', 'bin'), record);
  const { r } = runStart(['--room', 'xmesh-world-room'], { home });
  assert.strictEqual(r.status, 7, `the stand-in's exit code is passed on; got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.deepStrictEqual(fs.readFileSync(record, 'utf8').trim().split('\n'), ['--dangerously-load-development-channels', 'server:claude-sym-mesh']);
  assert.ok(r.stdout.includes(`claude found at ${bin}`) && r.stdout.includes('an install folder'), `the launch says where claude was found:\n${r.stdout}`);
});

test('start: a claude on PATH is used without a "found at" note, and arguments after -- are passed on', posixOnly, () => {
  const home = h.stateDir('home');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n', { mode: 0o600 });
  const record = path.join(home, 'argv.txt');
  const bindir = path.join(home, 'onpath');
  standIn(bindir, record);
  const { r } = runStart(['--room', 'xmesh-world-room', '--', '--resume'], { home, binDirs: [bindir] });
  assert.strictEqual(r.status, 7);
  assert.deepStrictEqual(fs.readFileSync(record, 'utf8').trim().split('\n'), ['--dangerously-load-development-channels', 'server:claude-sym-mesh', '--resume']);
  assert.ok(!r.stdout.includes('claude found at'), r.stdout);
});

test('start: SYM_CLAUDE_BIN names the claude to run; a wrong one stops with a clear error and starts nothing', posixOnly, () => {
  const home = h.stateDir('home');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n', { mode: 0o600 });
  const record = path.join(home, 'argv.txt');
  const mine = standIn(path.join(home, 'elsewhere'), record);
  const good = runStart(['--room', 'xmesh-world-room'], { home, extraEnv: { SYM_CLAUDE_BIN: mine } });
  assert.strictEqual(good.r.status, 7, good.r.stderr);
  assert.ok(good.r.stdout.includes('from SYM_CLAUDE_BIN'));
  fs.rmSync(record);
  standIn(path.join(home, '.local', 'bin'), record); // a claude exists in an install folder: the wrong override must NOT fall through to it
  const bad = runStart(['--room', 'xmesh-world-room'], { home, extraEnv: { SYM_CLAUDE_BIN: path.join(home, 'nope', 'claude') } });
  assert.strictEqual(bad.r.status, 127);
  assert.match(bad.r.stderr, /SYM_CLAUDE_BIN is set to .*nope.*which was not found as an executable file/);
  assert.ok(!fs.existsSync(record), 'a claude was started although the operator named another');
});

test('start: a claude killed by a signal makes start exit 128+signal, never 0 (0.11.1 review)', posixOnly, () => {
  const home = h.stateDir('home');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n', { mode: 0o600 });
  const dir = path.join(home, '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
  const { r } = runStart(['--room', 'xmesh-world-room'], { home });
  assert.strictEqual(r.status, 143, `SIGTERM is 15, so 128+15; got ${r.status} ${r.signal}\n${r.stderr}`);
});

// The fixed system folders are searched too, so this case only exists on a machine with no claude in any of them.
const hostHasClaude = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'].some((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
const noHostClaude = { skip: process.platform === 'win32' ? 'POSIX stand-in' : hostHasClaude ? 'this machine has a claude in a system folder (the unit tests cover the message)' : false };

test('start: no claude anywhere exits 127 with where it looked and how to fix it', noHostClaude, () => {
  const home = h.stateDir('home');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n', { mode: 0o600 });
  const { r } = runStart(['--room', 'xmesh-world-room'], { home });
  assert.strictEqual(r.status, 127, `${r.stdout}\n${r.stderr}`);
  for (const must of ['could not find the `claude` command', '.local/bin/claude', 'SYM_CLAUDE_BIN=/path/to/claude']) assert.ok(r.stderr.includes(must), `missing ${must}\n${r.stderr}`);
});

// ── REAL Windows (skipped elsewhere; run by the Windows job in .github/workflows/claude-bin.yml) ──
// Everything above decides Windows behaviour with the platform injected. These run it for real: the real registry,
// the real cmd.exe, a real npm-style claude.cmd, in a home folder whose name has a space in it.
const winOnly = { skip: process.platform === 'win32' ? false : 'Windows only' };

test('Windows: `reg query` of the real registry parses into the folders a new terminal would have', winOnly, () => {
  const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const dirs = cb.systemPathDirs({ platform: 'win32', env: process.env, run });
  assert.ok(dirs.length > 0, 'no folder came back from the registry PATH');
  assert.ok(dirs.some((d) => /system32$/i.test(d)), `the machine PATH always holds System32; got ${dirs.slice(0, 6).join(' | ')}`);
  assert.ok(dirs.every((d) => !d.includes('%')), 'a %VAR% in the registry value was left unexpanded');
});

test('Windows: start launches an npm-style claude.cmd that is NOT on PATH, from a folder with a space, every argument intact', winOnly, () => {
  const base = h.stateDir('home');
  const home = path.join(base, 'home dir');
  fs.mkdirSync(path.join(home, '.claude', 'local'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n');
  const bin = path.join(home, '.claude', 'local');
  // the shape of an npm shim: it forwards its arguments with %* to node, which records exactly what it received
  fs.writeFileSync(path.join(bin, 'print-args.js'), "require('fs').writeFileSync(require('path').join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0print-args.js" %*\r\nexit /b 7\r\n`);
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const env = cleanEnv({ HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), SYM_STATE_DIR: path.join(home, '.sym'), PATH: `${sys}\\System32;${sys}` });
  const cwd = fs.mkdtempSync(path.join(home, 'proj-'));
  const nasty = ['a b', 'C:\\My Projects\\', 'say "hi"', '100%', '%PATH%', 'a&b', 'x^y', '!bang', '(paren)', 'back\\slash', 'a|b', 'x<y>z'];
  const r = spawnSync(process.execPath, [SERVER, 'start', '--room', 'xmesh-world-room', '--', ...nasty], { cwd, env, encoding: 'utf8', timeout: 90000 });
  assert.strictEqual(r.status, 7, `the shim's exit code is passed on; got ${r.status}\n${r.stdout}\n${r.stderr}`);
  const got = JSON.parse(fs.readFileSync(path.join(bin, 'argv.json'), 'utf8'));
  assert.deepStrictEqual(got, ['--dangerously-load-development-channels', 'server:claude-sym-mesh', ...nasty], 'every argument reaches claude exactly as typed');
  assert.ok(/claude found at .*claude\.cmd, from an install folder/.test(r.stdout), r.stdout);
});

test('Windows: a native claude.exe in ~/.local/bin that is NOT on PATH is found and started directly', winOnly, () => {
  const home = path.join(h.stateDir('home'), 'home dir');
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n');
  // a real .exe: node itself, copied. Started with the channels flag it refuses it as a bad option, which proves it was started with our arguments.
  fs.copyFileSync(process.execPath, path.join(bin, 'claude.exe'));
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const env = cleanEnv({ HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), SYM_STATE_DIR: path.join(home, '.sym'), PATH: `${sys}\\System32;${sys}` });
  const cwd = fs.mkdtempSync(path.join(home, 'proj-'));
  const r = spawnSync(process.execPath, [SERVER, 'start', '--room', 'xmesh-world-room'], { cwd, env, encoding: 'utf8', timeout: 90000 });
  assert.ok(/claude found at .*\.local\\bin\\claude\.exe, from an install folder/.test(r.stdout), r.stdout);
  assert.notStrictEqual(r.status, 127, `claude.exe was found and started: ${r.stdout}\n${r.stderr}`);
  assert.ok(/bad option: --dangerously-load-development-channels/.test(`${r.stdout}${r.stderr}`), `the exe was started with the channels flag:\n${r.stdout}\n${r.stderr}`);
});

test('Windows: start with no claude anywhere exits 127 and names Get-Command and SYM_CLAUDE_BIN', winOnly, () => {
  const home = h.stateDir('home');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}\n');
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const env = cleanEnv({ HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), SYM_STATE_DIR: path.join(home, '.sym'), PATH: `${sys}\\System32;${sys}` });
  const cwd = fs.mkdtempSync(path.join(home, 'proj-'));
  const r = spawnSync(process.execPath, [SERVER, 'start', '--room', 'xmesh-world-room'], { cwd, env, encoding: 'utf8', timeout: 90000 });
  assert.strictEqual(r.status, 127, `${r.stdout}\n${r.stderr}`);
  for (const must of ['could not find the `claude` command', 'Get-Command claude', '$env:SYM_CLAUDE_BIN']) assert.ok(r.stderr.includes(must), `missing ${must}\n${r.stderr}`);
});
