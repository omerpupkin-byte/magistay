// ─── routes/search.js ─────────────────────────────────────────
// POST /api/search
// quiz → candidate hotels → AI matching → response
//
// The supplier search (slow, quota-limited) is cached by trip.
// The matching is NOT cached: two travellers going to the same place on
// the same dates want different hotels.

import { Router }            from 'express';
import { searchHotels }      from '../services/hotelSearch.js';
import { matchHotelsWithAI } from '../services/aiMatcher.js';
import { summariseReviews }  from '../services/reviewSummariser.js';
import { validateQuiz }      from '../utils/validateQuiz.js';
import { hasClaude }         from '../services/claude.js';
import { pickBookable, livePricesEnabled } from '../services/livePrices.js';

const router = Router();

// ── Candidate cache ───────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 200;

const SHOW    = 5;   // hotels on the results page
const RESERVE = 3;   // extra ranked hotels, used when one cannot be booked

// Everything that changes which hotels (or which prices) come back.
function tripKey(quiz) {
  return [
    quiz.destination.toLowerCase(), quiz.checkIn, quiz.checkOut,
    quiz.adults, quiz.children, quiz.infants, quiz.rooms,
    quiz.childAges.join('.'), quiz.radiusKm, quiz.stars,
  ].join('|');
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ── POST /api/search ──────────────────────────────────────────
router.post('/search', async (req, res, next) => {
  try {
    const { valid, error, quiz } = validateQuiz(req.body);
    if (!valid) return res.status(400).json({ error: `Invalid request: ${error}` });
    if (!quiz.destination) return res.status(400).json({ error: 'Invalid request: destination is required' });

    console.log(`[SEARCH] "${quiz.destination}" · ${quiz.adults}A ${quiz.children}C ${quiz.infants}I · ${quiz.checkIn}→${quiz.checkOut}`);

    // 1. Candidates. AI suggestions are tailored to the traveller, so
    //    only real supplier results are shared between travellers.
    const key = tripKey(quiz);
    let found = getCache(key);
    const cached = !!found;
    if (!found) {
      found = await searchHotels(quiz);
      if (!found.preMatched && found.hotels.length > 0) setCache(key, found);
    }

    if (found.hotels.length === 0) {
      return res.json({ hotels: [], meta: meta(quiz, found, cached, 0) });
    }

    // 2. Match to this traveller (AI suggestions arrive already matched).
    //    With live prices on, rank a few extra so a hotel that cannot be
    //    booked on these dates can be replaced by the next best match.
    const live    = found.source !== 'mock' && livePricesEnabled();
    const matched = found.preMatched
      ? found.hotels
      : await matchHotelsWithAI(quiz, found.hotels, { limit: live ? SHOW + RESERVE : SHOW });

    // 3. Live price per booking platform; keeps the best SHOW that can be
    //    booked. Demo data keeps its sample prices. Never throws.
    const priced = live ? await pickBookable(matched, quiz, { show: SHOW }) : matched.slice(0, SHOW);

    // 4. Review summaries, where real review text exists.
    const hotels = (await summariseReviews(priced)).map(publicHotel);

    res.json({ hotels, meta: { ...meta(quiz, found, cached, hotels.length), livePrices: hotels.filter(h => h.priceType === 'live').length } });
  } catch (err) {
    next(err);
  }
});

function meta(quiz, found, cached, count) {
  return {
    count,
    destination: quiz.destination,
    checkIn:     quiz.checkIn,
    checkOut:    quiz.checkOut,
    nights:      quiz.nights || null,
    // hotelbeds | booking | expedia | ai_knowledge | mock | none
    source:      found.source,
    candidates:  found.hotels.length,
    matching:    hasClaude() ? 'ai' : 'rules',
    cached,
    ts:          new Date().toISOString(),
  };
}

// Drop internal fields the page does not need.
function publicHotel(h) {
  const { rawReviews, facilities, ...rest } = h;
  return { ...rest, facilities: (facilities || []).slice(0, 40) };
}

// GET /api/search/test — quick sanity check
router.get('/search/test', (_req, res) => {
  res.json({ ok: true, message: 'Search route is alive' });
});

export default router;
