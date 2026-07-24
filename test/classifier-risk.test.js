#!/usr/bin/env node
'use strict';

// Unit tests for the classifier-risk ingest guard (classifier-risk.js). Pins the behavior that
// keeps a benign-but-risky-worded peer CMB from wedging the receiver's LLM session: risky phrasing
// is flagged, the quarantine header carries NO peer free-text and NO term names, and clean text is
// left untouched.

const assert = require('assert');
const {
  scanClassifierRisk,
  neutralizeSurface,
  quarantineHeader,
  RISK_TERMS,
} = require('../classifier-risk.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

// The empirically-observed trigger: "protocol stripped" phrasing.
test('flags the observed trigger phrasing ("stripped")', () => {
  const r = scanClassifierRisk('Cisco already stripped the protocol; blocker-assessment done');
  assert.equal(r.risky, true);
  assert.ok(r.terms.includes('stripped'), `expected 'stripped' in ${JSON.stringify(r.terms)}`);
});

test('flags offensive-security-adjacent terms', () => {
  for (const t of ['exploit', 'attack', 'bypass', 'penetration', 'jailbreak', 'backdoor']) {
    assert.equal(scanClassifierRisk(`we should ${t} it`).risky, true, `'${t}' should flag`);
  }
});

test('does NOT flag ordinary mesh chatter', () => {
  for (const s of [
    'gap-surfacing produced the finding; boundary revised, scope reduced',
    'gateway federation shipped; relay is next',
    'the ticket clustered as P1 with high velocity',
  ]) {
    assert.equal(scanClassifierRisk(s).risky, false, `should be clean: "${s}"`);
  }
});

test('matching is word-boundaried (no substring false positives)', () => {
  // Guard against substrings: "attach"≠attack, "stripe"/"strippable" ≠ the standalone "strip".
  assert.equal(scanClassifierRisk('please attach the file and describe it').risky, false);
  assert.equal(scanClassifierRisk('a stripe of colour on a strippable label').risky, false);
  // …but the standalone token does flag:
  assert.equal(scanClassifierRisk('strip the header field').risky, true);
});

test('returns DISTINCT terms', () => {
  const r = scanClassifierRisk('attack attack ATTACK attacker');
  assert.deepEqual([...new Set(r.terms)], r.terms, 'terms must be distinct');
  assert.ok(r.terms.includes('attack') && r.terms.includes('attacker'));
});

test('quarantine header carries no peer free-text and no term names', () => {
  const h = quarantineHeader('claude-sym-research@hongwei-mac', ' →you', 2, ' ·not-stored');
  assert.ok(h.includes('claude-sym-research@hongwei-mac'), 'keeps source');
  assert.ok(h.includes('quarantined'), 'marks quarantine');
  assert.ok(h.includes('2 flagged terms'), 'reports count');
  // The header itself must be clean — surfacing it must not re-introduce risk.
  assert.equal(scanClassifierRisk(h).risky, false, 'quarantine header must itself be classifier-safe');
});

test('neutralizeSurface defangs risky tokens but keeps them readable', () => {
  const out = neutralizeSurface('we stripped the exploit');
  assert.notEqual(out, 'we stripped the exploit', 'should change risky tokens');
  assert.equal(out.replace(/​/g, ''), 'we stripped the exploit', 'removing ZWSP restores original');
  assert.equal(scanClassifierRisk(out).risky, false, 'defanged text no longer matches');
});

test('empty / non-string inputs are safe', () => {
  assert.equal(scanClassifierRisk('').risky, false);
  assert.equal(scanClassifierRisk(null).risky, false);
  assert.equal(scanClassifierRisk(undefined).risky, false);
  assert.equal(neutralizeSurface(''), '');
  assert.ok(Array.isArray(RISK_TERMS) && RISK_TERMS.length > 0);
});

console.log(`\nclassifier-risk: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
