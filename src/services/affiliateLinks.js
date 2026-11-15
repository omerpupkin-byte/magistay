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
//   TP_LINK_<PLATFORM>    a Travelpayouts link for the platform (used instead of the ids above)
//   AFFILIATE_DISABLE     platforms we are NOT approved for, e.g. "expedia,hotelsCom"

const DEFAULTS = {
  bookingCjLink: 'https://www.anrdoezrs.net/click-101769223-11891539',
  agodaCid:      '1966785',
  expediaAffcid: 'US.DIRECT.PHG.1101l431027.1100l68075',
  expediaAfflid: '1101lDpY8aoX',
};

// ── Which platforms earn for us ───────────────────────────────
// A booking button is shown only for a platform whose clicks are
// credited to us. Three ways a platform can be "ours":
//   - our own affiliate id for it (the variables above),
//   - a Travelpayouts link for it (TP_LINK_<PLATFORM>): generate any
//     link for that brand in Travelpayouts and paste it; the hotel's
//     page is put into it as the destination,
//   - neither, or listed in AFFILIATE_DISABLE: no button. Its price is
//     still shown, as information, without a link.
export const ALL_PLATFORMS = ['bookingCom', 'agoda', 'expedia', 'hotelsCom', 'tripCom'];

const TP_ENV = { bookingCom: 'TP_LINK_BOOKINGCOM', agoda: 'TP_LINK_AGODA', expedia: 'TP_LINK_EXPEDIA',
                 hotelsCom: 'TP_LINK_HOTELSCOM', tripCom: 'TP_LINK_TRIPCOM' };

function tpLink(platform) {
  try {
    const u = new URL(String(process.env[TP_ENV[platform]] || '').trim());
    return u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

function disabledPlatforms() {
  return new Set(String(process.env.AFFILIATE_DISABLE || '').split(',').map(x => x.trim()).filter(Boolean));
}

// Our own ids for a platform. Empty when the platform goes through
// Travelpayouts instead (two trackers on one click would fight).
function ids(platform) {
  const own = (p) => !tpLink(p);
  const expGroup = platform === 'hotelsCom' ? own('hotelsCom') : own('expedia');
  return {
    bookingCjLink: own('bookingCom') ? (process.env.BOOKING_CJ_LINK      || DEFAULTS.bookingCjLink) : '',
    bookingAid:    own('bookingCom') ? (process.env.BOOKING_AFFILIATE_ID || '') : '',
    agodaCid:      own('agoda')      ? (process.env.AGODA_AFFILIATE_ID   || DEFAULTS.agodaCid) : '',
    expediaAffcid: expGroup ? (process.env.EXPEDIA_AFFCID || process.env.EXPEDIA_AFFILIATE_ID || DEFAULTS.expediaAffcid) : '',
    expediaAfflid: expGroup ? (process.env.EXPEDIA_AFFLID || DEFAULTS.expediaAfflid) : '',
  };
}

// What each platform runs on right now. The ids are public (they are in
// every link); listed so they can be compared with the affiliate accounts.
export function platformStatus() {
  const off = disabledPlatforms();
  const out = {};
  for (const p of ALL_PLATFORMS) {
    if (off.has(p)) { out[p] = { bookable: false, via: 'disabled' }; continue; }
    const tp = tpLink(p);
    if (tp) { out[p] = { bookable: true, via: 'travelpayouts', id: tp.searchParams.get('marker') || tp.hostname }; continue; }
    const i = ids(p);
    if (p === 'bookingCom') {
      out[p] = i.bookingAid ? { bookable: true, via: 'booking aid', id: i.bookingAid }
        : i.bookingCjLink ? { bookable: true, via: 'cj', id: (i.bookingCjLink.match(/click-[\d-]+/) || [i.bookingCjLink])[0], builtInDefault: !process.env.BOOKING_CJ_LINK }
        : { bookable: false, via: 'none' };
    } else if (p === 'agoda') {
      out[p] = i.agodaCid ? { bookable: true, via: 'agoda cid', id: i.agodaCid, builtInDefault: !process.env.AGODA_AFFILIATE_ID } : { bookable: false, via: 'none' };
    } else if (p === 'expedia' || p === 'hotelsCom') {
      out[p] = i.expediaAffcid ? { bookable: true, via: 'expedia affcid', id: i.expediaAfflid || i.expediaAffcid,
        builtInDefault: !(process.env.EXPEDIA_AFFCID || process.env.EXPEDIA_AFFILIATE_ID) } : { bookable: false, via: 'none' };
    } else {
      out[p] = { bookable: false, via: 'none' };      // Travelpayouts only
    }
  }
  return out;
}

export function isBookable(platform) { return !!platformStatus()[platform]?.bookable; }
export function bookablePlatforms()  { const st = platformStatus(); return ALL_PLATFORMS.filter(p => st[p].bookable); }

// Through Travelpayouts when that is how the platform is ours.
function finalize(platform, url) {
  const tp = url && tpLink(platform);
  if (!tp) return url;
  const out = new URL(tp);
  out.searchParams.set('u', url);
  return String(out);
}

// ── Public: all links for one hotel ───────────────────────────
export function buildAllAffiliateLinks(hotel, quiz = {}) {
  const trip = tripParams(quiz);
  const ours = new Set(bookablePlatforms());
  const link = (platform, build) => (ours.has(platform) ? { [platform]: finalize(platform, build(hotel, trip)) } : {});
  return {
    ...link('bookingCom', buildBookingLink),
    ...link('agoda',      buildAgodaLink),
    ...link('expedia',    buildExpediaLink),
    ...link('hotelsCom',  buildHotelsComLink),
    // Trip.com has no search link here: it gets a button only with the hotel's own page.
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
  const { bookingCjLink, bookingAid } = ids('bookingCom');
  const params = new URLSearchParams({
    ss:           searchText(hotel),
    checkin:      trip.checkIn,
    checkout:     trip.checkOut,
    group_adults: String(trip.adults),
    no_rooms:     String(trip.rooms),
    group_children: String(trip.ages.length),
  });
  for (const age of trip.ages) params.append('age', String(age));
  if (hotel.currency) params.set('selected_currency', hotel.currency);   // same currency as the price we show
  if (bookingAid) params.set('aid', bookingAid);

  const destination = `https://www.booking.com/searchresults.html?${params}`;
  if (bookingAid || !bookingCjLink) return destination;

  // CJ deep link: tracking link + ?url=<encoded landing page>
  const sep = bookingCjLink.includes('?') ? '&' : '?';
  return `${bookingCjLink}${sep}url=${encodeURIComponent(destination)}`;
}

// ── Agoda ─────────────────────────────────────────────────────
function buildAgodaLink(hotel, trip) {
  const { agodaCid } = ids('agoda');
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
  if (hotel.currency) params.set('currency', hotel.currency);
  if (agodaCid) params.set('cid', agodaCid);
  return `https://www.agoda.com/search?${params}`;
}

// ── Expedia / Hotels.com (same Expedia Group affiliate ids) ───
function expediaGroupParams(hotel, trip, platform) {
  const { expediaAffcid, expediaAfflid } = ids(platform);
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
  return `https://www.expedia.com/Hotel-Search?${expediaGroupParams(hotel, trip, 'expedia')}`;
}

function buildHotelsComLink(hotel, trip) {
  return `https://www.hotels.com/Hotel-Search?${expediaGroupParams(hotel, trip, 'hotelsCom')}`;
}

// ── Direct links to the hotel's own page on each platform ─────
// Google Hotels' price list carries, for every seller, the address of
// the hotel's page on that seller's site. We take only the hotel's
// identity from it (page path or hotel id), drop all of Google's and the
// seller's tracking, and build OUR link: our affiliate id, the
// traveller's dates and guests.
//
// Returns null whenever the address is not clearly a hotel page on the
// expected site; the caller then keeps the search link.
export function buildDirectLink(platform, sellerLink, quiz = {}, currency = '') {
  if (!isBookable(platform)) return null;
  const dest = sellerDestination(sellerLink);
  if (!dest) return null;
  const trip = tripParams(quiz);
  try {
    if (platform === 'bookingCom') return finalize(platform, directBooking(dest, trip, currency));
    if (platform === 'agoda')      return finalize(platform, directAgoda(dest, trip, currency));
    if (platform === 'expedia')    return finalize(platform, directExpediaGroup(dest, trip, 'expedia.com'));
    if (platform === 'hotelsCom')  return finalize(platform, directExpediaGroup(dest, trip, 'hotels.com'));
    if (platform === 'tripCom')    return finalize(platform, directTripCom(dest));
  } catch { /* fall through */ }
  return null;
}

// Trip.com: Google's link already opens the hotel for these dates and
// guests. Keep the page and its trip details; drop every tracking and
// affiliate parameter so the click is credited through our own link.
const TRACKING_PARAM = /^(utm_|gclid|gad_|gbraid|wbraid|msclkid|fbclid|allianceid$|sid$|ouid$|sub\d*$|label$|aid$|cid$|tag$|affcid$|afflid$|ref|source$|campaign|medium$|click|trace|token|locale$|promo|channel)/i;
function directTripCom(dest) {
  if (dest.protocol !== 'https:' || !/(^|\.)trip\.com$/i.test(dest.hostname)) return null;
  if (!/hotel/i.test(dest.pathname)) return null;
  const url = new URL(`https://www.trip.com${dest.pathname}`);
  for (const [k, v] of dest.searchParams) if (!TRACKING_PARAM.test(k)) url.searchParams.append(k, v);
  return String(url);
}

// Where a seller link leads, without its query: for diagnostics only.
export function describeSellerLink(link) {
  const dest = sellerDestination(link);
  if (!dest) return 'no destination in link';
  // Parameter names only (never their values): enough to see how the site identifies the hotel.
  const names = [...new Set([...dest.searchParams.keys()])].slice(0, 25).join(',');
  return dest.hostname + dest.pathname + (names ? ` [${names}]` : '');
}

// The seller's page is the `pcurl` parameter of Google's click link.
function sellerDestination(link) {
  try {
    const outer = new URL(link);
    const inner = outer.searchParams.get('pcurl') || (outer.hostname.endsWith('google.com') ? null : link);
    return inner ? new URL(inner) : null;
  } catch { return null; }
}

// expedia.com, www.expedia.ca, expedia.co.uk, ca.hotels.com ... but not expedia.evil.com
function onBrandSite(url, brand) {
  if (url.protocol !== 'https:') return false;
  const tld = '(com|ca|de|es|fr|it|nl|ie|at|ch|se|no|dk|fi|be|mx|jp|co\\.[a-z]{2}|com\\.[a-z]{2})';
  return new RegExp(`^([a-z]{2,3}\\.|www\\.)?${brand}\\.${tld}$`, 'i').test(url.hostname);
}

function onSite(url, domain) {
  return url.protocol === 'https:' && (url.hostname === domain || url.hostname.endsWith('.' + domain));
}

function directBooking(dest, trip, currency) {
  if (!onSite(dest, 'booking.com')) return null;
  const { bookingCjLink, bookingAid } = ids('bookingCom');
  const params = new URLSearchParams();
  let path;

  // a) The hotel's own page: /hotel/es/some-hotel.html (optionally .en-gb.html)
  const page = dest.pathname.match(/^\/hotel\/([a-z]{2})\/([a-z0-9-]+)(?:\.[a-z-]+)?\.html$/i);
  if (page) {
    path = `/hotel/${page[1].toLowerCase()}/${page[2]}.html`;
  } else if (/^\/searchresults(?:\.[a-z-]+)?\.html$/i.test(dest.pathname)) {
    // b) Search results with this one hotel pinned on top. That is how
    //    Google sends people to Booking.com; keep only what identifies
    //    the hotel, none of the tracking.
    const q = dest.searchParams;
    const hotelId = [q.get('highlighted_hotels'), q.get('hotel_id'), q.get('hotelid')].find(v => /^\d{2,12}$/.test(v || ''));
    const isHotelDest = q.get('dest_type') === 'hotel' && /^-?\d{1,12}$/.test(q.get('dest_id') || '');
    if (!hotelId && !isHotelDest) return null;
    path = '/searchresults.html';
    if (hotelId) params.set('highlighted_hotels', hotelId);
    if (/^-?\d{1,12}$/.test(q.get('dest_id') || '') && /^[a-z]{3,10}$/.test(q.get('dest_type') || '')) {
      params.set('dest_id', q.get('dest_id')); params.set('dest_type', q.get('dest_type'));
    } else if (hotelId) {
      params.set('dest_id', hotelId); params.set('dest_type', 'hotel');
    }
  } else {
    return null;
  }

  params.set('checkin', trip.checkIn); params.set('checkout', trip.checkOut);
  params.set('group_adults', String(trip.adults)); params.set('no_rooms', String(trip.rooms));
  params.set('group_children', String(trip.ages.length));
  for (const age of trip.ages) params.append('age', String(age));
  if (currency) params.set('selected_currency', currency);
  if (bookingAid) params.set('aid', bookingAid);
  const target = `https://www.booking.com${path}?${params}`;
  if (bookingAid || !bookingCjLink) return target;
  const sep = bookingCjLink.includes('?') ? '&' : '?';
  return `${bookingCjLink}${sep}url=${encodeURIComponent(target)}`;
}

function directAgoda(dest, trip, currency) {
  if (!onSite(dest, 'agoda.com')) return null;
  const { agodaCid } = ids('agoda');
  const hid = ['hid', 'hotel_id', 'hotelid', 'selectedproperty']
    .map(k => dest.searchParams.get(k)).find(v => /^\d{2,12}$/.test(v || ''));
  const common = { checkin: trip.checkIn, checkout: trip.checkOut, los: String(trip.nights),
                   adults: String(trip.adults), rooms: String(trip.rooms), children: String(trip.ages.length) };
  let url;
  if (hid) {
    url = new URL('https://www.agoda.com/partners/partnersearch.aspx');
    // Dates and guests are sent twice: in the documented affiliate form
    // (checkin, los, adults...) and in the form Agoda's own price links
    // use on this same page (CkInDay, NumberOfAdults...).
    const [iy, im, id] = trip.checkIn.split('-').map(Number);
    const [oy, om, od] = trip.checkOut.split('-').map(Number);
    url.search = String(new URLSearchParams({ pcs: '1', hid, ...common,
      CkInDay: String(id), CkInMonth: String(im), CkInYear: String(iy),
      CkOutDay: String(od), CkOutMonth: String(om), CkOutYear: String(oy),
      NumberOfAdults: String(trip.adults), NumberOfChildren: String(trip.ages.length), NumberOfRooms: String(trip.rooms),
      ...(currency ? { PartnerCurrency: currency } : {}) }));
  } else if (/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/hotel\/[a-z0-9-]+\.html$/i.test(dest.pathname)) {
    url = new URL(`https://www.agoda.com${dest.pathname}`);
    url.search = String(new URLSearchParams({ ...common, checkIn: trip.checkIn }));
  } else {
    return null;
  }
  if (trip.ages.length) url.searchParams.set('childages', trip.ages.join(','));
  if (currency) url.searchParams.set('currency', currency);
  if (agodaCid) url.searchParams.set('cid', agodaCid);
  return String(url);
}

function directExpediaGroup(dest, trip, domain) {
  // Google may hand out a regional site (expedia.ca, ca.hotels.com); hotel
  // ids are the same everywhere, so the link is rebuilt on the .com site.
  if (!onBrandSite(dest, domain.split('.')[0])) return null;
  const { expediaAffcid, expediaAfflid } = ids(domain === 'hotels.com' ? 'hotelsCom' : 'expedia');
  const selected = dest.searchParams.get('selected');
  let url;
  if (/^\d{2,12}$/.test(selected || '')) {
    // .../Hotel-Search?selected=<hotel id> opens the search with this hotel pinned first.
    url = new URL(`https://www.${domain}/Hotel-Search`);
    url.search = String(new URLSearchParams({
      selected, startDate: trip.checkIn, endDate: trip.checkOut,
      adults: String(trip.adults), rooms: String(trip.rooms),
    }));
  } else if (/\.h\d+\.Hotel-Information$/i.test(dest.pathname)) {
    url = new URL(`https://www.${domain}${dest.pathname}`);
    url.search = String(new URLSearchParams({ chkin: trip.checkIn, chkout: trip.checkOut, rm1: `a${trip.adults}` }));
  } else {
    return null;
  }
  if (expediaAffcid) url.searchParams.set('affcid', expediaAffcid);
  if (expediaAfflid) { url.searchParams.set('afflid', expediaAfflid); url.searchParams.set('ref_id', expediaAfflid); }
  return String(url);
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
