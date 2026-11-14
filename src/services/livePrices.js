// ─── services/livePrices.js ────────────────────────────────────
// Live price per booking platform for the hotels we are about to show.
//
// Source: Google Hotels, read through SerpApi (SERPAPI_KEY). Google lists
// what each booking site charges for one hotel on the traveller's dates,
// so one lookup answers "how much on Booking.com, Agoda, Expedia,
// Hotels.com" and, by absence, "no room there on these dates".
//
// Rules this file keeps:
//   - A price is attached only when we are confident Google's hotel is
//     the same hotel (name + position). No match → no price. A wrong
//     hotel's price is worse than none.
//   - Any failure (no key, timeout, quota, odd response) leaves the hotel
//     exactly as it was. Live prices never break a search.
//   - Outbound links stay OUR affiliate links. From Google's link we take
//     only which page is the hotel's, to open that page directly.
//
// Cost: 1 SerpApi search per hotel shown, 2 when the name is ambiguous.
// Results are cached for 20 minutes per hotel + trip.

import { buildDirectLink, buildAllAffiliateLinks, describeSellerLink } from './affiliateLinks.js';

const ENDPOINT   = 'https://serpapi.com/search.json';
const TIMEOUT_MS = 12_000;
const CACHE_TTL  = 20 * 60 * 1000;
const CACHE_MAX  = 500;

// Google's seller name → our platform key (same keys as affiliateLinks.js).
const PLATFORM_PATTERNS = [
  ['bookingCom', /^booking\.com$/i],
  ['agoda',      /^agoda/i],
  ['expedia',    /^expedia/i],
  ['hotelsCom',  /^hotels\.com$/i],
];

const cache = new Map();

export function livePricesEnabled() {
  return !!process.env.SERPAPI_KEY && process.env.LIVE_PRICES !== 'off';
}

// ── Public: add live prices to the final hotels ────────────────
// `fetchJson` is injectable so tests run without the network.
// `report`, when given, collects what was found for every hotel checked
// (used by the check endpoint to see why a hotel was priced or dropped).
export async function addLivePrices(hotels, quiz, { fetchJson = serpApiFetch, report = null } = {}) {
  if (!livePricesEnabled() || !hotels?.length) return hotels;
  if (!isDate(quiz.checkIn) || !isDate(quiz.checkOut)) return hotels;

  const results = await Promise.all(hotels.map(async (hotel) => {
    try {
      const live = await lookup(hotel, quiz, fetchJson);
      report?.push({
        hotel: hotel.name,
        result: !live?.matched ? 'not found on Google Hotels' : live.offers.some(o => o.platform) ? 'priced' : 'no price on our platforms',
        googleName: live?.googleName || null,
        sellers: (live?.offers || []).map(o => ({ seller: o.seller, perNight: o.price, total: o.total, ours: !!o.platform,
          ...(o.platform ? { leadsTo: o.link ? describeSellerLink(o.link) : 'no link' } : {}) })),
      });
      return live ? applyLivePrices(hotel, live, quiz) : hotel;
    } catch (e) {
      console.error(`[LIVE PRICES] ${hotel.name}: ${String(e.message).slice(0, 200)}`);
      report?.push({ hotel: hotel.name, result: 'lookup failed', error: String(e.message).slice(0, 120) });
      return hotel;
    }
  }));

  const priced = results.filter(h => h.priceType === 'live').length;
  const direct = results.reduce((n, h) => n + Object.values(h.platforms || {}).filter(p => p.direct).length, 0);
  console.log(`[LIVE PRICES] ${priced}/${hotels.length} hotels priced from Google Hotels, ${direct} direct hotel-page links`);

  return results;
}

// ── Public: the hotels to show, all of them bookable ──────────
// `ranked` is the matcher's list, best first, usually a few longer than
// `show`. A hotel Google knows but none of our platforms sells on these
// dates cannot be booked through us, so the next best match takes its
// place. Hotels we could not check at all stay: unknown is not "sold out".
export async function pickBookable(ranked, quiz, { show = 5, maxLookups = 15, fetchJson = serpApiFetch, report = null } = {}) {
  if (!livePricesEnabled()) return ranked.slice(0, show);

  const unbookable = h => !!h.livePrices && h.livePrices.found === 0;
  const first = await addLivePrices(ranked.slice(0, show), quiz, { fetchJson, report });
  let keep = first.filter(h => !unbookable(h));

  // Work down the reserve, a few at a time, until the page is full.
  let next = show, dropped = show - keep.length;
  while (keep.length < show && next < ranked.length && next < maxLookups) {
    const size  = Math.min(show - keep.length + 1, maxLookups - next);
    const batch = await addLivePrices(ranked.slice(next, next + size), quiz, { fetchJson, report });
    next += size;
    for (const h of batch) {
      if (unbookable(h)) dropped++;
      else if (keep.length < show) keep.push(h);
    }
  }
  if (dropped > 0) console.log(`[LIVE PRICES] ${dropped} hotel(s) not bookable on our platforms; showing ${keep.length} after checking ${Math.min(next, ranked.length)}`);

  // Nothing bookable anywhere: better the best matches, labelled, than an empty page.
  return keep.length > 0 ? keep : first;
}

// ── One hotel ─────────────────────────────────────────────────
async function lookup(hotel, quiz, fetchJson) {
  const currency = hotel.currency || 'EUR';
  const key = [hotel.id, quiz.checkIn, quiz.checkOut, quiz.adults, quiz.children, quiz.infants,
               (quiz.childAges || []).join('.'), currency].join('|');

  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  const data = await fetchFromGoogle(hotel, quiz, currency, fetchJson);
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return data;
}

async function fetchFromGoogle(hotel, quiz, currency, fetchJson) {
  const base = tripQuery(quiz, currency);

  // 1. Search by "Hotel name, City". For an exact name Google answers with
  //    the property itself; otherwise with a list to choose from.
  let res = await fetchJson({ ...base, q: searchText(hotel) });

  if (!isProperty(res)) {
    const best = pickProperty(hotel, res?.properties || []);
    if (!best?.property_token) return { matched: false };
    res = await fetchJson({ ...base, property_token: best.property_token });
  }

  if (!isProperty(res) || !sameHotel(hotel, res)) return { matched: false };

  return {
    matched:   true,
    checkedAt: new Date().toISOString(),
    googleName: res.name,
    currency,
    offers:    parseOffers(res.prices || []),
  };
}

function tripQuery(quiz, currency) {
  const children = Math.max(0, Number(quiz.children) || 0);
  const infants  = Math.max(0, Number(quiz.infants)  || 0);
  const given    = Array.isArray(quiz.childAges) ? quiz.childAges : [];
  const ages     = [];
  for (let i = 0; i < children; i++) ages.push(given[i] ?? 8);
  for (let i = 0; i < infants;  i++) ages.push(1);

  const q = {
    engine:         'google_hotels',
    check_in_date:  quiz.checkIn,
    check_out_date: quiz.checkOut,
    adults:         String(Math.max(1, Number(quiz.adults) || 2)),
    currency,
    gl: 'us',
    hl: 'en',
  };
  if (ages.length) { q.children = String(ages.length); q.children_ages = ages.join(','); }
  return q;
}

function searchText(hotel) {
  const name = (hotel.name || '').trim();
  const city = (hotel.city || '').trim();
  if (!city || name.toLowerCase().includes(city.toLowerCase())) return name;
  return `${name}, ${city}`;
}

// A property-details response has the hotel's own fields at the top level.
function isProperty(res) {
  return !!res && typeof res.name === 'string' && (Array.isArray(res.prices) || !!res.gps_coordinates) && !Array.isArray(res.properties);
}

// ── Is it the same hotel? ─────────────────────────────────────
// Suppliers and Google spell names differently ("Hotel Arts Barcelona" /
// "Hotel Arts Barcelona, a Ritz-Carlton Hotel"), so position carries most
// of the weight and the name confirms it.
export function sameHotel(hotel, candidate) {
  // The city is in half the hotel names in town ("W Barcelona", "Hotel Arts
  // Barcelona"), so it says nothing about which hotel this is.
  const skip = nameTokens(hotel.city);
  const { loose, strict } = nameOverlap(hotel.name, candidate.name, skip);
  const dist = distanceKm(hotel.coords, candidate.gps_coordinates);
  if (dist == null) return strict >= 0.75;      // no position on one side: names must be near-identical
  if (dist <= 0.25) return loose >= 0.5;
  if (dist <= 1)    return loose >= 0.99 && strict >= 0.5;
  return false;
}

function pickProperty(hotel, properties) {
  let best = null, bestScore = 0;
  for (const p of properties.slice(0, 10)) {
    if (!sameHotel(hotel, p)) continue;
    const score = nameOverlap(hotel.name, p.name, nameTokens(hotel.city)).strict;
    if (!best || score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

const GENERIC = new Set(['hotel', 'hotels', 'the', 'and', 'by', 'a', 'an', 'of', 'at', 'resort', 'spa', 'suites', 'boutique', 'apartments', 'hostel']);

function nameTokens(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(t => t && !GENERIC.has(t));
}

// How much two names share, ignoring generic words and `skip` words.
//   loose  - share of the SHORTER name's words found in the other
//   strict - share of the LONGER name's words found in the other
export function nameOverlap(a, b, skip = []) {
  const drop = new Set(skip);
  const clean = (name) => {
    const all = nameTokens(name);
    const kept = all.filter(t => !drop.has(t));
    return new Set(kept.length ? kept : all);   // a name that is only the city keeps it
  };
  const ta = clean(a), tb = clean(b);
  if (ta.size === 0 || tb.size === 0) return { loose: 0, strict: 0 };
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return { loose: shared / small.size, strict: shared / large.size };
}

export function nameSimilarity(a, b) { return nameOverlap(a, b).loose; }

function distanceKm(a, b) {
  const lat1 = Number(a?.lat), lng1 = Number(a?.lng);
  const lat2 = Number(b?.latitude), lng2 = Number(b?.longitude);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  if (lat1 === 0 && lng1 === 0) return null;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// ── Google's price list → our offers ──────────────────────────
// Per night, taxes and fees included when Google states that figure.
export function parseOffers(prices) {
  const offers = [];
  for (const p of prices) {
    const night = p?.rate_per_night || {};
    const total = p?.total_rate || {};
    const price = num(night.extracted_after_taxes_fees) ?? num(night.extracted_lowest) ?? num(night.extracted_display_price);
    if (price == null || !p.source) continue;
    offers.push({
      platform:  platformKey(p.source),          // null for sellers we have no link for
      seller:    String(p.source).slice(0, 60),
      link:      typeof p.link === 'string' ? p.link : null,   // server-side only, never sent to the page
      price,
      total:     num(total.extracted_after_taxes_fees) ?? num(total.extracted_lowest) ?? null,
      taxesIncluded:    num(night.extracted_after_taxes_fees) != null,
      freeCancellation: p.free_cancellation === true,
      cancelUntil:      p.free_cancellation === true && p.free_cancellation_until_date ? String(p.free_cancellation_until_date) : null,
      official:         p.official === true,
    });
  }
  return offers.sort((a, b) => a.price - b.price);
}

function platformKey(source) {
  for (const [key, re] of PLATFORM_PATTERNS) if (re.test(String(source).trim())) return key;
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// ── Put the live prices on the hotel ──────────────────────────
export function applyLivePrices(hotel, live, quiz = {}) {
  if (!live.matched) return hotel;

  const platforms = { ...(hotel.platforms || {}) };
  // Search links use the name Google (and the booking sites) know the hotel
  // by: supplier names carry extras ("... anteriormente Icon Embassy") that
  // make a platform's search come back empty.
  const affiliateLinks = live.googleName && hotel.affiliateLinks
    ? buildAllAffiliateLinks({ ...hotel, name: live.googleName }, quiz)
    : { ...(hotel.affiliateLinks || {}) };
  const tracked = [];
  for (const offer of live.offers) {
    if (!offer.platform || platforms[offer.platform]?.live) continue;   // keep the cheapest per platform
    // Straight to the hotel's page on that platform, with our affiliate id.
    const direct = offer.link ? buildDirectLink(offer.platform, offer.link, quiz, live.currency) : null;
    if (direct) affiliateLinks[offer.platform] = direct;
    platforms[offer.platform] = {
      price: offer.price, total: offer.total, live: true, direct: !!direct,
      taxesIncluded: offer.taxesIncluded,
      freeCancellation: offer.freeCancellation, cancelUntil: offer.cancelUntil,
    };
    tracked.push(offer);
  }

  const livePrices = {
    source:    'google_hotels',
    checkedAt: live.checkedAt,
    currency:  live.currency,
    found:     tracked.length,
    // The cheapest price anywhere, when it is NOT one of our platforms -
    // shown so "lowest" on the page is never a half-truth.
    cheaperElsewhere: null,
  };

  if (tracked.length === 0) {
    // Google knows the hotel but none of our platforms has a price for
    // these dates. Keep the supplier's indicative price; say so on the page.
    return { ...hotel, livePrices };
  }

  const cheapest = tracked[0];
  const overall  = live.offers[0];
  if (overall && !overall.platform && overall.price < cheapest.price) {
    livePrices.cheaperElsewhere = { seller: overall.seller, price: overall.price, official: overall.official };
  }

  const flex = tracked.find(o => o.freeCancellation);
  return {
    ...hotel,
    platforms,
    affiliateLinks,
    livePrices,
    currency:  live.currency,
    priceType: 'live',
    bestPrice: { platform: cheapest.platform, price: cheapest.price, total: cheapest.total },
    bestFlex:  flex
      ? { platform: flex.platform, price: flex.price, terms: flex.cancelUntil ? `free cancellation until ${flex.cancelUntil}` : 'free cancellation' }
      : null,
    // The supplier's "with breakfast" figure is a different price basis;
    // don't show it next to live prices.
    breakfastPrice: null,
  };
}

// ── HTTP ──────────────────────────────────────────────────────
async function serpApiFetch(params) {
  const url = `${ENDPOINT}?${new URLSearchParams({ ...params, api_key: process.env.SERPAPI_KEY })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    throw new Error(`SerpApi ${res.status}: ${body?.error || 'request failed'}`);
  }
  return body;
}

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// For tests.
export function _clearLivePriceCache() { cache.clear(); }
