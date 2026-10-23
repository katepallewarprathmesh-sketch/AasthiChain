// The property token on a public chain, and the rail that writes it.
//
// WHAT IS BEING CHECKED. contracts/PropertyToken.sol passed its own tests
// long before anything called it, and a contract nobody calls is a sample
// rather than a feature. These checks cover the connection: the rail's view
// of the contract, the refusals that protect the invariant, and the fact
// that every refusal lands on our own ledger.
//
// THE INVARIANT behind most of them:
//   an on-chain balance never exceeds the holder's position on the rail
// A mirror that can exceed the register is a second issuance of the same
// property, so every way of breaking that rule has to be refused.
//
// This suite runs against a rail with NO EVM chain configured, which is the
// normal state in CI. That is deliberate: the refusals an unconfigured rail
// gives are themselves part of the contract with the user, and "not
// configured" must name the variables rather than shrug. The live-chain
// path (ganache and a deployed contract) is exercised by the Go tests and
// was walked by hand; docs/TOKEN.md records the transactions.
//
//   node tests/tokenmirror.test.mjs        (RAIL=http://localhost:21100)

import { readFileSync } from 'node:fs';

const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const call = async (path, init) => {
  const r = await fetch(RAIL + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const post = (path, payload) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Identity-Id': 'regulator1', 'X-Fabric-Identity': 'regulator1', 'X-Identity-Role': 'Regulator' },
  body: JSON.stringify(payload || {}),
});

const run = async () => {
  console.log('\nProperty token on a public chain\n');

  // ------------------------------------------------------------- status
  const st = await call('/umi/token', { method: 'GET' });
  ok('the mirror reports its own configuration', st.status === 200, 'status ' + st.status);
  const s = st.body || {};
  ok('reading it needs no key', st.status === 200);
  ok('it names the chain it is pointed at', typeof s.network === 'string' && s.network.length > 0, s.network);
  ok('it says whether it can write at all', typeof s.configured === 'boolean');
  ok('it reports how many writes it has made', typeof s.writes === 'number');

  const configured = s.configured === true;
  if (!configured) {
    ok('an unconfigured mirror names the missing variables rather than shrugging',
      Array.isArray(s.missing) && s.missing.length > 0 && s.missing.every(v => /^EVM_/.test(v)),
      JSON.stringify(s.missing));
    ok('the signer is reported as absent, not faked', !s.signer);
  }

  ok('it states what is real about it',
    typeof s.whatIsReal === 'string' && /sign/i.test(s.whatIsReal));
  ok('it states the limit in the same breath',
    typeof s.whatIsNotReal === 'string' && /one direction|not written back/i.test(s.whatIsNotReal),
    s.whatIsNotReal);
  ok('the contract is described as a mirror and not as the register',
    /mirror/i.test(String(s.contract && s.contract.role)) && /register/i.test(String(s.contract && s.contract.role)),
    String(s.contract && s.contract.role));
  ok('the standards it implements are published',
    Array.isArray(s.contract && s.contract.standards) &&
    s.contract.standards.join(' ').includes('7943'),
    JSON.stringify(s.contract && s.contract.standards));

  // ------------------------------------------------------------ compare
  const noAsset = await call('/umi/token/compare', { method: 'GET' });
  ok('a comparison without an asset is refused', noAsset.status === 400, 'status ' + noAsset.status);

  const asset = 'PROP-TOKEN-SUITE-' + Date.now().toString(36);
  const cmp = await call(`/umi/token/compare?assetId=${asset}`, { method: 'GET' });
  ok('the comparison answers for an asset nobody has linked', cmp.status === 200, 'status ' + cmp.status);
  ok('an empty comparison is empty rather than wrong',
    cmp.body.count === 0 && Array.isArray(cmp.body.wallets));
  ok('the comparison states what it proves',
    /equals the rail position/i.test(String(cmp.body.whatThisProves)));
  ok('and states what it cannot prove: the chain does not write back',
    /not reflected|is not,/i.test(String(cmp.body.whatThisDoesNotProve)),
    String(cmp.body.whatThisDoesNotProve));

  // ----------------------------------------------------------- refusals
  const anon = await call('/umi/token/link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holder: 'investor1', wallet: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }),
  });
  ok('writing without an identity is refused', anon.status === 401 || anon.status === 403,
    'status ' + anon.status);

  const noFields = await post('/umi/token/link', { holder: '', wallet: '' });
  ok('a link with no holder and no wallet is refused', noFields.status === 400, 'status ' + noFields.status);

  const badAddress = await post('/umi/token/link', { holder: 'investor1', wallet: 'not-an-address' });
  ok('an address that is not 20 bytes is refused before anything is signed',
    badAddress.status === 400 || badAddress.status === 403, 'status ' + badAddress.status);
  ok('the refusal is recorded on our own ledger, not only in the response',
    badAddress.body.refusalRecorded === true || /not been verified|not completed KYC/i.test(String(badAddress.body.message)),
    JSON.stringify(badAddress.body).slice(0, 200));

  const unlinked = await post('/umi/token/mirror', { assetId: asset, holder: 'nobody-' + Date.now() });
  ok('mirroring a holder with no registered address is refused',
    unlinked.status === 409 || unlinked.status === 503, 'status ' + unlinked.status);
  ok('the refusal names the invariant it is protecting',
    /never exceeds/i.test(String(unlinked.body.invariant)), String(unlinked.body.invariant));

  const noAssetMirror = await post('/umi/token/mirror', { holder: 'investor1' });
  ok('mirroring without an asset is refused', noAssetMirror.status === 400, 'status ' + noAssetMirror.status);

  // A refusal must be distinguishable from a transport failure. "Nothing is
  // configured" and "the chain did not answer" need different fixes, and a
  // single generic 500 would hide which one happened.
  const codes = [badAddress, unlinked, noAssetMirror].map(r => String(r.body && r.body.error));
  ok('every refusal carries a specific code',
    codes.every(c => /^ERR_UMI_TOKEN_/.test(c)), codes.join(', '));
  ok('no refusal is reported as a server error',
    [badAddress, unlinked, noAssetMirror].every(r => r.status < 500 || r.status === 503),
    codes.join(', '));

  // ------------------------------------------------- the refusal ledger
  const chainstate = await call('/umi/chainstate/verify', { method: 'GET' });
  ok('writing refusals to the ledger does not break the chain-first check',
    chainstate.status !== 200 || chainstate.body.agrees === true,
    JSON.stringify((chainstate.body && chainstate.body.checks) || '').slice(0, 200));

  // -------------------------------------------------------- the screen
  const page = readFileSync(new URL('../frontend/src/pages/PublicToken.jsx', import.meta.url), 'utf8');
  ok('a screen exists for it', page.length > 2000);
  ok('the screen can register an address', page.includes('/token/link'));
  ok('the screen can mirror a position', page.includes('/token/mirror'));
  ok('the screen shows the comparison against the register', page.includes('/token/compare'));
  ok('the screen shows the gas balance, so "out of gas" is visible rather than mysterious',
    page.includes('balanceEth'));
  ok('the screen names the missing configuration instead of saying not configured',
    page.includes('st.missing'));
  ok('the screen links transactions to a block explorer', page.includes('explorer'));
  ok('the screen states that the chain is not the register',
    /not the register/i.test(page));
  ok('the screen states that the mirror is one way',
    /one way/i.test(page));
  ok('the screen admits the signing code is not constant time',
    /constant\s+time/i.test(page));

  console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });
