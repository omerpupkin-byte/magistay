// ─── services/bookingAPI.js ────────────────────────────────────
// Booking.com integration — two layers:
//
// LAYER 1: Affiliate links (available immediately after CJ approval)
//   → Build deep-links to Booking.com with your affiliate tracking
//   → User clicks → you earn commission on completed bookings
//
// LAYER 2: Demand API (requires separate Booking.com approval)
//   → Full hotel search, availability, pricing, photos, reviews
//   → Apply at: developers.booking.com after CJ approval
//
// HOW TO ACTIVATE AFFILIATE LINKS:
// 1. Get approved on CJ (Commission Junction) — you already applied
// 2. In CJ: Partners → Booking.com → Get Link → Deep Link
// 3. Your affiliate ID will be in the link (aid=XXXXXX)
// 4. Add to Railway Variables: BOOKING_AFFILIATE_ID=your_aid
//
// HOW TO ACTIVATE DEMAND API:
// 1. Apply at developers.booking.com after CJ approval
// 2. Add to Railway Variables:
//      BOOKING_API_KEY=your_key
//      BOOKING_API_SECRET=your_secret

// ── Build affiliate deep-link for a hotel ─────────────────────
export function buildBookingLink(hotel, quiz) {
  const affiliateId = process.env.BOOKING_AFFILIATE_ID;
  if (!affiliateId) return `https://www.booking.com/search.html?ss=${encodeURIComponent(hotel.name)}`;

  const params = new URLSearchParams({
    aid:      affiliateId,
    ss:       hotel.name,
    checkin:  quiz.checkIn  || '',
    checkout: quiz.checkOut || '',
    group_adults:   quiz.adults  || 2,
    group_children: (quiz.children || 0) + (quiz.infants || 0),
    no_rooms:       quiz.rooms   || 1,
    lang:     'en-gb',
    currency: 'USD',
  });

  // If we have the Booking.com hotel ID, link directly to the hotel page
  if (hotel.bookingComId) {
    return `https://www.booking.com/hotel/${hotel.bookingComId}.html?${params}`;
  }

  return `https://www.booking.com/searchresults.html?${params}`;
}

// ── Build affiliate links for all platforms ───────────────────
export function buildAllAffiliateLinks(hotel, quiz) {
  return {
    bookingCom:  buildBookingLink(hotel, quiz),
    expedia:     buildExpediaLink(hotel, quiz),
    agoda:       buildAgodaLink(hotel, quiz),
    hotelsCom:   buildHotelsComLink(hotel, quiz),
    tripAdvisor: buildTripAdvisorLink(hotel, quiz),
    kayak:       buildKayakLink(hotel, quiz),
  };
}

function buildExpediaLink(hotel, quiz) {
  const params = new URLSearchParams({
    destination: hotel.name,
    startDate:   quiz.checkIn  || '',
    endDate:     quiz.checkOut || '',
    adults:      quiz.adults   || 2,
  });
  const affId = process.env.EXPEDIA_AFFILIATE_ID;
  if (affId) params.set('affcid', affId);
  return `https://www.expedia.com/Hotel-Search?${params}`;
}

function buildAgodaLink(hotel, quiz) {
  const params = new URLSearchParams({
    city:      hotel.city,
    checkIn:   quiz.checkIn  || '',
    checkOut:  quiz.checkOut || '',
    adults:    quiz.adults   || 2,
    children:  (quiz.children || 0) + (quiz.infants || 0),
    rooms:     quiz.rooms    || 1,
  });
  const affId = process.env.AGODA_AFFILIATE_ID;
  if (affId) params.set('cid', affId);
  return `https://www.agoda.com/search?${params}`;
}

function buildHotelsComLink(hotel, quiz) {
  const params = new URLSearchParams({
    q:         hotel.name,
    startDate: quiz.checkIn  || '',
    endDate:   quiz.checkOut || '',
    adults:    quiz.adults   || 2,
  });
  return `https://www.hotels.com/search.do?${params}`;
}

function buildTripAdvisorLink(hotel, quiz) {
  const params = new URLSearchParams({
    q:     hotel.name,
    geo:   hotel.city || '',
  });
  return `https://www.tripadvisor.com/Search?${params}`;
}

function buildKayakLink(hotel, quiz) {
  const checkIn  = quiz.checkIn  || getDefaultDate(30);
  const checkOut = quiz.checkOut || getDefaultDate(35);
  return `https://www.kayak.com/hotels/${encodeURIComponent(hotel.city || hotel.name)}/${checkIn}/${checkOut}/${quiz.adults || 2}adults`;
}

// ── Demand API (full hotel data) ──────────────────────────────
// Requires separate Booking.com API approval.
// Structure is ready — activate by setting BOOKING_API_KEY.
export async function searchBookingCom(quiz) {
  if (!process.env.BOOKING_API_KEY) {
    throw new Error('BOOKING_API_KEY not set');
  }

  const coords = quiz.coords;
  if (!coords?.lat) throw new Error('No coordinates');

  const { checkIn, checkOut, adults = 2, children = 0, rooms = 1, radiusKm = 10 } = quiz;

  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.BOOKING_API_KEY}:${process.env.BOOKING_API_SECRET}`
  ).toString('base64');

  // Search hotels by location
  const searchParams = new URLSearchParams({
    latitude:       coords.lat,
    longitude:      coords.lng,
    radius:         radiusKm * 1000, // Booking uses metres
    checkin:        checkIn  || getDefaultDate(30),
    checkout:       checkOut || getDefaultDate(35),
    adults_number:  adults,
    children_number: children,
    room_number:    rooms,
    currency:       'USD',
    locale:         'en-gb',
    order_by:       'popularity',
    filter_by_currency: 'USD',
    include_adjacency: true,
  });

  const response = await fetch(
    `https://distribution-xml.booking.com/json/bookings.getHotels?${searchParams}`,
    { headers: { Authorization: authHeader } }
  );

  if (!response.ok) {
    throw new Error(`Booking.com API error: ${response.status}`);
  }

  const data = await response.json();
  return (data.result || []).map(h => normaliseBookingHotel(h, quiz));
}

// ── Normalise Booking.com hotel to our schema ─────────────────
function normaliseBookingHotel(h, quiz) {
  return {
    id:          `booking-${h.hotel_id}`,
    bookingComId: h.hotel_id,
    name:        h.hotel_name,
    location:    h.address || '',
    city:        h.city    || quiz.destination,
    country:     h.country_trans || '',
    stars:       h.class   || 3,
    coords: {
      lat: h.latitude,
      lng: h.longitude,
    },
    distanceKm:  h.distance ? Math.round(h.distance / 100) / 10 : null,
    amenities:   normaliseBookingAmenities(h.hotel_facilities || []),
    photos: {
      main:   { url: h.main_photo_url, label: 'Hotel', bg: '#C4D8B8', color: '#3a5a2a' },
      thumb1: { url: null, label: 'Room',  bg: '#B4C8D8', color: '#1a3a5a' },
      thumb2: { url: null, label: 'View',  bg: '#D8C8B4', color: '#5a3a1a' },
    },
    riScore:      h.review_score       || null,
    riConfidence: h.review_nr > 1000   ? 'high' : h.review_nr > 200 ? 'moderate' : 'low',
    totalReviews: h.review_nr          || 0,
    platforms: {
      bookingCom: {
        score:     h.review_score,
        reviews:   h.review_nr,
        price:     h.min_total_price ? Math.round(h.min_total_price / getNights(quiz)) : null,
        flexible:  null,
        flexTerms: null,
      },
    },
    bestPrice:   h.min_total_price ? {
      platform: 'bookingCom',
      price: Math.round(h.min_total_price / getNights(quiz)),
    } : null,
    bestFlex:    null,
    rawReviews:  [],
    matchScore:  null,
    matchReason: null,
    reviews:     null,
  };
}

function normaliseBookingAmenities(facilities) {
  const map = {
    433: 'pool', 2: 'parking', 3: 'restaurant', 4: 'bar',
    8: 'gym', 11: 'spa', 16: 'breakfast', 28: 'beach_access',
    148: 'elevator', 47: 'wheelchair_accessible', 4: 'pet',
  };
  return facilities.map(f => map[f.id]).filter(Boolean);
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
