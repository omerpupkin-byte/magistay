// ─── services/aiMatcher.js ─────────────────────────────────────
// Uses Claude to score each candidate hotel against the quiz answers
// and generate a natural-language "why chosen" explanation.
//
// If ANTHROPIC_API_KEY is not set → falls back to deterministic mock scoring.
// When the key is added → real AI kicks in automatically, zero code change.

import Anthropic from '@anthropic-ai/sdk';

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MAX_RESULTS = 5;

// ── Main entry ────────────────────────────────────────────────
export async function matchHotelsWithAI(quiz, hotels) {
  if (!client) {
    console.log('[AI MATCHER] No API key — using mock scoring');
    return mockMatch(quiz, hotels);
  }

  console.log('[AI MATCHER] Calling Claude...');
  return aiMatch(quiz, hotels);
}

// ── Real AI matching ──────────────────────────────────────────
async function aiMatch(quiz, hotels) {
  const prompt = buildMatchPrompt(quiz, hotels);

  const message = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0]?.text || '';

  try {
    const parsed = JSON.parse(extractJSON(raw));
    return applyScores(hotels, parsed.matches).slice(0, MAX_RESULTS);
  } catch (e) {
    console.error('[AI MATCHER] Parse error — falling back to mock', e.message);
    return mockMatch(quiz, hotels);
  }
}

// ── Prompt builder ─────────────────────────────────────────────
function buildMatchPrompt(quiz, hotels) {
  const quizSummary = formatQuiz(quiz);
  const hotelList   = hotels.map((h, i) => formatHotelForPrompt(h, i)).join('\n\n');

  return `You are the AI matching engine for Magistay, a hotel recommendation service.

A traveller has submitted the following requirements:
${quizSummary}

Here are the candidate hotels to evaluate:
${hotelList}

Your task:
1. Score each hotel from 0–100 based on how well it matches the traveller's requirements.
2. Write a concise, specific "matched because" explanation (1–2 sentences) for each hotel.
   - Reference the specific requirements it meets (e.g. "crib available", "elevator throughout").
   - Be honest — if something may not suit them, say so briefly (e.g. "compact rooms may be tight with a crib").
3. Return ONLY valid JSON in this exact format:

{
  "matches": [
    {
      "id": "hotel-id",
      "matchScore": 94,
      "matchReason": "Beachfront access as requested, crib confirmed, elevator throughout. Breakfast included and free cancellation on your dates."
    }
  ]
}

Important:
- Include ALL hotels in the response, even low-scoring ones.
- Sort by matchScore descending.
- Be specific to the traveller's actual quiz answers, not generic.
- If they have an infant, always check for crib and accessibility.`;
}

// ── Format quiz answers for the prompt ────────────────────────
function formatQuiz(quiz) {
  const lines = [
    `Destination: ${quiz.destination || 'Not specified'}`,
    `Travelers: ${quiz.adults} adult(s), ${quiz.children || 0} child(ren), ${quiz.infants || 0} infant(s)`,
    `Rooms needed: ${quiz.rooms || 1}`,
    `Dates: ${quiz.dateFlexibility === 'exact' && quiz.checkIn ? `${quiz.checkIn} → ${quiz.checkOut}` : quiz.dateFlexibility || 'Not specified'}`,
    `Budget per night: ${quiz.budget || 'No limit'}`,
    `Star rating minimum: ${quiz.stars > 0 ? quiz.stars + '+' : 'Any'}`,
    `Vibes: ${(quiz.vibes || []).join(', ') || 'Not specified'}`,
    `Must-haves: ${(quiz.priorities || []).join(', ') || 'None specified'}`,
    `Special needs: ${formatSpecialNeeds(quiz.specialNeeds)}`,
    `Free text: ${quiz.freeText || 'None'}`,
  ];
  return lines.map(l => `  - ${l}`).join('\n');
}

function formatSpecialNeeds(needs) {
  if (!needs || typeof needs !== 'object') return 'None';
  const all = Object.values(needs).flat();
  return all.length > 0 ? all.join(', ') : 'None';
}

// ── Format a hotel for the prompt ─────────────────────────────
function formatHotelForPrompt(hotel, index) {
  return [
    `Hotel ${index + 1}: ${hotel.name} (id: ${hotel.id})`,
    `  Location: ${hotel.location}, ${hotel.city} · ${hotel.stars}★ · ${hotel.distanceKm}km from center`,
    `  RI Score: ${hotel.riScore} (${hotel.riConfidence} confidence, ${hotel.totalReviews?.toLocaleString()} reviews)`,
    `  Price range: $${hotel.bestPrice?.price || '?'}/night (best) — $${hotel.bestFlex?.price || 'N/A'}/night (flexible)`,
    `  Amenities: ${hotel.amenities.join(', ')}`,
  ].join('\n');
}

// ── Apply AI scores back to hotel objects ─────────────────────
function applyScores(hotels, matches) {
  return hotels
    .map(hotel => {
      const match = matches.find(m => m.id === hotel.id);
      return {
        ...hotel,
        matchScore:  match?.matchScore  ?? 50,
        matchReason: match?.matchReason ?? 'Good overall match.',
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore);
}

// ── Extract JSON from Claude response ─────────────────────────
function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

// ── Mock scoring (no API key) ─────────────────────────────────
// Deterministic scoring based on amenity matching.
// Produces realistic results for development and testing.
function mockMatch(quiz, hotels) {
  const scored = hotels.map(hotel => {
    let score = 60; // base score
    const reasons = [];
    const warnings = [];

    // +Amenity matching
    const wants = [
      ...(quiz.priorities || []),
      ...(quiz.infants > 0 ? ['crib'] : []),
      ...(quiz.specialNeeds?.accessibility || []),
    ];

    for (const want of wants) {
      if (hotel.amenities.includes(want)) {
        score += 6;
        reasons.push(wantLabel(want));
      } else if (want === 'crib' && quiz.infants > 0) {
        score -= 15;
        warnings.push('crib not listed — confirm with hotel');
      }
    }

    // +Star match
    if (quiz.stars && hotel.stars >= quiz.stars) {
      score += 5;
    }

    // +RI confidence
    if (hotel.riConfidence === 'high')     score += 8;
    if (hotel.riConfidence === 'moderate') score += 4;
    if (hotel.riConfidence === 'low')      score -= 5;

    // +Distance
    if (hotel.distanceKm <= 1)  score += 6;
    if (hotel.distanceKm <= 2)  score += 3;
    if (hotel.distanceKm > 5)   score -= 4;

    // Clamp 0–99
    score = Math.min(99, Math.max(30, Math.round(score)));

    // Build reason string
    const reasonParts = reasons.slice(0, 3);
    const warningPart = warnings.length > 0 ? ` Note: ${warnings[0]}.` : '';
    const matchReason = reasonParts.length > 0
      ? `${reasonParts.join(', ')}.${warningPart}`
      : `Good overall match for your trip to ${quiz.destination || 'your destination'}.`;

    return { ...hotel, matchScore: score, matchReason };
  });

  return scored
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, MAX_RESULTS);
}

// ── Amenity → human label ─────────────────────────────────────
function wantLabel(want) {
  const map = {
    crib:              'Crib confirmed available',
    breakfast:         'Breakfast included',
    elevator:          'Elevator throughout — no stairs',
    pool:              'Pool on site',
    free_cancellation: 'Free cancellation available',
    sea_view:          'Sea view rooms available',
    walkable:          'Walkable city-center location',
    spa:               'Spa on site',
    parking:           'Parking available',
    wheelchair_accessible: 'Wheelchair accessible throughout',
    late_checkout:     'Late checkout available',
    beach_access:      'Direct beach access',
    rooftop:           'Rooftop terrace',
    restaurant:        'Restaurant on site',
    gym:               'Gym & fitness centre',
    pet:               'Pet friendly',
    kosher:            'Kosher dining available',
    halal:             'Halal dining available',
  };
  return map[want] || want.replace(/_/g, ' ');
}
