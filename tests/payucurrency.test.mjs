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

t('transactionCurrency is present', 'transactionCurrency' in prm);
t('currency is INR', prm.transactionCurrency === 'INR');
t('posts to PayU', out.action === 'https://test.payu.in/_payment');

// The hash sequence: key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt
const expected = crypto.createHash('sha512').update([
  payu.key, pay.paymentId, '50000.00', 'Buy 100 tokens', 'investor', 'investor@aasthichain.demo',
  'PROP-X', '100', 'NPCI-000000000001', 'owner@aasthichain', 'idem-1',
  '', '', '', '', '', payu.salt,
].join('|')).digest('hex');
t('request hash matches PayU formula', prm.hash === expected);
t('currency is NOT in the signed sequence', !expected.includes(prm.transactionCurrency) && prm.hash === expected);

// every mandatory field PayU checks before it even looks at the hash
for (const k of ['key', 'txnid', 'amount', 'productinfo', 'firstname', 'email', 'phone', 'surl', 'furl', 'hash'])
  t(`${k} present`, Boolean(prm[k]));
t('surl is absolute', /^https?:\/\//.test(prm.surl));
t('amount has 2 decimals', /^\d+\.\d{2}$/.test(prm.amount));

// the other two builders must agree
const mock = fs.readFileSync(path.join(here, '../mock-api-server.js'), 'utf8');
const go = fs.readFileSync(path.join(here, '../payment-gateway/real_payubank.go'), 'utf8');
t('local server sends it too', /transactionCurrency/.test(mock));
t('Go gateway sends it too', /transactionCurrency/.test(go));

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
