// ─── routes/go.js ──────────────────────────────────────────────
// GET /go?to=...  records a booking click and sends the traveller to the
// booking site with our affiliate id and a click id. See clickLinks.js.

import { Router } from 'express';
import { resolveClick, rememberClick, expand } from '../services/clickLinks.js';

const router = Router();

router.get('/', (req, res) => {
  const resolved = resolveClick(req.query);
  if (!resolved) return res.status(400).json({ error: 'This link does not lead to a booking site we work with.' });
  rememberClick(resolved.click);
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(302, resolved.url);
});

// GET /go/<code>  the short form used in chat messages.
router.get('/:code', async (req, res) => {
  const query = await expand(req.params.code);
  const resolved = query && resolveClick(query);
  if (!resolved) return res.status(404).type('text/plain').send('This link has expired. Please search again and use the new link.');
  rememberClick(resolved.click);
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(302, resolved.url);
});

export default router;
