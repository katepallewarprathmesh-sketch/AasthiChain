// Per-path speed: the CBDC and corridor paths, measured rather than claimed.
//
// The published speed figures described the DvP settlement engine and only
// that. Quoting them for a CBDC transfer or a corridor send would be quoting
// a measurement of different work: different locks, an AML screen, a
// condition evaluation, an HTLC. This layer measures each path where the
// work happens, and these checks hold it to the same standard the engine
// report is held to.
//
//   node tests/pathspeed.test.mjs          (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const headers = (id, role) => ({ 'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role });
const get = async (path, id, role) => {
  const r = await fetch(BASE + '/api/umi' + path, { headers: headers(id || 'investor1', role || 'Investor') });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (path, id, role, payload) => {
  const r = await fetch(BASE + '/api/umi' + path, { method: 'POST', headers: headers(id, role), body: JSON.stringify(payload || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function main() {
  console.log('\nPer-path speed\n');

  const tag = Date.now();
  // A fresh wholesale holder, not a shared demo identity. investor1 is
  // funded and spent by other suites in the same run, so issuing to it
  // trips the retail KYC balance cap and this would measure the refusal
  // path instead. Wholesale is uncapped, and a supervisor may move money
  // out of any account, so the regulator can sign both calls.
  const holder = `speed-holder-${tag}`;
  const payee = `speed-payee-${tag}`;

  // 1. The report is mounted and carries its own caveats.
  const first = await get('/pathspeed');
  ok('the per-path report is mounted', first.status === 200, JSON.stringify(first.body).slice(0, 160));
  for (const key of ['scope', 'refusalsCountedApart', 'notABenchmark', 'caveat', 'disclaimer']) {
    ok(`the report states its ${key}`, typeof first.body[key] === 'string' && first.body[key].length > 20);
  }
  ok('the report says the engine figure is measured separately',
    /throughput/i.test(first.body.scope || ''), first.body.scope);
  ok('the report refuses to pass itself off as a benchmark',
    /not a synthetic loop|synthetic/i.test(first.body.notABenchmark || ''));

  // 2. Exercise two real CBDC paths.
  const issue = await post('/cbdc/issue', 'regulator1', 'Regulator', {
    holder, segment: 'WHOLESALE', tier: 'FULL', amountPaise: 500000,
  });
  ok('money issued for the measurement', issue.status === 200 || issue.status === 201,
    JSON.stringify(issue.body).slice(0, 160));

  const transfer = await post('/cbdc/transfer', 'regulator1', 'Regulator', {
    from: holder, to: payee, amountPaise: 1000,
  });
  ok('a transfer ran', transfer.status === 200 || transfer.status === 201,
    JSON.stringify(transfer.body).slice(0, 160));

  // 3. Those paths must now be reported, with the work described.
  const after = await get('/pathspeed');
  const paths = after.body.paths || {};
  ok('the report switches to measured once there is traffic', after.body.measured === true);

  for (const name of ['cbdc.issue', 'cbdc.transfer']) {
    const entry = paths[name];
    ok(`${name} is reported`, !!entry, `paths present: ${Object.keys(paths).join(', ')}`);
    if (!entry) continue;
    ok(`${name} counts its calls`, Number(entry.calls) > 0);
    ok(`${name} says what work it does`, typeof entry.work === 'string' && entry.work.length > 20);
    ok(`${name} separates completed from refused`,
      Number.isFinite(Number(entry.completed)) && Number.isFinite(Number(entry.refused))
      && Number(entry.completed) + Number(entry.refused) === Number(entry.calls));
    const lat = entry.latencyMs || {};
    ok(`${name} publishes percentiles, not just a mean`,
      ['mean', 'p50', 'p95', 'p99', 'max'].every((k) => Number.isFinite(Number(lat[k]))),
      JSON.stringify(lat));
    ok(`${name} percentiles are ordered`, Number(lat.p99) >= Number(lat.p50) && Number(lat.max) >= Number(lat.p99),
      JSON.stringify(lat));
    ok(`${name} reports the lock wait behind the figure`,
      entry.lockWaitMs && Number.isFinite(Number(entry.lockWaitMs.mean)));
  }

  // 4. A path nobody has called must be absent, not zero. A zero row reads
  //    as a result; the absence is the honest statement.
  const untouched = Object.entries(paths).filter(([, v]) => Number(v.calls) === 0);
  ok('no path is reported with zero calls', untouched.length === 0,
    untouched.map(([k]) => k).join(', '));

  // 5. A refusal is timed and counted, not dropped. Asking to move far more
  //    than the balance is refused before anything moves.
  const before = Number((paths['cbdc.transfer'] || {}).refused || 0);
  const refused = await post('/cbdc/transfer', 'regulator1', 'Regulator', {
    from: holder, to: payee, amountPaise: 99900000000,
  });
  ok('an over-balance transfer is refused', refused.status >= 400, JSON.stringify(refused.body).slice(0, 140));
  const third = await get('/pathspeed');
  const t3 = (third.body.paths || {})['cbdc.transfer'] || {};
  ok('the refusal was counted on the path', Number(t3.refused) > before,
    `refused before ${before}, after ${t3.refused}`);

  // 6. The engine report stays its own thing: this must not have quietly
  //    become a second, contradictory source for the DvP figure.
  const engine = await get('/throughput');
  ok('the settlement engine report is still served separately', engine.status === 200);
  ok('the engine report still states its single-writer limit',
    /single writer/i.test(JSON.stringify(engine.body)));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
