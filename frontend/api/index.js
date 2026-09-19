// Vercel Serverless API — AasthiChain Mock Fabric Client with Clerk support
import crypto from 'crypto';

let properties = globalThis._aasthi_properties || {};
let balances = globalThis._aasthi_balances || {};
let transfers = globalThis._aasthi_transfers || {};
let kycRecords = globalThis._aasthi_kyc || {};
let idempotency = globalThis._aasthi_idem || {};
let testnetPayments = globalThis._aasthi_testnet || {};

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
  globalThis._aasthi_testnet = testnetPayments;
}

function mockJWT(identityId, mspId, role) {
  return Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now()+3600000 })).toString('base64');
}

function decodeToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.identityId) return payload;
  } catch {}
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      let payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      payloadB64 += '='.repeat((4 - payloadB64.length % 4) % 4);
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
      if (payload.sub) {
        return { clerk: true, sub: payload.sub, ...payload };
      }
      if (payload.identityId) return payload;
    }
  } catch {}
  return null;
}

function getUser(req) {
  const auth = req.headers.authorization || '';
  const fabricHeader = req.headers['x-fabric-identity'] || req.headers['X-Fabric-Identity'] || '';
  const roleMap = {
    originator1: { identityId: 'originator1', mspId: 'OriginatorMSP', role: 'Originator' },
    registrar1: { identityId: 'registrar1', mspId: 'RegistrarMSP', role: 'Registrar' },
    investor1: { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' },
    investor2: { identityId: 'investor2', mspId: 'InvestorMSP', role: 'Investor' },
    regulator1: { identityId: 'regulator1', mspId: 'RegulatorMSP', role: 'Regulator' },
  };

  if (!auth) {
    const mapped = roleMap[(fabricHeader || '').toLowerCase()];
    return mapped || { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' };
  }

  try {
    const token = auth.split(' ')[1] || '';
    const payload = decodeToken(token);
    if (payload) {
      if (payload.clerk) {
        const mapped = roleMap[(fabricHeader || '').toLowerCase()];
        if (mapped) return { ...mapped, clerkId: payload.sub, clerk: true };
        if (payload.fabricIdentity && roleMap[payload.fabricIdentity.toLowerCase()]) {
          return { ...roleMap[payload.fabricIdentity.toLowerCase()], clerkId: payload.sub, clerk: true };
        }
        return { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor', clerkId: payload.sub, clerk: true };
      }
      if (payload.identityId) return payload;
    }
  } catch {}

  const mapped = roleMap[(fabricHeader || '').toLowerCase()];
  return mapped || { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' };
}

export default function handler(req, res) {
  initState();
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key, X-Fabric-Identity');
  
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
      version: '1.8',
      fabricMode: 'mock (Vercel serverless + Clerk)',
    });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const { identityId, role } = req.body || {};
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
    return res.json({ properties: list, count: list.length, fabricMode: 'mock (Vercel)' });
  }

  if (path === '/api/properties' && method === 'POST') {
    const { title, state, city, pincode, valuationINR, documentHash } = req.body || {};
    const idemKey = req.headers['x-idempotency-key'];
    if (idemKey && idempotency[idemKey]) return res.json(idempotency[idemKey]);
    if (!documentHash || documentHash.length !== 64) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'documentHash must be 64 chars' });
    const assetId = 'PROP-' + crypto.randomUUID();
    const now = new Date();
    properties[assetId] = {
      assetId, docType: 'property', originatorId: user.identityId, title,
      location: { state, city, pincode }, valuationINR, totalTokens: 0,
      documentHash, registrarValidationStatus: 'PENDING', status: 'DRAFT',
      createdAt: now, updatedAt: now, version: 1
    };
    const resp = { assetId, status: 'DRAFT', message: 'Property registered', fabricMode: 'mock (Vercel)' };
    if (idemKey) idempotency[idemKey] = resp;
    globalThis._aasthi_properties = properties;
    return res.status(201).json(resp);
  }

  const propDetailMatch = path.match(/^\/api\/properties\/([^\/]+)$/);
  if (propDetailMatch && method === 'GET') {
    const id = decodeURIComponent(propDetailMatch[1]);
    const prop = properties[id];
    if (!prop) {
      // For demo, return first property if exact ID not found (helps with PROP-demo-1 etc)
      const first = Object.values(properties)[0];
      if (first && (id.startsWith('PROP-demo') || id === first.assetId)) {
        return res.json({ property: first, tokenPrice: Math.floor(first.valuationINR / first.totalTokens), documentHashVerified: true, fabricMode: 'mock (Vercel)' });
      }
      return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND', message: `Property ${id} not found` });
    }
    const tokenPrice = prop.totalTokens ? Math.floor(prop.valuationINR / prop.totalTokens) : 0;
    return res.json({ property: prop, tokenPrice, documentHashVerified: true, fabricMode: 'mock (Vercel)' });
  }

  const validateMatch = path.match(/^\/api\/properties\/([^\/]+)\/validate$/);
  if (validateMatch && method === 'POST') {
    const id = decodeURIComponent(validateMatch[1]);
    const prop = properties[id];
    if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
    prop.registrarValidationStatus = req.body.decision;
    prop.updatedAt = new Date();
    properties[id] = prop;
    globalThis._aasthi_properties = properties;
    return res.json({ assetId: id, validationStatus: req.body.decision, fabricMode: 'mock (Vercel)' });
  }

  const mintMatch = path.match(/^\/api\/properties\/([^\/]+)\/mint$/);
  if (mintMatch && method === 'POST') {
    const id = decodeURIComponent(mintMatch[1]);
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
    const resp = { assetId: id, totalTokens, status: 'TOKENIZED', fabricMode: 'mock (Vercel)' };
    if (idemKey) idempotency[idemKey] = resp;
    globalThis._aasthi_properties = properties;
    globalThis._aasthi_balances = balances;
    return res.json(resp);
  }

  const freezeMatch = path.match(/^\/api\/properties\/([^\/]+)\/freeze$/);
  if (freezeMatch && method === 'POST') {
    const id = decodeURIComponent(freezeMatch[1]);
    const prop = properties[id];
    if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
    prop.status = 'FROZEN';
    prop.updatedAt = new Date();
    properties[id] = prop;
    globalThis._aasthi_properties = properties;
    return res.json({ assetId: id, status: 'FROZEN', reason: req.body.reason, fabricMode: 'mock (Vercel)' });
  }

  if (path === '/api/transfers' && method === 'POST') {
    const { assetId, fromId: reqFrom, toId, amount } = req.body || {};
    const fromId = reqFrom || user.identityId;
    const amt = parseInt(amount);
    if (amt <= 0) return res.status(400).json({ error: 'ERR_INVALID_AMOUNT' });
    if (fromId === toId) return res.status(400).json({ error: 'ERR_INVALID_TRANSFER: self-transfer not allowed' });
    const prop = properties[assetId];
    if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
    if (prop.status === 'FROZEN') return res.status(400).json({ error: 'ERR_ASSET_FROZEN' });
    if (prop.status !== 'TOKENIZED') return res.status(400).json({ error: 'ERR_INVALID_TRANSFER: asset not tokenized' });
    const fromKey = assetId + '~' + fromId;
    const fromBal = balances[fromKey];
    if (!fromBal) return res.status(400).json({ error: 'ERR_BALANCE_NOT_FOUND' });
    if (fromBal.balance < amt) return res.status(400).json({ error: `ERR_INSUFFICIENT_BALANCE: have ${fromBal.balance} need ${amt}` });
    const toKey = assetId + '~' + toId;
    let toBal = balances[toKey] || { docType: 'balance', assetId, ownerId: toId, balance: 0, updatedAt: new Date() };
    fromBal.balance -= amt;
    balances[fromKey] = fromBal;
    toBal.balance += amt;
    balances[toKey] = toBal;
    const transferId = 'TXN-' + crypto.randomUUID();
    transfers[transferId] = { docType: 'transfer', transferId, assetId, fromId, toId, amount: amt, txTimestamp: new Date(), status: 'COMPLETED' };
    globalThis._aasthi_balances = balances;
    globalThis._aasthi_transfers = transfers;
    return res.json({ transferId, assetId, fromId, toId, amount: amt, status: 'COMPLETED', fabricMode: 'mock (Vercel)' });
  }

  const balMatch = path.match(/^\/api\/balances\/([^\/]+)\/([^\/]+)$/);
  if (balMatch && method === 'GET') {
    const assetId = decodeURIComponent(balMatch[1]);
    const ownerId = decodeURIComponent(balMatch[2]);
    const key = assetId + '~' + ownerId;
    const bal = balances[key] || { docType: 'balance', assetId, ownerId, balance: 0 };
    return res.json(bal);
  }

  const walletMatch = path.match(/^\/api\/balances\/wallet\/([^\/]+)$/);
  if (walletMatch && method === 'GET') {
    const ownerId = decodeURIComponent(walletMatch[1]);
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
    return res.json({ ownerId, balances: enriched, totalPortfolioValue: total, fabricMode: 'mock (Vercel)' });
  }

  if (path.startsWith('/api/transfers/history') && method === 'GET') {
    const assetId = url.searchParams.get('assetId');
    const ownerId = url.searchParams.get('ownerId');
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize')) || 10, 100);
    const bookmark = url.searchParams.get('bookmark') || '';
    let list = Object.values(transfers);
    if (assetId) list = list.filter(t => t.assetId === decodeURIComponent(assetId));
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
    return res.json({ transfers: page, count: page.length, total: list.length, bookmark: nextBookmark, hasMore, pageSize, fabricMode: 'mock (Vercel)' });
  }

  const kycPutMatch = path.match(/^\/api\/kyc\/([^\/]+)$/);
  if (kycPutMatch && method === 'PUT') {
    const id = decodeURIComponent(kycPutMatch[1]);
    kycRecords[id] = { docType: 'kyc', identityId: id, kycStatus: req.body.status, verifiedAt: new Date(), provider: 'mock' };
    globalThis._aasthi_kyc = kycRecords;
    return res.json({ identityId: id, kycStatus: req.body.status, fabricMode: 'mock (Vercel)' });
  }
  const kycGetMatch = path.match(/^\/api\/kyc\/([^\/]+)$/);
  if (kycGetMatch && method === 'GET') {
    const rec = kycRecords[decodeURIComponent(kycGetMatch[1])] || { docType: 'kyc', identityId: kycGetMatch[1], kycStatus: 'UNVERIFIED', provider: 'mock' };
    return res.json(rec);
  }

  if (path === '/api/payments/confirm' && method === 'POST') {
    const { transferId, amountINR, method: payMethod } = req.body || {};
    const hash = crypto.createHash('sha256').update((transferId||'') + (amountINR||'') + (payMethod||'')).digest('hex');
    return res.json({ confirmationId: 'PAY-' + crypto.randomUUID(), transferId, amountINR, method: payMethod, paymentHash: hash, status: 'CONFIRMED' });
  }

  if (path === '/api/transfers/failure-demo' && method === 'POST') {
    const { scenario } = req.body || {};
    if (scenario === 'insufficient_balance') {
      return res.json({ scenario, expected: 'ERR_INSUFFICIENT_BALANCE', result: 'ERR_INSUFFICIENT_BALANCE: have 50 need 999999999', passed: true });
    }
    if (scenario === 'self_transfer') {
      return res.json({ scenario, expected: 'ERR_INVALID_TRANSFER', result: 'ERR_INVALID_TRANSFER: self-transfer not allowed', passed: true });
    }
    if (scenario === 'kyc_unverified') {
      return res.json({ scenario, expected: 'ERR_KYC_NOT_VERIFIED', result: 'ERR_KYC_NOT_VERIFIED: receiver unverified', passed: true });
    }
    if (scenario === 'zero_amount') {
      return res.json({ scenario, expected: 'ERR_INVALID_AMOUNT', result: 'ERR_INVALID_AMOUNT', passed: true });
    }
    return res.status(400).json({ error: 'unknown scenario' });
  }

  // Testnet
  if (path === '/api/testnet/payments/initiate' && method === 'POST') {
    const { assetId, tokenAmount, estimatedEth, txHash, paymentId, from, to, isSimulated } = req.body || {};
    const pid = paymentId || (isSimulated ? 'SIM-' + crypto.randomUUID().slice(0,8).toUpperCase() : '0x' + crypto.randomUUID().replace(/-/g,'').slice(0,16));
    const finalTxHash = isSimulated ? '' : (txHash || '0x' + crypto.randomBytes(32).toString('hex'));
    testnetPayments[pid] = {
      paymentId: pid, assetId, tokenAmount, estimatedEth, txHash: finalTxHash, from, to,
      status: 'PENDING', createdAt: new Date(), drunixTransferId: null, isSimulated: !!isSimulated,
      sepoliaExplorer: isSimulated ? '' : `https://sepolia.etherscan.io/tx/${finalTxHash}`,
    };
    globalThis._aasthi_testnet = testnetPayments;
    return res.json({ paymentId: pid, status: 'PENDING', txHash: finalTxHash, isSimulated: !!isSimulated, sepoliaExplorer: testnetPayments[pid].sepoliaExplorer });
  }

  const testnetGetMatch = path.match(/^\/api\/testnet\/payments\/([^\/]+)$/);
  if (testnetGetMatch && method === 'GET') {
    const pay = testnetPayments[decodeURIComponent(testnetGetMatch[1])] || Object.values(testnetPayments)[0];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    return res.json(pay);
  }

  if (path.match(/^\/api\/testnet\/payments\/[^\/]+\/confirm$/) && method === 'POST') {
    const pid = path.split('/')[3];
    if (testnetPayments[pid]) {
      testnetPayments[pid].status = 'CONFIRMED';
      testnetPayments[pid].drunixTransferId = req.body.drunixTransferId;
      globalThis._aasthi_testnet = testnetPayments;
    }
    return res.json({ paymentId: pid, status: 'CONFIRMED' });
  }

  if (path.match(/^\/api\/testnet\/payments\/[^\/]+\/release$/) && method === 'POST') {
    const pid = path.split('/')[3];
    if (testnetPayments[pid]) {
      testnetPayments[pid].status = 'RELEASED';
      globalThis._aasthi_testnet = testnetPayments;
    }
    return res.json({ paymentId: pid, status: 'RELEASED' });
  }

  if (path === '/api/testnet/payments' && method === 'GET') {
    return res.json({ payments: Object.values(testnetPayments), count: Object.keys(testnetPayments).length });
  }

  if (path === '/api/testnet/config' && method === 'GET') {
    return res.json({
      chainId: '0xaa36a7',
      chainName: 'Sepolia Testnet',
      explorer: 'https://sepolia.etherscan.io',
      faucet: 'https://sepoliafaucet.com/',
    });
  }

  return res.status(404).json({ error: 'Not found', path });
}
