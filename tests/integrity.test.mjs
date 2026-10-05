// The integrity panel is only worth having if it FAILS when it should. These
// feed buildInsights the exact fault states seen in production and assert the
// verdict, not just that a field exists.
import { buildInsights } from '../frontend/api/lib/insights.mjs';

const app = {
  properties: [{ assetId: 'PROP-A', title: 'Indiabulls', totalTokens: 10000, tokenPrice: 500 }],
  balances: [{ assetId: 'PROP-A', ownerId: 'originator1', balance: 10000 }],
  transfers: [], kyc: [], chain: [],
};
const railOK = {
  config: { mode: 'simulation', persistence: { mode: 'postgres' } },
  reconciliation: { conserved: true, supplyConserved: true, supplyBreaches: [], totalBalanceINR: 100, totalFundedINR: 100 },
  instructions: [], wallets: [],
  chain: { totalBlocks: 5, verification: { valid: true }, durability: { durable: true, sealed: false } },
};
const clone = o => JSON.parse(JSON.stringify(o));
const get = (r, id) => (r.integrity.checks || []).find(c => c.id === id);

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

let r = buildInsights(app, railOK);
t('healthy system reports ok', r.integrity.ok === true && r.integrity.critical === 0);
t('every check passes', r.integrity.checks.every(c => c.ok));

// the real production fault: 10,110 tokens against a 10,000 issue
let rail = clone(railOK);
rail.reconciliation.supplyConserved = false;
rail.reconciliation.supplyBreaches = [{ assetId: 'PROP-A', authorisedTokens: 10000, outstandingTokens: 10110, excessTokens: 110 }];
r = buildInsights(app, rail);
t('supply breach fails the panel', r.integrity.ok === false && r.integrity.critical >= 1);
t('supply breach names the excess', /110/.test(get(r, 'supply-conserved').detail));

// app-side view of the same fault
const overApp = clone(app);
overApp.balances = [{ assetId: 'PROP-A', ownerId: 'originator1', balance: 10110 }];
r = buildInsights(overApp, railOK);
t('over-allocation detected from app state', get(r, 'allocation').ok === false);

rail = clone(railOK); rail.reconciliation.conserved = false;
t('money not conserved is critical', get(buildInsights(app, rail), 'cash-conserved').ok === false);

rail = clone(railOK); rail.chain.verification.valid = false;
t('tampered chain fails', get(buildInsights(app, rail), 'chain-valid').ok === false);

rail = clone(railOK); rail.chain.durability.durable = false;
r = buildInsights(app, rail);
t('in-memory ledger is a warning, not critical',
  get(r, 'durable').ok === false && get(r, 'durable').severity === 'warning' && r.integrity.critical === 0);

// an old rail build has no supplyConserved field at all — must not pass silently
rail = clone(railOK); delete rail.reconciliation.supplyConserved;
r = buildInsights(app, rail);
t('missing supply field is reported, not assumed healthy', get(r, 'supply-conserved').ok === false);

r = buildInsights(app, null);
t('unreachable rail degrades without throwing', r.integrity.ok === false && get(r, 'rail').ok === false);
t('allocation still checked without the rail', Boolean(get(r, 'allocation')));

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
