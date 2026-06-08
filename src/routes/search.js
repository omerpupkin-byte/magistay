// ─── routes/search.js ─────────────────────────────────────────
// Single endpoint: POST /api/search
// Orchestrates: hotel search → AI matching → review summarisation

import { Router }           from 'express';
import { searchHotels }     from '../services/hotelSearch.js';
import { matchHotelsWithAI } from '../services/aiMatcher.js';
import { summariseReviews }  from '../services/reviewSummariser.js';
import { validateQuiz }      from '../utils/validateQuiz.js';

const router = Router();

// ── Simple in-memory cache ─────────────────────────────────────
// Key: destination+checkIn+checkOut+adults+budget
// TTL: 30 minutes
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCacheKey(quiz) {
  return `${quiz.destination}|${quiz.checkIn}|${quiz.checkOut}|${quiz.adults}|${quiz.budget}|${quiz.stars}`;
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Limit cache size
  if (cache.size > 100) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

// POST /api/search
// Body: quiz answers (see validateQuiz for full schema)
// Returns: { hotels: [...], meta: { ... } }
router.post('/search', async (req, res, next) => {
  try {
    // 1. Validate incoming quiz data
    const { valid, error, quiz } = validateQuiz(req.body);
    if (!valid) {
      return res.status(400).json({ error: `Invalid request: ${error}` });
    }

    console.log(`[SEARCH] Destination: "${quiz.destination}" · ${quiz.adults} adults · ${quiz.infants} infants`);

    // Check cache first
    const cacheKey = getCacheKey(quiz);
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`[SEARCH] Cache hit for "${quiz.destination}"`);
      return res.json({ ...cached, meta: { ...cached.meta, source: 'cache' } });
    }

    // 2. Find candidate hotels (mock or real API)
    const candidates = await searchHotels(quiz);
    console.log(`[SEARCH] Found ${candidates.length} candidates`);

    if (candidates.length === 0) {
      return res.json({ hotels: [], meta: { count: 0, source: 'search' } });
    }

    // 3. AI matching — score + rank + explain
    const matched = await matchHotelsWithAI(quiz, candidates);
    console.log(`[SEARCH] AI matched top ${matched.length} hotels`);

    // 4. Review summarisation (runs in parallel for speed)
    const withReviews = await summariseReviews(matched);

    // 5. Save to cache and return
    const result = {
      hotels: withReviews,
      meta: {
        count:       withReviews.length,
        destination: quiz.destination,
        nights:      quiz.nights || null,
        source:      process.env.ANTHROPIC_API_KEY ? 'ai' : 'mock',
        ts:          new Date().toISOString(),
      },
    };
    setCache(cacheKey, result);
    res.json(result);

  } catch (err) {
    next(err);
  }
});

// GET /api/search/test — quick sanity check without quiz submission
router.get('/search/test', (_req, res) => {
  res.json({ ok: true, message: 'Search route is alive' });
});

export default router;
