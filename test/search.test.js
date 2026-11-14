// Run with: npm test
// Exercises the search pipeline with Hotelbeds replaced by canned
// responses shaped like the documented API, so no keys or network are needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAllAffiliateLinks, buildDirectLink } from '../src/services/affiliateLinks.js';
import { buildOccupancies, buildSearchBody, searchRadiusKm, analyseRates, normaliseHotel, parseContent, amenitiesFromFacilities, searchHotelbeds } from '../src/services/hotelbedsAPI.js';
import { baselineScore, buildMatchPrompt, matchHotelsWithAI } from '../src/services/aiMatcher.js';
import { listNeeds, checkNeed } from '../src/services/travellerProfile.js';
import { validateQuiz } from '../src/utils/validateQuiz.js';

const quiz = validateQuiz({
  adults: 2, infants: 1, rooms: 1, destination: 'Barcelona',
  checkIn: '2027-07-15', checkOut: '2027-07-20', budget: '$150 – $250',
  purpose: ['Family holiday'],
  priorities: ['Breakfast included', 'Pool', 'Free cancellation', 'Walkable location'],
  specialNeeds: { babies: ['Crib / cot available', 'Highchair in restaurant'] },
}).quiz;
const coords = { lat: 41.3851, lng: 2.1734, city: 'Barcelona', country: 'ES', spanKm: 22 };

// ── Affiliate links ───────────────────────────────────────────
test('every tracked link carries our affiliate id and the trip details', () => {
  const links = buildAllAffiliateLinks({ name: 'Hotel Arts Barcelona', city: 'Barcelona' }, quiz);

  const booking = new URL(links.bookingCom);
  assert.equal(booking.origin + booking.pathname, 'https://www.anrdoezrs.net/click-101769223-11891539');
  const landing = new URL(booking.searchParams.get('url'));
  assert.equal(landing.hostname, 'www.booking.com');
  assert.equal(landing.searchParams.get('ss'), 'Hotel Arts Barcelona');
  assert.equal(landing.searchParams.get('checkin'), '2027-07-15');
  assert.equal(landing.searchParams.get('checkout'), '2027-07-20');
  assert.equal(landing.searchParams.get('group_adults'), '2');
  assert.deepEqual(landing.searchParams.getAll('age'), ['1']);

  const agoda = new URL(links.agoda);
  assert.equal(agoda.searchParams.get('cid'), '1966785');
  assert.equal(agoda.searchParams.get('los'), '5');
  assert.equal(agoda.searchParams.get('checkIn'), '2027-07-15');

  for (const key of ['expedia', 'hotelsCom']) {
    const u = new URL(links[key]);
    assert.equal(u.searchParams.get('affcid'), 'US.DIRECT.PHG.1101l431027.1100l68075');
    assert.equal(u.searchParams.get('afflid'), '1101lDpY8aoX');
    assert.equal(u.searchParams.get('startDate'), '2027-07-15');
  }
});

test('hotel name gets the city appended when it is not already in the name', () => {
  const links = buildAllAffiliateLinks({ name: 'Petit Palace Boquería Garden', city: 'Barcelona' }, quiz);
  assert.equal(new URL(new URL(links.bookingCom).searchParams.get('url')).searchParams.get('ss'), 'Petit Palace Boquería Garden, Barcelona');
});

// ── Hotelbeds request ─────────────────────────────────────────
test('occupancies: children get ages, travellers are spread over rooms', () => {
  assert.deepEqual(buildOccupancies({ adults: 2, infants: 1, rooms: 1 }), [
    { rooms: 1, adults: 2, children: 1, paxes: [{ type: 'AD' }, { type: 'AD' }, { type: 'CH', age: 1 }] },
  ]);
  const two = buildOccupancies({ adults: 4, children: 2, rooms: 2, childAges: [5, 9] });
  assert.equal(two.reduce((n, o) => n + o.rooms, 0), 2);
  assert.equal(two.reduce((n, o) => n + o.rooms * o.adults, 0), 4);
  assert.equal(two.reduce((n, o) => n + o.rooms * o.children, 0), 2);
  for (const o of two) assert.equal(o.paxes.filter(p => p.type === 'CH').length, o.children);
  const uneven = buildOccupancies({ adults: 3, rooms: 2 });
  assert.equal(uneven.reduce((n, o) => n + o.rooms * o.adults, 0), 3);
});

test('radius: city keeps the chosen radius, an island widens it', () => {
  assert.equal(searchRadiusKm({ radiusKm: 5 }, { spanKm: 22 }), 5);
  assert.equal(searchRadiusKm({ radiusKm: 5 }, { spanKm: 260 }), 100);   // Crete, capped
  assert.equal(searchRadiusKm({ radiusKm: 5 }, { spanKm: 60 }), 30);
});

test('request body sends no per-night budget as a total-stay filter', () => {
  const body = buildSearchBody(quiz, coords, { reviews: true });
  assert.equal(body.filter.minRate, undefined);
  assert.equal(body.filter.maxRate, undefined);
  assert.equal(body.reviews[0].type, 'TRIPADVISOR');
  assert.equal(body.geolocation.radius, 10);
});

// ── Hotelbeds response ────────────────────────────────────────
const future = new Date(Date.now() + 20 * 86_400_000).toISOString();
const RAW = {
  code: 65041, name: 'Petit Palace Boquería Garden', categoryCode: '4EST', categoryName: '4 STARS',
  destinationName: 'Barcelona', zoneName: 'Las Ramblas', latitude: '41.381384', longitude: '2.173917',
  minRate: '900.00', currency: 'EUR',
  reviews: [{ rate: 4.5, reviewCount: 2310, type: 'TRIPADVISOR' }],
  rooms: [{ code: 'DBL.ST', name: 'DOUBLE STANDARD', rates: [
    { net: '900.00',  boardCode: 'RO', boardName: 'ROOM ONLY',         rateClass: 'NRF', cancellationPolicies: [{ amount: '900.00', from: new Date().toISOString() }] },
    { net: '1000.00', boardCode: 'RO', boardName: 'ROOM ONLY',         rateClass: 'NOR', cancellationPolicies: [{ amount: '200.00', from: future }] },
    { net: '1100.00', boardCode: 'BB', boardName: 'BED AND BREAKFAST', rateClass: 'NOR', cancellationPolicies: [{ amount: '220.00', from: future }] },
  ] }],
};
const CONTENT = {
  code: 65041, countryCode: 'ES',
  description: { content: 'Set in a 19th-century building with a garden terrace.' },
  address: { content: 'CALLE BOQUERIA 10' },
  facilities: [
    { facilityCode: 295, facilityGroupCode: 70, description: { content: 'Lift access' } },
    { facilityCode: 261, facilityGroupCode: 70, description: { content: 'Wi-fi' } },
    { facilityCode: 264, facilityGroupCode: 60, description: { content: 'Cot on demand' } },
    { facilityCode: 200, facilityGroupCode: 71, description: { content: 'Restaurant' } },
    { facilityCode: 999, facilityGroupCode: 70, description: { content: 'Outdoor swimming pool' }, indYesOrNo: false },
  ],
  images: [
    { imageTypeCode: 'HAB', path: '06/065041/065041a_hb_ro_003.jpg', visualOrder: 2, type: { code: 'HAB', description: { content: 'Room' } } },
    { imageTypeCode: 'GEN', path: '06/065041/065041a_hb_a_001.jpg',  visualOrder: 1, type: { code: 'GEN', description: { content: 'General view' } } },
  ],
};

test('rates: cheapest, refundable and breakfast prices are per night', () => {
  const r = analyseRates(RAW, 5);
  assert.equal(r.cheapest, 180);
  assert.equal(r.flexible, 200);
  assert.equal(r.breakfast, 220);
  assert.match(r.flexTerms, /^Free cancellation until \d{4}-\d{2}-\d{2}$/);
});

test('normalised hotel: real rating on a 10 scale, distance, currency, no invented fields', () => {
  const h = normaliseHotel(RAW, quiz, coords);
  assert.equal(h.riScore, 9);
  assert.equal(h.totalReviews, 2310);
  assert.equal(h.ratingSource, 'TripAdvisor');
  assert.equal(h.stars, 4);
  assert.equal(h.currency, 'EUR');
  assert.equal(h.priceType, 'indicative');
  assert.ok(h.distanceKm < 1);
  assert.equal(h.photos.main.url, undefined);            // no photo until content says so

  const noReview = normaliseHotel({ ...RAW, reviews: undefined }, quiz, coords);
  assert.equal(noReview.riScore, null);
  assert.equal(noReview.totalReviews, 0);
});

test('content: photos, facilities and amenities; facilities marked "no" are dropped', () => {
  const c = parseContent(CONTENT);
  assert.equal(c.images[0].url, 'https://photos.hotelbeds.com/giata/bigger/06/065041/065041a_hb_a_001.jpg');
  assert.deepEqual(c.facilities, ['Lift access', 'Wi-fi', 'Cot on demand', 'Restaurant']);
  assert.deepEqual(amenitiesFromFacilities(c.facilities).sort(), ['crib', 'elevator', 'restaurant', 'wifi']);
});

// ── End-to-end with a stubbed Hotelbeds ───────────────────────
function stubFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    for (const [pattern, reply] of handlers) {
      if (pattern.test(String(url))) {
        const r = typeof reply === 'function' ? reply(calls.length, init) : reply;
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json || r.text || '') };
      }
    }
    throw new Error('unexpected fetch ' + url);
  };
  return calls;
}

test('searchHotelbeds: availability + content merge into one hotel', async () => {
  process.env.HOTELBEDS_API_KEY = 'k'; process.env.HOTELBEDS_API_SECRET = 's';
  const calls = stubFetch([
    [/hotel-api\/1\.0\/hotels$/, { json: { hotels: { hotels: [RAW] } } }],
    [/hotel-content-api\/1\.0\/hotels\/65041\/details/, { json: { hotels: [CONTENT] } }],
  ]);
  const hotels = await searchHotelbeds({ ...quiz, coords });
  assert.equal(hotels.length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/api\.test\.hotelbeds\.com/);
  const h = hotels[0];
  assert.match(h.photos.main.url, /065041a_hb_a_001\.jpg$/);
  assert.match(h.photos.thumb1.url, /065041a_hb_ro_003\.jpg$/);
  assert.ok(h.amenities.includes('crib'));
  assert.equal(h.gallery.length, 2);
});

test('searchHotelbeds: content failure keeps the results; empty result retries simplified', async () => {
  let calls = stubFetch([
    [/hotel-api\/1\.0\/hotels$/, { json: { hotels: { hotels: [{ ...RAW, code: 777 }] } } }],
    [/hotel-content-api/, { status: 500, json: { error: 'boom' } }],
  ]);
  let hotels = await searchHotelbeds({ ...quiz, coords });
  assert.equal(hotels.length, 1);
  assert.deepEqual(hotels[0].amenities, []);

  calls = stubFetch([
    [/hotel-api\/1\.0\/hotels$/, n => ({ json: { hotels: { hotels: n === 1 ? [] : [{ ...RAW, code: 778 }] } } })],
    [/hotel-content-api/, { json: { hotels: [] } }],
  ]);
  hotels = await searchHotelbeds({ ...quiz, coords });
  assert.equal(hotels.length, 1);
  assert.ok(calls[0].body.reviews);
  assert.equal(calls[1].body.reviews, undefined);
});

// ── Matching ──────────────────────────────────────────────────
test('needs checklist: confirmed only by data, otherwise unknown', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  stubFetch([
    [/hotel-api\/1\.0\/hotels$/, { json: { hotels: { hotels: [{ ...RAW, code: 901 }] } } }],
    [/hotel-content-api/, { json: { hotels: [{ ...CONTENT, code: 901 }] } }],
  ]);
  const [hotel] = await searchHotelbeds({ ...quiz, coords });
  assert.deepEqual(listNeeds(quiz), ['Breakfast included', 'Pool', 'Free cancellation', 'Walkable location', 'Crib / cot available', 'Highchair in restaurant']);

  const [m] = await matchHotelsWithAI(quiz, [hotel]);
  const status = Object.fromEntries(m.needsCheck.map(n => [n.need, n.status]));
  assert.equal(status['Breakfast included'], 'yes');        // a breakfast rate exists
  assert.equal(status['Free cancellation'], 'yes');         // a refundable rate exists
  assert.equal(status['Crib / cot available'], 'yes');      // "Cot on demand"
  assert.equal(status['Walkable location'], 'yes');         // 0.4 km
  assert.equal(status['Pool'], 'unknown');                  // pool was marked "no" → not confirmed
  assert.equal(status['Highchair in restaurant'], 'unknown');
  assert.equal(m.matchedBy, 'rules');
  assert.ok(!/Pool/.test(m.matchReason.split('Check with the hotel')[0]));
});

test('children\'s pool is not confirmed by an ordinary pool; wifi speed is never confirmed', () => {
  const hotel = { amenities: ['pool', 'wifi'], facilities: ['Outdoor swimming pool', 'Wi-fi'] };
  assert.equal(checkNeed("Children's pool", hotel).status, 'unknown');
  assert.equal(checkNeed('Pool', hotel).status, 'yes');
  assert.equal(checkNeed('Fast Wi-Fi (100+ Mbps)', hotel).status, 'unknown');
});

test('match prompt carries the brief and forbids guessing', () => {
  const h = baselineScore(quiz, normaliseHotel(RAW, quiz, coords));
  const prompt = buildMatchPrompt(quiz, [h]);
  assert.match(prompt, /Trip purpose: Family holiday/);
  assert.match(prompt, /1 infant/);
  assert.match(prompt, /Budget: \$150–250 per night/);
  assert.match(prompt, /9\/10 from 2310 reviews \(TripAdvisor\)/);
  assert.match(prompt, /from 180 EUR\/night \(indicative\)/);
  assert.match(prompt, /Never guess "yes"/);
});

test('breakfast is "included" only when a breakfast rate exists; thin ratings earn no bonus', () => {
  const served = { amenities: ['breakfast'], facilities: ['Breakfast room'] };
  assert.equal(checkNeed('Breakfast included', served).status, 'unknown');
  assert.equal(checkNeed('Breakfast included', { ...served, breakfastPrice: 120 }).status, 'yes');

  const q = { ...quiz, priorities: [], specialNeeds: {}, infants: 0 };
  const few  = baselineScore(q, { riScore: 10, totalReviews: 3,   amenities: [] });
  const many = baselineScore(q, { riScore: 9.4, totalReviews: 900, amenities: [] });
  assert.ok(many.matchScore > few.matchScore);
});

// ── Live prices (Google Hotels via SerpApi) ───────────────────
import { addLivePrices, pickBookable, parseOffers, sameHotel, nameSimilarity, applyLivePrices, _clearLivePriceCache } from '../src/services/livePrices.js';

const rate = (night, total, taxes = true) => ({
  rate_per_night: taxes ? { extracted_lowest: night, extracted_before_taxes_fees: night - 20, extracted_after_taxes_fees: night } : { extracted_lowest: night },
  total_rate:     { extracted_lowest: total },
});
const googleArts = {
  type: 'hotel', name: 'Hotel Arts Barcelona, a Ritz-Carlton Hotel',
  gps_coordinates: { latitude: 41.3869, longitude: 2.1962 },
  prices: [
    { source: 'Super.com',   ...rate(390, 1950) },
    { source: 'Booking.com', ...rate(420, 2100), free_cancellation: true, free_cancellation_until_date: 'Jul 10' },
    { source: 'Agoda',       ...rate(405, 2025) },
    { source: 'Hotels.com',  ...rate(431, 2155, false) },
    { source: 'Hotel Arts Barcelona', official: true, ...rate(450, 2250) },
  ],
};
const arts = {
  id: 'hotelbeds-1', name: 'Hotel Arts Barcelona', city: 'Barcelona', coords: { lat: 41.3868, lng: 2.1961 },
  currency: 'EUR', priceType: 'indicative', platforms: { hotelbeds: { price: 380 } },
  bestPrice: { platform: 'hotelbeds', price: 380 }, bestFlex: null, breakfastPrice: 410,
};

test('same hotel: position decides, the name confirms', () => {
  assert.ok(sameHotel(arts, googleArts));
  assert.ok(!sameHotel(arts, { name: 'W Barcelona', gps_coordinates: { latitude: 41.3869, longitude: 2.1962 } }), 'same spot, different name');
  assert.ok(!sameHotel(arts, { name: 'Hotel Arts Barcelona', gps_coordinates: { latitude: 41.40, longitude: 2.15 } }), 'same name, 4 km away');
  assert.ok(!sameHotel({ name: 'Hotel Arts', city: 'Barcelona', coords: null }, { name: 'Arts Garden Suites Deluxe' }), 'no position: a partial name is not enough');
  assert.ok(sameHotel({ name: 'Hotel Arts Barcelona', city: 'Barcelona', coords: null }, { name: 'Arts Hotel Barcelona' }), 'no position: same words is enough');
  assert.ok(sameHotel({ name: 'Hotel Barcelona', city: 'Barcelona', coords: { lat: 41.38, lng: 2.17 } }, { name: 'Barcelona Hotel', gps_coordinates: { latitude: 41.38, longitude: 2.17 } }));
  assert.equal(nameSimilarity('Hôtel Café Royal & Spa', 'Cafe Royal Hotel'), 1);
});

test('offers: per night with taxes, mapped to our platforms, cheapest first', () => {
  const offers = parseOffers(googleArts.prices);
  assert.deepEqual(offers.map(o => o.seller), ['Super.com', 'Agoda', 'Booking.com', 'Hotels.com', 'Hotel Arts Barcelona']);
  assert.deepEqual(offers.map(o => o.platform), [null, 'agoda', 'bookingCom', 'hotelsCom', null]);
  assert.equal(offers[3].taxesIncluded, false);
  assert.equal(offers[2].cancelUntil, 'Jul 10');
});

test('live prices replace the indicative price and keep our links', async () => {
  process.env.SERPAPI_KEY = 'test';
  _clearLivePriceCache();
  const calls = [];
  const fetchJson = async (params) => { calls.push(params); return googleArts; };
  const withLinks = { ...arts, affiliateLinks: buildAllAffiliateLinks(arts, quiz) };

  const [h] = await addLivePrices([withLinks], quiz, { fetchJson });
  assert.equal(h.priceType, 'live');
  assert.deepEqual(h.bestPrice, { platform: 'agoda', price: 405, total: 2025 });
  assert.equal(h.bestFlex.platform, 'bookingCom');
  assert.equal(h.platforms.bookingCom.price, 420);
  assert.equal(h.platforms.expedia, undefined, 'no Expedia price on Google → none shown');
  assert.equal(h.platforms.hotelbeds.price, 380, 'supplier rate kept');
  assert.deepEqual(h.livePrices.cheaperElsewhere, { seller: 'Super.com', price: 390, official: false });
  assert.equal(h.breakfastPrice, null);
  const agodaLink = new URL(h.affiliateLinks.agoda);
  assert.equal(agodaLink.pathname, '/search', 'no hotel page known: still a search link');
  assert.equal(agodaLink.searchParams.get('cid'), '1966785', 'with our id');
  assert.equal(agodaLink.searchParams.get('textToSearch'), 'Hotel Arts Barcelona, a Ritz-Carlton Hotel', "under Google's name for the hotel");
  assert.equal(h.platforms.agoda.direct, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].q, 'Hotel Arts Barcelona');
  assert.equal(calls[0].check_in_date, '2027-07-15');
  assert.equal(calls[0].currency, 'EUR');
  assert.equal(calls[0].children_ages, '1', 'the infant is priced as a 1-year-old');

  await addLivePrices([withLinks], quiz, { fetchJson });
  assert.equal(calls.length, 1, 'second identical trip is served from the cache');
  delete process.env.SERPAPI_KEY;
});

test('ambiguous name: pick the matching property from the list, then fetch it', async () => {
  process.env.SERPAPI_KEY = 'test';
  _clearLivePriceCache();
  const calls = [];
  const fetchJson = async (params) => {
    calls.push(params);
    if (params.property_token) return googleArts;
    return { properties: [
      { name: 'Arts Hostel Barcelona', gps_coordinates: { latitude: 41.39, longitude: 2.16 }, property_token: 'WRONG' },
      { name: 'Hotel Arts Barcelona, a Ritz-Carlton Hotel', gps_coordinates: { latitude: 41.3869, longitude: 2.1962 }, property_token: 'RIGHT' },
    ] };
  };
  const [h] = await addLivePrices([arts], quiz, { fetchJson });
  assert.equal(calls[1].property_token, 'RIGHT');
  assert.equal(h.priceType, 'live');
  delete process.env.SERPAPI_KEY;
});

test('live prices never break a search', async () => {
  // No key: untouched, no call.
  delete process.env.SERPAPI_KEY;
  let called = false;
  assert.deepEqual(await addLivePrices([arts], quiz, { fetchJson: async () => { called = true; } }), [arts]);
  assert.equal(called, false);

  process.env.SERPAPI_KEY = 'test';
  _clearLivePriceCache();
  // The source fails: hotel unchanged.
  assert.deepEqual(await addLivePrices([arts], quiz, { fetchJson: async () => { throw new Error('quota'); } }), [arts]);
  // Google returns a different hotel: no price attached.
  const other = { ...googleArts, name: 'W Barcelona' };
  assert.deepEqual(await addLivePrices([arts], quiz, { fetchJson: async () => other }), [arts]);
  // Right hotel, but none of our platforms sells it on these dates.
  _clearLivePriceCache();
  const none = { ...googleArts, prices: [{ source: 'Super.com', ...rate(390, 1950) }] };
  const [h] = await addLivePrices([arts], quiz, { fetchJson: async () => none });
  assert.equal(h.priceType, 'indicative');
  assert.equal(h.livePrices.found, 0);
  assert.deepEqual(applyLivePrices(arts, { matched: false }), arts);
  delete process.env.SERPAPI_KEY;
});

// ── Direct hotel-page links ───────────────────────────────────
const google = (pcurl) => 'https://www.google.com/travel/clk?pc=AAA&pcurl=' + encodeURIComponent(pcurl) + '&ap=1';

test('direct links: the hotel page, our ids, the trip, none of their tracking', () => {
  const b = new URL(buildDirectLink('bookingCom', google('https://www.booking.com/hotel/es/nh-collection-madrid-suecia.en-gb.html?aid=356980&label=metagha-link&checkin=2020-01-01'), quiz, 'EUR'));
  assert.equal(b.hostname, 'www.anrdoezrs.net');
  const page = new URL(b.searchParams.get('url'));
  assert.equal(page.origin + page.pathname, 'https://www.booking.com/hotel/es/nh-collection-madrid-suecia.html');
  assert.equal(page.searchParams.get('checkin'), '2027-07-15');
  assert.equal(page.searchParams.get('selected_currency'), 'EUR');
  assert.equal(page.searchParams.get('aid'), null, 'their affiliate id is dropped');
  assert.equal(page.searchParams.get('label'), null);

  const a = new URL(buildDirectLink('agoda', google('https://www.agoda.com/partners/partnersearch.aspx?cid=1833981&hid=67890&tag=gha'), quiz, 'EUR'));
  assert.equal(a.pathname, '/partners/partnersearch.aspx');
  assert.equal(a.searchParams.get('hid'), '67890');
  assert.equal(a.searchParams.get('cid'), '1966785', 'our cid, not theirs');
  assert.equal(a.searchParams.get('tag'), null);
  assert.equal(a.searchParams.get('los'), '5');

  const h = new URL(buildDirectLink('hotelsCom', google('https://www.hotels.com/Hotel-Search?selected=92220472&startDate=2024-02-06&mdpcid=HCOM-US.META'), quiz));
  assert.equal(h.searchParams.get('selected'), '92220472');
  assert.equal(h.searchParams.get('startDate'), '2027-07-15');
  assert.equal(h.searchParams.get('mdpcid'), null);
  assert.equal(h.searchParams.get('afflid'), '1101lDpY8aoX');

  const e = new URL(buildDirectLink('expedia', google('https://www.expedia.com/Madrid-Hotels-NH-Suecia.h123456.Hotel-Information?mctc=10'), quiz));
  assert.equal(e.pathname, '/Madrid-Hotels-NH-Suecia.h123456.Hotel-Information');
  assert.equal(e.searchParams.get('chkin'), '2027-07-15');
});

test('direct links: anything that is not clearly the hotel page is refused', () => {
  assert.equal(buildDirectLink('bookingCom', 'https://www.google.com/aclk?sa=l&adurl', quiz), null, 'ad link without a destination');
  assert.equal(buildDirectLink('bookingCom', google('https://evil.example/hotel/es/x.html'), quiz), null, 'wrong site');
  assert.equal(buildDirectLink('bookingCom', google('https://www.booking.com/searchresults.html?ss=x'), quiz), null, 'not a hotel page');
  assert.equal(buildDirectLink('agoda', google('https://www.agoda.com/'), quiz), null);
  assert.equal(buildDirectLink('expedia', google('https://www.hotels.com/Hotel-Search?selected=1234'), quiz), null, 'other platform');
  assert.equal(buildDirectLink('agoda', 'not a url', quiz), null);
});

test('a hotel nobody on our platforms sells on these dates is replaced by the next match', async () => {
  process.env.SERPAPI_KEY = 'test';
  _clearLivePriceCache();
  const mk = (n, name) => ({ ...arts, id: 'hotelbeds-' + n, name, affiliateLinks: buildAllAffiliateLinks({ ...arts, name }, quiz) });
  const ranked = [mk(1, 'Alpha Palace'), mk(2, 'Soldout Grand'), mk(3, 'Gamma House'), mk(4, 'Unknown Inn'), mk(5, 'Delta Rooms'), mk(6, 'Soldout Two'), mk(7, 'Reserve Seven'), mk(8, 'Reserve Eight')];
  const asked = [];
  const fetchJson = async (params) => {
    const name = params.q.replace(', Barcelona', '');
    asked.push(name);
    if (name === 'Unknown Inn') throw new Error('timeout');
    const prices = name.startsWith('Soldout') ? [] : [{ source: 'Agoda', link: google('https://www.agoda.com/partners/partnersearch.aspx?hid=555'), ...rate(405, 2025) }];
    return { type: 'hotel', name, gps_coordinates: googleArts.gps_coordinates, prices };
  };

  const out = await pickBookable(ranked, quiz, { show: 5, fetchJson });
  assert.deepEqual(out.map(h => h.name), ['Alpha Palace', 'Gamma House', 'Unknown Inn', 'Delta Rooms', 'Reserve Seven'],
    'sold-out #2 is dropped, sold-out #6 is skipped, #7 fills the place; the unchecked hotel stays');
  assert.equal(out[2].priceType, 'indicative');
  assert.equal(out[0].platforms.agoda.direct, true);
  assert.match(out[0].affiliateLinks.agoda, /partnersearch\.aspx\?.*hid=555.*cid=1966785/);
  assert.ok(!JSON.stringify(out).includes('google.com/travel/clk'), "Google's link never reaches the page");

  // All five bookable: the reserve is never looked up.
  _clearLivePriceCache(); asked.length = 0;
  await pickBookable(ranked.filter(h => !h.name.startsWith('Soldout')), quiz, { show: 5, fetchJson });
  assert.equal(asked.length, 5);

  // Nothing bookable at all: the best matches are still shown.
  _clearLivePriceCache();
  const none = await pickBookable([mk(2, 'Soldout Grand'), mk(6, 'Soldout Two')], quiz, { show: 5, fetchJson });
  assert.deepEqual(none.map(h => h.name), ['Soldout Grand', 'Soldout Two']);

  // No key: just the top five, untouched.
  delete process.env.SERPAPI_KEY;
  assert.deepEqual(await pickBookable(ranked, quiz, { show: 5, fetchJson }), ranked.slice(0, 5));
});

test('the matcher returns as many ranked hotels as asked', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...arts, id: 'h' + i, name: 'Hotel ' + i, amenities: [], facilities: [], needsCheck: [] }));
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await matchHotelsWithAI(quiz, many)).length, 5);
  assert.equal((await matchHotelsWithAI(quiz, many, { limit: 8 })).length, 8);
  assert.equal((await matchHotelsWithAI(quiz, many, { limit: 15 })).length, 12, 'never more than there are');
  assert.match(buildMatchPrompt(quiz, many, 8), /Pick the 8 hotels/);
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
});

test('search links use the name the booking sites know; long reserve is worked through in batches', async () => {
  process.env.SERPAPI_KEY = 'test';
  _clearLivePriceCache();
  const supplier = { ...arts, id: 'hotelbeds-77', name: 'Embassy by Petit Palace anteriormente Icon Embassy', city: 'Madrid' };
  supplier.affiliateLinks = buildAllAffiliateLinks(supplier, quiz);
  const g = { type: 'hotel', name: 'Embassy by Petit Palace', gps_coordinates: googleArts.gps_coordinates,
              prices: [{ source: 'Booking.com', link: 'https://www.google.com/aclk?sa=l', ...rate(380, 1139) }] };
  const report = [];
  const [h] = await addLivePrices([supplier], quiz, { fetchJson: async () => g, report });
  const landing = new URL(new URL(h.affiliateLinks.bookingCom).searchParams.get('url'));
  assert.equal(landing.searchParams.get('ss'), 'Embassy by Petit Palace, Madrid');
  assert.equal(new URL(h.affiliateLinks.hotelsCom).searchParams.get('destination'), 'Embassy by Petit Palace, Madrid');
  assert.equal(report[0].result, 'priced');
  assert.equal(report[0].sellers[0].leadsTo, 'no destination in link');

  // 12 ranked, only #1, #9, #10, #11, #12 bookable: all five are found.
  _clearLivePriceCache();
  const mk = (n, name) => ({ ...arts, id: 'hb-' + n, name });
  const ranked = Array.from({ length: 12 }, (_, i) => mk(i, (i === 0 || i >= 8 ? 'Open ' : 'Soldout ') + 'Hotel' + String.fromCharCode(65 + i)));
  let calls = 0;
  const fetchJson = async (params) => {
    calls++;
    const name = params.q.replace(', Barcelona', '');
    return { type: 'hotel', name, gps_coordinates: googleArts.gps_coordinates, prices: name.startsWith('Soldout') ? [] : [{ source: 'Agoda', ...rate(100, 500) }] };
  };
  const out = await pickBookable(ranked, quiz, { show: 5, fetchJson });
  assert.deepEqual(out.map(x => x.id), ['hb-0', 'hb-8', 'hb-9', 'hb-10', 'hb-11']);
  assert.ok(calls <= 12);

  // The lookup budget is respected.
  _clearLivePriceCache(); calls = 0;
  await pickBookable(ranked, quiz, { show: 5, maxLookups: 7, fetchJson });
  assert.equal(calls, 7);
  delete process.env.SERPAPI_KEY;
});
