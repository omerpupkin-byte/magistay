// ─── services/expediaAPI.js ────────────────────────────────────
// Expedia Rapid API integration for hotel search + price comparison.
//
// HOW TO ACTIVATE:
// 1. Sign up at: developers.expediagroup.com
// 2. Get your API key and secret
// 3. Add to Railway Variables:
//      EXPEDIA_API_KEY=your_key
//      EXPEDIA_API_SECRET=your_secret
// 4. In hotelSearch.js, change searchHotels() to call searchExpedia()
//
// Covers: Expedia, Hotels.com, Vrbo — all with affiliate commission.
// Instant access upon sign-up (no manual review required).

const EXPEDIA_BASE = 'https://test.ean.com/v3'; // Change to prod URL after testing

// ── Main search ───────────────────────────────────────────────
export async function searchExpedia(quiz) {
  if (!process.env.EXPEDIA_API_KEY) {
    throw new Error('EXPEDIA_API_KEY not set');
  }

  const coords = quiz.coords; // set by geocoding.js
  if (!coords?.lat) {
    throw new Error('No coordinates for destination');
  }

  const {
    checkIn, checkOut,
    adults = 2, children = 0, infants = 0, rooms = 1,
    radiusKm = 10, stars, budget,
  } = quiz;

  // Build request
  const params = new URLSearchParams({
    partnerPointOfSale: 'magistay',
    language:           'en_US',
    currency:           'USD',
    countryCode:        coords.country || 'US',
    latitude:           coords.lat,
    longitude:          coords.lng,
    radius:             radiusKm,
    radiusUnit:         'KM',
    checkIn:            checkIn  || getDefaultCheckIn(),
    checkOut:           checkOut || getDefaultCheckOut(),
    rooms:              rooms,
  });

  // Add occupancy per room
  for (let i = 0; i < rooms; i++) {
    const adultsPerRoom = Math.ceil(adults / rooms);
    let occ = `occupancy=${adultsPerRoom}`;
    if (children > 0) {
      const childAges = Array(Math.ceil(children / rooms)).fill(10).join(',');
      occ += `-${childAges}`;
    }
    if (infants > 0) {
      occ += `,1`; // infant age
    }
    params.append('occupancy', occ);
  }

  // Star filter
  if (stars > 0) {
    params.append('amenities', `STAR_RATING_${stars}`);
  }

  const response = await fetch(`${EXPEDIA_BASE}/properties/availability?${params}`, {
    headers: buildHeaders(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Expedia API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return normaliseExpediaResults(data, quiz);
}

// ── Normalise Expedia response to our standard schema ─────────
function normaliseExpediaResults(data, quiz) {
  const properties = data.properties || [];

  return properties
    .filter(p => p.status === 'available')
    .map(p => {
      const rate   = p.rooms?.[0]?.rates?.[0];
      const price  = rate?.occupancyPricing?.totals?.exclusive?.billableCurrency?.value;
      const nightly = price ? Math.round(price / getNights(quiz)) : null;

      return {
        id:          `expedia-${p.propertyId}`,
        name:        p.propertyName,
        location:    p.address?.addressLine || '',
        city:        p.address?.city || quiz.destination,
        country:     p.address?.countryCode || '',
        stars:       p.starRating || 3,
        coords: {
          lat: p.coordinates?.latitude,
          lng: p.coordinates?.longitude,
        },
        distanceKm:  p.distanceFromCenter || null,
        amenities:   normaliseAmenities(p.amenities || []),
        photos:      normalisePhotos(p.images || []),

        // RI will be computed from actual ratings
        riScore:      p.reviewScore || null,
        riConfidence: p.reviewCount > 1000 ? 'high' : p.reviewCount > 200 ? 'moderate' : 'low',
        totalReviews: p.reviewCount || 0,

        // Expedia pricing
        platforms: {
          expedia: {
            score:      p.reviewScore,
            reviews:    p.reviewCount,
            price:      nightly,
            flexible:   null,
            flexTerms:  null,
          },
        },

        bestPrice:   nightly ? { platform: 'expedia', price: nightly } : null,
        bestFlex:    null,
        rawReviews:  [], // Expedia doesn't give raw reviews — Claude uses platform scores
        matchScore:  null,
        matchReason: null,
        reviews:     null,
      };
    })
    .filter(h => !quiz.budget || matchesBudget(h, quiz.budget));
}

// ── Amenity normalisation ─────────────────────────────────────
function normaliseAmenities(amenities) {
  const map = {
    'POOL':              'pool',
    'SPA':               'spa',
    'FITNESS_CENTER':    'gym',
    'RESTAURANT':        'restaurant',
    'FREE_BREAKFAST':    'breakfast',
    'PARKING':           'parking',
    'ACCESSIBLE':        'wheelchair_accessible',
    'PETS_ALLOWED':      'pet',
    'FREE_WIFI':         'wifi',
    'BEACH_ACCESS':      'beach_access',
    'ROOFTOP':           'rooftop',
  };
  return amenities
    .map(a => map[a.id] || a.id?.toLowerCase())
    .filter(Boolean);
}

// ── Photo normalisation ───────────────────────────────────────
function normalisePhotos(images) {
  const sorted = images.sort((a, b) => (a.displaySequence || 0) - (b.displaySequence || 0));
  return {
    main:   sorted[0] ? { url: sorted[0].links?.['350px']?.href, label: sorted[0].category || 'Hotel', bg: '#C4D8B8', color: '#3a5a2a' } : null,
    thumb1: sorted[1] ? { url: sorted[1].links?.['350px']?.href, label: sorted[1].category || 'Room',  bg: '#B4C8D8', color: '#1a3a5a' } : null,
    thumb2: sorted[2] ? { url: sorted[2].links?.['350px']?.href, label: sorted[2].category || 'View',  bg: '#D8C8B4', color: '#5a3a1a' } : null,
  };
}

// ── Helpers ───────────────────────────────────────────────────
function buildHeaders() {
  const credentials = Buffer.from(
    `${process.env.EXPEDIA_API_KEY}:${process.env.EXPEDIA_API_SECRET}`
  ).toString('base64');

  return {
    'Authorization': `Basic ${credentials}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
    'User-Agent':    'Magistay/1.0',
  };
}

function matchesBudget(hotel, budget) {
  const price = hotel.bestPrice?.price ?? 0;
  switch (budget) {
    case 'u80':     return price < 80;
    case '80_150':  return price >= 80  && price <= 150;
    case '150_250': return price >= 150 && price <= 250;
    case '250plus': return price >= 250;
    default:        return true;
  }
}

function getNights(quiz) {
  if (quiz.checkIn && quiz.checkOut) {
    return Math.max(1, Math.round(
      (new Date(quiz.checkOut) - new Date(quiz.checkIn)) / 86_400_000
    ));
  }
  return 5; // default
}

function getDefaultCheckIn() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().split('T')[0];
}

function getDefaultCheckOut() {
  const d = new Date();
  d.setDate(d.getDate() + 35);
  return d.toISOString().split('T')[0];
}
