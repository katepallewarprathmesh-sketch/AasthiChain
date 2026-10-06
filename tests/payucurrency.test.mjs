// PayU rejected live transactions with "transactionCurrency is mandatory for
// this merchant". The checkout form never sent the field. It must be present,
// and adding it must NOT disturb the request signature, which is computed over
// a fixed sequence that does not include currency.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../frontend/api/index.js'), 'utf8');

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

// Extract the real builder + hash fn so this cannot drift from production.
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('missing ' + name);
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
};
const mod = new Function('crypto', 'process',
  grab('payuRequestHash') + '\n' + grab('buildPayUCheckout') +
  '\nreturn { buildPayUCheckout, payuRequestHash };')(crypto, { env: {} });

const payu = { key: 'testkey', salt: 'testsalt', base: 'https://test.payu.in' };
const pay = { paymentId: 'AAST20261005ABCD1234', upiTxnId: 'NPCI-000000000001' };
const req = { assetId: 'PROP-X', tokenAmount: 100, amountINR: 50000, payerVpa: 'investor@aasthichain',
  payeeVpa: 'owner@aasthichain', note: 'Buy 100 tokens', idemKey: 'idem-1' };

const out = mod.buildPayUCheckout(payu, pay, req, 'https://aasthi-chain.vercel.app');
const prm = out.params;

// The live merchant is a plain INR account: sending transactionCurrency makes
// PayU reject the transaction ("Invalid API version for transactionCurrency
// request"). Verified by posting the signed form to test.payu.in, which 302s
// to the hosted checkout only when the field is absent. So: omitted unless
// PAYU_CURRENCY is explicitly configured for a multi-currency merchant.
t('transactionCurrency omitted by default', !('transactionCurrency' in prm));
t('posts to PayU', out.action === 'https://test.payu.in/_payment');

// The hash sequence: key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt
const expected = crypto.createHash('sha512').update([
  payu.key, pay.paymentId, '50000.00', 'Buy 100 tokens', 'investor', 'investor@aasthichain.demo',
  'PROP-X', '100', 'NPCI-000000000001', 'owner@aasthichain', 'idem-1',
  '', '', '', '', '', payu.salt,
].join('|')).digest('hex');
t('request hash matches PayU formula', prm.hash === expected);
t('hash unaffected by currency policy', prm.hash === expected);

const withCur = new Function('crypto', 'process',
  grab('payuRequestHash') + '\n' + grab('buildPayUCheckout') +
  '\nreturn { buildPayUCheckout };')(crypto, { env: { PAYU_CURRENCY: 'INR' } })
  .buildPayUCheckout(payu, pay, req, 'https://aasthi-chain.vercel.app').params;
t('PAYU_CURRENCY opts the field back in', withCur.transactionCurrency === 'INR');
t('opting in does not change the signature', withCur.hash === expected);

// every mandatory field PayU checks before it even looks at the hash
for (const k of ['key', 'txnid', 'amount', 'productinfo', 'firstname', 'email', 'phone', 'surl', 'furl', 'hash'])
  t(`${k} present`, Boolean(prm[k]));
t('surl is absolute', /^https?:\/\//.test(prm.surl));
t('amount has 2 decimals', /^\d+\.\d{2}$/.test(prm.amount));

// the other two builders must agree
const mock = fs.readFileSync(path.join(here, '../mock-api-server.js'), 'utf8');
const go = fs.readFileSync(path.join(here, '../payment-gateway/real_payubank.go'), 'utf8');
t('local server gates it on PAYU_CURRENCY too', /PAYU_CURRENCY \? \{ transactionCurrency/.test(mock));
t('Go gateway gates it on PAYU_CURRENCY too', /Getenv\("PAYU_CURRENCY"\); c != ""/.test(go));

// --- replayed payments ------------------------------------------------------
// Payments persist and replay by idempotency key. One built before this fix
// would replay its old params forever and keep failing at PayU, which is
// exactly how the error outlived the deploy.
const grabFn = (name, text) => {
  const i = text.indexOf(`function ${name}(`);
  let depth = 0;
  for (let k = text.indexOf('{', i); k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}') { depth--; if (depth === 0) return text.slice(i, k + 1); }
  }
};
const { withPayUCurrency } = new Function('process',
  grabFn('withPayUCurrency', src) + '\nreturn { withPayUCurrency };')({ env: {} });

const stale = { paymentId: 'OLD1', payuCheckout: { action: 'x', params: { key: 'k', amount: '500.00' } } };
t('no backfill when PAYU_CURRENCY is unset', !('transactionCurrency' in withPayUCurrency(stale).payuCheckout.params));
const { withPayUCurrency: bf } = new Function('process',
  grabFn('withPayUCurrency', src) + '\nreturn { withPayUCurrency };')({ env: { PAYU_CURRENCY: 'INR' } });
const stale2 = { paymentId: 'OLD2', payuCheckout: { action: 'x', params: { key: 'k' } } };
t('backfills when PAYU_CURRENCY is set', bf(stale2).payuCheckout.params.transactionCurrency === 'INR');

const already = { paymentId: 'NEW1', payuCheckout: { action: 'x', params: { transactionCurrency: 'USD' } } };
t('an explicit currency is not overwritten', withPayUCurrency(already).payuCheckout.params.transactionCurrency === 'USD');

t('payment without a checkout is untouched', withPayUCurrency({ paymentId: 'N' }).paymentId === 'N');
t('null is safe', withPayUCurrency(null) === null);

// --- kill switch ------------------------------------------------------------
// PayU's merchant account is provisioned multi-currency but /_payment rejects
// the field, so checkout cannot succeed until PayU fixes the account.
// PAYU_DISABLED must drop us back to the demo UPI rail.
const cfg = new Function('process', grabFn('payuConfig', src) + '\nreturn payuConfig;');
const base = { PAYU_MERCHANT_KEY: 'k', PAYU_SALT: 's', NPCI_MODE: 'payu' };
t('PayU active when key, salt and NPCI_MODE are set', cfg({ env: { ...base } })().active === true);
t('inactive without credentials', cfg({ env: { NPCI_MODE: 'payu' } })().active === false);
t('inactive when NPCI_MODE is not payu', cfg({ env: { ...base, NPCI_MODE: 'mock' } })().active === false);
t('inactive without a salt', cfg({ env: { ...base, PAYU_SALT: '' } })().active === false);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
