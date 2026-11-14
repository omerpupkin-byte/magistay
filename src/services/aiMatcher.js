// ─── services/aiMatcher.js ─────────────────────────────────────
// Ranks candidate hotels against the traveller's brief and explains why.
//
// With ANTHROPIC_API_KEY: Claude reads the brief and each hotel's real
// data (facilities, rates, rating, distance) and returns the best five,
// each with a reason and a need-by-need checklist.
//
// Without the key, or if the call fails: a deterministic scorer does the
// same job from the amenity data alone. It never invents facts — a need
// the data does not confirm is reported as "unknown".

import { askClaudeJSON, hasClaude } from './claude.js';
import { describeTraveller, listNeeds, checkAllNeeds } from './travellerProfile.js';

const MAX_RESULTS    = 5;
const MAX_CANDIDATES = 20;   // sent to the AI; keeps the call fast

// ── Main entry ────────────────────────────────────────────────
// `limit` is how many ranked hotels to return. The search asks for more
// than it shows, so a hotel that turns out not to be bookable can be
// replaced by the next best match. Claude ranks at most MAX_AI_RANKED
// (a longer answer is slow); the rest of the list follows the rule ranking.
const MAX_AI_RANKED = 8;

// Why the last AI call fell back to rules, for the check endpoint.
let lastFailure = null;
export function lastAIFailure() { return lastFailure; }

export async function matchHotelsWithAI(quiz, hotels, { limit = MAX_RESULTS } = {}) {
  if (hotels.length === 0) return [];
  limit = Math.max(1, Math.min(limit, 20));

  // Deterministic baseline: used to shortlist, and as the fallback result.
  const baseline = hotels.map(h => baselineScore(quiz, h)).sort((a, b) => b.matchScore - a.matchScore);
  const byRules  = (list) => list.map(h => ({ ...h, matchedBy: 'rules' }));

  if (!hasClaude()) {
    console.log('[AI MATCHER] No API key — using rule-based scoring');
    return byRules(baseline.slice(0, limit));
  }

  const shortlist = baseline.slice(0, MAX_CANDIDATES);
  const aiCount   = Math.min(limit, MAX_AI_RANKED);
  try {
    console.log(`[AI MATCHER] Calling Claude with ${shortlist.length} candidates...`);
    const parsed = await askClaudeJSON(buildMatchPrompt(quiz, shortlist, aiCount), { maxTokens: 600 * aiCount });
    const ranked = applyAIResult(quiz, shortlist, parsed.matches || []).slice(0, aiCount);
    if (ranked.length === 0) throw new Error('AI returned no usable matches');
    lastFailure = null;
    // Reserve beyond the AI's picks: next best by rules, not already chosen.
    const chosen = new Set(ranked.map(h => h.id));
    return ranked.concat(byRules(baseline.filter(h => !chosen.has(h.id)))).slice(0, limit);
  } catch (e) {
    lastFailure = { at: new Date().toISOString(), message: String(e?.message || e).slice(0, 300), status: e?.status ?? null, type: e?.name || null };
    console.error('[AI MATCHER] Falling back to rule-based scoring:', e.message);
    return byRules(baseline.slice(0, limit));
  }
}

// ── Prompt ────────────────────────────────────────────────────
export function buildMatchPrompt(quiz, hotels, limit = MAX_RESULTS) {
  const needs = listNeeds(quiz);
  return `You are the matching engine of Magistay, a hotel recommendation service. You act as a meticulous travel agent who reads the fine print.

THE TRAVELLER
${describeTraveller(quiz)}

THE CANDIDATE HOTELS (all have a room on these dates unless marked otherwise)
${hotels.map(formatHotelForPrompt).join('\n\n')}

YOUR TASK
Pick the ${Math.min(limit, hotels.length)} hotels that best fit THIS traveller and rank them, best first.

Judge fit the way a great agent would: who is travelling and why, the stated must-haves and needs, location for their plans, value against their budget, and guest rating. A hotel that misses a must-have should rank below one that meets it, unless everything else is far better.

Rules about facts — these matter more than anything else:
- Use ONLY the data given above for each hotel. Do not add facts from memory.
- If the data does not say whether the hotel has something, the status is "unknown". Never guess "yes".
- "Stated as NOT offered" is a fact: that need is "no".
- Review themes are evidence about quality (sleep, cleanliness, service...), not proof that a facility exists.
- Prices shown are indicative. Do not promise a price.

Return ONLY valid JSON, no prose around it:
{
  "matches": [
    {
      "id": "<hotel id exactly as given>",
      "matchScore": <0-100, honest — reserve 90+ for a hotel that meets every stated need>,
      "matchReason": "<2 sentences to the traveller, specific to their trip. Mention the most important fit and, if there is one, the main compromise.>",
      "needs": [${needs.length ? '\n        { "need": "<need label exactly as listed below>", "status": "yes" | "no" | "unknown", "note": "<optional, max 8 words>" }\n      ' : ''}],
      "highlights": ["<up to 3 short facts from the data that suit this traveller>"]
    }
  ]
}
${needs.length ? `\nThe needs to check for every hotel, in this order:\n${needs.map(n => `  - ${n}`).join('\n')}` : '\nThe traveller listed no specific needs, so "needs" is an empty array.'}`;
}

function formatHotelForPrompt(h, i) {
  const cur = h.currency || 'USD';
  const lines = [
    `Hotel ${i + 1} — ${h.name} (id: ${h.id})`,
    `  Where: ${[h.location, h.city, h.country].filter(Boolean).join(', ')}${h.distanceKm != null ? ` · ${h.distanceKm} km from ${h.distanceFrom || 'the centre'}` : ''}`,
    `  Class: ${h.stars > 0 ? h.stars + '★' : 'unrated'}`,
    `  Guest rating: ${h.riScore ? `${h.riScore}/10 from ${h.totalReviews} reviews${h.ratingSource ? ` (${h.ratingSource})` : ''}` : 'no rating data'}`,
  ];

  if (h.bestPrice?.price != null) {
    let price = `  Price: from ${h.bestPrice.price} ${cur}/night (indicative)`;
    if (h.bestFlex?.price != null) price += ` · refundable from ${h.bestFlex.price} ${cur}/night${h.bestFlex.terms ? ` (${h.bestFlex.terms})` : ''}`;
    if (h.breakfastPrice != null)  price += ` · with breakfast from ${h.breakfastPrice} ${cur}/night`;
    lines.push(price);
  } else {
    lines.push('  Price: not available — traveller checks live price on the booking platform');
  }
  if (h.available === false) lines.push('  Availability: NOT confirmed for these dates');
  if (h.boards?.length)      lines.push(`  Meal plans offered: ${h.boards.slice(0, 6).join(', ')}`);
  if (h.facilities?.length)  lines.push(`  Facilities: ${h.facilities.slice(0, 45).join('; ')}`);
  else if (h.amenities?.length) lines.push(`  Amenities: ${h.amenities.join(', ')}`);
  else lines.push('  Facilities: no facility data');
  if (h.excluded?.length)    lines.push(`  Stated as NOT offered: ${h.excluded.slice(0, 20).join('; ')}`);
  if (h.reviewThemes?.length) lines.push(`  What guest reviews say: ${h.reviewThemes.map(t => `${t.theme} ${Math.round(100 * t.positive / Math.max(1, t.mentions))}% positive of ${t.mentions} mentions`).join('; ')}`);
  if (h.locationRating != null) lines.push(`  Location rating: ${h.locationRating}/5`);
  if (h.nearby?.length)      lines.push(`  Nearby: ${h.nearby.join('; ')}`);
  if (h.checkInTime || h.checkOutTime) lines.push(`  Check-in from ${h.checkInTime || '?'}, check-out by ${h.checkOutTime || '?'}`);
  if (h.description)         lines.push(`  Description: ${h.description.slice(0, 380)}`);
  return lines.join('\n');
}

// ── Merge the AI's answer onto the hotel objects ──────────────
function applyAIResult(quiz, hotels, matches) {
  const byId   = new Map(hotels.map(h => [h.id, h]));
  const needs  = listNeeds(quiz);
  const result = [];

  for (const m of matches) {
    const hotel = byId.get(m?.id);
    if (!hotel || result.some(r => r.id === hotel.id)) continue;

    // Keep the checklist in the traveller's order; anything the AI skipped
    // falls back to what the data alone confirms.
    const fromData = new Map(hotel.needsCheck.map(n => [n.need.toLowerCase(), n]));
    const fromAI   = new Map((Array.isArray(m.needs) ? m.needs : [])
      .filter(n => n && typeof n.need === 'string' && ['yes', 'no', 'unknown'].includes(n.status))
      .map(n => [n.need.toLowerCase(), n]));

    const needsCheck = needs.map(need => {
      const ai = fromAI.get(need.toLowerCase());
      if (!ai) return fromData.get(need.toLowerCase()) || { need, status: 'unknown' };
      const item = { need, status: ai.status };
      if (typeof ai.note === 'string' && ai.note.trim()) item.note = ai.note.trim().slice(0, 80);
      return item;
    });

    result.push({
      ...hotel,
      matchScore:  clampScore(m.matchScore, hotel.matchScore),
      matchReason: typeof m.matchReason === 'string' && m.matchReason.trim() ? m.matchReason.trim() : hotel.matchReason,
      needsCheck,
      highlights:  Array.isArray(m.highlights) ? m.highlights.filter(x => typeof x === 'string').slice(0, 3) : [],
      matchedBy:   'ai',
    });
  }
  return result.sort((a, b) => b.matchScore - a.matchScore);
}

function clampScore(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

// ── Rule-based scoring ────────────────────────────────────────
// Score = how many stated needs the hotel's data confirms, plus rating,
// location and budget fit. Explains itself only with confirmed facts.
export function baselineScore(quiz, hotel) {
  const needsCheck = checkAllNeeds(quiz, hotel);
  const met = needsCheck.filter(n => n.status === 'yes');

  let score = 55;
  if (needsCheck.length > 0) score += Math.round((met.length / needsCheck.length) * 25);
  else score += 10;

  // A rating built on a handful of reviews says little, so it earns no bonus.
  if (hotel.riScore && hotel.totalReviews >= 50) score += Math.round((hotel.riScore - 7) * 4);   // 9.0 → +8, 6.0 → −4
  if (hotel.riConfidence === 'high') score += 2;
  if (quiz.stars && hotel.stars >= quiz.stars) score += 3;

  if (hotel.distanceKm != null) {
    if (hotel.distanceKm <= 1)      score += 5;
    else if (hotel.distanceKm <= 3) score += 2;
    else if (hotel.distanceKm > 10) score -= 4;
  }

  const fit = budgetFit(quiz.budget, hotel.bestPrice?.price);
  if (fit === 'within') score += 6;
  if (fit === 'over')   score -= 12;

  score = Math.min(97, Math.max(20, score));

  const parts = met.slice(0, 3).map(n => n.need);
  let matchReason = parts.length
    ? `Confirmed for your trip: ${parts.join(', ')}.`
    : `A solid option for ${quiz.destination || 'your trip'}.`;
  const unknown = needsCheck.filter(n => n.status !== 'yes');
  if (unknown.length) matchReason += ` Check with the hotel: ${unknown.slice(0, 2).map(n => n.need).join(', ')}.`;

  return { ...hotel, matchScore: score, matchReason, needsCheck, highlights: [] };
}

// Budget bands are in USD per night; rates may come in another currency,
// so this is deliberately a loose check (within 15% counts as within).
function budgetFit(budget, price) {
  const bands = { u80: [0, 80], '80_150': [80, 150], '150_250': [150, 250], '250plus': [250, Infinity] };
  const band = bands[budget];
  if (!band || price == null) return 'unknown';
  if (price > band[1] * 1.15) return 'over';
  if (price < band[0] * 0.6)  return 'under';
  return 'within';
}
