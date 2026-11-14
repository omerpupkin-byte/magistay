// ─── routes/search.js ─────────────────────────────────────────
// POST /api/search
// quiz → candidate hotels → AI matching → response
//
// The supplier search (slow, quota-limited) is cached by trip.
// The matching is NOT cached: two travellers going to the same place on
// the same dates want different hotels.

import { Router }            from 'express';
import { searchHotels }      from '../services/hotelSearch.js';
import { matchHotelsWithAI, lastAIFailure, lastAIDurationMs } from '../services/aiMatcher.js';
import { claudeModel } from '../services/claude.js';
import { summariseReviews }  from '../services/reviewSummariser.js';
import { validateQuiz }      from '../utils/validateQuiz.js';
import { hasClaude }         from '../services/claude.js';
import { pickBookable, livePricesEnabled } from '../services/livePrices.js';
import { trackHotelLinks, destinationOf, newSearchId } from '../services/clickLinks.js';

const router = Router();

// ── Candidate cache ───────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 200;

const SHOW    = 5;   // hotels on the results page
const RESERVE = 10;  // extra ranked hotels, used when one cannot be booked

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

// ── The search itself ─────────────────────────────────────────
// Returns { status, body }. `report`, when given, collects the live-price
// findings for every hotel that was checked.
async function runSearch(input, report = null, ctx = {}) {
  const { valid, error, quiz } = validateQuiz(input);
  if (!valid) return { status: 400, body: { error: `Invalid request: ${error}` } };
  if (!quiz.destination) return { status: 400, body: { error: 'Invalid request: destination is required' } };

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
    return { status: 200, body: { hotels: [], meta: meta(quiz, found, cached, 0) } };
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
  const priced = live ? await pickBookable(matched, quiz, { show: SHOW, report }) : matched.slice(0, SHOW);

  // 4. Review summaries, where real review text exists.
  // 5. Booking buttons go through /go, so every click is recorded and
  //    stamped with a click id the affiliate networks report back.
  const searchId = newSearchId();
  const hotels = (await summariseReviews(priced))
    .map(h => trackHotelLinks(h, { baseUrl: ctx.baseUrl, searchId, channel: ctx.channel || 'web' }))
    .map(publicHotel);

  const m = meta(quiz, found, cached, hotels.length);
  m.searchId = searchId;
  // What actually ranked these hotels, not what is configured.
  if (!found.preMatched) m.matching = hotels.some(h => h.matchedBy === 'ai') ? 'ai' : 'rules';
  m.livePrices = hotels.filter(h => h.priceType === 'live').length;
  return { status: 200, body: { hotels, meta: m } };
}

// ── POST /api/search ──────────────────────────────────────────
router.post('/search', async (req, res, next) => {
  try {
    const { status, body } = await runSearch(req.body, null, context(req, req.body?.channel));
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/search/check ─────────────────────────────────────
// The same search, opened as a plain address, with a compact answer:
// what is shown, at what price per platform, where each button leads,
// and what the live-price lookup found for every hotel it checked.
// For checking the live site without clicking through the quiz.
//   /api/search/check?destination=Madrid&checkIn=2026-11-24&checkOut=2026-11-27&adults=2
// Add any extra path segment (/api/search/check/2?...) to force a fresh run
// when something between you and the server keeps an old answer.
router.get(['/search/check', '/search/check/:run'], async (req, res, next) => {
  try {
    const startedAt = Date.now();
    const q = req.query;
    const list = v => (typeof v === 'string' && v ? v.split(',').map(x => x.trim()).filter(Boolean) : []);
    const report = [];
    const { status, body } = await runSearch({
      destination: q.destination, checkIn: q.checkIn, checkOut: q.checkOut,
      adults: Number(q.adults) || 2, children: Number(q.children) || 0, infants: Number(q.infants) || 0,
      rooms: Number(q.rooms) || 1, childAges: list(q.childAges).map(Number),
      stars: Number(q.stars) || 0, budget: q.budget, radiusKm: Number(q.radiusKm) || undefined,
      priorities: list(q.priorities), purpose: list(q.purpose), vibes: list(q.vibes),
      freeText: typeof q.freeText === 'string' ? q.freeText : '',
    }, report, context(req, 'check'));
    if (status !== 200) return res.status(status).json(body);

    res.json({
      meta: body.meta,
      shown: body.hotels.map((h, i) => ({
        rank: i + 1, name: h.name, matchScore: h.matchScore, matchedBy: h.matchedBy,
        matchReason: h.matchReason, priceType: h.priceType, currency: h.currency,
        stars: h.stars, rating: h.riScore, reviews: h.totalReviews, distanceKm: h.distanceKm,
        needs: h.needsCheck, highlights: h.highlights,
        bestPrice: h.bestPrice, listPrice: h.platforms?.google?.price ?? h.platforms?.hotelbeds?.price ?? null,
        platforms: Object.fromEntries(['bookingCom', 'agoda', 'expedia', 'hotelsCom'].map(k => [k, h.platforms?.[k]
          ? { perNight: h.platforms[k].price, total: h.platforms[k].total, directLink: !!h.platforms[k].direct }
          : null])),
        // Where each button finally leads (the page itself gets these wrapped in /go).
        links: Object.fromEntries(['bookingCom', 'agoda', 'expedia', 'hotelsCom'].map(k => [k, h.affiliateLinks?.[k] ? destinationOf(h.affiliateLinks[k]) : null])),
        tracked: ['bookingCom', 'agoda', 'expedia', 'hotelsCom'].filter(k => /\/go\?/.test(h.affiliateLinks?.[k] || '')),
      })),
      aiMatcher: body.meta.matching === 'ai'
        ? { ok: true, model: claudeModel(), answeredInMs: lastAIDurationMs() }
        : { fellBackToRules: true, model: claudeModel(), lastFailure: lastAIFailure() },
      tookMs: Date.now() - startedAt,
      livePriceLookups: report,
    });
  } catch (err) {
    next(err);
  }
});

// Where this API is reached from the outside (for /go links) and which
// channel the search came from (web, wa, check).
function context(req, channel) {
  const host  = req.get('host') || '';
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const baseUrl = process.env.PUBLIC_API_URL || (host ? `${local ? 'http' : 'https'}://${host}` : '');
  const ch = String(channel || 'web').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'web';
  return { baseUrl, channel: ch };
}

function meta(quiz, found, cached, count) {
  return {
    count,
    destination: quiz.destination,
    checkIn:     quiz.checkIn,
    checkOut:    quiz.checkOut,
    nights:      quiz.nights || null,
    // google_hotels | hotelbeds | booking | expedia | ai_knowledge | mock | none
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
