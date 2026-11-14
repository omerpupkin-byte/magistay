// ─── services/travellerProfile.js ──────────────────────────────
// Turns the quiz into (a) a readable brief for the AI and (b) a list of
// concrete needs that every recommended hotel is checked against.

const BUDGET_LABEL = {
  u80:      'under $80 per night',
  '80_150': '$80–150 per night',
  '150_250':'$150–250 per night',
  '250plus':'$250+ per night',
  any:      'no stated limit',
};

// ── The brief ─────────────────────────────────────────────────
export function describeTraveller(quiz) {
  const who = [`${quiz.adults} adult${quiz.adults !== 1 ? 's' : ''}`];
  if (quiz.children) who.push(`${quiz.children} child${quiz.children !== 1 ? 'ren' : ''} (2–17)`);
  if (quiz.infants)  who.push(`${quiz.infants} infant${quiz.infants !== 1 ? 's' : ''} (under 2)`);

  const dates = quiz.checkIn && quiz.checkOut
    ? `${quiz.checkIn} → ${quiz.checkOut}${quiz.nights ? ` (${quiz.nights} nights)` : ''}`
    : 'not specified';

  const lines = [
    `Destination: ${quiz.destination || 'not specified'}${quiz.landmark ? ` — wants to be near: ${quiz.landmark}` : ''}`,
    `Travellers: ${who.join(', ')} · ${quiz.rooms || 1} room(s)`,
    `Trip purpose: ${list(quiz.purpose) || 'not specified'}`,
    `Dates: ${dates}${quiz.dateFlexibility && quiz.dateFlexibility !== 'exact' ? ` (flexibility: ${quiz.dateFlexibility})` : ''}`,
    `Budget: ${BUDGET_LABEL[quiz.budget] || BUDGET_LABEL.any}`,
    `Minimum stars: ${quiz.stars > 0 ? quiz.stars + '+' : 'any'}`,
    `Vibe: ${list(quiz.vibes) || 'not specified'}`,
    `Must-haves: ${list(quiz.priorities) || 'none'}`,
    `Specific needs: ${list(Object.values(quiz.specialNeeds || {}).flat()) || 'none'}`,
    `In their own words: ${quiz.freeText ? JSON.stringify(quiz.freeText) : 'nothing added'}`,
  ];
  return lines.map(l => `  - ${l}`).join('\n');
}

const list = arr => (Array.isArray(arr) ? arr.filter(Boolean).join(', ') : '');

// ── The checklist ─────────────────────────────────────────────
// Everything the traveller explicitly asked for, in their own labels.
export function listNeeds(quiz) {
  const needs = [
    ...(quiz.priorities || []),
    ...Object.values(quiz.specialNeeds || {}).flat(),
  ];
  if (quiz.infants > 0 && !needs.some(n => /crib|cot/i.test(n))) needs.push('Crib / cot available');
  const seen = new Set();
  return needs.filter(n => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 14);
}

// Which hotel data confirms which need. `amenity` is one of our
// normalised amenity keys; `text` is matched against the hotel's raw
// facility names and description.
const NEED_RULES = [
  { need: /crib|cot/i,                    amenity: ['crib'],                  text: /\bcot\b|crib|baby bed/i },
  // "Included" is about the rate, not the hotel: a breakfast room proves nothing.
  { need: /breakfast/i,                   rate: 'breakfast',                  offered: /breakfast/i },
  { need: /free cancel/i,                 amenity: ['free_cancellation'],     rate: 'flexible' },
  { need: /children.?s pool|kids.? pool/i,amenity: ['kids_pool'],             text: /children.?s (swimming )?pool|kids.? pool|paddling/i },
  { need: /\bpool\b/i,                    amenity: ['pool'],                  text: /pool/i },
  { need: /spa|wellness/i,                amenity: ['spa'],                   text: /\bspa\b|wellness|sauna/i },
  { need: /parking/i,                     amenity: ['parking'],               text: /car park|parking|garage/i },
  { need: /rooftop/i,                     amenity: ['rooftop'],               text: /roof/i },
  { need: /beach/i,                       amenity: ['beach_access'],          text: /beach/i },
  { need: /sea view/i,                    amenity: ['sea_view'],              text: /sea view|ocean view/i },
  { need: /late check/i,                  amenity: ['late_checkout'],         text: /late check.?out/i },
  { need: /early check/i,                 amenity: ['early_checkin'],         text: /early check.?in/i },
  { need: /stairs|elevator|lift/i,        amenity: ['elevator'],              text: /lift|elevator/i },
  { need: /wheelchair|roll-in|wide door/i,amenity: ['wheelchair_accessible'], text: /wheelchair|disabled|reduced mobility/i },
  { need: /highchair/i,                   amenity: ['highchair'],             text: /high ?chair/i },
  { need: /kids club/i,                   amenity: ['kids_club'],             text: /kids.? club|children.?s club|mini.?club/i },
  { need: /babysit/i,                     amenity: ['babysitting'],           text: /babysit|child ?care/i },
  { need: /soundproof/i,                  amenity: ['soundproof'],            text: /soundproof|sound.?insulat/i },
  { need: /restaurant/i,                  amenity: ['restaurant'],            text: /restaurant/i },
  { need: /vegetarian|vegan/i,            amenity: ['vegetarian'],            text: /vegetarian|vegan/i },
  { need: /kosher/i,                      amenity: ['kosher'],                text: /kosher/i },
  { need: /halal/i,                       amenity: ['halal'],                 text: /halal/i },
  { need: /room service/i,                amenity: ['room_service'],          text: /room service/i },
  { need: /pet/i,                         amenity: ['pet'],                   text: /pets? (allowed|friendly)|small pets/i },
  { need: /ev charging/i,                 amenity: ['ev_charging'],           text: /electric (car|vehicle)|charging station/i },
  { need: /wi-?fi/i,                      amenity: ['wifi'],                  text: /wi-?fi|wlan|internet/i },
  { need: /laundry/i,                     amenity: ['laundry'],               text: /laundry/i },
  { need: /concierge/i,                   amenity: ['concierge'],             text: /concierge/i },
  { need: /gym|fitness/i,                 amenity: ['gym'],                   text: /gym|fitness/i },
  { need: /walkable/i,                    distance: 1.5 },
];

// Status of one need for one hotel, from the data we actually hold:
//   'yes'      the hotel's data confirms it
//   'no'       the hotel's listing states it is not offered
//   'unknown'  the data does not say — never guessed
export function checkNeed(need, hotel) {
  const rule = NEED_RULES.find(r => r.need.test(need));
  if (!rule) return { need, status: 'unknown' };

  const amenities = hotel.amenities || [];
  const haystack  = [...(hotel.facilities || []), hotel.description || ''].join(' · ');

  // A stated speed cannot be confirmed from a facility list.
  if (/mbps/i.test(need)) {
    const hasWifi = amenities.includes('wifi') || /wi-?fi|wlan|internet/i.test(haystack);
    return { need, status: 'unknown', note: hasWifi ? 'Wi-Fi listed; speed not stated' : undefined };
  }

  // The listing states outright that the hotel does NOT offer it.
  const denied = rule.text && (hotel.excluded || []).find(x => rule.text.test(x));
  if (denied) return { need, status: 'no', note: String(denied).slice(0, 60) };

  if (rule.rate === 'breakfast' && hotel.freeBreakfast) return { need, status: 'yes', note: 'free breakfast listed' };
  if (rule.amenity?.some(a => amenities.includes(a))) return { need, status: 'yes' };
  if (rule.text && rule.text.test(haystack))           return { need, status: 'yes' };
  if (rule.rate === 'breakfast' && hotel.breakfastPrice != null) {
    return { need, status: 'yes', note: 'available as a rate with breakfast' };
  }
  if (rule.rate === 'breakfast' && (amenities.includes('breakfast') || rule.offered.test(haystack))) {
    return { need, status: 'unknown', note: 'breakfast served; check it is in your rate' };
  }
  if (rule.rate === 'flexible' && hotel.bestFlex) {
    return { need, status: 'yes', note: hotel.bestFlex.terms || 'refundable rate available' };
  }
  if (rule.distance && hotel.distanceKm != null) {
    return hotel.distanceKm <= rule.distance
      ? { need, status: 'yes', note: `${hotel.distanceKm} km from ${hotel.distanceFrom || 'the centre'}` }
      : { need, status: 'unknown', note: `${hotel.distanceKm} km from ${hotel.distanceFrom || 'the centre'}` };
  }
  return { need, status: 'unknown' };
}

export function checkAllNeeds(quiz, hotel) {
  return listNeeds(quiz).map(n => checkNeed(n, hotel));
}
