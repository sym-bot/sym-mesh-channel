'use strict';

// ONE VOCABULARY on the invite wire: room (LAN) and team (relay). Founder ruling 2026-08-12. Since 0.11
// the grammar is the SDK's (sym 0.14 `invite`), so this channel keeps no copy: room-names.js asks the
// SDK, and invites carry the issuer (node, key) that an acceptor pins (sym D5).

require('./_harness.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseInviteURL } = require('../room-names.js');

for (const url of ['sym://room/backend-team', 'sym://team/backend-team?relay=https%3A%2F%2Fr.example&token=t', 'melotune://room/abc123/lounge']) {
  assert.ok(!parseInviteURL(url).error, `the parser must accept ${url}`);
}
assert.strictEqual(parseInviteURL('melotune://room/abc123/lounge').room, 'melotune-abc123');
const issuer = 'node=01a0fd15-52ca-726c-9ce1-5767a1379249&key=AIFMY28eNJTXCDpjEPAwqpcORIiJt1ByDeaatkY_K-U';
const withIssuer = parseInviteURL(`sym://team/backend-team?relay=wss%3A%2F%2Fr.example&token=t&${issuer}`);
assert.strictEqual(withIssuer.issuer.nodeId, '01a0fd15-52ca-726c-9ce1-5767a1379249');
assert.strictEqual(withIssuer.relayUrl, 'wss://r.example');
assert.strictEqual(withIssuer.serviceType, '_backend-team._tcp');
assert.match(parseInviteURL('sym://room/x?node=not-a-uuid&key=k').error, /names an issuer/);
// The removed vocabulary stays removed — in parsing AND in emission.
const legacyWord = 'gro' + 'up';
assert.ok(parseInviteURL(`sym://${legacyWord}/backend-team`).error, 'the legacy scheme is removed by ruling');
for (const f of ['server.js', 'room-names.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.ok(!src.toLowerCase().includes(`sym://${legacyWord}/`), `${f}: no emission or example of the legacy scheme`);
  assert.ok(!/INVITE_URL_RE\s*=/.test(src), `${f}: no copy of the invite grammar`);
}
console.log('invite-scheme-compat: ok (single vocabulary, the SDK\'s grammar, issuer carried)');
