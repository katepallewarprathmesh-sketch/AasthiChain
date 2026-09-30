#!/usr/bin/env node
/**
 * Regenerates data/*.json from a running server.
 *
 * data/ is the shared store the Vercel functions read via raw.githubusercontent.com,
 * because serverless instances do not share memory or /tmp. It had drifted to six
 * empty {} files, which made the deployed app fall back to whatever a single lambda
 * happened to hold.
 *
 * The seed is produced by DRIVING THE REAL API rather than hand-writing JSON, so the
 * records are exactly the shapes the application reads back. Hand-written fixtures
 * drift from the code the moment a field is added; these cannot.
 *
 * Everything written here is demo data and is marked as such — payments carry
 * simulated: true and a settlementRail, the same as any payment the app creates.
 *
 * Usage:
 *   node mock-api-server.js &
 *   node scripts/seed-data.mjs
 */

import fs from 'fs';
import path from 'path';

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:8080';
const ASSET = 'PROP-GREEN-VALLEY-PUNE-001';
const OUT = path.join(process.cwd(), 'data');

const IDENTITIES = [
  ['originator1', 'Originator'],
  ['registrar1', 'Registrar'],
  ['investor1', 'Investor'],
  ['investor2', 'Investor'],
  ['regulator1', 'Regulator'],
];

async function login(identityId, role) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityId, role }),
  });
  if (!r.ok) throw new Error(`login ${identityId}: HTTP ${r.status}`);
  return (await r.json()).token;
}

async function get(p, token) {
  const r = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
  return r.json();
}

async function post(p, token, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`POST ${p}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

const main = async () => {
  console.log(`\nSeeding data/ from ${BASE}\n`);

  const tokens = {};
  for (const [id, role] of IDENTITIES) tokens[id] = await login(id, role);
  const inv1 = tokens.investor1;

  // ---- properties -------------------------------------------------------
  const propsResp = await get('/api/properties', inv1);
  const propList = propsResp.properties || propsResp.items || propsResp;
  const properties = {};
  for (const p of (Array.isArray(propList) ? propList : [])) {
    const full = await get(`/api/properties/${p.assetId}`, inv1).catch(() => p);
    properties[p.assetId] = full;
  }
  console.log(`  properties      ${Object.keys(properties).length}`);

  // ---- KYC --------------------------------------------------------------
  // Read each identity's own record with its own token: the counterparty view
  // is deliberately redacted, so seeding from another identity would persist
  // the redacted shape.
  const kyc = {};
  for (const [id] of IDENTITIES) {
    kyc[id] = await get(`/api/kyc/${id}`, tokens[id]);
  }
  console.log(`  kyc             ${Object.keys(kyc).length}`);

  // ---- a couple of real, completed payments -----------------------------
  // Driven through collect -> approve -> settle so the records carry genuine
  // UTRs, risk scores from the trained model, and ledger references.
  const npci_payments = {};
  const utr_index = {};
  for (const [amt, tok] of [[5000, 10], [12500, 25]]) {
    const created = await post('/api/npci/collect', inv1, {
      amountINR: amt, tokenAmount: tok, assetId: ASSET,
      payerVpa: 'investor1@okhdfcbank', payeeVpa: 'originator1@okicici',
    });
    const id = created.paymentId;
    await post(`/api/npci/payments/${id}/approve`, inv1, {});
    await post(`/api/npci/payments/${id}/settle`, inv1, {}).catch(() => {});
    const final = await get(`/api/npci/payments/${id}`, inv1);
    const rec = final.payment || final;
    npci_payments[id] = rec;
    if (rec.utr || rec.utr12) utr_index[rec.utr12 || rec.utr] = id;
  }
  console.log(`  npci_payments   ${Object.keys(npci_payments).length}`);
  console.log(`  utr_index       ${Object.keys(utr_index).length}`);

  // ---- balances ---------------------------------------------------------
  const balances = {};
  for (const owner of ['originator1', 'investor1', 'investor2']) {
    try {
      const b = await get(`/api/balances/${ASSET}/${owner}`, tokens[owner]);
      if (b && b.balance !== undefined) balances[`${ASSET}~${owner}`] = b;
    } catch { /* an owner with no holding is legitimately absent */ }
  }
  console.log(`  balances        ${Object.keys(balances).length}`);

  // ---- transfers --------------------------------------------------------
  const tResp = await get('/api/transfers/history?limit=25', inv1).catch(() => ({}));
  const tList = tResp.transfers || tResp.items || [];
  const transfers = {};
  for (const t of tList) {
    const key = t.transferId || t.txId || t.id;
    if (key) transfers[key] = t;
  }
  console.log(`  transfers       ${Object.keys(transfers).length}`);

  // webhooks is an append-only delivery audit log. Empty is the correct
  // initial state — there is nothing to seed, and inventing entries would
  // imply deliveries that never happened.
  const webhooks = [];

  fs.mkdirSync(OUT, { recursive: true });
  const files = {
    'properties.json': properties,
    'balances.json': balances,
    'transfers.json': transfers,
    'kyc.json': kyc,
    'npci_payments.json': npci_payments,
    'utr_index.json': utr_index,
    'webhooks.json': webhooks,
  };
  for (const [name, obj] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2) + '\n');
  }

  console.log('\nwrote:');
  for (const name of Object.keys(files)) {
    const p = path.join(OUT, name);
    console.log(`  data/${name.padEnd(20)} ${String(fs.statSync(p).size).padStart(7)} bytes`);
  }
  console.log('');
};

main().catch(e => { console.error('seed failed:', e.message); process.exit(1); });
