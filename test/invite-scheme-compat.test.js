// ONE VOCABULARY on the invite wire: room (LAN) and team (relay). Founder ruling 2026-08-12.
// The legacy scheme is REMOVED, not carried — and the release that ships this must follow the
// App-side parser updates (fix before break). This test pins the single-vocabulary state and
// the absence of any resurrected legacy alternative.
const assert = require('node:assert/strict');
const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
const reMatch = src.match(/const INVITE_URL_RE = (\/.*\/i);/);
assert.ok(reMatch, 'INVITE_URL_RE is gone');
// eslint-disable-next-line no-eval
const RE = eval(reMatch[1]);
for (const url of ['sym://room/backend-team', 'sym://team/backend-team?relay=https%3A%2F%2Fr.example&token=t', 'melotune://room/abc123/lounge']) {
  assert.ok(RE.test(url), `parser must accept ${url}`);
}
// The removed vocabulary must stay removed — in the regex AND in emission.
assert.ok(!RE.test('sym://' + 'gro' + 'up/backend-team'), 'the legacy scheme is removed by ruling');
assert.ok(src.includes('url = `sym://room/${room}`'), 'LAN invites emit the room scheme');
const legacyWord = 'gro' + 'up';
assert.ok(!src.toLowerCase().includes(`sym://${legacyWord}/`), 'no emission or example of the legacy scheme survives');
console.log('invite-scheme-compat: ok (single vocabulary)');
