// ─── services/store.js ─────────────────────────────────────────
// One shared, lasting memory for things that cost money to fetch.
//
// Every paid lookup (hotel list for a trip, prices per booking site for
// a hotel) is the same for every traveller asking for the same thing,
// so it is kept and reused instead of bought again. With a database
// (DATABASE_URL, e.g. Railway PostgreSQL) the memory survives restarts
// and deploys; without one it lives in the server's memory only.
//
// Also the durable record of booking clicks.
// Never throws: if the database is unreachable the site keeps working
// from memory.

const memory = new Map();          // key -> { value, expires }
const MEMORY_MAX = 2000;

let pool = null;                   // pg Pool once connected
let dbState = process.env.DATABASE_URL ? 'connecting' : 'off';
let dbError = null;

const ready = init();

async function init() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  try {
    const { default: pg } = await import('pg');
    const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(url);
    pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
                         ssl: local ? false : { rejectUnauthorized: false } });
    pool.on('error', (e) => { dbError = String(e.message).slice(0, 160); });
    await pool.query(`CREATE TABLE IF NOT EXISTS cache (
      key text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS clicks (
      click_id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), channel text, search_id text,
      platform text, hotel text, price numeric, currency text, host text, sub_id_param text)`);
    await pool.query(`DELETE FROM cache WHERE expires_at < now()`);
    dbState = 'on';
    console.log('[STORE] PostgreSQL connected: cache and clicks are durable');
  } catch (e) {
    pool = null; dbState = 'failed'; dbError = String(e.message).slice(0, 160);
    console.error(`[STORE] No database (${dbError}); using memory only`);
  }
}

export async function cacheGet(key) {
  const hit = memory.get(key);
  if (hit) {
    if (hit.expires > Date.now()) return hit.value;
    memory.delete(key);
  }
  await ready;
  if (!pool) return null;
  try {
    const r = await pool.query('SELECT value, expires_at FROM cache WHERE key = $1 AND expires_at > now()', [key]);
    if (!r.rows.length) return null;
    remember(key, r.rows[0].value, new Date(r.rows[0].expires_at).getTime());
    return r.rows[0].value;
  } catch (e) { dbError = String(e.message).slice(0, 160); return null; }
}

export async function cacheSet(key, value, ttlMs) {
  const expires = Date.now() + ttlMs;
  remember(key, value, expires);
  await ready;
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO cache (key, value, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), new Date(expires)]);
  } catch (e) { dbError = String(e.message).slice(0, 160); }
}

function remember(key, value, expires) {
  memory.set(key, { value, expires });
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
}

export async function saveClick(c) {
  await ready;
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO clicks (click_id, at, channel, search_id, platform, hotel, price, currency, host, sub_id_param)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (click_id) DO NOTHING`,
      [c.clickId, c.at, c.channel, c.searchId, c.platform, c.hotel, c.price, c.currency, c.host, c.subIdParam]);
    return true;
  } catch (e) { dbError = String(e.message).slice(0, 160); return false; }
}

// Clicks per platform and channel over the last N days (database only).
export async function clickReport(days = 30) {
  await ready;
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT platform, channel, count(*)::int AS clicks FROM clicks
       WHERE at > now() - ($1 || ' days')::interval GROUP BY platform, channel ORDER BY clicks DESC`, [String(days)]);
    return r.rows;
  } catch (e) { dbError = String(e.message).slice(0, 160); return null; }
}

export function storeStatus() {
  return { database: dbState, ...(dbError ? { lastError: dbError } : {}), inMemoryEntries: memory.size };
}

// For tests.
export function _clearStore() { memory.clear(); }
