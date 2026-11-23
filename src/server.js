// ─── Magistay Backend — server.js ─────────────────────────────
// Main entry point. Keeps this file thin — logic lives in /services.
// Run: node src/server.js (or npm run dev for auto-restart)

import 'dotenv/config';
import express      from 'express';
import cors         from 'cors';
import searchRouter from './routes/search.js';
import goRouter     from './routes/go.js';
import chatRouter   from './routes/chat.js';
import waRouter, { whatsappStatus } from './routes/whatsapp.js';
import { reviewEvidenceEnabled } from './services/reviewEvidence.js';
import { clickStats } from './services/clickLinks.js';
import { storeStatus } from './services/store.js';
import { usageSnapshot } from './services/usage.js';
import { platformStatus } from './services/affiliateLinks.js';
import { googleHotelsEnabled } from './services/googleHotelsAPI.js';
import { claudeKeyShape, claudeModel, lastClaudeFailure } from './services/claude.js';
import { lastAIFailure } from './services/aiMatcher.js';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────
app.set('trust proxy', 1);            // Railway sits behind a proxy; needed for real client IPs
app.use(cors({ origin: allowedOrigins() }));
// The raw body is kept so WhatsApp calls can be checked against Meta's signature.
app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// FRONTEND_URL may list several origins, comma-separated. The www and
// non-www form of each is accepted, so either address of the site works.
function allowedOrigins() {
  const raw = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (raw.length === 0) return '*';
  const all = new Set();
  for (const origin of raw) {
    all.add(origin);
    all.add(origin.includes('://www.') ? origin.replace('://www.', '://') : origin.replace('://', '://www.'));
  }
  return [...all];
}

// ── Rate limit on search ───────────────────────────────────────
// Every search spends supplier quota and AI credit, so cap how many one
// visitor can run: 20 per 10 minutes.
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000, MAX_SEARCHES = 20;
app.use('/api/search', (req, res, next) => {
  // POST /api/search and GET /api/search/check both run a full search.
  if (req.method !== 'POST' && !(req.method === 'GET' && req.path.startsWith('/check'))) return next();
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_SEARCHES) {
    return res.status(429).json({ error: 'Too many searches — please try again in a few minutes.' });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  next();
});

// A chat turn costs a Claude call and often a search: 40 per visitor per 10 minutes.
const chatHits = new Map();
app.use('/api/chat', (req, res, next) => {
  if (req.method === 'GET' && (req.path.startsWith('/reply') || req.path.startsWith('/followup') || req.path.startsWith('/say'))) return next();
  const now = Date.now();
  const recent = (chatHits.get(req.ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= 40) return res.status(429).json({ error: 'Too many messages. Please try again in a few minutes.' });
  recent.push(now);
  chatHits.set(req.ip, recent);
  if (chatHits.size > 5000) chatHits.delete(chatHits.keys().next().value);
  next();
});

// ── Request logger (dev only) ──────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ── Routes ─────────────────────────────────────────────────────
// Search answers are per traveller and per moment: never cache them.
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', searchRouter);
app.use('/go', goRouter);              // tracked booking clicks
app.use('/wa', waRouter);              // WhatsApp webhook
app.use('/', chatRouter);              // /api/chat and the /chat simulator

// ── Health check ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  // Which pieces are switched on — booleans only, never the keys themselves.
  res.json({
    status:  'ok',
    version: '0.6.9',
    mode:    process.env.ANTHROPIC_API_KEY ? 'ai' : 'mock',
    sources: {
      claude:    !!process.env.ANTHROPIC_API_KEY,
      geocoding: !!process.env.GOOGLE_MAPS_API_KEY,
      googleHotels: googleHotelsEnabled(),
      hotelbeds: !!process.env.HOTELBEDS_API_KEY,
      hotelbedsEnv: process.env.HOTELBEDS_ENV === 'production' ? 'production' : 'test',
      booking:   !!process.env.BOOKING_API_KEY,
      expedia:   !!process.env.EXPEDIA_API_KEY,
      livePrices: !!process.env.SERPAPI_KEY && process.env.LIVE_PRICES !== 'off',
    },
    claudeKey: claudeKeyShape(),
    claudeModel: claudeModel(),
    claudeLastError: lastAIFailure()?.message?.slice(0, 120) || null,
    claudeLastCallFailure: lastClaudeFailure(),
    reviewEvidence: reviewEvidenceEnabled(),
    whatsapp: whatsappStatus(),
    affiliate: platformStatus(),
    store:   storeStatus(),
    usage:   usageSnapshot(),
    clicks:  clickStats(),
    ts:      new Date().toISOString(),
  });
});

// ── 404 handler ────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ───────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  const mode = process.env.ANTHROPIC_API_KEY ? '🤖 AI mode' : '🎭 Mock mode';
  console.log(`\n✅ Magistay backend running on http://localhost:${PORT}`);
  console.log(`   Mode: ${mode}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
