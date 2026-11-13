# Magistay

A hotel matcher. The traveller answers a short quiz (who is coming, why, where, when, what matters); the server finds hotels with rooms on those dates, checks each one against the traveller's list, and returns the best five — each with a reason, a need-by-need checklist and booking links that carry our affiliate ids.

- `magistay.html` — the whole site (served by Vercel at magistay.com)
- `src/` — the API server (runs on Railway)

## Run it locally

```bash
npm install
cp .env.example .env      # fill in the keys you have
npm run dev               # http://localhost:3001  ·  health: /health
npm test                  # no keys or network needed
```

Open `magistay.html` through a local web server (for example `python -m http.server 8080`, then http://localhost:8080/magistay.html). Opened from `localhost`, the page talks to the local server; anywhere else it talks to Railway.

## Where the hotels come from

`src/services/hotelSearch.js` picks the first source that returns hotels:

| Source | Needs | What it gives |
|---|---|---|
| Booking.com Demand API | `BOOKING_API_KEY` (Managed Affiliate Partners only — not approved yet) | — |
| Expedia Rapid API | `EXPEDIA_API_KEY` (not approved yet) | — |
| **Hotelbeds** | `HOTELBEDS_API_KEY` + `HOTELBEDS_API_SECRET` | Live availability, wholesale rates, photos, facilities, TripAdvisor rating |
| **AI suggestions** | `ANTHROPIC_API_KEY` | Well-known hotels from the model's general knowledge. No price, no availability, no rating. Used when a supplier has nothing for the destination or is down. |
| Demo data | nothing | Built-in sample hotels, for development without any keys |

The response says which one was used in `meta.source`, and the page tells the traveller.

## Live prices per booking platform

`src/services/livePrices.js` asks Google Hotels (through SerpApi, `SERPAPI_KEY`) what each booking site charges for the five hotels we show, on the traveller's dates and for their party. Booking.com, Agoda, Expedia and Hotels.com prices go on the booking buttons; the cheapest is marked.

- A price is attached only when Google's hotel is clearly the same hotel (same spot, matching name). No match, no price.
- A platform with no price is shown as "no price found for your dates".
- If another seller is cheaper than all four, the page says so.
- Without the key, or when the lookup fails, the site shows the supplier's indicative price as before.
- Cost: 1 SerpApi search per hotel shown (2 for an ambiguous name), cached 20 minutes.
- The buttons still open OUR affiliate links (a search for the hotel on the platform), so the price on arrival can differ slightly.

## Rules the code keeps about facts

- A need is marked **confirmed** only when the hotel's own data says so. Otherwise it is "not confirmed — ask the hotel". Nothing is guessed.
- Guest ratings, review summaries and photos are shown only when they are real. A hotel without them is shown without them.
- Hotelbeds rates are wholesale rates, shown as **indicative** and only when no live price was found.
- AI suggestions are labelled as suggestions, not live inventory.

## Booking links

`src/services/affiliateLinks.js` builds a link per platform with the traveller's dates and guests filled in:

| Platform | Tracking |
|---|---|
| Booking.com | CJ deep link (`BOOKING_CJ_LINK`) |
| Agoda | `cid` (`AGODA_AFFILIATE_ID`) |
| Expedia, Hotels.com | `affcid` + `afflid` |

The ids are public by nature and have defaults in the file; the environment variables override them.

## API

`POST /api/search`

```json
{
  "adults": 2, "children": 1, "infants": 1, "rooms": 1, "childAges": [5],
  "purpose": ["Family holiday"],
  "destination": "Crete, Greece", "landmark": "", "radiusKm": 5,
  "checkIn": "2027-07-15", "checkOut": "2027-07-20",
  "stars": 0, "budget": "150_250",
  "vibes": ["Beach & relax"],
  "priorities": ["Pool", "Breakfast included"],
  "specialNeeds": { "babies_young_children": ["Crib / cot available"] },
  "freeText": "It's my wife's birthday and she loves quiet places."
}
```

Returns `{ hotels: [...], meta: { source, count, candidates, matching, ... } }`. Each hotel has `matchScore`, `matchReason`, `needsCheck` (`yes` / `no` / `unknown` / `likely`), `highlights`, `photos`, `gallery`, `bestPrice`, `bestFlex`, `currency`, `riScore`, `affiliateLinks`.

Searches are limited to 20 per visitor per 10 minutes. Supplier results are cached for 30 minutes; the matching is done fresh for every traveller.

## Files

```
magistay.html                 the site
src/server.js                 Express app, CORS, rate limit, /health
src/routes/search.js          POST /api/search
src/services/
  hotelSearch.js              picks the hotel source
  hotelbedsAPI.js             Hotelbeds availability + content
  aiCandidates.js             AI suggestions when no supplier has inventory
  aiMatcher.js                ranking + reasons + checklist (Claude, or rules without a key)
  travellerProfile.js         quiz → brief for the AI, and the list of needs to check
  affiliateLinks.js           booking links with affiliate ids
  livePrices.js               live price per booking platform (Google Hotels via SerpApi)
  reviewSummariser.js         review themes, only from real review text
  geocoding.js                destination → coordinates and size
  claude.js                   shared Claude client
  bookingAPI.js, expediaAPI.js   dormant until those partners approve
src/data/mockHotels.js        demo hotels
test/search.test.js           tests
```
