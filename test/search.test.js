// Run with: npm test
// Exercises the search pipeline with Hotelbeds replaced by canned
// responses shaped like the documented API, so no keys or network are needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAllAffiliateLinks, buildDirectLink } from '../src/services/affiliateLinks.js';
import { buildOccupancies, buildSearchBody, searchRadiusKm, analyseRates, normaliseHotel, parseContent, amenitiesFromFacilities, searchHotelbeds } from '../src/services/hotelbedsAPI.js';
import { baselineScore, buildMatchPrompt, matchHotelsWithAI, rankByRules } from '../src/services/aiMatcher.js';
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
  assert.match(buildMatchPrompt(quiz, many, 8), /Pick up to 8 hotels/);
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

// ── Google Hotels as the hotel source ─────────────────────────
import { searchGoogleHotels, normaliseProperty } from '../src/services/googleHotelsAPI.js';
import { trackedLink, trackHotelLinks, resolveClick, destinationOf, isAllowedDestination } from '../src/services/clickLinks.js';

const gProp = (over = {}) => ({
  type: 'hotel', name: 'Hotel Uno', description: 'Quiet rooms near the park.', link: 'https://uno.example',
  property_token: 'TOK1', gps_coordinates: { latitude: 40.42, longitude: -3.70 },
  check_in_time: '3:00 PM', check_out_time: '12:00 PM',
  rate_per_night: { extracted_lowest: 187, extracted_before_taxes_fees: 154, extracted_after_taxes_fees: 187 },
  nearby_places: [{ name: 'Gran Via', transportations: [{ type: 'Walking', duration: '5 min' }] }],
  extracted_hotel_class: 4,
  images: [{ thumbnail: 'https://lh3.googleusercontent.com/p/abc=s287-w287-h192-n-k-no-v1', original_image: 'https://lh5.googleusercontent.com/p/abc=s10000' },
           { thumbnail: 'https://t.example/x.jpg', original_image: 'https://cdn.example/full.jpg' }],
  overall_rating: 4.6, reviews: 1550, location_rating: 4.8,
  reviews_breakdown: [{ name: 'Sleep', total_mentioned: 120, positive: 100, negative: 15 }, { name: 'Gym', total_mentioned: 4, positive: 4, negative: 0 }],
  amenities: ['Free Wi-Fi', 'Pool', 'Pet-friendly', 'Free breakfast', 'Air conditioning'],
  excluded_amenities: ['No beach access', 'No airport shuttle'],
  ...over,
});
const madrid = { ...quiz, destination: 'Madrid', coords: { lat: 40.4168, lng: -3.7038, city: 'Madrid', country: 'Spain' } };

test('Google Hotels: a property becomes a hotel the matcher can judge', () => {
  const h = normaliseProperty(gProp(), madrid, 'EUR');
  assert.equal(h.id, 'google-TOK1');
  assert.equal(h.source, 'google_hotels');
  assert.equal(h.stars, 4);
  assert.equal(h.riScore, 9.2, '4.6 of 5 shown as 9.2 of 10');
  assert.equal(h.ratingSource, 'Google');
  assert.deepEqual(h.bestPrice, { platform: 'google', price: 187 });
  assert.equal(h.priceType, 'indicative');
  assert.ok(h.distanceKm < 1);
  assert.ok(['wifi', 'pool', 'pet', 'breakfast', 'air_conditioning'].every(a => h.amenities.includes(a)));
  assert.equal(h.photos.main.url, 'https://lh5.googleusercontent.com/p/abc=s1200', 'page-sized photo, not the 10000px original');
  assert.equal(h.photos.thumb1.url, 'https://cdn.example/full.jpg');
  assert.deepEqual(h.reviewThemes, [{ theme: 'Sleep', mentions: 120, positive: 100, negative: 15 }], 'themes with a handful of mentions are dropped');
  assert.deepEqual(h.nearby, ['Gran Via (5 min walking)']);

  // The checklist reads the listing both ways.
  assert.equal(checkNeed('Pool', h).status, 'yes');
  assert.equal(checkNeed('Beach access', h).status, 'no', 'the listing says there is none');
  assert.equal(checkNeed('Breakfast included', h).status, 'yes');
  assert.equal(checkNeed('Spa', h).status, 'unknown');
  assert.match(buildMatchPrompt(madrid, [baselineScore(madrid, h)]), /Stated as NOT offered: No beach access[\s\S]*Sleep 83% positive of 120 mentions/);
});

test('Google Hotels: search pages through results and keeps only bookable hotels', async () => {
  const calls = [];
  const fetchJson = async (params) => {
    calls.push(params);
    if (!params.next_page_token) return {
      properties: [gProp(), gProp({ name: 'Ad Hotel', property_token: 'AD', sponsored: true }),
                   gProp({ name: 'Sold Out', property_token: 'SO', rate_per_night: undefined }),
                   gProp({ name: 'Flat', property_token: 'VR', type: 'vacation rental' })],
      serpapi_pagination: { next_page_token: 'P2' },
    };
    return { properties: [gProp(), gProp({ name: 'Hotel Dos', property_token: 'TOK2' })] };
  };
  const hotels = await searchGoogleHotels({ ...madrid, stars: 4, budget: '150_250' }, { fetchJson });
  assert.deepEqual(hotels.map(h => h.name), ['Hotel Uno', 'Hotel Dos'], 'no ads, no sold-out, no rentals, no duplicates');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].q, 'Hotels in Madrid');
  assert.equal(calls[0].hotel_class, '4,5');
  assert.equal(calls[0].max_price, '325');
  assert.equal(calls[0].check_in_date, '2027-07-15');
  assert.equal(calls[1].next_page_token, 'P2');
  assert.deepEqual(await searchGoogleHotels({ ...madrid, checkIn: '' }, { fetchJson }), [], 'no dates, no search');
});

test('Google Hotels: prices per site are read by token, links are ours', async () => {
  process.env.SERPAPI_KEY = 'test';
  _clearLivePriceCache();
  const base = normaliseProperty(gProp(), madrid, 'EUR');
  const hotel = { ...base, affiliateLinks: buildAllAffiliateLinks(base, madrid) };
  const calls = [];
  const fetchJson = async (params) => {
    calls.push(params);
    return { type: 'hotel', name: 'A Completely Different Name', gps_coordinates: { latitude: 1, longitude: 1 },
             prices: [{ source: 'Agoda', link: google('https://www.agoda.com/partners/partnersearch.aspx?hid=777'), ...rate(190, 950) }] };
  };
  const [out] = await pickBookable([hotel], madrid, { show: 5, fetchJson });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].property_token, 'TOK1', 'asked for by token');
  assert.equal(out.priceType, 'live', 'the token is the identity: no name or position check');
  assert.deepEqual(out.bestPrice, { platform: 'agoda', price: 190, total: 950 });
  assert.match(out.affiliateLinks.agoda, /hid=777.*cid=1966785/);
  delete process.env.SERPAPI_KEY;
});

// ── Tracked clicks ────────────────────────────────────────────
test('booking buttons go through /go and come out stamped with a click id', () => {
  const api = 'https://api.example';
  const hotel = { name: 'Hotel Uno', currency: 'EUR', platforms: { agoda: { price: 190 } },
    affiliateLinks: {
      agoda: 'https://www.agoda.com/partners/partnersearch.aspx?pcs=1&hid=777&cid=1966785',
      bookingCom: 'https://www.anrdoezrs.net/click-101769223-11891539?url=' + encodeURIComponent('https://www.booking.com/hotel/es/uno.html?checkin=2027-07-15'),
      expedia: 'https://www.expedia.com/Hotel-Search?selected=42&affcid=X',
      tripAdvisor: 'https://www.tripadvisor.com/Search?q=Hotel+Uno',
    } };
  const t = trackHotelLinks(hotel, { baseUrl: api, searchId: 'ab12cd34', channel: 'wa' });
  assert.ok(t.affiliateLinks.agoda.startsWith('https://api.example/go?'));
  assert.equal(t.affiliateLinks.tripAdvisor, hotel.affiliateLinks.tripAdvisor, 'untracked platforms are left alone');
  assert.equal(destinationOf(t.affiliateLinks.agoda), hotel.affiliateLinks.agoda);

  const click = (link) => resolveClick(Object.fromEntries(new URL(link).searchParams));
  const a = click(t.affiliateLinks.agoda);
  const au = new URL(a.url);
  assert.equal(au.searchParams.get('cid'), '1966785');
  assert.match(au.searchParams.get('tag'), /^wa-ab12cd34-[0-9a-f]{8}$/, 'Agoda sub-id');
  assert.equal(a.click.platform, 'agoda');
  assert.equal(a.click.hotel, 'Hotel Uno');
  assert.equal(a.click.price, 190);
  assert.equal(a.click.channel, 'wa');
  assert.equal(a.click.clickId, au.searchParams.get('tag'));

  const b = new URL(click(t.affiliateLinks.bookingCom).url);
  assert.equal(b.hostname, 'www.anrdoezrs.net');
  assert.match(b.searchParams.get('sid'), /^wa-ab12cd34-/, 'CJ sub-id on the CJ link');
  assert.equal(new URL(b.searchParams.get('url')).pathname, '/hotel/es/uno.html', 'destination untouched');

  const e = click(t.affiliateLinks.expedia);
  assert.equal(e.click.subIdParam, null);
  assert.equal(new URL(e.url).searchParams.get('affcid'), 'X');
});

test('/go never redirects anywhere but a booking site', () => {
  assert.equal(resolveClick({ to: 'https://evil.example/x' }), null);
  assert.equal(resolveClick({ to: 'http://www.agoda.com/x' }), null, 'https only');
  assert.equal(resolveClick({ to: 'https://agoda.com.evil.example/x' }), null);
  assert.equal(resolveClick({ to: 'javascript:alert(1)' }), null);
  assert.equal(resolveClick({}), null);
  assert.ok(isAllowedDestination('https://www.hotels.com/Hotel-Search?selected=1'));
  assert.equal(trackedLink('https://api.example', 'https://evil.example/x', {}), 'https://evil.example/x', 'not wrapped');
  const r = resolveClick({ to: 'https://www.agoda.com/x', c: '<script>', s: '../..', h: '<b>Hotel</b>' });
  assert.match(r.click.clickId, /^script-direct-[0-9a-f]{8}$/);
  assert.equal(r.click.hotel, 'bHotelb');
});

test('direct links: Booking search results with the hotel pinned; regional Expedia sites', () => {
  const b = new URL(buildDirectLink('bookingCom', google('https://www.booking.com/searchresults.en.html?aid=304142&label=gha-x&dest_id=-390625&dest_type=city&highlighted_hotels=91234&checkin=2020-01-01&utm_source=metagha'), quiz, 'EUR'));
  const page = new URL(b.searchParams.get('url'));
  assert.equal(page.pathname, '/searchresults.html');
  assert.equal(page.searchParams.get('highlighted_hotels'), '91234');
  assert.equal(page.searchParams.get('dest_id'), '-390625');
  assert.equal(page.searchParams.get('checkin'), '2027-07-15');
  assert.equal(page.searchParams.get('aid'), null);
  assert.equal(page.searchParams.get('label'), null);
  assert.equal(page.searchParams.get('utm_source'), null);

  const byDest = new URL(new URL(buildDirectLink('bookingCom', google('https://www.booking.com/searchresults.en.html?dest_id=91234&dest_type=hotel'), quiz)).searchParams.get('url'));
  assert.equal(byDest.searchParams.get('dest_type'), 'hotel');
  assert.equal(buildDirectLink('bookingCom', google('https://www.booking.com/searchresults.en.html?ss=Madrid&dest_id=-390625&dest_type=city'), quiz), null, 'a city search is not this hotel');

  const e = new URL(buildDirectLink('expedia', google('https://www.expedia.ca/Hotel-Search?selected=8556&mctc=10'), quiz));
  assert.equal(e.origin + e.pathname, 'https://www.expedia.com/Hotel-Search');
  assert.equal(e.searchParams.get('selected'), '8556');
  const h = new URL(buildDirectLink('hotelsCom', google('https://ca.hotels.com/Hotel-Search?selected=26286'), quiz));
  assert.equal(h.hostname, 'www.hotels.com');
  assert.equal(buildDirectLink('expedia', google('https://expedia.evil.com/Hotel-Search?selected=8556'), quiz), null);
  assert.equal(buildDirectLink('expedia', google('https://www.notexpedia.com/Hotel-Search?selected=8556'), quiz), null);
});

test('rule ranking: without a budget, the far-above-average hotel is not a default pick', () => {
  const mk = (name, price, riScore = 9.4, totalReviews = 2000) => ({ id: name, name, bestPrice: { price }, riScore, totalReviews, riConfidence: 'high', stars: 5, distanceKm: 0.8, amenities: [], facilities: [] });
  const pool = [mk('Ritz', 1460), mk('Fair', 250), mk('Mid', 380), mk('Cheap', 180, 8.0, 300), mk('Other', 260, 9.4, 200), mk('Pricey', 540)];
  const any = rankByRules({ destination: 'Madrid' }, pool).map(h => h.name);
  assert.equal(any[any.length - 1], 'Ritz');
  assert.equal(any[0], 'Fair', 'same score as Other, but far more reviews');
  const lux = rankByRules({ destination: 'Madrid', budget: '250plus' }, pool).map(h => h.name);
  assert.ok(lux.indexOf('Ritz') < any.indexOf('Ritz'), 'with a stated luxury budget the Ritz is not pushed down');
});

test('AI answers are held to the data: no invented "no", no confirmed wishes, no poor fits', async () => {
  const { _applyAIResultForTest } = await import('../src/services/aiMatcher.js');
  const q = { ...madrid, priorities: ['Pool', 'Spa', 'Beach access'], freeText: 'quiet room with blackout curtains' };
  const pool = [gProp(), gProp({ name: 'Hotel Dos', property_token: 'TOK2' }), gProp({ name: 'Hotel Tres', property_token: 'TOK3' })]
    .map(p => baselineScore(q, normaliseProperty(p, q, 'EUR')));
  const out = _applyAIResultForTest(q, pool, [
    { id: 'google-TOK1', matchScore: 91, matchReason: 'Fits.', highlights: ['a'],
      needs: [{ need: 'Pool', status: 'yes', note: 'Rooftop pool' }, { need: 'Spa', status: 'no', note: 'Not listed' }, { need: 'Beach access', status: 'yes' }],
      wishes: [{ wish: 'Quiet room', status: 'likely', note: 'Sleep 83% positive' }, { wish: 'Blackout curtains', status: 'yes', note: 'surely' }, { wish: 'Pool', status: 'likely', note: 'dup' }] },
    { id: 'google-TOK2', matchScore: 54, matchReason: 'Poor.', needs: [], wishes: [] },
    { id: 'google-TOK3', matchScore: 70, matchReason: 'Ok.', needs: [{ need: 'Spa', status: 'yes', note: 'spa in description' }] },
  ]);
  assert.deepEqual(out.map(h => h.name), ['Hotel Uno', 'Hotel Tres'], 'the 54-point pick is dropped');
  const by = Object.fromEntries(out[0].needsCheck.map(n => [n.need, n]));
  assert.equal(by['Pool'].status, 'yes');
  assert.equal(by['Pool'].note, 'Rooftop pool');
  assert.equal(by['Spa'].status, 'unknown', 'not listed is not "no"');
  assert.equal(by['Beach access'].status, 'no', 'the listing says no; the AI cannot overrule it');
  assert.equal(by['Quiet room'].status, 'likely');
  assert.equal(by['Blackout curtains'].status, 'unknown', 'a wish is never confirmed');
  assert.equal(out[0].needsCheck.filter(n => n.need === 'Pool').length, 1);
  assert.equal(out[1].needsCheck.find(n => n.need === 'Spa').status, 'likely', 'AI saw it, data silent');
  assert.match(buildMatchPrompt(q, pool), /SAME labels for every hotel/);
});

test('hostels are left out unless the budget is the lowest; Agoda link carries both date forms', async () => {
  const fetchJson = async () => ({ properties: [gProp(), gProp({ name: 'Generator Madrid', property_token: 'G', description: 'Hip hostel with a rooftop bar.' }), gProp({ name: 'One Star Inn', property_token: 'O', extracted_hotel_class: 1 })] });
  assert.deepEqual((await searchGoogleHotels(madrid, { fetchJson })).map(h => h.name), ['Hotel Uno']);
  assert.equal((await searchGoogleHotels({ ...madrid, budget: 'u80' }, { fetchJson })).length, 3);
  const a = new URL(buildDirectLink('agoda', google('https://www.agoda.com/partners/partnersearch.aspx?site_id=1&hid=245957&CkInDay=1'), quiz, 'EUR'));
  assert.equal(a.searchParams.get('CkInDay'), '15');
  assert.equal(a.searchParams.get('CkInMonth'), '7');
  assert.equal(a.searchParams.get('CkOutYear'), '2027');
  assert.equal(a.searchParams.get('NumberOfAdults'), '2');
  assert.equal(a.searchParams.get('PartnerCurrency'), 'EUR');
  assert.equal(a.searchParams.get('checkin'), '2027-07-15');
  assert.equal(a.searchParams.get('site_id'), null);
});

// ── Which platforms earn for us ───────────────────────────────
import { platformStatus, bookablePlatforms } from '../src/services/affiliateLinks.js';
import { usageSnapshot } from '../src/services/usage.js';

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const ladder = () => ({ type: 'hotel', name: 'Hotel Uno', gps_coordinates: { latitude: 40.42, longitude: -3.70 }, prices: [
  { source: 'Trip.com',    link: google('https://uk.trip.com/hotels/detail/?hotelId=991&checkIn=2027-07-15&checkOut=2027-07-20&adult=2&Allianceid=14&SID=22&utm_source=gha'), ...rate(180, 900) },
  { source: 'Agoda',       link: google('https://www.agoda.com/partners/partnersearch.aspx?hid=777'), ...rate(190, 950) },
  { source: 'Expedia.com', link: google('https://www.expedia.com/Hotel-Search?selected=42'), ...rate(200, 1000) },
  { source: 'Booking.com', link: google('https://www.booking.com/searchresults.en.html?highlighted_hotels=55&dest_id=55&dest_type=hotel'), ...rate(205, 1025) },
] });
const unoHotel = () => { const b = normaliseProperty(gProp(), madrid, 'EUR'); return { ...b, affiliateLinks: buildAllAffiliateLinks(b, madrid) }; };

test('a platform we are not approved for gets no button, only its price', async () => {
  await withEnv({ SERPAPI_KEY: 'test', AFFILIATE_DISABLE: 'expedia, hotelsCom' }, async () => {
    _clearLivePriceCache();
    assert.deepEqual(bookablePlatforms(), ['bookingCom', 'agoda']);
    assert.equal(platformStatus().expedia.via, 'disabled');
    assert.equal(platformStatus().tripCom.bookable, false, 'Trip.com needs a Travelpayouts link');
    const [h] = await pickBookable([unoHotel()], madrid, { fetchJson: async () => ladder() });
    assert.deepEqual(Object.keys(h.affiliateLinks).filter(k => ['bookingCom', 'agoda', 'expedia', 'hotelsCom', 'tripCom'].includes(k)).sort(), ['agoda', 'bookingCom']);
    assert.equal(h.platforms.expedia, undefined);
    assert.deepEqual(h.livePrices.otherPrices, [{ seller: 'Trip.com', price: 180 }, { seller: 'Expedia.com', price: 200 }]);
    assert.equal(h.bestPrice.platform, 'agoda', 'the best price is the best one we can send them to');
    assert.deepEqual(h.livePrices.cheaperElsewhere, { seller: 'Trip.com', price: 180, official: false }, 'and the page still says where it is cheaper');
  });
});

test('Travelpayouts: the hotel page goes into our Travelpayouts link, with no second tracker', async () => {
  const tp = (p, c) => `https://tp.media/r?marker=654321&trs=11111&p=${p}&campaign_id=${c}&u=https%3A%2F%2Fexample.com`;
  await withEnv({ SERPAPI_KEY: 'test', AFFILIATE_DISABLE: 'hotelsCom', TP_LINK_BOOKINGCOM: tp(1, 10), TP_LINK_TRIPCOM: tp(2, 20), TP_LINK_EXPEDIA: tp(3, 30) }, async () => {
    _clearLivePriceCache();
    const st = platformStatus();
    assert.deepEqual([st.bookingCom.via, st.agoda.via, st.expedia.via, st.tripCom.via], ['travelpayouts', 'agoda cid', 'travelpayouts', 'travelpayouts']);
    assert.equal(st.bookingCom.id, '654321');
    const [h] = await pickBookable([unoHotel()], madrid, { fetchJson: async () => ladder() });

    const b = new URL(h.affiliateLinks.bookingCom);
    assert.equal(b.hostname, 'tp.media');
    assert.equal(b.searchParams.get('marker'), '654321');
    const page = new URL(b.searchParams.get('u'));
    assert.equal(page.hostname, 'www.booking.com', 'straight to Booking.com, not through CJ as well');
    assert.equal(page.searchParams.get('highlighted_hotels'), '55');
    assert.equal(page.searchParams.get('aid'), null);

    const e = new URL(new URL(h.affiliateLinks.expedia).searchParams.get('u'));
    assert.equal(e.searchParams.get('selected'), '42');
    assert.equal(e.searchParams.get('affcid'), null, 'our direct Expedia id is not added on top of Travelpayouts');

    const t = new URL(new URL(h.affiliateLinks.tripCom).searchParams.get('u'));
    assert.equal(t.origin + t.pathname, 'https://www.trip.com/hotels/detail/');
    assert.equal(t.searchParams.get('hotelId'), '991');
    assert.equal(t.searchParams.get('checkIn'), '2027-07-15');
    assert.equal(t.searchParams.get('Allianceid'), null, "Trip.com's own partner ids are stripped");
    assert.equal(t.searchParams.get('SID'), null);
    assert.equal(t.searchParams.get('utm_source'), null);
    assert.equal(h.bestPrice.platform, 'tripCom', 'now the cheapest site is one we earn from');
    assert.equal(h.livePrices.cheaperElsewhere, null);

    assert.match(new URL(h.affiliateLinks.agoda).searchParams.get('cid'), /^1966785$/, 'Agoda stays on our own id');

    // The click id lands in Travelpayouts' sub_id.
    const tracked = trackHotelLinks(h, { baseUrl: 'https://api.example', searchId: 'aa11', channel: 'web' });
    const r = resolveClick(Object.fromEntries(new URL(tracked.affiliateLinks.tripCom).searchParams));
    assert.equal(r.click.subIdParam, 'sub_id');
    assert.match(new URL(r.url).searchParams.get('sub_id'), /^web-aa11-/);
    assert.equal(new URL(new URL(r.url).searchParams.get('u')).hostname, 'www.trip.com');
  });
});

test('the same hotel and trip is paid for once, however many travellers ask', async () => {
  await withEnv({ SERPAPI_KEY: 'test' }, async () => {
    _clearLivePriceCache();
    let paid = 0;
    const fetchJson = async () => { paid++; return ladder(); };
    const before = usageSnapshot().priceCacheHits;
    await pickBookable([unoHotel()], madrid, { fetchJson });
    await pickBookable([unoHotel()], { ...madrid, freeText: 'another traveller, other wishes' }, { fetchJson });
    await pickBookable([unoHotel()], madrid, { fetchJson });
    assert.equal(paid, 1);
    assert.equal(usageSnapshot().priceCacheHits - before, 2);
    await pickBookable([unoHotel()], { ...madrid, checkOut: '2027-07-21' }, { fetchJson });
    assert.equal(paid, 2, 'other dates are another price');
  });
});

// ── Review evidence ───────────────────────────────────────────
import { addReviewEvidence, openPoints, applyEvidence, buildEvidencePrompt } from '../src/services/reviewEvidence.js';
import { chatTurn, mergeTrip, hotelMessage, buildUnderstandPrompt } from '../src/services/chatEngine.js';
import { incoming, signedByMeta, send as waSend } from '../src/routes/whatsapp.js';
import { createHmac } from 'node:crypto';

const evHotel = (n, score, extra = {}) => ({
  id: 'google-T' + n, googleToken: 'T' + n, name: 'Hotel ' + n, matchScore: score, currency: 'EUR',
  needsCheck: [{ need: 'Pool', status: 'yes' }, { need: 'Spa', status: 'unknown' },
               { need: 'Quiet room', status: 'unknown', fromFreeText: true }, { need: 'Blackout curtains', status: 'unknown', fromFreeText: true }],
  ...extra,
});
const reviewsOf = { T1: [
    { rating: 5, best_rating: 5, date: 'a month ago', source: 'Google', snippet: 'Slept like a baby, the room was wonderfully quiet even though it is central. Curtains kept the room pitch dark until noon.' },
    { rating: 4, best_rating: 5, snippet: 'Great breakfast and friendly staff. Rooms are silent at night, we heard nothing from the street.', attributes: [{ name: 'Rooms', snippet: 'Big bed' }] },
    { rating: 5, best_rating: 5 } ],
  T2: [ { rating: 2, best_rating: 5, snippet: 'Thin walls, we heard the bar downstairs until 3am every night. Could not sleep at all, very noisy hotel.' },
        { rating: 3, best_rating: 5, snippet: 'Nice location but street noise is a real problem on the lower floors, bring earplugs.' } ] };

test('review evidence: reviews answer the wishes the data could not', async () => {
  _clearLivePriceCache();
  const calls = [];
  const fetchJson = async (p) => { calls.push(p); return { reviews: reviewsOf[p.property_token] || [] }; };
  let prompt = '';
  const ask = async (pr) => { prompt = pr; return { hotels: [
    { id: 2, points: [
      { point: 'Quiet room', verdict: 'supported', mentions: 2, note: 'Guests say rooms are quiet at night.', quote: 'the room was wonderfully quiet' },
      { point: 'Blackout curtains', verdict: 'supported', mentions: 1, note: 'Curtains keep the room dark.', quote: 'curtains kept the room pitch dark' },
      { point: 'Pool', verdict: 'contradicted', mentions: 1, note: 'No pool.', quote: 'x' },
      { point: 'Spa', verdict: 'silent', mentions: 0 } ] },
    { id: 1, points: [
      { point: 'Quiet room', verdict: 'contradicted', mentions: 2, note: 'Guests complain about noise from the bar.', quote: 'this exact sentence is not in any review' },
      { point: 'Blackout curtains', verdict: 'supported', mentions: 3, quote: 'made up words here' } ] },
  ] }; };

  const out = await addReviewEvidence([evHotel(2, 90), evHotel(1, 88)], madrid, { fetchJson, ask });
  assert.deepEqual(calls.map(c => [c.engine, c.property_token]), [['google_hotels_reviews', 'T2'], ['google_hotels_reviews', 'T1']]);
  assert.match(prompt, /POINTS TO CHECK:\n1\. Quiet room\n2\. Blackout curtains\n3\. Spa/, 'wishes first, then open needs; confirmed needs are not asked about');
  assert.match(prompt, /Thin walls/);

  assert.deepEqual(out.map(h => h.name), ['Hotel 1', 'Hotel 2'], 'guests confirm the wish at one and complain at the other: the order flips');
  const one = Object.fromEntries(out[0].needsCheck.map(n => [n.need, n]));
  assert.equal(one['Quiet room'].status, 'likely');
  assert.equal(one['Quiet room'].quote, 'the room was wonderfully quiet');
  assert.equal(one['Quiet room'].mentions, 2);
  assert.equal(one['Blackout curtains'].status, 'likely');
  assert.equal(one['Pool'].status, 'yes', "the hotel's own data is not overruled by a review verdict");
  assert.equal(one['Spa'].status, 'unknown');
  assert.equal(out[0].matchScore, 94);
  assert.equal(out[0].reviewEvidence.reviewsRead, 2, 'the bare star rating is not a review to read');

  const two = Object.fromEntries(out[1].needsCheck.map(n => [n.need, n]));
  assert.equal(two['Quiet room'].status, 'concern');
  assert.equal(two['Quiet room'].quote, undefined, 'a quote that is not in the reviews is never shown');
  assert.match(two['Quiet room'].note, /noise/);
  assert.equal(two['Blackout curtains'].status, 'unknown', 'no note and an invented quote: not evidence');
  assert.equal(out[1].matchScore, 82);

  // Second traveller, same hotels: the reviews are not bought again.
  await addReviewEvidence([evHotel(1, 88)], madrid, { fetchJson, ask });
  assert.equal(calls.length, 2);
});

test('review evidence: nothing open, nothing spent; failures change nothing', async () => {
  _clearLivePriceCache();
  let called = 0;
  const fetchJson = async () => { called++; return { reviews: [] }; };
  const settled = [{ ...evHotel(1, 80), needsCheck: [{ need: 'Pool', status: 'yes' }] }];
  assert.deepEqual(await addReviewEvidence(settled, madrid, { fetchJson, ask: async () => ({}) }), settled);
  assert.equal(called, 0);
  assert.deepEqual(openPoints(settled), []);

  const h = [evHotel(1, 80)];
  assert.deepEqual(await addReviewEvidence(h, madrid, { fetchJson: async () => { throw new Error('quota'); }, ask: async () => ({}) }), h);
  assert.deepEqual(await addReviewEvidence(h, madrid, { fetchJson: async (p) => ({ reviews: reviewsOf.T1 }), ask: async () => { throw new Error('down'); } }), h);
  assert.match(buildEvidencePrompt(h, [[]], ['Quiet room'], 'he'), /Write every "note" in this language: he/);
});

// ── The conversation ──────────────────────────────────────────
const fakeSearch = (log) => async (trip, ctx) => {
  log.push({ trip: JSON.parse(JSON.stringify(trip)), ctx });
  return { meta: { searchId: 's1' }, hotels: [
    { name: 'Hotel Uno', stars: 4, riScore: 9.2, currency: 'EUR', matchScore: 92, matchReason: 'שקט ומרכזי.',
      needsCheck: [{ need: 'Pool', status: 'yes' }, { need: 'Quiet room', status: 'likely', evidence: 'reviews', quote: 'wonderfully quiet', note: 'x' }, { need: 'Spa', status: 'unknown' }],
      platforms: { agoda: { price: 190 }, bookingCom: { price: 205 }, expedia: { price: 200 } },
      affiliateLinks: { agoda: 'https://api.x/go?to=a', bookingCom: 'https://api.x/go?to=b' },
      bestPrice: { platform: 'agoda', price: 190 }, livePrices: { cheaperElsewhere: { seller: 'Trip.com', price: 180 } },
      photos: { main: { url: 'https://img.x/1.jpg' } } },
    { name: 'Hotel Dos', currency: 'EUR', needsCheck: [], platforms: {}, affiliateLinks: {}, bestPrice: { platform: 'google', price: 150 } },
  ] };
};

test('chat: one message with everything goes straight to a search, in the traveller\'s language', async () => {
  _clearLivePriceCache();
  const searches = [], interim = [];
  const ask = async () => ({ intent: 'trip', language: 'he', destination: 'Madrid', checkIn: '2026-11-24', checkOut: '2026-11-27',
    destinationLabel: 'מדריד', adults: 2, addPriorities: ['Pool', 'Not A Real One'], wishes: 'quiet room, blackout curtains', reply: 'מעולה!' });
  const r = await chatTurn({ sessionId: 'abc12345', message: 'זוג למדריד 24-27 בנובמבר, מלון שקט עם בריכה ווילונות האפלה', channel: 'wa', baseUrl: 'https://api.x' },
    { ask, search: fakeSearch(searches), today: '2026-11-16', onInterim: (t) => interim.push(t) });

  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0].trip.priorities, ['Pool'], 'only priorities we know how to check');
  assert.equal(searches[0].trip.freeText, 'quiet room, blackout curtains');
  assert.equal(searches[0].trip.destination, 'Madrid', 'the search itself uses the English name');
  assert.deepEqual(searches[0].ctx, { baseUrl: 'https://api.x', channel: 'wa', language: 'he' });
  assert.match(interim[0], /מחפש מלונות במדריד, 24\.11 עד 27\.11, ל-2 מבוגרים\./);
  assert.equal(r.messages.length, 3, 'two hotels and the closing line; the "searching" line went out on its own');
  const m = r.messages[0];
  assert.equal(m.type, 'hotel');
  assert.equal(m.image, 'https://img.x/1.jpg');
  assert.match(m.text, /^1\. \*Hotel Uno\* ★★★★ · 9\.2\/10\nשקט ומרכזי\./);
  assert.match(m.text, /✓ Pool\n~ Quiet room "wonderfully quiet"/);
  assert.match(m.text, /\? לא אומת: Spa/);
  assert.match(m.text, /החל מ- €190 ללילה ב- Agoda\nגם: Booking\.com €205/, 'Expedia has a price but no link of ours: not offered');
  assert.match(m.text, /נראה זול יותר ב- Trip\.com: €180/);
  assert.match(m.text, /להזמנה: https:\/\/api\.x\/go\?to=a$/);
  assert.match(r.messages[1].text, /€150 ללילה \(מחיר משוער\)/);
  assert.equal(r.searched, true);
});

test('chat: asks for one missing thing at a time, asks about preferences once, then refines', async () => {
  _clearLivePriceCache();
  const searches = [];
  const script = [
    { intent: 'trip', language: 'en', destination: 'Lisbon', reply: 'Lisbon, lovely. When are you going?' },
    { intent: 'trip', language: 'en', checkIn: '2026-12-05', reply: 'Got it.' },
    { intent: 'trip', language: 'en', checkOut: '2026-12-08', reply: 'Thanks.' },
    { intent: 'trip', language: 'en', reply: 'Sure.' },
    { intent: 'refine', language: 'en', budget: '80_150', addPriorities: ['Pool'], reply: 'Looking for cheaper.' },
    { intent: 'question', language: 'en', reply: 'Hotel Uno is the one guests call quiet.' },
    { intent: 'reset', language: 'en' },
  ];
  let i = 0; const prompts = [];
  const deps = { ask: async (p) => { prompts.push(p); return script[i++]; }, search: fakeSearch(searches), today: '2026-11-16' };
  const say = (message) => chatTurn({ sessionId: 'flow-123456', message }, deps);

  assert.equal((await say('Lisbon')).messages[0].text, 'Lisbon, lovely. When are you going?');
  assert.equal((await say('from dec 5')).messages[0].text, 'And when do you check out?', 'the model did not ask, so we do');
  const third = await say('until the 8th');
  assert.match(third.messages[0].text, /Lisbon, 5\.12 to 8\.12\. What matters most to you/);
  assert.equal(searches.length, 0, 'nothing known about preferences: ask once before spending a search');
  const fourth = await say('nothing special');
  assert.equal(searches.length, 1, 'asked once; now search whatever the answer');
  assert.match(fourth.messages[0].text, /for 2 adults \(tell me if that is wrong\)/);
  assert.equal(searches[0].trip.adults, 2);

  await say('something cheaper with a pool');
  assert.equal(searches.length, 2);
  assert.equal(searches[1].trip.budget, '80_150');
  assert.deepEqual(searches[1].trip.priorities, ['Pool']);
  assert.match(prompts[4], /HOTELS ALREADY SHOWN:\n1\. Hotel Uno \(190 EUR\/night\)/, 'the model sees what was shown');

  const q = await say('which one is quiet?');
  assert.equal(searches.length, 2, 'a question does not search again');
  assert.equal(q.messages[0].text, 'Hotel Uno is the one guests call quiet.');

  await say('start over');
  const fresh = await chatTurn({ sessionId: 'flow-123456', message: '' }, deps);
  assert.equal(fresh.trip.destination, '');
});

test('chat: bad values never reach the trip', () => {
  const trip = { destination: 'Rome', destinationLabel: 'רומא', landmark: 'Colosseum', checkIn: '', checkOut: '', adults: null, children: 0, childAges: [], infants: 0, rooms: 1, budget: 'any', stars: 0, priorities: ['Spa'], freeText: '' };
  mergeTrip(trip, { destination: 'Paris', checkIn: '2020-01-01', checkOut: 'soon', adults: 40, budget: 'free', stars: 9, addPriorities: ['Pool', '<script>'], removePriorities: ['Spa'], wishes: 'x'.repeat(500) }, '2026-11-16');
  assert.equal(trip.destination, 'Paris');
  assert.equal(trip.landmark, '', 'a new place drops the old landmark');
  assert.equal(trip.checkIn, '', 'a date in the past is refused');
  assert.equal(trip.checkOut, '');
  assert.equal(trip.adults, null);
  assert.equal(trip.budget, 'any');
  assert.equal(trip.stars, 0);
  assert.deepEqual(trip.priorities, ['Pool']);
  assert.equal(trip.freeText.length, 200);
  mergeTrip(trip, { checkIn: '2026-12-10', checkOut: '2026-12-09' }, '2026-11-16');
  assert.equal(trip.checkIn, '2026-12-10');
  assert.equal(trip.checkOut, '', 'check-out before check-in is refused');
  mergeTrip(trip, { checkOut: '2027-03-01' }, '2026-11-16');
  assert.equal(trip.checkOut, '', 'more than 30 nights is refused');
  assert.match(buildUnderstandPrompt({ trip, lastResults: [], history: [] }, 'hi', '2026-11-16'), /Today is 2026-11-16/);
});

// ── WhatsApp ──────────────────────────────────────────────────
test('whatsapp: reads Meta\'s webhook, checks its signature, sends a hotel as a photo with caption', async () => {
  const body = { entry: [{ changes: [{ value: { messages: [
    { from: '972501234567', id: 'wamid.1', type: 'text', text: { body: 'מדריד בסוף נובמבר' } },
    { from: '972501234567', id: 'wamid.2', type: 'image', image: {} },
    { from: '972501234567', id: 'wamid.3', type: 'interactive', interactive: { button_reply: { title: 'Cheaper' } } },
  ], statuses: [{ id: 'x' }] } }] }] };
  assert.deepEqual(incoming(body).map(m => [m.id, m.text]), [['wamid.1', 'מדריד בסוף נובמבר'], ['wamid.2', null], ['wamid.3', 'Cheaper']]);
  assert.deepEqual(incoming({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }), [], 'delivery receipts are not messages');

  await withEnv({ WHATSAPP_APP_SECRET: 'shh' }, async () => {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex');
    const req = (s, b = raw) => ({ rawBody: b, get: () => s });
    assert.equal(signedByMeta(req(sig)), true);
    assert.equal(signedByMeta(req(sig, Buffer.from('tampered'))), false);
    assert.equal(signedByMeta(req('sha256=00')), false);
    assert.equal(signedByMeta(req('')), false);
  });

  await withEnv({ WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_ID: '111', WHATSAPP_API_VERSION: null }, async () => {
    const sent = [];
    const ok = (status) => ({ ok: status < 300, status, text: async () => '' });
    let refuseImage = false;
    const fetchImpl = async (url, opt) => { const b = JSON.parse(opt.body); sent.push({ url, auth: opt.headers.Authorization, b }); return ok(refuseImage && b.type === 'image' ? 400 : 200); };
    await waSend('972501234567', { type: 'hotel', text: '1. *Hotel Uno*', image: 'https://img.x/1.jpg' }, { fetchImpl });
    assert.equal(sent[0].url, 'https://graph.facebook.com/v21.0/111/messages');
    assert.equal(sent[0].auth, 'Bearer tok');
    assert.deepEqual(sent[0].b, { messaging_product: 'whatsapp', to: '972501234567', type: 'image', image: { link: 'https://img.x/1.jpg', caption: '1. *Hotel Uno*' } });
    await waSend('972501234567', { type: 'text', text: 'hello' }, { fetchImpl });
    assert.equal(sent[1].b.type, 'text');
    refuseImage = true;
    assert.equal(await waSend('972501234567', { type: 'hotel', text: 'x', image: 'https://img.x/bad.jpg' }, { fetchImpl }), true);
    assert.deepEqual(sent.slice(2).map(s => s.b.type), ['image', 'text'], 'a refused photo falls back to text');
  });
  assert.equal(await waSend('1', { type: 'text', text: 'x' }), false, 'not configured: nothing is sent');
});

test('chat links are short, and a short link still lands on the stamped booking page', async () => {
  const { shorten, expand } = await import('../src/services/clickLinks.js');
  _clearLivePriceCache();
  const long = trackedLink('https://api.example', 'https://www.agoda.com/partners/partnersearch.aspx?pcs=1&hid=777&cid=1966785', { platform: 'agoda', hotel: 'Hotel Uno', searchId: 'ab12', channel: 'wa', price: 190, currency: 'EUR' });
  const short = await shorten(long);
  assert.match(short, /^https:\/\/api\.example\/go\/[\w-]{8}$/);
  const r = resolveClick(await expand(short.split('/').pop()));
  assert.equal(r.click.platform, 'agoda');
  assert.equal(r.click.channel, 'wa');
  assert.match(new URL(r.url).searchParams.get('tag'), /^wa-ab12-/);
  assert.equal(await expand('nosuchcode'), null);
  assert.equal(await expand('../../etc'), null);
  assert.equal(await shorten('https://www.agoda.com/x'), 'https://www.agoda.com/x', 'only our own /go links are shortened');
  const rules = hotelMessage({ name: 'H', matchReason: 'Confirmed for your trip: Pool.', matchedBy: 'rules', needsCheck: [], platforms: {}, affiliateLinks: {} }, 0, 'he');
  assert.ok(!rules.text.includes('Confirmed'), 'a fixed English sentence is not dropped into a Hebrew chat');
});

test('each step can run on its own model; the default is Haiku 5.5', async () => {
  const { modelFor, claudeModel } = await import('../src/services/claude.js');
  await withEnv({ ANTHROPIC_MODEL: null, ANTHROPIC_MODEL_MATCH: 'claude-sonnet-5-5', ANTHROPIC_MODEL_CHAT: 'not a model; rm -rf' }, async () => {
    assert.equal(modelFor('match'), 'claude-sonnet-5-5');
    assert.equal(modelFor('reviews'), claudeModel());
    assert.equal(modelFor('chat'), claudeModel(), 'a malformed value is ignored');
  });
});
