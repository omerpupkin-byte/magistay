// ─── services/clickLinks.js ────────────────────────────────────
// Every booking button goes through our own address first:
//
//   <api>/go?to=<affiliate link>&p=agoda&h=<hotel>&s=<search>&c=web
//
// /go records the click, stamps it with a click id the affiliate network
// reports back to us (a "sub-id"), and sends the traveller on. That is
// what ties a commission in a network report to the search, the hotel,
// the platform and the channel (site or WhatsApp) that earned it.
//
// The link carries everything it needs, so it keeps working after a
// server restart and when it is opened days later from a chat.
// It can only lead to the booking sites listed below, never elsewhere.

import { randomBytes } from 'node:crypto';
import { bookablePlatforms } from './affiliateLinks.js';
import { saveClick, cacheGet, cacheSet } from './store.js';

// Sites a /go link may lead to.
const BOOKING_SITES = ['booking.com', 'agoda.com', 'expedia.com', 'hotels.com', 'trip.com'];
// Travelpayouts' redirect domain, plus the host of any Travelpayouts link configured.
const TP_DOMAINS = ['tp.media', 'tp.st'];
function tpDomains() {
  const extra = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('TP_LINK_')) continue;
    try { extra.push(new URL(v).hostname.replace(/^www\./, '')); } catch { /* ignore */ }
  }
  return [...TP_DOMAINS, ...extra];
}
// CJ Affiliate's tracking domains (Booking.com is tracked through CJ).
const CJ_DOMAINS = ['anrdoezrs.net', 'dpbolvw.net', 'jdoqocy.com', 'kqzyfj.com', 'tkqlhce.com'];

const onDomain = (host, domain) => host === domain || host.endsWith('.' + domain);

function cjDomains() {
  const extra = [];
  try { if (process.env.BOOKING_CJ_LINK) extra.push(new URL(process.env.BOOKING_CJ_LINK).hostname.replace(/^www\./, '')); } catch { /* ignore */ }
  return [...CJ_DOMAINS, ...extra];
}

export function isAllowedDestination(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return [...BOOKING_SITES, ...cjDomains(), ...tpDomains()].some(d => onDomain(u.hostname, d));
  } catch { return false; }
}

// ── Building: affiliate link → our /go link ───────────────────
export function trackedLink(baseUrl, destination, { platform, hotel, searchId, channel, price, currency } = {}) {
  if (!baseUrl || !isAllowedDestination(destination)) return destination;
  const params = new URLSearchParams({ to: destination, p: platform || '', h: String(hotel || '').slice(0, 80), s: searchId || '', c: channel || 'web' });
  if (price != null) { params.set('pr', String(price)); if (currency) params.set('cur', currency); }
  return `${baseUrl.replace(/\/$/, '')}/go?${params}`;
}

// All of one hotel's booking buttons, tracked.
export function trackHotelLinks(hotel, { baseUrl, searchId, channel }) {
  if (!hotel.affiliateLinks || !baseUrl) return hotel;
  const affiliateLinks = { ...hotel.affiliateLinks };
  for (const platform of bookablePlatforms()) {
    if (!affiliateLinks[platform]) continue;
    affiliateLinks[platform] = trackedLink(baseUrl, affiliateLinks[platform], {
      platform, hotel: hotel.name, searchId, channel,
      price: hotel.platforms?.[platform]?.price ?? null, currency: hotel.currency,
    });
  }
  return { ...hotel, affiliateLinks };
}

// Where a link finally leads (our /go links are unwrapped).
export function destinationOf(link) {
  try {
    const u = new URL(link);
    return u.pathname === '/go' && u.searchParams.get('to') ? u.searchParams.get('to') : link;
  } catch { return link; }
}

// ── Clicking: /go link → the booking site, stamped ────────────
// Returns { url, click } or null when the destination is not allowed.
export function resolveClick(query) {
  const destination = typeof query.to === 'string' ? query.to : '';
  if (!isAllowedDestination(destination)) return null;

  const clean   = (v, max) => String(v ?? '').replace(/[^\w .,'&()\-À-ÿ]/g, '').slice(0, max);
  const channel = clean(query.c, 8).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'web';
  const search  = clean(query.s, 16).replace(/[^a-z0-9]/gi, '');
  // Short, readable in a network report: channel-search-random.
  const clickId = [channel, search || 'direct', randomBytes(4).toString('hex')].join('-');

  const { url, subId } = stamp(destination, clickId);
  return {
    url,
    click: {
      clickId, at: new Date().toISOString(), channel, searchId: search || null,
      platform: clean(query.p, 20), hotel: clean(query.h, 80),
      price: Number(query.pr) > 0 ? Number(query.pr) : null, currency: clean(query.cur, 3) || null,
      subIdParam: subId,                      // which parameter carries the click id, or null
      host: new URL(destination).hostname,
    },
  };
}

// Put the click id where each network reads a sub-id from.
function stamp(destination, clickId) {
  const u = new URL(destination);
  const host = u.hostname;
  let subId = null;

  if (tpDomains().some(d => onDomain(host, d)))      subId = 'sub_id';  // Travelpayouts: sub id
  else if (cjDomains().some(d => onDomain(host, d))) subId = 'sid';     // CJ Affiliate: shopper id
  else if (onDomain(host, 'agoda.com'))              subId = 'tag';     // Agoda partners: tag
  else if (onDomain(host, 'booking.com') && u.searchParams.get('aid')) subId = 'label';   // Booking.com direct aid
  // Expedia Group links carry affcid/afflid only; no sub-id field is used.

  if (subId) u.searchParams.set(subId, clickId);
  return { url: String(u), subId };
}

// ── A short memory of recent clicks (the log line is the record) ──
const recent = [];
export function rememberClick(click) {
  recent.push(click);
  if (recent.length > 500) recent.shift();
  console.log(`[CLICK] ${JSON.stringify(click)}`);
  saveClick(click);                       // durable when a database is connected
}
export function clickStats() {
  const byPlatform = {};
  for (const c of recent) byPlatform[c.platform || 'unknown'] = (byPlatform[c.platform || 'unknown'] || 0) + 1;
  return { sinceRestart: recent.length, byPlatform, last: recent.length ? recent[recent.length - 1].at : null };
}

export function newSearchId() { return randomBytes(4).toString('hex'); }

// ── Short links, for chat ─────────────────────────────────────
// A /go link carries its whole destination, which is fine behind a button
// but is 600 characters in a chat message. shorten() keeps the same link
// under a short code (<api>/go/Ab3xK9q) for 30 days.
const SHORT_TTL = 30 * 24 * 60 * 60 * 1000;

export async function shorten(link) {
  try {
    const u = new URL(link);
    if (u.pathname !== '/go' || !u.searchParams.get('to')) return link;
    const code = randomBytes(6).toString('base64url');
    await cacheSet('go|' + code, u.search.slice(1), SHORT_TTL);
    return `${u.origin}/go/${code}`;
  } catch { return link; }
}

// The query a short code stands for, or null when unknown or expired.
export async function expand(code) {
  if (!/^[\w-]{6,12}$/.test(String(code))) return null;
  const query = await cacheGet('go|' + code);
  return typeof query === 'string' ? Object.fromEntries(new URLSearchParams(query)) : null;
}
