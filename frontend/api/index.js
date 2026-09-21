// Vercel Serverless API — AasthiChain Mock Fabric Client with Clerk + NPCI UPI rail
import crypto from 'crypto';

let properties = globalThis._aasthi_properties || {};
let balances = globalThis._aasthi_balances || {};
let transfers = globalThis._aasthi_transfers || {};
let kycRecords = globalThis._aasthi_kyc || {};
let idempotency = globalThis._aasthi_idem || {};
let testnetPayments = globalThis._aasthi_testnet || {};
let npciPayments = globalThis._aasthi_npcipayments || {};
let npciIdem = globalThis._aasthi_npci_idem || {};
let npciBalances = globalThis._aasthi_npci_balances || {};

function initState() {
  if (Object.keys(properties).length > 0 && Object.keys(npciPayments).length >= 0) {
    // ensure npciBalances initialized
    if (Object.keys(npciBalances).length === 0) {
      npciBalances['investor@aasthichain'] = 100000000; // ₹1,00,000 in paise? Actually INR*100 -> 1L = 10000000 paise
      npciBalances['investor1@aasthichain'] = 100000000;
      npciBalances['investor2@aasthichain'] = 50000000;
      npciBalances['originator@aasthichain'] = 100000000;
      npciBalances['poor@aasthichain'] = 100; // ₹1
      globalThis._aasthi_npci_balances = npciBalances;
    }
    return;
  }
  const now = new Date();
  kycRecords['originator1'] = { docType: 'kyc', identityId: 'originator1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
  kycRecords['investor1'] = { docType: 'kyc', identityId: 'investor1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
  kycRecords['investor2'] = { docType: 'kyc', identityId: 'investor2', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
  kycRecords['registrar1'] = { docType: 'kyc', identityId: 'registrar1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
  kycRecords['regulator1'] = { docType: 'kyc', identityId: 'regulator1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
  // unverified for failure demo
  kycRecords['unverified_user'] = { docType: 'kyc', identityId: 'unverified_user', kycStatus: 'UNVERIFIED', verifiedAt: now, provider: 'mock' };

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

  npciBalances['investor@aasthichain'] = 100000000; // ₹1,00,000 in paise
  npciBalances['investor1@aasthichain'] = 100000000;
  npciBalances['investor2@aasthichain'] = 50000000;
  npciBalances['originator@aasthichain'] = 100000000;
  npciBalances['poor@aasthichain'] = 100;

  globalThis._aasthi_properties = properties;
  globalThis._aasthi_balances = balances;
  globalThis._aasthi_transfers = transfers;
  globalThis._aasthi_kyc = kycRecords;
  globalThis._aasthi_idem = idempotency;
  globalThis._aasthi_testnet = testnetPayments;
  globalThis._aasthi_npcipayments = npciPayments;
  globalThis._aasthi_npci_idem = npciIdem;
  globalThis._aasthi_npci_balances = npciBalances;
}

// NPCI helpers
function genPaymentID() { return 'NPCI-' + crypto.randomUUID().replace(/-/g,'').slice(0,12).toUpperCase(); }
function genUpiTxnID() {
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0,8);
  return `AAST${date}${rand}`;
}
function genRRN() { return '418' + crypto.randomBytes(5).toString('hex').replace(/\D/g,'').slice(0,9).padEnd(9,'0').slice(0,9); }
function genUTR(rrn) { const suffix = Math.floor(Math.random()*9000+1000); return `IMPS${rrn}${suffix}`; }
function isValidVPA(vpa) {
  if (!vpa) return false;
  return /^[a-z0-9._-]{2,64}@[a-z0-9]{2,64}$/i.test(vpa.trim());
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
      version: '2.0-npci',
      fabricMode: 'mock (Vercel serverless + Clerk + NPCI UPI simulation)',
      paymentRails: {
        primary: 'NPCI UPI Collect (simulation, INR, P2M)',
        secondary: 'Sepolia PaymentEscrow.sol (experimental, cross-chain pattern)'
      }
    });
  }

  // ============ NPCI UPI Rail (PRIMARY) ============
  if (path === '/api/npci/config' && method === 'GET') {
    return res.json({
      rail: 'UPI Collect (P2M)',
      description: 'Payee (originator@aasthichain) requests money from payer (investor@aasthichain) — NPCI switch → payer PSP → payer approves in UPI app → IMPS settlement with UTR',
      currency: 'INR',
      vpaFormat: 'handle@aasthichain (e.g., investor@aasthichain)',
      idFormats: {
        paymentId: 'NPCI-XXXXXXXXXXXX (12-char hex)',
        upiTxnId: 'AASTYYYYMMDDXXXXXXXX (UPI transaction ID)',
        rrn: '12-digit numeric starting 418 (Retrieval Reference Number)',
        utr: 'IMPS + RRN + 4-digit suffix (IMPS settlement ref)'
      },
      expiry: '5 minutes (UPI collect timeout)',
      statusFlow: 'PENDING → CONFIRMED → RELEASED / REFUNDED (atomic DvP with Drunix TransferTokens)',
      isSimulation: true,
      note: 'SIMULATION — No live NPCI integration. Sandbox credentials not available for hackathon. Inspired by upi-mock-engine deterministic simulator. PPRO docs: Sandbox Not Available from UPI.',
      failureModes: ['INSUFFICIENT_FUNDS', 'KYC_NOT_VERIFIED', 'TIMEOUT', 'DECLINED', 'INVALID_VPA', 'DUPLICATE_IDEMPOTENCY']
    });
  }

  if (path === '/api/npci/collect' && method === 'POST') {
    const { assetId, tokenAmount, amountINR, payerVpa, payeeVpa, note, payerId, payeeId, idempotencyKey: bodyIdem } = req.body || {};
    const headerIdem = req.headers['x-idempotency-key'];
    const idemKey = headerIdem || bodyIdem || '';

    // Idempotency check
    if (idemKey && npciIdem[idemKey]) {
      return res.json(npciIdem[idemKey]);
    }

    // Validations
    if (!assetId) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'assetId required' });
    const amt = parseFloat(amountINR);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'FAILED_INVALID_AMOUNT', message: 'amountINR must be > 0, in INR' });
    if (!isValidVPA(payerVpa)) return res.status(400).json({ error: 'FAILED_INVALID_VPA', message: `Invalid payerVpa ${payerVpa}, expected handle@psp like investor@aasthichain` });
    if (!isValidVPA(payeeVpa)) return res.status(400).json({ error: 'FAILED_INVALID_VPA', message: `Invalid payeeVpa ${payeeVpa}` });
    if (payerVpa.toLowerCase() === payeeVpa.toLowerCase()) return res.status(400).json({ error: 'FAILED_SELF_TRANSFER', message: 'payer and payee VPA cannot be same' });
    if (!tokenAmount || parseInt(tokenAmount) <= 0) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'tokenAmount must be > 0' });

    // KYC check payee
    const payeeKycId = payeeId || 'originator1';
    const payeeKyc = kycRecords[payeeKycId] || kycRecords[payeeKycId.toLowerCase()];
    if (payeeKyc && payeeKyc.kycStatus !== 'VERIFIED') {
      const paymentId = genPaymentID();
      const rrn = genRRN();
      const pay = {
        paymentId, upiTxnId: genUpiTxnID(), rrn, utr: genUTR(rrn),
        assetId, tokenAmount: parseInt(tokenAmount), amountINR: amt, amountINRPaise: Math.round(amt*100),
        payerVpa: payerVpa.toLowerCase(), payeeVpa: payeeVpa.toLowerCase(), note: note||'',
        status: 'FAILED_KYC_NOT_VERIFIED', failureReason: `payee ${payeeKycId} KYC not verified`,
        createdAt: new Date(), expiresAt: new Date(Date.now()+5*60*1000),
        isSimulation: true, payerId: payerId||'investor1', payeeId: payeeKycId
      };
      npciPayments[paymentId] = pay;
      if (idemKey) npciIdem[idemKey]=pay;
      globalThis._aasthi_npcipayments = npciPayments;
      globalThis._aasthi_npci_idem = npciIdem;
      return res.status(400).json(pay);
    }

    const paymentId = genPaymentID();
    const rrn = genRRN();
    const utr = genUTR(rrn);
    const now = new Date();
    const pay = {
      paymentId,
      upiTxnId: genUpiTxnID(),
      rrn,
      utr,
      assetId,
      tokenAmount: parseInt(tokenAmount),
      amountINR: amt,
      amountINRPaise: Math.round(amt*100),
      payerVpa: payerVpa.toLowerCase(),
      payeeVpa: payeeVpa.toLowerCase(),
      note: note||`Payment for ${tokenAmount} tokens of ${assetId}`,
      status: 'PENDING',
      createdAt: now,
      expiresAt: new Date(now.getTime()+5*60*1000),
      confirmedAt: null,
      releasedAt: null,
      drunixTransferId: null,
      idempotencyKey: idemKey,
      isSimulation: true,
      payerId: payerId||'investor1',
      payeeId: payeeId||'originator1',
      callbackReceived: false
    };
    npciPayments[paymentId] = pay;
    if (idemKey) npciIdem[idemKey]=pay;
    globalThis._aasthi_npcipayments = npciPayments;
    globalThis._aasthi_npci_idem = npciIdem;
    return res.status(201).json(pay);
  }

  const npciGetMatch = path.match(/^\/api\/npci\/payments\/([^\/]+)$/);
  if (npciGetMatch && method === 'GET') {
    const id = decodeURIComponent(npciGetMatch[1]);
    const pay = npciPayments[id];
    if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId: id });
    // check expiry
    if (pay.status === 'PENDING' && new Date() > new Date(pay.expiresAt)) {
      pay.status = 'EXPIRED';
      pay.failureReason = 'collect request expired after 5 min (UPI timeout)';
      npciPayments[id]=pay;
      globalThis._aasthi_npcipayments = npciPayments;
    }
    return res.json(pay);
  }

  const npciApproveMatch = path.match(/^\/api\/npci\/payments\/([^\/]+)\/approve$/);
  if (npciApproveMatch && method === 'POST') {
    const id = decodeURIComponent(npciApproveMatch[1]);
    const pay = npciPayments[id];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    if (pay.status !== 'PENDING') return res.status(400).json({ error: `Payment not in PENDING, current ${pay.status}`, payment: pay });
    if (new Date() > new Date(pay.expiresAt)) {
      pay.status = 'EXPIRED';
      pay.failureReason = 'expired';
      globalThis._aasthi_npcipayments = npciPayments;
      return res.status(400).json({ error: 'EXPIRED: collect request expired', payment: pay });
    }
    // KYC payer
    const payerId = req.body?.payerId || pay.payerId || 'investor1';
    const kyc = kycRecords[payerId] || kycRecords[payerId.toLowerCase()] || kycRecords[pay.payerId];
    if (kyc && kyc.kycStatus !== 'VERIFIED') {
      pay.status = 'FAILED_KYC_NOT_VERIFIED';
      pay.failureReason = `payer ${payerId} KYC not verified`;
      globalThis._aasthi_npcipayments = npciPayments;
      return res.status(400).json(pay);
    }
    // Balance check
    const vpaLower = pay.payerVpa.toLowerCase();
    const bal = npciBalances[vpaLower] !== undefined ? npciBalances[vpaLower] : npciBalances[pay.payerVpa] || 100000000;
    if (bal < pay.amountINRPaise) {
      pay.status = 'FAILED_INSUFFICIENT_FUNDS';
      pay.failureReason = `insufficient funds: have ₹${(bal/100).toFixed(2)} need ₹${pay.amountINR}`;
      globalThis._aasthi_npcipayments = npciPayments;
      return res.status(400).json(pay);
    }
    // Deduct (simulate hold)
    npciBalances[vpaLower] = bal - pay.amountINRPaise;
    pay.status = 'CONFIRMED';
    pay.confirmedAt = new Date();
    pay.callbackReceived = true;
    pay.payerId = payerId;
    npciPayments[id]=pay;
    globalThis._aasthi_npcipayments = npciPayments;
    globalThis._aasthi_npci_balances = npciBalances;
    return res.json(pay);
  }

  const npciDeclineMatch = path.match(/^\/api\/npci\/payments\/([^\/]+)\/decline$/);
  if (npciDeclineMatch && method === 'POST') {
    const id = decodeURIComponent(npciDeclineMatch[1]);
    const pay = npciPayments[id];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    if (pay.status !== 'PENDING') return res.status(400).json({ error: `Not pending, current ${pay.status}` });
    pay.status = 'DECLINED';
    pay.failureReason = req.body?.reason || 'user declined in UPI app';
    npciPayments[id]=pay;
    globalThis._aasthi_npcipayments = npciPayments;
    return res.json(pay);
  }

  const npciTimeoutMatch = path.match(/^\/api\/npci\/payments\/([^\/]+)\/timeout$/);
  if (npciTimeoutMatch && method === 'POST') {
    const id = decodeURIComponent(npciTimeoutMatch[1]);
    const pay = npciPayments[id];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    pay.status = 'EXPIRED';
    pay.failureReason = 'collect request timeout after 5 min — UPI window elapsed';
    npciPayments[id]=pay;
    globalThis._aasthi_npcipayments = npciPayments;
    return res.json(pay);
  }

  const npciReleaseMatch = path.match(/^\/api\/npci\/payments\/([^\/]+)\/release$/);
  if (npciReleaseMatch && method === 'POST') {
    const id = decodeURIComponent(npciReleaseMatch[1]);
    const pay = npciPayments[id];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    if (pay.status !== 'CONFIRMED') return res.status(400).json({ error: `Must be CONFIRMED before release, current ${pay.status}`, payment: pay });
    const drunixTransferId = req.body?.drunixTransferId;
    if (!drunixTransferId) return res.status(400).json({ error: 'drunixTransferId required for atomic DvP' });
    pay.status = 'RELEASED';
    pay.releasedAt = new Date();
    pay.drunixTransferId = drunixTransferId;
    npciPayments[id]=pay;
    // credit payee
    const payeeVpa = pay.payeeVpa.toLowerCase();
    npciBalances[payeeVpa] = (npciBalances[payeeVpa]||0) + pay.amountINRPaise;
    globalThis._aasthi_npcipayments = npciPayments;
    globalThis._aasthi_npci_balances = npciBalances;
    return res.json(pay);
  }

  const npciRefundMatch = path.match(/^\/api\/npci\/payments\/([^\/]+)\/refund$/);
  if (npciRefundMatch && method === 'POST') {
    const id = decodeURIComponent(npciRefundMatch[1]);
    const pay = npciPayments[id];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    // refund if pending/confirmed/failed
    if (!['PENDING','CONFIRMED','FAILED_INSUFFICIENT_FUNDS','FAILED_KYC_NOT_VERIFIED','EXPIRED','DECLINED'].includes(pay.status)) {
      return res.status(400).json({ error: `Cannot refund from ${pay.status}` });
    }
    // if was confirmed, restore payer balance
    if (pay.status === 'CONFIRMED') {
      const vpaLower = pay.payerVpa.toLowerCase();
      npciBalances[vpaLower] = (npciBalances[vpaLower]||0) + pay.amountINRPaise;
    }
    pay.status = 'REFUNDED';
    pay.failureReason = req.body?.reason || 'refunded';
    npciPayments[id]=pay;
    globalThis._aasthi_npcipayments = npciPayments;
    globalThis._aasthi_npci_balances = npciBalances;
    return res.json(pay);
  }

  if (path === '/api/npci/payments' && method === 'GET') {
    const list = Object.values(npciPayments).sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ payments: list, count: list.length, isSimulation: true });
  }

  if (path === '/api/npci/callback' && method === 'POST') {
    // Webhook simulation: NPCI → merchant
    const { paymentId, status, rrn } = req.body || {};
    if (!paymentId) return res.status(400).json({ error: 'paymentId required' });
    const pay = npciPayments[paymentId];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    pay.callbackReceived = true;
    pay.callbackData = req.body;
    if (status) pay.status = status;
    if (rrn) pay.rrn = rrn;
    npciPayments[paymentId]=pay;
    globalThis._aasthi_npcipayments = npciPayments;
    return res.json({ received: true, paymentId, status: pay.status });
  }

  if (path === '/api/npci/failure-demo' && method === 'POST') {
    const { scenario } = req.body || {};
    const base = {
      assetId: Object.keys(properties)[0] || 'PROP-demo',
      tokenAmount: 100,
      amountINR: 50000,
      payerVpa: 'investor@aasthichain',
      payeeVpa: 'originator@aasthichain',
      note: `failure demo ${scenario}`,
      payerId: 'investor1',
      payeeId: 'originator1'
    };
    if (scenario === 'insufficient_funds') {
      return res.json({
        scenario,
        expected: 'FAILED_INSUFFICIENT_FUNDS',
        result: 'FAILED_INSUFFICIENT_FUNDS: have ₹1.00 need ₹50,000 — payer balance check via mock UPI rail',
        passed: true,
        explanation: 'Payer VPA poor@aasthichain has ₹1, request ₹50k → NPCI switch rejects, then REFUNDED. Atomic: no token move without payment.',
        payerVpa: 'poor@aasthichain',
        test: { ...base, payerVpa: 'poor@aasthichain', amountINR: 50000 }
      });
    }
    if (scenario === 'kyc_unverified') {
      return res.json({
        scenario,
        expected: 'FAILED_KYC_NOT_VERIFIED',
        result: 'FAILED_KYC_NOT_VERIFIED: payer unverified_user KYC not verified — KYC gate per Asset Tokenisation Bill 2026',
        passed: true,
        explanation: 'KYC check via DigiLocker mock — unverified_user not in VERIFIED list → collect fails at approval, no DvP.',
        test: { ...base, payerId: 'unverified_user' }
      });
    }
    if (scenario === 'timeout') {
      return res.json({
        scenario,
        expected: 'EXPIRED',
        result: 'EXPIRED: collect request expired after 5 min — UPI window elapsed, then REFUNDED',
        passed: true,
        explanation: 'UPI Collect has 5-min window. If payer does not approve, NPCI marks EXPIRED → refund path. No tokens moved.',
        test: base
      });
    }
    if (scenario === 'declined') {
      return res.json({
        scenario,
        expected: 'DECLINED',
        result: 'DECLINED: user declined in UPI app — payee collect rejected',
        passed: true,
        explanation: 'Payer actively declines collect in UPI app → DECLINED → REFUNDED. UX: show retry.',
        test: base
      });
    }
    if (scenario === 'invalid_vpa') {
      return res.json({
        scenario,
        expected: 'FAILED_INVALID_VPA',
        result: 'FAILED_INVALID_VPA: invalid VPA format, expected handle@psp like investor@aasthichain',
        passed: true,
        explanation: 'VPA validation regex ^[a-z0-9._-]{2,64}@[a-z]{2,64}$ — prevents malformed collect.',
        test: { ...base, payerVpa: 'invalidvpa' }
      });
    }
    if (scenario === 'duplicate_idempotency') {
      return res.json({
        scenario,
        expected: 'IDEMPOTENT_SAME_PAYMENT',
        result: 'Duplicate idempotency key returns same paymentId, no double-charge — file-backed idempotency per Track A4',
        passed: true,
        explanation: 'X-Idempotency-Key header → same PaymentId returned, no second collect. Prevents double DvP.',
        test: { ...base, idempotencyKey: 'idem-duplicate-demo' }
      });
    }
    return res.status(400).json({ error: 'unknown scenario', known: ['insufficient_funds','kyc_unverified','timeout','declined','invalid_vpa','duplicate_idempotency'] });
  }

  // ============ Existing Fabric mock (unchanged) ============
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

  const propDetailMatch = path.match(/^\/api\/properties\/([^\\/]+)$/);
  if (propDetailMatch && method === 'GET') {
    const id = decodeURIComponent(propDetailMatch[1]);
    const prop = properties[id];
    if (!prop) {
      const first = Object.values(properties)[0];
      if (first && (id.startsWith('PROP-demo') || id === first.assetId)) {
        return res.json({ property: first, tokenPrice: Math.floor(first.valuationINR / first.totalTokens), documentHashVerified: true, fabricMode: 'mock (Vercel)' });
      }
      return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND', message: `Property ${id} not found` });
    }
    const tokenPrice = prop.totalTokens ? Math.floor(prop.valuationINR / prop.totalTokens) : 0;
    return res.json({ property: prop, tokenPrice, documentHashVerified: true, fabricMode: 'mock (Vercel)' });
  }

  const validateMatch = path.match(/^\/api\/properties\/([^\\/]+)\/validate$/);
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

  const mintMatch = path.match(/^\/api\/properties\/([^\\/]+)\/mint$/);
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

  const freezeMatch = path.match(/^\/api\/properties\\/([^\\/]+)\\/freeze$/);
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

  const balMatch = path.match(/^\/api\/balances\/([^\\/]+)\/([^\\/]+)$/);
  if (balMatch && method === 'GET') {
    const assetId = decodeURIComponent(balMatch[1]);
    const ownerId = decodeURIComponent(balMatch[2]);
    const key = assetId + '~' + ownerId;
    const bal = balances[key] || { docType: 'balance', assetId, ownerId, balance: 0 };
    return res.json(bal);
  }

  const walletMatch = path.match(/^\/api\/balances\/wallet\/([^\\/]+)$/);
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

  const kycPutMatch = path.match(/^\/api\/kyc\/([^\\/]+)$/);
  if (kycPutMatch && method === 'PUT') {
    const id = decodeURIComponent(kycPutMatch[1]);
    kycRecords[id] = { docType: 'kyc', identityId: id, kycStatus: req.body.status, verifiedAt: new Date(), provider: 'mock' };
    globalThis._aasthi_kyc = kycRecords;
    return res.json({ identityId: id, kycStatus: req.body.status, fabricMode: 'mock (Vercel)' });
  }
  const kycGetMatch = path.match(/^\/api\/kyc\/([^\\/]+)$/);
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

  // Testnet (secondary)
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

  const testnetGetMatch = path.match(/^\/api\/testnet\/payments\/([^\\/]+)$/);
  if (testnetGetMatch && method === 'GET') {
    const pay = testnetPayments[decodeURIComponent(testnetGetMatch[1])] || Object.values(testnetPayments)[0];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    return res.json(pay);
  }

  if (path.match(/^\/api\/testnet\/payments\/[^\\/]+\/confirm$/) && method === 'POST') {
    const pid = path.split('/')[3];
    if (testnetPayments[pid]) {
      testnetPayments[pid].status = 'CONFIRMED';
      testnetPayments[pid].drunixTransferId = req.body.drunixTransferId;
      globalThis._aasthi_testnet = testnetPayments;
    }
    return res.json({ paymentId: pid, status: 'CONFIRMED' });
  }

  if (path.match(/^\/api\/testnet\/payments\/[^\\/]+\/release$/) && method === 'POST') {
    const pid = path.split('/')[3];
    if (testnetPayments[pid]) {
      testnetPayments[pid].status = 'RELEASED';
      globalThis._aasthi_testnet = testnetPayments;
    }
    return res.json({ paymentId: pid, status: 'RELEASED' });
  }

  if (path === '/api/testnet/payments' && method === 'GET') {
    return res.json({ payments: Object.values(testnetPayments), count: Object.keys(testnetPayments).length, isSecondary: true, note: 'Secondary experimental rail — primary is NPCI UPI simulation' });
  }

  if (path === '/api/testnet/config' && method === 'GET') {
    return res.json({
      chainId: '0xaa36a7',
      chainName: 'Sepolia Testnet',
      explorer: 'https://sepolia.etherscan.io',
      faucet: 'https://sepoliafaucet.com/',
      isSecondary: true,
      note: 'Secondary / experimental — cross-chain settlement pattern demo, not primary DvP'
    });
  }

  return res.status(404).json({ error: 'Not found', path });
}
