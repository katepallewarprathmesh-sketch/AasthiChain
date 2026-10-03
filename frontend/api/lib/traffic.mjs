// First-party web traffic — collection + aggregation.
//
// WHY THIS SHAPE
// There is no third-party script here. No Google Analytics, no Plausible, no
// pixel. The browser posts a tiny beacon to our own /api/track and that is the
// entire data path, so nothing about your visitors is handed to anyone else.
//
// PRIVACY, CONCRETELY
//   * No IP address is ever stored. Not hashed, not truncated - never written.
//   * No cookies. The visitor id is a random value the browser keeps in
//     sessionStorage; it dies when the tab closes and cannot follow anyone
//     across sites.
//   * That id is hashed with a server secret + the calendar date before it is
//     stored, so yesterday's id and today's id for the same person do not
//     match. The raw value never reaches the database.
//   * Events are aggregated ON WRITE into day/path/referrer counters. There is
//     no event log, so there is no per-visit history to subpoena, leak, or
//     accidentally join against anything else.
//   * Do Not Track is honoured in the client beacon.
//
// STORAGE
// Postgres when DATABASE_URL / POSTGRES_URL is set (the Neon instance the rail
// already uses), otherwise a JSON file in the system temp dir. The file mode is
// fine locally but resets on a serverless cold start - the summary reports
// which mode is live so a deployment is never quietly losing data.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const FILE = path.join(os.tmpdir(), 'aasthi_traffic.json');
const SALT = process.env.TRAFFIC_SALT || process.env.ADMIN_DASHBOARD_KEY || 'aasthichain-local-salt';

// Paths we never want polluting the report.
const IGNORE = [/^\/api\//, /^\/health$/, /\.(js|css|map|png|jpg|jpeg|svg|ico|woff2?|webp|avif|txt|xml)$/i];
const BOT = /(bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|go-http)/i;

const today = () => new Date().toISOString().slice(0, 10);

/** Stable-per-day, unlinkable-across-days visitor token. Never reversible. */
function visitorToken(rawId) {
  return crypto.createHash('sha256').update(`${SALT}|${today()}|${rawId || 'anon'}`).digest('hex').slice(0, 16);
}

/** Referrers are reduced to a hostname; query strings are discarded. */
export function normaliseReferrer(ref) {
  if (!ref) return 'direct';
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '').toLowerCase();
    if (!h) return 'direct';
    if (/google\./.test(h)) return 'google';
    if (/bing\./.test(h)) return 'bing';
    if (/duckduckgo\./.test(h)) return 'duckduckgo';
    if (/(^|\.)(x|twitter)\.com$/.test(h)) return 'twitter/x';
    if (/linkedin\./.test(h)) return 'linkedin';
    return h.slice(0, 60);
  } catch { return 'direct'; }
}

/** Search engines, for the SEO view. */
export const isSearch = (r) => ['google', 'bing', 'duckduckgo'].includes(r);

export function normalisePath(p) {
  if (!p || typeof p !== 'string') return null;
  let out = p.split('?')[0].split('#')[0].trim();
  if (!out.startsWith('/')) return null;
  if (out.length > 1) out = out.replace(/\/+$/, '') || '/';
  if (out.length > 120) out = out.slice(0, 120);
  if (IGNORE.some(rx => rx.test(out))) return null;
  return out;
}

export const looksLikeBot = (ua) => !ua || BOT.test(ua);

// ---------------------------------------------------------------- storage ---

let pool = null;
let schemaReady = null;

async function getPool() {
  if (!CONN) return null;
  if (!pool) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({
      connectionString: CONN,
      ssl: /localhost|127\.0\.0\.1/.test(CONN) ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS site_traffic (
        day date NOT NULL,
        path text NOT NULL,
        referrer text NOT NULL DEFAULT 'direct',
        hits bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (day, path, referrer)
      );
      CREATE TABLE IF NOT EXISTS site_visitors (
        day date NOT NULL,
        visitor char(16) NOT NULL,
        PRIMARY KEY (day, visitor)
      );
      CREATE INDEX IF NOT EXISTS site_traffic_day_idx ON site_traffic (day DESC);
    `).catch(e => { schemaReady = null; throw e; });
  }
  await schemaReady;
  return pool;
}

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { hits: {}, visitors: {} }; }
}
function writeFile(d) {
  try { fs.writeFileSync(FILE, JSON.stringify(d), 'utf8'); } catch { /* read-only fs: degrade quietly */ }
}

// ------------------------------------------------------------- collection ---

/**
 * Record one pageview. Returns { ok, mode } and never throws: analytics must
 * not be able to take a page down.
 */
export async function recordHit({ path: rawPath, referrer, visitorId, userAgent }) {
  const p = normalisePath(rawPath);
  if (!p) return { ok: false, reason: 'ignored-path' };
  if (looksLikeBot(userAgent)) return { ok: false, reason: 'bot' };

  const day = today();
  const ref = normaliseReferrer(referrer);
  const visitor = visitorToken(visitorId);

  try {
    const db = await getPool();
    if (db) {
      await db.query(
        `INSERT INTO site_traffic (day, path, referrer, hits) VALUES ($1,$2,$3,1)
         ON CONFLICT (day, path, referrer) DO UPDATE SET hits = site_traffic.hits + 1`,
        [day, p, ref]);
      await db.query(
        `INSERT INTO site_visitors (day, visitor) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [day, visitor]);
      return { ok: true, mode: 'postgres' };
    }
  } catch (e) {
    // fall through to file mode rather than lose the hit
    console.error('[traffic] postgres write failed:', e.message);
  }

  const d = readFile();
  const key = `${day}|${p}|${ref}`;
  d.hits[key] = (d.hits[key] || 0) + 1;
  (d.visitors[day] = d.visitors[day] || []).includes(visitor) || d.visitors[day].push(visitor);
  writeFile(d);
  return { ok: true, mode: 'file' };
}

// ------------------------------------------------------------ aggregation ---

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/** Traffic summary for the last `days` days. Never throws. */
export async function trafficSummary(days = 14) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  let rows = [];
  let visitorRows = [];
  let mode = 'file';

  try {
    const db = await getPool();
    if (db) {
      mode = 'postgres';
      rows = (await db.query(
        `SELECT day::text, path, referrer, hits FROM site_traffic WHERE day >= $1`, [since])).rows
        .map(r => ({ ...r, hits: Number(r.hits) }));
      visitorRows = (await db.query(
        `SELECT day::text, count(*)::int AS n FROM site_visitors WHERE day >= $1 GROUP BY day`, [since])).rows;
    }
  } catch (e) {
    console.error('[traffic] postgres read failed:', e.message);
    mode = 'file';
  }

  if (mode === 'file') {
    const d = readFile();
    rows = Object.entries(d.hits)
      .map(([k, hits]) => { const [day, path, referrer] = k.split('|'); return { day, path, referrer, hits }; })
      .filter(r => r.day >= since);
    visitorRows = Object.entries(d.visitors)
      .filter(([day]) => day >= since)
      .map(([day, list]) => ({ day, n: list.length }));
  }

  const totalViews = rows.reduce((a, r) => a + r.hits, 0);
  const uniqueVisitors = visitorRows.reduce((a, r) => a + Number(r.n), 0);

  const roll = (keyFn) => {
    const m = new Map();
    for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + r.hits);
    return [...m.entries()]
      .map(([key, views]) => ({ key, views, sharePct: pct(views, totalViews) }))
      .sort((a, b) => b.views - a.views);
  };

  const topPages = roll(r => r.path).slice(0, 12).map(x => ({ path: x.key, views: x.views, sharePct: x.sharePct }));
  const referrers = roll(r => r.referrer);
  const topReferrers = referrers.slice(0, 12).map(x => ({ source: x.key, views: x.views, sharePct: x.sharePct }));

  const searchViews = referrers.filter(r => isSearch(r.key)).reduce((a, r) => a + r.views, 0);
  const directViews = referrers.filter(r => r.key === 'direct').reduce((a, r) => a + r.views, 0);
  const referralViews = totalViews - searchViews - directViews;

  // dense day series so the chart has no gaps
  const byDay = new Map();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) || 0) + r.hits);
  const visByDay = new Map(visitorRows.map(r => [r.day, Number(r.n)]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ date, views: byDay.get(date) || 0, visitors: visByDay.get(date) || 0 });
  }

  return {
    windowDays: days,
    persistence: mode === 'postgres' ? 'postgres (durable)' : 'in-memory file (resets on cold start)',
    durable: mode === 'postgres',
    totalViews,
    uniqueVisitors,
    viewsPerVisitor: uniqueVisitors ? Math.round((totalViews / uniqueVisitors) * 10) / 10 : 0,
    topPages,
    topReferrers,
    acquisition: {
      searchViews, searchPct: pct(searchViews, totalViews),
      directViews, directPct: pct(directViews, totalViews),
      referralViews, referralPct: pct(referralViews, totalViews),
    },
    series,
    notes: [
      'First-party only: no third-party analytics, no cookies, no IP addresses stored.',
      'Visitor ids are salted and rotate daily, so they cannot be linked across days.',
      'Counts are aggregated on write - there is no per-visit event log.',
      mode === 'postgres'
        ? 'Stored in Postgres, so figures survive restarts and cold starts.'
        : 'No DATABASE_URL set: counts live in a temp file and reset on a cold start.',
    ],
  };
}

export default { recordHit, trafficSummary, normalisePath, normaliseReferrer, looksLikeBot };
