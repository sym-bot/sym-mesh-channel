// The invite scheme is WIRE: parsed by shipped apps, emitted by shipped apps, neither
// updatable from here. Measured 2026-08-12: mesh-channel 0.6.2's rename emitted sym://room/
// which shipped MeloTune rejects (it parses only sym://group/, SymMeshService.swift:352),
// and the regex read `room|room` — a blind replace had clobbered legacy acceptance, so old
// invites were rejected too. Break in BOTH directions, found by a mesh doer grounding a
// scope ruling, not by any test here. This file is that missing test.
const assert = require('node:assert/strict');

const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
const reMatch = src.match(/const INVITE_URL_RE = (\/.*\/i);/);
assert.ok(reMatch, 'INVITE_URL_RE is gone');
// eslint-disable-next-line no-eval
const RE = eval(reMatch[1]);

// 1. The parser accepts BOTH vocabularies — group forever, room for new code.
for (const url of ['sym://group/backend-team', 'sym://room/backend-team',
                   'sym://team/backend-team?relay=https%3A%2F%2Fr.example&token=t',
                   'melotune://room/abc123/lounge']) {
  assert.ok(RE.test(url), `parser must accept ${url}`);
}

// 2. No duplicated alternative: `room|room` was the fingerprint of the clobber, and a
//    duplicate means one vocabulary silently vanished again.
const alt = src.match(/\(\?:([a-z|]+)\)\\\//);
if (alt) {
  const parts = alt[1].split('|');
  assert.equal(new Set(parts).size, parts.length,
    `duplicate alternative in INVITE_URL_RE (${alt[1]}) — a vocabulary was clobbered`);
}

// 3. The LAN emitter emits the LEGACY scheme until the shipped parser fleet accepts both.
//    Readers migrate first; the emitter flips last. When that flip happens, this assertion
//    is the one you change — deliberately, with the fleet check in hand.
assert.ok(src.includes('url = `sym://group/${room}`'),
  'LAN invites must emit sym://group/ while shipped parsers only accept the legacy scheme');
assert.ok(!src.includes('url = `sym://room/${room}`'),
  'emitting sym://room/ is compatible only with ourselves — shipped MeloTune rejects it');

console.log('invite-scheme-compat: ok');
