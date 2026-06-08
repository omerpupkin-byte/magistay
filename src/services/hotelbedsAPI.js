// ─── services/hotelbedsAPI.js ──────────────────────────────────
// Hotelbeds (HBX Group) Hotel API integration.
// Provides real hotel data: availability, pricing, photos, amenities.
//
// API docs: https://developer.hotelbeds.com/documentation/hotels/
// Test environment base URL used by default.
// Switch to production after certification.

import crypto from 'crypto';

const BASE_URL = 'https://api.test.hotelbeds.com/hotel-api/1.0';
// Production: 'https://api.hotelbeds.com/hotel-api/1.0'

// ── Auth signature (required per request) ─────────────────────
function buildSignature() {
  const apiKey    = process.env.HOTELBEDS_API_KEY;
  const secret    = process.env.HOTELBEDS_API_SECRET;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const raw       = apiKey + secret + timestamp;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function buildHeaders() {
  return {
    'Api-key':    process.env.HOTELBEDS_API_KEY,
    'X-Signature': buildSignature(),
    'Accept':     'application/json',
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/json',
  };
}

// ── Main search ───────────────────────────────────────────────
export async function searchHotelbeds(quiz) {
  if (!process.env.HOTELBEDS_API_KEY) {
    throw new Error('HOTELBEDS_API_KEY not set');
  }

  const coords = quiz.coords;
  if (!coords?.lat) throw new Error('No coordinates for destination');

  console.log(`[HOTELBEDS] Searching near ${quiz.destination} (${coords.lat}, ${coords.lng})`);

  const body = buildSearchBody(quiz, coords);

  const res = await fetch(`${BASE_URL}/hotels`, {
    method:  'POST',
    headers: buildHeaders(),
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Hotelbeds API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const hotels = data.hotels?.hotels || [];

  console.log(`[HOTELBEDS] Found ${hotels.length} hotels`);

  return hotels.map(h => normaliseHotelbedsHotel(h, quiz));
}

// ── Build search request body ─────────────────────────────────
function buildSearchBody(quiz, coords) {
  const {
    checkIn, checkOut,
    adults = 2, children = 0, infants = 0, rooms = 1,
    radiusKm = 10, stars, budget,
  } = quiz;

  // Occupancy per room
  const paxes = [];
  const adultsPerRoom = Math.ceil(adults / rooms);
  for (let i = 0; i < adultsPerRoom; i++) {
    paxes.push({ type: 'AD' }); // Adult
  }
  if (children > 0) {
    for (let i = 0; i < Math.ceil(children / rooms); i++) {
      paxes.push({ type: 'CH', age: 10 });
    }
  }
  if (infants > 0) {
    paxes.push({ type: 'CH', age: 1 }); // Infant as child age 1
  }

  const occupancies = Array(rooms).fill({ rooms: 1, adults: adultsPerRoom, children: children + infants, paxes });

  const body = {
    stay: {
      checkIn:  checkIn  || getDefaultDate(30),
      checkOut: checkOut || getDefaultDate(35),
    },
    occupancies,
    geolocation: {
      latitude:  coords.lat,
      longitude: coords.lng,
      radius:    radiusKm,
      unit:      'km',
    },
    filter: {
      maxHotels: 20,
      maxRooms:  1,
      minRate:   getBudgetMin(budget),
      maxRate:   getBudgetMax(budget),
      minCategory: stars > 0 ? stars : undefined,
    },
    hotels: {
      hotel: [], // empty = search all
    },
  };

  return body;
}

// ── Normalise Hotelbeds hotel to our standard schema ──────────
function normaliseHotelbedsHotel(h, quiz) {
  const minRate = h.minRate ? parseFloat(h.minRate) : null;
  const nights  = getNights(quiz);
  const nightly = minRate ? Math.round(minRate / nights) : null;

  const stars = h.categoryCode
    ? parseInt(h.categoryCode.replace(/\D/g, '')) || 3
    : 3;

  return {
    id:           `hotelbeds-${h.code}`,
    hotelbedsCode: h.code,
    name:         h.name,
    location:     h.zoneName || '',
    city:         h.destinationName || quiz.destination,
    country:      h.countryCode || '',
    stars,
    coords: {
      lat: h.latitude  ? parseFloat(h.latitude)  : null,
      lng: h.longitude ? parseFloat(h.longitude) : null,
    },
    distanceKm: null, // Hotelbeds doesn't return distance in search

    amenities:   normaliseHotelbedsAmenities(h.facilities || []),
    photos:      buildHotelbedsPhotos(h),

    // RI — Hotelbeds provides review score
    riScore:      h.reviews?.rating ? parseFloat(h.reviews.rating) : null,
    riConfidence: h.reviews?.reviewCount > 500 ? 'high'
                : h.reviews?.reviewCount > 100 ? 'moderate' : 'low',
    totalReviews: h.reviews?.reviewCount || 0,

    // Pricing
    platforms: {
      hotelbeds: {
        score:     h.reviews?.rating ? parseFloat(h.reviews.rating) : null,
        reviews:   h.reviews?.reviewCount || 0,
        price:     nightly,
        flexible:  null,
        flexTerms: null,
      },
    },
    bestPrice: nightly ? { platform: 'hotelbeds', price: nightly } : null,
    bestFlex:  null,

    rawReviews:  [],
    matchScore:  null,
    matchReason: null,
    reviews:     null,
  };
}

// ── Amenity normalisation ─────────────────────────────────────
function normaliseHotelbedsAmenities(facilities) {
  const map = {
    'POOL':           'pool',
    'SPA':            'spa',
    'GYM':            'gym',
    'REST':           'restaurant',
    'BAR':            'bar',
    'BREAKF':         'breakfast',
    'PARK':           'parking',
    'BEACH':          'beach_access',
    'ELEV':           'elevator',
    'WIFI':           'wifi',
    'ACCES':          'wheelchair_accessible',
    'PETS':           'pet',
    'CRIB':           'crib',
    'KIDS':           'family_friendly',
    'CONC':           'concierge',
    'ROOF':           'rooftop',
    'LATE':           'late_checkout',
  };

  return (facilities || [])
    .map(f => {
      const code = f.facilityCode || f.code || '';
      return map[code.slice(0, 5)] || null;
    })
    .filter(Boolean);
}

// ── Photo builder ─────────────────────────────────────────────
function buildHotelbedsPhotos(h) {
  // Hotelbeds provides image paths — build full URLs
  const images = h.images || [];

  if (images.length > 0) {
    const base = 'https://photos.hotelbeds.com/giata/';
    return {
      main:   { url: base + (images[0]?.path || ''), label: 'Hotel', bg: '#C4D8B8', color: '#3a5a2a' },
      thumb1: { url: base + (images[1]?.path || ''), label: 'Room',  bg: '#B4C8D8', color: '#1a3a5a' },
      thumb2: { url: base + (images[2]?.path || ''), label: 'View',  bg: '#D8C8B4', color: '#5a3a1a' },
    };
  }

  // Fallback placeholder
  return {
    main:   { bg: '#C4D8B8', color: '#3a5a2a', label: 'Hotel' },
    thumb1: { bg: '#B4C8D8', color: '#1a3a5a', label: 'Room'  },
    thumb2: { bg: '#D8C8B4', color: '#5a3a1a', label: 'View'  },
  };
}

// ── Helpers ───────────────────────────────────────────────────
function getBudgetMin(budget) {
  switch (budget) {
    case 'u80':     return 0;
    case '80_150':  return 80;
    case '150_250': return 150;
    case '250plus': return 250;
    default:        return 0;
  }
}

function getBudgetMax(budget) {
  switch (budget) {
    case 'u80':     return 80;
    case '80_150':  return 150;
    case '150_250': return 250;
    case '250plus': return 9999;
    default:        return 9999;
  }
}

function getNights(quiz) {
  if (quiz.checkIn && quiz.checkOut) {
    return Math.max(1, Math.round(
      (new Date(quiz.checkOut) - new Date(quiz.checkIn)) / 86_400_000
    ));
  }
  return 5;
}

function getDefaultDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}
