// ─── services/aiCandidates.js ──────────────────────────────────
// Last-resort hotel source: when no supplier has inventory for a
// destination (or the supplier is down / out of quota), ask Claude for
// well-known hotels there that suit the traveller.
//
// These are SUGGESTIONS FROM GENERAL KNOWLEDGE, not live inventory:
//   • no price, no availability, no guest rating is attached
//   • every hotel is marked source: 'ai_knowledge' so the page can say so
//   • the traveller checks live price and availability on the booking
//     platform (through our affiliate links)
//
// Disable with AI_FALLBACK=off.

import { askClaudeJSON, hasClaude } from './claude.js';
import { describeTraveller, listNeeds } from './travellerProfile.js';

const MAX_SUGGESTIONS = 5;

export function aiFallbackEnabled() {
  return hasClaude() && process.env.AI_FALLBACK !== 'off';
}

export async function suggestHotelsFromKnowledge(quiz) {
  if (!aiFallbackEnabled() || !quiz.destination) return [];

  console.log(`[AI CANDIDATES] No supplier inventory — asking Claude for hotels in "${quiz.destination}"`);
  const parsed = await askClaudeJSON(buildPrompt(quiz), { maxTokens: 3000 });
  const hotels = (parsed.hotels || [])
    .filter(h => h && typeof h.name === 'string' && h.name.trim())
    .slice(0, MAX_SUGGESTIONS)
    .map((h, i) => normalise(h, i, quiz));

  console.log(`[AI CANDIDATES] ${hotels.length} suggestions`);
  return hotels.sort((a, b) => b.matchScore - a.matchScore);
}

export function buildPrompt(quiz) {
  const needs = listNeeds(quiz);
  return `You are the hotel expert of Magistay, a hotel recommendation service.

THE TRAVELLER
${describeTraveller(quiz)}

We have no live inventory for this destination, so recommend from your own knowledge.

Recommend up to ${MAX_SUGGESTIONS} real hotels in or near the destination that suit THIS traveller, best first.

Strict rules:
- Only hotels you are confident exist and are operating under that exact name. If you are not sure, leave it out. Fewer, certain hotels beat more, doubtful ones.
- If you do not know the destination or cannot name hotels there with confidence, return {"hotels": []}.
- Do not state prices, availability or review scores — you do not have live data.
- For each need, say "likely" only if the hotel is well known for it; otherwise "unknown". Never claim certainty.

Return ONLY valid JSON:
{
  "hotels": [
    {
      "name": "<exact hotel name>",
      "area": "<neighbourhood / town>",
      "city": "<city or island>",
      "country": "<country>",
      "stars": <1-5, or 0 if unsure>,
      "lat": <approximate latitude or null>,
      "lng": <approximate longitude or null>,
      "matchScore": <0-100, honest fit for this traveller>,
      "matchReason": "<2 sentences to the traveller: why it fits their trip, and the main thing to double-check>",
      "knownFor": ["<up to 4 short things the hotel is known for>"],
      "needs": [${needs.length ? '{ "need": "<label exactly as listed below>", "status": "likely" | "unknown" }' : ''}]
    }
  ]
}
${needs.length ? `\nNeeds to assess for every hotel:\n${needs.map(n => `  - ${n}`).join('\n')}` : ''}`;
}

function normalise(h, i, quiz) {
  const needs = listNeeds(quiz);
  const given = new Map((Array.isArray(h.needs) ? h.needs : [])
    .filter(n => n && typeof n.need === 'string')
    .map(n => [n.need.toLowerCase(), n.status === 'likely' ? 'likely' : 'unknown']));

  const lat = Number.isFinite(Number(h.lat)) && h.lat !== null ? Number(h.lat) : null;
  const lng = Number.isFinite(Number(h.lng)) && h.lng !== null ? Number(h.lng) : null;
  const stars = Math.round(Number(h.stars));
  const score = Math.round(Number(h.matchScore));

  return {
    id:           `ai-${slug(h.name)}-${i}`,
    source:       'ai_knowledge',
    name:         h.name.trim(),
    location:     str(h.area),
    city:         str(h.city) || quiz.coords?.city || quiz.destination,
    country:      str(h.country) || quiz.coords?.country || '',
    stars:        stars >= 1 && stars <= 5 ? stars : 0,
    coords:       { lat, lng },
    // Coordinates from memory are approximate — too rough to quote a distance.
    distanceKm:   null,

    amenities:    [],
    facilities:   [],
    description:  '',
    photos:       null,
    gallery:      [],

    riScore:      null,
    riConfidence: null,
    totalReviews: 0,
    ratingSource: null,

    available:    null,          // unknown — not checked
    currency:     null,
    priceType:    null,
    platforms:    {},
    bestPrice:    null,
    bestFlex:     null,

    rawReviews:   [],
    matchScore:   Number.isFinite(score) ? Math.min(95, Math.max(0, score)) : 70,
    matchReason:  str(h.matchReason) || `A well-known option in ${quiz.destination}.`,
    needsCheck:   needs.map(need => ({ need, status: given.get(need.toLowerCase()) || 'unknown' })),
    highlights:   (Array.isArray(h.knownFor) ? h.knownFor : []).filter(x => typeof x === 'string').slice(0, 4),
    matchedBy:    'ai',
    reviews:      { loves: [], complaints: [], totalReviews: 0, source: 'empty' },
  };
}

const str  = v => (typeof v === 'string' ? v.trim() : '');
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
