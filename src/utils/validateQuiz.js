// ─── utils/validateQuiz.js ─────────────────────────────────────
// Validates and normalises the quiz payload from the frontend.
// Returns { valid, error, quiz } — keeps routes clean.

export function validateQuiz(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  // Required: at least one adult
  const adults = Number(body.adults) || 1;
  if (adults < 1) {
    return { valid: false, error: 'At least 1 adult is required' };
  }

  // Normalise and return clean quiz object
  const quiz = {
    // Travelers
    adults:   adults,
    children: Math.max(0, Number(body.children) || 0),
    infants:  Math.max(0, Number(body.infants)  || 0),
    rooms:    Math.max(1, Number(body.rooms)    || 1),

    // Location
    destination: (body.destination || '').trim(),
    radiusKm:    Math.min(50, Math.max(1, Number(body.radiusKm) || 10)),
    landmark:    (body.landmark || '').trim(),

    // Dates
    dateFlexibility: body.dateFlexibility || 'exact',
    checkIn:         body.checkIn  || null,
    checkOut:        body.checkOut || null,
    nights:          computeNights(body.checkIn, body.checkOut),

    // Who they are and why they travel
    purpose:   cleanList(body.purpose, 6),
    childAges: Array.isArray(body.childAges)
      ? body.childAges.map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 17).slice(0, 10)
      : [],

    // Preferences
    vibes:      cleanList(body.vibes, 12),
    priorities: cleanList(body.priorities, 20),
    stars:      Math.min(5, Math.max(0, Number(body.stars) || 0)),
    budget:     normaliseBudget(body.budget),

    // Special needs — { group: [labels] }
    specialNeeds: cleanNeeds(body.specialNeeds),

    // Free text
    freeText: (body.freeText || '').trim().slice(0, 2000),
  };

  return { valid: true, quiz };
}

// Lists of short labels chosen in the quiz. Anything else is dropped.
function cleanList(value, max) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(v => typeof v === 'string')
    .map(v => v.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, max);
}

function cleanNeeds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [group, items] of Object.entries(value).slice(0, 12)) {
    const list = cleanList(items, 12);
    if (list.length) out[String(group).slice(0, 60)] = list;
  }
  return out;
}

// Accepts the budget keys (u80, 80_150, 150_250, 250plus, any) and also
// the labels older versions of the page sent ("$80 – $150").
export function normaliseBudget(value) {
  const v = String(value || '').toLowerCase();
  if (['u80', '80_150', '150_250', '250plus', 'any'].includes(v)) return v;
  if (/under/.test(v))                      return 'u80';
  if (/250\s*\+|250plus/.test(v))            return '250plus';
  if (/150\D+250/.test(v))                  return '150_250';
  if (/80\D+150/.test(v))                   return '80_150';
  return 'any';
}

function computeNights(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  try {
    const d1 = new Date(checkIn);
    const d2 = new Date(checkOut);
    const nights = Math.round((d2 - d1) / 86_400_000);
    return nights > 0 ? nights : null;
  } catch {
    return null;
  }
}
