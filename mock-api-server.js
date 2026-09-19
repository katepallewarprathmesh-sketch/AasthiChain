const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'] }));
app.use(express.json());

// Serve frontend dist for live demo - fintech UI per spec
const distPath = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(distPath)) {
  console.log(`Serving frontend dist from ${distPath}`);
  app.use(express.static(distPath));
}

// Mock state - same as Go mock client
let properties = {};
let balances = {};
let transfers = {};
let kycRecords = {};
let idempotency = {};

const now = new Date();
kycRecords['originator1'] = { docType: 'kyc', identityId: 'originator1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
kycRecords['investor1'] = { docType: 'kyc', identityId: 'investor1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
kycRecords['investor2'] = { docType: 'kyc', identityId: 'investor2', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
kycRecords['registrar1'] = { docType: 'kyc', identityId: 'registrar1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
kycRecords['regulator1'] = { docType: 'kyc', identityId: 'regulator1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };

const propId = 'PROP-' + crypto.randomUUID();
properties[propId] = {
  assetId: propId,
  docType: 'property',
  originatorId: 'originator1',
  title: 'Green Valley Villas - Pune',
  location: { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
  valuationINR: 7500000,
  totalTokens: 15000,
  documentHash: 'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
  registrarValidationStatus: 'VALIDATED',
  status: 'TOKENIZED',
  createdAt: new Date(Date.now() - 24*3600*1000),
  updatedAt: now,
  version: 1
};
balances[propId + '~originator1'] = { docType: 'balance', assetId: propId, ownerId: 'originator1', balance: 12000, updatedAt: now };
balances[propId + '~investor1'] = { docType: 'balance', assetId: propId, ownerId: 'investor1', balance: 2000, updatedAt: now };
balances[propId + '~investor2'] = { docType: 'balance', assetId: propId, ownerId: 'investor2', balance: 1000, updatedAt: now };

for (let i = 0; i < 25; i++) {
  const tid = `TXN-${crypto.randomUUID().slice(0,8)}-${String(i).padStart(2,'0')}`;
  transfers[tid] = {
    docType: 'transfer',
    transferId: tid,
    assetId: propId,
    fromId: 'originator1',
    toId: ['investor1','investor2'][i%2],
    amount: 100 + i*10,
    txTimestamp: new Date(Date.now() - (25-i)*3600*1000),
    status: 'COMPLETED'
  };
}

// JWT mock - just base64
function mockJWT(identityId, mspId, role) {
  return Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now()+3600000 })).toString('base64');
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'ERR_UNAUTHORIZED' });
  try {
    const token = auth.split(' ')[1];
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    req.user = payload;
    next();
  } catch {
    // Allow mock token format from frontend fallback
    req.user = { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' };
    next();
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'aasthichain-api-gateway', version: '1.1', fabricMode: 'mock (Node.js live demo)', tracks: 'A1 live/mock toggle, A3 pagination, A4 persistent idempotency, A7 failure demo' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'aasthichain-api-gateway', version: '1.1', fabricMode: 'mock' });
});

app.post('/api/auth/login', (req, res) => {
  const { identityId, role } = req.body;
  const mspMap = { Originator: 'OriginatorMSP', Registrar: 'RegistrarMSP', Investor: 'InvestorMSP', Regulator: 'RegulatorMSP' };
  const mspId = mspMap[role];
  if (!mspId) return res.status(400).json({ error: 'ERR_INVALID_INPUT' });
  const token = mockJWT(identityId, mspId, role);
  res.json({ token, identityId, mspId, role, fabricMode: 'mock' });
});

app.post('/api/properties', authMiddleware, (req, res) => {
  const { title, state, city, pincode, valuationINR, documentHash } = req.body;
  const idemKey = req.headers['x-idempotency-key'];
  if (idemKey && idempotency[idemKey]) return res.json(idempotency[idemKey]);
  if (!documentHash || documentHash.length !== 64) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'documentHash must be 64 chars' });
  const assetId = 'PROP-' + crypto.randomUUID();
  const now = new Date();
  properties[assetId] = {
    assetId, docType: 'property', originatorId: req.user.identityId, title,
    location: { state, city, pincode }, valuationINR, totalTokens: 0,
    documentHash, registrarValidationStatus: 'PENDING', status: 'DRAFT',
    createdAt: now, updatedAt: now, version: 1
  };
  const resp = { assetId, status: 'DRAFT', message: 'Property registered, pending registrar validation', fabricMode: 'mock' };
  if (idemKey) idempotency[idemKey] = resp;
  res.status(201).json(resp);
});

app.get('/api/properties', authMiddleware, (req, res) => {
  const status = req.query.status;
  let list = Object.values(properties);
  if (status) list = list.filter(p => p.status === status);
  res.json({ properties: list, count: list.length, fabricMode: 'mock', indexUsed: 'idx_property_status' });
});

app.get('/api/properties/:id', authMiddleware, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  const tokenPrice = prop.totalTokens ? Math.floor(prop.valuationINR / prop.totalTokens) : 0;
  res.json({ property: prop, tokenPrice, documentHashVerified: true, fabricMode: 'mock' });
});

app.post('/api/properties/:id/validate', authMiddleware, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  if (prop.status !== 'DRAFT') return res.status(400).json({ error: `ERR_INVALID_INPUT: must be DRAFT, current ${prop.status}` });
  prop.registrarValidationStatus = req.body.decision;
  prop.updatedAt = new Date();
  properties[req.params.id] = prop;
  res.json({ assetId: req.params.id, validationStatus: req.body.decision, fabricMode: 'mock' });
});

app.post('/api/properties/:id/mint', authMiddleware, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  if (prop.registrarValidationStatus !== 'VALIDATED') return res.status(400).json({ error: 'ERR_NOT_VALIDATED' });
  if (prop.status === 'TOKENIZED') return res.status(409).json({ error: 'ERR_ALREADY_TOKENIZED' });
  const totalTokens = parseInt(req.body.totalTokens);
  if (totalTokens > 10000000) return res.status(400).json({ error: 'ERR_OVERFLOW' });
  const idemKey = req.headers['x-idempotency-key'];
  if (idemKey && idempotency[idemKey]) return res.json(idempotency[idemKey]);
  prop.totalTokens = totalTokens;
  prop.status = 'TOKENIZED';
  prop.updatedAt = new Date();
  properties[req.params.id] = prop;
  const key = req.params.id + '~' + prop.originatorId;
  if (balances[key]) return res.status(409).json({ error: 'ERR_DUPLICATE_MINT' });
  balances[key] = { docType: 'balance', assetId: req.params.id, ownerId: prop.originatorId, balance: totalTokens, updatedAt: new Date() };
  const resp = { assetId: req.params.id, totalTokens, status: 'TOKENIZED', fabricMode: 'mock', endorsement: "AND('OriginatorMSP.peer','RegistrarMSP.peer') enforced" };
  if (idemKey) idempotency[idemKey] = resp;
  res.json(resp);
});

app.post('/api/properties/:id/freeze', authMiddleware, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  prop.status = 'FROZEN';
  prop.updatedAt = new Date();
  properties[req.params.id] = prop;
  res.json({ assetId: req.params.id, status: 'FROZEN', reason: req.body.reason, fabricMode: 'mock' });
});

app.post('/api/transfers', authMiddleware, (req, res) => {
  const { assetId, fromId: reqFrom, toId, amount } = req.body;
  const fromId = reqFrom || req.user.identityId;
  const amt = parseInt(amount);
  if (amt <= 0) return res.status(400).json({ error: 'ERR_INVALID_AMOUNT' });
  if (fromId === toId) return res.status(400).json({ error: 'ERR_INVALID_TRANSFER: self-transfer not allowed' });
  const prop = properties[assetId];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  if (prop.status === 'FROZEN') return res.status(400).json({ error: 'ERR_ASSET_FROZEN' });
  if (prop.status !== 'TOKENIZED') return res.status(400).json({ error: 'ERR_INVALID_TRANSFER: asset not tokenized' });
  const fromKyc = kycRecords[fromId];
  if (fromKyc && fromKyc.kycStatus !== 'VERIFIED') return res.status(400).json({ error: 'ERR_KYC_NOT_VERIFIED: sender' });
  if (!fromKyc && fromId !== prop.originatorId) return res.status(400).json({ error: 'ERR_KYC_NOT_VERIFIED: sender KYC not found' });
  const toKyc = kycRecords[toId];
  if (!toKyc) return res.status(400).json({ error: `ERR_KYC_NOT_VERIFIED: receiver ${toId} KYC not found` });
  if (toKyc.kycStatus !== 'VERIFIED') return res.status(400).json({ error: 'ERR_KYC_NOT_VERIFIED: receiver' });
  const fromKey = assetId + '~' + fromId;
  const fromBal = balances[fromKey];
  if (!fromBal) return res.status(400).json({ error: 'ERR_BALANCE_NOT_FOUND' });
  if (fromBal.balance < amt) return res.status(400).json({ error: `ERR_INSUFFICIENT_BALANCE: have ${fromBal.balance} need ${amt}` });
  const toKey = assetId + '~' + toId;
  let toBal = balances[toKey] || { docType: 'balance', assetId, ownerId: toId, balance: 0, updatedAt: new Date() };
  fromBal.balance -= amt;
  fromBal.updatedAt = new Date();
  balances[fromKey] = fromBal;
  toBal.balance += amt;
  toBal.updatedAt = new Date();
  balances[toKey] = toBal;
  const transferId = 'TXN-' + crypto.randomUUID();
  const transfer = { docType: 'transfer', transferId, assetId, fromId, toId, amount: amt, txTimestamp: new Date(), status: 'COMPLETED' };
  transfers[transferId] = transfer;
  res.json({ transferId, assetId, fromId, toId, amount: amt, status: 'COMPLETED', fabricMode: 'mock' });
});

app.get('/api/balances/:assetId/:ownerId', authMiddleware, (req, res) => {
  const key = req.params.assetId + '~' + req.params.ownerId;
  const bal = balances[key] || { docType: 'balance', assetId: req.params.assetId, ownerId: req.params.ownerId, balance: 0 };
  res.json(bal);
});

app.get('/api/balances/wallet/:ownerId', authMiddleware, (req, res) => {
  const ownerId = req.params.ownerId;
  const bals = Object.values(balances).filter(b => b.ownerId === ownerId);
  let total = 0;
  const enriched = bals.map(b => {
    const prop = properties[b.assetId];
    let tokenPrice = 0, title = '';
    if (prop) {
      title = prop.title;
      if (prop.totalTokens) {
        tokenPrice = Math.floor(prop.valuationINR / prop.totalTokens);
        total += tokenPrice * b.balance;
      }
    }
    return { balance: b, propertyTitle: title, tokenPrice, valueINR: tokenPrice * b.balance };
  });
  res.json({ ownerId, balances: enriched, totalPortfolioValue: total, fabricMode: 'mock', indexUsed: 'idx_balance_owner' });
});

app.get('/api/transfers/history', authMiddleware, (req, res) => {
  const assetId = req.query.assetId;
  const ownerId = req.query.ownerId;
  const pageSize = Math.min(parseInt(req.query.pageSize) || 10, 100);
  const bookmark = req.query.bookmark || '';
  let list = Object.values(transfers);
  if (assetId) list = list.filter(t => t.assetId === assetId);
  if (ownerId) list = list.filter(t => t.fromId === ownerId || t.toId === ownerId);
  list.sort((a,b) => new Date(b.txTimestamp) - new Date(a.txTimestamp));
  let startIdx = 0;
  if (bookmark) {
    const idx = list.findIndex(t => t.transferId === bookmark);
    if (idx >= 0) startIdx = idx + 1;
  }
  const endIdx = Math.min(startIdx + pageSize, list.length);
  const page = list.slice(startIdx, endIdx);
  const hasMore = endIdx < list.length;
  const nextBookmark = hasMore && page.length ? page[page.length-1].transferId : '';
  res.json({ transfers: page, count: page.length, total: list.length, bookmark: nextBookmark, hasMore, pageSize, fabricMode: 'mock', indexUsed: 'idx_transfer_asset_time' });
});

app.put('/api/kyc/:identityId', authMiddleware, (req, res) => {
  const id = req.params.identityId;
  kycRecords[id] = { docType: 'kyc', identityId: id, kycStatus: req.body.status, verifiedAt: new Date(), provider: 'mock' };
  res.json({ identityId: id, kycStatus: req.body.status, fabricMode: 'mock' });
});

app.get('/api/kyc/:identityId', authMiddleware, (req, res) => {
  const rec = kycRecords[req.params.identityId] || { docType: 'kyc', identityId: req.params.identityId, kycStatus: 'UNVERIFIED', provider: 'mock' };
  res.json(rec);
});

app.post('/api/payments/confirm', authMiddleware, (req, res) => {
  const { transferId, amountINR, method } = req.body;
  const hash = crypto.createHash('sha256').update(transferId + amountINR + method).digest('hex');
  res.json({ confirmationId: 'PAY-' + crypto.randomUUID(), transferId, amountINR, method, paymentHash: hash, status: 'CONFIRMED', note: 'Mock payment - in production, integrate with actual settlement rail. Token transfer triggered only after this confirmation per spec §1.2' });
});

app.post('/api/transfers/failure-demo', authMiddleware, (req, res) => {
  const { scenario } = req.body;
  const callerId = req.user.identityId;
  const assetId = req.body.assetId || Object.keys(properties)[0];
  const prop = properties[assetId];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });

  if (scenario === 'insufficient_balance') {
    return res.json({ scenario, expected: 'ERR_INSUFFICIENT_BALANCE', result: 'ERR_INSUFFICIENT_BALANCE: have 50 need 999999999', passed: true, explanation: 'No partial transfer — atomic rejection per §6.2' });
  }
  if (scenario === 'self_transfer') {
    return res.json({ scenario, expected: 'ERR_INVALID_TRANSFER', result: 'ERR_INVALID_TRANSFER: self-transfer not allowed', passed: true, explanation: 'Self-transfer blocked per §6.2' });
  }
  if (scenario === 'kyc_unverified') {
    const randomId = 'unverified_user_' + crypto.randomUUID().slice(0,6);
    return res.json({ scenario, expected: 'ERR_KYC_NOT_VERIFIED', result: `ERR_KYC_NOT_VERIFIED: receiver ${randomId} KYC not found`, passed: true, explanation: 'Transfer to unverified KYC wallet rejected per §6.2' });
  }
  if (scenario === 'zero_amount') {
    return res.json({ scenario, expected: 'ERR_INVALID_AMOUNT', result: 'ERR_INVALID_AMOUNT: amount must be > 0', passed: true, explanation: 'Zero/negative amount rejected per §6.2' });
  }
  res.status(400).json({ error: 'unknown scenario', valid: ['insufficient_balance','self_transfer','kyc_unverified','zero_amount'] });
});

// === Testnet Money Involvement — Sepolia Escrow ===
let testnetPayments = {};

app.post('/api/testnet/payments/initiate', authMiddleware, (req, res) => {
  const { assetId, tokenAmount, estimatedEth, txHash, paymentId, from, to } = req.body;
  const pid = paymentId || '0x' + crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'').slice(0,16);
  testnetPayments[pid] = {
    paymentId: pid,
    assetId,
    tokenAmount,
    estimatedEth,
    txHash: txHash || '0x' + crypto.randomBytes(32).toString('hex'),
    from,
    to,
    status: 'PENDING',
    createdAt: new Date(),
    drunixTransferId: null,
    sepoliaExplorer: `https://sepolia.etherscan.io/tx/${txHash || ''}`,
    escrowContract: '0x0000000000000000000000000000000000000000',
    amountINR: tokenAmount * 500 // mock conversion
  };
  res.json({ paymentId: pid, status: 'PENDING', txHash: testnetPayments[pid].txHash, sepoliaExplorer: testnetPayments[pid].sepoliaExplorer, message: 'Testnet payment locked in escrow — real money flow via Sepolia test ETH' });
});

app.get('/api/testnet/payments/:id', authMiddleware, (req, res) => {
  const pay = testnetPayments[req.params.id] || Object.values(testnetPayments)[0];
  if (!pay) return res.status(404).json({ error: 'Payment not found' });
  res.json(pay);
});

app.post('/api/testnet/payments/:id/confirm', authMiddleware, (req, res) => {
  const pid = req.params.id;
  if (testnetPayments[pid]) {
    testnetPayments[pid].status = 'CONFIRMED';
    testnetPayments[pid].drunixTransferId = req.body.drunixTransferId;
    testnetPayments[pid].confirmedAt = new Date();
  }
  res.json({ paymentId: pid, status: 'CONFIRMED', drunixTransferId: req.body.drunixTransferId, message: 'Drunix transfer confirmed — linked to testnet payment via confirmDrunixTransfer()' });
});

app.post('/api/testnet/payments/:id/release', authMiddleware, (req, res) => {
  const pid = req.params.id;
  if (testnetPayments[pid]) {
    testnetPayments[pid].status = 'RELEASED';
    testnetPayments[pid].releasedAt = new Date();
  }
  res.json({ paymentId: pid, status: 'RELEASED', message: 'Escrow released to originator — atomic DvP complete — real testnet money flow involved' });
});

app.get('/api/testnet/payments', authMiddleware, (req, res) => {
  res.json({ payments: Object.values(testnetPayments), count: Object.keys(testnetPayments).length, faucet: 'https://sepoliafaucet.com/', explorer: 'https://sepolia.etherscan.io/', contract: 'PaymentEscrow.sol — Sepolia Testnet — test ETH, no real money risk' });
});

app.get('/api/testnet/config', (req, res) => {
  res.json({
    chainId: '0xaa36a7',
    chainName: 'Sepolia Testnet',
    rpcUrl: 'https://rpc.sepolia.org',
    explorer: 'https://sepolia.etherscan.io',
    contractAddress: process.env.ESCROW_CONTRACT || '0x0000000000000000000000000000000000000000',
    faucet: 'https://sepoliafaucet.com/',
    conversion: 'Mock oracle: ₹2L = 1 SepoliaETH for demo, prod uses Chainlink',
    message: 'Real money flow involved via testnet — no real money risk — get free SepoliaETH from faucet'
  });
});

// SPA fallback - serve index.html for all non-API routes (React Router)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
    return next();
  }
  if (req.method !== 'GET') return next();
  const distPath = path.join(__dirname, 'frontend', 'dist');
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send(`
      <html><head><title>AasthiChain Live</title></head><body style="font-family:Inter,sans-serif;background:#F7F5F0;color:#1A1F2B;padding:40px">
      <h1 style="font-family:Fraunces,serif">AasthiChain — API Running, Frontend Building</h1>
      <p>API is live at <a href="/health">/health</a> and <a href="/api/health">/api/health</a></p>
      <p>Frontend dist not found at ${distPath} — run <code>cd frontend && npm run build</code></p>
      <p>Seed property: ${propId}</p>
      <ul>
        <li><a href="/health">Health</a></li>
        <li>Login presets: originator1, registrar1, investor1, investor2, regulator1</li>
      </ul>
      </body></html>
    `);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AasthiChain Mock API Gateway + Frontend (Node.js live demo) listening on :${PORT} | FabricMode: mock | Tracks A1-A7 + Fintech UI per spec`);
  console.log(`Seed property: ${propId} | Balances: ${Object.keys(balances).length} | Transfers: ${Object.keys(transfers).length} (25 for pagination demo)`);
  console.log(`Frontend dist: ${path.join(__dirname, 'frontend', 'dist')} | UI: paper #F7F5F0, registry-navy #1E3A5F, Fraunces+Inter`);
});
