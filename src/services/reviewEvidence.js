// ─── services/reviewEvidence.js ────────────────────────────────
// What guests actually say about the things a facility list cannot
// answer: is it quiet at night, do the curtains keep the light out, is
// the bed good, is the staff kind.
//
// For the hotels we are about to show, read their guest reviews (Google
// Hotels Reviews through SerpApi) and ask Claude, for every open point on
// the traveller's list, whether the reviews support it, contradict it,
// disagree, or say nothing.
//
// Rules this file keeps:
//   - It runs only when there is something open to check (a wish from the
//     traveller's own words, or a need the data could not confirm).
//   - Evidence never becomes "confirmed". Reviews make a point "likely",
//     raise a "concern", or show guests are "mixed".
//   - A quote is shown only if those exact words are in a review we read.
//   - Any failure leaves the hotels exactly as they were.
//
// Cost: 1 SerpApi search per hotel for the top REVIEW_HOTELS (default 3),
// the first time that hotel is read; the reviews are then kept for REVIEW_CACHE_DAYS (default 14) and
// shared by every traveller. Plus one small Claude call per search.

import { serpApiFetch } from './livePrices.js';
import { askClaudeJSON, hasClaude } from './claude.js';
import { cacheGet, cacheSet } from './store.js';
import { count } from './usage.js';

const REVIEW_TTL   = (Number(process.env.REVIEW_CACHE_DAYS) || 14) * 24 * 60 * 60 * 1000;
const MAX_POINTS   = 5;      // open points checked per search
const MAX_HOTELS   = () => Math.max(1, Math.min(5, Number(process.env.REVIEW_HOTELS) || 3));   // reviews are read for the top few
const MAX_REVIEWS  = 14;     // reviews per hotel sent to the model
const REVIEW_CHARS = 420;

export function reviewEvidenceEnabled() {
  return !!process.env.SERPAPI_KEY && hasClaude() && process.env.REVIEW_EVIDENCE !== 'off';
}

// ── Public ────────────────────────────────────────────────────
// `fetchJson` and `ask` are injectable so tests run without the network.
export async function addReviewEvidence(hotels, quiz, { fetchJson = serpApiFetch, ask = askClaudeJSON } = {}) {
  const original = hotels;
  try {
    if (!hotels?.length) return hotels;
    const points = openPoints(hotels);
    if (points.length === 0) return hotels;
    // Reviews are read for the top few only; the rest follow unchanged.
    const rest = hotels.slice(MAX_HOTELS());
    hotels = hotels.slice(0, MAX_HOTELS());

    // 1. Reviews for every hotel we can look up (kept and shared).
    const read = await Promise.all(hotels.map(async (h) => {
      if (!h.googleToken) return [];
      try { return await reviewsFor(h, fetchJson); }
      catch (e) { console.error(`[REVIEWS] ${h.name}: ${String(e.message).slice(0, 160)}`); return []; }
    }));
    if (read.every(r => r.length === 0)) return hotels.concat(rest);

    // 2. One question to Claude for all hotels and all open points.
    const answer = await ask(buildEvidencePrompt(hotels, read, points, quiz.language), { maxTokens: 1500 * hotels.length + 800, step: 'reviews' });
    const byId = new Map((answer?.hotels || []).map(x => [String(x.id), x]));

    // 3. Fold the evidence into each hotel's checklist.
    const out = hotels.map((h, i) => applyEvidence(h, byId.get(String(i + 1)), read[i], points));
    const touched = out.filter(h => h.reviewEvidence?.points > 0).length;
    console.log(`[REVIEWS] evidence for ${touched}/${hotels.length} hotels on: ${points.join(', ')}`);

    // Evidence can change the order: a wish guests confirm beats one they complain about.
    return out.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0)).concat(rest);
  } catch (e) {
    console.error(`[REVIEWS] skipped: ${String(e?.message || e).slice(0, 200)}`);
    return original;
  }
}

// The points worth reading reviews for: the traveller's own wishes first,
// then needs the hotel data left unanswered.
export function openPoints(hotels) {
  const wishes = [], unknowns = [];
  const seen = new Set();
  for (const h of hotels) {
    for (const n of h.needsCheck || []) {
      const key = String(n.need || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      if (n.fromFreeText) { wishes.push(n.need); seen.add(key); }
      else if (n.status === 'unknown') { unknowns.push(n.need); seen.add(key); }
    }
  }
  return [...wishes, ...unknowns].slice(0, MAX_POINTS);
}

// ── Reading reviews ───────────────────────────────────────────
async function reviewsFor(hotel, fetchJson) {
  const key = 'reviews|' + hotel.googleToken;
  const hit = await cacheGet(key);
  if (hit) { count('reviewCacheHits'); return hit; }

  // "Most helpful" first: the long, detailed reviews. REVIEW_PAGES=2 also
  // reads the lowest-scored ones, where complaints (noise, light) live.
  const pages = [{}];
  if (Number(process.env.REVIEW_PAGES) >= 2) pages.push({ sort_by: '4' });

  const texts = [];
  for (const extra of pages) {
    const res = await fetchJson({ engine: 'google_hotels_reviews', property_token: hotel.googleToken, hl: 'en', ...extra });
    for (const r of res?.reviews || []) {
      const text = reviewText(r);
      if (text.length < 40) continue;                    // a bare star rating says nothing
      const best = Number(r.best_rating) || 5;
      texts.push({ text: text.slice(0, 1200), rating: Number.isFinite(Number(r.rating)) ? Math.round(Number(r.rating) / best * 50) / 10 : null,
                   when: typeof r.date === 'string' ? r.date.slice(0, 30) : '', source: typeof r.source === 'string' ? r.source.slice(0, 30) : '' });
    }
  }
  await cacheSet(key, texts, REVIEW_TTL);
  return texts;
}

function reviewText(r) {
  const parts = [typeof r?.snippet === 'string' ? r.snippet : ''];
  for (const a of Array.isArray(r?.attributes) ? r.attributes : []) {
    if (a?.snippet) parts.push(`${a.name || ''}: ${a.snippet}`);
  }
  return parts.join(' ').replace(/\|\|?/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Prompt ────────────────────────────────────────────────────
export function buildEvidencePrompt(hotels, read, points, language) {
  const blocks = hotels.map((h, i) => {
    const reviews = (read[i] || []).slice(0, MAX_REVIEWS)
      .map((r, j) => `  (${j + 1}) [${r.rating ?? '?'}/5${r.when ? ', ' + r.when : ''}] ${r.text.slice(0, REVIEW_CHARS)}`);
    return `HOTEL ${i + 1}: ${h.name}\n${reviews.length ? reviews.join('\n') : '  (no reviews available)'}`;
  }).join('\n\n');

  const lang = language && !/^en/i.test(language) ? `Write every "note" in this language: ${language}.` : 'Write every "note" in English.';

  return `You are checking guest reviews of hotels against what one traveller cares about.

POINTS TO CHECK:
${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}

GUEST REVIEWS:
${blocks}

For every hotel and every point, decide from these reviews only:
- "supported": guests describe it positively (for "quiet room": slept well, quiet, no noise).
- "contradicted": guests complain about exactly this (noise, light coming in, thin walls...).
- "mixed": some guests say one thing, some the opposite.
- "silent": the reviews do not talk about it. This is the usual answer; do not stretch.

Rules:
- Use only what these reviews say. General praise ("great hotel") supports nothing specific.
- "mentions" is how many of the reviews above talk about the point.
- "quote" is up to 12 consecutive words copied exactly from one review, the clearest evidence. Omit it when silent.
- "note" is one plain sentence of at most 14 words summing up what guests say. Omit it when silent.
- Keep the whole reply short: no commentary outside the JSON.
- ${lang}

Reply with JSON only:
{
  "hotels": [
    { "id": 1, "points": [ { "point": "<exactly as listed>", "verdict": "supported" | "contradicted" | "mixed" | "silent", "mentions": 0, "note": "...", "quote": "..." } ] }
  ]
}`;
}

// ── Folding the answer into the hotel ─────────────────────────
const STATUS = { supported: 'likely', contradicted: 'concern', mixed: 'mixed' };
const SCORE  = { supported: 3, contradicted: -8, mixed: -2 };

export function applyEvidence(hotel, answer, reviews, points) {
  if (!answer || !Array.isArray(answer.points) || !reviews?.length) return hotel;
  const haystack = normalise(reviews.map(r => r.text).join(' \n '));
  const byPoint = new Map(answer.points.filter(p => p && typeof p.point === 'string').map(p => [p.point.toLowerCase().trim(), p]));

  let delta = 0, used = 0;
  const needsCheck = (hotel.needsCheck || []).map(n => {
    const p = byPoint.get(String(n.need).toLowerCase().trim());
    const status = p && STATUS[p.verdict];
    if (!status || !points.some(x => x.toLowerCase() === String(n.need).toLowerCase())) return n;
    // What the hotel's own data settled stays settled; reviews speak to the open points.
    if (n.status === 'yes' || n.status === 'no') return n;

    const quote = typeof p.quote === 'string' ? p.quote.trim().replace(/^["'“”]+|["'“”.]+$/g, '') : '';
    const real  = quote && quote.split(/\s+/).length <= 14 && haystack.includes(normalise(quote));
    const note  = typeof p.note === 'string' && p.note.trim() ? p.note.trim().slice(0, 110) : null;
    if (!note && !real) return n;                        // a verdict with nothing to show for it is not evidence

    delta += SCORE[p.verdict]; used++;
    const mentions = Math.max(1, Math.min(reviews.length, Math.round(Number(p.mentions)) || 1));
    return { ...n, status, evidence: 'reviews', mentions,
             ...(note ? { note } : {}), ...(real ? { quote: quote.slice(0, 110) } : {}) };
  });

  if (used === 0) return { ...hotel, reviewEvidence: { reviewsRead: reviews.length, points: 0 } };
  return {
    ...hotel,
    needsCheck,
    matchScore: hotel.matchScore == null ? hotel.matchScore : Math.max(20, Math.min(98, hotel.matchScore + delta)),
    reviewEvidence: { reviewsRead: reviews.length, points: used, source: 'Google Hotels reviews' },
  };
}

function normalise(s) {
  return String(s).toLowerCase().replace(/[“”"'’`.,!?;:()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}
