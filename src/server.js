// ─── Magistay Backend — server.js ─────────────────────────────
// Main entry point. Keeps this file thin — logic lives in /services.
// Run: node src/server.js (or npm run dev for auto-restart)

import 'dotenv/config';
import express      from 'express';
import cors         from 'cors';
import searchRouter from './routes/search.js';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── Request logger (dev only) ──────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ── Routes ─────────────────────────────────────────────────────
app.use('/api', searchRouter);

// ── Health check ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    version: '0.1.0',
    mode:    process.env.ANTHROPIC_API_KEY ? 'ai' : 'mock',
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
