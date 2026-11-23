// ─── services/questions.js ─────────────────────────────────────
// The questionnaire: every option the website offers, asked in the chat
// in the traveller's language (English or Hebrew, with the same content),
// and only when the answers so far make that group relevant.
//
// Each option says what it does to the search:
//   priority: a must-have the matcher checks against the hotel's data
//   wish:     a need the matcher checks against reviews
//   cancellation / rooms / budget / stars / purpose / vibes: set on the trip
//
// A test keeps the options equal to the website's, and every question
// has both languages.

export const SITE = {
  purpose:   ['Family holiday', "Couple's getaway", 'Honeymoon / anniversary', "Friends' trip", 'Solo trip', 'Business', 'Celebration'],
  vibe:      ['Beach & relax', 'City exploration', 'Culture & history', 'Nature & hiking', 'Romantic getaway', 'Spa & wellness', 'Nightlife'],
  mustHaves: ['Walkable location', 'Breakfast included', 'Pool', 'Free cancellation', 'Sea view', 'Quiet area', 'Spa on site', 'Parking', 'Rooftop terrace', 'Beach access', 'Late checkout'],
  access:    ['No stairs (elevator required)', 'Wheelchair accessible', 'Roll-in shower', 'Ground floor room', 'Wide doorways'],
  babies:    ['Crib / cot available', 'Highchair in restaurant', "Children's pool", 'Kids club', 'Babysitting service', 'Child-proof balcony'],
  sleep:     ['Pillow menu', 'Hypoallergenic bedding', 'Blackout curtains', 'Soundproofed rooms', 'No feather products'],
  dining:    ['Restaurant on site', 'Vegetarian / vegan options', 'Kosher meals', 'Halal meals', 'Fine dining', '24h room service'],
  other:     ['Pet friendly', 'EV charging', 'Fast Wi-Fi (100+ Mbps)', 'Early check-in', 'Laundry service', 'Concierge service'],
  stars:     ['5', '4', '3', 'Any'],
  budget:    ['Under $80', '$80 – $150', '$150 – $250', '$250+', 'No limit'],
};

// Both languages for every option. The English is the website's own wording.
const HE = {
  'Family holiday': 'טיול משפחתי', "Couple's getaway": 'טיול זוגי', 'Honeymoon / anniversary': 'ירח דבש / יום נישואין',
  "Friends' trip": 'טיול חברים', 'Solo trip': 'טיול solo', 'Business': 'עסקים', 'Celebration': 'חגיגה',
  'Beach & relax': 'חוף ורוגע', 'City exploration': 'גילוי העיר', 'Culture & history': 'תרבות והיסטוריה',
  'Nature & hiking': 'טבע וטיולים', 'Romantic getaway': 'רומנטי', 'Spa & wellness': 'ספא ובריאות', 'Nightlife': 'חיי לילה',
  'Walkable location': 'מיקום שמגיעים אליו ברגל', 'Breakfast included': 'ארוחת בוקר כלולה', 'Pool': 'בריכה',
  'Free cancellation': 'ביטול חינם', 'Sea view': 'נוף לים', 'Quiet area': 'אזור שקט', 'Spa on site': 'ספא במקום',
  'Parking': 'חניה', 'Rooftop terrace': 'מרפסת גג', 'Beach access': 'גישה לחוף', 'Late checkout': "צ'ק-אאוט מאוחר",
  'No stairs (elevator required)': 'בלי מדרגות (מעלית)', 'Wheelchair accessible': 'נגיש לכיסא גלגלים', 'Roll-in shower': 'מקלחת ללא מדרגה',
  'Ground floor room': 'חדר בקומת קרקע', 'Wide doorways': 'פתחים רחבים',
  'Crib / cot available': 'עריסה / מיטת תינוק', 'Highchair in restaurant': 'כסא תינוק במסעדה', "Children's pool": 'בריכת ילדים',
  'Kids club': 'מועדון ילדים', 'Babysitting service': 'שמרטף', 'Child-proof balcony': 'מרפסת בטוחה לילדים',
  'Pillow menu': 'תפריט כריות', 'Hypoallergenic bedding': 'מצעים לאלרגיה', 'Blackout curtains': 'וילונות האפלה',
  'Soundproofed rooms': 'חדרים מבודדים מרעש', 'No feather products': 'בלי מוצרי נוצה',
  'Restaurant on site': 'מסעדה במקום', 'Vegetarian / vegan options': 'אפשרויות צמחוניות / טבעוניות', 'Kosher meals': 'כשר',
  'Halal meals': 'חלאל', 'Fine dining': 'מסעדת שף', '24h room service': 'שירות חדרים 24 שעות',
  'Pet friendly': 'מקבל חיות מחמד', 'EV charging': 'טעינה לרכב חשמלי', 'Fast Wi-Fi (100+ Mbps)': 'אינטרנט מהיר (100+ Mbps)',
  'Early check-in': "צ'ק-אין מוקדם", 'Laundry service': 'שירות כביסה', 'Concierge service': "קונסיירז'",
};
export const label = (option, lang) => (lang === 'he' ? HE[option] || option : option);

// What each option means for the search.
const MEANS = {
  'Walkable location':            { wish: 'walkable location' },
  'Breakfast included':           { priority: 'Breakfast included' },
  'Pool':                         { priority: 'Pool' },
  'Free cancellation':            { priority: 'Free cancellation', cancellation: 'free' },
  'Sea view':                     { wish: 'sea view' },
  'Quiet area':                   { wish: 'quiet area' },
  'Spa on site':                  { priority: 'Spa' },
  'Parking':                      { priority: 'Parking' },
  'Rooftop terrace':              { priority: 'Rooftop' },
  'Beach access':                 { priority: 'Beach access' },
  'Late checkout':                { priority: 'Late check-out' },
  'No stairs (elevator required)': { priority: 'Elevator' },
  'Wheelchair accessible':        { priority: 'Wheelchair accessible' },
  'Roll-in shower':               { wish: 'roll-in shower' },
  'Ground floor room':            { wish: 'ground floor room' },
  'Wide doorways':                { wish: 'wide doorways' },
  'Crib / cot available':         { priority: 'Crib / cot available' },
  'Highchair in restaurant':      { wish: 'highchair in restaurant' },
  "Children's pool":              { priority: 'Kids pool' },
  'Kids club':                    { priority: 'Kids club' },
  'Babysitting service':          { wish: 'babysitting service' },
  'Child-proof balcony':          { wish: 'child-proof balcony' },
  'Pillow menu':                  { wish: 'pillow menu' },
  'Hypoallergenic bedding':       { wish: 'hypoallergenic bedding' },
  'Blackout curtains':            { wish: 'blackout curtains' },
  'Soundproofed rooms':           { wish: 'soundproofed rooms' },
  'No feather products':          { wish: 'no feather products' },
  'Restaurant on site':           { wish: 'restaurant on site' },
  'Vegetarian / vegan options':   { wish: 'vegetarian or vegan options' },
  'Kosher meals':                 { wish: 'kosher meals' },
  'Halal meals':                  { wish: 'halal meals' },
  'Fine dining':                  { wish: 'fine dining' },
  '24h room service':             { wish: '24h room service' },
  'Pet friendly':                 { priority: 'Pet friendly' },
  'EV charging':                  { wish: 'EV charging' },
  'Fast Wi-Fi (100+ Mbps)':       { wish: 'fast Wi-Fi' },
  'Early check-in':               { priority: 'Early check-in' },
  'Laundry service':              { wish: 'laundry service' },
  'Concierge service':            { wish: 'concierge service' },
};

// Single-choice questions: value is what the search uses.
const CHOICES = {
  rooms:  [{ value: 1, en: '1', he: '1' }, { value: 2, en: '2', he: '2' }, { value: 3, en: '3 or more', he: '3 ומעלה' }],
  budget: [
    { value: 'u80', en: 'Under $80', he: 'עד 80' }, { value: '80_150', en: '$80 – $150', he: '80 עד 150' },
    { value: '150_250', en: '$150 – $250', he: '150 עד 250' }, { value: '250plus', en: '$250+', he: 'מעל 250' },
    { value: 'any', en: 'No limit', he: 'לא משנה' },
  ],
  stars:  [
    { value: 5, en: '5 stars', he: '5 כוכבים' }, { value: 4, en: '4 stars', he: '4 כוכבים' },
    { value: 3, en: '3 stars', he: '3 כוכבים' }, { value: 0, en: 'Any', he: 'לא משנה' },
  ],
};

const MULTI_HINT = { en: 'Pick as many as you like, or say "next" to skip.', he: 'אפשר כמה, או "הבא" לדלג.' };
const NONE_WORD  = { en: /(^|\s)(none|no|nothing)(\s|$|[.,!])/i, he: /(^|\s)(אין|לא)(\s|$|[.,!])/i };
const young = (t) => (t.childAges || []).some(a => a < 3) || (t.infants || 0) > 0;
const kids  = (t) => (t.children || 0) + (t.infants || 0) > 0;

// The questions, in the order they are asked. `when` decides relevance.
export const QUESTIONS = [
  { id: 'ages', kind: 'text', when: t => (t.children || 0) > 0 && (t.childAges || []).length < (t.children || 0),
    text: { en: 'How old is each child? (under 2 counts as 0 or 1)', he: 'כמה שנים לכל ילד? (תינוק מתחת לשנתיים: 0 או 1)' } },

  { id: 'rooms', kind: 'single', when: () => true, choices: CHOICES.rooms,
    text: { en: 'How many rooms do you need?', he: 'כמה חדרים צריך?' },
    apply: (v) => ({ rooms: v[0] }) },

  { id: 'purpose', kind: 'multi', when: () => true, options: SITE.purpose, single: true,
    text: { en: 'What kind of trip is it?', he: 'איזה סוג נסיעה זו?' },
    apply: (v) => ({ purpose: v }) },

  { id: 'babies', kind: 'multi', when: young, options: SITE.babies,
    text: { en: 'There is a baby or toddler. What matters for them?', he: 'יש תינוק או פעוט. מה חשוב לו?' },
    apply: (v) => fromMeans(v) },

  { id: 'kids', kind: 'multi', when: t => kids(t) && !young(t), options: ["Children's pool", 'Kids club', 'Babysitting service'],
    text: { en: 'What will the kids enjoy?', he: 'מה הילדים יאהבו?' },
    apply: (v) => fromMeans(v) },

  { id: 'access', kind: 'multi', when: () => true, options: SITE.access, none: true,
    text: { en: 'Does anyone need accessibility?', he: 'האם מישהו בקבוצה זקוק להתאמות נגישות?' },
    apply: (v) => fromMeans(v) },

  { id: 'must', kind: 'multi', when: () => true, options: SITE.mustHaves,
    text: { en: 'What must the hotel have?', he: 'מה חייב להיות במלון?' },
    apply: (v) => fromMeans(v) },

  { id: 'budget', kind: 'single', when: t => t.budget === 'any', choices: CHOICES.budget,
    text: { en: 'What can you spend per night (taxes included)?', he: 'כמה מוכנים לשלם ללילה (כולל מסים)?' },
    apply: (v) => ({ budget: v[0] }) },

  { id: 'stars', kind: 'single', when: t => !t.stars, choices: CHOICES.stars,
    text: { en: 'What is the minimum star rating?', he: 'מה דירוג הכוכבים המינימלי?' },
    apply: (v) => ({ stars: v[0] }) },

  { id: 'vibe', kind: 'multi', when: () => true, options: SITE.vibe,
    text: { en: 'What kind of holiday vibe?', he: 'איזה סגנון חופשה?' },
    apply: (v) => ({ vibes: v }) },

  { id: 'sleep', kind: 'multi', when: () => true, options: SITE.sleep, none: true,
    text: { en: 'Sleep and room comfort?', he: 'שינה ונוחות בחדר?' },
    apply: (v) => fromMeans(v) },

  { id: 'dining', kind: 'multi', when: () => true, options: SITE.dining, none: true,
    text: { en: 'Food and dining?', he: 'אוכל והעדפות?' },
    apply: (v) => fromMeans(v) },

  { id: 'other', kind: 'multi', when: () => true, options: SITE.other, none: true,
    text: { en: 'Anything else that matters?', he: 'עוד דברים שחשובים?' },
    apply: (v) => fromMeans(v) },
];

// What the picked options do to the trip.
function fromMeans(picked) {
  const change = { priorities: [], wishes: [], cancellation: null };
  for (const p of picked) {
    const m = MEANS[p];
    if (!m) continue;
    if (m.priority) change.priorities.push(m.priority);
    if (m.wish) change.wishes.push(m.wish);
    if (m.cancellation) change.cancellation = m.cancellation;
  }
  return change;
}

// The next question, given what is known and what was already asked.
export function nextQuestion(trip, asked = new Set()) {
  return QUESTIONS.find(q => !asked.has(q.id) && q.when(trip)) || null;
}

// Apply the traveller's answer to the trip.
export function applyAnswer(trip, question, picked) {
  if (!question || question.id === 'ages') return trip;
  const change = question.apply ? question.apply(picked) : {};
  if (change.priorities?.length) trip.priorities = [...new Set([...trip.priorities, ...change.priorities])].slice(0, 12);
  if (change.wishes?.length) trip.freeText = [trip.freeText, ...change.wishes].filter(Boolean).join('; ').slice(-400);
  if (change.cancellation) trip.cancellation = change.cancellation;
  for (const k of ['budget', 'stars', 'rooms', 'purpose', 'vibes']) if (change[k] != null) trip[k] = change[k];
  return trip;
}

// Read the answer in either language. Numbers pick by position; the option's
// own words (English or Hebrew) pick by name; "none" for the optional groups.
export function pickOptions(question, text, lang = 'en') {
  const t = String(text || '').toLowerCase().trim();
  if (question.kind === 'text') return [String(text || '').trim()];
  if (question.none && (NONE_WORD.en.test(t) || NONE_WORD.he.test(t))) return [];

  if (question.choices) {
    const n = Number(t.match(/^\d+$/)?.[0]);
    if (n >= 1 && n <= question.choices.length) return [question.choices[n - 1].value];
    const hit = question.choices.find(c => [c.en, c.he].some(w => t.includes(w.toLowerCase())));
    return hit ? [hit.value] : [];
  }

  const options = question.options || [];
  const numbers = (t.match(/\d+/g) || []).map(Number);
  const byNumber = numbers.filter(n => n >= 1 && n <= options.length).map(n => options[n - 1]);
  if (question.single) {
    const hit = options.find(o => t.includes(o.toLowerCase()) || (HE[o] && t.includes(HE[o].toLowerCase())));
    return hit ? [hit] : byNumber.slice(0, 1);
  }
  const named = options.filter(o => t.includes(o.toLowerCase()) || (HE[o] && t.includes(HE[o].toLowerCase())));
  return [...new Set([...byNumber, ...named])];
}

// The question as a chat message: numbered, the same in both languages.
export function questionText(q, lang = 'en') {
  const L = lang === 'he' ? 'he' : 'en';
  if (q.kind === 'text') return q.text[L];
  const items = q.choices ? q.choices.map(c => c[L]) : q.options.map(o => label(o, L));
  const hint = q.kind === 'text' ? '' : q.kind === 'single' || q.single ? (L === 'he' ? '(אפשר לענות במספר או במילים)' : '(answer with a number or the words)') : `(${MULTI_HINT[L]}${q.none ? (L === 'he' ? ' או "אין"' : ' or "none"') : ''})`;
  return `${q.text[L]}\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n${hint}`;
}

// Every website option, covered by a question (budget and stars by their values).
export function coveredOptions() {
  const out = new Set();
  for (const q of QUESTIONS) {
    for (const o of q.options || []) out.add(o);
    for (const c of q.choices || []) out.add(c.en);
  }
  return out;
}
export function siteOptionCovered(option) {
  return coveredOptions().has(option) || (option === '5' || option === '4' || option === '3' || option === 'Any');
}
