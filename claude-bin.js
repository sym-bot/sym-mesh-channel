'use strict';

/**
 * Where is the `claude` CLI, and how is it launched? Used by `sym-mesh-channel start`.
 *
 * `start` used to run the bare name `claude` and let the shell find it. That breaks exactly when the CLI is
 * somewhere the PATH of THIS process does not reach, which is common on Windows and happens on macOS and
 * Linux too:
 *   - an installer or auto-update moved Claude Code (an npm global install to the native one, a new folder)
 *     and put the new folder on the USER PATH in the registry; a terminal that was already open, and so every
 *     process started from it (npx, node), keeps the old PATH until a new terminal is opened;
 *   - `claude` works in the user's own shell because the shell defines an alias or a function for it, which a
 *     child process never sees;
 *   - the folder was never on PATH at all (the native installer's ~/.local/bin on a machine where that is
 *     not on PATH).
 * The answer is to find the binary ourselves, from the places it can be, and to say where we looked when we
 * cannot. The order, first hit wins:
 *   1. SYM_CLAUDE_BIN, the operator's explicit choice. If it is set and wrong that is an error, never a
 *      silent fall-through to something else.
 *   2. this process's PATH;
 *   3. Windows only: the PATH the system holds NOW (the registry's user and machine PATH), which is what a
 *      new terminal would have;
 *   4. the folders Claude Code installs into;
 *   5. CLAUDE_CODE_EXECPATH, the binary of a Claude Code session we are running inside. Last on purpose:
 *      it can name a versioned file that an update has since removed, while the launcher on PATH does not.
 *
 * Nothing here runs a shell, `where` or `npm`: a file is looked for, as a file, in a list of folders.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** What Windows runs from a name with no extension: PATHEXT, restricted to what can be started directly. */
const WINDOWS_EXTS_DEFAULT = ['.COM', '.EXE', '.BAT', '.CMD'];

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isExecutableFile = (p) => { try { if (!fs.statSync(p).isFile()) return false; fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };

/** `%NAME%` references in a registry value, expanded from env (a name with no value is left as written). */
function expandWindowsVars(value, env) {
  const upper = {};
  for (const k of Object.keys(env)) upper[k.toUpperCase()] = env[k];
  return String(value).replace(/%([^%]+)%/g, (all, name) => (upper[name.toUpperCase()] !== undefined ? upper[name.toUpperCase()] : all));
}

/**
 * The PATH the system holds now: the user's then the machine's, from the registry (Windows only).
 * `run(command, args)` returns { status, stdout }; injected so this is testable without a registry.
 * @returns {string[]} folders, empty when not Windows or the registry could not be read
 */
function systemPathDirs({ platform = process.platform, env = process.env, run } = {}) {
  if (platform !== 'win32' || typeof run !== 'function') return [];
  // by absolute path: a bare `reg` is looked for in the current folder first on Windows, and a project folder is not trusted
  const regExe = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe');
  const keys = [
    ['HKCU\\Environment', 'Path'],
    ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'],
  ];
  const dirs = [];
  for (const [key, name] of keys) {
    let r;
    try { r = run(regExe, ['query', key, '/v', name]); } catch { continue; }
    if (!r || r.status !== 0 || typeof r.stdout !== 'string') continue;
    // "    Path    REG_EXPAND_SZ    C:\Users\x\bin;%USERPROFILE%\.local\bin"
    const m = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'im').exec(r.stdout);
    if (!m) continue;
    for (const d of expandWindowsVars(m[1].trim(), env).split(';')) if (d.trim()) dirs.push(d.trim().replace(/^"|"$/g, ''));
  }
  return dirs;
}

/** The files Claude Code installs itself as, per platform. Best effort: an absent path costs one stat. */
function knownLocations({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const out = [];
  if (platform === 'win32') {
    const home = env.USERPROFILE || homedir;
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    const j = path.win32.join;
    out.push(
      j(home, '.local', 'bin', 'claude.exe'),                 // the native installer
      j(local, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),  // winget
      j(home, '.claude', 'local', 'claude.exe'),               // the local installer (claude migrate-installer)
      j(home, '.claude', 'local', 'claude.cmd'),
      j(home, '.claude', 'local', 'node_modules', '.bin', 'claude.cmd'),
      j(roaming, 'npm', 'claude.cmd'),                         // npm install -g, the default prefix
    );
  } else {
    const j = path.posix.join;
    const home = homedir;
    out.push(
      j(home, '.local', 'bin', 'claude'),                      // the native installer
      j(home, '.claude', 'local', 'claude'),                   // the local installer
      j(home, '.claude', 'local', 'node_modules', '.bin', 'claude'),
      '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude',
      j(home, '.npm-global', 'bin', 'claude'),
    );
  }
  return out;
}

/** Find `claude` in `dirs`: on Windows by every extension PATHEXT lists (directly runnable ones), elsewhere by exact name. */
function findInDirs(dirs, { platform = process.platform, env = process.env, exists, name = 'claude' } = {}) {
  const win = platform === 'win32';
  const j = win ? path.win32.join : path.posix.join;
  const check = exists || (win ? isFile : isExecutableFile);
  let exts = [''];
  if (win) {
    const listed = String(env.PATHEXT || env.Pathext || '').split(';').map((e) => e.trim().toUpperCase()).filter(Boolean);
    exts = (listed.length ? listed : WINDOWS_EXTS_DEFAULT).filter((e) => WINDOWS_EXTS_DEFAULT.includes(e));
    if (!exts.length) exts = WINDOWS_EXTS_DEFAULT;
  }
  const seen = new Set();
  for (const raw of dirs) {
    const dir = String(raw || '').trim().replace(/^"|"$/g, '');
    if (!dir || seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    for (const ext of exts) {
      const candidate = j(dir, `${name}${ext.toLowerCase()}`); // Windows ignores case; the path shown and stored is the usual spelling
      if (check(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the `claude` to launch.
 * @param {{ platform?: string, env?: object, homedir?: string, exists?: (p: string) => boolean, run?: Function }} [o]
 * @returns {{ path: string, source: string } | { path: null, searched: string[], override?: string }}
 */
function resolveClaude(o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const homedir = o.homedir || os.homedir();
  const win = platform === 'win32';
  const exists = o.exists || (win ? isFile : isExecutableFile);
  const delimiter = win ? ';' : ':';
  const searched = [];

  const override = (env.SYM_CLAUDE_BIN || '').trim();
  if (override) {
    const given = override.replace(/^"|"$/g, '');
    const dirs = String(env.PATH || env.Path || '').split(delimiter);
    let hit = null;
    if (/[\\/]/.test(given)) {
      // a path: as written, or (Windows) with an extension PATHEXT lists, so `C:\\x\\claude` finds claude.exe
      const exts = win ? ['', ...WINDOWS_EXTS_DEFAULT.map((e) => e.toLowerCase())] : [''];
      hit = exts.map((e) => `${given}${e}`).find((c) => exists(c)) || null;
    } else {
      // a bare name (`claude`, `claude-dev`): looked for on PATH, as the shell would
      hit = findInDirs(dirs, { platform, env, exists, name: given });
    }
    if (hit) return { path: hit, source: 'SYM_CLAUDE_BIN' };
    return { path: null, searched: [`SYM_CLAUDE_BIN=${given} (not found, not a file, or not executable)`], override: given };
  }

  const processDirs = String(env.PATH || env.Path || '').split(delimiter);
  searched.push(`PATH (${processDirs.filter(Boolean).length} folders)`);
  let hit = findInDirs(processDirs, { platform, env, exists });
  if (hit) return { path: hit, source: 'PATH' };

  if (win) {
    const sys = systemPathDirs({ platform, env, run: o.run });
    searched.push(sys.length ? `the system PATH from the registry (${sys.length} folders)` : 'the system PATH from the registry (unreadable)');
    hit = findInDirs(sys, { platform, env, exists });
    if (hit) return { path: hit, source: 'the system PATH, which this terminal does not have yet' };
  }

  const known = knownLocations({ platform, env, homedir });
  searched.push(...known);
  for (const p of known) if (exists(p)) return { path: p, source: 'an install folder' };

  const exec = (env.CLAUDE_CODE_EXECPATH || '').trim();
  if (exec) {
    searched.push(`CLAUDE_CODE_EXECPATH=${exec}`);
    if (exists(exec)) return { path: exec, source: 'CLAUDE_CODE_EXECPATH' };
  }
  return { path: null, searched };
}

/**
 * Escaping for cmd.exe, by the published algorithm (https://qntm.org/cmd, as cross-spawn applies it). A command line
 * reaches a program through TWO parsers: cmd.exe first (its metacharacters ( ) % ! ^ " < > & | and the space), then
 * the program's C runtime (backslashes before a quote, a quote ends an argument). An npm .cmd shim forwards its
 * arguments with `%*`, so cmd.exe parses the line a SECOND time when the shim runs: the escaping is applied twice.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** One argument: made safe for the C runtime (quotes in, trailing backslashes doubled), quoted, then caret-escaped for cmd.exe. */
function escapeCmdArgument(arg, { doubleEscape = false } = {}) {
  let a = `${arg}`;
  a = a.replace(/(\\*)"/g, '$1$1\\"');   // backslashes before a quote: doubled, and the quote escaped
  a = a.replace(/(\\+)$/, '$1$1');        // trailing backslashes: doubled, so they do not escape the closing quote
  a = `"${a}"`;
  a = a.replace(CMD_META, '^$1');
  if (doubleEscape) a = a.replace(CMD_META, '^$1');
  return a;
}
/** The program's own path: caret-escaped for cmd.exe (it is not quoted, so a space is escaped too). */
function escapeCmdCommand(command) { return `${command}`.replace(CMD_META, '^$1'); }

/**
 * How to start `file` with `args`, for child_process.spawnSync.
 *   POSIX and a Windows .exe/.com: the file itself, no shell. Node quotes the arguments.
 *   A Windows .cmd/.bat (an npm install): only cmd.exe can run it (Node refuses a batch file without a
 *   shell, CVE-2024-27980), so a shell is used and the whole command line is quoted here.
 * @returns {{ command: string, args: string[], options: { shell: boolean } }}
 */
function launchSpec(file, args, { platform = process.platform } = {}) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { command: [escapeCmdCommand(file), ...args.map((a) => escapeCmdArgument(a, { doubleEscape: true }))].join(' '), args: [], options: { shell: true } };
  }
  return { command: file, args: [...args], options: { shell: false } };
}

/** The words for a `claude` that cannot be found: where we looked, and the three ways to fix it. */
function notFoundMessage(result, { platform = process.platform } = {}) {
  const win = platform === 'win32';
  if (result.override) {
    return `ERROR: SYM_CLAUDE_BIN is set to ${result.override}, which was not found as an executable file.\n` +
      'Fix it (a full path to the file, or a name on PATH), or unset SYM_CLAUDE_BIN to let `start` look for Claude Code itself.\n';
  }
  const lines = ['ERROR: `start` could not find the `claude` command (Claude Code).', '  It looked in:'];
  for (const s of result.searched) lines.push(`    - ${s}`);
  lines.push('  What to do:');
  if (win) {
    lines.push(
      '    1. Find it:  in PowerShell run `Get-Command claude` or `where.exe claude`. If Get-Command says Alias or Function,',
      '       that is why: your shell knows `claude`, but a program started from it does not.',
      '    2. Tell `start` where it is, then run it again:  $env:SYM_CLAUDE_BIN = \'C:\\path\\to\\claude.exe\'',
      '    3. Or add its folder to PATH and open a NEW terminal (an open terminal keeps the PATH it started with).',
      '    Not installed?  https://claude.com/code',
    );
  } else {
    lines.push(
      '    1. Find it:  `command -v claude` in your own shell (an alias or function is invisible to a program started from it).',
      '    2. Tell `start` where it is:  SYM_CLAUDE_BIN=/path/to/claude sym-mesh-channel start',
      '    3. Or put its folder on PATH.',
      '    Not installed?  https://claude.com/code',
    );
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { resolveClaude, launchSpec, notFoundMessage, escapeCmdArgument, escapeCmdCommand, systemPathDirs, knownLocations, findInDirs, expandWindowsVars };
