#!/usr/bin/env node
// MUTATION CHECKS. Each check breaks one production decision the way a careless edit would and requires the
// named test file to FAIL. A check whose edit target has moved fails loudly ("target not found"), never
// passes silently, and every test file is run unmutated first, so a kill is the mutation's and not a flaky
// file's. The mutations are applied to a throw-away copy of the working tree (node_modules is linked, the
// tree is not touched), and each test file runs the way test/run.js runs it: a sandboxed HOME and
// SYM_STATE_DIR and an allowlisted environment.
//
//   node test/mutation-checks.mjs              run them all (a heavy job: take the lock first)
//   node test/mutation-checks.mjs --list
//   node test/mutation-checks.mjs --check      the edit targets exist (fast, touches nothing)
//   node test/mutation-checks.mjs --only M04,M18
//
// Exit 0 when every check is killed. The 21 checks the 0.11.0 design speaks of (the security review's ten,
// and the ones added on 2026-10-07) were run by hand and their list was not kept in the repository. These
// are rebuilt from the review's findings, named in brackets (H1, r2, M3...), and extended for the move onto
// sym 0.14.0 (M16 onward) and for 0.11.1's review R4 (M32 onward); `--check` verifies that every edit target
// still exists exactly once.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { cleanEnv, refuseDangerous } = require('./_clean-env.js');
refuseDangerous(process.env, 'test/mutation-checks.mjs');

/** [id, what the edit breaks, file, exact text, replacement, the test that must fail] */
const CHECKS = [
  ['M01', 'a tag shows only 4 hex of the key fingerprint (review H2, r1)', 'key-display.js', 'const MIN_SUFFIX = 8;', 'const MIN_SUFFIX = 4;', 'key-display.test.js'],
  ['M02', 'two keys with one label are not said to be two (H2)', 'key-display.js', '${shared > 1 ? ` (${shared} keys)` : \'\'}', '${shared > 99 ? ` (${shared} keys)` : \'\'}', 'key-display.test.js'],
  ['M03', 'the suffix does not grow past a shared tail (H2)', 'key-display.js', 'while (n < fp.length && other.endsWith(fp.slice(-n))) n++;', 'if (false) n++;', 'key-display.test.js'],
  ['M04', 'an entry the node did not mark verified is shown as verified (H1)', 'provenance.js', "if (entry.verified !== true) return {", 'if (false) return {', 'provenance.test.js'],
  ['M05', 'a Legacy Import entry is shown (D7)', 'provenance.js', "if (entry.profile === 'legacy-import') return { withheld: 'legacy-import' };", '', 'provenance.test.js'],
  ['M06', 'facts for another author than the entry\'s are accepted (r2, r11)', 'provenance.js', "if (nodeId(author.nodeId) !== facts.signer.nodeId) return { withheld: 'facts-mismatch' };", '', 'provenance.test.js'],
  ['M07', 'a mood frame is attributed though another session delivered it (M1, r3)', 'provenance.js', 'nodeId(m.authorNodeId) !== peer || by !== peer)', 'nodeId(m.authorNodeId) !== peer)', 'provenance.test.js'],
  ['M08', 'peer text is not escaped as a JSON string in a lead (M2, r4)', 'delivery-policy.js', 'return escapeInvisible(JSON.stringify(cut));', 'return escapeInvisible(cut);', 'delivery-policy.test.js'],
  ['M09', 'the fence marker has no nonce, so peer text can close it (M2, r4)', 'delivery-policy.js', "const nonce = crypto.randomBytes(6).toString('hex');", "const nonce = '000000000000';", 'delivery-policy.test.js'],
  ['M10', 'a non-CAT7 key of a record is shown (M3, r8)', 'signed-parts.js', 'for (const f of CAT7) {', 'for (const f of Object.keys(cats)) {', 'provenance.test.js'],
  ['M11', 'the push rate limit never holds (r10)', 'delivery-policy.js', 'return w.length <= limit;', 'return true;', 'delivery-policy.test.js'],
  ['M12', 'a list of names allows everyone (M5)', 'delivery-policy.js', 'failClosed: entries.length > 0 && nodeIds.length + keys.length + pairs.length === 0,', 'failClosed: false,', 'delivery-policy.test.js'],
  ['M13', 'a tool call\'s hold timer starts when it is queued, not when it starts (L1, r5)', 'tool-queue.js', '    tail = gate;\n    return prev.then(async () => {\n      const t = setTimeout(release, holdMs);', '    tail = gate;\n    const t = setTimeout(release, holdMs);\n    return prev.then(async () => {', 'tool-queue.test.js'],
  ['M14', 'the sandbox lets an XMesh mind\'s interior variables through (M5, r9)', 'test/_clean-env.js', 'const DANGEROUS_PARENT = /^(SYM_INTERIOR_[A-Z_]*|', 'const DANGEROUS_PARENT = /^(SYM_INTERIOR_NEVER|', 'sandbox.test.js'],
  ['M15', 'the gate lets a file: dependency through (M4, r6)', 'scripts/verify-packed-artifact.mjs', '/^(file|link):/.test(String(v))', '/^(link):/.test(String(v))', 'release-gate.test.js'],
  ['M16', 'a Legacy Import session\'s peer-joined makes its nodeId known to the outbox (L4)', 'node-host.js', "const proven = !!peer && peer.profile === 'core-secure' && Array.isArray(peer.sessions) && peer.sessions.length > 0 && peer.sessions.every((s) => !s.legacy);", 'const proven = !!peer;', 'node-host.test.js'],
  ['M17', 'the outbox holds for a name, not a nodeId (D8)', 'outbox.js', "if (!isNodeId(to)) return { held: false, reason: 'not-a-node-id' };", '', 'outbox.test.js'],
  ['M18', 'a store that could not write is answered as "already in memory" (sym 0.14: null)', 'channel-delivery.js', "if (!entry) return { outcome: 'store-failed' };", "if (!entry) return { outcome: 'already-in-memory' };", 'channel-delivery.test.js'],
  ['M19', 'parents are not bounded', 'channel-delivery.js', 'const MAX_PARENTS = 16;', 'const MAX_PARENTS = 1000;', 'channel-delivery.test.js'],
  ['M20', 'the host feed reuses the ids of evicted items (inbox-id bug)', 'node-host.js', 'else if (Number.isSafeInteger(o.seqFloor) && o.seqFloor > seq) seq = o.seqFloor;', '', 'node-host.test.js'],
  ['M21', 'a receive never drains the inbox, so the same deliveries are listed again', 'node-host.js', 'const drained = this.node.inbox({ limit: Math.max(1, inboxUnread) });', 'const drained = null;', 'redelivery-e2e.test.js'],
  ['M22', 'a room is the kebab-case grammar again', 'room-names.js', 'return isValidRoom(room);', "return typeof room === 'string' && /^[a-z0-9]+(?:--?[a-z0-9]+)*$/.test(room);", 'plugin.test.js'],
  ['M23', 'the relay store keeps its own kebab-case pattern again', 'relay-store.js', 'if (!isValidRoom(room)) return null;', "if (typeof room !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(room)) return null;", 'relay-store.test.js'],
  ['M24', 'the installer\'s mirror of the room grammar is one character short', 'bin/install.js', 'const FALLBACK_ROOM_RE = /^[a-z0-9._-]{1,64}$/;', 'const FALLBACK_ROOM_RE = /^[a-z0-9._-]{1,63}$/;', 'plugin.test.js'],
  ['M25', 'discovery prints a room name that is not a room', 'room-discovery.js', 'if (!isValidRoom(room)) { badRoom++; seen.set(id, { room: null, core }); continue; }', '', 'room-discovery.test.js'],
  ['M26', 'discovery counts this node among the others', 'room-discovery.js', 'if (!id || id === ownNodeId || seen.has(id)) continue;', 'if (!id || seen.has(id)) continue;', 'room-discovery.test.js'],
  ['M27', 'the node is built with a per-room service type (invisible to 0.14 nodes)', 'server.js', '    room,\n    relay: relay || undefined,', '    discoveryServiceType: `_${room}._tcp`,\n    room,\n    relay: relay || undefined,', 'plugin.test.js'],
  ['M28', 'a room that is not a room is built into a node (mints an identity)', 'server.js', 'if (!isRoom(ROOM)) {', 'if (false) {', 'rooms-surface.test.js'],
  ['M29', 'a malformed anchor pin crashes the server instead of stopping the node with the cause', 'server.js', '(/^anchor pin:/.test(String(err.message)) || err instanceof SyntaxError)', 'false', 'rooms-surface.test.js'],
  ['M30', 'sym_fetch does not acknowledge what it read to the end', 'node-host.js', 'try { return this.node.inboxAck(id); } catch { return false; }', 'return false;', 'core-secure-e2e.test.js'],
  ['M31', 'the release gate looks for package.json.js in the packed artifact and fails a correct tarball', 'scripts/verify-packed-artifact.mjs', "/\\.(js|json|mjs|cjs)$/.test(m[1])", "m[1].endsWith('.js')", 'release-gate.test.js'],
  // 0.11.1, review R4
  ['M32', 'a read item takes a place in a receive again, so the unread one after it is never listed (R4-2)', 'node-host.js', 'if (!d.acked) { if (unread >= lim) break; unread++; }', 'if (unread >= lim) break; unread++;', 'node-host.test.js'],
  ['M33', 'a relay close 4004 exits the server again (R4-1)', 'server.js', "h.on('identity-collision', (info) => relayStops.onStop(info));", "h.on('identity-collision', () => process.exit(2));", 'server-hardening-e2e.test.js'],
  ['M34', 'the installer writes a config file with the default mode again (R4-4)', 'bin/install.js', 'fs.writeFileSync(tmp, data, { mode });\n    fs.chmodSync(tmp, mode);', 'fs.writeFileSync(tmp, data);', 'installer-modes.test.js'],
  ['M35', 'a label is printed bare whatever it holds (R4-5)', 'key-display.js', '  if (s.length <= LABEL_MAX && PLAIN_LABEL.test(s)', '  if (true || s.length <= LABEL_MAX && PLAIN_LABEL.test(s)', 'key-display.test.js'],
  ['M36', 'sym_invite_info repeats the relay token (R4-6)', 'server.js', 'relay_token: p.relayToken ? `<redacted: ${p.relayToken.length} characters>` : undefined,', 'relay_token: p.relayToken || undefined,', 'server-hardening-e2e.test.js'],
  ['M37', 'a nodeId pinned to a key in the allowlist is allowed with any key (R4-8)', 'delivery-policy.js', '(fp && pairs.has(`${id}@${fp}`))', '[...pairs].some((x) => x.startsWith(`${id}@`))', 'delivery-policy.test.js'],
  ['M38', 'a fault building the node kills the server before MCP connects again (R4-3)', 'server.js', "      NODE_FAULT = nodeFault(err, 'built');", '      throw err;', 'server-hardening-e2e.test.js'],
  ['M39', 'a lead lets invisible characters through again (R4-13)', 'delivery-policy.js', 'return escapeInvisible(JSON.stringify(cut));', 'return JSON.stringify(cut);', 'delivery-policy.test.js'],
  ['M40', 'the keys written down in earlier runs are not counted for "(2 keys)" (R4-7)', 'key-display.js', 'for (const p of persistedEntries()) {', 'for (const p of []) {', 'key-display.test.js'],
  ['M41', 'records sym drops past a budget are not counted (R4-10)', 'node-host.js', "if (!m || (m.type !== 'cmb-over-budget' && m.type !== 'cmb-over-verify-budget')) return;", 'return;', 'server-hardening-e2e.test.js'],
  ['M43', 'a ping-pong sym 0.14.3 finds is not pushed when a stop was pushed just before (R4-1)', 'relay-stop.js', ' && !(pingPong && !stop.pingPong);', ';', 'relay-stop.test.js'],
  ['M42', 'the release script ships in the package again (R4-14)', 'package.json', '    "LICENSE"\n  ],', '    "LICENSE",\n    "scripts/"\n  ],', 'packaging.test.js'],
];

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : (process.argv[i + 1] || ''); };
if (process.argv.includes('--list')) { for (const c of CHECKS) console.log(`${c[0]}  ${c[2]}  ${c[1]}  [${c[5]}]`); process.exit(0); }
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const chosen = CHECKS.filter((c) => !only || only.has(c[0]));
if (process.argv.includes('--check')) {
  let bad = 0;
  for (const [id, , file, from] of chosen) {
    const n = fs.readFileSync(path.join(root, file), 'utf8').split(from).length - 1;
    if (n !== 1) { bad++; console.log(`${id}: target found ${n} times in ${file}`); }
  }
  console.log(bad ? `${bad} target(s) to fix` : `all ${chosen.length} targets found exactly once`);
  process.exit(bad ? 1 : 0);
}

const TMP = fs.realpathSync(os.tmpdir());
const work = fs.mkdtempSync(path.join(TMP, 'mesh-channel-mutation-'));
const copy = path.join(work, 'tree');
function freshTree() {
  fs.rmSync(copy, { recursive: true, force: true });
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of files) {
    const src = path.join(root, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
    fs.copyFileSync(src, path.join(copy, f));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'));
}

function runTest(file) {
  const box = fs.mkdtempSync(path.join(work, 'box-'));
  fs.mkdirSync(path.join(box, '.sym'), { recursive: true });
  const env = cleanEnv({ HOME: box, USERPROFILE: box, SYM_STATE_DIR: path.join(box, '.sym'), MESH_CHANNEL_RUN_STARTED_AT: String(Date.now()) });
  const r = spawnSync(process.execPath, [path.join(copy, 'test', file)], { cwd: copy, env, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(box, { recursive: true, force: true });
  return r;
}

const baseline = new Map();
let survived = 0, invalid = 0, killed = 0;
try {
  for (const [id, what, file, from, to, test] of chosen) {
    freshTree();
    if (!baseline.has(test)) { const b = runTest(test); baseline.set(test, b.status === 0); }
    if (!baseline.get(test)) { invalid++; console.log(`INVALID   ${id}  ${what}\n          ${test} fails unmutated, so no kill would mean anything`); continue; }
    const target = path.join(copy, file);
    const src = fs.readFileSync(target, 'utf8');
    const n = src.split(from).length - 1;
    if (n !== 1) { invalid++; console.log(`INVALID   ${id}  ${what}\n          target not found exactly once in ${file} (${n} times): the code moved, update the check`); continue; }
    fs.writeFileSync(target, src.replace(from, () => to));
    const r = runTest(test);
    if (r.status !== 0) { killed++; console.log(`killed    ${id}  ${what}  [${test}]`); }
    else { survived++; console.log(`SURVIVED  ${id}  ${what}  [${test}]`); }
  }
} finally { fs.rmSync(work, { recursive: true, force: true }); }

console.log(`\n${killed} killed, ${survived} survived, ${invalid} invalid, of ${chosen.length}.`);
process.exit(survived || invalid ? 1 : 0);
