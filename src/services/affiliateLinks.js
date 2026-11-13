// ─── services/affiliateLinks.js ────────────────────────────────
// Builds the outbound booking links for every platform.
//
// This is where the money is made: every link a traveller clicks must
// carry OUR affiliate id, otherwise the booking earns nothing.
//
// The ids below are public (they appear in every link we hand out), so
// they are safe to keep in code as defaults. Each can be overridden
// from Railway Variables without a code change.
//
//   BOOKING_CJ_LINK       CJ tracking link for Booking.com
//   BOOKING_AFFILIATE_ID  direct Booking.com aid (used instead of CJ if set)
//   AGODA_AFFILIATE_ID    Agoda cid
//   EXPEDIA_AFFCID / EXPEDIA_AFFLID   Expedia Group affiliate ids

const DEFAULTS = {
  bookingCjLink: 'https://www.anrdoezrs.net/click-101769223-11891539',
  agodaCid:      '1966785',
  expediaAffcid: 'US.DIRECT.PHG.1101l431027.1100l68075',
  expediaAfflid: '1101lDpY8aoX',
};

function ids() {
  return {
    bookingCjLink: process.env.BOOKING_CJ_LINK      || DEFAULTS.bookingCjLink,
    bookingAid:    process.env.BOOKING_AFFILIATE_ID || '',
    agodaCid:      process.env.AGODA_AFFILIATE_ID   || DEFAULTS.agodaCid,
    expediaAffcid: process.env.EXPEDIA_AFFCID || process.env.EXPEDIA_AFFILIATE_ID || DEFAULTS.expediaAffcid,
    expediaAfflid: process.env.EXPEDIA_AFFLID       || DEFAULTS.expediaAfflid,
  };
}

// Platforms where a click is tracked to us (and can earn commission).
export const TRACKED_PLATFORMS = ['bookingCom', 'agoda', 'expedia', 'hotelsCom'];

// ── Public: all links for one hotel ───────────────────────────
export function buildAllAffiliateLinks(hotel, quiz = {}) {
  const trip = tripParams(quiz);
  return {
    bookingCom:  buildBookingLink(hotel, trip),
    agoda:       buildAgodaLink(hotel, trip),
    expedia:     buildExpediaLink(hotel, trip),
    hotelsCom:   buildHotelsComLink(hotel, trip),
    tripAdvisor: buildTripAdvisorLink(hotel),
    kayak:       buildKayakLink(hotel, trip),
  };
}

// ── Trip details shared by every link ─────────────────────────
function tripParams(quiz) {
  const checkIn  = isDate(quiz.checkIn)  ? quiz.checkIn  : defaultDate(30);
  const checkOut = isDate(quiz.checkOut) ? quiz.checkOut : addDays(checkIn, 5);
  const nights   = Math.max(1, Math.round((new Date(checkOut) - new Date(checkIn)) / 86_400_000));
  const children = Math.max(0, Number(quiz.children) || 0);
  const infants  = Math.max(0, Number(quiz.infants)  || 0);
  const ages     = childAges(quiz, children, infants);
  return {
    checkIn, checkOut, nights,
    adults: Math.max(1, Number(quiz.adults) || 2),
    rooms:  Math.max(1, Number(quiz.rooms)  || 1),
    ages,
  };
}

// Ages for every non-adult traveller (platforms need them for pricing).
export function childAges(quiz, children, infants) {
  const given = Array.isArray(quiz.childAges) ? quiz.childAges.map(Number).filter(n => n >= 0 && n <= 17) : [];
  const ages = [];
  for (let i = 0; i < children; i++) ages.push(given[i] ?? 8);
  for (let i = 0; i < infants;  i++) ages.push(1);
  return ages;
}

// "Hotel Name, City" is the most reliable free-text query on every platform.
function searchText(hotel) {
  const name = (hotel.name || '').trim();
  const city = (hotel.city || '').trim();
  if (!city || name.toLowerCase().includes(city.toLowerCase())) return name;
  return `${name}, ${city}`;
}

// ── Booking.com (via CJ deep link) ────────────────────────────
function buildBookingLink(hotel, trip) {
  const { bookingCjLink, bookingAid } = ids();
  const params = new URLSearchParams({
    ss:           searchText(hotel),
    checkin:      trip.checkIn,
    checkout:     trip.checkOut,
    group_adults: String(trip.adults),
    no_rooms:     String(trip.rooms),
    group_children: String(trip.ages.length),
  });
  for (const age of trip.ages) params.append('age', String(age));
  if (bookingAid) params.set('aid', bookingAid);

  const destination = `https://www.booking.com/searchresults.html?${params}`;
  if (bookingAid || !bookingCjLink) return destination;

  // CJ deep link: tracking link + ?url=<encoded landing page>
  const sep = bookingCjLink.includes('?') ? '&' : '?';
  return `${bookingCjLink}${sep}url=${encodeURIComponent(destination)}`;
}

// ── Agoda ─────────────────────────────────────────────────────
function buildAgodaLink(hotel, trip) {
  const { agodaCid } = ids();
  const params = new URLSearchParams({
    textToSearch: searchText(hotel),
    checkIn:  trip.checkIn,
    checkOut: trip.checkOut,
    los:      String(trip.nights),
    rooms:    String(trip.rooms),
    adults:   String(trip.adults),
    children: String(trip.ages.length),
  });
  if (trip.ages.length) params.set('childAges', trip.ages.join(','));
  if (agodaCid) params.set('cid', agodaCid);
  return `https://www.agoda.com/search?${params}`;
}

// ── Expedia / Hotels.com (same Expedia Group affiliate ids) ───
function expediaGroupParams(hotel, trip) {
  const { expediaAffcid, expediaAfflid } = ids();
  const params = new URLSearchParams({
    destination: searchText(hotel),
    startDate:   trip.checkIn,
    endDate:     trip.checkOut,
    adults:      String(trip.adults),
    rooms:       String(trip.rooms),
  });
  if (expediaAffcid) params.set('affcid', expediaAffcid);
  if (expediaAfflid) { params.set('afflid', expediaAfflid); params.set('ref_id', expediaAfflid); }
  return params;
}

function buildExpediaLink(hotel, trip) {
  return `https://www.expedia.com/Hotel-Search?${expediaGroupParams(hotel, trip)}`;
}

function buildHotelsComLink(hotel, trip) {
  return `https://www.hotels.com/Hotel-Search?${expediaGroupParams(hotel, trip)}`;
}

// ── Not tracked (no affiliate programme connected) ────────────
function buildTripAdvisorLink(hotel) {
  return `https://www.tripadvisor.com/Search?${new URLSearchParams({ q: searchText(hotel) })}`;
}

function buildKayakLink(hotel, trip) {
  const place = encodeURIComponent(hotel.city || hotel.name || '');
  return `https://www.kayak.com/hotels/${place}/${trip.checkIn}/${trip.checkOut}/${trip.adults}adults`;
}

// ── Date helpers ──────────────────────────────────────────────
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function defaultDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
