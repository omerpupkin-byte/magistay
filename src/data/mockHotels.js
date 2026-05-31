// ─── data/mockHotels.js ────────────────────────────────────────
// Mock hotel data structured identically to the normalised schema
// we'll use when real APIs are connected.
//
// Each hotel object has:
//   id, name, location, city, country, stars,
//   coords { lat, lng },
//   distanceKm (from city center),
//   amenities: string[]
//   pricePerNight: { min, max, currency }
//   platforms: { bookingCom, expedia, agoda, hotelsCom, tripAdvisor, kayak }
//   rawReviews: string[]   ← fed to Claude for summarisation
//   photos: { main, thumb1, thumb2 }

export const MOCK_HOTELS = [

  // ── Barcelona ──────────────────────────────────────────────────
  {
    id: 'bcn-001',
    name: 'Hotel Arts Barcelona',
    location: 'Barceloneta',
    city: 'Barcelona',
    country: 'Spain',
    stars: 5,
    coords: { lat: 41.3851, lng: 2.1966 },
    distanceKm: 1.2,
    amenities: [
      'pool', 'spa', 'gym', 'beach_access', 'breakfast', 'restaurant',
      'elevator', 'crib', 'late_checkout', 'free_cancellation', 'sea_view',
      'bar', 'concierge', 'rooftop', 'wheelchair_accessible'
    ],
    pricePerNight: { min: 110, max: 180, currency: 'USD' },
    platforms: {
      bookingCom:  { score: 9.2, reviews: 6840, price: 144, flexible: 159, flexTerms: 'Free cancel 48h · Pay at hotel' },
      expedia:     { score: 8.7, reviews: 4120, price: 142, flexible: 163, flexTerms: 'Free cancel 72h · Pay now' },
      agoda:       { score: 8.8, reviews: 3210, price: 133, flexible: null, flexTerms: null },
      hotelsCom:   { score: 8.6, reviews: 2100, price: 128, flexible: 171, flexTerms: 'Free cancel 48h · Pay now' },
      tripAdvisor: { score: 8.5, reviews: 1690, price: 119, flexible: null, flexTerms: null },
      kayak:       { score: 8.4, reviews: 980,  price: 138, flexible: null, flexTerms: null },
    },
    rawReviews: [
      'The sea view from our room was absolutely stunning. Worth every penny.',
      'Staff were exceptional — proactive, warm and remembered our names from day one.',
      'Breakfast buffet had an incredible variety. Fresh seafood every morning.',
      'Beach crowded at midday but the hotel pool is a great alternative.',
      'Parking is very limited and extremely expensive — use public transport.',
      'Pool fills up fast in summer. Get there before 9am.',
      'Our baby crib was ready and perfectly set up when we arrived.',
      'The elevator access throughout made it very easy with a pushchair.',
      'Room was a good size with beautiful modern design.',
      'Check-in had a queue during peak afternoon hours.',
      'Free cancellation made booking stress-free. Great flexibility.',
      'The spa was world-class. Booked the couples package — highly recommend.',
    ],
    photos: {
      main:   { bg: '#C4D8B8', label: 'Pool & terrace', textColor: '#3a5a2a' },
      thumb1: { bg: '#B4C8D8', label: 'Sea view room',  textColor: '#1a3a5a' },
      thumb2: { bg: '#D8C8B4', label: 'Lobby',          textColor: '#5a3a1a' },
    },
  },

  {
    id: 'bcn-002',
    name: 'Yurbban Passage Hotel',
    location: 'El Born',
    city: 'Barcelona',
    country: 'Spain',
    stars: 4,
    coords: { lat: 41.3844, lng: 2.1802 },
    distanceKm: 0.6,
    amenities: [
      'breakfast', 'rooftop', 'bar', 'elevator', 'crib',
      'walkable', 'free_cancellation'
    ],
    pricePerNight: { min: 90, max: 150, currency: 'USD' },
    platforms: {
      bookingCom:  { score: 8.7, reviews: 1920, price: 115, flexible: 138, flexTerms: 'Free cancel 24h · Pay at hotel' },
      expedia:     { score: 7.6, reviews: 420,  price: 118, flexible: 131, flexTerms: 'Free cancel 48h · Pay now' },
      agoda:       { score: 7.9, reviews: 640,  price: 109, flexible: null, flexTerms: null },
      hotelsCom:   { score: 7.4, reviews: 390,  price: 121, flexible: 144, flexTerms: 'Free cancel 72h · Pay now' },
      tripAdvisor: { score: 7.2, reviews: 310,  price: 114, flexible: null, flexTerms: null },
      kayak:       { score: 7.0, reviews: 180,  price: 107, flexible: null, flexTerms: null },
    },
    rawReviews: [
      'Absolutely loved the boutique feel and unique design throughout.',
      'Location in El Born is perfect — everything within walking distance.',
      'The rooftop bar at sunset is a highlight. Stunning city views.',
      'Rooms are on the small side — felt tight with a travel cot.',
      'Street noise can be loud until midnight. Bring earplugs.',
      'No pool on site which was a slight disappointment.',
      'Breakfast was freshly prepared and excellent quality.',
      'Staff were friendly and full of great local recommendations.',
      'Very good value for the location and quality.',
    ],
    photos: {
      main:   { bg: '#C8C0D8', label: 'Rooftop terrace', textColor: '#3a2a5a' },
      thumb1: { bg: '#D8CEB8', label: 'Room',            textColor: '#5a4a1a' },
      thumb2: { bg: '#B8D0C8', label: 'Rooftop bar',     textColor: '#1a4a3a' },
    },
  },

  {
    id: 'bcn-003',
    name: 'H10 Metropolitan',
    location: 'Eixample',
    city: 'Barcelona',
    country: 'Spain',
    stars: 4,
    coords: { lat: 41.3901, lng: 2.1535 },
    distanceKm: 2.1,
    amenities: [
      'pool', 'rooftop', 'gym', 'breakfast', 'restaurant', 'elevator',
      'parking', 'free_cancellation'
    ],
    pricePerNight: { min: 75, max: 130, currency: 'USD' },
    platforms: {
      bookingCom:  { score: 8.2, reviews: 880, price: 102, flexible: 114, flexTerms: 'Free cancel 72h · Pay now' },
      expedia:     { score: 7.1, reviews: 160, price: 106, flexible: 118, flexTerms: 'Free cancel 48h · Pay now' },
      agoda:       { score: 7.4, reviews: 210, price: 109, flexible: null, flexTerms: null },
      hotelsCom:   { score: 6.8, reviews: 95,  price: 103, flexible: null, flexTerms: null },
      tripAdvisor: { score: 6.4, reviews: 68,  price: 101, flexible: null, flexTerms: null },
      kayak:       { score: 6.0, reviews: 42,  price: 97,  flexible: null, flexTerms: null },
    },
    rawReviews: [
      'Rooftop pool has spectacular city views. Best feature of the hotel.',
      'Great value for money in this category.',
      'Good base for exploring Eixample and nearby.',
      'Room quality was inconsistent — ours was fine, neighbour complained.',
      'Check-in had long queues during peak afternoon hours.',
      'Wi-Fi was unreliable in some rooms.',
      'Breakfast was decent but nothing special.',
      'Pool area can get crowded in summer.',
    ],
    photos: {
      main:   { bg: '#B8D4C8', label: 'Rooftop pool', textColor: '#1a4a2a' },
      thumb1: { bg: '#D4D0C8', label: 'Room',         textColor: '#3a3630' },
      thumb2: { bg: '#C8D8B4', label: 'Pool deck',    textColor: '#2a4a1a' },
    },
  },

  // ── Lisbon ─────────────────────────────────────────────────────
  {
    id: 'lis-001',
    name: 'Bairro Alto Hotel',
    location: 'Bairro Alto',
    city: 'Lisbon',
    country: 'Portugal',
    stars: 5,
    coords: { lat: 38.7139, lng: -9.1435 },
    distanceKm: 0.8,
    amenities: [
      'pool', 'spa', 'rooftop', 'breakfast', 'restaurant', 'bar',
      'elevator', 'crib', 'concierge', 'free_cancellation', 'sea_view'
    ],
    pricePerNight: { min: 280, max: 420, currency: 'USD' },
    platforms: {
      bookingCom:  { score: 9.6, reviews: 2840, price: 320, flexible: 360, flexTerms: 'Free cancel 48h · Pay at hotel' },
      expedia:     { score: 9.4, reviews: 1210, price: 310, flexible: 345, flexTerms: 'Free cancel 72h · Pay now' },
      agoda:       { score: 9.3, reviews: 890,  price: 305, flexible: null, flexTerms: null },
      hotelsCom:   { score: 9.1, reviews: 620,  price: 298, flexible: null, flexTerms: null },
      tripAdvisor: { score: 9.5, reviews: 1890, price: 315, flexible: null, flexTerms: null },
      kayak:       { score: 9.2, reviews: 430,  price: 309, flexible: null, flexTerms: null },
    },
    rawReviews: [
      'One of the most beautiful hotels I have ever stayed in. Flawless.',
      'Staff remembered every preference from our first interaction.',
      'The rooftop views over Lisbon and the Tagus are breathtaking.',
      'Breakfast is a work of art. The pastéis de nata alone are worth it.',
      'Room was immaculate and incredibly well-designed.',
      'Crib was set up perfectly before we arrived with our infant.',
      'Price is high but genuinely worth every cent.',
      'The spa is exceptional — book in advance as slots fill quickly.',
    ],
    photos: {
      main:   { bg: '#D4C8B4', label: 'Rooftop terrace', textColor: '#3a2a14' },
      thumb1: { bg: '#C4D0C8', label: 'Suite',           textColor: '#1a3a2a' },
      thumb2: { bg: '#C0C8D8', label: 'Pool',            textColor: '#1a2a3a' },
    },
  },

  {
    id: 'lis-002',
    name: 'Hotel do Bairro',
    location: 'Príncipe Real',
    city: 'Lisbon',
    country: 'Portugal',
    stars: 4,
    coords: { lat: 38.7162, lng: -9.1481 },
    distanceKm: 1.1,
    amenities: [
      'breakfast', 'bar', 'elevator', 'crib', 'walkable',
      'free_cancellation', 'restaurant', 'concierge'
    ],
    pricePerNight: { min: 140, max: 220, currency: 'USD' },
    platforms: {
      bookingCom:  { score: 9.1, reviews: 1340, price: 168, flexible: 189, flexTerms: 'Free cancel 24h · Pay at hotel' },
      expedia:     { score: 8.8, reviews: 560,  price: 162, flexible: 181, flexTerms: 'Free cancel 48h · Pay now' },
      agoda:       { score: 8.9, reviews: 420,  price: 155, flexible: null, flexTerms: null },
      hotelsCom:   { score: 8.6, reviews: 310,  price: 158, flexible: null, flexTerms: null },
      tripAdvisor: { score: 9.0, reviews: 780,  price: 165, flexible: null, flexTerms: null },
      kayak:       { score: 8.7, reviews: 220,  price: 152, flexible: null, flexTerms: null },
    },
    rawReviews: [
      'Charming boutique hotel in the heart of Príncipe Real.',
      'Breakfast was exceptional — local produce, beautifully presented.',
      'Staff went above and beyond for our family, especially with the baby.',
      'Perfect location for exploring Alfama and Bairro Alto on foot.',
      'Rooms are a good size with lovely Lisbon-inspired décor.',
      'Crib was clean and safe — no issues at all with our infant.',
      'The bar serves great local wines and cocktails.',
    ],
    photos: {
      main:   { bg: '#D8C8B8', label: 'Terrace garden', textColor: '#3a2a18' },
      thumb1: { bg: '#C8D4C0', label: 'Room',           textColor: '#2a3a1a' },
      thumb2: { bg: '#D0C8D8', label: 'Bar',            textColor: '#3a2a3a' },
    },
  },

  // ── Rome ───────────────────────────────────────────────────────
  {
    id: 'rom-001',
    name: 'Hotel de Russie',
    location: 'Piazza del Popolo',
    city: 'Rome',
    country: 'Italy',
    stars: 5,
    coords: { lat: 41.9088, lng: 12.4779 },
    distanceKm: 1.4,
    amenities: [
      'pool', 'spa', 'gym', 'garden', 'breakfast', 'restaurant', 'bar',
      'elevator', 'crib', 'late_checkout', 'free_cancellation', 'concierge'
    ],
    pricePerNight: { min: 380, max: 650, currency: 'USD' },
    platforms: {
      bookingCom:  { score: 9.4, reviews: 3210, price: 450, flexible: 510, flexTerms: 'Free cancel 48h · Pay at hotel' },
      expedia:     { score: 9.3, reviews: 1440, price: 440, flexible: 495, flexTerms: 'Free cancel 72h · Pay now' },
      agoda:       { score: 9.1, reviews: 880,  price: 430, flexible: null, flexTerms: null },
      hotelsCom:   { score: 9.2, reviews: 720,  price: 435, flexible: null, flexTerms: null },
      tripAdvisor: { score: 9.5, reviews: 2890, price: 445, flexible: null, flexTerms: null },
      kayak:       { score: 9.0, reviews: 560,  price: 428, flexible: null, flexTerms: null },
    },
    rawReviews: [
      'Possibly the most beautiful hotel garden in Rome. Magical.',
      'Staff service is flawlessly discreet and anticipatory.',
      'The spa is world-class. Perfect for a romantic stay.',
      'Walking distance to Spanish Steps and Villa Borghese.',
      'Pool is small but exclusive — rarely crowded.',
      'Breakfast is a celebration. The pastries are extraordinary.',
      'An anniversary celebration made unforgettable by the team here.',
      'Price is very high, but the experience justifies it completely.',
    ],
    photos: {
      main:   { bg: '#D4C8A4', label: 'Secret garden', textColor: '#3a3014' },
      thumb1: { bg: '#C8D0BC', label: 'Suite',         textColor: '#1a3a14' },
      thumb2: { bg: '#D0C4C8', label: 'Spa pool',      textColor: '#3a1a2a' },
    },
  },

];

// ── Helper: get hotels by city ─────────────────────────────────
export function getHotelsByCity(city) {
  const normalised = city.toLowerCase().trim();
  return MOCK_HOTELS.filter(h =>
    h.city.toLowerCase().includes(normalised) ||
    normalised.includes(h.city.toLowerCase())
  );
}

// ── Helper: compute RI score ───────────────────────────────────
// Weights score by review volume.
// A 9.2 from 40 reviews is NOT the same as 8.8 from 6,000.
export function computeRI(platforms) {
  const entries = Object.values(platforms).filter(p => p.score && p.reviews);
  if (entries.length === 0) return { score: null, confidence: 'none', totalReviews: 0 };

  const totalReviews = entries.reduce((sum, p) => sum + p.reviews, 0);
  const weightedSum  = entries.reduce((sum, p) => sum + p.score * p.reviews, 0);
  const riScore      = Math.round((weightedSum / totalReviews) * 10) / 10;

  let confidence;
  if      (totalReviews >= 5000) confidence = 'high';
  else if (totalReviews >= 1000) confidence = 'moderate';
  else                           confidence = 'low';

  return { score: riScore, confidence, totalReviews };
}
