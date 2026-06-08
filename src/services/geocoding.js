// ─── services/geocoding.js ─────────────────────────────────────
// Converts a destination string (e.g. "Barcelona") into
// { lat, lng, cityName, countryCode } using Google Maps Geocoding API.
//
// Falls back to a built-in city lookup table if no API key.
// Add GOOGLE_MAPS_API_KEY to .env / Railway Variables to enable.
//
// Get your key at: console.cloud.google.com
// Enable: Maps JavaScript API + Geocoding API
// Free credit: $200/month (covers ~40,000 geocoding requests)

// ── Built-in fallback for common cities ───────────────────────
const CITY_COORDS = {
  'barcelona':    { lat: 41.3851, lng: 2.1734,   city: 'Barcelona',    country: 'ES' },
  'madrid':       { lat: 40.4168, lng: -3.7038,  city: 'Madrid',       country: 'ES' },
  'lisbon':       { lat: 38.7169, lng: -9.1399,  city: 'Lisbon',       country: 'PT' },
  'porto':        { lat: 41.1579, lng: -8.6291,  city: 'Porto',        country: 'PT' },
  'rome':         { lat: 41.9028, lng: 12.4964,  city: 'Rome',         country: 'IT' },
  'milan':        { lat: 45.4642, lng: 9.1900,   city: 'Milan',        country: 'IT' },
  'florence':     { lat: 43.7696, lng: 11.2558,  city: 'Florence',     country: 'IT' },
  'paris':        { lat: 48.8566, lng: 2.3522,   city: 'Paris',        country: 'FR' },
  'nice':         { lat: 43.7102, lng: 7.2620,   city: 'Nice',         country: 'FR' },
  'amsterdam':    { lat: 52.3676, lng: 4.9041,   city: 'Amsterdam',    country: 'NL' },
  'london':       { lat: 51.5074, lng: -0.1278,  city: 'London',       country: 'GB' },
  'berlin':       { lat: 52.5200, lng: 13.4050,  city: 'Berlin',       country: 'DE' },
  'munich':       { lat: 48.1351, lng: 11.5820,  city: 'Munich',       country: 'DE' },
  'vienna':       { lat: 48.2082, lng: 16.3738,  city: 'Vienna',       country: 'AT' },
  'prague':       { lat: 50.0755, lng: 14.4378,  city: 'Prague',       country: 'CZ' },
  'budapest':     { lat: 47.4979, lng: 19.0402,  city: 'Budapest',     country: 'HU' },
  'athens':       { lat: 37.9838, lng: 23.7275,  city: 'Athens',       country: 'GR' },
  'santorini':    { lat: 36.3932, lng: 25.4615,  city: 'Santorini',    country: 'GR' },
  'mykonos':      { lat: 37.4467, lng: 25.3289,  city: 'Mykonos',      country: 'GR' },
  'dubai':        { lat: 25.2048, lng: 55.2708,  city: 'Dubai',        country: 'AE' },
  'tel aviv':     { lat: 32.0853, lng: 34.7818,  city: 'Tel Aviv',     country: 'IL' },
  'eilat':        { lat: 29.5577, lng: 34.9519,  city: 'Eilat',        country: 'IL' },
  'new york':     { lat: 40.7128, lng: -74.0060, city: 'New York',     country: 'US' },
  'miami':        { lat: 25.7617, lng: -80.1918, city: 'Miami',        country: 'US' },
  'los angeles':  { lat: 34.0522, lng: -118.2437,city: 'Los Angeles',  country: 'US' },
  'bangkok':      { lat: 13.7563, lng: 100.5018, city: 'Bangkok',      country: 'TH' },
  'tokyo':        { lat: 35.6762, lng: 139.6503, city: 'Tokyo',        country: 'JP' },
  'bali':         { lat: -8.3405, lng: 115.0920, city: 'Bali',         country: 'ID' },
};

// ── Main entry ────────────────────────────────────────────────
export async function geocode(destination) {
  if (!destination) return null;

  // Try Google Maps API first
  if (process.env.GOOGLE_MAPS_API_KEY) {
    try {
      return await geocodeWithGoogle(destination);
    } catch (e) {
      console.warn('[GEOCODE] Google Maps failed, using fallback:', e.message);
    }
  }

  // Fallback: built-in lookup
  return geocodeFallback(destination);
}

// ── Google Maps Geocoding API ─────────────────────────────────
async function geocodeWithGoogle(destination) {
  const encoded = encodeURIComponent(destination);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${process.env.GOOGLE_MAPS_API_KEY}`;

  const res  = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' || !data.results.length) {
    throw new Error(`Geocoding failed: ${data.status}`);
  }

  const result   = data.results[0];
  const location = result.geometry.location;

  // Extract city and country from address components
  let city = '', country = '';
  for (const comp of result.address_components) {
    if (comp.types.includes('locality'))             city    = comp.long_name;
    if (comp.types.includes('country'))              country = comp.short_name;
    if (!city && comp.types.includes('administrative_area_level_1')) city = comp.long_name;
  }

  return {
    lat:     location.lat,
    lng:     location.lng,
    city:    city || destination,
    country: country,
    formatted: result.formatted_address,
  };
}

// ── Fallback: built-in city table ─────────────────────────────
function geocodeFallback(destination) {
  const key = destination.toLowerCase().trim();

  // Exact match
  if (CITY_COORDS[key]) {
    return { ...CITY_COORDS[key], formatted: CITY_COORDS[key].city };
  }

  // Partial match
  for (const [cityKey, coords] of Object.entries(CITY_COORDS)) {
    if (key.includes(cityKey) || cityKey.includes(key)) {
      return { ...coords, formatted: coords.city };
    }
  }

  // Unknown city — return null (caller handles gracefully)
  console.warn(`[GEOCODE] Unknown city: "${destination}" — no coords available`);
  return { lat: null, lng: null, city: destination, country: '', formatted: destination };
}
