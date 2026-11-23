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
import { cacheGet, cacheSet } from '../services/store.js';
import { addReviewEvidence, reviewEvidenceEnabled } from '../services/reviewEvidence.js';
import { count, usageSnapshot, usageDelta } from '../services/usage.js';
import { ALL_PLATFORMS, platformStatus } from '../services/affiliateLinks.js';

const router = Router();

// ── Candidate cache ───────────────────────────────────────────
// The hotel list for a trip is the same for everyone and changes slowly;
// what moves is price and availability, and those are re-read per hotel
// (livePrices.js) before anything is shown. Kept in the shared store.
const LIST_TTL = (Number(process.env.LIST_CACHE_HOURS) || 6) * 60 * 60 * 1000;

const SHOW    = 5;   // hotels on the results page
const RESERVE = 10;  // extra ranked hotels, used when one cannot be booked

// Everything that changes which hotels (or which prices) come back.
function tripKey(quiz) {
  return [
    quiz.destination.toLowerCase(), quiz.checkIn, quiz.checkOut,
    quiz.adults, quiz.children, quiz.infants, quiz.rooms,
    quiz.childAges.join('.'), quiz.radiusKm, quiz.stars,
    quiz.budget || '', (quiz.landmark || '').toLowerCase(),      // both shape the list that is fetched
  ].join('|');
}

// ── The search itself ─────────────────────────────────────────
// Returns { status, body }. `report`, when given, collects the live-price
// findings for every hotel that was checked.
async function runSearch(input, report = null, ctx = {}) {
  const { valid, error, quiz } = validateQuiz(input);
  if (!valid) return { status: 400, body: { error: `Invalid request: ${error}` } };
  if (!quiz.destination) return { status: 400, body: { error: 'Invalid request: destination is required' } };
  // The language to write reasons and notes in (chat channels pass the traveller's).
  if (ctx.language && /^[a-z]{2}(-[a-z]{2})?$/i.test(ctx.language)) quiz.language = ctx.language.toLowerCase();

  console.log(`[SEARCH] "${quiz.destination}" · ${quiz.adults}A ${quiz.children}C ${quiz.infants}I · ${quiz.checkIn}→${quiz.checkOut}`);

  const t0 = Date.now(); const timings = {};
  // 1. Candidates. AI suggestions are tailored to the traveller, so
  //    only real supplier results are shared between travellers.
  const key = tripKey(quiz);
  count('searches');
  let found = await cacheGet('list|' + key);
  const cached = !!found;
  if (cached) count('listingCacheHits');
  if (!found) {
    found = await searchHotels(quiz);
    if (!found.preMatched && found.hotels.length > 0 && found.source !== 'mock') await cacheSet('list|' + key, found, LIST_TTL);
  }

  timings.candidatesMs = Date.now() - t0;

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

  timings.matchingMs = Date.now() - t0 - timings.candidatesMs;

  // 3. Live price per booking platform; keeps the best SHOW that can be
  //    booked. Demo data keeps its sample prices. Never throws.
  const show   = Math.max(1, Math.min(SHOW, Number(ctx.show) || SHOW));     // a chat shows fewer than the site
  const priced0 = live ? await pickBookable(matched, quiz, { show, report }) : matched.slice(0, show);
  // A pick the AI did not make (the reserve, ranked by rules) must show something
  // real: a confirmed need, or a rated hotel of at least three stars.
  const real = (h) => h.matchedBy !== 'rules' || h.stars >= 3 || (h.needsCheck || []).some(n => n.status === 'yes');
  const priced = priced0.filter(real).length ? priced0.filter(real) : priced0;

  // 4. Review summaries, where real review text exists.
  timings.pricesMs = Date.now() - t0 - timings.candidatesMs - timings.matchingMs;

  // 4. What guests say about the points the data left open (a quiet room,
  //    blackout curtains...). Only when there is something open to check.
  const judged = found.source !== 'mock' && reviewEvidenceEnabled() ? await addReviewEvidence(priced, quiz) : priced;
  timings.reviewsMs = Date.now() - t0 - timings.candidatesMs - timings.matchingMs - timings.pricesMs;

  // 5. Booking buttons go through /go, so every click is recorded and
  //    stamped with a click id the affiliate networks report back.
  const searchId = newSearchId();
  const hotels = (await summariseReviews(judged))
    .map(h => trackHotelLinks(h, { baseUrl: ctx.baseUrl, searchId, channel: ctx.channel || 'web' }))
    .map(publicHotel);

  const m = meta(quiz, found, cached, hotels.length);
  m.searchId = searchId;
  timings.totalMs = Date.now() - t0;
  m.timings = timings;
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
//   /api/search/check/1?destination=Madrid&checkIn=2026-11-24&checkOut=2026-11-27&adults=2
//
// A search can take longer than a simple page fetch is willing to wait,
// so the check runs as a job: the address answers within a few seconds,
// either with the report or with "running" and the address to read the
// report from. Change the number after /check/ for a fresh run.
const jobs = new Map();                 // id -> { startedAt, done, report, error }
const JOB_TTL = 15 * 60 * 1000, WAIT_MS = 8000;

function startJob(id, query, ctx) {
  for (const [k, j] of jobs) if (Date.now() - j.startedAt > JOB_TTL) jobs.delete(k);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  const job = { startedAt: Date.now(), done: false, report: null, error: null };
  jobs.set(id, job);
  job.promise = buildCheckReport(query, ctx)
    .then(r => { job.report = r; })
    .catch(e => { job.error = String(e?.message || e).slice(0, 300); })
    .finally(() => { job.done = true; job.tookMs = Date.now() - job.startedAt; });
  return job;
}

async function answerJob(res, id, job, baseUrl, step) {
  await Promise.race([job.promise, new Promise(r => setTimeout(r, WAIT_MS))]);
  if (!job.done) {
    return res.json({ status: 'running', elapsedMs: Date.now() - job.startedAt,
      readTheReportHere: `${baseUrl}/api/search/result/${id}/${step + 1}` });
  }
  if (job.error) return res.status(500).json({ status: 'failed', error: job.error, tookMs: job.tookMs });
  res.status(job.report.status).json({ status: 'done', tookMs: job.tookMs, ...job.report.body });
}

router.get(['/search/check', '/search/check/:run'], async (req, res, next) => {
  try {
    const ctx = context(req, 'check');
    const id  = `${String(req.params.run || '0').replace(/[^\w-]/g, '').slice(0, 20)}-${newSearchId()}`;
    await answerJob(res, id, startJob(id, req.query, ctx), ctx.baseUrl, 0);
  } catch (err) { next(err); }
});

router.get('/search/result/:id/:step?', async (req, res, next) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ status: 'unknown', error: 'No such check, or it is older than 15 minutes. Start a new one.' });
    await answerJob(res, req.params.id, job, context(req).baseUrl, Number(req.params.step) || 1);
  } catch (err) { next(err); }
});

async function buildCheckReport(q, ctx) {
  const list = v => (typeof v === 'string' && v ? v.split(',').map(x => x.trim()).filter(Boolean) : []);
  const report = [];
  const usageBefore = usageSnapshot();
  const { status, body } = await runSearch({
    destination: q.destination, checkIn: q.checkIn, checkOut: q.checkOut,
    adults: Number(q.adults) || 2, children: Number(q.children) || 0, infants: Number(q.infants) || 0,
    rooms: Number(q.rooms) || 1, childAges: list(q.childAges).map(Number),
    stars: Number(q.stars) || 0, budget: q.budget, radiusKm: Number(q.radiusKm) || undefined,
    priorities: list(q.priorities), purpose: list(q.purpose), vibes: list(q.vibes),
    freeText: typeof q.freeText === 'string' ? q.freeText : '',
  }, report, { ...ctx, language: typeof q.lang === 'string' ? q.lang : undefined });
  if (status !== 200) return { status, body };

  const PLATFORMS = ALL_PLATFORMS;
  return { status: 200, body: {
    meta: body.meta,
    // What this one search cost, and who each platform's clicks are credited to.
    cost: usageDelta(usageBefore, usageSnapshot()),
    affiliate: platformStatus(),
    aiMatcher: body.meta.matching === 'ai'
      ? { ok: true, model: claudeModel(), answeredInMs: lastAIDurationMs() }
      : { fellBackToRules: true, model: claudeModel(), lastFailure: lastAIFailure() },
    shown: body.hotels.map((h, i) => ({
      rank: i + 1, name: h.name, matchScore: h.matchScore, matchedBy: h.matchedBy,
      matchReason: h.matchReason, priceType: h.priceType, currency: h.currency,
      stars: h.stars, rating: h.riScore, reviews: h.totalReviews, distanceKm: h.distanceKm,
      needs: h.needsCheck, highlights: h.highlights, reviewEvidence: h.reviewEvidence || null,
      otherPrices: h.livePrices?.otherPrices || [], cheaperElsewhere: h.livePrices?.cheaperElsewhere || null,
      // Same price on every site we can sell through: plausible, but worth a look in the booking sites.
      samePriceOnOurSites: (() => { const v = Object.values(h.platforms || {}).filter(x => x?.live).map(x => x.price); return v.length >= 3 && v.every(p => p === v[0]); })(),
      bestPrice: h.bestPrice, listPrice: h.platforms?.google?.price ?? h.platforms?.hotelbeds?.price ?? null,
      platforms: Object.fromEntries(PLATFORMS.map(k => [k, h.platforms?.[k]
        ? { perNight: h.platforms[k].price, total: h.platforms[k].total, directLink: !!h.platforms[k].direct }
        : null])),
      // Where each button finally leads (the page itself gets these wrapped in /go).
      links: Object.fromEntries(PLATFORMS.map(k => [k, h.affiliateLinks?.[k] ? destinationOf(h.affiliateLinks[k]) : null])),
      tracked: PLATFORMS.filter(k => /\/go\?/.test(h.affiliateLinks?.[k] || '')),
    })),
    // Sellers that are not ours are summarised: how many, and the cheapest.
    livePriceLookups: report.map(l => {
      const others = (l.sellers || []).filter(x => !x.ours);
      return { hotel: l.hotel, result: l.result, googleName: l.googleName, error: l.error,
        ours: (l.sellers || []).filter(x => x.ours),
        otherSellers: others.length, cheapestOther: others[0] ? { seller: others[0].seller, perNight: others[0].perNight } : null };
    }),
  } };
}

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

export { runSearch, context };
export default router;
