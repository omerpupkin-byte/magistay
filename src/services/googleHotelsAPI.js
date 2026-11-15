// ─── services/googleHotelsAPI.js ───────────────────────────────
// Candidate hotels from Google Hotels (read through SerpApi, SERPAPI_KEY).
//
// Why this is the first source: Google only lists a price for a hotel
// that some booking site can actually sell on the traveller's dates, so
// every candidate here is bookable somewhere today. It also brings what
// the matcher needs: amenities (and what is explicitly NOT offered),
// guest rating, what reviews say per theme, photos and nearby places.
//
// What it does NOT give is money: Google's own links are never used.
// Each hotel carries its Google token; livePrices.js uses it to read the
// price per booking site, and affiliateLinks.js turns the site's hotel
// page into OUR link.
//
// Cost: GOOGLE_HOTELS_PAGES searches per new trip (default 2, about 40
// hotels), cached by the search route for 30 minutes.

import { distanceKm } from './geocoding.js';
import { amenitiesFromFacilities } from './hotelbedsAPI.js';
import { serpApiFetch, tripQuery } from './livePrices.js';

const MAX_PAGES = () => Math.min(3, Math.max(1, Number(process.env.GOOGLE_HOTELS_PAGES) || 2));

// Budget bands (per night). Used only to keep the candidate pool relevant;
// the matcher still judges value hotel by hotel.
const BUDGET_MAX = { u80: 80, '80_150': 150, '150_250': 250 };

export function googleHotelsEnabled() {
  return !!process.env.SERPAPI_KEY && process.env.HOTEL_SOURCE !== 'hotelbeds';
}

// ── Public: search ────────────────────────────────────────────
// `fetchJson` is injectable so tests run without the network.
export async function searchGoogleHotels(quiz, { fetchJson = serpApiFetch } = {}) {
  if (!isDate(quiz.checkIn) || !isDate(quiz.checkOut)) return [];

  const currency = process.env.DISPLAY_CURRENCY || 'EUR';
  const params = { ...tripQuery(quiz, currency), q: searchText(quiz) };
  if (quiz.stars >= 2) params.hotel_class = [2, 3, 4, 5].filter(s => s >= Math.min(5, quiz.stars)).join(',');
  if (BUDGET_MAX[quiz.budget]) params.max_price = String(Math.round(BUDGET_MAX[quiz.budget] * 1.3));

  const seen = new Set();
  const hotels = [];
  let pageToken = null;

  for (let page = 0; page < MAX_PAGES(); page++) {
    const res = await fetchJson(pageToken ? { ...params, next_page_token: pageToken } : params);
    for (const p of res?.properties || []) {
      if (!usable(p) || seen.has(p.property_token)) continue;
      if (isHostel(p) && quiz.budget !== 'u80') continue;   // dorm beds are for the lowest budget only
      seen.add(p.property_token);
      hotels.push(normaliseProperty(p, quiz, currency));
    }
    pageToken = res?.serpapi_pagination?.next_page_token;
    if (!pageToken) break;
  }

  console.log(`[GOOGLE HOTELS] ${hotels.length} bookable hotels for "${params.q}"`);
  return hotels;
}

function searchText(quiz) {
  const place = String(quiz.destination || '').trim();
  return quiz.landmark ? `Hotels near ${String(quiz.landmark).trim()}, ${place}` : `Hotels in ${place}`;
}

// A candidate must be a hotel we can look up again, with a price on these
// dates. Paid placements are left out: rank is earned by fit, not by ads.
function usable(p) {
  return !!p && typeof p.name === 'string' && !!p.property_token
    && p.sponsored !== true
    && !/vacation rental/i.test(p.type || '')
    && nightly(p.rate_per_night) != null;
}

// Hostels list a per-bed price that makes them look like a bargain hotel.
function isHostel(p) {
  return /\bhostel\b/i.test(`${p.name} ${p.type || ''} ${p.description || ''}`) || Number(p.extracted_hotel_class) === 1;
}

// ── Google's property → our hotel shape ───────────────────────
export function normaliseProperty(p, quiz, currency) {
  const coords = quiz.coords || null;
  const lat = num(p.gps_coordinates?.latitude), lng = num(p.gps_coordinates?.longitude);
  // "km from the centre" means nothing for an island or a region.
  const isArea = Number(coords?.spanKm) > 40;
  const dist   = isArea ? null : distanceKm(coords?.lat, coords?.lng, lat, lng);

  const offered  = strings(p.amenities);
  const excluded = strings(p.excluded_amenities);
  const rating5  = num(p.overall_rating);
  const reviews  = Math.max(0, Math.round(num(p.reviews) || 0));
  const price    = nightly(p.rate_per_night);
  const images   = (Array.isArray(p.images) ? p.images : []).map(imageUrl).filter(Boolean);
  const tints    = placeholderPhotos();
  const slot     = (url, fallback) => (url ? { ...fallback, url } : fallback);

  return {
    id:           `google-${p.property_token}`,
    googleToken:  p.property_token,
    source:       'google_hotels',
    name:         p.name.trim(),
    location:     '',
    city:         coords?.city || quiz.destination || '',
    country:      coords?.country || '',
    stars:        Math.max(0, Math.min(5, Math.round(num(p.extracted_hotel_class) || 0))),
    coords:       { lat, lng },
    distanceKm:   dist == null ? null : Math.round(dist * 10) / 10,
    distanceFrom: dist == null ? null : (coords?.label || 'the centre'),

    amenities:    amenityKeys(offered),
    facilities:   offered.slice(0, 80),
    excluded:     excluded.slice(0, 40),       // stated by the hotel's listing as NOT offered
    freeBreakfast: offered.some(a => /^free breakfast$/i.test(a)),
    description:  typeof p.description === 'string' ? p.description.slice(0, 900) : '',
    website:      typeof p.link === 'string' ? p.link : null,
    checkInTime:  p.check_in_time || null,
    checkOutTime: p.check_out_time || null,
    nearby:       nearbyPlaces(p.nearby_places),

    photos:  { main: slot(images[0], tints.main), thumb1: slot(images[1], tints.thumb1), thumb2: slot(images[2], tints.thumb2) },
    gallery: images.slice(0, 12).map((url, i) => ({ url, label: i === 0 ? 'Hotel' : 'Photo' })),

    // Guest rating: Google's 1-5 scale shown on our 10 scale.
    riScore:        rating5 ? Math.round(rating5 * 20) / 10 : null,
    riConfidence:   reviews > 500 ? 'high' : reviews > 100 ? 'moderate' : 'low',
    totalReviews:   reviews,
    ratingSource:   rating5 ? 'Google' : null,
    locationRating: num(p.location_rating),
    reviewThemes:   reviewThemes(p.reviews_breakdown),

    // Bookable somewhere on these dates. The figure is the lowest price
    // Google lists anywhere; the price per booking site comes next.
    available:  true,
    currency,
    priceType:  'indicative',
    platforms:  { google: { price } },
    bestPrice:  { platform: 'google', price },
    bestFlex:   null,
    breakfastPrice: null,

    rawReviews:  [],
    matchScore:  null,
    matchReason: null,
    reviews:     null,
  };
}

function nightly(rate) {
  const n = num(rate?.extracted_after_taxes_fees) ?? num(rate?.extracted_lowest) ?? num(rate?.extracted_display_price);
  return n != null && n > 0 ? Math.round(n) : null;
}

// Google's amenity names → the amenity keys the matcher understands.
const EXTRA_AMENITIES = [
  ['pet',                   /pet-?friendly/i],
  ['family_friendly',       /(child|kid|family)-?friendly/i],
  ['airport_shuttle',       /airport shuttle/i],
  ['kitchen',               /kitchen/i],
  ['hot_tub',               /hot tub|jacuzzi/i],
  ['all_inclusive',         /all-?inclusive/i],
];

function amenityKeys(names) {
  const keys = new Set(amenitiesFromFacilities(names));
  for (const name of names) for (const [key, re] of EXTRA_AMENITIES) if (re.test(name)) keys.add(key);
  return [...keys];
}

// What guests talk about, and how they feel about it. Themes with too few
// mentions say little and are left out.
function reviewThemes(breakdown) {
  return (Array.isArray(breakdown) ? breakdown : [])
    .map(b => ({ theme: String(b?.name || '').trim(), mentions: num(b?.total_mentioned) || 0, positive: num(b?.positive) || 0, negative: num(b?.negative) || 0 }))
    .filter(t => t.theme && t.mentions >= 10)
    .slice(0, 10);
}

function nearbyPlaces(places) {
  return (Array.isArray(places) ? places : []).slice(0, 5).map(pl => {
    const t = Array.isArray(pl?.transportations) ? pl.transportations[0] : null;
    return pl?.name ? `${pl.name}${t?.duration ? ` (${t.duration}${t.type ? ' ' + String(t.type).toLowerCase() : ''})` : ''}` : null;
  }).filter(Boolean);
}

// A photo sized for the page. Google-hosted originals are served at
// "=s10000" (full size); ask for 1200px instead.
function imageUrl(img) {
  const original = typeof img?.original_image === 'string' ? img.original_image : '';
  const thumb    = typeof img?.thumbnail === 'string' ? img.thumbnail : '';
  const url = original || thumb;
  if (!/^https:\/\//.test(url)) return null;
  return /googleusercontent\.com\//.test(url) ? url.replace(/=s\d+$/, '=s1200') : url;
}

function placeholderPhotos() {
  return {
    main:   { bg: '#C4D8B8', color: '#3a5a2a', label: 'Hotel' },
    thumb1: { bg: '#B4C8D8', color: '#1a3a5a', label: 'Room'  },
    thumb2: { bg: '#D8C8B4', color: '#5a3a1a', label: 'View'  },
  };
}

function strings(v) { return (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()); }
function num(v) { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; }
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
