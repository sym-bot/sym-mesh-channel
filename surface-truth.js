'use strict';

/**
 * surface-truth.js — the read surface must say what it CANNOT show (dev-team-2 handover m053,
 * 2026-08-25, defect 2).
 *
 * THE INCIDENT. A CMB whose `commitment` carried ~1,400 chars (three design problems) was
 * answered with "what are the three?" — the receiver's agent read the compact header, which
 * renders the FOCUS line only, and had NO indicator that any other field carried substance.
 * A bare-focus CMB and one hauling 1.4KB elsewhere were byte-identical at the surface agents
 * actually read. That is the silent-drop wire class (2026-07-18: ignored unknown params,
 * per-field SVAF muting): semantics lost, nothing errored. The wire itself measured CLEAN —
 * a 1,400-char field survives sender store → frame → SVAF → receiver store whole; the loss
 * was the surface's, so the fix is the surface's: mark elision explicitly, never let a cut
 * read as completeness.
 */

/** Fields whose text is the message's own metadata, or already on the header. */
const ON_HEADER = new Set(['focus', 'mood']);
/** Default/filler values that carry no substance worth flagging. */
const FILLER = new Set(['', 'none', 'directive', 'neutral']);

/**
 * Name the substantive fields the header cannot carry, with their weight.
 * Returns '' when everything the CMB says is already on the header — so the tag's PRESENCE
 * is the signal, and its absence is a checked claim of completeness, not a default.
 */
function hiddenFieldsTag(categories) {
  if (!categories || typeof categories !== 'object') return '';
  const parts = [];
  let bytes = 0;
  for (const [k, v] of Object.entries(categories)) {
    if (ON_HEADER.has(k)) continue;
    const raw = v && typeof v === 'object' && 'text' in v ? v.text : v;
    const s = String(raw ?? '').trim();
    if (FILLER.has(s.toLowerCase())) continue;
    // Short values render fine wherever the body is shown; the defect class is SUBSTANCE
    // hiding behind a header — a sentence or more, not a tag.
    if (s.length <= 120) continue;
    parts.push(k);
    bytes += s.length;
  }
  if (!parts.length) return '';
  const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}b`;
  return ` [+${parts.join('+')} ${size} — sym_fetch for the whole CMB]`;
}

module.exports = { hiddenFieldsTag };
