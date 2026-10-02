'use strict';

// End to end, real SDK: two spawned channel servers meet through a loopback fake relay by the real
// sym 0.14 Core Secure handshake, and everything is asserted on what a session reads — tool results
// and channel notifications.

const h = require('./_harness.js'); // sandbox first
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const t = h.suite('Core Secure end to end (two servers, one relay)');
const TOKEN = 'e2e-token-'.padEnd(40, 'x');
let relay;
const idOf = (s) => s.instructions.match(/nodeId ([0-9a-f-]{36})/)[1];

async function pair(extraA = {}, extraB = {}) {
  const env = { SYM_ROOM: 'e2e-room', SYM_RELAY_URL: relay.url, SYM_RELAY_TOKEN: TOKEN };
  const A = new h.McpSession({ env: { ...env, SYM_NODE_NAME: 'alice', ...extraA } });
  const B = new h.McpSession({ env: { ...env, SYM_NODE_NAME: 'bob', ...extraB } });
  await A.initialize(); await B.initialize();
  const ok = await h.until(async () => /1 peer\(s\)/.test((await A.call('sym_peers')).text) && /1 peer\(s\)/.test((await B.call('sym_peers')).text), 20000, 400);
  if (!ok) throw new Error(`the pair did not meet.\nA: ${A.stderr}\nB: ${B.stderr}`);
  return { A, B, a: idOf(A), b: idOf(B) };
}
const closeAll = async (...s) => { for (const x of s) await x.close(); };
const inIdOf = (text) => (text.match(/\[(in\d{4})\]/) || [])[1];

t('setup: a relay', async () => { relay = await h.fakeRelay(); });

t('a directed CMB arrives with who signed it, the audience, the id and the key; a name is never a route', async () => {
  const { A, B, a, b } = await pair();
  try {
    const peers = (await A.call('sym_peers')).text;
    assert.match(peers, new RegExp(`bob — nodeId ${b}; key proven; relay`));
    const byName = await A.call('sym_send', { to: 'bob', focus: 'by name' });
    assert.strictEqual(byName.isError, true);
    assert.match(byName.text, new RegExp(`Connected peers that use the label "bob": ${b}`));
    const sent = await A.call('sym_send', { to: b, focus: 'review the outbox migration', payload: { pr: 42 } });
    assert.match(sent.text, /^Sent CMB cmb-[0-9a-f]{64} \(assertion asrt-[0-9a-f]+\) to bob·/);
    const push = await B.waitForPush((p) => p.type === 'cmb', 10000);
    assert.ok(push, `no push. B stderr:\n${B.stderr}`);
    assert.match(push.text, new RegExp(`^\\[alice·${a.slice(-8)} →you\\] review the outbox migration \\[\\+payload 9 bytes\\] \\[in\\d{4}\\] key cmb-[0-9a-f]{64}$`));
    const r = (await B.call('sym_receive')).text;
    const id = inIdOf(r);
    assert.ok(id, r);
    assert.match(r, /·pushed/, 'until the session confirms push, a pushed delivery is still listed');
    const f = (await B.call('sym_fetch', { msg_id: id })).text;
    assert.match(f, new RegExp(`Signed by: alice — nodeId ${a}; its key is proven by a Core Secure session with it`));
    assert.match(f, /Audience: directed to this node/);
    assert.match(f, /---PAYLOAD \(signed application data\)---\n\{\n {2}"pr": 42\n\}/);
  } finally { await closeAll(A, B); }
});

t('a reply cites what it answers; the asker sees the lineage, and identical cognition is "Already in memory"', async () => {
  const { A, B, b } = await pair();
  try {
    await A.call('sym_send', { to: b, focus: 'is the relay healthy' });
    await h.until(async () => inIdOf((await B.call('sym_receive', { peek: true })).text), 10000, 300);
    const id = inIdOf((await B.call('sym_receive')).text);
    const first = await B.call('sym_send', { to: id, parents: [id], focus: 'yes, healthy for an hour' });
    assert.match(first.text, /^Not sent: MMP §15\.7/, 'the SDK\'s remix guard, said as such');
    assert.match((await B.call('sym_publish', { focus: 'bob has watched the relay for an hour' })).text, /^Published CMB/);
    const reply = await B.call('sym_send', { to: id, parents: [id], focus: 'yes, healthy for an hour' });
    assert.match(reply.text, /Lineage: 1 parent\(s\) cited/);
    await h.until(async () => /healthy for an hour/.test((await A.call('sym_receive', { peek: true })).text), 10000, 300);
    const ra = (await A.call('sym_receive')).text;
    const replyId = ra.split('\n').filter((l) => /healthy for an hour/.test(l)).map(inIdOf)[0];
    assert.match((await A.call('sym_fetch', { msg_id: replyId })).text, /Lineage: it cites cmb-[0-9a-f]{64}\./);
    assert.match((await A.call('sym_publish', { focus: 'one' })).text, /^Published/);
    assert.match((await A.call('sym_publish', { focus: 'two' })).text, /^Published/);
    const again = await A.call('sym_publish', { focus: 'one' });
    assert.strictEqual(again.isError, false);
    assert.match(again.text, /^Already in memory: .* That is not an error\./);
  } finally { await closeAll(A, B); }
});

t('push, stated first-hand: after sym_push_confirm a pushed delivery is named, not repeated, and not counted unread', async () => {
  const { A, B, b } = await pair();
  try {
    const check = await B.waitForPush((p) => p.type === 'push-check', 5000);
    assert.ok(check);
    const code = check.text.match(/"code":"([A-Z0-9-]+)"/)[1];
    assert.match((await B.call('sym_push_confirm', { code: 'AAAA-BBBB' })).text, /not a code this server sent/);
    assert.match((await B.call('sym_status')).text, /Push: not confirmed — a push check was sent/);
    assert.match((await B.call('sym_push_confirm', { code })).text, /^Confirmed, first-hand/);
    assert.match((await B.call('sym_status')).text, /Push: confirmed by this session at/);
    await A.call('sym_send', { to: b, focus: 'pushed and confirmed' });
    const p = await B.waitForPush((x) => /pushed and confirmed/.test(x.text), 10000);
    assert.ok(p);
    const status = (await B.call('sym_status')).text;
    assert.ok(!/Mesh inbox: \d+ unread/.test(status), `a delivery pushed into a confirmed session is not unread: ${status}`);
    const r = (await B.call('sym_receive')).text;
    assert.match(r, /Already pushed into this session, not repeated: 1 \(in\d{4}\)/);
    assert.ok(!/pushed and confirmed/.test(r), 'not listed again');
    // A fresh check on demand.
    assert.match((await B.call('sym_push_confirm', {})).text, /A push check was sent just now/);
  } finally { await closeAll(A, B); }
});

t('without push confirmed, the unread footer counts what waits; sym_fetch to the end marks it read', async () => {
  const { A, B, b } = await pair();
  try {
    await A.call('sym_send', { to: b, focus: 'count me' });
    const st = await h.until(async () => { const x = (await B.call('sym_status')).text; return /Mesh inbox: 1 unread — call sym_receive\./.test(x) && x; }, 10000, 300);
    assert.ok(st, 'the footer says one unread');
    const id = inIdOf((await B.call('sym_receive', { peek: true })).text);
    await B.call('sym_fetch', { msg_id: id });
    assert.ok(!/Mesh inbox/.test((await B.call('sym_status')).text), 'read in full: no longer unread');
    assert.match((await B.call('sym_receive')).text, new RegExp(`Already read with sym_fetch, not repeated: 1 \\(${id}\\)`));
  } finally { await closeAll(A, B); }
});

t('SYM_ALLOWED_PEERS of names allows nothing, and says so; of nodeIds, admits exactly those', async () => {
  const { A, B, a, b } = await pair({}, { SYM_ALLOWED_PEERS: 'alice' });
  try {
    assert.match(B.instructions, /SYM_ALLOWED_PEERS lists 1 entry that is not a nodeId, ignored: names are labels, not identities\. It lists no nodeId, so it allows nothing/);
    await A.call('sym_send', { to: b, focus: 'kept out by a name list' });
    const r = await h.until(async () => { const x = (await B.call('sym_receive')).text; return /signer outside SYM_ALLOWED_PEERS/.test(x) && x; }, 10000, 300);
    assert.ok(r, 'counted, never shown');
    assert.ok(!/kept out by a name list/.test(r));
    assert.match((await B.call('sym_status')).text, /Allowlist: 0 nodeId\(s\); 1 entr\(ies\) ignored \(not nodeIds\) — it allows nothing/);
  } finally { await closeAll(A, B); }
  // A listed nodeId is admitted; another node with the same label is not.
  const sdk = require('@sym-bot/sym');
  const listed = sdk.identity.loadIdentity({ name: 'alice', create: true });   // in the sandbox's own state root
  const C = await pair({ SYM_STATE_DIR: process.env.SYM_STATE_DIR }, { SYM_ALLOWED_PEERS: listed.nodeId });
  const impostor = new h.McpSession({ env: { SYM_ROOM: 'e2e-room', SYM_RELAY_URL: relay.url, SYM_RELAY_TOKEN: TOKEN, SYM_NODE_NAME: 'alice' } });
  try {
    assert.strictEqual(C.a, listed.nodeId);
    await impostor.initialize();
    await h.until(async () => /bob/.test((await impostor.call('sym_peers')).text), 20000, 400);
    await C.A.call('sym_send', { to: C.b, focus: 'from the listed alice' });
    await impostor.call('sym_send', { to: C.b, focus: 'from another alice' });
    const r = await h.until(async () => { const x = (await C.B.call('sym_receive', { peek: true })).text; return /from the listed alice/.test(x) && /signer outside SYM_ALLOWED_PEERS: 1/.test(x) && x; }, 15000, 400);
    assert.ok(r, 'the listed nodeId is shown and the same label from another nodeId is counted, not shown');
    assert.ok(!/from another alice/.test(r));
  } finally { await closeAll(C.A, C.B, impostor); }
});

t('a restarted server still says who signed what waits in its inbox, and its instructions carry no record text', async () => {
  const bState = h.stateDir('bob-restart');
  const bCwd = fs.mkdtempSync(path.join(process.env.HOME, 'bob-proj-'));
  const { A, B, b } = await pair({}, { SYM_STATE_DIR: bState, CLAUDE_PROJECT_DIR: bCwd });
  try {
    await A.call('sym_send', { to: b, focus: 'MARKER-PRIMER wait for me across a restart' });
    await h.until(async () => inIdOf((await B.call('sym_receive', { peek: true })).text), 10000, 300);
    await B.call('sym_publish', { focus: 'MARKER-OWN bob notes something' });
    await new Promise((r) => setTimeout(r, 1500));   // the SDK writes its inbox at most once a second
    await B.close();
    const B2 = new h.McpSession({ env: { ...B.env } });
    try {
      await B2.initialize();
      assert.ok(!/MARKER-PRIMER|MARKER-OWN/.test(B2.instructions), `no record text in the instructions (audit C-2.12): ${B2.instructions}`);
      assert.match(B2.instructions, /This node's memory holds \d+ record\(s\); sym_recall "" lists the newest, as data\./);
      const r = (await B2.call('sym_receive')).text;
      assert.match(r, /\[alice·[0-9a-f]{8} →you\] MARKER-PRIMER wait for me across a restart/, r);
      assert.match((await B2.call('sym_recall', { query: 'MARKER' })).text, /MARKER-PRIMER|MARKER-OWN/, 'memory is read as a tool result, through the policy');
    } finally { await B2.close(); }
  } finally { await closeAll(A); }
});

t('an invite names its issuer; joining with it pins the issuer\'s key, and the session then proves that key', async () => {
  const env = { SYM_ROOM: 'e2e-room', SYM_RELAY_URL: relay.url, SYM_RELAY_TOKEN: TOKEN };
  const A = new h.McpSession({ env: { ...env, SYM_NODE_NAME: 'issuer' } });
  const B = new h.McpSession({ env: { SYM_NODE_NAME: 'invitee', SYM_ROOM: 'elsewhere' } });
  try {
    await A.initialize(); await B.initialize();
    const a = idOf(A);
    const inv = (await A.call('sym_invite_create', { room: 'e2e-room', relay_url: relay.url, relay_token: TOKEN })).text;
    const url = inv.match(/(sym:\/\/team\/\S+)/)[1];
    assert.ok(url.includes(`node=${a}`), 'the issuer is in the URL');
    const info = (await B.call('sym_invite_info', { url })).text;
    assert.match(info, new RegExp(`"issuer_node_id": "${a}"`));
    assert.match(info, /"issuer_key_fingerprint": "[0-9a-f]{16}"/);
    const join = await B.call('sym_join_room', { invite: url });
    assert.strictEqual(join.isError, false, join.text);
    assert.match(join.text, /Moved from room "elsewhere" .* to "e2e-room"/);
    assert.match(join.text, new RegExp(`Pinned the issuer's key for ${a}`));
    const peered = await h.until(async () => { const x = (await B.call('sym_peers')).text; return x.includes(a) && x; }, 20000, 400);
    assert.ok(peered, 'the invitee meets the issuer through the invite\'s relay');
    // The session proved the key the invite pinned: no conflict. (sym 0.14 at 28c0fdb then reports the
    // binding's source as `proven`, where its design D3 keeps the stronger `pinned`: reported upstream.)
    assert.match(peered, new RegExp(`issuer — nodeId ${a}; key (pinned|proven)`));
    assert.match((await B.call('sym_status')).text, /no key conflicts/);
    assert.match((await B.call('sym_join_room', { room: 'e2e-room', invite: url.replace('e2e-room', 'other-room') })).text, /differ/);
  } finally { await closeAll(A, B); }
});

t('teardown', async () => { await relay.close(); });

t.run();
