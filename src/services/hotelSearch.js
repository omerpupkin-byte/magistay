// ─── services/hotelSearch.js ───────────────────────────────────
// Hotel search orchestrator.
//
// MODE SELECTION (automatic based on environment variables):
//
//   Mock mode     → no API keys needed, uses built-in data
//   Expedia mode  → set EXPEDIA_API_KEY + EXPEDIA_API_SECRET
//   Booking mode  → set BOOKING_API_KEY + BOOKING_API_SECRET
//   Combined mode → set both → merges results, best coverage
//
// Switch modes by adding keys to Railway Variables.
// Zero frontend changes required in any mode.

import { getHotelsByCity, computeRI, MOCK_HOTELS } from '../data/mockHotels.js';
import { geocode }            from './geocoding.js';
import { searchExpedia }      from './expediaAPI.js';
import { searchBookingCom, buildAllAffiliateLinks } from './bookingAPI.js';
import { searchAmadeus }      from './amadeusAPI.js';
import { searchHotelbeds }    from './hotelbedsAPI.js';

// ── Main entry point ───────────────────────────────────────────
export async function searchHotels(quiz) {
  const coords = await geocode(quiz.destination);
  quiz.coords  = coords;

  const hasBooking    = !!process.env.BOOKING_API_KEY;
  const hasExpedia    = !!process.env.EXPEDIA_API_KEY;
  const hasAmadeus    = !!process.env.AMADEUS_API_KEY;
  const hasHotelbeds  = !!process.env.HOTELBEDS_API_KEY;

  // Priority order: Booking+Expedia > Booking > Expedia > Hotelbeds > Amadeus > Mock
  if (hasBooking && hasExpedia) {
    console.log('[SEARCH] Mode: Booking.com + Expedia (combined)');
    return searchCombined(quiz);
  }
  if (hasBooking) {
    console.log('[SEARCH] Mode: Booking.com');
    return searchBookingCom(quiz).then(h => addAffiliateLinks(h, quiz));
  }
  if (hasExpedia) {
    console.log('[SEARCH] Mode: Expedia');
    return searchExpedia(quiz).then(h => addAffiliateLinks(h, quiz));
  }
  if (hasHotelbeds) {
    console.log('[SEARCH] Mode: Hotelbeds — real hotel data');
    return searchHotelbeds(quiz).then(h => addAffiliateLinks(h, quiz));
  }
  if (hasAmadeus) {
    console.log('[SEARCH] Mode: Amadeus');
    return searchAmadeus(quiz).then(h => addAffiliateLinks(h, quiz));
  }

  console.log('[SEARCH] Mode: Mock data');
  return searchMock(quiz);
}

// ── Combined search: merge Booking + Expedia ───────────────────
async function searchCombined(quiz) {
  const [bookingResults, expediaResults] = await Promise.allSettled([
    searchBookingCom(quiz),
    searchExpedia(quiz),
  ]);

  const booking = bookingResults.status === 'fulfilled' ? bookingResults.value : [];
  const expedia = expediaResults.status === 'fulfilled' ? expediaResults.value : [];

  // Merge by name — if same hotel appears in both, merge platform data
  const merged = mergeHotelResults(booking, expedia);
  return addAffiliateLinks(merged, quiz);
}

// ── Merge hotel results from multiple sources ──────────────────
function mergeHotelResults(booking, expedia) {
  const map = new Map();

  for (const h of booking) {
    map.set(normaliseHotelName(h.name), h);
  }

  for (const h of expedia) {
    const key = normaliseHotelName(h.name);
    if (map.has(key)) {
      // Merge platform data
      const existing = map.get(key);
      existing.platforms = { ...existing.platforms, ...h.platforms };
      // Recompute RI with combined reviews
      const ri = computeRI(existing.platforms);
      existing.riScore      = ri.score;
      existing.riConfidence = ri.confidence;
      existing.totalReviews = ri.totalReviews;
    } else {
      map.set(key, h);
    }
  }

  return Array.from(map.values());
}

function normaliseHotelName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

// ── Add affiliate links to hotel objects ───────────────────────
function addAffiliateLinks(hotels, quiz) {
  return hotels.map(h => ({
    ...h,
    affiliateLinks: buildAllAffiliateLinks(h, quiz),
  }));
}

// ── Mock search (no API keys) ──────────────────────────────────
function searchMock(quiz) {
  const { destination, budget, stars, radiusKm = 10 } = quiz;

  let hotels = destination
    ? getHotelsByCity(destination)
    : MOCK_HOTELS;

  if (stars && stars > 0) hotels = hotels.filter(h => h.stars >= stars);
  if (budget && budget !== 'any') hotels = hotels.filter(h => matchesBudget(h, budget));
  if (radiusKm) hotels = hotels.filter(h => h.distanceKm <= radiusKm);

  return hotels.map(h => ({
    ...normaliseHotel(h),
    affiliateLinks: buildAllAffiliateLinks(h, quiz),
  }));
}

// ── Normalise mock hotel to standard schema ────────────────────
function normaliseHotel(hotel) {
  const ri = computeRI(hotel.platforms);

  const stdPrices = Object.entries(hotel.platforms)
    .filter(([, p]) => p.price)
    .map(([platform, p]) => ({ platform, price: p.price }))
    .sort((a, b) => a.price - b.price);

  const flexPrices = Object.entries(hotel.platforms)
    .filter(([, p]) => p.flexible)
    .map(([platform, p]) => ({ platform, price: p.flexible, terms: p.flexTerms }))
    .sort((a, b) => a.price - b.price);

  return {
    id:           hotel.id,
    name:         hotel.name,
    location:     hotel.location,
    city:         hotel.city,
    country:      hotel.country,
    stars:        hotel.stars,
    coords:       hotel.coords,
    distanceKm:   hotel.distanceKm,
    amenities:    hotel.amenities,
    photos:       hotel.photos,
    riScore:      ri.score,
    riConfidence: ri.confidence,
    totalReviews: ri.totalReviews,
    platforms:    hotel.platforms,
    bestPrice:    stdPrices[0]  || null,
    bestFlex:     flexPrices[0] || null,
    rawReviews:   hotel.rawReviews || [],
    matchScore:   null,
    matchReason:  null,
    reviews:      null,
  };
}

function matchesBudget(hotel, budget) {
  const min = hotel.pricePerNight?.min ?? 0;
  switch (budget) {
    case 'u80':     return min < 80;
    case '80_150':  return min >= 80  && min <= 150;
    case '150_250': return min >= 150 && min <= 250;
    case '250plus': return min >= 250;
    default:        return true;
  }
}
