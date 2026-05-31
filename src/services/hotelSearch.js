// ─── services/hotelSearch.js ───────────────────────────────────
// Finds candidate hotels based on quiz parameters.
//
// Current mode: mock data  (no API keys required)
// Future mode:  Booking.com Affiliate API + Expedia Rapid API
//
// The returned schema is identical in both modes,
// so switching is a single function swap with zero frontend changes.

import { getHotelsByCity, computeRI, MOCK_HOTELS } from '../data/mockHotels.js';

// ── Main entry point ───────────────────────────────────────────
export async function searchHotels(quiz) {
  // When real API keys are present, swap this for the live call:
  // return await searchBookingCom(quiz);
  return searchMock(quiz);
}

// ── Mock search ────────────────────────────────────────────────
function searchMock(quiz) {
  const { destination, budget, stars, radiusKm = 10 } = quiz;

  // 1. Get hotels for destination (city match)
  let hotels = destination
    ? getHotelsByCity(destination)
    : MOCK_HOTELS;                  // fallback: return all

  // 2. Filter by star rating if specified
  if (stars && stars > 0) {
    hotels = hotels.filter(h => h.stars >= stars);
  }

  // 3. Filter by budget
  if (budget && budget !== 'any') {
    hotels = hotels.filter(h => matchesBudget(h, budget));
  }

  // 4. Filter by radius
  if (radiusKm) {
    hotels = hotels.filter(h => h.distanceKm <= radiusKm);
  }

  // 5. Attach computed RI score and normalised pricing to each hotel
  return hotels.map(h => normaliseHotel(h));
}

// ── Normalise a hotel into the standard schema ─────────────────
// This is what we return regardless of mock vs real API.
function normaliseHotel(hotel) {
  const ri = computeRI(hotel.platforms);

  // Best standard price across all platforms
  const stdPrices  = Object.entries(hotel.platforms)
    .filter(([, p]) => p.price)
    .map(([platform, p]) => ({ platform, price: p.price }))
    .sort((a, b) => a.price - b.price);

  // Best flexible price
  const flexPrices = Object.entries(hotel.platforms)
    .filter(([, p]) => p.flexible)
    .map(([platform, p]) => ({ platform, price: p.flexible, terms: p.flexTerms }))
    .sort((a, b) => a.price - b.price);

  return {
    id:            hotel.id,
    name:          hotel.name,
    location:      hotel.location,
    city:          hotel.city,
    country:       hotel.country,
    stars:         hotel.stars,
    coords:        hotel.coords,
    distanceKm:    hotel.distanceKm,
    amenities:     hotel.amenities,
    photos:        hotel.photos,

    // RI (Rating Index)
    riScore:        ri.score,
    riConfidence:   ri.confidence,
    totalReviews:   ri.totalReviews,

    // Platform breakdown
    platforms:      hotel.platforms,

    // Quick-access best prices
    bestPrice: stdPrices[0]  || null,
    bestFlex:  flexPrices[0] || null,

    // Raw reviews for Claude to summarise
    rawReviews: hotel.rawReviews || [],

    // Placeholders — filled in by aiMatcher
    matchScore:  null,
    matchReason: null,
    reviews:     null,
  };
}

// ── Budget filter helper ───────────────────────────────────────
function matchesBudget(hotel, budget) {
  const min = hotel.pricePerNight?.min ?? 0;
  switch (budget) {
    case 'u80':     return min < 80;
    case '80_150':  return min >= 80  && min <= 150;
    case '150_250': return min >= 150 && min <= 250;
    case '250plus': return min >= 250;
    default:        return true;   // 'any' or unknown
  }
}

// ── Stub for future Booking.com integration ────────────────────
// Uncomment and implement when you have your API key:
//
// async function searchBookingCom(quiz) {
//   const { destination, checkIn, checkOut, adults, children, rooms } = quiz;
//
//   const coords = await geocode(destination);   // Google Maps
//
//   const response = await fetch('https://distribution-xml.booking.com/json/getHotels', {
//     headers: {
//       'Authorization': `Basic ${Buffer.from(
//         `${process.env.BOOKING_API_KEY}:${process.env.BOOKING_API_SECRET}`
//       ).toString('base64')}`,
//     },
//   });
//   const data = await response.json();
//   return data.result.map(h => normaliseBookingHotel(h));
// }
