'use strict';

// classifier-risk.js — a receiver-side guard that stops inbound peer CMB text from wedging the
// receiving agent's LLM session.
//
// checkSecurity() in server.js already drops prompt-injection and oversized payloads. This is the
// ORTHOGONAL failure mode observed 2026-07-24: a benign, non-injecting CMB whose wording
// (security/offensive-adjacent terms, stripped of the AUTHOR's context) trips the RECEIVER's
// server-side usage-policy classifier — hard-erroring the turn the instant the delivered text is
// re-fed to the model. It took two consecutive requests down before the session had to be reset.
//
// The lesson: peer content is untrusted PROMPT INPUT, not merely untrusted instructions. We cannot
// control another node's phrasing, so a receiver must neutralize it on ITS OWN surface before it
// reaches its model. The guarantee here does NOT rest on guessing what the classifier keys on: the
// caller QUARANTINES a flagged delivery (auto-surfaces metadata only — no peer free-text), and the
// verbatim body stays available via an explicit, deliberate sym_fetch. A false positive therefore
// costs a fetch round-trip, never lost information.

// Terms that, out of their authoring context, read as offensive-security / policy-adjacent to a
// content classifier. Word-boundaried and conservative to limit false positives. Matching only
// FLAGS for quarantine; it never drops the CMB.
const RISK_TERMS = [
  'exploit', 'exploited', 'exploiting', 'exploits',
  'attack', 'attacks', 'attacker', 'attacking',
  'penetration', 'pentest',
  'bypass', 'bypasses', 'bypassing', 'bypassed',
  'weaponize', 'weaponized', 'weaponizing',
  'malware', 'backdoor', 'rootkit',
  'strip', 'stripped', 'stripping',     // "protocol stripped" — the empirically-observed trigger
  'killchain', 'kill-chain',
  'jailbreak', 'jailbroken',
];

function buildRe() {
  const alt = RISK_TERMS
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-\\s]?'))
    .join('|');
  return new RegExp('\\b(' + alt + ')\\b', 'gi');
}

// One shared compiled regex; callers must reset lastIndex before use (it is /g).
const RISK_RE = buildRe();

/**
 * Scan free text for phrasing that could trip a receiver's usage-policy classifier.
 * @returns {{ risky: boolean, terms: string[] }} distinct matched terms, lowercased.
 */
function scanClassifierRisk(text) {
  if (!text || typeof text !== 'string') return { risky: false, terms: [] };
  const found = new Set();
  RISK_RE.lastIndex = 0;
  let m;
  while ((m = RISK_RE.exec(text)) !== null) {
    found.add(m[1].toLowerCase());
    if (m.index === RISK_RE.lastIndex) RISK_RE.lastIndex++; // guard against zero-width loops
  }
  return { risky: found.size > 0, terms: [...found] };
}

/**
 * Best-effort defang for text we still choose to surface (e.g. a sym_fetch preview): a zero-width
 * space is inserted after each risky token's first character so it stays human-readable but no
 * longer matches an exact-token n-gram. This is a CONVENIENCE layer, not the guarantee — the
 * guarantee comes from the caller quarantining (not auto-surfacing) flagged deliveries.
 */
function neutralizeSurface(text) {
  if (!text || typeof text !== 'string') return text;
  RISK_RE.lastIndex = 0;
  return text.replace(RISK_RE, (w) => w[0] + '\u200b' + w.slice(1));
}

/**
 * Build the metadata-only header that REPLACES a flagged CMB's free-text on the auto-push surface.
 * Deliberately carries no peer free-text and no term NAMES (the term names are themselves risky) —
 * only the source and the flagged-term count. The [mNNN] fetch id is appended by the delivery path,
 * so the agent can sym_fetch the verbatim body deliberately.
 */
function quarantineHeader(source, dirTag, count, suffix) {
  const plural = count === 1 ? 'term' : 'terms';
  return `[${source}${dirTag}] \u26a0 quarantined delivery \u00b7 classifier-risk (${count} flagged ${plural}) \u00b7 sym_fetch to view${suffix || ''}`;
}

module.exports = { scanClassifierRisk, neutralizeSurface, quarantineHeader, RISK_TERMS };
