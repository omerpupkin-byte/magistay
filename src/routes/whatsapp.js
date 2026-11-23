// ─── routes/whatsapp.js ────────────────────────────────────────
// WhatsApp (Meta Cloud API) in front of the same conversation engine.
//
//   GET  /wa/webhook   Meta's one-time check that this address is ours.
//   POST /wa/webhook   every incoming message.
//
// Needs, in the environment:
//   WHATSAPP_TOKEN          access token that may send from the number
//   WHATSAPP_PHONE_ID       the number's "Phone number ID" (not the number)
//   WHATSAPP_VERIFY_TOKEN   any phrase; typed again in Meta's webhook form
//   WHATSAPP_APP_SECRET     the app secret; with it, every incoming call is
//                           checked to really come from Meta (recommended)
//
// Meta wants an answer within seconds and re-sends when it does not get
// one, so we answer 200 at once, work in the background, and ignore a
// message id we have already seen.

import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { turn } from './chat.js';
import { cacheGet, cacheSet } from '../services/store.js';

const router = Router();
const GRAPH = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v21.0'}`;

export function whatsappStatus() {
  return {
    canReceive: !!process.env.WHATSAPP_VERIFY_TOKEN,
    canSend: !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_ID,
    checksSignature: !!process.env.WHATSAPP_APP_SECRET,
  };
}

// Meta's handshake when the webhook address is saved.
router.get('/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && !!process.env.WHATSAPP_VERIFY_TOKEN
    && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN;
  if (!ok) return res.sendStatus(403);
  res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
});

router.post('/webhook', (req, res) => {
  if (!signedByMeta(req)) return res.sendStatus(401);
  res.sendStatus(200);                                   // answer first, work after
  for (const msg of incoming(req.body)) handle(req, msg).catch(e => console.error('[WHATSAPP]', String(e?.message || e).slice(0, 200)));
});

export function signedByMeta(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;                              // not configured: accept (set it before going live)
  const given = String(req.get('x-hub-signature-256') || '');
  if (!req.rawBody || !given.startsWith('sha256=')) return false;
  const want = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

// The messages inside a webhook call, flattened.
export function incoming(body) {
  const out = [];
  for (const entry of body?.entry || []) for (const change of entry?.changes || []) {
    for (const m of change?.value?.messages || []) {
      if (!m?.from || !m?.id) continue;
      const text = m.type === 'text' ? m.text?.body
        : m.type === 'interactive' ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title)
        : m.type === 'button' ? m.button?.text : null;
      out.push({ from: String(m.from), id: String(m.id), text: typeof text === 'string' ? text : null, type: m.type });
    }
  }
  return out;
}

async function handle(req, msg) {
  // Meta re-sends a message it thinks we missed.
  const seenKey = 'wa-seen|' + msg.id;
  if (await cacheGet(seenKey)) return;
  await cacheSet(seenKey, 1, 24 * 60 * 60 * 1000);

  if (!msg.text) {
    return send(msg.from, { type: 'text', text: 'I can read text messages for now. Tell me where you are going, when, and what matters to you in a hotel.' });
  }
  const result = await turn(req, { sessionId: 'wa-' + msg.from, message: msg.text, channel: 'wa' },
    { onInterim: (text) => send(msg.from, { type: 'text', text }) });
  for (const m of result.messages) await send(msg.from, m);
  // The reviews follow once they are read (a few seconds later).
  if (typeof result.followUp === 'function') {
    const extra = await result.followUp().catch(e => { console.error('[WHATSAPP] reviews', String(e?.message || e).slice(0, 160)); return []; });
    for (const m of extra) await send(msg.from, m);
  }
}

// One message out. A hotel goes as its photo with the text as caption
// (a caption holds 1024 characters); without a photo, or if the photo
// is refused, as plain text.
export async function send(to, m, { fetchImpl = fetch } = {}) {
  const st = whatsappStatus();
  if (!st.canSend) { console.log(`[WHATSAPP] (not configured to send) -> ${to}: ${String(m.text).slice(0, 80)}`); return false; }
  const text = String(m.text || '').slice(0, 4000);
  const asImage = m.type === 'hotel' && m.image && text.length <= 1024;
  const payload = asImage
    ? { messaging_product: 'whatsapp', to, type: 'image', image: { link: m.image, caption: text } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } };

  const post = (body) => fetchImpl(`${GRAPH()}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });

  let res = await post(payload);
  if (!res.ok && asImage) res = await post({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } });
  if (!res.ok) console.error(`[WHATSAPP] send failed ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.ok;
}

export default router;
