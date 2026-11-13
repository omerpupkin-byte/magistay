// Run with: npm test
// Exercises the search pipeline with Hotelbeds replaced by canned
// responses shaped like the documented API, so no keys or network are needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAllAffiliateLinks } from '../src/services/affiliateLinks.js';
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
