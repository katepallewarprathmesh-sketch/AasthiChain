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

      -- Who is on the site right now. One row per visitor token, overwritten
      -- on every beacon, swept after the presence window. This is a live
      -- gauge, not a history: it answers "how many people are here" and it
      -- cannot answer "where was this person last Tuesday", because the row
      -- is replaced rather than appended and the token still rotates daily.
      CREATE TABLE IF NOT EXISTS site_presence (
        visitor char(16) PRIMARY KEY,
        path text NOT NULL,
        seen_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS site_presence_seen_idx ON site_presence (seen_at DESC);

      -- The register of accounts that have actually signed in. These are not
      -- anonymous visitors: they are people who created an account and
      -- identified themselves, so first seen, last seen and a count of active
      -- days are recorded against them. Nothing is inferred and no browsing
      -- path is attached to a person here.
      CREATE TABLE IF NOT EXISTS app_accounts (
        account_key text PRIMARY KEY,
        email text,
        name text,
        role text,
        provider text,
        first_seen timestamptz NOT NULL DEFAULT NOW(),
        last_seen timestamptz NOT NULL DEFAULT NOW(),
        days_active integer NOT NULL DEFAULT 1,
        last_day date NOT NULL DEFAULT CURRENT_DATE,
        sightings bigint NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS app_accounts_last_idx ON app_accounts (last_seen DESC);
    `).catch(e => { schemaReady = null; throw e; });
  }
  await schemaReady;
  return pool;
}

function readFile() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    d.hits = d.hits || {};
    d.visitors = d.visitors || {};
    d.presence = d.presence || {};
    d.accounts = d.accounts || {};
    return d;
  } catch { return { hits: {}, visitors: {}, presence: {}, accounts: {} }; }
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
      // Live presence: one row per visitor, overwritten rather than appended.
      await db.query(
        `INSERT INTO site_presence (visitor, path, seen_at) VALUES ($1,$2,NOW())
         ON CONFLICT (visitor) DO UPDATE SET path = EXCLUDED.path, seen_at = NOW()`,
        [visitor, p]);
      // Sweep anything well past the window so the table cannot grow without
      // bound. Cheap: the index is on seen_at and the table is tiny.
      await db.query(`DELETE FROM site_presence WHERE seen_at < NOW() - INTERVAL '1 hour'`);
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
  d.presence[visitor] = { path: p, at: Date.now() };
  for (const [k, v] of Object.entries(d.presence)) {
    if (Date.now() - (v.at || 0) > 3600000) delete d.presence[k];
  }
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

// ------------------------------------------------------- live + lifetime ---

/**
 * Who is on the site right now.
 *
 * A count of distinct visitor tokens seen in the last `windowMin` minutes,
 * with the pages they are on. It is a gauge, not a guest list: the tokens are
 * the same salted daily values used everywhere else, so nobody here can be
 * named, emailed or followed to tomorrow.
 */
export async function livePresence(windowMin = 5) {
  const cutoff = Date.now() - windowMin * 60000;
  let rows = [];
  let mode = 'file';
  try {
    const db = await getPool();
    if (db) {
      mode = 'postgres';
      rows = (await db.query(
        `SELECT path, count(*)::int AS n FROM site_presence
          WHERE seen_at > NOW() - ($1 || ' minutes')::interval
          GROUP BY path ORDER BY n DESC`, [String(windowMin)])).rows;
    }
  } catch (e) {
    console.error('[traffic] presence read failed:', e.message);
    mode = 'file';
  }
  if (mode === 'file') {
    const d = readFile();
    const m = new Map();
    for (const v of Object.values(d.presence || {})) {
      if (!v || (v.at || 0) < cutoff) continue;
      m.set(v.path, (m.get(v.path) || 0) + 1);
    }
    rows = [...m.entries()].map(([path, n]) => ({ path, n })).sort((a, b) => b.n - a.n);
  }
  const onlineNow = rows.reduce((a, r) => a + Number(r.n), 0);
  return {
    windowMinutes: windowMin,
    onlineNow,
    pages: rows.slice(0, 12).map(r => ({ path: r.path, visitors: Number(r.n) })),
    durable: mode === 'postgres',
    note: onlineNow === 0
      ? 'Nobody has loaded a page in the last ' + windowMin + ' minutes.'
      : onlineNow + ' browser(s) active in the last ' + windowMin + ' minutes. Counted, not identified.',
  };
}

/**
 * Lifetime totals, as far back as the table goes.
 *
 * trafficSummary deliberately windows to a fortnight for the dashboard chart.
 * This is the all-time view: every day ever recorded, the first day, and the
 * busiest one.
 *
 * One honest caveat is returned with the numbers rather than left implicit:
 * uniqueVisitors here is the sum of DAILY uniques, because the visitor token
 * is re-salted every day on purpose. One person visiting on ten days counts
 * ten times. There is no design in which that figure can be deduplicated, and
 * calling it "total users" would be a lie.
 */
export async function allTimeSummary() {
  let rows = [];
  let visitorRows = [];
  let mode = 'file';
  try {
    const db = await getPool();
    if (db) {
      mode = 'postgres';
      rows = (await db.query(
        `SELECT day::text, path, referrer, hits FROM site_traffic`)).rows
        .map(r => ({ ...r, hits: Number(r.hits) }));
      visitorRows = (await db.query(
        `SELECT day::text, count(*)::int AS n FROM site_visitors GROUP BY day`)).rows;
    }
  } catch (e) {
    console.error('[traffic] all-time read failed:', e.message);
    mode = 'file';
  }
  if (mode === 'file') {
    const d = readFile();
    rows = Object.entries(d.hits)
      .map(([k, hits]) => { const [day, path, referrer] = k.split('|'); return { day, path, referrer, hits }; });
    visitorRows = Object.entries(d.visitors).map(([day, list]) => ({ day, n: list.length }));
  }

  const totalViews = rows.reduce((a, r) => a + r.hits, 0);
  const visitorDays = visitorRows.reduce((a, r) => a + Number(r.n), 0);
  const days = [...new Set(rows.map(r => r.day))].sort();

  const byDay = new Map();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) || 0) + r.hits);
  let busiest = null;
  for (const [date, views] of byDay) if (!busiest || views > busiest.views) busiest = { date, views };

  const rollAll = (keyFn) => {
    const m = new Map();
    for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + r.hits);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  return {
    firstDay: days[0] || null,
    lastDay: days[days.length - 1] || null,
    daysRecorded: days.length,
    totalViews,
    visitorDays,
    busiestDay: busiest,
    topPages: rollAll(r => r.path).slice(0, 25).map(([path, views]) => ({ path, views, sharePct: pct(views, totalViews) })),
    topReferrers: rollAll(r => r.referrer).slice(0, 25).map(([source, views]) => ({ source, views, sharePct: pct(views, totalViews) })),
    series: days.map(date => ({
      date,
      views: byDay.get(date) || 0,
      visitors: Number((visitorRows.find(v => v.day === date) || {}).n || 0),
    })),
    durable: mode === 'postgres',
    caveat: 'visitorDays is the sum of daily unique visitors. The visitor token is re-salted every ' +
      'day so that one person cannot be followed across days, which means a returning visitor is ' +
      'counted once per day they visit. It is not a count of distinct people, and the design cannot ' +
      'produce one.',
  };
}

// --------------------------------------------------------------- accounts ---

/**
 * Record that an identified account was seen.
 *
 * Called on authenticated requests. Unlike the visitor beacon this is a named
 * person: they hold an account and signed in, so first seen, last seen, the
 * number of distinct active days and a request count are kept against them.
 * No page path and no IP are attached, which keeps the sign-in register and
 * the browsing counters from ever being joined into a per-person history.
 */
export async function recordAccountSighting({ key, email, name, role, provider }) {
  const k = String(key || '').trim().slice(0, 200);
  if (!k) return { ok: false, reason: 'no-key' };
  const day = today();
  try {
    const db = await getPool();
    if (db) {
      await db.query(
        `INSERT INTO app_accounts (account_key, email, name, role, provider, first_seen, last_seen, days_active, last_day, sightings)
         VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),1,$6,1)
         ON CONFLICT (account_key) DO UPDATE SET
           email       = COALESCE(EXCLUDED.email, app_accounts.email),
           name        = COALESCE(EXCLUDED.name, app_accounts.name),
           role        = COALESCE(EXCLUDED.role, app_accounts.role),
           provider    = COALESCE(EXCLUDED.provider, app_accounts.provider),
           last_seen   = NOW(),
           sightings   = app_accounts.sightings + 1,
           days_active = app_accounts.days_active + (CASE WHEN app_accounts.last_day < $6 THEN 1 ELSE 0 END),
           last_day    = $6`,
        [k, email || null, name || null, role || null, provider || null, day]);
      return { ok: true, mode: 'postgres' };
    }
  } catch (e) {
    console.error('[traffic] account write failed:', e.message);
  }
  const d = readFile();
  const cur = d.accounts[k] || { firstSeen: Date.now(), daysActive: 0, lastDay: null, sightings: 0 };
  cur.email = email || cur.email || null;
  cur.name = name || cur.name || null;
  cur.role = role || cur.role || null;
  cur.provider = provider || cur.provider || null;
  cur.lastSeen = Date.now();
  cur.sightings = (cur.sightings || 0) + 1;
  if (cur.lastDay !== day) { cur.daysActive = (cur.daysActive || 0) + 1; cur.lastDay = day; }
  d.accounts[k] = cur;
  writeFile(d);
  return { ok: true, mode: 'file' };
}

/** Every account the deployment has ever seen sign in, newest activity first. */
export async function accountRegister(limit = 500) {
  let rows = [];
  let mode = 'file';
  try {
    const db = await getPool();
    if (db) {
      mode = 'postgres';
      rows = (await db.query(
        `SELECT account_key, email, name, role, provider,
                first_seen, last_seen, days_active, sightings
           FROM app_accounts ORDER BY last_seen DESC LIMIT $1`, [limit])).rows
        .map(r => ({
          accountKey: r.account_key,
          email: r.email, name: r.name, role: r.role, provider: r.provider,
          firstSeen: new Date(r.first_seen).toISOString(),
          lastSeen: new Date(r.last_seen).toISOString(),
          daysActive: Number(r.days_active),
          requests: Number(r.sightings),
        }));
    }
  } catch (e) {
    console.error('[traffic] account read failed:', e.message);
    mode = 'file';
  }
  if (mode === 'file') {
    const d = readFile();
    rows = Object.entries(d.accounts || {}).map(([accountKey, a]) => ({
      accountKey,
      email: a.email || null, name: a.name || null, role: a.role || null, provider: a.provider || null,
      firstSeen: new Date(a.firstSeen).toISOString(),
      lastSeen: new Date(a.lastSeen || a.firstSeen).toISOString(),
      daysActive: a.daysActive || 1,
      requests: a.sightings || 1,
    })).sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1)).slice(0, limit);
  }
  const active = (since) => rows.filter(r => Date.parse(r.lastSeen) > Date.now() - since).length;
  return {
    totalAccounts: rows.length,
    activeLast24h: active(86400000),
    activeLast7d: active(7 * 86400000),
    accounts: rows,
    durable: mode === 'postgres',
    note: 'Accounts that have made an authenticated request against this deployment. ' +
      'Sign-ins completed before this register was added were never written down and ' +
      'cannot be recovered. The identity provider holds the authoritative account list.',
  };
}

export default { recordHit, trafficSummary, normalisePath, normaliseReferrer, looksLikeBot };
