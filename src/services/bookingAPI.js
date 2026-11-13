// ─── services/bookingAPI.js ────────────────────────────────────
// Booking.com Demand API (full hotel search, availability, pricing).
// Requires Booking.com "Managed Affiliate Partner" approval — until then
// this file is dormant. Activate by setting BOOKING_API_KEY/SECRET.
//
// Outbound booking links (the affiliate layer, which works today)
// live in ./affiliateLinks.js.

export { buildAllAffiliateLinks } from './affiliateLinks.js';

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
