'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

assert.match(readme, /Let your Claude Code agents coordinate themselves in real time/);
assert.match(readme, /One command\. One room\. Multiple Claude Code agents/);
assert.match(readme, /every day for more than six months/);
assert.match(readme, /coding agents from multiple vendors across live projects/);
assert.match(readme, /Not another central orchestrator/);
assert.match(readme, /We provide the trusted, real-time channel/);
assert.match(readme, /npx -y @sym-bot\/mesh-channel@latest start --room your-room/);
assert.match(readme, /Yes, I trust this folder/);
assert.match(readme, /WARNING: Loading development-channels/);
assert.match(readme, /Full-duplex delivery/);
assert.match(readme, /Automatic peer discovery/);
assert.match(readme, /Receiver-controlled attention/);
assert.match(readme, /A room, not a session/);
assert.match(readme, /Multi-vendor operation/);
assert.match(readme, /The mesh enables coordination; the intelligence stays with the agents/);
assert.match(readme, /Why this still matters when Claude Code has Agent Teams/);
assert.match(readme, /one lead creates and manages Claude teammates around a shared task list and mailbox/);
assert.match(readme, /Peer-to-peer communication with no required lead/);
assert.match(readme, /Separate projects, sessions, machines, and supported agent vendors through open MMP/);
assert.match(readme, /Use Agent Teams when one Claude session should create and supervise a temporary team/);
assert.match(readme, /Peer messages are \*\*external input\*\*/);
assert.doesNotMatch(readme, /best tool|best way/i);
assert.doesNotMatch(readme, /Claude Code sessions talking to each other in real time\./);

console.log('README positioning contract: ok');
