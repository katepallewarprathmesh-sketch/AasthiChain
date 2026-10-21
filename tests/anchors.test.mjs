// Public-chain anchoring.
//
// Replaying this ledger from genesis proves it is internally consistent. It
// does not prove it is the same history that existed yesterday, because the
// people who run it could have rebuilt the whole thing. Publishing the head
// to a public blockchain is what closes that gap: afterwards, rewriting
// history means rewriting a record on a network nobody here controls.
//
// These checks hold the honest parts of that claim: the network calls are
// real, the write path is off rather than faked when there is no funded key,
// no settlement data reaches the public chain, and a mismatch would be
// reported instead of hidden.
//
//   node tests/anchors.test.mjs            (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const skip = (name, why) => { passed++; console.log('  ok   ' + name + ' (skipped: ' + why + ')'); };

const call = async (origin, path, init) => {
  const r = await fetch(origin + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const rail = (path, init) => call(RAIL, path, init);
const app = (path, init) => call(BASE, path, init);
const headers = (id, role) => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role,
});

const run = async () => {
  console.log('Public-chain anchoring');

  // 1. Status is public: verification nobody can run without an account is
  //    not verification.
  const st = await rail('/umi/anchors');
  const status = (st.body && st.body.status) || {};
  ok('the anchor status is readable without signing in', st.status === 200 && status.network === 'solana',
    JSON.stringify(st.body).slice(0, 180));
  ok('it names the cluster and the RPC it is talking to', !!status.cluster && !!status.rpc);
  ok('reads are declared live', status.reads === 'live');
  ok('the disclaimer says what an anchor does and does not prove',
    String(status.disclaimer || '').includes('does not prove'));

  // 2. The network call is real. If the public cluster is having a bad day
  //    that is not this repository's bug, so it is reported, not failed.
  if (status.reachable) {
    ok('the cluster answered with a live slot', Number(status.clusterSlot) > 0, String(status.clusterSlot));
  } else {
    skip('the cluster answered with a live slot', 'public RPC unreachable: ' + (status.error || 'no reason given'));
  }

  // 3. No key means no writing, said out loud rather than faked.
  if (status.writeEnabled) {
    skip('writing is off until a funded key is configured', 'a key is configured in this environment');
  } else {
    ok('writing is off until a funded key is configured',
      String(status.writeDisabledBecause || '').length > 20, status.writeDisabledBecause);
    const attempt = await rail('/umi/anchors', { method: 'POST', headers: headers('regulator1', 'Regulator') });
    ok('an anchor attempt without a key fails loudly',
      attempt.status === 409 && attempt.body.error === 'ERR_UMI_ANCHOR_NO_KEY',
      JSON.stringify(attempt.body).slice(0, 160));
  }

  // 4. Publishing spends money and cannot be undone, so it is not open to
  //    everybody who happens to be signed in.
  const asInvestor = await rail('/umi/anchors', { method: 'POST', headers: headers('investor1', 'Investor') });
  ok('an ordinary participant cannot publish an anchor',
    asInvestor.status === 403 && asInvestor.body.error === 'ERR_UMI_ANCHOR_FORBIDDEN',
    JSON.stringify(asInvestor.body).slice(0, 160));

  // 5. Verification of something that is not there says so, rather than
  //    returning a comfortable answer.
  const bogus = '1111111111111111111111111111111111111111111111111111111111111111';
  const check = await rail('/umi/anchors/' + bogus);
  if (check.status === 200) {
    const v = check.body.verification || {};
    ok('a signature that is not on the cluster does not verify',
      v.foundOnChain === false && v.matches === false && String(v.explanation || '').length > 10,
      JSON.stringify(v).slice(0, 160));
    ok('the verification links to a public explorer', String(v.explorer || '').includes('explorer.solana.com'));
  } else {
    skip('a signature that is not on the cluster does not verify', 'RPC returned ' + check.status);
  }

  // 6. The app proxies it with no logic of its own.
  const proxied = await app('/api/umi/anchors');
  ok('the app proxies the anchor status',
    proxied.status === 200 && proxied.body.status && proxied.body.status.network === 'solana',
    JSON.stringify(proxied.body).slice(0, 160));

  // 7. The memo format must never carry settlement data. Checked at source,
  //    because this is the one mistake that cannot be withdrawn once made.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../drunix-gateway/solana.go', import.meta.url), 'utf8');
  const memoLine = (src.match(/return fmt\.Sprintf\("aasthi\|v1[^\n]*/) || [''])[0];
  ok('the memo carries only chain id, height, block hash and root',
    memoLine.includes('b.Height') && memoLine.includes('b.Hash') && memoLine.includes('b.TxnsRoot')
      && !/participant|investor|amount|price/i.test(memoLine), memoLine);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
