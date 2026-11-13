// ─── services/hotelbedsAPI.js ──────────────────────────────────
// Hotelbeds (HBX Group) integration — two APIs:
//
//   Booking API  (/hotel-api)          live availability + rates
//   Content API  (/hotel-content-api)  photos, facilities, descriptions
//
// Docs: https://developer.hotelbeds.com/documentation/hotels/
//
// Environment:
//   HOTELBEDS_API_KEY / HOTELBEDS_API_SECRET   required
//   HOTELBEDS_ENV=production                   after certification (default: test)
//   HOTELBEDS_REVIEWS=off                      skip the TripAdvisor rating filter
//
// Notes on honesty of the data:
//   • Rates are Hotelbeds wholesale rates — a real, live price, but not
//     the price the traveller will see on Booking.com/Agoda. They are
//     passed on as `priceType: 'indicative'`.
//   • The evaluation (test) key allows a small number of requests per day.
//     Results are cached by the route to stretch it.

import crypto from 'crypto';
import { distanceKm } from './geocoding.js';

const HOST = () => process.env.HOTELBEDS_BASE_URL            // for local testing against a stub
  || (process.env.HOTELBEDS_ENV === 'production'
    ? 'https://api.hotelbeds.com'
    : 'https://api.test.hotelbeds.com');

const PHOTO_HOST = () => process.env.HOTELBEDS_PHOTO_BASE_URL || PHOTO_BASE;

const PHOTO_BASE = 'https://photos.hotelbeds.com/giata/bigger/';   // 800px wide
const MAX_HOTELS = 30;
const MAX_RADIUS_KM = 100;

// ── Auth (signature must be rebuilt for every request) ─────────
function buildHeaders() {
  const apiKey = process.env.HOTELBEDS_API_KEY;
  const secret = process.env.HOTELBEDS_API_SECRET;
  const ts     = Math.floor(Date.now() / 1000).toString();
  return {
    'Api-key':     apiKey,
    'X-Signature': crypto.createHash('sha256').update(apiKey + secret + ts).digest('hex'),
    'Accept':      'application/json',
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/json',
  };
}

// ── Main search ───────────────────────────────────────────────
export async function searchHotelbeds(quiz) {
  if (!process.env.HOTELBEDS_API_KEY) throw new Error('HOTELBEDS_API_KEY not set');

  const coords = quiz.coords;
  if (coords?.lat == null) throw new Error('No coordinates for destination');

  const radius      = searchRadiusKm(quiz, coords);
  const wantReviews = process.env.HOTELBEDS_REVIEWS !== 'off';
  console.log(`[HOTELBEDS] Searching "${quiz.destination}" (${coords.lat}, ${coords.lng}) radius ${radius} km`);

  // First attempt: full request. If Hotelbeds rejects it or finds nothing,
  // retry once with the simplest possible request before giving up.
  let raw = [];
  try {
    raw = await availability(buildSearchBody(quiz, coords, { radius, reviews: wantReviews }));
  } catch (e) {
    if (!/ 400:/.test(e.message)) throw e;
    console.warn('[HOTELBEDS] Request rejected, retrying simplified:', e.message.slice(0, 200));
  }
  if (raw.length === 0 && (wantReviews || radius > 20)) {
    raw = await availability(buildSearchBody(quiz, coords, { radius: Math.min(radius, 20), reviews: false, simple: true }));
  }
  console.log(`[HOTELBEDS] Found ${raw.length} hotels`);

  let hotels = raw.map(h => normaliseHotel(h, quiz, coords));

  // Photos, facilities and descriptions come from the Content API.
  // Enrichment is best-effort: a failure here must never lose the results.
  try {
    hotels = await enrichWithContent(hotels);
  } catch (e) {
    console.warn('[HOTELBEDS] Content enrichment failed:', e.message.slice(0, 200));
  }
  return hotels;
}

async function availability(body) {
  const res = await fetch(`${HOST()}/hotel-api/1.0/hotels`, {
    method: 'POST', headers: buildHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hotelbeds API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  return data.hotels?.hotels || [];
}

// ── Radius: the traveller's choice, widened for regions/islands ─
// "Crete" geocodes to the middle of a 260 km island; a 5 km circle around
// that point contains mountains, not hotels.
export function searchRadiusKm(quiz, coords) {
  const chosen = Number(quiz.radiusKm) || 10;
  const span   = Number(coords?.spanKm) || 0;
  const isArea = span > 40;
  const radius = isArea ? Math.max(chosen, span / 2) : chosen;
  return Math.max(1, Math.min(MAX_RADIUS_KM, Math.round(radius)));
}

// ── Request body ──────────────────────────────────────────────
export function buildSearchBody(quiz, coords, opts = {}) {
  const body = {
    stay: {
      checkIn:  quiz.checkIn  || defaultDate(30),
      checkOut: quiz.checkOut || defaultDate(35),
    },
    occupancies: buildOccupancies(quiz),
    geolocation: {
      latitude:  coords.lat,
      longitude: coords.lng,
      radius:    opts.radius ?? searchRadiusKm(quiz, coords),
      unit:      'km',
    },
    filter: { maxHotels: MAX_HOTELS },
  };

  if (!opts.simple) {
    // A few rates per hotel so we can tell "cheapest" from "free cancellation"
    // and "breakfast included".
    body.filter.maxRooms = 3;
    body.filter.maxRatesPerRoom = 3;
    if (quiz.stars > 0) body.filter.minCategory = quiz.stars;
  }
  // Real guest ratings (TripAdvisor), returned per hotel.
  if (opts.reviews) {
    body.reviews = [{ type: 'TRIPADVISOR', minRate: 1, maxRate: 5, minReviewCount: 1 }];
  }
  return body;
}

// Spread travellers across rooms. Hotelbeds wants one entry per distinct
// room make-up, with an age for every child.
export function buildOccupancies(quiz) {
  const rooms    = Math.max(1, Number(quiz.rooms) || 1);
  const adults   = Math.max(rooms, Number(quiz.adults) || 2);   // at least one adult per room
  const children = Math.max(0, Number(quiz.children) || 0);
  const infants  = Math.max(0, Number(quiz.infants) || 0);
  const given    = Array.isArray(quiz.childAges) ? quiz.childAges : [];

  const ages = [];
  for (let i = 0; i < children; i++) ages.push(Number(given[i]) >= 0 ? Number(given[i]) : 8);
  for (let i = 0; i < infants;  i++) ages.push(1);

  const perRoom = Array.from({ length: rooms }, () => ({ adults: 0, ages: [] }));
  for (let i = 0; i < adults; i++) perRoom[i % rooms].adults++;
  ages.forEach((age, i) => perRoom[i % rooms].ages.push(age));

  const grouped = new Map();
  for (const r of perRoom) {
    const key = `${r.adults}|${r.ages.join(',')}`;
    if (!grouped.has(key)) grouped.set(key, { ...r, rooms: 0 });
    grouped.get(key).rooms++;
  }

  return [...grouped.values()].map(r => ({
    rooms:    r.rooms,
    adults:   r.adults,
    children: r.ages.length,
    paxes: [
      ...Array.from({ length: r.adults }, () => ({ type: 'AD' })),
      ...r.ages.map(age => ({ type: 'CH', age })),
    ],
  }));
}

// ── Normalise an availability result to our schema ────────────
export function normaliseHotel(h, quiz, coords) {
  const nights = nightsOf(quiz);
  const rates  = analyseRates(h, nights);
  const review = pickReview(h.reviews);
  const lat = num(h.latitude), lng = num(h.longitude);
  // "km from the centre" means nothing for an island or a region, so
  // distance is only reported for a city or a named landmark.
  const isArea = Number(coords?.spanKm) > 40;
  const dist = isArea ? null : distanceKm(coords?.lat, coords?.lng, lat, lng);
  const currency = h.currency || 'EUR';

  const hotelbeds = {
    score:     review.score10,
    reviews:   review.count,
    price:     rates.cheapest,
    flexible:  rates.flexible,
    flexTerms: rates.flexTerms,
  };

  return {
    id:            `hotelbeds-${h.code}`,
    hotelbedsCode: h.code,
    source:        'hotelbeds',
    name:          h.name,
    location:      h.zoneName || '',
    city:          h.destinationName || coords?.city || quiz.destination,
    country:       coords?.country || '',
    stars:         parseStars(h.categoryCode, h.categoryName),
    coords:        { lat, lng },
    distanceKm:    dist == null ? null : Math.round(dist * 10) / 10,
    distanceFrom:  dist == null ? null : (coords?.label || 'the centre'),

    amenities:     [],          // filled from the Content API
    facilities:    [],
    description:   '',
    photos:        placeholderPhotos(),
    gallery:       [],

    // Guest rating — only when Hotelbeds returned a real one.
    riScore:       review.score10,
    riConfidence:  review.count > 500 ? 'high' : review.count > 100 ? 'moderate' : 'low',
    totalReviews:  review.count,
    ratingSource:  review.score10 ? 'TripAdvisor' : null,

    // Live availability on the traveller's dates, at Hotelbeds' rate.
    available:     rates.cheapest != null,
    currency,
    priceType:     'indicative',
    platforms:     { hotelbeds },
    bestPrice:     rates.cheapest != null ? { platform: 'hotelbeds', price: rates.cheapest } : null,
    bestFlex:      rates.flexible != null ? { platform: 'hotelbeds', price: rates.flexible, terms: rates.flexTerms } : null,
    breakfastPrice: rates.breakfast,
    boards:        rates.boards,

    rawReviews:  [],
    matchScore:  null,
    matchReason: null,
    reviews:     null,
  };
}

// Cheapest rate, cheapest refundable rate, cheapest rate with breakfast.
// Hotelbeds quotes the whole stay; we show a nightly figure.
export function analyseRates(h, nights) {
  const all = (h.rooms || []).flatMap(r => r.rates || []);
  const perNight = total => Math.round(total / nights);
  const now = Date.now();
  let cheapest = null, flexible = null, flexUntil = null, breakfast = null;
  const boards = new Set();

  for (const r of all) {
    const total = num(r.net) ?? num(r.sellingRate);
    if (total == null) continue;
    if (r.boardName) boards.add(titleCase(r.boardName));
    if (cheapest == null || total < cheapest) cheapest = total;

    const deadline = r.cancellationPolicies?.[0]?.from ? Date.parse(r.cancellationPolicies[0].from) : null;
    const refundable = r.rateClass !== 'NRF' && deadline && deadline - now > 24 * 3_600_000;
    if (refundable && (flexible == null || total < flexible)) { flexible = total; flexUntil = deadline; }

    const hasBreakfast = /^(BB|HB|FB|AI|TI|AS|CB|AB|DB|GB|IB|LB|SB|B1|B2|QB|HV|FV)$/.test(r.boardCode || '')
      || /breakfast|half board|full board|all inclusive/i.test(r.boardName || '');
    if (hasBreakfast && (breakfast == null || total < breakfast)) breakfast = total;
  }

  // Fall back to the hotel-level minimum when no room rates came back.
  if (cheapest == null && num(h.minRate) != null) cheapest = num(h.minRate);

  return {
    cheapest:  cheapest  == null ? null : perNight(cheapest),
    flexible:  flexible  == null ? null : perNight(flexible),
    breakfast: breakfast == null ? null : perNight(breakfast),
    flexTerms: flexUntil ? `Free cancellation until ${new Date(flexUntil).toISOString().slice(0, 10)}` : null,
    boards:    [...boards],
  };
}

// Hotelbeds returns reviews as [{ rate, reviewCount, type }] on a 1–5 scale.
function pickReview(reviews) {
  const list = Array.isArray(reviews) ? reviews : reviews ? [reviews] : [];
  const r = list.find(x => /TRIPADVISOR/i.test(x.type || '')) || list[0];
  const rate  = num(r?.rate ?? r?.rating);
  const count = Number(r?.reviewCount) || 0;
  if (rate == null || rate <= 0) return { score10: null, count: 0 };
  return { score10: Math.round(rate * 2 * 10) / 10, count };
}

function parseStars(categoryCode, categoryName) {
  const fromCode = parseInt(String(categoryCode || '').replace(/\D/g, ''), 10);
  if (fromCode >= 1 && fromCode <= 5) return fromCode;
  const fromName = parseInt(String(categoryName || '').replace(/\D/g, ''), 10);
  return fromName >= 1 && fromName <= 5 ? fromName : 0;   // 0 = unrated
}

// ── Content API: photos, facilities, description ──────────────
const contentCache = new Map();          // hotel code → content (static data)
const CONTENT_TTL = 24 * 3_600_000;

async function enrichWithContent(hotels) {
  if (hotels.length === 0) return hotels;
  const now = Date.now();
  const missing = hotels.map(h => h.hotelbedsCode)
    .filter(code => !(contentCache.has(code) && now - contentCache.get(code).ts < CONTENT_TTL));

  if (missing.length > 0) {
    const url = `${HOST()}/hotel-content-api/1.0/hotels/${missing.join(',')}/details?language=ENG&useSecondaryLanguage=false`;
    const res = await fetch(url, { headers: buildHeaders() });
    if (!res.ok) throw new Error(`Hotelbeds content error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const list = data.hotels || (data.hotel ? [data.hotel] : []);
    for (const c of list) contentCache.set(c.code, { ts: now, content: parseContent(c) });
    console.log(`[HOTELBEDS] Content loaded for ${list.length}/${missing.length} hotels`);
  }

  return hotels.map(h => {
    const c = contentCache.get(h.hotelbedsCode)?.content;
    return c ? applyContent(h, c) : h;
  });
}

export function parseContent(c) {
  const text = x => (typeof x === 'string' ? x : x?.content) || '';

  const facilities = (c.facilities || [])
    .filter(f => f.indYesOrNo !== false && f.indLogic !== false)
    .map(f => {
      const name = text(f.description).trim();
      if (!name) return null;
      // Some facilities carry a value (e.g. "Year of construction 1998").
      return f.number != null && !/^(yes|no)$/i.test(String(f.number)) && /year|number of|distance/i.test(name)
        ? `${name}: ${f.number}` : name;
    })
    .filter(Boolean);

  const images = (c.images || [])
    .filter(i => i.path)
    .sort((a, b) => (a.visualOrder ?? a.order ?? 99) - (b.visualOrder ?? b.order ?? 99))
    .map(i => ({ url: PHOTO_HOST() + i.path, label: text(i.type?.description) || 'Hotel', type: i.imageTypeCode || i.type?.code || '' }));

  return {
    facilities:  [...new Set(facilities)],
    images,
    description: text(c.description).replace(/\s+/g, ' ').trim(),
    address:     text(c.address),
    city:        text(c.city),
    country:     c.countryCode || '',
  };
}

function applyContent(h, c) {
  const out = { ...h };
  out.facilities  = c.facilities.slice(0, 80);
  out.amenities   = amenitiesFromFacilities(c.facilities);
  out.description = c.description.slice(0, 900);
  if (c.address) out.address = titleCase(c.address);
  if (c.country && !out.country) out.country = c.country;

  if (c.images.length > 0) {
    // Lead with a general/exterior shot, then a room, then anything else.
    const general = c.images.find(i => /GEN|COM|PIS|PLA/i.test(i.type)) || c.images[0];
    const room    = c.images.find(i => /HAB/i.test(i.type) && i !== general);
    const ordered = [general, room, ...c.images.filter(i => i !== general && i !== room)].filter(Boolean);
    const tints = placeholderPhotos();
    const slot = (img, fallback) => img ? { ...fallback, url: img.url, label: img.label } : fallback;
    out.photos  = { main: slot(ordered[0], tints.main), thumb1: slot(ordered[1], tints.thumb1), thumb2: slot(ordered[2], tints.thumb2) };
    out.gallery = ordered.slice(0, 12).map(i => ({ url: i.url, label: i.label }));
  }
  return out;
}

// Map Hotelbeds' free-text facility names onto the amenity keys the
// matcher understands. Text matching, so it survives code changes.
const AMENITY_PATTERNS = [
  ['pool',                  /pool/i],
  ['kids_pool',             /children.?s (swimming )?pool|kids.? pool|paddling/i],
  ['spa',                   /\bspa\b|wellness|sauna|hammam|steam/i],
  ['gym',                   /gym|fitness/i],
  ['restaurant',            /restaurant/i],
  ['bar',                   /\bbar\b|pub/i],
  ['breakfast',             /breakfast/i],
  ['parking',               /car park|parking|garage/i],
  ['beach_access',          /beach/i],
  ['elevator',              /lift|elevator/i],
  ['wifi',                  /wi-?fi|wlan|internet/i],
  ['wheelchair_accessible', /wheelchair|disabled|reduced mobility|accessible/i],
  ['pet',                   /pets? (allowed|friendly)|small pets|large pets/i],
  ['crib',                  /\bcot\b|crib|baby bed/i],
  ['family_friendly',       /kids.? club|children.?s (club|play|area)|playground|babysit|child ?care/i],
  ['kids_club',             /kids.? club|children.?s club|mini.?club/i],
  ['babysitting',           /babysit|child ?care/i],
  ['highchair',             /high ?chair/i],
  ['concierge',             /concierge/i],
  ['rooftop',               /roof/i],
  ['late_checkout',         /late check.?out/i],
  ['early_checkin',         /early check.?in/i],
  ['room_service',          /room service/i],
  ['air_conditioning',      /air.?condition/i],
  ['ev_charging',           /electric (car|vehicle)|charging station/i],
  ['laundry',               /laundry/i],
  ['sea_view',              /sea view|ocean view/i],
  ['soundproof',            /soundproof|sound.?insulat/i],
  ['kosher',                /kosher/i],
  ['halal',                 /halal/i],
  ['vegetarian',            /vegetarian|vegan/i],
  ['terrace',               /terrace|garden/i],
];

export function amenitiesFromFacilities(facilities) {
  const found = new Set();
  for (const name of facilities || []) {
    for (const [key, re] of AMENITY_PATTERNS) if (re.test(name)) found.add(key);
  }
  return [...found];
}

// ── Helpers ───────────────────────────────────────────────────
function placeholderPhotos() {
  return {
    main:   { bg: '#C4D8B8', color: '#3a5a2a', label: 'Hotel' },
    thumb1: { bg: '#B4C8D8', color: '#1a3a5a', label: 'Room'  },
    thumb2: { bg: '#D8C8B4', color: '#5a3a1a', label: 'View'  },
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/(^|[\s\-/(])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());
}

function nightsOf(quiz) {
  if (quiz.checkIn && quiz.checkOut) {
    return Math.max(1, Math.round((new Date(quiz.checkOut) - new Date(quiz.checkIn)) / 86_400_000));
  }
  return 5;
}

function defaultDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}
