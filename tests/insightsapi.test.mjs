// The private insights dashboard must fail in a way you can act on.
//
// /api/admin/insights built its report outside any error handling, so one bad
// record took the whole endpoint down with an opaque failure, and the page —
// which assumed every response was JSON — reported a server that had answered
// as "could not reach the server".
const BASE = process.env.BASE || 'http://localhost:8080';
const KEY = process.env.ADMIN_DASHBOARD_KEY || 'devkey';
let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const call = async (headers) => {
  const r = await fetch(BASE + '/api/admin/insights', { headers });
  const raw = await r.text();
  let b = null; try { b = JSON.parse(raw) } catch { /* not json */ }
  return { s: r.status, b, raw, ct: r.headers.get('content-type') || '' };
};

const status = await (await fetch(BASE + '/api/admin/insights/status')).json();
t('status endpoint reports the dashboard is enabled', status.enabled === true);
t('status endpoint stamps the build', typeof status.build === 'string' && status.build.length > 0);

const no = await call({});
t('no key is refused', no.s === 401);
t('the refusal is JSON', !!no.b);
t('the refusal explains itself', /admin key/i.test((no.b && no.b.message) || ''));

const bad = await call({ 'x-admin-key': 'definitely-not-the-key' });
t('a wrong key is refused', bad.s === 401);
t('a wrong key does not leak the report', !(bad.b && bad.b.portfolio));

const ok = await call({ 'x-admin-key': KEY });
t('the right key is accepted', ok.s === 200);
t('the response is JSON', !!ok.b);

const d = ok.b || {};
for (const section of ['portfolio', 'properties', 'settlement', 'ledger', 'integrity', 'activity']) {
  t(`report carries ${section}`, d[section] !== undefined);
}
t('portfolio counts properties', typeof d.portfolio?.properties === 'number');
t('integrity reports a verdict', typeof d.integrity?.ok === 'boolean');
t('traffic never breaks the report', d.traffic === undefined || typeof d.traffic === 'object');

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
