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

    // Preferences
    vibes:      Array.isArray(body.vibes)      ? body.vibes      : [],
    priorities: Array.isArray(body.priorities) ? body.priorities : [],
    stars:      Math.min(5, Math.max(0, Number(body.stars) || 0)),
    budget:     body.budget || 'any',

    // Special needs
    specialNeeds: body.specialNeeds || {},

    // Free text
    freeText: (body.freeText || '').trim().slice(0, 2000),
  };

  return { valid: true, quiz };
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
