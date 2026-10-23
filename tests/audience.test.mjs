// Audience analytics: live presence, lifetime totals, account register.
//
// WHAT THIS GUARDS
// The ask behind this code was "every single record of who signed in, who is
// seeing it now, total users, all their info". Most of that is answerable.
// One part of it is not, by design, and the dangerous failure mode is a
// dashboard that quietly implies otherwise.
//
// So these checks hold two lines at once:
//
//   1. The things that CAN be measured are measured and survive a round trip:
//      a beacon shows up in live presence, the lifetime total counts every
//      day rather than a fortnight, and an identified account is registered
//      with first seen, last seen, active days and a request count.
//
//   2. The things that CANNOT be measured stay impossible and stay disclosed:
//      no IP address is stored anywhere, the visitor token still rotates
//      daily so visitors cannot be linked across days, no per-visit event log
//      exists, and the limits are returned WITH the figures rather than
//      written only in a comment.
//
// The second group matters more than the first. The published privacy page
// promises all of it, so a change that silently starts storing an IP would
// make that page false. A test is the only thing that notices.
//
//   node tests/audience.test.mjs          (BASE=http://localhost:8080)

import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8080';
const KEY = process.env.ADMIN_DASHBOARD_KEY || 'devkey';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const src = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const insights = async () => {
  const r = await fetch(BASE + '/api/admin/insights', { headers: { 'x-admin-key': KEY } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const run = async () => {
  console.log('Audience analytics');

  // ---------------------------------------------------------------- unit ---
  const traffic = await import('../frontend/api/lib/traffic.mjs');
  for (const fn of ['livePresence', 'allTimeSummary', 'accountRegister', 'recordAccountSighting']) {
    ok('traffic.mjs exports ' + fn, typeof traffic[fn] === 'function');
  }

  // A beacon must become presence. Without DATABASE_URL this exercises the
  // file path, which is the mode a local run and a cold serverless start
  // actually use.
  const vid = 'test-' + Math.random().toString(36).slice(2);
  await traffic.recordHit({ path: '/marketplace', referrer: '', visitorId: vid, userAgent: 'Mozilla/5.0 test' });
  const live = await traffic.livePresence(5);
  ok('a pageview shows up in live presence', live.onlineNow >= 1, JSON.stringify(live).slice(0, 200));
  ok('live presence names the page, not the person',
    (live.pages || []).some(p => p.path === '/marketplace') &&
    !JSON.stringify(live).includes(vid),
    JSON.stringify(live).slice(0, 200));

  // A bot must not be counted as a person on the site.
  const botBefore = (await traffic.livePresence(5)).onlineNow;
  await traffic.recordHit({ path: '/', referrer: '', visitorId: 'bot-' + Math.random(), userAgent: 'Googlebot/2.1' });
  ok('a crawler is not counted as someone on the site',
    (await traffic.livePresence(5)).onlineNow === botBefore);

  const all = await traffic.allTimeSummary();
  ok('the lifetime view is not windowed to a fortnight',
    all.windowDays === undefined && typeof all.daysRecorded === 'number');
  ok('the lifetime view counts at least the hit just recorded', all.totalViews >= 1);
  ok('the lifetime view discloses that visitor-days are not distinct people',
    /not a count of distinct people/i.test(String(all.caveat)), all.caveat);

  // The account register.
  const key = 'test:' + Math.random().toString(36).slice(2);
  await traffic.recordAccountSighting({ key, email: 'a@example.com', name: 'tester', role: 'Investor', provider: 'clerk' });
  await traffic.recordAccountSighting({ key, email: 'a@example.com', name: 'tester', role: 'Investor', provider: 'clerk' });
  const reg = await traffic.accountRegister(500);
  const mine = (reg.accounts || []).find(a => a.accountKey === key);
  ok('an identified account is registered', Boolean(mine), JSON.stringify(reg).slice(0, 200));
  ok('the register keeps first seen, last seen, active days and a count',
    Boolean(mine && mine.firstSeen && mine.lastSeen && mine.daysActive >= 1 && mine.requests === 2),
    JSON.stringify(mine));
  ok('two requests on one day count as one active day, not two',
    Boolean(mine && mine.daysActive === 1), mine && String(mine.daysActive));
  ok('the register says plainly that it cannot show sign-ins from before it existed',
    /cannot be recovered/i.test(String(reg.note)), reg.note);

  // ------------------------------------------------------------- privacy ---
  // These are the checks that must never be "fixed" by relaxing them.
  const t = src('frontend/api/lib/traffic.mjs');
  ok('no IP address is written to any analytics table',
    !/\bip_address\b|\bip\b\s*:/.test(t.replace(/\/\/.*$/gm, '')),
    'traffic.mjs must not store an IP in any form');
  ok('the visitor token is still salted with the calendar date',
    /today\(\)/.test(t) && /createHash\('sha256'\)/.test(t));
  ok('presence is overwritten per visitor, never appended as a log',
    /ON CONFLICT \(visitor\) DO UPDATE/.test(t) && /PRIMARY KEY/.test(t));
  ok('presence rows are swept rather than kept',
    /DELETE FROM site_presence/.test(t));
  ok('the browser beacon still honours Do Not Track',
    /optedOut\(\)/.test(src('frontend/src/lib/track.js')));

  // ------------------------------------------------------------- the API ---
  const unauth = await fetch(BASE + '/api/admin/insights');
  ok('the audience data needs the operator key', unauth.status === 401 || unauth.status === 503,
    'got ' + unauth.status);

  const { status, body } = await insights();
  ok('the insights report answers with the operator key', status === 200, 'got ' + status);
  const a = body.audience || {};
  ok('the report carries an audience block', Boolean(body.audience), Object.keys(body).join(', '));
  ok('it reports who is on the site now', a.live && typeof a.live.onlineNow === 'number');
  ok('it reports lifetime totals', a.allTime && typeof a.allTime.totalViews === 'number');
  ok('it reports the account register', a.accounts && typeof a.accounts.totalAccounts === 'number');
  ok('the limits are returned with the figures, not left to a footnote',
    Array.isArray(a.limits) && a.limits.length >= 3 &&
    a.limits.some(l => /no IP address is stored/i.test(l)),
    JSON.stringify(a.limits || []).slice(0, 200));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
