'use strict';

/**
 * signed-parts.js — the parts of a record a line may show: what its author signed (design D6; spec
 * draft #34). The seven CAT7 categories, each as its text, and the record's signed application data
 * when it is sym's payload schema (JSON). A non-CAT7 key, a mood's valence and arousal, per-category
 * metadata and the SDK's rendered `content` string were not signed, so nothing a line shows is built
 * from them.
 *
 * Both modes read the same thing: the item's `record`, the signed projection sym keeps with every
 * verified inbox item and gives in every interior delivery item.
 */

const CAT7 = Object.freeze(['focus', 'issue', 'intent', 'motivation', 'commitment', 'perspective', 'mood']);

/** The application schema `remember({ payload })` signs a payload under (a wire identifier, §8.8.3). */
const PAYLOAD_SCHEMA = 'https://sym.bot/schema/payload-v1.json';

/** The seven CAT7 categories of `cats`, each as `{ text }`; anything else is left out. */
function signedCategories(cats) {
  const out = {};
  if (!cats || typeof cats !== 'object') return out;
  for (const f of CAT7) {
    const v = cats[f];
    const t = typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.text === 'string' ? v.text : null);
    if (t !== null) out[f] = { text: t };
  }
  return out;
}

/** The payload a record signed in its application section, or null (none, another schema, not JSON). */
function signedPayload(record) {
  const app = record && record.metadata && record.metadata.application;
  if (!app || typeof app !== 'object') return null;
  if (app.schema !== PAYLOAD_SCHEMA || app.mediaType !== 'application/json' || app.encoding !== 'base64url' || typeof app.data !== 'string') return null;
  try { return JSON.parse(Buffer.from(app.data, 'base64url').toString('utf8')); } catch { return null; }
}

/** `{ categories, payload }` from a signed projection (null when there is none: nothing to show). */
function signedParts(record) {
  if (!record || typeof record !== 'object') return { categories: {}, payload: null };
  return { categories: signedCategories(record.categories), payload: signedPayload(record) };
}

module.exports = { CAT7, PAYLOAD_SCHEMA, signedCategories, signedPayload, signedParts };
