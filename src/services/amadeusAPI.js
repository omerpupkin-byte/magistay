// ─── services/amadeusAPI.js ────────────────────────────────────
// Amadeus Hotel Search API integration.
// 150,000+ hotels worldwide. Instant access. Free test quota.
//
// HOW TO ACTIVATE:
// 1. Sign up at: developers.amadeus.com (free, instant)
// 2. Create an app → get API Key + API Secret
// 3. Add to Railway Variables:
//      AMADEUS_API_KEY=your_key
//      AMADEUS_API_SECRET=your_secret
// 4. That's it — server auto-switches to real hotel data
//
// Amadeus Self-Service API docs:
// https://developers.amadeus.com/self-service/category/hotels

const AMADEUS_AUTH_URL = 'https://test.api.amadeus.com/v1/security/oauth2/token';
const AMADEUS_BASE_URL = 'https://test.api.amadeus.com';
// When approved for production, change to:
// const AMADEUS_BASE_URL = 'https://api.amadeus.com';

// ── Token cache — reuse until expiry ──────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expiresAt - 30_000) {
    return _tokenCache.token;
  }

  const res = await fetch(AMADEUS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.AMADEUS_API_KEY,
      client_secret: process.env.AMADEUS_API_SECRET,
    }),
  });

  if (!res.ok) throw new Error(`Amadeus auth failed: ${res.status}`);
  const data = await res.json();

  _tokenCache = {
    token:     data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return _tokenCache.token;
}

// ── Main search ───────────────────────────────────────────────
export async function searchAmadeus(quiz) {
  if (!process.env.AMADEUS_API_KEY) {
    throw new Error('AMADEUS_API_KEY not set');
  }

  const coords = quiz.coords;
  if (!coords?.lat) throw new Error('No coordinates for destination');

  const token = await getAccessToken();

  // Step 1: Get hotel IDs near the location
  const hotelIds = await getHotelsByLocation(token, coords, quiz);
  if (!hotelIds.length) return [];

  console.log(`[AMADEUS] Found ${hotelIds.length} hotels near ${quiz.destination}`);

  // Step 2: Get offers/prices for those hotels
  const offers = await getHotelOffers(token, hotelIds, quiz);

  return offers.map(o => normaliseAmadeusHotel(o, quiz));
}

// ── Step 1: Hotel list by geo-location ────────────────────────
async function getHotelsByLocation(token, coords, quiz) {
  const params = new URLSearchParams({
    latitude:  coords.lat,
    longitude: coords.lng,
    radius:    quiz.radiusKm || 10,
    radiusUnit: 'KM',
    hotelSource: 'ALL',
  });

  // Star rating filter
  if (quiz.stars > 0) {
    const ratings = [];
    for (let i = quiz.stars; i <= 5; i++) ratings.push(i);
    params.set('ratings', ratings.join(','));
  }

  const res = await fetch(
    `${AMADEUS_BASE_URL}/v1/reference-data/locations/hotels/by-geocode?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Amadeus hotel list failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  const hotels = data.data || [];

  // Return up to 20 hotel IDs for pricing (API limit per call)
  return hotels.slice(0, 20).map(h => h.hotelId);
}

// ── Step 2: Get offers (availability + pricing) ───────────────
async function getHotelOffers(token, hotelIds, quiz) {
  const {
    checkIn, checkOut,
    adults = 2, children = 0, rooms = 1,
  } = quiz;

  const params = new URLSearchParams({
    hotelIds:    hotelIds.join(','),
    adults:      adults,
    checkInDate:  checkIn  || getDefaultDate(30),
    checkOutDate: checkOut || getDefaultDate(35),
    roomQuantity: rooms,
    currency:    'USD',
    bestRateOnly: true,
    includeClosed: false,
  });

  if (children > 0) {
    // Amadeus takes child ages — default to age 10
    const ages = Array(children).fill(10).join(',');
    params.set('childAges', ages);
  }

  const res = await fetch(
    `${AMADEUS_BASE_URL}/v3/shopping/hotel-offers?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    console.warn(`[AMADEUS] Hotel offers failed: ${res.status}`, err);
    return [];
  }

  const data = await res.json();
  return data.data || [];
}

// ── Normalise Amadeus hotel to our standard schema ─────────────
function normaliseAmadeusHotel(hotelData, quiz) {
  const hotel = hotelData.hotel || {};
  const offer  = hotelData.offers?.[0];
  const price  = offer?.price;

  const nightly = price?.total
    ? Math.round(parseFloat(price.total) / getNights(quiz))
    : null;

  const stars = hotel.rating ? parseInt(hotel.rating) : 3;

  // Build amenities from Amadeus amenities list
  const amenities = normaliseAmadeusAmenities(hotel.amenities || []);

  // Check for crib/infant facilities
  if (quiz.infants > 0) {
    // Amadeus doesn't always list cribs — flag as unknown
    if (!amenities.includes('crib')) amenities.push('crib_unconfirmed');
  }

  return {
    id:          `amadeus-${hotel.hotelId}`,
    amadeusId:   hotel.hotelId,
    name:        hotel.name || 'Unknown Hotel',
    location:    hotel.address?.lines?.join(', ') || '',
    city:        hotel.address?.cityCode || quiz.destination,
    country:     hotel.address?.countryCode || '',
    stars:       stars,
    coords: {
      lat: hotel.latitude,
      lng: hotel.longitude,
    },
    distanceKm: hotel.distance?.value
      ? Math.round(hotel.distance.value * 10) / 10
      : null,
    amenities,
    photos: buildAmadeusPhotos(hotel),

    // Ratings — Amadeus provides aggregate score
    riScore:      hotel.rating ? parseFloat(hotel.rating) * 2 : null, // Convert 5-star to 10-point
    riConfidence: 'moderate',
    totalReviews: 0, // Amadeus doesn't provide review count in basic API

    // Pricing
    platforms: {
      amadeus: {
        score:     null,
        reviews:   0,
        price:     nightly,
        flexible:  null,
        flexTerms: offer?.policies?.cancellation?.deadline
          ? `Free cancel until ${offer.policies.cancellation.deadline}`
          : null,
      },
    },
    bestPrice: nightly ? { platform: 'amadeus', price: nightly } : null,
    bestFlex:  offer?.policies?.cancellation
      ? { platform: 'amadeus', price: nightly }
      : null,

    // Raw offer data for booking
    amadeusOfferId: offer?.id,

    rawReviews:  [],
    matchScore:  null,
    matchReason: null,
    reviews:     null,
  };
}

// ── Amenity normalisation ─────────────────────────────────────
function normaliseAmadeusAmenities(amenities) {
  const map = {
    'SWIMMING_POOL':         'pool',
    'SPA':                   'spa',
    'FITNESS_CENTER':        'gym',
    'RESTAURANT':            'restaurant',
    'BREAKFAST_INCLUDED':    'breakfast',
    'PARKING':               'parking',
    'ACCESSIBLE_FACILITIES': 'wheelchair_accessible',
    'PETS_ALLOWED':          'pet',
    'WIFI':                  'wifi',
    'BEACH':                 'beach_access',
    'ROOFTOP_TERRACE':       'rooftop',
    'ELEVATOR':              'elevator',
    'BABY_EQUIPMENT':        'crib',
    'KIDS_WELCOME':          'family_friendly',
    'AIR_CONDITIONING':      'ac',
    'BAR':                   'bar',
    'CONCIERGE_SERVICES':    'concierge',
  };
  return amenities
    .map(a => map[a] || a.toLowerCase().replace(/_/g, ' '))
    .filter(Boolean);
}

// ── Photo builder ─────────────────────────────────────────────
function buildAmadeusPhotos(hotel) {
  // Amadeus basic API doesn't return photo URLs
  // Use placeholder colors based on hotel category
  const colors = [
    { bg: '#C4D8B8', color: '#3a5a2a', label: 'Hotel exterior' },
    { bg: '#B4C8D8', color: '#1a3a5a', label: 'Room' },
    { bg: '#D8C8B4', color: '#5a3a1a', label: 'Lobby' },
  ];

  return {
    main:   colors[0],
    thumb1: colors[1],
    thumb2: colors[2],
  };
}

// ── Helpers ───────────────────────────────────────────────────
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
