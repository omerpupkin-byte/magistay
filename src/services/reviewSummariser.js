// ─── services/reviewSummariser.js ────────────────────────────
// Sends raw guest reviews to Claude and extracts structured themes:
//   - What guests keep loving (with frequency counts)
//   - What keeps coming up as a problem (with frequency counts)
//   - Recency tags (last 30 days / last 90 days)
//
// Falls back to pre-built mock summaries if no API key.
// Runs in parallel across all hotels for speed.

import Anthropic from '@anthropic-ai/sdk';

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── Main entry ────────────────────────────────────────────────
export async function summariseReviews(hotels) {
  if (!client) {
    console.log('[REVIEWS] No API key — using mock summaries');
    return hotels.map(h => ({ ...h, reviews: mockSummary(h) }));
  }

  // Run all hotels in parallel
  const results = await Promise.all(
    hotels.map(h => summariseHotel(h))
  );
  return results;
}

// ── Summarise one hotel ───────────────────────────────────────
async function summariseHotel(hotel) {
  if (!hotel.rawReviews || hotel.rawReviews.length === 0) {
    return { ...hotel, reviews: emptyReviews() };
  }

  try {
    const prompt = buildReviewPrompt(hotel);
    const message = await client.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw    = message.content[0]?.text || '';
    const parsed = JSON.parse(extractJSON(raw));

    return {
      ...hotel,
      reviews: {
        loves:     parsed.loves    || [],
        complaints: parsed.complaints || [],
        totalReviews: hotel.totalReviews,
        source:    'ai',
      },
    };
  } catch (e) {
    console.error(`[REVIEWS] Error for ${hotel.id}:`, e.message);
    return { ...hotel, reviews: mockSummary(hotel) };
  }
}

// ── Prompt ────────────────────────────────────────────────────
function buildReviewPrompt(hotel) {
  const reviews = hotel.rawReviews.join('\n- ');

  return `You are analysing guest reviews for ${hotel.name} to extract key recurring themes.

Guest reviews:
- ${reviews}

Extract:
1. Up to 5 things guests keep LOVING (recurring positive themes)
2. Up to 4 things that keep coming up as PROBLEMS or caveats

For each item, estimate how often it is mentioned (as a multiplier like "mentioned 847×").
Also assign a recency tag: "month" (feels recent/current) or "quarter" (older but still relevant).

Return ONLY valid JSON:
{
  "loves": [
    { "text": "Stunning sea views", "frequency": "847×", "recency": "month" },
    { "text": "Exceptional staff", "frequency": "612×", "recency": "month" }
  ],
  "complaints": [
    { "text": "Beach crowded at midday", "frequency": "334×", "recency": "month" },
    { "text": "Parking very limited", "frequency": "278×", "recency": "quarter" }
  ]
}

Rules:
- Keep each item to 3–5 words. Concise.
- frequency should be realistic based on how often the theme appears in the reviews provided.
- recency "month" = this issue/feature feels current; "quarter" = mentioned but may be improving.`;
}

// ── Mock summary (no API key) ─────────────────────────────────
// Pre-built summaries that match the real data structure exactly.
function mockSummary(hotel) {
  const summaries = {
    'bcn-001': {
      loves: [
        { text: 'Stunning sea views',     frequency: '847×', recency: 'month' },
        { text: 'Exceptional staff',       frequency: '612×', recency: 'month' },
        { text: 'Breakfast buffet quality',frequency: '389×', recency: 'month' },
        { text: 'Room size & modern feel', frequency: '201×', recency: 'quarter' },
      ],
      complaints: [
        { text: 'Beach crowded at midday',     frequency: '334×', recency: 'month' },
        { text: 'Parking very limited',        frequency: '278×', recency: 'month' },
        { text: 'Pool fills fast in summer',   frequency: '156×', recency: 'quarter' },
        { text: 'Check-in queue at peak times',frequency: '89×',  recency: 'quarter' },
      ],
    },
    'bcn-002': {
      loves: [
        { text: 'Boutique feel & design',     frequency: '312×', recency: 'month' },
        { text: 'Perfect El Born location',   frequency: '289×', recency: 'month' },
        { text: 'Rooftop bar at sunset',      frequency: '178×', recency: 'quarter' },
      ],
      complaints: [
        { text: 'Rooms on the small side',  frequency: '234×', recency: 'month' },
        { text: 'Street noise until midnight',frequency: '198×', recency: 'month' },
        { text: 'No pool on site',           frequency: '145×', recency: 'quarter' },
      ],
    },
    'bcn-003': {
      loves: [
        { text: 'Rooftop pool views',  frequency: '134×', recency: 'month' },
        { text: 'Value for money',     frequency: '98×',  recency: 'quarter' },
      ],
      complaints: [
        { text: 'Inconsistent room quality',frequency: '112×', recency: 'month' },
        { text: 'Slow check-in at peak',    frequency: '87×',  recency: 'month' },
        { text: 'Wi-Fi unreliable',         frequency: '64×',  recency: 'quarter' },
      ],
    },
    'lis-001': {
      loves: [
        { text: 'Flawless, attentive service', frequency: '621×', recency: 'month' },
        { text: 'Rooftop views over Lisbon',   frequency: '489×', recency: 'month' },
        { text: 'Exceptional breakfast',       frequency: '344×', recency: 'month' },
        { text: 'Beautiful hotel design',      frequency: '298×', recency: 'quarter' },
      ],
      complaints: [
        { text: 'Very high price point', frequency: '201×', recency: 'quarter' },
        { text: 'Spa books up quickly',  frequency: '98×',  recency: 'month' },
      ],
    },
    'lis-002': {
      loves: [
        { text: 'Charming boutique atmosphere', frequency: '287×', recency: 'month' },
        { text: 'Exceptional breakfast quality',frequency: '234×', recency: 'month' },
        { text: 'Great Príncipe Real location', frequency: '198×', recency: 'month' },
      ],
      complaints: [
        { text: 'No pool or spa on site', frequency: '112×', recency: 'quarter' },
        { text: 'Rooms a little small',   frequency: '89×',  recency: 'quarter' },
      ],
    },
    'rom-001': {
      loves: [
        { text: 'Beautiful secret garden',  frequency: '534×', recency: 'month' },
        { text: 'Discreet, anticipatory service',frequency: '412×', recency: 'month' },
        { text: 'Extraordinary pastries at breakfast',frequency: '289×', recency: 'month' },
        { text: 'Perfect romantic atmosphere',frequency: '234×', recency: 'quarter' },
      ],
      complaints: [
        { text: 'Very expensive',    frequency: '312×', recency: 'quarter' },
        { text: 'Pool is quite small',frequency: '145×', recency: 'month' },
      ],
    },
  };

  const summary = summaries[hotel.id] || defaultSummary();
  return {
    ...summary,
    totalReviews: hotel.totalReviews,
    source: 'mock',
  };
}

function defaultSummary() {
  return {
    loves: [
      { text: 'Great location',    frequency: '124×', recency: 'month' },
      { text: 'Friendly staff',    frequency: '98×',  recency: 'month' },
      { text: 'Good breakfast',    frequency: '67×',  recency: 'quarter' },
    ],
    complaints: [
      { text: 'Can get noisy',     frequency: '45×',  recency: 'quarter' },
      { text: 'Parking limited',   frequency: '32×',  recency: 'quarter' },
    ],
  };
}

function emptyReviews() {
  return { loves: [], complaints: [], totalReviews: 0, source: 'empty' };
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}
