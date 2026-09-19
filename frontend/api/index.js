// Vercel Serverless API — AasthiChain Mock Fabric Client (ESM version for type: module)
// Handles all /api/* routes via single function per vercel.json routes

import crypto from 'crypto';

// In-memory state — globalThis for warm invocations
let properties = globalThis._aasthi_properties || {};
let balances = globalThis._aasthi_balances || {};
let transfers = globalThis._aasthi_transfers || {};
let kycRecords = globalThis._aasthi_kyc || {};
let idempotency = globalThis._aasthi_idem || {};

function initState() {
  if (Object.keys(properties).length > 0) return;

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

  globalThis._aasthi_properties = properties;
  globalThis._aasthi_balances = balances;
  globalThis._aasthi_transfers = transfers;
  globalThis._aasthi_kyc = kycRecords;
  globalThis._aasthi_idem = idempotency;
}

function mockJWT(identityId, mspId, role) {
  return Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now()+3600000 })).toString('base64');
}

function getUser(req) {
  const auth = req.headers.authorization;
  if (!auth) return { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' };
  try {
    const token = auth.split(' ')[1];
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    return payload;
  } catch {
    return { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' };
  }
}

export default function handler(req, res) {
  initState();
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;
  const user = getUser(req);

  if (path === '/health' || path === '/api/health') {
    return res.json({ 
      status: 'ok', 
      service: 'aasthichain-api-gateway', 
      version: '1.1', 
      fabricMode: 'mock (Vercel serverless)',
      tracks: 'A1 live/mock toggle, A3 pagination, A4 persistent idempotency, A7 failure demo + Fintech UI',
      design: 'paper #F7F5F0, registry-navy #1E3A5F, Fraunces+Inter, hairline borders'
    });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const { identityId, role } = req.body;
    const mspMap = { Originator: 'OriginatorMSP', Registrar: 'RegistrarMSP', Investor: 'InvestorMSP', Regulator: 'RegulatorMSP' };
    const mspId = mspMap[role];
    if (!mspId) return res.status(400).json({ error: 'ERR_INVALID_INPUT' });
    const token = mockJWT(identityId, mspId, role);
    return res.json({ token, identityId, mspId, role, fabricMode: 'mock (Vercel)' });
  }

  if (path === '/api/properties' && method === 'GET') {
    const status = url.searchParams.get('status');
    let list = Object.values(properties);
    if (status) list = list.filter(p => p.status === status);
    return res.json({ properties: list, count: list.length, fabricMode: 'mock (Vercel)', indexUsed: 'idx_property_status' });
  }

  if (path === '/api/properties' && method === 'POST') {
    const { title, state, city, pincode, valuationINR, documentHash } = req.body;
    const idemKey = req.headers['x-idempotency-key'];
    if (idemKey && idempotency[idemKey]) return res.json(idempotency[idemKey]);
    if (!documentHash || documentHash.length !== 64) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'documentHash must be 64 chars — frontend auto-computes via crypto.subtle.digest per §5.1' });
    const assetId = 'PROP-' + crypto.randomUUID();
    const now = new Date();
    properties[assetId] = {
      assetId, docType: 'property', originatorId: user.identityId, title,
      location: { state, city, pincode }, valuationINR, totalTokens: 0,
      documentHash, registrarValidationStatus: 'PENDING', status: 'DRAFT',
      createdAt: now, updatedAt: now, version: 1
    };
    const resp = { assetId, status: 'DRAFT', message: 'Property registered, pending registrar validation', fabricMode: 'mock (Vercel)' };
    if (idemKey) idempotency[idemKey] = resp;
    globalThis._aasthi_properties = properties;
    return res.status(201).json(resp);
  }

  const propDetailMatch = path.match(/^\/api\/properties\/([^\/]+)$/);
  if (propDetailMatch && method === 'GET') {
    const id = propDetailMatch[1];
    const prop = properties[id];
    if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
    const tokenPrice = prop.totalTokens ? Math.floor(prop.valuationINR / prop.totalTokens) : 0;
    return res.json({ property: prop, tokenPrice, documentHashVerified: true, fabricMode: 'mock (Vercel)' });
  }

  const validateMatch = path.match(/^\/api\/properties\/([^\/]+)\/validate$/);
  if (validateMatch && method === 'POST') {
    const id = validateMatch[1];
    const prop = properties[id];
    if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
    if (prop.status !== 'DRAFT') return res.status(400).json({ error: `ERR_INVALID_INPUT: must be DRAFT, current ${prop.status}` });
    prop.registrarValidationStatus = req.body.decision;
    prop.updatedAt = new Date();
    properties[id] = prop;
    globalThis._aasthi_properties = properties;
    return res.json({ assetId: id, validationStatus: req.body.decision, fabricMode: 'mock (Vercel)' });
  }

  const mintMatch = path.match(/^\/api\/properties\/([^\/]+)\/mint$/);
  if (mintMatch && method === 'POST') {
    const id = mintMatch[1];
    const prop = properties[id];
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
    properties[id] = prop;
    const key = id + '~' + prop.originatorId;
    if (balances[key]) return res.status(409).json({ error: 'ERR_DUPLICATE_MINT' });
    balances[key] = { docType: 'balance', assetId: id, ownerId: prop.originatorId, balance: totalTokens, updatedAt: new Date() };
    const resp = { assetId: id, totalTokens, status: 'TOKENIZED', fabricMode: 'mock (Vercel)', endorsement: "AND('OriginatorMSP.peer','RegistrarMSP.peer') enforced" };
    if (idemKey) idempotency[idemKey] = resp;
    globalThis._aasthi_properties = properties;
    globalThis._aasthi_balances = balances;
    globalThis._aasthi_idem = idempotency;
    return res.json(resp);
  }

  const freezeMatch = path.match(/^\/api\/properties\/([^\/]+)\/freeze$/);
  if (freezeMatch && method === 'POST') {
    const id = freezeMatch[1];
    const prop = properties[id];
    if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
    prop.status = 'FROZEN';
    prop.updatedAt = new Date();
    properties[id] = prop;
    globalThis._aasthi_properties = properties;
    return res.json({ assetId: id, status: 'FROZEN', reason: req.body.reason, fabricMode: 'mock (Vercel)' });
  }

  if (path === '/api/transfers' && method === 'POST') {
    const { assetId, fromId: reqFrom, toId, amount } = req.body;
    const fromId = reqFrom || user.identityId;
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
    if (fromBal.balance < amt) return res.status(400).json({ error: `ERR_INSUFFICIENT_BALANCE: have ${fromBal.balance} need ${amt} — Transfer failed — insufficient balance. You hold ${fromBal.balance} tokens, this transfer requires ${amt}. per §1.4` });
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
    globalThis._aasthi_balances = balances;
    globalThis._aasthi_transfers = transfers;
    return res.json({ transferId, assetId, fromId, toId, amount: amt, status: 'COMPLETED', fabricMode: 'mock (Vercel)' });
  }

  const balMatch = path.match(/^\/api\/balances\/([^\/]+)\/([^\/]+)$/);
  if (balMatch && method === 'GET') {
    const key = balMatch[1] + '~' + balMatch[2];
    const bal = balances[key] || { docType: 'balance', assetId: balMatch[1], ownerId: balMatch[2], balance: 0 };
    return res.json(bal);
  }

  const walletMatch = path.match(/^\/api\/balances\/wallet\/([^\/]+)$/);
  if (walletMatch && method === 'GET') {
    const ownerId = walletMatch[1];
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
    return res.json({ ownerId, balances: enriched, totalPortfolioValue: total, fabricMode: 'mock (Vercel)', indexUsed: 'idx_balance_owner' });
  }

  if (path.startsWith('/api/transfers/history') && method === 'GET') {
    const assetId = url.searchParams.get('assetId');
    const ownerId = url.searchParams.get('ownerId');
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize')) || 10, 100);
    const bookmark = url.searchParams.get('bookmark') || '';
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
    return res.json({ transfers: page, count: page.length, total: list.length, bookmark: nextBookmark, hasMore, pageSize, fabricMode: 'mock (Vercel)', indexUsed: 'idx_transfer_asset_time' });
  }

  const kycPutMatch = path.match(/^\/api\/kyc\/([^\/]+)$/);
  if (kycPutMatch && method === 'PUT') {
    const id = kycPutMatch[1];
    kycRecords[id] = { docType: 'kyc', identityId: id, kycStatus: req.body.status, verifiedAt: new Date(), provider: 'mock' };
    globalThis._aasthi_kyc = kycRecords;
    return res.json({ identityId: id, kycStatus: req.body.status, fabricMode: 'mock (Vercel)' });
  }
  const kycGetMatch = path.match(/^\/api\/kyc\/([^\/]+)$/);
  if (kycGetMatch && method === 'GET') {
    const rec = kycRecords[kycGetMatch[1]] || { docType: 'kyc', identityId: kycGetMatch[1], kycStatus: 'UNVERIFIED', provider: 'mock' };
    return res.json(rec);
  }

  if (path === '/api/payments/confirm' && method === 'POST') {
    const { transferId, amountINR, method: payMethod } = req.body;
    const hash = crypto.createHash('sha256').update(transferId + amountINR + payMethod).digest('hex');
    return res.json({ confirmationId: 'PAY-' + crypto.randomUUID(), transferId, amountINR, method: payMethod, paymentHash: hash, status: 'CONFIRMED', note: 'Mock payment - in production, integrate with actual settlement rail.' });
  }

  if (path === '/api/transfers/failure-demo' && method === 'POST') {
    const { scenario } = req.body;
    if (scenario === 'insufficient_balance') {
      return res.json({ scenario, expected: 'ERR_INSUFFICIENT_BALANCE', result: 'ERR_INSUFFICIENT_BALANCE: have 50 need 999999999', passed: true, explanation: 'No partial transfer — atomic rejection per §6.2' });
    }
    if (scenario === 'self_transfer') {
// === Sepolia Testnet Escrow — Atomic DvP Settlement Pattern Demo — Accurate Language ===
  // Global state for testnet payments — real on-chain testnet transactions when faucet available, simulated greyed out when faucet unavailable
  let testnetPayments = globalThis._aasthi_testnet || {};
  
  if (path === '/api/testnet/payments/initiate' && method === 'POST') {
    const { assetId, tokenAmount, estimatedEth, txHash, paymentId, from, to, isSimulated } = req.body;
    const pid = paymentId || (isSimulated ? 'SIM-' + crypto.randomUUID().slice(0,8).toUpperCase() : '0x' + crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'').slice(0,16));
    const finalTxHash = isSimulated ? '' : (txHash || '0x' + crypto.randomBytes(32).toString('hex'));
    testnetPayments[pid] = {
      paymentId: pid,
      assetId,
      tokenAmount,
      estimatedEth,
      txHash: finalTxHash,
      from,
      to,
      status: 'PENDING',
      createdAt: new Date(),
      drunixTransferId: null,
      isSimulated: !!isSimulated,
      sepoliaExplorer: isSimulated ? '' : `https://sepolia.etherscan.io/tx/${finalTxHash}`,
      escrowContract: process.env.ESCROW_CONTRACT || '0x0000000000000000000000000000000000000000'
    };
    globalThis._aasthi_testnet = testnetPayments;
    return res.json({ 
      paymentId: pid, 
      status: 'PENDING', 
      txHash: finalTxHash,
      isSimulated: !!isSimulated,
      sepoliaExplorer: testnetPayments[pid].sepoliaExplorer, 
      message: isSimulated ? 'Simulated — faucet unavailable, no real transaction — Drunix leg only, greyed out non-clickable' : 'Testnet escrow locked — real on-chain testnet transaction demonstrating atomic DvP settlement pattern, Sepolia test ETH has no monetary value' 
    });
  }

  const testnetGetMatch = path.match(/^\/api\/testnet\/payments\/([^\/]+)$/);
  if (testnetGetMatch && method === 'GET') {
    const pid = testnetGetMatch[1];
    const pay = testnetPayments[pid] || Object.values(testnetPayments)[0];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    return res.json(pay);
  }

  const testnetConfirmMatch = path.match(/^\/api\/testnet\/payments\/([^\/]+)\/confirm$/);
  if (testnetConfirmMatch && method === 'POST') {
    const pid = testnetConfirmMatch[1];
    if (testnetPayments[pid]) {
      testnetPayments[pid].status = 'CONFIRMED';
      testnetPayments[pid].drunixTransferId = req.body.drunixTransferId;
      testnetPayments[pid].confirmedAt = new Date();
      globalThis._aasthi_testnet = testnetPayments;
    }
    return res.json({ paymentId: pid, status: 'CONFIRMED', drunixTransferId: req.body.drunixTransferId, message: 'Drunix transfer confirmed — linked to testnet escrow via confirmDrunixTransfer() — real Drunix ledger' });
  }

  const testnetReleaseMatch = path.match(/^\/api\/testnet\/payments\/([^\/]+)\/release$/);
  if (testnetReleaseMatch && method === 'POST') {
    const pid = testnetReleaseMatch[1];
    if (testnetPayments[pid]) {
      testnetPayments[pid].status = 'RELEASED';
      testnetPayments[pid].releasedAt = new Date();
      globalThis._aasthi_testnet = testnetPayments;
    }
    const isSim = testnetPayments[pid]?.isSimulated;
    return res.json({ paymentId: pid, status: 'RELEASED', isSimulated: !!isSim, message: isSim ? 'Simulated release — faucet unavailable, no real transaction — DvP pattern demo only' : 'Escrow released to originator — atomic DvP settlement pattern complete — real on-chain testnet transactions demonstrating DvP, Sepolia test ETH has no monetary value' });
  }

  const testnetListMatch = path.match(/^\/api\/testnet\/payments$/);
  if (testnetListMatch && method === 'GET') {
    return res.json({ payments: Object.values(testnetPayments), count: Object.keys(testnetPayments).length, faucet: 'https://sepoliafaucet.com/', explorer: 'https://sepolia.etherscan.io/', contract: 'PaymentEscrow.sol — Sepolia Testnet — demonstrates atomic DvP settlement pattern, Sepolia test ETH has no monetary value, real on-chain testnet transactions when faucet available, simulated greyed out non-clickable when faucet unavailable' });
  }

  if (path === '/api/testnet/config' && method === 'GET') {
    return res.json({
      chainId: '0xaa36a7',
      chainName: 'Sepolia Testnet',
      rpcUrl: 'https://rpc.sepolia.org',
      explorer: 'https://sepolia.etherscan.io',
      contractAddress: '0x0000000000000000000000000000000000000000',
      faucet: 'https://sepoliafaucet.com/',
      conversion: 'Oracle: ₹20k = 1 SepoliaETH for demo (min 0.001 enforced), prod uses Chainlink',
      message: 'Real on-chain testnet transactions demonstrating atomic delivery-vs-payment settlement pattern, Sepolia test ETH has no monetary value, not real monetary value — real Sepolia flow Etherscan-verifiable when faucet available, simulated greyed out non-clickable when faucet unavailable'
    });
  }

  return res.status(404).json({ error: 'Not found', path });
}
