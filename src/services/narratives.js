// ─── services/narratives.js ────────────────────────────────────
// What guests keep saying, over a set of reviews: recurring themes, how
// often they come up, whether they are good or bad, and how recent they
// are. Rough by design (keywords, not meaning): it finds the subjects
// guests return to, and Claude reads the quotes for what they actually say.

const THEMES = {
  'שקט בלילה':          { words: /\b(quiet|silent|noise|noisy|loud|thin walls|street noise|sleep)\b/i, good: /\b(quiet|silent|slept|peaceful)\b/i, bad: /\b(noise|noisy|loud|thin walls|couldn'?t sleep|heard)\b/i },
  'מיטה ושינה':         { words: /\b(bed|mattress|pillow|sheets)\b/i, good: /\b(comfortable|comfy|great bed|soft)\b/i, bad: /\b(uncomfortable|hard bed|lumpy|saggy|firm)\b/i },
  'ניקיון':             { words: /\b(clean|dirty|smell|smelled|hygiene|dust)\b/i, good: /\b(clean|spotless|immaculate)\b/i, bad: /\b(dirty|smell|stain|dust|hair)\b/i },
  'צוות':               { words: /\b(staff|reception|receptionist|concierge|service)\b/i, good: /\b(friendly|helpful|kind|lovely|excellent service)\b/i, bad: /\b(rude|unhelpful|slow|ignored)\b/i },
  'מיקום':              { words: /\b(location|central|walk|walking distance|metro|subway)\b/i, good: /\b(central|great location|walking distance|close to)\b/i, bad: /\b(far from|remote|no metro)\b/i },
  'בריכה וספא':         { words: /\b(pool|spa|jacuzzi|sauna)\b/i, good: /\b(great pool|lovely pool|amazing spa|pool was)\b/i, bad: /\b(pool was closed|crowded pool|small pool)\b/i },
  'ארוחת בוקר':         { words: /\b(breakfast|buffet)\b/i, good: /\b(great breakfast|excellent breakfast|good breakfast)\b/i, bad: /\b(poor breakfast|limited breakfast|overpriced breakfast)\b/i },
  'נגישות':             { words: /\b(wheelchair|accessible|lift|elevator|stairs)\b/i, good: /\b(accessible|elevator|lift worked)\b/i, bad: /\b(not accessible|no lift|no elevator|stairs only)\b/i },
  'משפחה וילדים':       { words: /\b(kids|children|child|family|crib|cot|baby)\b/i, good: /\b(kids loved|family friendly|great for kids|crib)\b/i, bad: /\b(not for kids|no crib|no cot)\b/i },
  'חדר ותצוגה':         { words: /\b(room|view|balcony|window|blackout|curtain|curtains)\b/i, good: /\b(great view|spacious|blackout|curtains kept)\b/i, bad: /\b(small room|tiny|no blackout|bright|light came)\b/i },
};

// Google's relative date ("a month ago", "3 years ago") as months.
export function monthsAgo(when) {
  const s = String(when || '').toLowerCase();
  if (/\bjust now|today|yesterday|a few days|days? ago|a week|weeks? ago/.test(s)) return 0.5;
  const n = Number((s.match(/(\d+)\s+month/) || [])[1]);
  if (n) return n;
  if (/\ba month\b/.test(s)) return 1;
  const y = Number((s.match(/(\d+)\s+year/) || [])[1]);
  if (y) return y * 12;
  if (/\ban? year\b/.test(s)) return 12;
  return null;
}

// reviews: [{ text, when, rating }]
// returns themes sorted by how often guests raise them, with recent share.
export function narratives(reviews, { recentMonths = 12 } = {}) {
  const out = [];
  const total = reviews.length;
  for (const [theme, rule] of Object.entries(THEMES)) {
    const hits = reviews.filter(r => rule.words.test(r.text || ''));
    if (hits.length < 2) continue;                  // one guest is an anecdote
    // A review that praises the subject counts as praise, even if it also says "no noise".
    const good = hits.filter(r => rule.good.test(r.text)).length;
    const bad  = hits.filter(r => !rule.good.test(r.text) && rule.bad.test(r.text)).length;
    const dated = hits.map(r => monthsAgo(r.when)).filter(m => m != null);
    const recent = dated.filter(m => m <= recentMonths).length;
    out.push({
      theme, mentions: hits.length, outOf: total,
      positive: good, negative: bad,
      stance: bad > good ? 'mostly negative' : good > bad ? 'mostly positive' : 'mixed',
      recentShare: dated.length ? Math.round(100 * recent / dated.length) : null,
      recent: dated.length ? recent : null,
    });
  }
  return out.sort((a, b) => b.mentions - a.mentions || (b.recentShare ?? 0) - (a.recentShare ?? 0));
}
