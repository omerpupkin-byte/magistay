// ─── routes/chat.js ────────────────────────────────────────────
// The conversation, over plain HTTP:
//
//   POST /api/chat            { sessionId, message, channel? } -> { messages, trip }
//   GET  /chat                a small page to talk to it (the simulator)
//   GET  /api/chat/say/<session>/<n>?m=...   the same turn as a plain address,
//        answered as a job (see below), for checking the live server.
//
// WhatsApp uses the same engine through routes/whatsapp.js.

import { Router } from 'express';
import { chatTurn, reviewMessages } from '../services/chatEngine.js';
import { addReviewEvidence, reviewEvidenceEnabled, openPoints } from '../services/reviewEvidence.js';
import { narratives } from '../services/narratives.js';
import { cacheGet } from '../services/store.js';
import { runSearch, context } from './search.js';
import { shorten } from '../services/clickLinks.js';

const router = Router();

// The real search, in the shape the engine expects.
export async function searchForChat(trip, ctx) {
  // A chat shows three hotels, so only three are priced and read about.
  // The reviews follow the answer (see reviewsForChat), so the search skips them here.
  const { status, body } = await runSearch(trip, null, { ...ctx, show: 3, skipReviews: true });
  if (status !== 200) throw new Error(body?.error || `search answered ${status}`);
  // Links short enough to sit in a message.
  for (const h of body.hotels || []) {
    for (const [platform, link] of Object.entries(h.affiliateLinks || {})) {
      if (typeof link === 'string' && link.includes('/go?')) h.affiliateLinks[platform] = await shorten(link);
    }
  }
  return body;
}

// The review follow-up: read the reviews for the open points, and say what
// they found for each hotel whose checks changed.
export async function reviewsForChat(hotels, trip, lang) {
  if (!reviewEvidenceEnabled()) return [];
  const had = openPoints(hotels).length > 0;
  const before = new Map(hotels.map(h => [h.id, JSON.stringify(h.needsCheck || [])]));
  const judged = await addReviewEvidence(hotels, { ...trip, language: lang });
  const changed = judged.filter(h => before.get(h.id) !== JSON.stringify(h.needsCheck || []) && h.reviewEvidence?.points > 0);
  const msgs = reviewMessages(changed, lang, { none: had });
  // What guests keep coming back to, for each hotel shown (the recent ones count for more).
  const repeat = await narrativeMessage(hotels, lang);
  return repeat ? [...msgs, repeat] : msgs;
}

// Recurring themes from the stored reviews, one short block per hotel.
async function narrativeMessage(hotels, lang) {
  const he = lang === 'he';
  const blocks = [];
  for (const h of hotels) {
    if (!h.googleToken) continue;
    const texts = await cacheGet('reviews|' + h.googleToken);
    if (!Array.isArray(texts) || texts.length < 4) continue;
    const top = narratives(texts).slice(0, 3);
    if (!top.length) continue;
    const lines = top.map(n => {
      const recent = n.recentShare != null ? (he ? ` · ${n.recentShare}% מהשנה האחרונה` : ` · ${n.recentShare}% in the last year`) : '';
      return `• ${n.theme}: ${n.mentions} מתוך ${n.outOf}, ${stanceHe(n.stance, he)}${recent}`.replace(/^• /, '• ');
    });
    blocks.push(`*${h.name}*\n${lines.join('\n')}`);
  }
  if (!blocks.length) return null;
  const head = he ? 'מה אורחים חוזרים אליו:' : 'What guests keep coming back to:';
  return { type: 'text', text: `${head}\n\n${blocks.join('\n\n')}` };
}

function stanceHe(stance, he) {
  if (!he) return stance;
  return { 'mostly positive': 'בעיקר חיובי', 'mostly negative': 'בעיקר שלילי', 'mixed': 'מעורב' }[stance] || stance;
}

export function turn(req, { sessionId, message, channel }, extra = {}) {
  const ctx = context(req, channel || 'chat');
  return chatTurn({ sessionId, message, channel: ctx.channel, baseUrl: ctx.baseUrl }, { search: searchForChat, reviews: reviewsForChat, ...extra });
}

router.post('/api/chat', async (req, res, next) => {
  try {
    const { sessionId, message, channel } = req.body || {};
    if (typeof sessionId !== 'string' || sessionId.length < 6) return res.status(400).json({ error: 'sessionId is required' });
    const result = await turn(req, { sessionId, message, channel: channel || 'chat' });
    // The reviews follow when ready: the channel asks for them by this id.
    if (typeof result.followUp === 'function') {
      const id = newFollowId();
      const job = { done: false, messages: [] };
      follow.set(id, job);
      result.followUp().then(m => { job.messages = m; }).catch(() => {}).finally(() => { job.done = true; });
      const { followUp, ...rest } = result;
      res.json({ ...rest, followUpId: id });
    } else {
      const { followUp, ...rest } = result;
      res.json(rest);
    }
  } catch (err) { next(err); }
});

// A turn that searches takes longer than a simple page fetch waits, so
// this address answers within a few seconds: with the reply, or with
// "running" and where to read it.
const follow = new Map();
const newFollowId = () => Math.random().toString(36).slice(2, 10);
router.get('/api/chat/followup/:id', (req, res) => {
  const job = follow.get(req.params.id);
  if (!job) return res.status(404).json({ status: 'unknown' });
  if (!job.done) return res.json({ status: 'running' });
  res.json({ status: 'done', messages: job.messages });
});

const jobs = new Map();
const WAIT_MS = 8000;

async function answer(res, id, job, base, step) {
  await Promise.race([job.promise, new Promise(r => setTimeout(r, WAIT_MS))]);
  if (!job.done) return res.json({ status: 'running', elapsedMs: Date.now() - job.startedAt, readTheReplyHere: `${base}/api/chat/reply/${id}/${step + 1}` });
  if (job.error) return res.status(500).json({ status: 'failed', error: job.error });
  res.json({ status: 'done', tookMs: job.tookMs, ...job.result });
}

router.get('/api/chat/say/:session/:n', async (req, res, next) => {
  try {
    for (const [k, j] of jobs) if (Date.now() - j.startedAt > 15 * 60 * 1000) jobs.delete(k);
    const id = `${String(req.params.session).replace(/[^\w-]/g, '').slice(0, 24)}-${String(req.params.n).replace(/\D/g, '').slice(0, 4)}-${Date.now().toString(36)}`;
    const job = { startedAt: Date.now(), done: false };
    job.promise = turn(req, { sessionId: 'check-' + req.params.session, message: String(req.query.m || ''), channel: 'check' })
      .then(async (r) => {
        // For checking, the review follow-up is included in the same answer.
        if (typeof r.followUp === 'function') r.messages = r.messages.concat(await r.followUp().catch(() => []));
        delete r.followUp;
        job.result = r;
      }).catch(e => { job.error = String(e?.message || e).slice(0, 300); })
      .finally(() => { job.done = true; job.tookMs = Date.now() - job.startedAt; });
    jobs.set(id, job);
    await answer(res, id, job, context(req).baseUrl, 0);
  } catch (err) { next(err); }
});

router.get('/api/chat/reply/:id/:step?', async (req, res, next) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ status: 'unknown', error: 'No such turn, or it is older than 15 minutes.' });
    await answer(res, req.params.id, job, context(req).baseUrl, Number(req.params.step) || 1);
  } catch (err) { next(err); }
});

// ── The simulator ─────────────────────────────────────────────
router.get('/chat', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(PAGE);
});

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Magistay chat</title>
<style>
  :root{--bg:#ECE5DD;--me:#D9FDD3;--them:#fff;--ink:#111B21;--soft:#667781;--bar:#F0F2F5;--go:#008069}
  @media (prefers-color-scheme:dark){:root{--bg:#0B141A;--me:#005C4B;--them:#202C33;--ink:#E9EDEF;--soft:#8696A0;--bar:#202C33;--go:#00A884}}
  *{box-sizing:border-box}html,body{height:100%;margin:0}
  body{font:15px/1.45 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:var(--bg);color:var(--ink);display:flex;flex-direction:column}
  header{padding:12px 16px;background:var(--bar);font-weight:600;display:flex;justify-content:space-between;align-items:center}
  header small{font-weight:400;color:var(--soft)}
  #log{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px}
  .m{max-width:min(520px,86%);padding:8px 11px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
  .me{align-self:flex-end;background:var(--me)}.them{align-self:flex-start;background:var(--them)}
  .m img{display:block;width:100%;max-height:200px;object-fit:cover;border-radius:7px;margin-bottom:6px}
  .m a{color:var(--go)}.wait{color:var(--soft);font-style:italic}
  form{display:flex;gap:8px;padding:10px;background:var(--bar)}
  input{flex:1;padding:11px 14px;border-radius:22px;border:none;font:inherit;background:var(--them);color:var(--ink);outline:none}
  button{padding:0 18px;border-radius:22px;border:none;background:var(--go);color:#fff;font:inherit;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5}
</style></head><body>
<header><span>Magistay</span><small>simulator: the same engine WhatsApp uses · <a href="#" id="new" style="color:inherit">new chat</a></small></header>
<div id="log"></div>
<form id="f"><input id="t" autocomplete="off" placeholder="Where, when, and what matters to you" dir="auto" autofocus><button id="b">Send</button></form>
<script>
var sid='sim-'+Math.random().toString(36).slice(2,12);
var log=document.getElementById('log'),f=document.getElementById('f'),t=document.getElementById('t'),b=document.getElementById('b');
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function rich(s){return esc(s).replace(/\\*([^*\\n]+)\\*/g,'<b>$1</b>').replace(/(https?:\\/\\/[^\\s]+)/g,function(u){return '<a href="'+u+'" target="_blank" rel="noopener sponsored">'+(u.length>46?u.slice(0,46)+'…':u)+'</a>';});}
function add(cls,html){var d=document.createElement('div');d.className='m '+cls;d.dir='auto';d.innerHTML=html;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
function show(m){add('them',(m.image?'<img src="'+esc(m.image)+'" alt="" onerror="this.remove()">':'')+rich(m.text||''));}
add('them','Hi! Tell me where you are going, when, and what matters to you in a hotel.\\nהיי! ספרו לי לאן, מתי, ומה חשוב לכם במלון.');
document.getElementById('new').onclick=function(e){e.preventDefault();sid='sim-'+Math.random().toString(36).slice(2,12);log.innerHTML='';add('them','New chat.');};
function waitFollow(id,n){if(n>60)return;setTimeout(function(){fetch('/api/chat/followup/'+id).then(function(r){return r.json();}).then(function(d){if(d.status==='done'){(d.messages||[]).forEach(show);}else waitFollow(id,n+1);}).catch(function(){});},1500);}
f.onsubmit=function(e){
  e.preventDefault();var msg=t.value.trim();if(!msg)return;t.value='';b.disabled=true;add('me',esc(msg));var w=add('them wait','…');
  fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,message:msg,channel:'sim'})})
   .then(function(r){return r.json();}).then(function(d){w.remove();(d.messages||[{text:d.error||'No reply.'}]).forEach(show);
     if(d.followUpId) waitFollow(d.followUpId,0);})
   .catch(function(){w.remove();add('them','Could not reach the server.');})
   .then(function(){b.disabled=false;t.focus();});
};
</script></body></html>`;

export default router;
