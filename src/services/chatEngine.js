// ─── services/chatEngine.js ────────────────────────────────────
// The matcher as a conversation. One function, no channel in it:
//
//   chatTurn({ sessionId, message, channel, baseUrl }) -> { messages, ... }
//
// The website chat, the simulator and WhatsApp all call it and only
// differ in how they show the messages that come back.
//
// A turn:
//   1. Claude reads the message against what we already know about the
//      trip and returns what changed (and the language the person writes in).
//   2. If the place or the dates are missing, ask for exactly one thing.
//   3. If nothing is known about what matters to them, ask once. Never twice.
//   4. Otherwise search, and answer with the best three: why, what was
//      checked, the price on each site, one link to book.
//
// After results the conversation goes on: "cheaper", "closer to the
// centre", "with a pool" change the trip and search again.
//
// What we know is kept per session in the shared store (24 hours).

import { askClaudeJSON, hasClaude } from './claude.js';
import { cacheGet, cacheSet } from './store.js';
import { count } from './usage.js';

const SESSION_TTL = 24 * 60 * 60 * 1000;
const MAX_MESSAGE = 700;
const SHOW        = 3;          // hotels per answer in a chat

const BUDGETS    = ['u80', '80_150', '150_250', '250plus', 'any'];
const PRIORITIES = ['Pool', 'Spa', 'Breakfast included', 'Free cancellation', 'Parking', 'Rooftop', 'Beach access',
                    'Sea view', 'Gym', 'Kids pool', 'Crib / cot available', 'Elevator', 'Wheelchair accessible',
                    'Pet friendly', 'Air conditioning', 'Late check-out', 'Early check-in', 'Airport shuttle', 'Kitchen'];

function emptyState() {
  return { trip: { destination: '', destinationLabel: '', landmark: '', checkIn: '', checkOut: '', adults: null, children: 0, childAges: [], infants: 0,
                   rooms: 1, budget: 'any', stars: 0, priorities: [], freeText: '' },
           language: 'en', askedPreferences: false, lastResults: [], turns: 0, history: [] };
}

// ── Public: one turn ──────────────────────────────────────────
// deps.search(trip, ctx) -> { hotels, meta }   (the real search, injected so
// this file has no route in it and tests need no network)
// deps.ask(prompt, opts)                        (Claude, injectable)
// deps.onInterim(text)                          (optional: "searching..." sent right away)
export async function chatTurn({ sessionId, message, channel = 'web', baseUrl = '' }, deps = {}) {
  const ask = deps.ask || askClaudeJSON;
  const key = 'chat|' + String(sessionId || '').replace(/[^\w.+-]/g, '').slice(0, 64);
  const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
  const state = (await cacheGet(key)) || emptyState();
  count('chatTurns');

  if (!text) return finish(key, state, [t(state.language, 'hello')]);
  if (!deps.ask && !hasClaude()) return finish(key, state, [t(state.language, 'unavailable')]);

  // 1. Understand.
  let read;
  try {
    read = await ask(buildUnderstandPrompt(state, text, deps.today || today()), { maxTokens: 900, step: 'chat' });
  } catch (e) {
    console.error('[CHAT] understanding failed:', String(e?.message || e).slice(0, 160));
    state.lastFailure = { step: 'understand', at: new Date().toISOString(), message: String(e?.message || e).slice(0, 200) };
    return finish(key, state, [t(state.language, 'unavailable')]);
  }
  if (typeof read?.language === 'string' && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(read.language)) state.language = read.language.toLowerCase();
  const lang = state.language;
  state.history.push({ who: 'user', text }); state.turns++;

  if (read?.intent === 'reset') {
    const fresh = emptyState(); fresh.language = lang;
    return finish(key, fresh, [t(lang, 'reset')]);
  }

  const before = JSON.stringify(state.trip);
  mergeTrip(state.trip, read, deps.today || today());
  const changed = JSON.stringify(state.trip) !== before;

  // A question about a hotel we already showed, or small talk: the model's
  // reply is the answer; no search.
  if ((read?.intent === 'question' || read?.intent === 'smalltalk') && !changed) {
    return finish(key, state, [clean(read.reply) || t(lang, 'hello')]);
  }

  // 2. The two things a search cannot do without.
  const trip = state.trip;
  if (!trip.destination) return finish(key, state, [clean(read?.reply) || t(lang, 'askWhere')]);
  if (!trip.checkIn || !trip.checkOut) return finish(key, state, [missingDatesReply(read, lang, trip)]);

  // 3. What matters to them: asked once, and only if they said nothing.
  const said = trip.priorities.length > 0 || !!trip.freeText || trip.budget !== 'any' || trip.stars > 0;
  if (!said && !state.askedPreferences && !/^(search|go|חפש|תחפש|לא|no|nothing|כלום|אין)$/i.test(text)) {
    state.askedPreferences = true;
    return finish(key, state, [t(lang, 'askWhat', trip)]);
  }
  state.askedPreferences = true;

  // 4. Search.
  if (!deps.search) return finish(key, state, [t(lang, 'unavailable')]);
  const assumedAdults = trip.adults == null;
  const interim = t(lang, 'searching', { ...trip, adults: trip.adults || 2, assumedAdults });
  if (deps.onInterim) { try { await deps.onInterim(interim); } catch { /* the answer still goes out */ } }

  let found;
  try {
    found = await deps.search({ ...trip, adults: trip.adults || 2 }, { baseUrl, channel, language: lang });
  } catch (e) {
    console.error('[CHAT] search failed:', String(e?.message || e).slice(0, 200));
    return finish(key, state, [...(deps.onInterim ? [] : [interim]), t(lang, 'searchFailed')]);
  }

  const hotels = (found?.hotels || []).slice(0, SHOW);
  state.lastResults = hotels.map(h => ({ name: h.name, price: h.bestPrice?.price ?? null, currency: h.currency || '', score: h.matchScore ?? null }));
  const messages = deps.onInterim ? [] : [interim];
  if (hotels.length === 0) {
    messages.push(t(lang, 'nothing', trip));
  } else {
    hotels.forEach((h, i) => messages.push(hotelMessage(h, i, lang)));
    messages.push(t(lang, 'after'));
  }
  // The reviews come after the answer, as a follow-up the channel sends when ready.
  const wishes = hotels.some(h => (h.needsCheck || []).some(n => n.fromFreeText && n.status !== 'yes'));
  const followUp = deps.reviews && hotels.length && wishes
    ? () => deps.reviews(hotels, { ...trip, adults: trip.adults || 2 }, lang)
    : null;
  return finish(key, state, messages, { searched: true, hotels: hotels.length, searchId: found?.meta?.searchId || null, followUp });
}

async function finish(key, state, messages, extra = {}) {
  const out = messages.filter(Boolean).map(m => (typeof m === 'string' ? { type: 'text', text: m } : m));
  for (const m of out) state.history.push({ who: 'us', text: (m.text || '').slice(0, 300) });
  state.history = state.history.slice(-8);
  await cacheSet(key, state, SESSION_TTL);
  return { messages: out, language: state.language, trip: state.trip, ...extra };
}

// ── Understanding ─────────────────────────────────────────────
export function buildUnderstandPrompt(state, text, todayIso) {
  const shown = state.lastResults.length
    ? state.lastResults.map((h, i) => `${i + 1}. ${h.name}${h.price ? ` (${h.price} ${h.currency}/night)` : ''}`).join('\n')
    : 'none yet';
  const recent = state.history.slice(-4).map(h => `${h.who === 'user' ? 'Traveller' : 'Us'}: ${h.text}`).join('\n') || '(start of conversation)';

  return `You are the understanding step of a hotel-matching assistant. Read the traveller's new message and report what it changes. You do not recommend hotels.

Today is ${todayIso}.

WHAT WE KNOW ABOUT THE TRIP:
${JSON.stringify(state.trip)}

HOTELS ALREADY SHOWN:
${shown}

RECENT CONVERSATION:
${recent}

NEW MESSAGE FROM THE TRAVELLER:
${JSON.stringify(text)}

Report only what this message states or changes. Leave out anything it does not mention.
- "destination": the city, region or island, in English ("Madrid", "Crete, Greece"). "destinationLabel": the same place as the traveller would write it in their language ("מדריד"). "landmark": a specific place to be near, if named.
- "checkIn" / "checkOut": YYYY-MM-DD, never in the past. Resolve "next weekend", "24-27 in November", "3 nights from the 5th" from today's date. If only one date or only a month is given, set what is certain and leave the rest out.
- "adults", "children", "infants" (under 2), "childAges", "rooms": numbers. "a couple" is 2 adults.
- "budget": one of ${BUDGETS.join(', ')} (per night, roughly in euros or dollars). "cheaper" after results means one step lower than now; "luxury" is 250plus.
- "stars": minimum star class if they ask for one.
- "addPriorities" / "removePriorities": only from this list: ${PRIORITIES.join(', ')}.
- "wishes": anything else that matters to them, in short plain English ("quiet room, blackout curtains, firm mattress"). Only new wishes from this message.
- "intent": "trip" (gives or changes trip details), "refine" (changes what they want after seeing results), "question" (asks about a hotel shown or how this works), "smalltalk", or "reset" (start over).
- "language": the language the traveller writes in, as a two-letter code ("he", "en", "es"...).
- "reply": one or two short sentences TO the traveller, in their language, warm and plain. If the place or the dates are still unknown after this message, ask for the single most important missing one. If they asked a question, answer it only from what is above; say so if we do not know. Otherwise a brief acknowledgement.

Reply with JSON only:
{ "intent": "...", "language": "..", "destination": "...", "destinationLabel": "...", "landmark": "...", "checkIn": "...", "checkOut": "...", "adults": 0, "children": 0, "infants": 0, "childAges": [], "rooms": 0, "budget": "...", "stars": 0, "addPriorities": [], "removePriorities": [], "wishes": "...", "reply": "..." }`;
}

// Take only what is well-formed; never let a bad value into the trip.
export function mergeTrip(trip, read, todayIso) {
  if (!read || typeof read !== 'object') return trip;
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? v : null);

  const dest = str(read.destination, 80);
  if (dest && dest.toLowerCase() !== trip.destination.toLowerCase()) { trip.destination = dest; trip.landmark = ''; trip.destinationLabel = ''; }
  const label = str(read.destinationLabel, 60); if (label && dest) trip.destinationLabel = label;
  const lm = str(read.landmark, 80); if (lm) trip.landmark = lm;

  const ci = date(read.checkIn), co = date(read.checkOut);
  if (ci && ci >= todayIso) { trip.checkIn = ci; if (trip.checkOut && trip.checkOut <= ci) trip.checkOut = ''; }
  if (co && co > (trip.checkIn || todayIso)) trip.checkOut = co;
  if (trip.checkIn && trip.checkOut && nights(trip.checkIn, trip.checkOut) > 30) trip.checkOut = '';

  const a = int(read.adults, 1, 12);   if (a != null) trip.adults = a;
  const c = int(read.children, 0, 8);  if (c != null) trip.children = c;
  const b = int(read.infants, 0, 4);   if (b != null) trip.infants = b;
  const r = int(read.rooms, 1, 6);     if (r != null) trip.rooms = r;
  if (Array.isArray(read.childAges)) trip.childAges = read.childAges.filter(x => Number.isInteger(x) && x >= 0 && x <= 17).slice(0, 8);
  if (BUDGETS.includes(read.budget)) trip.budget = read.budget;
  const s = int(read.stars, 2, 5);     if (s != null) trip.stars = s;

  const add = (Array.isArray(read.addPriorities) ? read.addPriorities : []).filter(p => PRIORITIES.includes(p));
  const del = new Set(Array.isArray(read.removePriorities) ? read.removePriorities : []);
  trip.priorities = [...new Set([...trip.priorities, ...add])].filter(p => !del.has(p)).slice(0, 8);

  const wish = str(read.wishes, 200);
  if (wish && !trip.freeText.toLowerCase().includes(wish.toLowerCase())) {
    trip.freeText = (trip.freeText ? trip.freeText + '; ' : '') + wish;
    trip.freeText = trip.freeText.slice(-400);
  }
  return trip;
}

function missingDatesReply(read, lang, trip) {
  const reply = clean(read?.reply);
  // The model's own question is used when it really asks one; otherwise ours.
  return reply && /[?？]/.test(reply) ? reply : t(lang, trip.checkIn ? 'askCheckout' : 'askWhen', trip);
}

// ── One hotel as a chat message ───────────────────────────────
const SITE = { bookingCom: 'Booking.com', agoda: 'Agoda', expedia: 'Expedia', hotelsCom: 'Hotels.com', tripCom: 'Trip.com' };
const ICON = { yes: '✓', likely: '~', concern: '!', mixed: '±', no: '✕', unknown: '?' };

// The review findings, as one message, for the hotels whose checks changed.
export function reviewMessages(changed, lang, { none = false } = {}) {
  const L = STRINGS[lang] || STRINGS.en;
  if (!changed.length) return none ? [{ type: 'text', text: L.reviewsNone }] : [];
  const blocks = changed.map(h => {
    const ev = (h.needsCheck || []).filter(n => n.evidence === 'reviews');
    const lines = ev.map(n => `${ICON[n.status] || '?'} ${n.need}${n.quote ? ` "${n.quote}"` : ''}${n.note ? ` (${n.note})` : ''}`);
    return `*${h.name}*\n${lines.join('\n')}`;
  });
  return [{ type: 'text', text: `${L.reviewsIntro}\n\n${blocks.join('\n\n')}` }];
}

export function hotelMessage(h, i, lang) {
  const L = STRINGS[lang] || STRINGS.en;
  const cur = h.currency === 'EUR' ? '€' : h.currency === 'USD' ? '$' : h.currency === 'ILS' ? '₪' : (h.currency || '') + ' ';
  const lines = [];

  const stars = h.stars ? ' ' + '★'.repeat(h.stars) : '';
  const rating = h.riScore ? ` · ${h.riScore}/10` : '';
  lines.push(`${i + 1}. *${h.name}*${stars}${rating}`);
  // A rule-based reason is a fixed English sentence: say nothing rather than switch language.
  if (h.matchReason && !(h.matchedBy === 'rules' && lang !== 'en')) lines.push(h.matchReason);

  // The traveller's list: what is confirmed, what guests say, what is open.
  const checks = (h.needsCheck || []).filter(n => n.status !== 'unknown').slice(0, 5).map(n => {
    const said = n.quote ? ` "${n.quote}"` : n.note && n.evidence === 'reviews' ? ` (${n.note})` : '';
    return `${ICON[n.status] || '?'} ${n.need}${said}`;
  });
  if (checks.length) lines.push(checks.join('\n'));
  const open = (h.needsCheck || []).filter(n => n.status === 'unknown').map(n => n.need);
  if (open.length) lines.push(`? ${L.notConfirmed}: ${open.slice(0, 4).join(', ')}`);

  // Prices: the sites we can send them to, cheapest first.
  const priced = Object.keys(SITE).filter(k => h.platforms?.[k]?.price && h.affiliateLinks?.[k])
    .sort((a, b) => h.platforms[a].price - h.platforms[b].price);
  if (priced.length) {
    const best = priced[0];
    const rest = priced.slice(1, 4).map(k => `${SITE[k]} ${cur}${h.platforms[k].price}`).join(' · ');
    lines.push(`${L.from} ${cur}${h.platforms[best].price} ${L.perNight} ${L.on} ${SITE[best]}${rest ? `\n${L.also}: ${rest}` : ''}`);
    const else_ = h.livePrices?.cheaperElsewhere;
    if (else_) lines.push(`${L.cheaperAt} ${else_.official ? L.hotelSite : else_.seller}: ${cur}${else_.price}`);
    lines.push(`${L.book}: ${h.affiliateLinks[best]}`);
  } else if (h.bestPrice?.price) {
    lines.push(`${L.from} ${cur}${h.bestPrice.price} ${L.perNight} (${L.indicative})`);
  }

  const image = h.photos?.main?.url || null;
  return { type: 'hotel', text: lines.join('\n'), image, name: h.name };
}

// ── Fixed phrases ─────────────────────────────────────────────
// Hebrew and English; any other language falls back to English for
// these (the model's own replies are already in the traveller's language).
const STRINGS = {
  en: {
    hello: 'Hi! Tell me where you are going, when, and what matters to you in a hotel. One message is enough.',
    reset: 'Starting fresh. Where to, and when?',
    unavailable: 'I cannot search right now. Please try again in a few minutes.',
    askWhere: 'Where would you like to go?',
    askWhen: (x) => `When are you going to ${x.destination}? Check-in and check-out dates, please.`,
    askCheckout: 'And when do you check out?',
    askWhat: (x) => `${x.destination}, ${fmt(x.checkIn)} to ${fmt(x.checkOut)}. What matters most to you: a quiet room, a pool, the location, a budget? Or just say "search".`,
    searching: (x) => `Looking for hotels in ${x.destination}, ${fmt(x.checkIn)} to ${fmt(x.checkOut)}, for ${x.adults} adult${x.adults === 1 ? '' : 's'}${x.assumedAdults ? ' (tell me if that is wrong)' : ''}. About 20 seconds...`,
    searchFailed: 'Something went wrong with that search. Please try again.',
    nothing: (x) => `I found no hotels I can stand behind in ${x.destination} for those dates. Try other dates or a wider area?`,
    after: 'Want something different? Say "cheaper", "closer to the centre", "with a pool", or ask about one of them.',
    from: 'From', perNight: 'per night', on: 'on', also: 'Also', book: 'Book', indicative: 'indicative',
    notConfirmed: 'Not confirmed', cheaperAt: 'Cheaper seen at', hotelSite: "the hotel's own site",
    reviewsIntro: 'I checked what guests write about what matters to you:', reviewsNone: 'I found no guest reviews that speak to what you asked about.',
  },
  he: {
    hello: 'היי! ספרו לי לאן אתם נוסעים, מתי, ומה חשוב לכם במלון. הודעה אחת מספיקה.',
    reset: 'מתחילים מחדש. לאן, ומתי?',
    unavailable: 'אני לא מצליח לחפש כרגע. נסו שוב בעוד כמה דקות.',
    askWhere: 'לאן תרצו לנסוע?',
    askWhen: (x) => `מתי אתם נוסעים ל${x.destination}? תאריכי הגעה ועזיבה, בבקשה.`,
    askCheckout: 'ומתי אתם עוזבים?',
    askWhat: (x) => `${x.destination}, ${fmt(x.checkIn)} עד ${fmt(x.checkOut)}. מה הכי חשוב לכם: חדר שקט, בריכה, מיקום, תקציב? או פשוט כתבו "חפש".`,
    searching: (x) => `מחפש מלונות ב${x.destination}, ${fmt(x.checkIn)} עד ${fmt(x.checkOut)}, ל-${x.adults} מבוגרים${x.assumedAdults ? ' (תקנו אותי אם זה לא נכון)' : ''}. כ-20 שניות...`,
    searchFailed: 'משהו השתבש בחיפוש. נסו שוב.',
    nothing: (x) => `לא מצאתי מלונות שאני יכול לעמוד מאחוריהם ב${x.destination} בתאריכים האלה. ננסה תאריכים אחרים או אזור רחב יותר?`,
    after: 'רוצים משהו אחר? כתבו "זול יותר", "קרוב יותר למרכז", "עם בריכה", או שאלו על אחד מהם.',
    from: 'החל מ-', perNight: 'ללילה', on: 'ב-', also: 'גם', book: 'להזמנה', indicative: 'מחיר משוער',
    notConfirmed: 'לא אומת', cheaperAt: 'נראה זול יותר ב-', hotelSite: 'אתר המלון',
    reviewsIntro: 'בדקתי מה אורחים כותבים על מה שחשוב לכם:', reviewsNone: 'לא מצאתי ביקורות אורחים שמתייחסות למה שביקשתם.',
  },
};

function t(lang, key, x) {
  const L = STRINGS[lang] || STRINGS.en;
  const v = L[key] ?? STRINGS.en[key];
  // Fixed phrases name the place the way the traveller does.
  const shown = x ? { ...x, destination: (STRINGS[lang] && x.destinationLabel) || x.destination } : {};
  return typeof v === 'function' ? v(shown) : v;
}

function fmt(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return isNaN(d) ? iso : `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
}
function nights(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function today() { return new Date().toISOString().slice(0, 10); }
function clean(s) { return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 500) : ''; }

export const _PRIORITIES = PRIORITIES;
