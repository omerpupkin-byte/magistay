// ─── routes/go.js ──────────────────────────────────────────────
// GET /go?to=...  records a booking click and sends the traveller to the
// booking site with our affiliate id and a click id. See clickLinks.js.

import { Router } from 'express';
import { resolveClick, rememberClick } from '../services/clickLinks.js';

const router = Router();

router.get('/', (req, res) => {
  const resolved = resolveClick(req.query);
  if (!resolved) return res.status(400).json({ error: 'This link does not lead to a booking site we work with.' });
  rememberClick(resolved.click);
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(302, resolved.url);
});

export default router;
