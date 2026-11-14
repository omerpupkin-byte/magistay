// ─── services/hotelSearch.js ───────────────────────────────────
// Finds candidate hotels for a quiz. Picks the best source available:
//
//   1. Booking.com Demand API / Expedia Rapid   (when their keys are set)
//   2. Google Hotels                            (SERPAPI_KEY)
//   2b. Hotelbeds                               (HOTELBEDS_API_KEY; used if Google fails)
//   3. AI suggestions from general knowledge    (when a supplier has
//      nothing for the destination, fails, or none is configured)
//   4. Built-in demo hotels                     (no keys at all — local dev only)
//
// Returns { hotels, source, preMatched }. `source` travels all the way to
// the page so it can tell the traveller what kind of data they are seeing.

import { getHotelsByCity, computeRI } from '../data/mockHotels.js';
import { geocode }               from './geocoding.js';
import { searchExpedia }         from './expediaAPI.js';
import { searchBookingCom }      from './bookingAPI.js';
import { searchHotelbeds }       from './hotelbedsAPI.js';
import { searchGoogleHotels, googleHotelsEnabled } from './googleHotelsAPI.js';
import { buildAllAffiliateLinks } from './affiliateLinks.js';
import { suggestHotelsFromKnowledge, aiFallbackEnabled } from './aiCandidates.js';

// ── Main entry point ───────────────────────────────────────────
export async function searchHotels(quiz) {
  quiz.coords = await geocode(quiz.destination);

  // "Near the old port" — search around the landmark instead of the
  // centre of the destination, and measure distances from it.
  if (quiz.landmark) {
    const spot = await geocode(`${quiz.landmark}, ${quiz.destination}`);
    if (spot?.lat != null) {
      quiz.coords = { ...spot, city: quiz.coords?.city || spot.city, country: quiz.coords?.country || spot.country, spanKm: null, label: quiz.landmark };
    }
  }

  const suppliers = [];
  if (process.env.BOOKING_API_KEY)   suppliers.push(['booking',   searchBookingCom]);
  if (process.env.EXPEDIA_API_KEY)   suppliers.push(['expedia',   searchExpedia]);
  // Google Hotels lists only hotels some booking site can sell on these
  // dates, so it comes before the wholesale supplier.
  if (googleHotelsEnabled())         suppliers.push(['google_hotels', searchGoogleHotels]);
  if (process.env.HOTELBEDS_API_KEY) suppliers.push(['hotelbeds', searchHotelbeds]);

  // Live inventory first.
  for (const [name, search] of suppliers) {
    try {
      const hotels = await search(quiz);
      if (hotels.length > 0) {
        console.log(`[SEARCH] Source: ${name} (${hotels.length} hotels)`);
        return { hotels: withLinks(hotels, quiz), source: name, preMatched: false };
      }
      console.log(`[SEARCH] ${name} returned no hotels for "${quiz.destination}"`);
    } catch (e) {
      console.error(`[SEARCH] ${name} failed:`, e.message.slice(0, 300));
    }
  }

  // No live inventory — AI suggestions, clearly labelled as such.
  if (aiFallbackEnabled()) {
    try {
      const hotels = await suggestHotelsFromKnowledge(quiz);
      return { hotels: withLinks(hotels, quiz), source: 'ai_knowledge', preMatched: true };
    } catch (e) {
      console.error('[SEARCH] AI suggestions failed:', e.message.slice(0, 300));
      return { hotels: [], source: 'none', preMatched: true };
    }
  }

  // Nothing configured at all: demo data for local development.
  if (suppliers.length === 0) {
    console.log('[SEARCH] Source: built-in demo data (no API keys configured)');
    return { hotels: withLinks(searchMock(quiz), quiz), source: 'mock', preMatched: false };
  }

  return { hotels: [], source: 'none', preMatched: false };
}

function withLinks(hotels, quiz) {
  return hotels.map(h => ({ ...h, affiliateLinks: buildAllAffiliateLinks(h, quiz) }));
}

// ── Demo search (no API keys) ──────────────────────────────────
function searchMock(quiz) {
  let hotels = quiz.destination ? getHotelsByCity(quiz.destination) : [];
  if (quiz.stars > 0) hotels = hotels.filter(h => h.stars >= quiz.stars);
  return hotels.map(normaliseMockHotel);
}

function normaliseMockHotel(hotel) {
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
    source:       'mock',
    name:         hotel.name,
    location:     hotel.location,
    city:         hotel.city,
    country:      hotel.country,
    stars:        hotel.stars,
    coords:       hotel.coords,
    distanceKm:   hotel.distanceKm,
    amenities:    hotel.amenities,
    facilities:   [],
    description:  '',
    photos:       hotel.photos,
    gallery:      [],
    riScore:      ri.score,
    riConfidence: ri.confidence,
    totalReviews: ri.totalReviews,
    ratingSource: 'demo',
    available:    true,
    currency:     'USD',
    priceType:    'demo',
    platforms:    hotel.platforms,
    bestPrice:    stdPrices[0]  || null,
    bestFlex:     flexPrices[0] || null,
    rawReviews:   hotel.rawReviews || [],
    matchScore:   null,
    matchReason:  null,
    reviews:      null,
  };
}
