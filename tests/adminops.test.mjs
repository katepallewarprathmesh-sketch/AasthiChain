// The operations queue decides what an operator sees and, more importantly,
// who is allowed to see it. These run against a live server.
import { randomBytes } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8080';

const tok = (identityId, mspId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 36e5 })).toString('base64');

const AS = {
  registrar: tok('registrar1', 'RegistrarMSP', 'Registrar'),
  regulator: tok('regulator1', 'RegulatorMSP', 'Regulator'),
  investor: tok('investor1', 'InvestorMSP', 'Investor'),
  originator: tok('originator1', 'OriginatorMSP', 'Originator'),
};

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const get = (who) => fetch(`${BASE}/api/admin/ops`, {
  headers: who ? { Authorization: 'Bearer ' + AS[who] } : {},
});

// --- who may look ---
t('anonymous is rejected', (await get(null)).status === 401);
t('an investor is refused', (await get('investor')).status === 403);
t('an originator is refused', (await get('originator')).status === 403);
t('a registrar is allowed', (await get('registrar')).status === 200);
t('a regulator is allowed', (await get('regulator')).status === 200);

const body = await (await get('registrar')).json();

// --- shape ---
const queues = ['awaitingValidation', 'validatedNotMinted', 'frozen',
  'stuckPayments', 'expiredPending', 'pendingKyc'];
t('every queue is present and is a list',
  queues.every(k => Array.isArray(body.queues[k])));
t('counts agree with the queues themselves',
  queues.every(k => body.counts[k] === body.queues[k].length));
t('actionable only counts the queues a human must clear',
  body.actionable === body.counts.awaitingValidation
    + body.counts.validatedNotMinted + body.counts.stuckPayments);
t('the report names who asked for it', body.actor.role === 'Registrar');
t('ledger health is reported', typeof body.chain.valid === 'boolean' && body.chain.blocks > 0);

// --- the rail is optional, never fatal ---
t('rail reachability is explicit', typeof body.rail.reachable === 'boolean');
if (body.rail.reachable) {
  t('failures are broken down by reason', typeof body.rail.failedByReason === 'object');
  const rec = body.rail.recoverable || [];
  t('every recoverable entry carries a positive shortfall',
    rec.every(r => r.largestShortfallINR > 0 && r.buyer && r.instructions > 0));
  t('recoverable failures are grouped one row per wallet',
    new Set(rec.map(r => r.buyer)).size === rec.length);
  t('the worst shortfall is listed first',
    rec.every((r, i) => i === 0 || rec[i - 1].largestShortfallINR >= r.largestShortfallINR));
}

// --- a newly listed title must appear in the validation queue ---
const reg = await fetch(`${BASE}/api/properties`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + AS.originator, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: 'Ops Queue Probe ' + Date.now(), state: 'Maharashtra', city: 'Pune', pincode: '411045',
    valuationINR: 4200000,
    // A fresh hash each run: the registry rejects a repeat document, which is
    // correct behaviour and would otherwise make this test pass only once.
    documentHash: randomBytes(32).toString('hex'),
  }),
});
if (reg.ok) {
  const { assetId } = await reg.json();
  const after = await (await get('registrar')).json();
  t('a freshly listed title shows up as awaiting validation',
    after.queues.awaitingValidation.some(x => x.assetId === assetId));
  t('the queue entry says how long it has been waiting',
    after.queues.awaitingValidation.every(x => typeof x.ageMins === 'number'));
} else {
  t('could list a property for the queue probe', false);
}

// --- freezing is supervisory, not something an investor can do ---
const freeze = (who) => fetch(`${BASE}/api/properties/PROP-GREEN-VALLEY-PUNE-001/freeze`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + AS[who], 'Content-Type': 'application/json' },
  body: JSON.stringify({ reason: 'authz probe' }),
});
t('an investor cannot freeze an asset', (await freeze('investor')).status === 403);
t('an originator cannot freeze an asset', (await freeze('originator')).status === 403);

console.log(`\n  admin ops: ${p} passed, ${f} failed`);
process.exit(f === 0 ? 0 : 1);
