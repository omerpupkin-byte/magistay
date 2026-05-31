# Magistay Backend

Node.js + Express server that powers the Magistay AI hotel matching engine.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file
cp .env.example .env

# 3. Start the server (mock mode — no API keys needed)
npm run dev

# Server runs at http://localhost:3001
# Health check: http://localhost:3001/health
```

## Modes

| Mode | What it does |
|------|-------------|
| **Mock mode** (default) | Returns realistic hotel data and scoring with no API keys. Perfect for development. |
| **AI mode** | Set `ANTHROPIC_API_KEY` in `.env` — Claude scores hotels and summarises reviews. |
| **Live mode** | Add `BOOKING_API_KEY` + `EXPEDIA_API_KEY` for real hotel data. |

## API

### `POST /api/search`

Send quiz answers, receive matched hotels.

**Request body:**
```json
{
  "adults": 2,
  "children": 0,
  "infants": 1,
  "rooms": 1,
  "destination": "Barcelona",
  "radiusKm": 5,
  "dateFlexibility": "exact",
  "checkIn": "2025-06-12",
  "checkOut": "2025-06-17",
  "budget": "80_150",
  "stars": 4,
  "vibes": ["beach"],
  "priorities": ["breakfast", "crib"],
  "specialNeeds": { "babies": ["crib"] },
  "freeText": "We have an infant and need elevator access throughout."
}
```

**Response:**
```json
{
  "hotels": [
    {
      "id": "bcn-001",
      "name": "Hotel Arts Barcelona",
      "matchScore": 98,
      "matchReason": "Beachfront access, crib confirmed, elevator throughout...",
      "riScore": 8.7,
      "riConfidence": "high",
      "bestPrice": { "platform": "hotelsCom", "price": 128 },
      "bestFlex": { "platform": "bookingCom", "price": 159 },
      "reviews": {
        "loves": [
          { "text": "Stunning sea views", "frequency": "847×", "recency": "month" }
        ],
        "complaints": [
          { "text": "Beach crowded at midday", "frequency": "334×", "recency": "month" }
        ]
      }
    }
  ],
  "meta": {
    "count": 3,
    "destination": "Barcelona",
    "source": "mock"
  }
}
```

## File structure

```
src/
  server.js              # Express app — entry point
  routes/
    search.js            # POST /api/search
  services/
    hotelSearch.js       # Find candidate hotels (mock → real API)
    aiMatcher.js         # Claude scores + explains each hotel
    reviewSummariser.js  # Claude extracts review themes
  data/
    mockHotels.js        # Realistic hotel data for Barcelona, Lisbon, Rome
  utils/
    validateQuiz.js      # Validates + normalises quiz payload
```

## Adding real APIs (when ready)

### Anthropic (Claude)
1. Get key at console.anthropic.com
2. Add to `.env`: `ANTHROPIC_API_KEY=sk-ant-...`
3. Restart server — AI mode activates automatically

### Booking.com
1. Apply at developers.booking.com
2. Add keys to `.env`
3. Uncomment `searchBookingCom()` in `hotelSearch.js`

### Expedia
1. Sign up at developers.expediagroup.com
2. Add keys to `.env`
3. Add `searchExpedia()` function in `hotelSearch.js`

## Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up

# Set environment variables in Railway dashboard
# → Variables → add all keys from .env
```
