const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'] }));
app.use(express.json());
// PayU surl/furl callbacks POST application/x-www-form-urlencoded — capture raw body
app.use(express.urlencoded({ extended: false }));

// Serve frontend dist for live demo - fintech UI per spec
const distPath = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(distPath)) {
  console.log(`Serving frontend dist from ${distPath}`);
  // redirect:false — the build now emits dist/<route>/index.html per route,
  // and the default would answer /marketplace with a 301 to /marketplace/.
  // index:'index.html' is what then serves the prerendered head directly.
  app.use(express.static(distPath, { redirect: false, index: 'index.html', extensions: [] }));
}

// Mock state - same as Go mock client
let properties = {};
let balances = {};
let transfers = {};
let kycRecords = {};
let idempotency = {};

// ===== Neon schema entities (in-memory parity with frontend/api/lib/authstore.js) =====
// user, account, session, organization, member, invitation, verification, jwt, project_config
const authMem = {
  user: new Map(), account: new Map(), session: new Map(), organization: new Map(),
  member: new Map(), invitation: new Map(), verification: new Map(), jwt: new Map(),
  project_config: new Map([['pcfg_default', { id: 'pcfg_default', name: 'aasthichain', single_page_app: true, disable_sign_up: false }]])
};
const uidA = (p) => (p ? p + '_' : '') + crypto.randomUUID();
function authGetOrCreateUser(id) {
  let u = authMem.user.get(id);
  if (!u) {
    u = { id, email: `${id}@aasthichain.demo`, email_not_verified: false, name: id, image: null, first_name: id.replace(/[0-9]+$/, ''), last_name: null, created_at: new Date(), updated_at: new Date(), deleted_at: null };
    authMem.user.set(id, u);
  }
  u.updated_at = new Date();
  return u;
}
function authCreateAccount(userId) {
  const id = uidA('acc');
  const row = { id, user_id: userId, account_id: id, email: `${userId}@aasthichain.demo`, display_name: userId, avatar_url: null, external_identifier: userId, external_id: userId, type: 'oauth', provider: 'mock', created_at: new Date(), updated_at: new Date() };
  authMem.account.set(id, row);
  return row;
}
function authCreateSession(userId, token, req) {
  const id = uidA('sess');
  const row = { id, user_id: userId, active_organization_id: null, token, user_agent: req?.headers?.['user-agent'] || null, ip_address: req?.headers?.['x-forwarded-for'] || null, extra_data: {}, created_at: new Date(), updated_at: new Date() };
  authMem.session.set(id, row);
  authMem.session.set('tok:' + token, row);
  return row;
}
function authMemberships(userId) {
  const out = [];
  for (const m of authMem.member.values()) {
    if (m.user_id !== userId) continue;
    const o = authMem.organization.get(m.organization_id);
    if (o) out.push({ role: m.role, organization_id: o.id, name: o.name, slug: o.slug });
  }
  return out;
}

const now = new Date();
kycRecords['originator1'] = { docType: 'kyc', identityId: 'originator1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
kycRecords['investor1'] = { docType: 'kyc', identityId: 'investor1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
kycRecords['investor2'] = { docType: 'kyc', identityId: 'investor2', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
kycRecords['registrar1'] = { docType: 'kyc', identityId: 'registrar1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };
kycRecords['regulator1'] = { docType: 'kyc', identityId: 'regulator1', kycStatus: 'VERIFIED', verifiedAt: now, provider: 'mock' };

// FIX: deterministic property ID — stable across restarts, same as Vercel api/index.js seed
const propId = 'PROP-GREEN-VALLEY-PUNE-001';
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

// ---- marketplace catalogue (additive) --------------------------------------
// A marketplace with one listing is a demo, not a marketplace. These are seeded
// from frontend/api/lib/catalogue.json, the SAME file the Vercel handler reads,
// so both deployments show an identical catalogue. The original Pune property
// is the first entry, so its id, token count and balances are unchanged.
try {
  const catalogue = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, 'frontend/api/lib/catalogue.json'), 'utf8'));
  for (const c of catalogue) {
    const existing = properties[c.assetId];
    properties[c.assetId] = {
      ...(existing || {}),
      assetId: c.assetId,
      docType: 'property',
      originatorId: (existing && existing.originatorId) || 'originator1',
      title: c.title,
      location: c.location,
      propertyType: c.propertyType,
      valuationINR: c.valuationINR,
      totalTokens: c.totalTokens,
      pricePerTokenINR: c.pricePerTokenINR,
      expectedYieldPct: c.expectedYieldPct,
      areaSqft: c.areaSqft,
      yearBuilt: c.yearBuilt,
      description: c.description,
      documentHash: c.documentHash,
      registrarValidationStatus: 'VALIDATED',
      status: 'TOKENIZED',
      createdAt: (existing && existing.createdAt) || new Date(Date.now() - 24 * 3600 * 1000),
      updatedAt: now,
      version: (existing && existing.version) || 1,
    };
    // Seed holdings only for the new listings; never touch the original three.
    if (!existing) {
      const sold = Math.round(c.totalTokens * c.seedSoldFraction);
      balances[c.assetId + '~originator1'] = { docType: 'balance', assetId: c.assetId, ownerId: 'originator1', balance: c.totalTokens - sold, updatedAt: now };
      if (sold > 0) {
        const a = Math.round(sold * 0.6), b = sold - a;
        balances[c.assetId + '~investor1'] = { docType: 'balance', assetId: c.assetId, ownerId: 'investor1', balance: a, updatedAt: now };
        if (b > 0) balances[c.assetId + '~investor2'] = { docType: 'balance', assetId: c.assetId, ownerId: 'investor2', balance: b, updatedAt: now };
      }
    }
  }
  console.log(`Marketplace catalogue: ${catalogue.length} properties seeded`);
} catch (e) {
  console.error('Catalogue seed skipped:', e.message);
}

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

function decodeClerkOrMockToken(token) {
  // Try mock base64 JSON first
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.identityId) return payload;
  } catch {}
  // Try JWT (Clerk) — decode without verification for mock server
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
      const payload = JSON.parse(Buffer.from(padded, 'base64').toString());
      // Clerk JWT has sub, sid, etc.
      const identityId = payload.fabricIdentity || payload.identityId || (payload.sub ? 'investor1' : null);
      // If Clerk token, map to demo identity from header or default
      // Check for custom claims or use fallback
      if (payload.sub) {
        // Clerk user — use demo identity from localStorage mapping or default investor1
        // For mock, we accept any Clerk token and map to investor1 unless x-fabric-identity header present
        return {
          identityId: payload.fabricIdentity || 'investor1',
          mspId: payload.mspId || 'InvestorMSP',
          role: payload.role || 'Investor',
          clerkId: payload.sub,
          clerk: true
        };
      }
      if (payload.identityId) return payload;
    }
  } catch (e) {
    // console.warn('Token decode failed', e.message)
  }
  return null;
}

function authMiddleware(req, res, next) {
  // A signed bank callback authenticates itself; it has no session with us,
  // so demanding a bearer token on top would make signature auth unusable by
  // the only caller it exists for.
  if (req.method === 'POST' && WEBHOOK_PATHS.has(req.path) && webhookSignatureValid(req)) {
    req.user = { identityId: 'bank-callback', mspId: 'BankMSP', role: 'Webhook' };
    return next();
  }
  // Authenticate, then check entitlement. Chained here rather than added to
  // each route so a new owner-scoped route cannot forget it.
  return authenticate(req, res, () =>
    ownershipGate(req, res, () =>
      paymentGate(req, res, () => webhookGate(req, res, () => bodyPaymentGate(req, res, next)))));
}

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  const fabricIdentityHeader = req.headers['x-fabric-identity'] || req.headers['x-fabric-role'];
  if (!auth) return res.status(401).json({ error: 'ERR_UNAUTHORIZED' });
  try {
    const token = auth.split(' ')[1];
    let payload = decodeClerkOrMockToken(token);
    
    // If token is Clerk JWT and we have fabric identity header, use it
    if (payload && payload.clerk && fabricIdentityHeader) {
      const roleMap = {
        originator1: { identityId: 'originator1', mspId: 'OriginatorMSP', role: 'Originator' },
        registrar1: { identityId: 'registrar1', mspId: 'RegistrarMSP', role: 'Registrar' },
        investor1: { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' },
        investor2: { identityId: 'investor2', mspId: 'InvestorMSP', role: 'Investor' },
        regulator1: { identityId: 'regulator1', mspId: 'RegulatorMSP', role: 'Regulator' },
      };
      const mapped = roleMap[fabricIdentityHeader.toLowerCase()] || roleMap['investor1'];
      payload = { ...payload, ...mapped };
    }

    if (payload && payload.identityId) {
      req.user = payload;
      return next();
    }

    // Fallback: try direct base64
    const fallback = JSON.parse(Buffer.from(token, 'base64').toString());
    req.user = fallback;
    next();
  } catch {
    // Allow mock token format from frontend fallback + Clerk placeholder tokens
    const headerIdentity = fabricIdentityHeader || 'investor1';
    const roleMap = {
      originator1: { identityId: 'originator1', mspId: 'OriginatorMSP', role: 'Originator' },
      registrar1: { identityId: 'registrar1', mspId: 'RegistrarMSP', role: 'Registrar' },
      investor1: { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' },
      investor2: { identityId: 'investor2', mspId: 'InvestorMSP', role: 'Investor' },
      regulator1: { identityId: 'regulator1', mspId: 'RegulatorMSP', role: 'Regulator' },
    };
    req.user = roleMap[headerIdentity.toLowerCase()] || { identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor' };
    next();
  }
}

// Being logged in is not the same as being entitled. These routes name
// someone in the URL; without this any signed-in user could read any other
// user's KYC record, wallet, loans or net worth, and write anyone's KYC
// status. Mirrors OWNER_SCOPED in frontend/api/index.js.
//
// /api/balances/:assetId/:ownerId is deliberately not here: that is the cap
// table, already on the public listing page.
const OWNER_SCOPED = [
  ['GET', /^\/api\/kyc\/([^\/]+)$/, ['regulator', 'admin', 'registrar']],
  ['PUT', /^\/api\/kyc\/([^\/]+)$/, ['regulator', 'admin', 'registrar']],
  ['GET', /^\/api\/balances\/wallet\/([^\/]+)$/, ['regulator', 'admin', 'registrar']],
  ['GET', /^\/api\/credit\/loans\/([^\/]+)$/, ['regulator', 'admin']],
  ['GET', /^\/api\/portfolio\/([^\/]+)\/nav$/, ['regulator', 'admin']],
];

const SUPERVISORY = new Set(['regulator', 'admin']);

function paymentOwner(user, requested) {
  const self = (user && user.identityId) || 'investor1';
  if (!requested || requested === self) return self;
  const role = String((user && user.role) || '').toLowerCase();
  return SUPERVISORY.has(role) ? requested : self;
}

const PAYMENT_SCOPED = /^\/api\/npci\/payments\/([^\/]+)(?:\/(approve|decline|refund|reattach|release|settle))?$/;
const WEBHOOK_PATHS = new Set(['/api/npci/webhook', '/api/npci/webhook/test']);

// The capability list advertises these as auth: 'signature' and nothing ever
// verified one. A bank callback carries no user session, so a shared secret
// is the only thing that can authenticate it; with none configured, fall
// back to the same ownership rule as the rest of the payment routes.
function webhookSignatureValid(req) {
  const secret = process.env.NPCI_WEBHOOK_SECRET;
  if (!secret) return false;
  const supplied = String(req.headers['x-setu-signature'] || req.headers['x-icici-signature']
    || req.headers['x-webhook-signature'] || (req.body && req.body.signature) || '');
  if (!supplied) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(JSON.stringify(req.body || {})).digest('hex');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The payment is named in the body here, so the path-based gate never saw
// it: any signed-in user could post a SUCCESS callback against a stranger's
// payment, moving it to CONFIRMED with a UTR of their choosing.
function webhookGate(req, res, next) {
  if (!WEBHOOK_PATHS.has(req.path) || req.method !== 'POST') return next();
  if (webhookSignatureValid(req)) return next();
  if (!req.user) return next();
  const body = req.body || {};
  const id = body.paymentId || body.referenceId || body.merchantTxnId || body.transactionId;
  if (!id) return next();
  const pay = npciPayments[id];
  if (!pay) return next();
  const self = req.user.identityId;
  const role = String(req.user.role || '').toLowerCase();
  if (pay.payerId === self || pay.payeeId === self) return next();
  if (SUPERVISORY.has(role) || role === 'originator') return next();
  return res.status(403).json({
    error: 'ERR_NOT_YOUR_PAYMENT',
    message: `Payment ${pay.paymentId} belongs to someone else. A bank callback needs a valid signature.`,
  });
}

// Reconciliation names its payment in the body too, so the path gate below
// never saw it — and a reconcile that comes back CONFIRMED settles the
// purchase on the spot. Any signed-in user could force a stranger's payment
// through.
const BODY_PAYMENT_PATHS = new Set(['/api/npci/payu/reconcile']);
function bodyPaymentGate(req, res, next) {
  if (!BODY_PAYMENT_PATHS.has(req.path) || req.method !== 'POST') return next();
  if (!req.user) return next();
  const id = (req.body || {}).paymentId;
  const pay = id ? npciPayments[id] : null;
  if (!pay) return next(); // the handler answers 404
  const self = req.user.identityId;
  const role = String(req.user.role || '').toLowerCase();
  if (pay.payerId === self || pay.payeeId === self) return next();
  if (SUPERVISORY.has(role) || role === 'originator') return next();
  return res.status(403).json({
    error: 'ERR_NOT_YOUR_PAYMENT',
    message: `Payment ${pay.paymentId} belongs to someone else.`,
  });
}

// Any signed-in user could read, approve, decline or refund anyone's
// payment. Declining was the damaging one: cancelling a stranger's purchase.
function paymentGate(req, res, next) {
  if (!req.user) return next();
  const match = PAYMENT_SCOPED.exec(req.path);
  if (!match) return next();
  if (req.method !== 'GET' && req.method !== 'POST') return next();
  const pay = npciPayments[decodeURIComponent(match[1])];
  if (!pay) return next(); // the handler answers 404
  const self = req.user.identityId;
  const role = String(req.user.role || '').toLowerCase();
  if (pay.payerId === self || pay.payeeId === self) return next();
  if (SUPERVISORY.has(role) || role === 'originator') return next();
  return res.status(403).json({
    error: 'ERR_NOT_YOUR_PAYMENT',
    message: `Payment ${pay.paymentId} belongs to someone else.`,
  });
}

function ownershipGate(req, res, next) {
  if (!req.user) return next();
  const role = String(req.user.role || '').toLowerCase();
  for (const [m, rx, allowed] of OWNER_SCOPED) {
    if (m !== req.method) continue;
    const match = rx.exec(req.path);
    if (!match) continue;
    const subject = decodeURIComponent(match[1]);
    if (subject === req.user.identityId) return next();
    if (allowed.includes(role)) return next();
    return res.status(403).json({
      error: 'ERR_NOT_YOURS',
      message: `This belongs to ${subject}. You can only read your own record.`,
    });
  }
  return next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'aasthichain-api-gateway', version: '1.1', fabricMode: 'mock (Node.js live demo)', tracks: 'A1 live/mock toggle, A3 pagination, A4 persistent idempotency, A7 failure demo' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'aasthichain-api-gateway', version: '2.6-drunix-fraud-golang', fabricMode: 'mock', drunixGateway: { mode: process.env.DRUNIX_GATEWAY_URL ? 'remote-go' : 'embedded', language: 'golang', source: 'drunix-gateway/ (Go)' }, fraudEngine: { model: 'aasthichain-rules-v1', theme: 'AI & Fraud Detection', parityOf: 'drunix-gateway/fraud.go' }, payuBridge: (() => { const pu = payuConfig(); return { enabled: pu.active, mode: pu.test ? 'test' : 'live', baseUrl: pu.base, callbackPath: '/api/npci/payu/callback' }; })() });
});

app.post('/api/auth/login', (req, res) => {
  const { identityId, role } = req.body;
  const mspMap = { Originator: 'OriginatorMSP', Registrar: 'RegistrarMSP', Investor: 'InvestorMSP', Regulator: 'RegulatorMSP' };
  const mspId = mspMap[role];
  if (!mspId) return res.status(400).json({ error: 'ERR_INVALID_INPUT' });
  const token = mockJWT(identityId, mspId, role);
  // Neon schema lifecycle: user + account + session
  authGetOrCreateUser(identityId);
  authCreateAccount(identityId);
  const session = authCreateSession(identityId, token, req);
  res.json({ token, identityId, mspId, role, sessionId: session.id, userId: identityId, memberships: authMemberships(identityId), fabricMode: 'mock' });
});

app.get('/api/auth/session', authMiddleware, (req, res) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  const session = authMem.session.get('tok:' + token);
  if (!session) return res.status(404).json({ error: 'Session not found — login again' });
  res.json({ session: { id: session.id, created_at: session.created_at, user_agent: session.user_agent, ip_address: session.ip_address }, user: authMem.user.get(session.user_id) || null, memberships: authMemberships(session.user_id) });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  const s = authMem.session.get('tok:' + token);
  if (s) { authMem.session.delete('tok:' + token); authMem.session.delete(s.id); }
  res.json({ revoked: true });
});

app.get('/api/auth/users', authMiddleware, (req, res) => {
  res.json({ users: [...authMem.user.values()] });
});

app.get('/api/auth/jwks', (req, res) => {
  let row = null;
  for (const j of authMem.jwt.values()) { row = j; break; }
  if (!row) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    row = { id: uidA('jwt'), token_key: 'jwt_demo', public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(), private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), created_at: new Date(), updated_at: new Date() };
    authMem.jwt.set(row.id, row);
  }
  let jwk = {};
  try { jwk = crypto.createPublicKey(row.public_key).export({ format: 'jwk' }); } catch {}
  res.json({ keys: [{ ...jwk, kid: row.token_key, use: 'sig', alg: 'EdDSA' }] });
});

app.get('/api/auth/schema', (req, res) => {
  res.json({
    source: 'Neon schema (uploads/image-1.png) — entities now implemented in code',
    storeMode: 'memory (Vercel build uses Neon postgres via authstore.js)',
    entities: [
      { table: 'user', fields: ['id','email','email_not_verified','name','image','created_at','updated_at','deleted_at','first_name','last_name'] },
      { table: 'account', fields: ['id','user_id','account_id','email','display_name','avatar_url','external_identifier','external_id','type','provider','created_at','updated_at'] },
      { table: 'session', fields: ['id','user_id','active_organization_id','token','user_agent','ip_address','extra_data','created_at','updated_at'] },
      { table: 'organization', fields: ['id','name','slug','logo','client_id','metadata'] },
      { table: 'member', fields: ['id','organization_id','user_id','role','created_at'] },
      { table: 'invitation', fields: ['id','organization_id','email','role','status','expires_at','created_at','invited_by'] },
      { table: 'verification', fields: ['id','identifier','value','expires_at','updated_at'] },
      { table: 'jwt', fields: ['id','token_key','public_key','private_key','created_at','updated_at'] },
      { table: 'project_config', fields: ['id','name','org_id','domain_url','cookie_domain','limited_logins','disable_sign_up','enabled_providers','email_at_first_login','single_page_app','magic_link_config'] }
    ]
  });
});

// A six-digit code is only a secret while guessing is expensive. Nothing
// counted attempts, so the whole space could be walked in seconds — and the
// code was matched on identifier alone, so whoever guessed it got the
// verification, not the person who asked for it.
const VERIFICATION_MAX_ATTEMPTS = 5;
const VERIFICATION_LOCKOUT_MS = 15 * 60 * 1000;
const verificationAttempts = new Map();
function verificationLockedOut(identifier) {
  const rec = verificationAttempts.get(identifier);
  if (!rec) return false;
  if (Date.now() - rec.first > VERIFICATION_LOCKOUT_MS) { verificationAttempts.delete(identifier); return false; }
  return rec.count >= VERIFICATION_MAX_ATTEMPTS;
}
function noteFailedVerification(identifier) {
  const rec = verificationAttempts.get(identifier);
  if (!rec || Date.now() - rec.first > VERIFICATION_LOCKOUT_MS) {
    verificationAttempts.set(identifier, { count: 1, first: Date.now() });
    return;
  }
  rec.count += 1;
}

app.post('/api/auth/verification', authMiddleware, (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier) return res.status(400).json({ error: 'identifier required' });
  const id = uidA('ver');
  const row = { id, identifier: String(identifier).toLowerCase(), value: String(Math.floor(100000 + Math.random() * 900000)), requested_by: req.user.identityId, expires_at: new Date(Date.now() + 30 * 60 * 1000), updated_at: new Date() };
  authMem.verification.set(id, row);
  res.status(201).json({ id, identifier: row.identifier, expires_at: row.expires_at });
});

app.post('/api/auth/verification/verify', authMiddleware, (req, res) => {
  const { identifier, value } = req.body || {};
  const ident = String(identifier || '').toLowerCase();
  if (verificationLockedOut(ident)) {
    return res.status(429).json({ verified: false, error: 'ERR_TOO_MANY_ATTEMPTS', message: 'Too many wrong codes for this identifier. Try again later.' });
  }
  for (const [k, v] of authMem.verification.entries()) {
    if (v.identifier === ident && v.value === String(value)) {
      if (new Date(v.expires_at) < new Date()) { noteFailedVerification(ident); return res.json({ verified: false }); }
      if (v.requested_by && v.requested_by !== req.user.identityId) {
        noteFailedVerification(ident);
        return res.status(403).json({ verified: false, error: 'ERR_NOT_YOUR_VERIFICATION', message: 'This code was issued to someone else.' });
      }
      authMem.verification.delete(k);
      verificationAttempts.delete(ident);
      return res.json({ verified: true });
    }
  }
  noteFailedVerification(ident);
  res.json({ verified: false });
});

app.get('/api/auth/config', (req, res) => {
  for (const c of authMem.project_config.values()) return res.json(c);
  res.json({ id: 'pcfg_default', name: 'aasthichain', single_page_app: true });
});

app.post('/api/orgs', authMiddleware, (req, res) => {
  const { name, slug, logo } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uidA('org');
  const safeSlug = (slug || name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  for (const o of authMem.organization.values()) {
    if (o.slug === safeSlug) return res.status(409).json({ error: 'organization slug already exists: ' + safeSlug });
  }
  const org = { id, name, slug: safeSlug, logo: logo || null, client_id: null, metadata: { createdBy: req.user.identityId }, created_at: new Date(), updated_at: new Date() };
  authMem.organization.set(id, org);
  const mid = uidA('mem');
  authMem.member.set(mid, { id: mid, organization_id: id, user_id: req.user.identityId, role: 'owner', created_at: new Date() });
  authGetOrCreateUser(req.user.identityId);
  res.status(201).json(org);
});

// Organisation membership was never checked anywhere: any signed-in user
// could read any org's member list, and — the serious one — issue themselves
// an 'admin' invitation into an org they had nothing to do with and accept
// it. Two calls, no membership, no token.
function orgRoleOf(identityId, organizationId) {
  for (const m of authMem.member.values()) {
    if (m.organization_id === organizationId && m.user_id === identityId) return m.role;
  }
  return null;
}
const isSupervisor = (user) => SUPERVISORY.has(String((user && user.role) || '').toLowerCase());

// An invitation is addressed to someone. Demo identities are not email
// addresses, so the local part is what we match on: inviting
// "investor2@anything" invites investor2.
function invitationIsFor(inv, identityId) {
  if (!inv) return false;
  if (inv.identity_id) return inv.identity_id === identityId;
  const local = String(inv.email || '').split('@')[0].toLowerCase();
  return !!local && local === String(identityId).toLowerCase();
}

app.get('/api/orgs', authMiddleware, (req, res) => {
  // Listing every organisation to everyone is a customer list.
  const all = [...authMem.organization.values()];
  if (isSupervisor(req.user)) return res.json({ organizations: all });
  res.json({ organizations: all.filter(o => orgRoleOf(req.user.identityId, o.id)) });
});

app.get('/api/orgs/:id/members', authMiddleware, (req, res) => {
  if (!authMem.organization.has(req.params.id)) return res.status(404).json({ error: 'organization not found' });
  if (!orgRoleOf(req.user.identityId, req.params.id) && !isSupervisor(req.user)) {
    return res.status(403).json({ error: 'ERR_NOT_A_MEMBER', message: 'You are not a member of this organisation.' });
  }
  res.json({ members: [...authMem.member.values()].filter(m => m.organization_id === req.params.id) });
});

app.post('/api/orgs/:id/invitations', authMiddleware, (req, res) => {
  const { email, role, identityId } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!authMem.organization.has(req.params.id)) return res.status(404).json({ error: 'organization not found' });
  const mine = orgRoleOf(req.user.identityId, req.params.id);
  if (!['owner', 'admin'].includes(mine) && !isSupervisor(req.user)) {
    return res.status(403).json({ error: 'ERR_NOT_ORG_ADMIN', message: 'Only an owner or admin of this organisation can invite.' });
  }
  const id = uidA('inv');
  const row = { id, organization_id: req.params.id, email: String(email).toLowerCase(), identity_id: identityId || null, role: role || 'member', status: 'pending', expires_at: new Date(Date.now() + 168 * 3600 * 1000), created_at: new Date(), invited_by: req.user.identityId };
  authMem.invitation.set(id, row);
  res.status(201).json(row);
});

app.get('/api/orgs/:id/invitations', authMiddleware, (req, res) => {
  if (!authMem.organization.has(req.params.id)) return res.status(404).json({ error: 'organization not found' });
  if (!orgRoleOf(req.user.identityId, req.params.id) && !isSupervisor(req.user)) {
    return res.status(403).json({ error: 'ERR_NOT_A_MEMBER', message: 'You are not a member of this organisation.' });
  }
  res.json({ invitations: [...authMem.invitation.values()].filter(i => i.organization_id === req.params.id) });
});

app.post('/api/invitations/accept', authMiddleware, (req, res) => {
  const { invitationId } = req.body || {};
  const inv = authMem.invitation.get(invitationId);
  if (!inv) return res.status(404).json({ error: 'invitation not found' });
  // Knowing an invitation id is not the same as having been invited.
  if (!invitationIsFor(inv, req.user.identityId)) {
    return res.status(403).json({ error: 'ERR_NOT_INVITED', message: `This invitation was issued to ${inv.email}.` });
  }
  if (inv.status !== 'pending') return res.status(400).json({ error: 'invitation already ' + inv.status });
  if (new Date(inv.expires_at) < new Date()) { inv.status = 'expired'; return res.status(400).json({ error: 'invitation expired' }); }
  inv.status = 'accepted';
  const mid = uidA('mem');
  const member = { id: mid, organization_id: inv.organization_id, user_id: req.user.identityId, role: inv.role, created_at: new Date() };
  authMem.member.set(mid, member);
  authGetOrCreateUser(req.user.identityId);
  res.json({ member });
});

// --- Document register bridge -------------------------------------------
// The Go rail owns every rule about documents (CID derivation, duplicate
// detection, visibility, anchoring). This is a forwarder and nothing else —
// no logic lives here, in line with keeping the JS layers pure proxies.
//
// Anchoring is deliberately BEST EFFORT and never blocks the caller. A
// property registration must not fail because the register is briefly
// unreachable: the deed hash is still written to the Fabric chain exactly as
// before, and the anchor can be replayed later. Breaking a working flow to
// add evidence to it would be a bad trade.
async function anchorDigestOnRail({ assetId, subject, docType, title, issuer, submittedBy, sha256 }) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(UMI_GATEWAY_URL.replace(/\/$/, '') + '/umi/documents/digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, subject, docType, title, issuer, submittedBy, sha256 }),
        signal: ctrl.signal,
      });
      const body = await r.json().catch(() => null);
      // 409 means it is already anchored, which is a success for our purposes.
      return { ok: r.ok || r.status === 409, status: r.status, body };
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// certifyOnRail files a document AasthiChain itself generated — a validation
// certificate, a tokenisation certificate, a payment receipt.
//
// The body is deterministic: it contains only facts already committed to the
// ledger, in a fixed field order, with no "generated at" stamp. Rebuild it
// from those facts later and you get the same bytes and therefore the same
// CID, so the certificate can be re-verified rather than merely trusted.
//
// Like every other anchor here it is best effort and never awaited by the
// caller: the lifecycle step it certifies has already been committed.
async function certifyOnRail({ assetId, subject, docType, title, parties, visibility, body }) {
  try {
    const content = JSON.stringify(body, null, 2) + '\n';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(UMI_GATEWAY_URL.replace(/\/$/, '') + '/umi/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId, subject, docType, title,
          issuer: 'AasthiChain registry',
          submittedBy: (parties && parties[0]) || 'system',
          mediaType: 'application/json',
          visibility: visibility || 'public',
          parties,
          content,
        }),
        signal: ctrl.signal,
      });
      return { ok: r.ok, status: r.status };
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// documentsForAsset reads the register back so the verification report can
// cite it. Returns null when the rail is unreachable, and the report says so
// rather than silently claiming there are no documents.
async function documentsForAsset(assetId) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(UMI_GATEWAY_URL.replace(/\/$/, '') +
        '/umi/documents/' + encodeURIComponent(assetId), { signal: ctrl.signal });
      if (!r.ok) return null;
      const body = await r.json();
      return Array.isArray(body.documents) ? body.documents : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

app.post('/api/properties', authMiddleware, (req, res) => {
  let { title, state, city, pincode, valuationINR, documentHash } = req.body;
  const idemKey = req.headers['x-idempotency-key'];
  if (idemKey && idempotency[idemKey]) return res.json(idempotency[idemKey]);
if (documentHash && String(documentHash).trim().length !== 64) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'documentHash must be 64 hex chars' });
      const normalisedDoc = normaliseDocumentHash(documentHash, { title, city, state, pincode, valuationINR }, req.user.identityId);
      documentHash = normalisedDoc.hash;
      // Duplicate-property guard — same document (hash) or same title+location cannot be listed twice
      {
        const t = String(title || '').trim().toLowerCase();
        const c = String(city || '').trim().toLowerCase();
        const p = String(pincode || '').trim();
        const byDoc = documentHash && Object.values(properties).find(x => x.documentHash === documentHash);
        const byName = t && Object.values(properties).find(x =>
          x.title && x.title.trim().toLowerCase() === t &&
          x.location && String(x.location.city || '').toLowerCase() === c &&
          String(x.location.pincode || '') === p);
        const dup = byDoc || byName;
        if (dup) {
          // Say WHICH rule matched. "Already listed" on a property sharing no
          // name, city or value with the existing one reads as a broken
          // registry, and a client sending a constant hash looked exactly
          // like that.
          const reason = byDoc
            ? `the same document hash is already registered to "${dup.title}" (${dup.assetId}). If this is genuinely a different property, attach its own document — a shared or placeholder hash will always collide.`
            : `a property named "${dup.title}" already exists at the same city and pincode (${dup.assetId}).`;
          return res.status(409).json({
            error: 'ERR_DUPLICATE_PROPERTY', assetId: dup.assetId, title: dup.title,
            matchedOn: byDoc ? 'documentHash' : 'title+city+pincode',
            message: `Cannot list: ${reason}`
          });
        }
      }
  const assetId = 'PROP-' + crypto.randomUUID();
  const now = new Date();
  properties[assetId] = {
    assetId, docType: 'property', originatorId: req.user.identityId, title,
    location: { state, city, pincode }, valuationINR, totalTokens: 0,
    documentHash, registrarValidationStatus: 'PENDING', status: 'DRAFT',
    createdAt: now, updatedAt: now, version: 1
  };
  // Provenance used to start at validation, so the chain could not show when a
  // property was first listed or by whom — the earliest fact about an asset was
  // somebody else's approval of it.
  const regBlock = drunixAppend('PROPERTY_REGISTERED', [{
    kind: 'registration',
    assetId,
    title,
    originatorId: req.user.identityId,
    msp: req.user.mspId || 'OriginatorMSP',
    documentHash,
    documentHashDerived: normalisedDoc.derived,
    location: { state, city, pincode },
    valuationINR,
    endorsedBy: ['OriginatorMSP.peer'],
  }]);

  // Mirror the deed fingerprint into the content-addressed register, so the
  // listing is verifiable by CID from the moment it exists. Not awaited: the
  // registration is already final and committed above.
  anchorDigestOnRail({
    assetId,
    docType: 'TITLE_DEED',
    title: `Title deed — ${title}`,
    issuer: 'self-declared at registration',
    submittedBy: req.user.identityId,
    sha256: documentHash,
  }).catch(() => {});

  const resp = { assetId, status: 'DRAFT', message: 'Property registered, pending registrar validation', fabricMode: 'mock', blockHeight: regBlock.height, blockHash: regBlock.hash };
  if (idemKey) idempotency[idemKey] = resp;
  res.status(201).json(resp);
});

// Marketplace economics are DERIVED from live balances, never stored, so a
// listing can never disagree with the ledger about how much is actually left.
function marketplaceView(p) {
  const held = Object.values(balances).filter(b => b.assetId === p.assetId && Number(b.balance) > 0);
  const ownerBal = held.find(b => b.ownerId === p.originatorId);
  const available = ownerBal ? Math.max(0, Number(ownerBal.balance)) : 0;
  const total = Number(p.totalTokens) || 0;
  const sold = Math.max(0, total - available);
  const price = Number(p.pricePerTokenINR) || (total ? p.valuationINR / total : 0);
  return {
    ...p,
    subscription: subscriptionOf(p),
    pricePerTokenINR: Math.round(price * 100) / 100,
    tokensAvailable: available,
    tokensSold: sold,
    fundedPct: total ? Math.round((sold / total) * 1000) / 10 : 0,
    holderCount: held.filter(b => b.ownerId !== p.originatorId).length,
    minInvestmentINR: Math.round(price * 100) / 100,
    annualRentPerTokenINR: Math.round(price * ((Number(p.expectedYieldPct) || 0) / 100) * 100) / 100,
  };
}

// Anonymous callers come through optionalAuth with the sentinel identity
// 'public' (role 'Public'), so a plain truthiness check on req.user would
// treat a stranger as signed in. Test the role.
function isAuthenticated(req) {
  return !!req.user && req.user.role !== 'Public' && req.user.identityId !== 'public';
}

// Holder identities are personal data: who owns what. Anonymous callers get
// the shape of the distribution (how many holders, how concentrated) without
// the identities behind it.
function publicHolderView(holders) {
  const total = holders.reduce((s, h) => s + h.balance, 0) || 1;
  return holders.map((h, i) => ({
    ownerId: 'Investor ' + String.fromCharCode(65 + Math.min(i, 25)),
    balance: h.balance,
    sharePct: Math.round((h.balance / total) * 10000) / 100,
    anonymised: true,
  }));
}

app.get('/api/properties', optionalAuth, (req, res) => {
  const { status, city, type, minYield, maxPrice, sort } = req.query;
  let list = Object.values(properties).map(marketplaceView);
  if (status) list = list.filter(p => p.status === status);
  if (city) list = list.filter(p => (p.location && p.location.city || '').toLowerCase() === String(city).toLowerCase());
  if (type) list = list.filter(p => (p.propertyType || '').toLowerCase() === String(type).toLowerCase());
  if (minYield) list = list.filter(p => Number(p.expectedYieldPct || 0) >= Number(minYield));
  if (maxPrice) list = list.filter(p => Number(p.pricePerTokenINR || 0) <= Number(maxPrice));
  const sorters = {
    yield: (a, b) => (b.expectedYieldPct || 0) - (a.expectedYieldPct || 0),
    priceAsc: (a, b) => (a.pricePerTokenINR || 0) - (b.pricePerTokenINR || 0),
    priceDesc: (a, b) => (b.pricePerTokenINR || 0) - (a.pricePerTokenINR || 0),
    funded: (a, b) => (b.fundedPct || 0) - (a.fundedPct || 0),
    valuation: (a, b) => (b.valuationINR || 0) - (a.valuationINR || 0),
  };
  if (sort && sorters[sort]) list = list.sort(sorters[sort]);
  res.json({
    properties: list, count: list.length, fabricMode: 'mock', indexUsed: 'idx_property_status',
    facets: {
      cities: [...new Set(Object.values(properties).map(p => p.location && p.location.city).filter(Boolean))].sort(),
      types: [...new Set(Object.values(properties).map(p => p.propertyType).filter(Boolean))].sort(),
    },
  });
});

app.get('/api/properties/:id', optionalAuth, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  const tokenPrice = prop.totalTokens ? Math.floor(prop.valuationINR / prop.totalTokens) : 0;
  // Supply visibility: how many tokens can an investor buy right now (owner's remaining holding)
  const ownerBal = balances[req.params.id + '~' + prop.originatorId];
  const availableTokens = ownerBal ? Math.max(0, ownerBal.balance) : 0;
  const soldTokens = Math.max(0, (prop.totalTokens || 0) - availableTokens);
  // Real holder distribution — anyone holding >0 of this asset (owner role irrelevant)
  const holders = Object.values(balances)
    .filter(b => b.assetId === req.params.id && parseInt(b.balance) > 0)
    .map(b => ({ ownerId: b.ownerId, balance: parseInt(b.balance) }))
    .sort((a, b) => b.balance - a.balance);
  // Identities only for authenticated callers; everyone else sees the shape.
  const holderView = isAuthenticated(req) ? holders : publicHolderView(holders);
  res.json({ property: prop, tokenPrice, availableTokens, soldTokens, holders: holderView, holderCount: holders.length, subscription: subscriptionOf(prop), documentHashVerified: true, fabricMode: 'mock' });
});

// Title validation is the whole basis of the verification story, so it has to
// be (a) performed by someone other than the owner and (b) written to the
// chain. It used to be neither: any logged-in role could validate, including
// the Originator validating their own property and minting it straight after,
// and the decision left no block behind to audit.
const VALIDATION_DECISIONS = new Set(['VALIDATED', 'REJECTED']);

app.post('/api/properties/:id/validate', authMiddleware, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  if (prop.status !== 'DRAFT') return res.status(400).json({ error: `ERR_INVALID_INPUT: must be DRAFT, current ${prop.status}` });

  const role = req.user.role;
  if (!['Registrar', 'Regulator'].includes(role)) {
    return res.status(403).json({
      error: 'ERR_NOT_REGISTRAR',
      message: `Only a Registrar can validate title. You are signed in as ${role || 'unknown'}. An owner validating their own property would make the check meaningless.`,
    });
  }
  if (req.user.identityId === prop.originatorId) {
    return res.status(403).json({
      error: 'ERR_SELF_VALIDATION',
      message: 'The same identity registered this property, so it cannot also validate it.',
    });
  }

  const decision = String(req.body.decision || '').toUpperCase();
  if (!VALIDATION_DECISIONS.has(decision)) {
    return res.status(400).json({
      error: 'ERR_INVALID_INPUT',
      message: "decision must be 'VALIDATED' or 'REJECTED'",
    });
  }

  prop.registrarValidationStatus = decision;
  prop.validatedBy = req.user.identityId;
  prop.validatedByMsp = req.user.mspId || 'RegistrarMSP';
  prop.validatedAt = new Date().toISOString();
  prop.validationNote = String(req.body.note || '').slice(0, 300) || undefined;
  prop.updatedAt = new Date();
  properties[req.params.id] = prop;

  const block = drunixAppend('PROPERTY_VALIDATED', [{
    kind: 'validation',
    assetId: req.params.id,
    decision,
    documentHash: prop.documentHash,
    validatedBy: prop.validatedBy,
    msp: prop.validatedByMsp,
    note: prop.validationNote,
    endorsedBy: ['RegistrarMSP.peer'],
  }]);

  // The registrar's decision is the single most load-bearing claim on a
  // listing, and until now it existed only as a status field. This turns it
  // into a document a buyer can hold, hash and check.
  certifyOnRail({
    assetId: req.params.id,
    docType: 'VALIDATION_CERTIFICATE',
    title: `Title validation — ${req.params.id}`,
    parties: [prop.validatedBy, prop.originatorId],
    visibility: 'public', // a buyer must be able to read this without asking
    body: {
      document: 'Title validation certificate',
      assetId: req.params.id,
      decision,
      deedSha256: prop.documentHash,
      owner: prop.originatorId,
      validatedBy: prop.validatedBy,
      validatorMsp: prop.validatedByMsp,
      validatedAt: prop.validatedAt,
      note: prop.validationNote || '',
      ledgerBlockHeight: block.height,
      ledgerBlockHash: block.hash,
      independence: req.user.identityId !== prop.originatorId
        ? 'Validator is not the owner.'
        : 'SELF-VALIDATED — not independent.',
    },
  }).catch(() => {});

  res.json({
    assetId: req.params.id,
    validationStatus: decision,
    validatedBy: prop.validatedBy,
    validatedAt: prop.validatedAt,
    blockHeight: block.height,
    blockHash: block.hash,
    fabricMode: 'mock',
  });
});

// The integrations table advertised GET /api/properties/:id/verify as live and
// no such route existed. This is that endpoint: everything a buyer needs to
// decide whether to trust a listing, with the chain evidence behind each claim.
// Deliberately unauthenticated — a trust surface nobody can read is worthless.
app.all('/api/properties/:id/verify', async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'ERR_METHOD_NOT_ALLOWED' });
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });

  const evidence = drunixChain
    .filter(b => (b.txns || []).some(t => t && t.assetId === prop.assetId))
    .map(b => ({ height: b.height, type: b.type, timestamp: b.timestamp, hash: b.hash }));

  const chain = drunixVerify();
  const railChain = await railChainVerdict();
  const validated = prop.registrarValidationStatus === 'VALIDATED';
  const independent = Boolean(prop.validatedBy) && prop.validatedBy !== prop.originatorId;
  const dupes = Object.values(properties).filter(x => x.documentHash === prop.documentHash && x.assetId !== prop.assetId);

  // Read the content-addressed register. null means "could not ask", which is
  // reported as unproven below rather than as an absence of documents — the
  // two are very different claims to make about somebody's title deed.
  const registerDocs = await documentsForAsset(prop.assetId);
  const registerActive = registerDocs ? registerDocs.filter(d => d.status === 'ACTIVE').length : 0;
  const registerRevoked = registerDocs ? registerDocs.filter(d => d.status === 'REVOKED').length : 0;
  const registerSuperseded = registerDocs ? registerDocs.filter(d => d.status === 'SUPERSEDED').length : 0;

  const checks = [
    {
      id: 'registrar',
      ok: validated,
      label: 'Title validated by a registrar',
      detail: validated
        ? `${prop.validatedBy || 'registrar'} (${prop.validatedByMsp || 'RegistrarMSP'}) validated this on ${prop.validatedAt || 'an earlier build, before validations were recorded'}`
        : `Current status is ${prop.registrarValidationStatus || 'PENDING'}. Tokens cannot be minted until a registrar validates the title.`,
    },
    {
      id: 'independence',
      ok: independent || !prop.validatedBy,
      warn: !prop.validatedBy && validated,
      label: 'Validator is not the owner',
      detail: prop.validatedBy
        ? (independent
          ? `Registered by ${prop.originatorId}, validated by ${prop.validatedBy} — different parties.`
          : 'The owner validated their own property. This listing should be re-checked.')
        : 'This property was validated before the validator identity was recorded, so independence cannot be proven from the chain.',
    },
    {
      id: 'document',
      ok: Boolean(prop.documentHash) && String(prop.documentHash).length === 64,
      label: 'Title document fingerprinted',
      detail: prop.documentHash
        ? `SHA-256 ${prop.documentHash}. Hash your own copy of the deed and compare it with POST /api/properties/${prop.assetId}/verify-document.`
        : 'No document hash on record.',
    },
    {
      // A fingerprint alone only helps someone who already holds the file.
      // This check reports whether the evidence is also content-addressed, so
      // a stranger can fetch it and verify it without asking us for anything.
      id: 'documentRegister',
      // This check can only FAIL on a positive red flag: every document on
      // file has been withdrawn. An unreachable register, or a property that
      // predates the register, is reported as not-yet-proven rather than as
      // a failure — otherwise adding this check would mark every existing
      // listing unverified overnight, which would be a lie about them.
      ok: registerDocs === null || registerDocs.length === 0 || registerActive > 0,
      warn: registerDocs === null || (registerDocs !== null && registerDocs.length === 0),
      label: 'Documents anchored and independently verifiable',
      detail: registerDocs === null
        ? 'The document register could not be reached, so this check is unproven rather than failed.'
        : registerDocs.length === 0
          ? 'No document is anchored for this property yet, so there is nothing a stranger can verify independently. Anchor one with POST /api/umi/documents.'
          : registerActive === 0
            ? `Every document on file has been withdrawn (${registerRevoked} revoked, ${registerSuperseded} superseded). Treat this listing as unsupported until a current document is anchored.`
            : `${registerActive} active, ${registerRevoked} revoked, ${registerSuperseded} superseded. ` +
              `Each is addressed by its IPFS CID, so anyone can re-hash their copy and check it: ` +
              registerDocs.slice(0, 3).map(d => `${d.docType} ${d.cid.slice(0, 16)}…`).join(', ') + '.',
    },
    {
      id: 'uniqueness',
      ok: dupes.length === 0,
      label: 'No duplicate deed',
      detail: dupes.length === 0
        ? 'No other listing shares this document hash.'
        : `Shares a document hash with ${dupes.map(d => d.assetId).join(', ')} — possible double listing.`,
    },
    {
      // This check only ever looked at the ownership chain, but it was
      // labelled "Ledger intact from genesis" — which a reader takes to mean
      // every ledger behind the listing, settlement rail included. The rail
      // keeps its own chain and can be broken while this one is perfect, so
      // name which ledger this is and say so when the other one disagrees.
      id: 'chain',
      ok: Boolean(chain.valid),
      ...(railChain && railChain.valid === false ? { warn: true } : {}),
      label: 'Ownership ledger intact from genesis',
      detail: (chain.valid
        ? `All ${chain.blocks ?? drunixChain.length} blocks replay cleanly.`
        : 'Hash chain verification FAILED — treat every claim above as unproven.')
        + (railChain && railChain.valid === false
          ? ` Separately, the UMI settlement rail's own ledger failed verification${railChain.brokenAt != null ? ` at block ${railChain.brokenAt}` : ''}, so settlement history is not currently provable.`
          : ''),
    },
  ];

  const failed = checks.filter(c => !c.ok);
  // A check can pass without being proven: an unreachable register, or a
  // listing with nothing anchored yet, is a warning rather than a failure.
  // Counting only failures let the report announce "every check passed" over
  // a property whose documents nobody can actually verify, which is a more
  // confident claim than the evidence supports.
  const unproven = checks.filter(c => c.ok && c.warn);
  res.json({
    unprovenCount: unproven.length,
    assetId: prop.assetId,
    title: prop.title,
    status: prop.status,
    registrarValidationStatus: prop.registrarValidationStatus,
    verified: failed.length === 0,
    summary: failed.length > 0
      ? `${failed.length} check(s) did not pass: ${failed.map(c => c.label).join('; ')}.`
      : unproven.length > 0
        ? `No check failed, but ${unproven.length} could not be proven: ${unproven.map(c => c.label).join('; ')}.`
        : 'Every verification check passed.',
    checks,
    documentHash: prop.documentHash,
    owner: prop.originatorId,
    validatedBy: prop.validatedBy || null,
    validatedAt: prop.validatedAt || null,
    chainEvidence: evidence,
    documents: registerDocs,
    documentRegisterReachable: registerDocs !== null,
    chainVerified: Boolean(chain.valid),
    checkedAt: new Date().toISOString(),
    fabricMode: 'mock',
  });
});

// Lets a buyer prove the deed they were sent is the one on the ledger, without
// uploading the document itself — they hash it locally and send 64 hex chars.
app.post('/api/properties/:id/verify-document', (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  const supplied = String(req.body.documentHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) {
    return res.status(400).json({
      error: 'ERR_INVALID_INPUT',
      message: 'documentHash must be 64 hex characters (SHA-256 of the file). Compute it with: sha256sum deed.pdf',
    });
  }
  const match = supplied === String(prop.documentHash || '').toLowerCase();
  res.json({
    assetId: prop.assetId,
    match,
    message: match
      ? 'This document matches the one registered on the ledger for this property.'
      : 'This document does NOT match the registered title document. Do not rely on it.',
    registeredHash: prop.documentHash,
    suppliedHash: supplied,
    checkedAt: new Date().toISOString(),
  });
});

// Tokens of this asset already credited to holders other than `exceptOwner`.
// A self-heal may only hand out what is genuinely left of the issued supply.
// Without this cap, healing a missing balance mints tokens out of nothing and
// the sum of holdings climbs past totalTokens — which is what put properties
// above 100% allocated on the insights dashboard.
function supplyHeadroom(balanceMap, assetId, exceptOwner, totalTokens) {
  let heldByOthers = 0;
  for (const b of Object.values(balanceMap)) {
    if (!b || b.assetId !== assetId) continue;
    if (b.ownerId === exceptOwner) continue;
    heldByOthers += parseInt(b.balance) || 0;
  }
  return Math.max(0, (parseInt(totalTokens) || 0) - heldByOthers);
}

app.post('/api/properties/:id/mint', authMiddleware, async (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  // Minting sets the entire supply, and supply divided into the valuation is
  // the token price. Validate, freeze, delete, yield and governance were all
  // owner-checked; this one, the most consequential write of the lot, was
  // not — any signed-in user could tokenise someone else's listing.
  if (prop.originatorId !== req.user.identityId && String(req.user.role || '').toLowerCase() !== 'regulator') {
    return res.status(403).json({
      error: 'ERR_NOT_ALLOWED',
      message: `Only the listing owner (${prop.originatorId}) or a Regulator can mint this listing.`,
    });
  }
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
  drunixAppend('TOKEN_MINTED', [{ kind: 'mint', assetId: req.params.id, to: prop.originatorId, msp: 'OriginatorMSP', totalTokens, endorsedBy: ['OriginatorMSP.peer', 'RegistrarMSP.peer'] }]);
  const rail = await seedRailPosition(req.params.id, prop.originatorId, totalTokens);
  // Tokenisation is the moment a building becomes a security. That deserves
  // an instrument document stating exactly what was issued, against which
  // deed, on whose validation — the prospectus-shaped fact an investor is
  // entitled to before they buy a fraction of it.
  certifyOnRail({
    assetId: req.params.id,
    docType: 'TOKENISATION_CERTIFICATE',
    title: `Tokenisation — ${req.params.id}`,
    parties: [prop.originatorId],
    visibility: 'public',
    body: {
      document: 'Tokenisation certificate',
      assetId: req.params.id,
      propertyTitle: prop.title,
      issuer: prop.originatorId,
      totalTokens,
      valuationINR: prop.valuationINR,
      deedSha256: prop.documentHash,
      validatedBy: prop.validatedBy || null,
      validatedAt: prop.validatedAt || null,
      location: prop.location,
      endorsement: "AND('OriginatorMSP.peer','RegistrarMSP.peer')",
      ledgerBlockHeight: drunixChain.length - 1,
      note: 'Issued supply is fixed at this figure. No settlement may push holdings above it.',
    },
  }).catch(() => {});

  const resp = { assetId: req.params.id, totalTokens, status: 'TOKENIZED', fabricMode: 'mock', blockHeight: drunixChain.length - 1, endorsement: "AND('OriginatorMSP.peer','RegistrarMSP.peer') enforced", rail };
  if (idemKey) idempotency[idemKey] = resp;
  res.json(resp);
});

app.post('/api/properties/:id/freeze', authMiddleware, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  // Freezing an asset halts every transfer on it. That is a supervisory power,
  // not something any signed-in investor should be able to do to someone
  // else's property.
  if (!['Regulator', 'Registrar'].includes(req.user.role)) {
    return res.status(403).json({
      error: 'ERR_NOT_REGULATOR',
      message: 'Only a Regulator or Registrar can freeze an asset.',
    });
  }
  prop.status = 'FROZEN';
  prop.updatedAt = new Date();
  properties[req.params.id] = prop;
  res.json({ assetId: req.params.id, status: 'FROZEN', reason: req.body.reason, fabricMode: 'mock' });
});

app.post('/api/transfers', authMiddleware, (req, res) => {
  const { assetId, fromId: reqFrom, toId, amount, clientState } = req.body;
  // Identity hardening: you can only spend YOUR tokens (Registrar/Regulator may act on behalf for audit moves)
  const fromId = (reqFrom && (reqFrom === req.user.identityId || ['Registrar', 'Regulator'].includes(req.user.role))) ? reqFrom : req.user.identityId;
  const amt = parseInt(amount);
  if (amt <= 0) return res.status(400).json({ error: 'ERR_INVALID_AMOUNT' });
  if (fromId === toId) return res.status(400).json({ error: 'ERR_INVALID_TRANSFER: self-transfer not allowed' });
  let prop = properties[assetId];
  if (!prop) {
    // Cold-instance heal: property meta sent by the client that bought on a warm instance
    const cp = clientState && clientState.property;
    if (cp && cp.assetId === assetId && cp.title && parseFloat(cp.valuationINR) > 0) {
      const nowC = new Date();
      properties[assetId] = {
        assetId, docType: 'property', originatorId: cp.originatorId || fromId,
        title: cp.title,
        location: cp.location || { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
        valuationINR: parseInt(cp.valuationINR), totalTokens: parseInt(cp.totalTokens) || 10000,
        documentHash: 'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
        registrarValidationStatus: cp.registrarValidationStatus || 'VALIDATED',
        status: 'TOKENIZED', createdAt: nowC, updatedAt: nowC, version: 1, restoredFromClient: true
      };
      prop = properties[assetId];
    }
  }
  if (!prop) {
    // Auto-fix (same as Vercel): create demo property + owner balance so buys never dead-end
    const nowT = new Date();
    properties[assetId] = {
      assetId, docType: 'property', originatorId: fromId,
      title: `Property ${assetId.slice(0, 24)}`,
      location: { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
      valuationINR: 6000000, totalTokens: 10000,
      documentHash: 'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
      registrarValidationStatus: 'VALIDATED', status: 'TOKENIZED',
      createdAt: nowT, updatedAt: nowT, version: 1, autoCreated: true
    };
    prop = properties[assetId];
    balances[assetId + '~' + fromId] = { docType: 'balance', assetId, ownerId: fromId, balance: prop.totalTokens, updatedAt: nowT };
  }
  if (prop.status === 'FROZEN') return res.status(400).json({ error: 'ERR_ASSET_FROZEN' });
  if (prop.status !== 'TOKENIZED') return res.status(400).json({ error: 'ERR_INVALID_TRANSFER: asset not tokenized' });
  const fromKyc = kycRecords[fromId];
  if (fromKyc && fromKyc.kycStatus !== 'VERIFIED') return res.status(400).json({ error: 'ERR_KYC_NOT_VERIFIED: sender' });
  if (!fromKyc && fromId !== prop.originatorId) return res.status(400).json({ error: 'ERR_KYC_NOT_VERIFIED: sender KYC not found' });
  const toKyc = kycRecords[toId];
  if (!toKyc) return res.status(400).json({ error: `ERR_KYC_NOT_VERIFIED: receiver ${toId} KYC not found` });
  if (toKyc.kycStatus !== 'VERIFIED') return res.status(400).json({ error: 'ERR_KYC_NOT_VERIFIED: receiver' });
  const fromKey = assetId + '~' + fromId;
  let fromBal = balances[fromKey];
  if (!fromBal) {
    // 1) migrate an owner balance stored under another key
    const alt = Object.values(balances).find(b => b.assetId === assetId && b.ownerId === fromId);
    if (alt) {
      balances[fromKey] = { ...alt, assetId, ownerId: fromId };
      fromBal = balances[fromKey];
    }
  }
  if (!fromBal && clientState && Array.isArray(clientState.receipts) && clientState.receipts.length > 0) {
    // 2) verified purchase receipts (cold-instance self-heal, same as Vercel)
    let verifiedTokens = 0;
    const nowH = Date.now();
    for (const r of clientState.receipts) {
      if (!r || !r.paymentId || !r.createdAt) continue;
      if (r.assetId !== assetId) continue;
      if ((r.payerId || fromId) !== fromId) continue;
      const created = new Date(r.createdAt);
      if (isNaN(created.getTime()) || (nowH - created.getTime()) > 24 * 3600 * 1000) continue;
      if (['CONFIRMED', 'RELEASED'].includes(r.status) && parseInt(r.tokenAmount) > 0) {
        verifiedTokens += parseInt(r.tokenAmount);
        if (!npciPayments[r.paymentId]) {
          npciPayments[r.paymentId] = { ...r, restoredFromClient: true };
        }
      }
    }
    const headroom = supplyHeadroom(balances, assetId, fromId, prop.totalTokens);
    const healable = Math.min(verifiedTokens, headroom);
    if (healable >= amt) {
      balances[fromKey] = { docType: 'balance', assetId, ownerId: fromId, balance: healable, updatedAt: new Date() };
      fromBal = balances[fromKey];
    } else {
      return res.status(400).json({ error: 'ERR_INSUFFICIENT_BALANCE', verifiedTokens, headroom, needed: amt, message: `Verified tokens from your purchase receipts: ${verifiedTokens}. Needed: ${amt}.` });
    }
  }
  if (!fromBal) {
    // 3) demo auto-fix: originator gets supply
    if (fromId === prop.originatorId || fromId === 'originator1' || prop.autoCreated || prop.restoredFromClient) {
      // Only the unsold remainder, never the whole supply again.
      balances[fromKey] = { docType: 'balance', assetId, ownerId: fromId,
        balance: supplyHeadroom(balances, assetId, fromId, prop.totalTokens), updatedAt: new Date() };
      fromBal = balances[fromKey];
    } else {
      return res.status(400).json({ error: 'ERR_BALANCE_NOT_FOUND' });
    }
  }
  if (fromBal.balance < amt) return res.status(400).json({ error: `ERR_INSUFFICIENT_BALANCE: have ${fromBal.balance} need ${amt}` });
  const lockedNow = drunixLockedTokens(assetId, fromId);
  if (fromBal.balance - lockedNow < amt) return res.status(400).json({ error: 'ERR_TOKENS_LOCKED', message: `${lockedNow} tokens are pledged as loan collateral. Repay the loan or transfer less.` });
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
  drunixAppend('TOKEN_TRANSFERRED', [{ kind: 'transfer', transferId, assetId, from: fromId, to: toId, tokens: amt, commitType: 'propose-endorse-commit' }]);
  res.json({ transferId, assetId, fromId, toId, amount: amt, status: 'COMPLETED', blockHeight: drunixChain.length - 1, fabricMode: 'mock' });
});

// FIX: wallet route BEFORE balance/:assetId/:ownerId — otherwise "wallet" is captured as assetId
app.get('/api/balances/wallet/:ownerId', authMiddleware, (req, res) => {
  const ownerId = req.params.ownerId;
  const bals = Object.values(balances).filter(b => b.ownerId === ownerId && (b.balance || 0) > 0);
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

app.get('/api/balances/:assetId/:ownerId', authMiddleware, (req, res) => {
  // Safety: wallet handled above; never treat it as an asset
  if (req.params.assetId === 'wallet') {
    return res.json({ ownerId: req.params.ownerId, balances: [], totalPortfolioValue: 0 });
  }
  const key = req.params.assetId + '~' + req.params.ownerId;
  const bal = balances[key] || { docType: 'balance', assetId: req.params.assetId, ownerId: req.params.ownerId, balance: 0 };
  res.json(bal);
});


// A placeholder hash is not a document. The listing form shipped one constant
// value - the SHA-256 of an EMPTY STRING - for every property, so the first
// listing claimed it and every later one collided. Clients cached in users'
// browsers still send it, so the fix has to live here: a placeholder is
// treated as "no document attached" and replaced with a fingerprint of the
// property itself, which is unique per property and still catches a genuine
// re-submission of the same one.
const PLACEHOLDER_DOCUMENT_HASHES = new Set([
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '0'.repeat(64),
  'f'.repeat(64),
]);

function propertyFingerprint(fields, ownerId) {
  const basis = ['aasthichain-property-v1', fields.title, fields.city, fields.state,
    fields.pincode, fields.valuationINR, ownerId]
    .map(v => String(v == null ? '' : v).trim().toLowerCase()).join('|');
  return crypto.createHash('sha256').update(basis).digest('hex');
}

function normaliseDocumentHash(documentHash, fields, ownerId) {
  const h = String(documentHash || '').trim().toLowerCase();
  if (!h || PLACEHOLDER_DOCUMENT_HASHES.has(h)) {
    return { hash: propertyFingerprint(fields, ownerId), derived: true };
  }
  return { hash: h, derived: false };
}

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

// === Sepolia Testnet Escrow — Atomic DvP Settlement Pattern Demo — Accurate Language ===
let testnetPayments = {};

app.post('/api/testnet/payments/initiate', authMiddleware, (req, res) => {
  const { assetId, tokenAmount, estimatedEth, txHash, paymentId, from, to, isSimulated } = req.body;
  const pid = paymentId || (isSimulated ? 'SIM-' + crypto.randomUUID().slice(0,8).toUpperCase() : '0x' + crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'').slice(0,16));
  // FIX: No fabricated hash in simulated mode — per user fix #1, simulated state has no fake 0x... hash or fake Etherscan link, greyed out non-clickable
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
    // Who actually started this escrow. `from` comes from the body and is
    // whatever the caller typed, so it cannot be the basis of a check.
    initiatedBy: req.user.identityId,
    // Real flow: Etherscan-verifiable link, Simulated: no link, greyed out non-clickable visibly different
    sepoliaExplorer: isSimulated ? '' : `https://sepolia.etherscan.io/tx/${finalTxHash}`,
    escrowContract: '0x0000000000000000000000000000000000000000',
    amountINR: tokenAmount * 500
  };
  res.json({ 
    paymentId: pid, 
    status: 'PENDING', 
    txHash: finalTxHash, 
    isSimulated: !!isSimulated,
    sepoliaExplorer: testnetPayments[pid].sepoliaExplorer, 
    message: isSimulated ? 'Simulated — faucet unavailable, no real transaction — Drunix leg only, greyed out non-clickable' : 'Testnet escrow locked — real on-chain testnet transaction demonstrating atomic DvP settlement pattern, Sepolia test ETH has no monetary value' 
  });
});

app.get('/api/testnet/payments/:id', authMiddleware, (req, res) => {
  const pay = testnetPayments[req.params.id] || Object.values(testnetPayments)[0];
  if (!pay) return res.status(404).json({ error: 'Payment not found' });
  res.json(pay);
});

// Confirming or releasing someone else's escrow is not yours to do.
function testnetDenied(req, res, pid) {
  const pay = testnetPayments[pid];
  if (!pay) { res.status(404).json({ error: 'ERR_PAYMENT_NOT_FOUND', paymentId: pid }); return true; }
  const me = req.user.identityId;
  if (pay.initiatedBy === me || pay.from === me || pay.to === me) return false;
  if (SUPERVISORY.has(String(req.user.role || '').toLowerCase())) return false;
  res.status(403).json({ error: 'ERR_NOT_YOUR_PAYMENT', message: 'This testnet escrow belongs to another participant.' });
  return true;
}

app.post('/api/testnet/payments/:id/confirm', authMiddleware, (req, res) => {
  const pid = req.params.id;
  if (testnetDenied(req, res, pid)) return;
  if (testnetPayments[pid]) {
    testnetPayments[pid].status = 'CONFIRMED';
    testnetPayments[pid].drunixTransferId = req.body.drunixTransferId;
    testnetPayments[pid].confirmedAt = new Date();
  }
  res.json({ paymentId: pid, status: 'CONFIRMED', drunixTransferId: req.body.drunixTransferId, message: 'Drunix transfer confirmed — linked to testnet escrow via confirmDrunixTransfer() — real Drunix ledger' });
});

app.post('/api/testnet/payments/:id/release', authMiddleware, (req, res) => {
  const pid = req.params.id;
  if (testnetDenied(req, res, pid)) return;
  if (testnetPayments[pid]) {
    testnetPayments[pid].status = 'RELEASED';
    testnetPayments[pid].releasedAt = new Date();
  }
  const isSim = testnetPayments[pid]?.isSimulated;
  res.json({ 
    paymentId: pid, 
    status: 'RELEASED', 
    isSimulated: !!isSim,
    message: isSim ? 'Simulated release — faucet unavailable, no real transaction — DvP pattern demo only' : 'Escrow released to originator — atomic DvP settlement pattern complete — real on-chain testnet transactions demonstrating DvP, Sepolia test ETH has no monetary value' 
  });
});

app.get('/api/testnet/payments', authMiddleware, (req, res) => {
  res.json({ 
    payments: Object.values(testnetPayments), 
    count: Object.keys(testnetPayments).length, 
    faucet: 'https://sepoliafaucet.com/', 
    explorer: 'https://sepolia.etherscan.io/', 
    contract: 'PaymentEscrow.sol — Sepolia Testnet — demonstrates atomic DvP settlement pattern, Sepolia test ETH has no monetary value, real on-chain testnet transactions when faucet available, simulated greyed out non-clickable when faucet unavailable' 
  });
});

app.get('/api/testnet/config', (req, res) => {
  res.json({
    chainId: '0xaa36a7',
    chainName: 'Sepolia Testnet',
    rpcUrl: 'https://rpc.sepolia.org',
    explorer: 'https://sepolia.etherscan.io',
    contractAddress: process.env.ESCROW_CONTRACT || '0x0000000000000000000000000000000000000000',
    faucet: 'https://sepoliafaucet.com/',
    conversion: 'Oracle: ₹20k = 1 SepoliaETH for demo (min 0.001 enforced), prod uses Chainlink',
    message: 'Real on-chain testnet transactions demonstrating atomic delivery-vs-payment settlement pattern, Sepolia test ETH has no monetary value, not real monetary value — real Sepolia flow Etherscan-verifiable when faucet available, simulated greyed out non-clickable when faucet unavailable'
  });
});

// SPA fallback - serve index.html for all non-API routes (React Router)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
    return next();
  }
  if (req.method !== 'GET') return next();
  const distPath = path.join(__dirname, 'frontend', 'dist');
  // Prefer the prerendered head for this route; fall back to the SPA shell
  // for anything dynamic. Matches what Vercel serves.
  const rel = path.normalize(req.path).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  const routeIndex = path.join(distPath, rel, 'index.html');
  const indexPath = path.join(distPath, 'index.html');
  if (rel && routeIndex.startsWith(distPath) && fs.existsSync(routeIndex)) {
    res.sendFile(routeIndex);
  } else if (fs.existsSync(indexPath)) {
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

// ============ NPCI UPI Collect Rail (SIMULATION — same state machine as Vercel api/index.js) ============
// Rail: UPI Collect (P2M) — payee requests money, payer approves in UPI app, IMPS settles with UTR
// Settlement: escrow release triggers Drunix token transfer (DvP — Delivery versus Payment, atomic)
// Fictitious test VPAs only: demo.investor@aasthichain etc — no real mobile numbers, no live NPCI

let npciPayments = {};
let npciIdem = {};
let npciBalances = {
  'investor@aasthichain': 100000000,
  'investor1@aasthichain': 100000000,
  'investor2@aasthichain': 50000000,
  'originator@aasthichain': 100000000,
  'originator1@aasthichain': 100000000,
  'poor@aasthichain': 100,
  'demo.investor@aasthichain': 100000000,
  'demo.investor@fakebank': 100000000,
  'demo.owner@fakebank': 100000000
};
let utrIndex = {};
let npciWebhooks = [];

function isValidVPA(vpa) {
  return typeof vpa === 'string' && /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-]{1,32}$/.test(vpa.trim());
}
function genPaymentID() {
  return 'NPCI-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}
function genUpiTxnID() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `AAST${ymd}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function genRRN() {
  return '418' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
}
function genUTRRealistic() {
  const rrn = genRRN();
  const utr12 = String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
  const utrImps = 'IMPS' + rrn + String(Math.floor(Math.random() * 9000) + 1000);
  return { rrn, utr12, utrImps, utr: utr12 };
}
// ===== PayU test-mode UPI bridge ("feels like real UPI") =====
// Real PSP contract on https://test.payu.in — SHA-512 request hash, reverse-hash
// callback verification, mihpayid/bank_ref_num. Simulated settlement (no NPCI,
// no real money). Mock rail stays default; NPCI_MODE=payu + PAYU_* envs activate.

// ===== Server-side settlement — THE source of truth for completing a purchase =====
// A CONFIRMED payment must always result in tokens moving, regardless of what the
// browser does afterwards (closed tab, lost localStorage, buggy client orchestration).
// Idempotent: RELEASED payments return as-is.
// A completed purchase has to reach the ledger the Ledger Explorer actually
// reads. That view is the Go rail's hash chain (/drunix/chain), and only UMI
// operations append to it — the app-side block written above lives on a
// separate in-memory chain, which is why paid-for transfers never showed up.
// So mirror the settlement onto the rail as a real DvP: fund the buyer's e₹-W
// wallet with the money PayU actually collected, then settle securities
// against cash atomically. Best effort by design — the tokens have already
// moved and the buyer has paid, so a rail hiccup must never fail the purchase
// or throw. Keyed on paymentId so retries do not double-settle.
// Issue a property's opening position on the UMI settlement rail.
//
// Tokenizing wrote the opening balance into the app's own ledger and stopped
// there, so the rail had never heard of the asset. Every later purchase then
// moved tokens app-side while the rail refused the DvP with
// ERR_UMI_INSUFFICIENT_SECURITIES — "listed" and "settleable" drifted apart
// and the chain filled with UMI_DVP_FAILED blocks for purchases the app had
// already called successful. Seeding is absolute and idempotent, so repeating
// it is safe. Never throws: tokenizing must not fail because the rail is down.
async function seedRailPosition(assetId, holder, tokens) {
  const base = (process.env.UMI_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base || !assetId || !holder || !tokens) return { skipped: 'rail not configured' };
  try {
    const r = await fetch(base + '/umi/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `seed-${assetId}-${tokens}`, 'X-Fabric-Identity': 'aasthichain-gateway', 'X-Identity-Role': 'Admin' },
      body: JSON.stringify({ assetId, holder, tokens, authorisedTokens: tokens }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status >= 400) {
      console.error('[RAIL] could not issue opening position for', assetId, body.error || r.status);
      return { ok: false, error: body.error };
    }
    console.log(`[RAIL] opening position issued: ${holder} holds ${tokens} of ${assetId}`);
    return { ok: true, position: body.position };
  } catch (e) {
    console.error('[RAIL] seed unreachable for', assetId, e.message);
    return { ok: false, error: e.message };
  }
}

// The settlement rail keeps its own chain. This one can replay perfectly
// while the rail's is broken, so a verify report that says "ledger intact"
// without saying which ledger is overclaiming. Unreachable means unknown,
// never "fine".
async function railChainVerdict() {
  const base = (process.env.UMI_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(base + '/umi/reconciliation', { signal: ctrl.signal });
    if (!r.ok) return null;
    const body = await r.json();
    return (body && body.chain) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function commitSettlementToRail(pay, assetId, seller, buyer, tokens) {
  const base = (process.env.UMI_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base) return { skipped: 'UMI_GATEWAY_URL not set' };
  const amountINR = Number(pay.amountINR) || 0;
  // This is the gateway settling on the rail after money actually arrived,
  // not a person asking. It identifies itself as the settlement operator.
  const post = async (path, body, idem) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': idem, 'X-Fabric-Identity': 'aasthichain-gateway', 'X-Identity-Role': 'Admin' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    // Cash leg: the rupees PayU took become the buyer's wholesale CBDC balance.
    if (amountINR > 0) await post(`/umi/wallets/${encodeURIComponent(buyer)}/fund`, { amountINR }, `${pay.paymentId}-fund`);
    const dvp = await post('/umi/dvp', {
      assetId, seller, buyer, tokens,
      pricePerTokenINR: tokens > 0 ? amountINR / tokens : 0,
    }, pay.paymentId);
    if (dvp.status >= 400) {
      console.error('[RAIL] DvP refused for', pay.paymentId, dvp.body && (dvp.body.error || dvp.body.message));
      // Record the refusal on the payment. The purchase still completed in the
      // app ledger, but calling that "atomic DvP settled" when the settlement
      // rail refused it is a claim the chain contradicts.
      pay.umiError = (dvp.body && dvp.body.error) || 'ERR_UMI_REFUSED';
      pay.umiErrorMessage = (dvp.body && dvp.body.message) || '';
      return { ok: false, status: dvp.status, error: pay.umiError };
    }
    pay.umiError = null;
    pay.umiErrorMessage = null;
    const iid = dvp.body && dvp.body.instruction && dvp.body.instruction.instructionId;
    if (iid) {
      pay.umiInstructionId = iid;
      pay.umiIsin = dvp.body.instruction.isin;
      // The settlement block on the chain is keyed by instructionId, not by
      // our TXN- id, so carry it onto the transfer too. Transaction history
      // was citing a "ledger ref" that appears nowhere on the ledger.
      const tr = pay.drunixTransferId && transfers[pay.drunixTransferId];
      if (tr) { tr.umiInstructionId = iid; tr.umiIsin = dvp.body.instruction.isin; }
    }
    console.log(`[RAIL] ${pay.paymentId} settled on the UMI chain as ${iid}`);
    return { ok: true, instructionId: iid };
  } catch (e) {
    console.error('[RAIL] could not reach the settlement rail for', pay.paymentId, e.message);
    return { ok: false, error: e.message };
  }
}

// A purchase can reach RELEASED two ways: server-side via settleConfirmedPayment
// (PayU callback) or client-side via POST /payments/{id}/release after the
// frontend has done the token transfer itself. Only the first used to touch the
// UMI rail, so UI purchases were RELEASED but absent from the chain. Both paths
// now land here. Safe to call twice — the DvP is keyed by paymentId.
async function railCommitForReleasedPayment(pay) {
  if (!pay || pay.umiInstructionId) return { skipped: 'already on chain' };
  const assetId = pay.assetId;
  const tokens = parseInt(pay.tokenAmount);
  if (!assetId || !tokens || tokens <= 0) return { skipped: 'payment has no asset or token amount' };
  const prop = properties[assetId] || Object.values(properties).find(p => p.assetId === assetId);
  const seller = (prop && prop.originatorId) || 'originator1';
  const buyer = pay.payerId || 'investor1';
  if (seller === buyer) return { skipped: 'seller and buyer are the same participant' };
  return commitSettlementToRail(pay, assetId, seller, buyer, tokens);
}

async function settleConfirmedPayment(pay) {
  if (!pay) return { ok: false, code: 404, error: 'ERR_PAYMENT_NOT_FOUND', message: 'Payment not found' };
  // Hand the transfer back on the already-settled path too. The browser
  // needs it to render the success screen when the server got there first.
  if (pay.status === 'RELEASED' && pay.drunixTransferId) {
    return { ok: true, already: true, payment: pay, transfer: transfers[pay.drunixTransferId] || null, message: 'Already settled' };
  }
  if (pay.status !== 'CONFIRMED') return { ok: false, code: 409, error: 'ERR_NOT_CONFIRMED', message: `Payment is ${pay.status} — only CONFIRMED payments settle. Use /payu/reconcile first for PayU payments.` };
  const assetId = pay.assetId, buyer = pay.payerId || 'investor1';
  if (!assetId) return { ok: false, code: 400, error: 'ERR_NO_ASSET', message: 'Payment has no assetId' };
  const amt = parseInt(pay.tokenAmount);
  if (!amt || amt <= 0) return { ok: false, code: 400, error: 'ERR_NO_TOKENS', message: 'Payment has no tokenAmount' };
  let prop = properties[assetId] || Object.values(properties).find(p => p.assetId === assetId);
  if (!prop) return { ok: false, code: 404, error: 'ERR_ASSET_NOT_FOUND', message: 'Property not found: ' + assetId };
  const seller = prop.originatorId || 'originator1';
  const sKey = assetId + '~' + seller, bKey = assetId + '~' + buyer;
  const sBal = balances[sKey] || Object.values(balances).find(b => b.assetId === assetId && b.ownerId === seller);
  const sHave = sBal ? parseInt(sBal.balance) : 0;
  if (sHave < amt) {
    return { ok: false, code: 409, error: 'ERR_SELLER_NO_BALANCE', message: `Seller ${seller} holds ${sHave} tokens but payment needs ${amt}. Re-mint the property or fix ownership.` };
  }
  const now = new Date();
  balances[sKey] = { docType: 'balance', assetId, ownerId: seller, balance: sHave - amt, updatedAt: now };
  const bBal = balances[bKey] || Object.values(balances).find(b => b.assetId === assetId && b.ownerId === buyer);
  balances[bKey] = { docType: 'balance', assetId, ownerId: buyer, balance: ((bBal ? parseInt(bBal.balance) : 0)) + amt, updatedAt: now };
  const tid = `TXN-${(typeof safeUUID === 'function' ? safeUUID() : crypto.randomUUID()).slice(0, 8)}-S1`;
  transfers[tid] = { docType: 'transfer', transferId: tid, assetId, fromId: seller, toId: buyer, amount: amt, txTimestamp: now, status: 'COMPLETED', paymentId: pay.paymentId, settledServerSide: true };
  drunixAppend('TOKEN_TRANSFERRED', [{ kind: 'transfer', transferId: tid, assetId, from: seller, to: buyer, tokens: amt, paymentId: pay.paymentId, atomic: 'DvP-leg-1' }]);
  pay.drunixTransferId = tid;
  pay.status = 'RELEASED';
  pay.releasedAt = now;
  drunixAppend('ESCROW_RELEASED', [{ kind: 'escrow-release', paymentId: pay.paymentId, transferId: tid, assetId, amountINR: pay.amountINR, tokens: amt, seller, buyer, atomic: 'DvP-leg-2' }]);
  if (typeof globalThis !== 'undefined') {
    globalThis._aasthi_balances = balances;
    globalThis._aasthi_transfers = transfers;
    globalThis._aasthi_npcipayments = npciPayments;
  }
  try { if (typeof persistNpciState === 'function') await persistNpciState(); } catch {}
  try { if (typeof saveAllPersisted === 'function') saveAllPersisted(); } catch {}
  console.log(`[SETTLE] ${pay.paymentId}: ${amt} tokens ${seller} → ${buyer} (${tid}) — server-side settlement`);
  const rail = await commitSettlementToRail(pay, assetId, seller, buyer, amt);
  try { await persistNpciState(); } catch {}
  // A purchase receipt: the money leg, the UTR, the tokens, and the block
  // that proves all three. Restricted to the two parties — it names what
  // somebody paid — but anchored so neither side can later dispute it.
  certifyOnRail({
    assetId,
    subject: buyer,
    docType: 'PAYMENT_RECEIPT',
    title: `Payment receipt ${pay.paymentId}`,
    parties: [buyer, seller],
    visibility: 'restricted',
    body: {
      document: 'Payment receipt and escrow release',
      paymentId: pay.paymentId,
      assetId,
      buyer,
      seller,
      tokens: amt,
      amountINR: pay.amountINR,
      utr: pay.utr || null,
      rrn: pay.rrn || null,
      provider: pay.provider || 'npci-upi',
      transferId: tid,
      status: 'RELEASED',
      settledAt: pay.releasedAt || pay.updatedAt || null,
      note: 'Escrow released against confirmed funds. Tokens and cash moved as one settlement.',
    },
  }).catch(() => {});

  return { ok: true, payment: pay, transfer: transfers[tid], moved: amt, seller, buyer, rail };
}


// ===== Property deletion / delisting =====
// Originator: own listing — anytime while DRAFT (nothing tokenized), or once fully
// subscribed (all tokens sold: owner holds 0). Regulator: any listing (compliance).
// ---- Subscription lifecycle (computed, never stored — can't drift from ledger)
// primary (buying) -> fully-subscribed (primary closed, phase 'secondary') ->
// wallet-to-wallet P2P transfers. Drives buy guards + UI progress/badges.
// ================= AASTHI DRUNIX — HASH-CHAINED BLOCK LEDGER =================
// Every state change (mint / token transfer / escrow release) is committed as a
// block: SHA-512 chained (prevHash) + merkle-committed (txnsRoot). Anyone —
// people, agents, or DPI stacks — can verify the whole chain without trusting
// the server: GET /api/chain/verify (open layer, no auth, no PII).
const DRUNIX_CHAIN_ID = 'aasthi-drunix';
const DRUNIX_GENESIS_PREV = '0'.repeat(128);
const DRUNIX_ORGS = [
  { msp: 'AasthiChainMSP', role: 'platform' },
  { msp: 'OriginatorMSP', role: 'property-owner' },
  { msp: 'RegistrarMSP', role: 'registrar' },
  { msp: 'InvestorMSP', role: 'investor' },
  { msp: 'RegulatorMSP', role: 'regulator' }
];
function drunixHash(s) { return crypto.createHash('sha512').update(String(s)).digest('hex'); }
function drunixTxnsRoot(txns) {
  if (!txns || !txns.length) return drunixHash('');
  let layer = txns.map(t => drunixHash(JSON.stringify(t)));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(drunixHash(layer[i] + (layer[i + 1] || layer[i])));
    layer = next;
  }
  return layer[0];
}
function drunixCanonical(b) { return [b.height, b.timestamp, b.type, b.txnsRoot, b.prevHash].join('|'); }
let drunixChain = (typeof globalThis !== 'undefined' && globalThis._aasthi_chain) || [];
function drunixAppend(type, txns) {
  const prev = drunixChain[drunixChain.length - 1] || null;
  const b = {
    height: drunixChain.length,
    timestamp: new Date().toISOString(),
    type, txns,
    contract: 'aasthi.dvp-v1',
    txnsRoot: null, prevHash: prev ? prev.hash : DRUNIX_GENESIS_PREV, hash: null
  };
  b.txnsRoot = drunixTxnsRoot(b.txns);
  b.hash = drunixHash(drunixCanonical(b));
  drunixChain.push(b);
  if (typeof globalThis !== 'undefined') globalThis._aasthi_chain = drunixChain;
  return b;
}
if (drunixChain.length === 0) {
  drunixAppend('GENESIS', [{ config: 'aasthi-channel-init', channel: DRUNIX_CHAIN_ID, orgs: DRUNIX_ORGS, consensus: 'RAFT (simulated)', hashAlgo: 'SHA-512', network: 'NPCI Drunix fork · permissioned' }]);
}
function drunixVerify() {
  for (let i = 0; i < drunixChain.length; i++) {
    const b = drunixChain[i];
    const expectPrev = i === 0 ? DRUNIX_GENESIS_PREV : drunixChain[i - 1].hash;
    if (b.prevHash !== expectPrev) return { valid: false, brokenAt: b.height, reason: 'prevHash linkage broken — block ' + b.height + ' no longer follows ' + (i - 1) };
    if (drunixTxnsRoot(b.txns) !== b.txnsRoot) return { valid: false, brokenAt: b.height, reason: 'merkle root mismatch — block ' + b.height + ' transactions were altered after commit' };
    if (b.hash !== drunixHash(drunixCanonical(b))) return { valid: false, brokenAt: b.height, reason: 'block ' + b.height + ' contents do not match its committed hash — data was altered after commit' };
  }
  return { valid: true, chainId: DRUNIX_CHAIN_ID, height: Math.max(0, drunixChain.length - 1), blocks: drunixChain.length, checkedAt: new Date().toISOString() };
}
// Judge/demo only (clearly labeled SIMULATION in UI): alter a committed txn so
// verify() can detect it — proof of tamper-evidence, the core of decentralized trust.
function drunixTamper(height) {
  const b = drunixChain[height];
  if (!b || b.type === 'GENESIS' || !b.txns.length) return null;
  if (!b._pristine) b._pristine = JSON.stringify(b.txns);
  const t = b.txns[0];
  if (t.amount) t.amount = Number(t.amount) * 10 + 1;
  else if (t.totalTokens) t.totalTokens = Number(t.totalTokens) + 999999;
  else if (t.tokens) t.tokens = Number(t.tokens) * 10 + 1;
  else t.TAMPERED = true;
  return { height, altered: t };
}
function drunixRestore(height) {
  const b = drunixChain[height];
  if (b && b._pristine) { b.txns = JSON.parse(b._pristine); delete b._pristine; return true; }
  return false;
}
// ============ END HASH-CHAINED BLOCK LEDGER ============

// ---- Programmable ownership: yield servicing, governance, credit, swaps ----
// Shared Drunix transaction layer: every primitive below commits to the same
// hash-chained ledger, so investors, owners and financial participants all see
// one truth (the UMI/Demat-2.0 pattern: DLT assets + programmable servicing).
const yieldBalances = (typeof globalThis !== 'undefined' && globalThis._aasthi_yield) || {};
const governance = (typeof globalThis !== 'undefined' && globalThis._aasthi_gov) || {};
const creditLoans = (typeof globalThis !== 'undefined' && globalThis._aasthi_loans) || {};
if (typeof globalThis !== 'undefined') { globalThis._aasthi_yield = yieldBalances; globalThis._aasthi_gov = governance; globalThis._aasthi_loans = creditLoans; }
function drunixTokenPrice(assetId) { const p = properties[assetId]; return p && p.totalTokens ? Math.floor(p.valuationINR / p.totalTokens) : 0; }
function drunixLockedTokens(assetId, identityId) { let l = 0; for (const L of Object.values(creditLoans)) if (L.status === 'ACTIVE' && L.assetId === assetId && L.identityId === identityId) l += parseInt(L.tokens); return l; }
function drunixNav(identityId) {
  const holdings = []; let assetsValue = 0;
  for (const b of Object.values(balances)) {
    if (b.ownerId !== identityId || !(parseInt(b.balance) > 0)) continue;
    const price = drunixTokenPrice(b.assetId);
    const value = parseInt(b.balance) * price; assetsValue += value;
    holdings.push({ assetId: b.assetId, tokens: parseInt(b.balance), tokenPrice: price, valueINR: value, lockedTokens: drunixLockedTokens(b.assetId, identityId) });
  }
  const yieldEarned = Math.round((yieldBalances[identityId] || 0) * 100) / 100;
  let debt = 0; let activeLoans = 0;
  for (const L of Object.values(creditLoans)) if (L.identityId === identityId && L.status === 'ACTIVE') { debt += Math.round(L.principalINR * 1.01 * 100) / 100; activeLoans++; }
  const nav = Math.round((assetsValue + yieldEarned - debt) * 100) / 100;
  return { identityId, asOf: new Date().toISOString(), assetsValueINR: assetsValue, yieldEarnedINR: yieldEarned, outstandingDebtINR: debt, navINR: nav, holdings, activeLoans, method: 'last-trade-price mark', currency: 'INR' };
}
// ========= end programmable ownership module =========

function subscriptionOf(prop) {
  const id = prop.assetId;
  const total = parseInt(prop.totalTokens) || 0;
  const holderList = Object.values(balances).filter(b => b.assetId === id && parseInt(b.balance) > 0);
  const ownerBal = holderList.find(b => b.ownerId === prop.originatorId);
  const availableTokens = ownerBal ? parseInt(ownerBal.balance) : 0;
  const investors = holderList.filter(b => b.ownerId !== prop.originatorId);
  const soldTokens = Math.max(0, Math.min(total, total - availableTokens));
  const fullySubscribed = prop.status === 'TOKENIZED' && total > 0 && availableTokens === 0 && investors.length > 0;
  let completedAt = null;
  if (fullySubscribed) {
    let latest = 0;
    for (const t of Object.values(transfers)) {
      if (t.assetId === id) { const ts = new Date(t.txTimestamp || t.createdAt || 0).getTime(); if (ts > latest) latest = ts; }
    }
    if (latest > 0) completedAt = new Date(latest).toISOString();
  }
  return {
    totalTokens: total, soldTokens, availableTokens,
    percentFunded: total ? Math.round((soldTokens / total) * 100) : 0,
    investorCount: investors.length,
    fullySubscribed,
    phase: prop.status !== 'TOKENIZED' ? (prop.status === 'DRAFT' ? 'draft' : String(prop.status).toLowerCase()) : (fullySubscribed ? 'secondary' : 'primary'),
    completedAt
  };
}

function deletePropertyAuthorized(user, prop, assetId) {
  const role = user.role || user.identityId;
  if (role === 'Regulator') return { allowed: true, reason: 'regulator' };
  // Listing OWNER (identity-gated, any role) — covers registrar-owned listings
  // created before the owner-only gate existed.
  if (prop.originatorId === user.identityId) {
    if (prop.status === 'DRAFT') return { allowed: true, reason: 'draft' };
    // Who besides the owner holds tokens?
    const others = Object.values(balances).filter(b =>
      b.assetId === (prop.assetId || assetId) && b.ownerId !== user.identityId && parseInt(b.balance) > 0);
    if (others.length === 0) return { allowed: true, reason: 'no-investors' };
    const ownerBal = balances[(prop.assetId || assetId) + '~' + user.identityId] || Object.values(balances).find(b => b.assetId === (prop.assetId || assetId) && b.ownerId === user.identityId);
    const have = ownerBal ? parseInt(ownerBal.balance) : 0;
    if (have === 0) return { allowed: true, reason: 'fully-subscribed' };
    return { allowed: false, message: `Investors already hold tokens on this listing (${others.length} holder${others.length > 1 ? 's' : ''}) — only a Regulator can remove it. Investors keep their tokens. NOTE: your ownership here came from the role at listing time; ask the Regulator to remove mistaken listings.` };
  }
  return { allowed: false, message: `Only the listing owner (${prop.originatorId}) or a Regulator can delete this listing.` };
}

function payuConfig() {
  const key = process.env.PAYU_MERCHANT_KEY || '';
  const salt = process.env.PAYU_SALT || '';
  const base = (process.env.PAYU_BASE_URL || 'https://test.payu.in').replace(/\/$/, '');
  return {
    key, salt, base,
    active: !!(key && salt) && (process.env.NPCI_MODE === 'payu'),
    test: base.includes('test.payu.in')
  };
}
function payuRequestHash(key, txnid, amount, productinfo, firstname, email, udf, salt) {
  return crypto.createHash('sha512').update(
    [key, txnid, amount, productinfo, firstname, email, udf[0], udf[1], udf[2], udf[3], udf[4], '', '', '', '', '', salt].join('|')
  ).digest('hex');
}
function payuResponseHash(salt, status, email, firstname, productinfo, amount, txnid, key, udf) {
  // PayU formula: sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
  // The 6 pipes after `status` = 5 EMPTY slots (udf10..udf6). Verified against docs.payu.in —
  // a previous 4-slot version rejected every real PayU callback (synthetic tests passed
  // because signer and verifier shared the same wrong formula).
  return crypto.createHash('sha512').update(
    [salt, status, '', '', '', '', '', udf[4], udf[3], udf[2], udf[1], udf[0], email, firstname, productinfo, amount, txnid, key].join('|')
  ).digest('hex');
}
function verifyPayUResponse(params, key, salt) {
  const g = (k) => String(params[k] ?? '').trim();
  const udf = [g('udf1'), g('udf2'), g('udf3'), g('udf4'), g('udf5')];
  const want = payuResponseHash(salt, g('status'), g('email'), g('firstname'), g('productinfo'), g('amount'), g('txnid'), key, udf);
  const got = g('hash');
  try {
    return got.length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
  } catch { return false; }
}
// Payments are persisted and replayed by idempotency key, so a checkout built
// before transactionCurrency was added would keep replaying without it and
// keep being rejected by PayU. Backfill any stored checkout on the way out.
function withPayUCurrency(pay) {
  // Only multi-currency merchants accept this field; a plain INR account
  // rejects the transaction outright when it is present. Opt in via
  // PAYU_CURRENCY, which is also what buildPayUCheckout honours.
  const cur = process.env.PAYU_CURRENCY;
  if (cur && pay && pay.payuCheckout && pay.payuCheckout.params &&
      !pay.payuCheckout.params.transactionCurrency) {
    pay.payuCheckout.params.transactionCurrency = cur;
  }
  return pay;
}

function buildPayUCheckout(payu, pay, req, cbBase) {
  const firstname = String(req.payerVpa || 'payer').split('@')[0];
  const email = firstname + '@aasthichain.demo';
  const udf = [req.assetId || '', String(req.tokenAmount || ''), pay.upiTxnId || '', req.payeeVpa || '', req.idemKey || ''];
  const productinfo = req.note || `Buy ${req.tokenAmount} tokens of ${req.assetId}`;
  const amount = Number(req.amountINR).toFixed(2);
  const params = {
    key: payu.key, txnid: pay.paymentId, amount, productinfo, firstname, email,
    phone: '9999999999', vpa: req.payerVpa,
    // Sent ONLY when PAYU_CURRENCY is set. Multi-currency merchants require
    // it; ordinary INR accounts reject the whole transaction when it is
    // present ("Invalid API version for transactionCurrency request").
    ...(process.env.PAYU_CURRENCY ? { transactionCurrency: process.env.PAYU_CURRENCY } : {}),
    // PayU requires ABSOLUTE redirect URLs — derive from request host when not configured
    surl: process.env.PAYU_SURL || (cbBase ? cbBase + '/api/npci/payu/callback' : '/api/npci/payu/callback'),
    furl: process.env.PAYU_FURL || (cbBase ? cbBase + '/api/npci/payu/callback' : '/api/npci/payu/callback'),
    udf1: udf[0], udf2: udf[1], udf3: udf[2], udf4: udf[3], udf5: udf[4]
  };
  // PAYU_PIN_UPI=false → full PayU menu (Cards/Netbanking/Wallets/UPI). Default: pinned UPI (NPCI rail).
  if (process.env.PAYU_PIN_UPI !== 'false') {
    params.pg = 'UPI';
    params.bankcode = 'UPI';
  }
  params.hash = payuRequestHash(payu.key, pay.paymentId, amount, productinfo, firstname, email, udf, payu.salt);
  return { action: payu.base + '/_payment', params };
}
function payuCallbackHtml(pay, base) {
  const paymentId = pay.paymentId, status = pay.status, assetId = pay.assetId;
  // RELEASED means confirmed *and* already settled on the ledger.
  const ok = status === 'CONFIRMED' || status === 'RELEASED';
  const declined = status === 'DECLINED';
  // Return to the property page (SimpleBuyFlow auto-resumes DvP there); wallet as fallback
  const target = assetId ? `${base}/property/${encodeURIComponent(assetId)}?payu=return&paymentId=${encodeURIComponent(paymentId)}` : `${base}/wallet`;
  const row = (k, v, mono) => `<div style="display:flex;justify-content:space-between;gap:24px;padding:7px 0;border-bottom:1px solid #EEF1F5"><span style="color:#8B95A1;font-size:12px">${k}</span><span style="font-weight:700;font-size:12.5px;${mono ? 'font-family:monospace' : ''}">${v}</span></div>`;
  const rows =
    (pay.amountINR ? row('Amount', '₹' + Number(pay.amountINR).toLocaleString('en-IN')) : '') +
    (pay.tokenAmount ? row('Tokens', Number(pay.tokenAmount).toLocaleString('en-IN')) : '') +
    ((pay.utr || pay.utr12) ? row('Bank reference (UTR)', pay.utr12 || pay.utr, true) : '') +
    row('Payment ID', paymentId, true);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=${target}"><title>AasthiChain — Payment ${status}</title></head>` +
    `<body style="font-family:Inter,sans-serif;text-align:center;padding:48px 16px;background:#F7F5F0;color:#1E3A5F">` +
    `<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:28px 24px">` +
    `<div style="font-size:36px">${ok ? '✓' : declined ? '✗' : '…'}</div>` +
    `<h2 style="margin:8px 0 2px">${ok ? 'Payment confirmed' : declined ? 'Payment not completed' : 'Payment pending'}</h2>` +
    `<p style="color:#5A6B7D;font-size:13px;margin:0 0 16px">${ok ? 'Your tokens are being transferred to your wallet.' : declined ? 'No money was taken. You can try again anytime.' : 'We are confirming with the bank — this page updates automatically.'}</p>` +
    `<div style="text-align:left;background:#F9FAFB;border:1px solid #F1F4F8;border-radius:10px;padding:6px 14px;margin-bottom:16px">${rows}</div>` +
    `<p style="font-size:12px;color:#8B95A1;margin:0 0 14px">Returning you to AasthiChain…</p>` +
    `<a href="${target}" style="display:inline-block;background:#1E3A5F;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 22px;border-radius:9px">Return now</a>` +
    `</div></body></html>`;
}
function parsePayUParams(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) return req.body;
  const out = {};
  for (const [k, v] of new URLSearchParams(req._rawPayuBody || '')) out[k] = v;
  return out;
}
function addWebhookAudit(entry) {
  npciWebhooks.unshift(entry);
  npciWebhooks = npciWebhooks.slice(0, 100);
  return entry;
}

// ===== AI & Fraud Detection — JS parity of drunix-gateway/fraud.go (rules-v1) =====
// Same rules, weights and thresholds as the Golang engine so serverless lambdas
// and the Go Drunix gateway reach identical decisions. ML-pluggable (OCP).
const FRAUD_T = { blockScore: 70, reviewScore: 40, highValue: 500000, elevated: 200000,
  structFloor: 180000, structCeil: 200000, structCount: 3, velBlock: 8, velWarn: 5,
  total24h: 1000000, riskyFragments: ['fraud','scam','thief','steal','phish','xxx','darkweb'] };

function computeRiskScore(payment, history) {
  const h = history || { txnCount10m: 0, txnCount24h: 0, totalINR24h: 0, recentINR: [], kycVerified: true };
  const factors = [];
  let score = 0;
  const amt = parseFloat(payment.amountINR) || 0;
  if (amt > FRAUD_T.highValue) { score += 30; factors.push({ code: 'HIGH_VALUE', note: 'high-value transaction', weight: 30 }); }
  else if (amt > FRAUD_T.elevated) { score += 15; factors.push({ code: 'ELEVATED_VALUE', note: 'above usual retail band', weight: 15 }); }
  let band = (h.recentINR || []).filter(a => a > FRAUD_T.structFloor && a <= FRAUD_T.structCeil).length;
  if (amt > FRAUD_T.structFloor && amt <= FRAUD_T.structCeil) band++;
  if (band >= FRAUD_T.structCount) { score += 40; factors.push({ code: 'STRUCTURING_PATTERN', note: band + ' transactions just below reporting band', weight: 40 }); }
  if (h.txnCount10m >= FRAUD_T.velBlock) { score += 70; factors.push({ code: 'VELOCITY_BURST', note: h.txnCount10m + ' payments in 10 minutes', weight: 70 }); }
  else if (h.txnCount10m >= FRAUD_T.velWarn) { score += 40; factors.push({ code: 'VELOCITY_ELEVATED', note: h.txnCount10m + ' payments in 10 minutes', weight: 40 }); }
  if ((h.totalINR24h || 0) + amt > FRAUD_T.total24h) { score += 20; factors.push({ code: 'DAILY_EXPOSURE', note: '24h total would exceed daily cap', weight: 20 }); }
  const vpa = String(payment.payerVpa || '').toLowerCase();
  const frag = FRAUD_T.riskyFragments.find(f => vpa.includes(f));
  if (frag) { score += 40; factors.push({ code: 'RISKY_VPA_PATTERN', note: 'VPA contains phishing-style fragment: ' + frag, weight: 40 }); }
  const payeeLocal = String(payment.payeeVpa || '').split('@')[0].toLowerCase();
  const payerLocal = vpa.split('@')[0];
  if (payeeLocal && payerLocal && payeeLocal === payerLocal && vpa !== String(payment.payeeVpa || '').toLowerCase()) {
    score += 15; factors.push({ code: 'HANDLE_MIMIC', note: 'lookalike handle on different bank', weight: 15 });
  }
  if (h.kycVerified === false) { score += 25; factors.push({ code: 'KYC_NOT_VERIFIED', note: 'payer KYC not verified', weight: 25 }); }
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5 && amt > FRAUD_T.elevated) { score += 10; factors.push({ code: 'ODD_HOURS', note: 'high-value payment 00:00-05:00', weight: 10 }); }
  score = Math.max(0, Math.min(100, score));
  let bandName = 'LOW', decision = 'APPROVE';
  if (score >= FRAUD_T.blockScore) { bandName = 'HIGH'; decision = 'BLOCK'; }
  else if (score >= FRAUD_T.reviewScore) { bandName = 'MEDIUM'; decision = 'REVIEW'; }
  if (factors.length === 0) factors.push({ code: 'CLEAN', note: 'no risk signals — genuine retail purchase pattern', weight: 0 });
  return { score, band: bandName, decision, factors, model: 'aasthichain-rules-v1 (JS parity of drunix-gateway/fraud.go)' };
}

function payerHistory(payerId, excludePaymentId) {
  const now = Date.now();
  let c10 = 0, c24 = 0, total24 = 0; const recent = [];
  Object.values(npciPayments).forEach(p => {
    if (p.paymentId === excludePaymentId) return;
    if ((p.payerId || '') !== payerId && (p.payerVpa || '').split('@')[0] !== payerId) return;
    if (String(p.status).startsWith('FAILED')) return; // blocked attempts don't feed velocity
    const t = new Date(p.createdAt).getTime();
    if (isNaN(t)) return;
    const age = now - t;
    if (age <= 10 * 60 * 1000) c10++;
    if (age <= 24 * 3600 * 1000) { c24++; total24 += parseFloat(p.amountINR) || 0; recent.push(parseFloat(p.amountINR) || 0); }
  });
  const kyc = kycRecords[payerId] || kycRecords[String(payerId).toLowerCase()];
  return { txnCount10m: c10, txnCount24h: c24, totalINR24h: total24, recentINR: recent.slice(0, 10), kycVerified: !kyc || kyc.kycStatus === 'VERIFIED' };
}


app.get('/api/npci/config', (req, res) => {
  res.json({
    rail: 'UPI Collect (P2M)',
    description: 'Payee requests money from payer VPA — NPCI switch routes to payer PSP — payer approves in UPI app — IMPS settles with UTR',
    currency: 'INR',
    vpaFormat: 'handle@aasthichain (fictitious test handles only)',
    idFormats: { paymentId: 'NPCI-XXXXXXXXXXXX', upiTxnId: 'AASTYYYYMMDDXXXXXXXX', rrn: '12-digit starting 418', utr: '12-digit bank UTR' },
    expiry: '5 minutes',
    statusFlow: 'PENDING → CONFIRMED → RELEASED / REFUNDED / DECLINED / EXPIRED',
    settlement: 'NPCI Drunix — escrow release triggers Fabric token transfer (DvP), drunixTransferId on payment',
    isSimulation: true,
    failureModes: ['INSUFFICIENT_FUNDS', 'KYC_NOT_VERIFIED', 'TIMEOUT', 'DECLINED', 'INVALID_VPA', 'DUPLICATE_IDEMPOTENCY']
  });
});

app.get('/api/drunix/info', (req, res) => {
  res.json({
    platform: 'NPCI Drunix — NPCI open-source blockchain for tokenization (Hyperledger Fabric enterprise fork)',
    tokenization: 'Real-world assets as fractional tokens on Drunix-compatible Fabric chaincode (chaincode/ Go contracts: property.go, token.go, kyc.go)',
    settlement: 'UPI Collect escrow → payment CONFIRMED (UTR) → Drunix Transfer (token DvP) → escrow RELEASED — atomic, no partial settlement',
    settlementRef: 'drunixTransferId on each payment record',
    upiHandles: 'payerVpa/payeeVpa mapped to Drunix identities for T+0 settlement',
    license: 'Apache 2.0 (Drunix), chaincode follows Fabric contract-api'
  });
});

app.post('/api/npci/collect', authMiddleware, (req, res) => {
  const { assetId, tokenAmount, amountINR, payerVpa, payeeVpa, note, payerId, payeeId } = req.body || {};
  const idemKey = req.headers['x-idempotency-key'] || '';
  if (idemKey && npciIdem[idemKey]) return res.json(withPayUCurrency(npciIdem[idemKey]));
  if (!assetId) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'assetId required' });
  const amt = parseFloat(amountINR);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'FAILED_INVALID_AMOUNT', message: 'amountINR must be > 0 in INR' });
  if (!isValidVPA(payerVpa)) return res.status(400).json({ error: 'FAILED_INVALID_VPA', message: `Invalid payerVpa ${payerVpa}` });
  if (!isValidVPA(payeeVpa)) return res.status(400).json({ error: 'FAILED_INVALID_VPA', message: `Invalid payeeVpa ${payeeVpa}` });
  if (payerVpa.toLowerCase() === payeeVpa.toLowerCase()) return res.status(400).json({ error: 'FAILED_SELF_TRANSFER', message: 'payer and payee VPA cannot be same' });
  if (!tokenAmount || parseInt(tokenAmount) <= 0) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'tokenAmount must be > 0' });
  // Supply guard: never accept money for tokens that no longer exist
  const propSupply = properties[assetId];
  if (propSupply) {
    const sub = subscriptionOf(propSupply);
    if (sub.fullySubscribed) {
      return res.status(400).json({ error: 'ERR_FULLY_SUBSCRIBED', message: `All ${sub.totalTokens} tokens are owned — primary sale closed. Wallet-to-wallet secondary transfers remain available.`, subscription: sub });
    }
    if (parseInt(tokenAmount) > sub.availableTokens) {
      return res.status(400).json({ error: 'ERR_INSUFFICIENT_SUPPLY', message: `Only ${sub.availableTokens} of ${sub.totalTokens} tokens remain`, subscription: sub });
    }
  }

  const payeeKycId = payeeId || 'originator1';
  const payeeKyc = kycRecords[payeeKycId] || kycRecords[payeeKycId.toLowerCase()];
  if (payeeKyc && payeeKyc.kycStatus !== 'VERIFIED') {
    const paymentId = genPaymentID();
    const rrn = genRRN();
    const pay = {
      paymentId, upiTxnId: genUpiTxnID(), rrn, utr: genUTRRealistic().utr12,
      assetId, tokenAmount: parseInt(tokenAmount), amountINR: amt, amountINRPaise: Math.round(amt * 100),
      payerVpa: payerVpa.toLowerCase(), payeeVpa: payeeVpa.toLowerCase(), note: note || '',
      status: 'FAILED_KYC_NOT_VERIFIED', failureReason: `payee ${payeeKycId} KYC not verified`,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      isSimulation: true, payerId: payerId || 'investor1', payeeId: payeeKycId
    };
    npciPayments[paymentId] = pay;
    if (idemKey) npciIdem[idemKey] = pay;
    return res.status(400).json(pay);
  }

  const paymentId = genPaymentID();
  const rrnPlaceholder = genRRN();
  const utrGen = genUTRRealistic();
  const now = new Date();
  const pay = {
    paymentId, upiTxnId: genUpiTxnID(),
    rrn: null, utr: null, utr12: null, utrImps: null,
    rrnPlaceholder, utrPlaceholder: utrGen.utrImps,
    assetId, tokenAmount: parseInt(tokenAmount), amountINR: amt, amountINRPaise: Math.round(amt * 100),
    payerVpa: payerVpa.toLowerCase(), payeeVpa: payeeVpa.toLowerCase(),
    note: note || `Payment for ${tokenAmount} tokens of ${assetId}`,
    status: 'PENDING', createdAt: now, expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    confirmedAt: null, releasedAt: null, drunixTransferId: null,
    idempotencyKey: idemKey, isSimulation: true,
    // Owner comes from the caller, not the body: it used to default to
    // investor1, so someone else's purchase credited the wrong wallet.
    payerId: paymentOwner(req.user, payerId), payeeId: payeeId || 'originator1',
    callbackReceived: false, provider: 'mock', webhookReceivedAt: null
  };
  // AI & Fraud Detection screen (parity with drunix-gateway/fraud.go, Golang)
  pay.risk = computeRiskScore(pay, payerHistory(pay.payerId, pay.paymentId));
  if (pay.risk.decision === 'BLOCK') {
    pay.status = 'FAILED_FRAUD_BLOCKED';
    pay.failureReason = 'Blocked by fraud engine: ' + pay.risk.factors.map(f => f.code).join(', ');
    npciPayments[paymentId] = pay;
    return res.status(403).json(pay);
  }
  // PayU test-mode bridge (additive): real PSP checkout form attached to PENDING payment
  const payu = payuConfig();
  if (payu.active) {
    pay.provider = 'payu';
    pay.payuTestMode = payu.test;
    pay.isSimulation = payu.test;
    pay.payuCheckout = buildPayUCheckout(payu, pay, { assetId, tokenAmount, amountINR: amt, payerVpa, payeeVpa, note, idemKey }, payuPublicBase(req));
  }
  npciPayments[paymentId] = pay;
  if (idemKey) npciIdem[idemKey] = pay;
  res.status(201).json(pay);
});

// ===== PayU callback (surl/furl) — browser-redirect POST, form-urlencoded =====
app.all('/api/npci/payu/callback', (req, res) => {
  const payu = payuConfig();
  if (!payu.active) return res.status(400).send('<html><body><h3>PayU bridge not active</h3></body></html>');
  const params = parsePayUParams(req);
  const g = (k) => String(params[k] ?? '').trim();
  if (!g('txnid')) return res.status(400).send('<html><body><h3>txnid missing</h3></body></html>');
  if (!verifyPayUResponse(params, payu.key, payu.salt)) {
    addWebhookAudit({ webhookId: `payu-hashfail-${Date.now()}`, paymentId: g('txnid'), status: g('status'), provider: 'payu', timestamp: new Date(), result: 'HASH_MISMATCH', raw: params });
    return res.status(403).send('<html><body><h3>✗ Hash verification failed — payload rejected</h3></body></html>');
  }
  const pay = npciPayments[g('txnid')];
  if (!pay) return res.status(404).send('<html><body><h3>Payment not found</h3></body></html>');
  const webhookId = `payu~${g('txnid')}~${g('status')}~${g('mihpayid')}`;
  if (npciIdem[webhookId]) return res.status(200).send(payuCallbackHtml(pay, payuPublicBase(req)));
  const amtPayu = parseFloat(g('amount'));
  if (!isNaN(amtPayu) && Math.abs(amtPayu - pay.amountINR) > 0.01) {
    pay.status = 'FAILED_AMOUNT_MISMATCH';
    pay.failureReason = `Amount mismatch: expected ₹${pay.amountINR} got ₹${amtPayu} — manual review required`;
    pay.callbackData = params; pay.provider = 'payu'; pay.webhookReceivedAt = new Date();
    return res.status(200).send(payuCallbackHtml(pay, payuPublicBase(req)));
  }
  const statusLower = g('status').toLowerCase();
  if (statusLower === 'success' && pay.status === 'PENDING') {
    pay.status = 'CONFIRMED';
    pay.payuId = g('mihpayid');
    if (g('bank_ref_num')) { pay.utr = g('bank_ref_num'); pay.utr12 = g('bank_ref_num'); pay.rrn = g('bank_ref_num'); pay.utrPlaceholder = null; pay.rrnPlaceholder = null; }
    pay.confirmedAt = new Date();
    pay.callbackReceived = true;
    pay.failureReason = null;
  } else if (statusLower === 'failure' && pay.status === 'PENDING') {
    pay.status = 'DECLINED';
    pay.failureReason = 'PayU: ' + (g('error_Message') || g('field9') || 'declined at PayU (test fail VPA)');
    pay.callbackReceived = true;
  }
  pay.provider = 'payu';
  pay.webhookReceivedAt = new Date();
  npciIdem[webhookId] = pay;
  npciPayments[pay.paymentId] = pay;
  addWebhookAudit({ webhookId, paymentId: pay.paymentId, status: pay.status, rrn: pay.rrn, utr: pay.utr, provider: 'payu', amount: pay.amountINR, timestamp: new Date(), result: 'OK', raw: params });
  // Settle here rather than waiting for the browser to come back and drive
  // it. PayU has taken the money by now; if the tab is closed or the return
  // trip fails the tokens would never move and nothing would reach the
  // ledger. settleConfirmedPayment is idempotent, so a later browser-driven
  // settle is harmless.
  if (pay.status === 'CONFIRMED') {
    settleConfirmedPayment(pay)
      .then(r => { if (!r.ok) console.error('payu callback settle refused', pay.paymentId, r.error, r.message); })
      .catch(e => console.error('payu callback settle failed', pay.paymentId, e))
      .finally(() => res.status(200).send(payuCallbackHtml(pay, payuPublicBase(req))));
    return;
  }
  res.status(200).send(payuCallbackHtml(pay, payuPublicBase(req)));
});

// PayU verify_payment S2S reconciliation — heals payments whose browser
// callback was missed or rejected (e.g. hash-formula bug, closed tab).
// Request hash: sha512(key|verify_payment|var1|salt), var1 = txnid.
async function payuVerifyPayment(payu, txnid) {
  const hash = crypto.createHash('sha512').update([payu.key, 'verify_payment', txnid, payu.salt].join('|')).digest('hex');
  const body = new URLSearchParams({ key: payu.key, command: 'verify_payment', var1: txnid, hash }).toString();
  const resp = await fetch(payu.base + '/merchant/postservice.php?form=2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) throw new Error('PayU verify_payment HTTP ' + resp.status);
  return resp.json();
}
async function reconcilePayuPayment(payu, pay) {
  const txnid = pay.paymentId;
  const data = await payuVerifyPayment(payu, txnid);
  const txn = data && data.transaction_details && (data.transaction_details[txnid] || Object.values(data.transaction_details || {})[0]);
  if (!txn) {
    return { reconciled: false, state: pay.status, message: (data && data.msg) || 'PayU has no record for this transaction yet' };
  }
  if (pay.status !== 'PENDING') {
    return { reconciled: false, state: pay.status, message: 'Payment already ' + pay.status + ' — nothing to reconcile' };
  }
  const st = String(txn.status || '').toLowerCase();
  const amtPayu = parseFloat(txn.amount);
  if (!isNaN(amtPayu) && Math.abs(amtPayu - pay.amountINR) > 0.01) {
    pay.status = 'FAILED_AMOUNT_MISMATCH';
    pay.failureReason = `Reconcile amount mismatch: expected ₹${pay.amountINR} got ₹${amtPayu}`;
    pay.webhookReceivedAt = new Date();
    return { reconciled: true, state: pay.status };
  }
  if (st === 'success') {
    pay.status = 'CONFIRMED';
    pay.payuId = String(txn.mihpayid || '');
    if (txn.bank_ref_num) { pay.utr = String(txn.bank_ref_num); pay.utr12 = String(txn.bank_ref_num); pay.rrn = String(txn.bank_ref_num); pay.utrPlaceholder = null; pay.rrnPlaceholder = null; }
    pay.confirmedAt = new Date();
    pay.failureReason = null;
    pay.provider = 'payu';
    pay.webhookReceivedAt = new Date();
    return { reconciled: true, state: pay.status, payuId: pay.payuId, utr: pay.utr };
  }
  if (st === 'failure') {
    pay.status = 'DECLINED';
    pay.failureReason = 'PayU reconcile: ' + (txn.error_message || txn.field9 || 'declined');
    pay.provider = 'payu';
    pay.webhookReceivedAt = new Date();
    return { reconciled: true, state: pay.status };
  }
  return { reconciled: false, state: pay.status, message: 'PayU status: ' + (st || 'unknown') };
}
function payuPublicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8080';
  return `${proto}://${host}`;
}

// PayU S2S reconciliation — heal PENDING PayU payments (missed/rejected callback)
app.post('/api/npci/payu/reconcile', authMiddleware, async (req, res) => {
  const payu = payuConfig();
  if (!payu.active) return res.status(400).json({ error: 'PayU bridge not active' });
  const paymentId = (req.body && req.body.paymentId) || '';
  const pay = paymentId ? npciPayments[paymentId] : null;
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId });
  if (pay.provider !== 'payu') return res.status(400).json({ error: 'Payment is not on the PayU rail', provider: pay.provider });
  try {
    const result = await reconcilePayuPayment(payu, pay);
    if (result.reconciled) addWebhookAudit({ webhookId: `payu-reconcile-${Date.now()}`, paymentId: pay.paymentId, status: pay.status, utr: pay.utr, provider: 'payu-reconcile', timestamp: new Date(), result: 'OK' });
    // Auto-settle: reconciliation CONFIRMed (or payment already CONFIRMed) →
    // complete the purchase server-side. Tokens move now, no browser needed.
    let settle = null;
    if (pay.status === 'CONFIRMED') settle = await settleConfirmedPayment(pay);
    res.json({ paymentId: pay.paymentId, ...result, settle, payment: pay });
  } catch (e) {
    res.status(502).json({ error: 'PayU verify_payment failed', message: e.message });
  }
});

// POST /api/npci/payments/:id/settle — server-side completion of a CONFIRMED purchase
app.post('/api/npci/payments/:id/settle', authMiddleware, async (req, res) => {
  try {
    const pay = npciPayments[req.params.id];
    const result = await settleConfirmedPayment(pay);
    return res.status(result.ok ? 200 : (result.code || 400)).json(result);
  } catch (e) {
    return res.status(500).json({ error: 'ERR_SETTLE_FAILED', message: e.message });
  }
});

// DELETE /api/properties/:id — originator (draft or fully-subscribed) / regulator (any)
app.delete('/api/properties/:id', authMiddleware, (req, res) => {
  const assetId = req.params.id;
  const prop = properties[assetId] || Object.values(properties).find(x => x.assetId === assetId);
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND', assetId });
  const check = deletePropertyAuthorized(req.user, prop, assetId);
  if (!check.allowed) return res.status(403).json({ error: 'ERR_DELETE_NOT_ALLOWED', message: check.message });
  delete properties[prop.assetId || assetId];
  if (prop.assetId && prop.assetId !== assetId) delete properties[assetId];
  console.log(`[DELETE] property ${assetId} removed by ${req.user.identityId} (${check.reason})`);
  res.json({ deleted: true, assetId, deletedBy: req.user.identityId, reason: check.reason, note: 'Investors keep their tokens — only the marketplace listing is removed. Ledger history is preserved.' });
});

// Drunix transaction flow for a payment (FAQ 14 demo: Drunix Transaction Flow)
// The settlement trace spells out the VPAs, the UTR, the RRN and the fraud
// score of whichever payment you name — and with no paymentId it used to
// default to the newest payment on the platform, whoever it belonged to.
app.get('/api/drunix/ledger', authMiddleware, (req, res) => {
  const visible = paymentsVisibleTo(req.user);
  const pay = req.query.paymentId
    ? npciPayments[req.query.paymentId]
    : visible.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId: req.query.paymentId });
  if (!visible.some(p => p.paymentId === pay.paymentId)) {
    return res.status(403).json({ error: 'ERR_NOT_YOUR_PAYMENT', message: `Payment ${pay.paymentId} belongs to someone else.` });
  }
  const crypto = require('crypto');
  const txId = crypto.createHash('sha256').update(`aasthichain|SettleDvP|${pay.paymentId}|${pay.drunixTransferId || pay.utr || ''}`).digest('hex');
  const pseudoBlock = 100 + (parseInt(txId.slice(0, 6), 16) % 90000);
  const stages = [
    { stage: 1, name: 'UPI Collect', network: 'NPCI UPI (off-chain trigger)', detail: `${pay.paymentId} — ₹${pay.amountINR} from ${pay.payerVpa}`, status: ['PENDING', 'CONFIRMED', 'RELEASED'].includes(pay.status) ? 'DONE' : (String(pay.status).startsWith('FAILED') ? 'FAILED' : 'PENDING') },
    { stage: 2, name: 'AI Fraud Screen', network: 'aasthichain-rules-v1 (Go engine, JS parity)', detail: pay.risk ? `${pay.risk.decision} — score ${pay.risk.score}/100 (${pay.risk.factors.map(f => f.code).join(', ')})` : 'not screened', status: pay.risk ? 'DONE' : 'PENDING' },
    { stage: 3, name: 'Escrow Confirmed (UTR)', network: 'NPCI UPI / IMPS', detail: pay.utr ? `UTR ${pay.utr} · RRN ${pay.rrn}` : 'awaiting approval', status: pay.utr ? 'DONE' : 'PENDING' },
    { stage: 4, name: 'Drunix Proposal + Endorsement', network: 'NPCI Drunix (Fabric fork)', detail: `chaincode aasthichain · SettleDvP(${pay.paymentId}, ${pay.utr || 'UTR'}, ${pay.assetId.slice(0, 20)}...)`, status: pay.drunixTransferId ? 'DONE' : 'PENDING' },
    { stage: 5, name: 'Drunix Commit', network: 'NPCI Drunix — block ' + pseudoBlock, detail: 'txId ' + txId.slice(0, 24) + '… · validationCode 0 (VALID)', status: pay.drunixTransferId ? 'DONE' : 'PENDING' },
    { stage: 6, name: 'Chaincode Event', network: 'NPCI Drunix', detail: 'SettlementRecorded — regulator + payment ops subscribe', status: pay.drunixTransferId ? 'DONE' : 'PENDING' },
    { stage: 7, name: 'Escrow Released (DvP complete)', network: 'NPCI UPI escrow', detail: pay.drunixTransferId ? `atomic settlement ${pay.drunixTransferId}` : 'tokens transfer then release', status: pay.status === 'RELEASED' ? 'DONE' : 'PENDING' }
  ];
  res.json({
    paymentId: pay.paymentId,
    mode: process.env.DRUNIX_GATEWAY_URL ? 'remote-go-gateway' : 'embedded-simulation (Go source: drunix-gateway/ — Golang)',
    language: 'golang',
    channel: 'aasthichain',
    stages,
    settlement: { txId, block: pseudoBlock, chaincodeEvent: 'SettlementRecorded', drunixTransferId: pay.drunixTransferId || null }
  });
});

app.get('/api/fraud/config', authMiddleware, (req, res) => {
  res.json({ model: 'aasthichain-rules-v1 (ML-pluggable)', thresholds: FRAUD_T, sourceOfTruth: 'drunix-gateway/fraud.go (Golang)', theme: 'AI & Fraud Detection' });
});

app.get('/api/openfinance/capabilities', authMiddleware, (req, res) => {
  res.json({
    theme: 'Open Finance APIs',
    apis: [
      { name: 'NPCI UPI Collect', endpoint: '/api/npci/collect', auth: 'Bearer JWT', status: 'live' },
      { name: 'UTR Reconciliation Lookup', endpoint: '/api/npci/utr/:utr', auth: 'Bearer JWT', status: 'live' },
      // Report the auth that is actually in force, not the one we wish for.
      { name: 'Bank Webhooks', endpoint: '/api/npci/webhook',
        auth: process.env.NPCI_WEBHOOK_SECRET ? 'signature (HMAC-SHA256)' : 'Bearer JWT — payment owner only; set NPCI_WEBHOOK_SECRET for signature auth',
        status: 'live' },
      { name: 'Drunix Ledger Flow', endpoint: '/api/drunix/ledger?paymentId=', auth: 'Bearer JWT', status: 'live' },
      { name: 'Fraud Scoring', endpoint: '/api/fraud/config', auth: 'Bearer JWT', status: 'live' },
      { name: 'Property Data (Bhoomi/Dharani)', endpoint: '/api/properties/:id/verify', auth: 'Bearer JWT', status: 'live' },
      { name: 'KYC — DigiLocker', endpoint: '/api/kyc/digilocker/init', auth: 'Bearer JWT', status: 'live' },
      { name: 'Drunix Gateway (Golang)', endpoint: 'http://localhost:21100 (DRUNIX_GATEWAY_URL)', auth: 'internal', status: 'optional remote' }
    ]
  });
});

// Reading one payment has been owner-checked for a while, but the list
// handed every signed-in user everyone else's payments: counterparties,
// amounts, VPAs and UTRs.
function paymentsVisibleTo(user) {
  const all = Object.values(npciPayments);
  if (SUPERVISORY.has(String(user.role || '').toLowerCase())) return all;
  return all.filter(p => p.payerId === user.identityId || p.payeeId === user.identityId);
}

app.get('/api/npci/payments', authMiddleware, (req, res) => {
  const list = paymentsVisibleTo(req.user)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, parseInt(req.query.limit) || 20);
  res.json({ payments: list, count: list.length });
});

app.get('/api/npci/payments/:id', authMiddleware, (req, res) => {
  const pay = npciPayments[req.params.id];
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId: req.params.id });
  if (pay.status === 'PENDING' && new Date() > new Date(pay.expiresAt)) {
    pay.status = 'EXPIRED';
    pay.failureReason = 'collect request expired after 5 min';
    npciPayments[pay.paymentId] = pay;
  }
  res.json(pay);
});

// Self-heal for serverless multi-instance races — client re-uploads payment state it already holds
app.post('/api/npci/payments/:id/reattach', authMiddleware, (req, res) => {
  const p = req.body && req.body.payment;
  const id = req.params.id;
  if (!p || p.paymentId !== id) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'body.payment.paymentId must match URL id' });
  if (!(parseFloat(p.amountINR) > 0)) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'amountINR must be > 0' });
  const created = new Date(p.createdAt);
  if (isNaN(created) || (Date.now() - created.getTime()) > 24 * 3600 * 1000) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'payment too old or invalid createdAt' });
  const existing = npciPayments[id];
  if (existing) return res.json({ reattached: false, payment: existing, message: 'payment already on server' });
  npciPayments[id] = p;
  if (p.idempotencyKey && !npciIdem[p.idempotencyKey]) npciIdem[p.idempotencyKey] = p;
  res.status(201).json({ reattached: true, payment: p });
});

app.post('/api/npci/payments/:id/approve', authMiddleware, (req, res) => {
  const pay = npciPayments[req.params.id];
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId: req.params.id });
  if (pay.status !== 'PENDING') return res.status(400).json({ error: `Payment not in PENDING, current ${pay.status}`, payment: pay });
  if (new Date() > new Date(pay.expiresAt)) {
    pay.status = 'EXPIRED';
    pay.failureReason = 'expired';
    npciPayments[pay.paymentId] = pay;
    return res.status(400).json({ error: 'EXPIRED', payment: pay });
  }
  const payerId = (req.body && req.body.payerId) || pay.payerId || 'investor1';
  const kyc = kycRecords[payerId] || kycRecords[payerId.toLowerCase()] || kycRecords[pay.payerId];
  if (kyc && kyc.kycStatus !== 'VERIFIED') {
    pay.status = 'FAILED_KYC_NOT_VERIFIED';
    pay.failureReason = `payer ${payerId} KYC not verified`;
    npciPayments[pay.paymentId] = pay;
    return res.status(400).json(pay);
  }
  // AI & Fraud Detection re-screen at approval (before any money movement)
  const riskAtApprove = computeRiskScore(pay, payerHistory(payerId, pay.paymentId));
  pay.risk = riskAtApprove;
  if (riskAtApprove.decision === 'BLOCK') {
    pay.status = 'FAILED_FRAUD_BLOCKED';
    pay.failureReason = 'Blocked by fraud engine at approval: ' + riskAtApprove.factors.map(f => f.code).join(', ');
    npciPayments[pay.paymentId] = pay;
    return res.status(403).json(pay);
  }
  const vpaLower = pay.payerVpa.toLowerCase();
  const bal = npciBalances[vpaLower] !== undefined ? npciBalances[vpaLower] : 100000000;
  if (bal < pay.amountINRPaise) {
    pay.status = 'FAILED_INSUFFICIENT_FUNDS';
    pay.failureReason = `insufficient funds: have ₹${(bal / 100).toFixed(2)} need ₹${pay.amountINR}`;
    npciPayments[pay.paymentId] = pay;
    return res.status(400).json(pay);
  }
  npciBalances[vpaLower] = bal - pay.amountINRPaise;
  pay.status = 'CONFIRMED';
  pay.confirmedAt = new Date();
  pay.callbackReceived = true;
  pay.payerId = payerId;
  const utrReal = genUTRRealistic();
  if (!pay.rrn) pay.rrn = utrReal.rrn;
  if (!pay.utr) {
    pay.utr = utrReal.utr;
    pay.utr12 = utrReal.utr12;
    pay.utrImps = utrReal.utrImps;
  }
  // Index every alias unconditionally — PayU payments arrive with their own
  // utr/rrn from the callback and must be UTR-lookup-able too (parity with Vercel).
  utrIndex[pay.utr] = pay.paymentId;
  if (pay.utr12) utrIndex[pay.utr12] = pay.paymentId;
  if (pay.utrImps) utrIndex[pay.utrImps] = pay.paymentId;
  if (pay.rrn) utrIndex[pay.rrn] = pay.paymentId;
  pay.webhookReceivedAt = new Date();
  npciPayments[pay.paymentId] = pay;
  addWebhookAudit({
    webhookId: `wh-${Date.now()}-${pay.paymentId}`,
    paymentId: pay.paymentId, status: 'CONFIRMED', rrn: pay.rrn, utr: pay.utr,
    provider: 'mock', amount: pay.amountINR, timestamp: new Date(), result: 'PAYMENT_CONFIRMED'
  });
  res.json(pay);
});

app.post('/api/npci/payments/:id/release', authMiddleware, async (req, res) => {
  const pay = npciPayments[req.params.id];
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId: req.params.id });
  if (pay.status !== 'CONFIRMED') return res.status(400).json({ error: `Must be CONFIRMED before release, current ${pay.status}`, payment: pay });
  const drunixTransferId = req.body && req.body.drunixTransferId;
  if (!drunixTransferId) return res.status(400).json({ error: 'drunixTransferId required' });
  pay.status = 'RELEASED';
  pay.releasedAt = new Date();
  pay.drunixTransferId = drunixTransferId;
  npciPayments[pay.paymentId] = pay;
  const payeeVpa = pay.payeeVpa.toLowerCase();
  npciBalances[payeeVpa] = (npciBalances[payeeVpa] || 0) + pay.amountINRPaise;
  const tr = transfers[drunixTransferId];
  const rail = await railCommitForReleasedPayment(pay);
  if (tr && pay.umiInstructionId) { tr.umiInstructionId = pay.umiInstructionId; tr.umiIsin = pay.umiIsin; }
  res.json({ ...pay, rail });
});

app.post('/api/npci/rail/backfill', async (req, res) => {
  const key = (process.env.ADMIN_DASHBOARD_KEY || '').trim();
  if (!key || (req.headers['x-admin-key'] || '') !== key) return res.status(401).json({ error: 'ERR_ADMIN_KEY', message: 'x-admin-key required' });
  const pending = Object.values(npciPayments)
    .filter(p => p.status === 'RELEASED' && !p.umiInstructionId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const results = [];
  for (const pay of pending) {
    const rail = await railCommitForReleasedPayment(pay);
    const tr = pay.drunixTransferId && transfers[pay.drunixTransferId];
    if (tr && pay.umiInstructionId) { tr.umiInstructionId = pay.umiInstructionId; tr.umiIsin = pay.umiIsin; }
    results.push({ paymentId: pay.paymentId, instructionId: pay.umiInstructionId || null, rail });
  }
  const onChain = results.filter(r => r.instructionId).length;
  res.json({ considered: pending.length, committed: onChain, skipped: pending.length - onChain, results });
});

app.post('/api/npci/payments/:id/refund', authMiddleware, (req, res) => {
  const pay = npciPayments[req.params.id];
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId: req.params.id });
  if (!['PENDING', 'CONFIRMED', 'FAILED_INSUFFICIENT_FUNDS', 'FAILED_KYC_NOT_VERIFIED', 'EXPIRED', 'DECLINED'].includes(pay.status)) {
    return res.status(400).json({ error: `Cannot refund from ${pay.status}` });
  }
  if (pay.status === 'CONFIRMED') {
    const vpaLower = pay.payerVpa.toLowerCase();
    npciBalances[vpaLower] = (npciBalances[vpaLower] || 0) + pay.amountINRPaise;
  }
  pay.status = 'REFUNDED';
  pay.failureReason = (req.body && req.body.reason) || 'refunded';
  npciPayments[pay.paymentId] = pay;
  res.json(pay);
});

app.post('/api/npci/payments/:id/decline', authMiddleware, (req, res) => {
  const pay = npciPayments[req.params.id];
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId: req.params.id });
  if (pay.status !== 'PENDING') return res.status(400).json({ error: `Not pending, current ${pay.status}` });
  pay.status = 'DECLINED';
  pay.failureReason = (req.body && req.body.reason) || 'user declined in UPI app';
  npciPayments[pay.paymentId] = pay;
  res.json(pay);
});

// UTR verification is a public certificate surface: read-only, keyed by an
// unguessable UTR, no PII — anyone holding the reference can verify it
// (same open-layer policy as /api/chain/*).
function optionalAuth(req, res, next) {
  if (req.headers.authorization) return authMiddleware(req, res, next);
  req.user = { identityId: 'public', mspId: 'PublicMSP', role: 'Public' };
  next();
}
// UTR lookup: browsers get a verification certificate, API clients get JSON
function utrVerifyRespond(req, res, utr, pay, payload, errCode) {
  const wantsHtml = String(req.headers.accept || '').includes('text/html') && req.query.format !== 'json';
  if (!wantsHtml || !pay) {
    if (payload) return res.json(payload);
    return res.status(404).json({ error: errCode || 'UTR not found', utr });
  }
  const row = (k, v, mono) => `<tr><td style="padding:9px 0;color:#64748B;font-size:12.5px;white-space:nowrap;padding-right:24px">${k}</td><td style="padding:9px 0;font-weight:700;font-size:13px;color:#0F172A;text-align:right;${mono ? 'font-family:monospace' : ''}">${v}</td></tr>`;
  const settled = pay.status === 'RELEASED';
  const dt = (t) => t ? new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Payment Verification ${utr}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;font-family:Inter,Arial,sans-serif;background:#F7F5F0;padding:32px 12px">` +
    `<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden">` +
    `<div style="background:#1E3A5F;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center">` +
    `<div><div style="font-size:15px;font-weight:800;letter-spacing:.02em">AasthiChain</div><div style="font-size:10.5px;opacity:.75;letter-spacing:.14em">PAYMENT VERIFICATION</div></div>` +
    `<div style="background:${settled ? '#63BE94' : '#D9A85C'};color:#0A1422;font-size:10px;font-weight:800;padding:5px 10px;border-radius:999px">${settled ? '✓ VERIFIED · SETTLED' : 'PENDING'}</div></div>` +
    `<div style="padding:20px 24px">` +
    `<div style="font-size:11px;color:#94A3B8;font-weight:700;letter-spacing:.1em;margin-bottom:2px">BANK REFERENCE (UTR)</div>` +
    `<div style="font-family:monospace;font-size:15px;font-weight:800;color:#1E3A5F;word-break:break-all">${utr}</div>` +
    `<table style="width:100%;border-collapse:collapse;margin-top:12px">` +
    row('Amount', '₹' + Number(pay.amountINR || 0).toLocaleString('en-IN')) +
    row('Tokens', Number(pay.tokenAmount || 0).toLocaleString('en-IN')) +
    row('Status', pay.status) +
    row('Paid from', pay.payerVpa || '—', true) +
    row('Paid to', pay.payeeVpa || '—', true) +
    row('Provider', (pay.provider === 'payu' ? 'PayU' : 'NPCI mock rail') + (pay.payuTestMode || pay.isSimulation ? ' · test mode, no real money' : '')) +
    row('Confirmed at', dt(pay.confirmedAt)) +
    row('Released at', dt(pay.releasedAt)) +
    row('Drunix ledger TXN', pay.drunixTransferId || '—', true) +
    `</table>` +
    `<div style="margin-top:14px;padding:10px 12px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;font-size:11px;color:#065F46;line-height:1.6">` +
    `This certificate reflects the committed state of the Aasthi Drunix hash-chained ledger at the time of verification. Amount, tokens and ownership moved together atomically.</div>` +
    (pay.drunixTransferId ? `<a href="/ledger?tx=${encodeURIComponent(pay.drunixTransferId)}" style="display:block;text-align:center;margin-top:14px;background:#1E3A5F;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 20px;border-radius:9px">View this transfer in the Ledger Explorer →</a>` : '') +
    `<div style="text-align:center;font-size:10px;color:#94A3B8;margin-top:12px">Machine-readable copy: append <code>?format=json</code></div>` +
    `</div></div></body></html>`;
  res.status(200).send(html);
}
app.get('/api/npci/utr/:utr', optionalAuth, (req, res) => {
  let pay = utrIndex[req.params.utr] ? npciPayments[utrIndex[req.params.utr]] : null;
  if (!pay) pay = Object.values(npciPayments).find(p => p.utr === req.params.utr || p.utr12 === req.params.utr || p.utrImps === req.params.utr || p.rrn === req.params.utr);
  if (!pay) return utrVerifyRespond(req, res, req.params.utr, null, null, 'UTR not found');
  utrVerifyRespond(req, res, req.params.utr, pay, { utr: req.params.utr, paymentId: pay.paymentId, status: pay.status, amountINR: pay.amountINR, rrn: pay.rrn, upiTxnId: pay.upiTxnId, confirmedAt: pay.confirmedAt, releasedAt: pay.releasedAt, drunixTransferId: pay.drunixTransferId, payment: pay });
});

// UTRReconciliation.jsx reads summary/issues/recentWebhooks. This route used to
// answer with a different vocabulary entirely (total/byStatus/reconciliationRate),
// so the dashboard rendered zeros against the local server and real figures
// against the deployed one — the opposite way round from the usual drift, and
// the reason it went unnoticed: nobody checks a dev-only page for being wrong.
app.get('/api/npci/reconcile', authMiddleware, (req, res) => {
  const all = Object.values(npciPayments);
  const now = new Date();
  const pendingWithoutUTR = all.filter(p => p.status === 'CONFIRMED' && !p.utr);
  const amountMismatches = all.filter(p => p.status === 'FAILED_AMOUNT_MISMATCH');
  const pendingTooLong = all.filter(p => p.status === 'PENDING' && (now - new Date(p.createdAt)) > 5 * 60 * 1000);
  const failedProvider = all.filter(p => p.status === 'FAILED_PROVIDER');
  const success = all.filter(p => ['CONFIRMED', 'RELEASED'].includes(p.status));
  const totalVolume = success.reduce((sum, p) => sum + (p.amountINR || 0), 0);
  const successRate = all.length ? (success.length / all.length * 100).toFixed(1) : 0;
  const utrCount = Object.keys(utrIndex).length;
  const paymentsWithUTR = all.filter(p => !!p.utr).length;
  const ageMin = p => Math.floor((now - new Date(p.createdAt)) / 60000);

  res.json({
    summary: {
      totalPayments: all.length,
      successCount: success.length,
      pendingCount: all.filter(p => p.status === 'PENDING').length,
      failedCount: all.filter(p => String(p.status).startsWith('FAILED')).length,
      totalVolumeINR: totalVolume,
      successRate: `${successRate}%`,
      utrCoverage: `${paymentsWithUTR}/${all.length} payments have UTR (${utrCount} in index)`,
      webhookCount: npciWebhooks.length,
    },
    issues: {
      pendingWithoutUTR: pendingWithoutUTR.map(p => ({ paymentId: p.paymentId, assetId: p.assetId, amountINR: p.amountINR, createdAt: p.createdAt, ageMin: ageMin(p) })),
      amountMismatches: amountMismatches.map(p => ({ paymentId: p.paymentId, expected: p.amountINR, failureReason: p.failureReason, createdAt: p.createdAt })),
      pendingTooLong: pendingTooLong.map(p => ({ paymentId: p.paymentId, assetId: p.assetId, amountINR: p.amountINR, createdAt: p.createdAt, ageMin: ageMin(p) })),
      failedProvider: failedProvider.map(p => ({ paymentId: p.paymentId, failureReason: p.failureReason, provider: p.provider })),
    },
    // addWebhookAudit() unshifts here, so the newest are already at the front.
    recentWebhooks: npciWebhooks.slice(0, 20),
    utrIndexSample: Object.entries(utrIndex).slice(-10).map(([utr, pid]) => ({ utr, paymentId: pid })),
    note: 'For Regulator — per §3.5 monitoring, freeze if needed. UTR reconciliation ensures bank statement matches our ledger — no partial, atomic DvP.',
  });
});

app.post('/api/npci/webhook', authMiddleware, (req, res) => {
  const raw = req.body || {};
  const paymentId = raw.paymentId || raw.referenceId || raw.merchantTxnId || raw.transactionId;
  const status = String(raw.status || raw.txnStatus || raw.paymentStatus || '').toUpperCase();
  const rrn = raw.rrn || raw.RRN || raw.bankRRN || '';
  const utr = raw.utr || raw.UTR || raw.bankUTR || raw.upiUTR || '';
  const provider = raw.provider || raw.source || 'setu';
  if (!paymentId) return res.status(400).json({ error: 'paymentId or referenceId required' });
  const pay = npciPayments[paymentId];
  if (!pay) {
    addWebhookAudit({ webhookId: `wh-${Date.now()}-${paymentId}`, paymentId, status, rrn, utr, provider, timestamp: new Date(), result: 'PAYMENT_NOT_FOUND', raw });
    return res.status(404).json({ error: 'Payment not found for webhook', paymentId, provider });
  }
  const webhookId = `${paymentId}~${status}~${utr || rrn || 'no-utr'}`;
  if (npciIdem[webhookId]) {
    return res.json({ received: true, idempotent: true, paymentId, status: pay.status, utr: pay.utr, message: 'Duplicate webhook — already processed, no double credit' });
  }
  npciIdem[webhookId] = true;
  if (status === 'SUCCESS' || status === 'CONFIRMED') {
    if (pay.status === 'PENDING') {
      pay.status = 'CONFIRMED';
      pay.confirmedAt = new Date();
      pay.callbackReceived = true;
      const utrReal = genUTRRealistic();
      if (!pay.rrn && rrn) pay.rrn = rrn; else if (!pay.rrn) pay.rrn = utrReal.rrn;
      if (!pay.utr) {
        pay.utr = utr || utrReal.utr;
        pay.utr12 = pay.utr;
        utrIndex[pay.utr] = pay.paymentId;
        if (pay.rrn) utrIndex[pay.rrn] = pay.paymentId;
      }
      pay.webhookReceivedAt = new Date();
    }
  } else if (['FAILED', 'DECLINED', 'TIMEOUT'].includes(status) && pay.status === 'PENDING') {
    pay.status = status === 'TIMEOUT' ? 'EXPIRED' : 'DECLINED';
    pay.failureReason = `webhook ${status} from ${provider}`;
  }
  npciPayments[paymentId] = pay;
  addWebhookAudit({ webhookId, paymentId, status, rrn, utr: pay.utr, provider, timestamp: new Date(), result: `PAYMENT_${pay.status}` });
  res.json({ received: true, idempotent: false, paymentId, status: pay.status, utr: pay.utr, rrn: pay.rrn });
});

app.post('/api/npci/webhook/test', authMiddleware, (req, res) => {
  const { paymentId } = req.body || {};
  const pay = npciPayments[paymentId];
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId });
  if (pay.status !== 'PENDING') return res.status(400).json({ error: `Webhook test needs PENDING, current ${pay.status}` });
  const utrReal = genUTRRealistic();
  const payload = { paymentId, status: 'SUCCESS', rrn: utrReal.rrn, utr: utrReal.utr12, provider: 'setu-test' };
  pay.status = 'CONFIRMED';
  pay.confirmedAt = new Date();
  pay.rrn = utrReal.rrn;
  pay.utr = utrReal.utr12;
  pay.utr12 = utrReal.utr12;
  pay.utrImps = utrReal.utrImps;
  pay.webhookReceivedAt = new Date();
  pay.callbackReceived = true;
  utrIndex[pay.utr] = paymentId;
  utrIndex[pay.rrn] = paymentId;
  npciPayments[paymentId] = pay;
  addWebhookAudit({ webhookId: `wh-${Date.now()}-${paymentId}`, paymentId, status: 'SUCCESS', rrn: pay.rrn, utr: pay.utr, provider: 'setu-test', timestamp: new Date(), result: 'PAYMENT_CONFIRMED' });
  res.json({ sent: payload, payment: pay, note: 'Simulated bank webhook. No signature is verified unless NPCI_WEBHOOK_SECRET is set; without it only the payment owner may call this.' });
});

// The callback audit trail is a record of other people's payments too.
app.get('/api/npci/webhooks', authMiddleware, (req, res) => {
  const supervising = SUPERVISORY.has(String(req.user.role || '').toLowerCase());
  const mine = new Set(paymentsVisibleTo(req.user).map(p => p.paymentId));
  const list = (supervising ? npciWebhooks : npciWebhooks.filter(w => mine.has(w.paymentId))).slice(0, 50);
  res.json({ webhooks: list, count: list.length });
});

const PORT = process.env.PORT || 8080;

// ---- Drunix chain explorer API — OPEN LAYER (public, read-only, no PII):
// people, agents and DPI stacks verify the ledger without an account ----
app.get('/api/chain', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const head = drunixChain[drunixChain.length - 1] || null;
  res.json({
    chainId: DRUNIX_CHAIN_ID, channel: DRUNIX_CHAIN_ID, hashAlgo: 'SHA-512',
    height: Math.max(0, drunixChain.length - 1), blocks: drunixChain.length,
    head: head ? head.hash : null,
    orgs: DRUNIX_ORGS, contract: 'aasthi.dvp-v1', fabricMode: 'mock',
    blocksList: drunixChain.slice(-limit).reverse().map(b => ({ ...b, txns: b.txns }))
  });
});
app.get('/api/chain/verify', (req, res) => {
  const v = drunixVerify();
  res.json({ ...v, note: v.valid ? 'Recomputed SHA-512 chain + merkle roots from genesis — every block intact.' : 'Any participant (or agent) recomputing the chain detects this. Trust is in the math, not the operator.' });
});
app.get('/api/chain/head', (req, res) => {
  const head = drunixChain[drunixChain.length - 1] || null;
  res.json({ chainId: DRUNIX_CHAIN_ID, height: head ? head.height : -1, head: head ? head.hash : null, blocks: drunixChain.length });
});
app.get('/api/chain/block/:n', (req, res) => {
  const key = req.params.n;
  const b = /^\d+$/.test(key) ? drunixChain[parseInt(key)] : drunixChain.find(x => x.hash === key || (x.txns || []).some(t => Object.values(t).includes(key)));
  if (!b) return res.status(404).json({ error: 'ERR_BLOCK_NOT_FOUND', query: key });
  res.json({ ...b });
});
// Demo-only (SIMULATION label in UI): mutate a committed block, then verify() proves detection.
// Rewriting the ledger is a regulator's demonstration, not an open endpoint:
// these took no credentials at all.
const supervisoryOnly = (req, res) => {
  if (SUPERVISORY.has(String(req.user?.role || '').toLowerCase())) return false;
  res.status(403).json({ error: 'ERR_NOT_REGULATOR', message: 'Only a regulator or admin can tamper with or restore the chain.' });
  return true;
};
app.post('/api/chain/tamper', authMiddleware, (req, res) => {
  if (supervisoryOnly(req, res)) return;
  const height = parseInt(req.body?.height ?? Math.max(1, drunixChain.length - 1));
  const r = drunixTamper(height);
  if (!r) return res.status(400).json({ error: 'ERR_CANNOT_TAMPER', message: 'Pick a committed, non-genesis block' });
  res.json({ simulated: true, warning: 'SIMULATION — demonstrating tamper-evidence', ...r, next: 'GET /api/chain/verify' });
});
app.post('/api/chain/restore', authMiddleware, (req, res) => {
  if (supervisoryOnly(req, res)) return;
  const height = parseInt(req.body?.height ?? -1);
  if (height >= 0) return res.json({ restored: drunixRestore(height), height });
  let n = 0; for (const b of drunixChain) if (b._pristine && drunixRestore(b.height)) n++;
  res.json({ restoredBlocks: n, next: 'GET /api/chain/verify' });
});


// ---- Programmable ownership API: continuous NAV, yield servicing, governance, credit, swaps ----
app.get('/api/portfolio/:identityId/nav', authMiddleware, (req, res) => {
  res.json(drunixNav(req.params.identityId));
});

app.post('/api/properties/:id/yield/distribute', authMiddleware, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  if (prop.originatorId !== req.user.identityId && req.user.role !== 'Regulator') return res.status(403).json({ error: 'ERR_NOT_ALLOWED', message: 'Only the listing owner or a Regulator can distribute yield' });
  const amount = Math.round(parseFloat(req.body.amountINR) * 100) / 100;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'ERR_INVALID_AMOUNT', message: 'amountINR must be > 0' });
  const holders = Object.values(balances).filter(b => b.assetId === req.params.id && parseInt(b.balance) > 0);
  if (!holders.length) return res.status(400).json({ error: 'ERR_NO_HOLDERS' });
  const totalTokens = holders.reduce((s, h) => s + parseInt(h.balance), 0);
  let distributed = 0; const distribution = [];
  for (const h of holders) {
    const share = Math.floor(amount * (parseInt(h.balance) / totalTokens) * 100) / 100;
    if (share <= 0) continue;
    yieldBalances[h.ownerId] = Math.round(((yieldBalances[h.ownerId] || 0) + share) * 100) / 100;
    distributed = Math.round((distributed + share) * 100) / 100;
    distribution.push({ identityId: h.ownerId, tokens: parseInt(h.balance), shareINR: share });
  }
  const blk = drunixAppend('YIELD_DISTRIBUTED', [{ kind: 'yield', assetId: req.params.id, amountINR: distributed, holders: distribution.length, contract: 'aasthi.servicing-v1' }]);
  res.json({ ok: true, assetId: req.params.id, amountINR: distributed, distribution, blockHeight: blk.height, message: `Rent distributed pro-rata to ${distribution.length} holders and credited to their wallets` });
});

app.post('/api/properties/:id/governance', authMiddleware, (req, res) => {
  const prop = properties[req.params.id];
  if (!prop) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  if (prop.originatorId !== req.user.identityId && req.user.role !== 'Regulator') return res.status(403).json({ error: 'ERR_NOT_ALLOWED', message: 'Only the listing owner or a Regulator can create proposals' });
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'title required' });
  const list = governance[req.params.id] = governance[req.params.id] || [];
  const g = { id: 'GOV-' + crypto.randomUUID().slice(0, 8), assetId: req.params.id, title, description: String(req.body.description || ''), createdBy: req.user.identityId, createdAt: new Date().toISOString(), status: 'OPEN', votes: {}, quorumPct: 20 };
  list.unshift(g);
  res.json({ ok: true, proposal: g });
});

app.get('/api/properties/:id/governance', authMiddleware, (req, res) => {
  res.json({ proposals: governance[req.params.id] || [] });
});

app.post('/api/governance/:assetId/:govId/vote', authMiddleware, (req, res) => {
  const list = governance[req.params.assetId] || [];
  const g = list.find(x => x.id === req.params.govId);
  if (!g) return res.status(404).json({ error: 'ERR_PROPOSAL_NOT_FOUND' });
  if (g.status !== 'OPEN') return res.status(400).json({ error: 'ERR_ALREADY_RESOLVED' });
  const bal = balances[req.params.assetId + '~' + req.user.identityId];
  const weight = bal ? parseInt(bal.balance) : 0;
  if (weight <= 0) return res.status(403).json({ error: 'ERR_NO_VOTING_POWER', message: 'Only token holders vote, weighted by tokens held' });
  const choice = String(req.body.choice || '').toUpperCase() === 'NO' ? 'NO' : 'YES';
  g.votes[req.user.identityId] = { choice, weight, at: new Date().toISOString() };
  const prop = properties[req.params.assetId];
  const supply = prop && prop.totalTokens ? parseInt(prop.totalTokens) : Object.values(g.votes).reduce((s, v) => s + v.weight, 0);
  let yes = 0, no = 0;
  for (const v of Object.values(g.votes)) (v.choice === 'YES' ? yes += v.weight : no += v.weight);
  if (((yes + no) / supply) * 100 >= g.quorumPct) {
    g.status = yes > no ? 'ACCEPTED' : 'REJECTED';
    g.resolvedAt = new Date().toISOString();
    g.tally = { yes, no };
    drunixAppend('GOVERNANCE_RESOLVED', [{ kind: 'governance', assetId: req.params.assetId, govId: g.id, title: g.title, yes, no, status: g.status, quorumPct: g.quorumPct }]);
  }
  res.json({ ok: true, proposal: g, yourWeight: weight });
});

app.post('/api/credit/pledge', authMiddleware, (req, res) => {
  const assetId = req.body.assetId, identityId = req.user.identityId;
  const tokens = parseInt(req.body.tokens);
  const price = drunixTokenPrice(assetId);
  if (!price) return res.status(404).json({ error: 'ERR_ASSET_NOT_FOUND' });
  if (!tokens || tokens <= 0) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'tokens must be > 0' });
  const bal = balances[assetId + '~' + identityId];
  const have = bal ? parseInt(bal.balance) : 0;
  const already = drunixLockedTokens(assetId, identityId);
  if (already + tokens > Math.floor(have * 0.5)) return res.status(400).json({ error: 'ERR_LTV_LIMIT', message: `Collateral capped at 50% of your ${have} tokens (${already} already pledged). Loan-locked tokens cannot be sold or swapped.` });
  const principalINR = Math.floor(tokens * price * 0.5);
  const loan = { loanId: 'LOAN-' + crypto.randomUUID().slice(0, 8), identityId, assetId, tokens, principalINR, ratePct: 1, ltvPct: 50, status: 'ACTIVE', createdAt: new Date().toISOString(), isSimulation: true };
  creditLoans[loan.loanId] = loan;
  const blk = drunixAppend('COLLATERAL_PLEDGED', [{ kind: 'credit', loanId: loan.loanId, assetId, identityId, tokens, principalINR, ltvPct: 50 }]);
  res.json({ ok: true, loan, blockHeight: blk.height, message: `${principalINR} INR credited against ${tokens} pledged tokens (50% LTV, repay with 1% fee). Simulation credit line.` });
});

app.post('/api/credit/repay', authMiddleware, (req, res) => {
  const L = creditLoans[req.body.loanId];
  if (!L || L.identityId !== req.user.identityId) return res.status(404).json({ error: 'ERR_LOAN_NOT_FOUND' });
  if (L.status !== 'ACTIVE') return res.status(400).json({ error: 'ERR_ALREADY_REPAID' });
  L.status = 'REPAID';
  L.repaidAt = new Date().toISOString();
  L.totalPaidINR = Math.round(L.principalINR * 1.01 * 100) / 100;
  const blk = drunixAppend('LOAN_REPAID', [{ kind: 'credit', loanId: L.loanId, identityId: L.identityId, assetId: L.assetId, tokensUnlocked: L.tokens, totalPaidINR: L.totalPaidINR }]);
  // Discharge of a secured loan releases pledged collateral. That is exactly
  // the event a lender and a borrower each want evidence of years later.
  certifyOnRail({
    assetId: L.assetId,
    subject: L.identityId,
    docType: 'LOAN_DISCHARGE_CERTIFICATE',
    title: `Loan discharge ${L.loanId}`,
    parties: [L.identityId],
    visibility: 'restricted',
    body: {
      document: 'Loan discharge and collateral release',
      loanId: L.loanId,
      borrower: L.identityId,
      assetId: L.assetId,
      tokensUnlocked: L.tokens,
      totalPaidINR: L.totalPaidINR,
      ledgerBlockHeight: blk.height,
      note: 'Collateral pledge released. The pledge and its discharge are both on the chain.',
    },
  }).catch(() => {});

  res.json({ ok: true, loan: L, blockHeight: blk.height, message: 'Loan repaid, collateral unlocked' });
});

app.get('/api/credit/loans/:identityId', authMiddleware, (req, res) => {
  res.json({ loans: Object.values(creditLoans).filter(L => L.identityId === req.params.identityId) });
});

// A swap moves tokens out of two wallets, so it needs two people to agree.
// It used to settle the moment one of them asked: the caller named a
// counterparty and simply took the tokens, at whatever ratio they liked.
// Proposing and accepting are now separate acts.
const swapProposals = {};

function swapView(sw) {
  return {
    swapId: sw.swapId, status: sw.status,
    proposer: sw.proposer, counterparty: sw.counterparty,
    offering: { assetId: sw.giveAssetId, tokens: sw.giveTokens },
    requesting: { assetId: sw.getAssetId, tokens: sw.getTokens },
    createdAt: sw.createdAt, settledAt: sw.settledAt || null,
    blockHeight: sw.blockHeight ?? null,
  };
}

// Proposing is free; it moves nothing. The balance checks still run here so
// an obviously impossible offer is refused up front, and again at accept
// time because holdings move in between.
app.post('/api/swap', authMiddleware, (req, res) => {
  const { giveAssetId, giveTokens, getAssetId, getTokens, counterparty } = req.body || {};
  const me = req.user.identityId;
  const gt = parseInt(giveTokens), rt = parseInt(getTokens);
  if (!giveAssetId || !getAssetId || !(gt > 0) || !(rt > 0)) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'giveAssetId, giveTokens, getAssetId, getTokens required' });
  if (giveAssetId === getAssetId) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'Pick two different properties' });
  if (!counterparty || counterparty === me) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'counterparty identity required' });
  const mine = balances[giveAssetId + '~' + me];
  const theirs = balances[getAssetId + '~' + counterparty];
  if (!mine || mine.balance < gt + drunixLockedTokens(giveAssetId, me)) return res.status(400).json({ error: 'ERR_INSUFFICIENT_BALANCE', message: 'You lack enough unlocked tokens on ' + giveAssetId });
  if (!theirs || theirs.balance < rt + drunixLockedTokens(getAssetId, counterparty)) return res.status(400).json({ error: 'ERR_COUNTERPARTY_SHORT', message: counterparty + ' lacks enough unlocked tokens on ' + getAssetId });
  const swapId = 'SWAP-' + crypto.randomUUID().slice(0, 8);
  swapProposals[swapId] = { swapId, status: 'PROPOSED', proposer: me, counterparty, giveAssetId, giveTokens: gt, getAssetId, getTokens: rt, createdAt: new Date() };
  res.status(201).json({
    ...swapView(swapProposals[swapId]),
    message: counterparty + ' must accept before anything moves.',
    next: 'POST /api/swap/' + swapId + '/accept (as ' + counterparty + ')',
  });
});

app.get('/api/swaps', authMiddleware, (req, res) => {
  const me = req.user.identityId;
  const all = Object.values(swapProposals);
  const mine = SUPERVISORY.has(String(req.user.role || '').toLowerCase())
    ? all : all.filter(sw => sw.proposer === me || sw.counterparty === me);
  res.json({ swaps: mine.map(swapView), count: mine.length });
});

app.get('/api/swap/:id', authMiddleware, (req, res) => {
  const sw = swapProposals[req.params.id];
  if (!sw) return res.status(404).json({ error: 'ERR_SWAP_NOT_FOUND', swapId: req.params.id });
  const me = req.user.identityId;
  if (sw.proposer !== me && sw.counterparty !== me && !SUPERVISORY.has(String(req.user.role || '').toLowerCase())) {
    return res.status(403).json({ error: 'ERR_NOT_YOUR_SWAP', message: 'This swap is between two other participants.' });
  }
  res.json(swapView(sw));
});

// Only the person being asked can say yes.
app.post('/api/swap/:id/accept', authMiddleware, (req, res) => {
  const sw = swapProposals[req.params.id];
  if (!sw) return res.status(404).json({ error: 'ERR_SWAP_NOT_FOUND', swapId: req.params.id });
  const me = req.user.identityId;
  if (sw.counterparty !== me) {
    return res.status(403).json({ error: 'ERR_NOT_YOUR_SWAP', message: 'Only ' + sw.counterparty + ' can accept this swap.' });
  }
  if (sw.status !== 'PROPOSED') return res.status(409).json({ error: 'ERR_SWAP_NOT_PENDING', status: sw.status });
  const { giveAssetId, getAssetId, giveTokens: gt, getTokens: rt, proposer } = sw;
  // Holdings move between proposal and acceptance, so check again now.
  const mine = balances[giveAssetId + '~' + proposer];
  const theirs = balances[getAssetId + '~' + me];
  if (!mine || mine.balance < gt + drunixLockedTokens(giveAssetId, proposer)) return res.status(409).json({ error: 'ERR_INSUFFICIENT_BALANCE', message: proposer + ' no longer holds enough unlocked tokens on ' + giveAssetId });
  if (!theirs || theirs.balance < rt + drunixLockedTokens(getAssetId, me)) return res.status(409).json({ error: 'ERR_COUNTERPARTY_SHORT', message: 'You lack enough unlocked tokens on ' + getAssetId });
  mine.balance -= gt; mine.updatedAt = new Date();
  const toProposer = balances[getAssetId + '~' + proposer] || (balances[getAssetId + '~' + proposer] = { docType: 'balance', assetId: getAssetId, ownerId: proposer, balance: 0, updatedAt: new Date() });
  toProposer.balance += rt; toProposer.updatedAt = new Date();
  theirs.balance -= rt; theirs.updatedAt = new Date();
  const toMe = balances[giveAssetId + '~' + me] || (balances[giveAssetId + '~' + me] = { docType: 'balance', assetId: giveAssetId, ownerId: me, balance: 0, updatedAt: new Date() });
  toMe.balance += gt; toMe.updatedAt = new Date();
  const blk = drunixAppend('ATOMIC_SWAP', [{ kind: 'swap', swapId: sw.swapId, leg1: { assetId: giveAssetId, from: proposer, to: me, tokens: gt }, leg2: { assetId: getAssetId, from: me, to: proposer, tokens: rt }, acceptedBy: me, atomic: 'all-or-nothing' }]);
  sw.status = 'SETTLED'; sw.settledAt = new Date(); sw.blockHeight = blk.height;
  res.json({ ok: true, ...swapView(sw), message: 'Both legs settled together. Either both moved, or neither.' });
});

// Either side can walk away while it is still only a proposal.
app.post('/api/swap/:id/cancel', authMiddleware, (req, res) => {
  const sw = swapProposals[req.params.id];
  if (!sw) return res.status(404).json({ error: 'ERR_SWAP_NOT_FOUND', swapId: req.params.id });
  const me = req.user.identityId;
  if (sw.proposer !== me && sw.counterparty !== me) {
    return res.status(403).json({ error: 'ERR_NOT_YOUR_SWAP', message: 'This swap is between two other participants.' });
  }
  if (sw.status !== 'PROPOSED') return res.status(409).json({ error: 'ERR_SWAP_NOT_PENDING', status: sw.status });
  sw.status = 'CANCELLED'; sw.cancelledBy = me;
  res.json({ ok: true, ...swapView(sw) });
});

// ============ PRIVATE OPERATOR INSIGHTS (additive) ============
// Locked to the operator by ADMIN_DASHBOARD_KEY. Disabled (503) when unset —
// it fails closed, never open. Aggregation lives in frontend/api/lib/insights.mjs so this
// server and the Vercel handler cannot drift apart.
// The shared module is ESM (the Vercel handler is ESM too). This file is
// CommonJS, so it is pulled in with a dynamic import once at startup and the
// routes await the same promise. One copy of the logic, two module systems.
const insightsReady = import('./frontend/api/lib/insights.mjs');
const trafficReady = import('./frontend/api/lib/traffic.mjs');

// Public beacon. Unauthenticated by necessity - visitors' browsers call it.
// It only ever increments counters, returns no data, and answers 204 so a
// failure here can never surface to a visitor or block a page.
app.post('/api/track', async (req, res) => {
  res.status(204).end();
  try {
    const { recordHit } = await trafficReady;
    const b = req.body || {};
    await recordHit({
      path: b.path,
      referrer: b.referrer,
      visitorId: b.vid,
      userAgent: req.get('user-agent') || '',
    });
  } catch (e) { console.error('[traffic]', e.message); }
});

app.get('/api/admin/insights', async (req, res) => {
  const { authorise: insightsAuth, buildInsights } = await insightsReady;
  const denied = insightsAuth(req);
  if (denied) return res.status(denied.status).json(denied.body);

  let rail = null;
  try {
    const base = UMI_GATEWAY_URL.replace(/\/$/, '');
    const get = async (p) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await fetch(base + p, { signal: ctrl.signal });
        return r.ok ? await r.json() : null;
      } finally { clearTimeout(timer); }
    };
    const [config, reconciliation, instructions, wallets, chain, analytics] = await Promise.all([
      get('/umi/config'), get('/umi/reconciliation'), get('/umi/instructions'),
      get('/umi/wallets'), get('/drunix/chain?limit=500'), get('/umi/analytics')
    ]);
    if (reconciliation) {
      rail = { config, reconciliation, instructions: (instructions && instructions.instructions) || [],
               wallets: (wallets && wallets.wallets) || [], chain,
               analytics: (analytics && analytics.analytics) || null };
    }
  } catch { /* rail optional — the report says so */ }

  // Report what broke instead of failing the whole dashboard opaquely.
  let report;
  try {
    report = buildInsights({ properties, balances, transfers, kycRecords, chain: drunixChain }, rail);
  } catch (e) {
    console.error('[INSIGHTS] buildInsights threw', e);
    return res.status(500).json({
      error: 'ERR_INSIGHTS_BUILD_FAILED',
      message: `Could not assemble the report: ${e.message}`,
      railReachable: !!rail,
    });
  }
  try {
    const { trafficSummary } = await trafficReady;
    report.traffic = await trafficSummary(14);
  } catch (e) {
    report.traffic = { unavailable: true, message: e.message };
  }
  res.json(report);
});

// Lets the UI tell "wrong password" apart from "feature not configured".

// The app and the settlement rail are deployed separately, so they drift: the
// site can be serving a commit the rail has never heard of. That cost a long
// debugging session once, when a fix looked live because Vercel had it and
// was not live because the rail had not redeployed. Report both, and whether
// the rail's own books still verify.
async function railDeploymentStatus() {
  const base = (process.env.UMI_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base) return { configured: false };
  const get = async (p) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(base + p, { signal: ctrl.signal });
      return r.ok ? await r.json() : null;
    } finally { clearTimeout(timer); }
  };
  try {
    const [health, recon] = await Promise.all([
      get('/health').catch(() => null),
      get('/umi/reconciliation').catch(() => null),
    ]);
    if (!health && !recon) return { configured: true, reachable: false };
    const chain = (recon && recon.chain) || null;
    return {
      configured: true,
      reachable: true,
      build: (health && health.build && health.build.commit) || 'unknown',
      ledgerValid: chain ? chain.valid === true : null,
      ...(chain && chain.valid === false
        ? { ledgerProblem: chain.reason, ledgerBrokenAt: chain.brokenAt }
        : {}),
    };
  } catch {
    return { configured: true, reachable: false };
  }
}

app.get('/api/admin/insights/status', async (req, res) => {
  const { configuredKey } = await insightsReady;
  res.json({
    enabled: !!configuredKey(),
    rail: await railDeploymentStatus(),
    // Build stamp: lets an operator confirm which commit a deployment is
    // actually serving, instead of guessing whether a redeploy took effect.
    build: process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
    runtime: 'esm',
  });
});
// ============ END PRIVATE OPERATOR INSIGHTS ============

// ============ ADMIN OPS QUEUE (additive) ============
// The existing /admin page walks one property through its lifecycle, and
// /insights is a private analytics read. Neither answers the question an
// operator actually opens a dashboard to ask: what is stuck right now, and
// who has to act on it. This aggregates the work queues and nothing else —
// no UMI logic lives here, the rail is only read over HTTP.
function ageMins(ts) {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
}

app.get('/api/admin/ops', authMiddleware, async (req, res) => {
  if (!['Registrar', 'Regulator'].includes(req.user.role)) {
    return res.status(403).json({
      error: 'ERR_NOT_REGISTRAR',
      message: 'The operations queue is for Registrars and Regulators.',
    });
  }

  const props = Object.values(properties);

  const awaitingValidation = props
    .filter(p => p.registrarValidationStatus !== 'VALIDATED' && p.registrarValidationStatus !== 'REJECTED')
    .map(p => ({ assetId: p.assetId, title: p.title, owner: p.originatorId,
                 ageMins: ageMins(p.createdAt), status: p.registrarValidationStatus || 'PENDING' }));

  const validatedNotMinted = props
    .filter(p => p.registrarValidationStatus === 'VALIDATED' && p.status !== 'TOKENIZED' && p.status !== 'FROZEN')
    .map(p => ({ assetId: p.assetId, title: p.title, owner: p.originatorId,
                 ageMins: ageMins(p.updatedAt) }));

  const frozen = props.filter(p => p.status === 'FROZEN')
    .map(p => ({ assetId: p.assetId, title: p.title, ageMins: ageMins(p.updatedAt) }));

  // A payment that is CONFIRMED but never RELEASED means the buyer's money
  // moved and their tokens did not. That is the one queue worth paging over.
  const payments = Object.values(npciPayments);
  const stuckPayments = payments
    .filter(p => p.status === 'CONFIRMED')
    .map(p => ({ paymentId: p.paymentId, assetId: p.assetId, payerId: p.payerId,
                 amountINR: Number(p.amountINR) || 0, tokenAmount: Number(p.tokenAmount) || 0,
                 ageMins: ageMins(p.createdAt) }))
    .sort((a, b) => (b.ageMins || 0) - (a.ageMins || 0));

  const expiredPending = payments
    .filter(p => p.status === 'PENDING' && p.expiresAt && new Date(p.expiresAt).getTime() < Date.now())
    .map(p => ({ paymentId: p.paymentId, assetId: p.assetId, payerId: p.payerId,
                 amountINR: Number(p.amountINR) || 0, ageMins: ageMins(p.createdAt) }));

  const pendingKyc = Object.values(kycRecords)
    .filter(k => k.kycStatus !== 'VERIFIED')
    .map(k => ({ identityId: k.identityId, status: k.kycStatus }));

  // Rail reads are best-effort: the ops page must still render if the Go
  // gateway is down, and say so rather than fail opaquely.
  let rail = { reachable: false };
  try {
    const base = UMI_GATEWAY_URL.replace(/\/$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let insts = [];
    try {
      const r = await fetch(base + '/umi/instructions', { signal: ctrl.signal });
      if (r.ok) {
        const j = await r.json();
        insts = j.instructions || [];
      }
    } finally { clearTimeout(timer); }
    const failed = insts.filter(i => i.status === 'FAILED');
    const byReason = {};
    for (const i of failed) byReason[i.failureReason || 'UNKNOWN'] = (byReason[i.failureReason || 'UNKNOWN'] || 0) + 1;
    rail = {
      reachable: true,
      instructions: insts.length,
      settled: insts.filter(i => i.status === 'SETTLED').length,
      failed: failed.length,
      failedByReason: byReason,
      // Underfunded buyers are recoverable by topping up. These are grouped by
      // buyer on purpose: one wallet retrying a dozen times produces a dozen
      // failures, and a queue of identical rows is noise, not work. What an
      // operator needs is the wallet and the total it is short by.
      recoverable: Object.values(failed
        .filter(i => i.failureReason === 'ERR_UMI_INSUFFICIENT_CBDC' && i.shortfallINR > 0)
        .reduce((acc, i) => {
          const g = acc[i.buyer] || (acc[i.buyer] = {
            buyer: i.buyer, instructions: 0, largestShortfallINR: 0, assets: [],
            latestInstructionId: i.instructionId,
          });
          g.instructions += 1;
          // Topping up the largest single gap clears that instruction; summing
          // retries of the same trade would overstate what is actually needed.
          g.largestShortfallINR = Math.max(g.largestShortfallINR, i.shortfallINR);
          g.latestInstructionId = i.instructionId;
          if (!g.assets.includes(i.assetId)) g.assets.push(i.assetId);
          return acc;
        }, {}))
        .sort((a, b) => b.largestShortfallINR - a.largestShortfallINR),
    };
  } catch { /* leave rail.reachable false */ }

  const chain = drunixVerify();
  const queues = {
    awaitingValidation, validatedNotMinted, frozen,
    stuckPayments, expiredPending, pendingKyc,
  };
  res.json({
    generatedAt: new Date().toISOString(),
    actor: { identityId: req.user.identityId, role: req.user.role },
    actionable: awaitingValidation.length + validatedNotMinted.length + stuckPayments.length,
    queues,
    counts: Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, v.length])),
    rail,
    chain: { blocks: drunixChain.length, valid: !!(chain && (chain.valid ?? chain.ok)) },
  });
});
// ============ END ADMIN OPS QUEUE ============

// ============ UMI RAIL PROXY (additive) ============
// RBI Unified Market Interface pattern — SEBI Demat 2.0: tokenised asset on the
// depositories' permissioned ledger + cash leg in wholesale CBDC (e₹-W) = atomic DvP.
// ALL UMI logic lives in Go (drunix-gateway/umi.go). Node holds zero UMI state and
// only reverse-proxies; if the Go rail is down, /api/umi/* returns 503 and every
// other AasthiChain route is unaffected.
const UMI_GATEWAY_URL = process.env.UMI_GATEWAY_URL || 'http://127.0.0.1:21100';
// Live ledger stream. This must bypass umiProxy: that helper buffers the whole
// upstream body and aborts after 8s, which is exactly wrong for a connection
// meant to stay open. Note this works where the app is a long-running process;
// on serverless the connection cannot be held, and the client falls back to
// polling on its own.
app.get('/api/umi/events', async (req, res) => {
  let upstream;
  try {
    upstream = await fetch(UMI_GATEWAY_URL.replace(/\/$/, '') + '/drunix/events', {
      headers: { Accept: 'text/event-stream' },
    });
  } catch (e) {
    return res.status(503).json({ error: 'ERR_UMI_RAIL_UNAVAILABLE', message: e.message });
  }
  if (!upstream.ok || !upstream.body) {
    return res.status(502).json({ error: 'ERR_UMI_STREAM_FAILED', upstreamStatus: upstream.status });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const reader = upstream.body.getReader();
  // Stop reading as soon as the browser goes away, or the rail keeps a
  // subscriber alive for a client that no longer exists.
  let closed = false;
  req.on('close', () => { closed = true; reader.cancel().catch(() => {}); });
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch { /* client or upstream went away */ }
  if (!closed) res.end();
});

// Metrics are Prometheus text, not JSON. umiProxy assumes JSON and rewrites
// anything else into an error envelope, so this has to bypass it.
app.get('/api/umi/metrics', async (req, res) => {
  try {
    const upstream = await fetch(UMI_GATEWAY_URL.replace(/\/$/, '') + '/umi/metrics');
    const text = await upstream.text();
    res
      .status(upstream.status)
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(text);
  } catch (e) {
    res.status(503).type('text/plain').send('# settlement rail unreachable: ' + e.message + '\n');
  }
});

// A document fetch returns the file itself — a PDF, an image, arbitrary bytes.
// umiProxy assumes JSON and would rewrite the body into an error envelope, so
// this streams it through untouched. The caller's identity is forwarded as
// headers because the rail has no session of its own and enforces visibility
// on restricted documents itself.
app.get('/api/umi/documents/fetch/:cid', async (req, res) => {
  try {
    const headers = {};
    // Optional auth: public documents are readable without a login, and the
    // rail decides. Decoding the token here only adds the identity when one
    // was actually supplied.
    const auth = req.headers.authorization;
    if (auth) {
      try {
        const payload = decodeClerkOrMockToken(auth.split(' ')[1]);
        if (payload && payload.identityId) {
          headers['X-Identity-Id'] = payload.identityId;
          headers['X-Identity-Role'] = payload.role || '';
        }
      } catch { /* an unreadable token is simply an anonymous request */ }
    }
    const upstream = await fetch(
      UMI_GATEWAY_URL.replace(/\/$/, '') + '/umi/documents/fetch/' + encodeURIComponent(req.params.cid),
      { headers }
    );
    const buf = Buffer.from(await upstream.arrayBuffer());
    // Pass the integrity headers through: they are what let the browser (or
    // curl) re-hash the bytes and confirm they match the CID it asked for.
    for (const h of ['content-type', 'x-document-cid', 'x-document-sha256', 'x-document-status', 'cache-control']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(upstream.status).send(buf);
  } catch (e) {
    res.status(503).json({ error: 'ERR_DRUNIX_UNREACHABLE', message: e.message });
  }
});

// Identify the caller if they have credentials, but do not demand them:
// some rail routes (reconciliation, the public ledger view) are deliberately
// open, and the rail itself decides which ones need a name.
function umiIdentify(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return next();
  try {
    const payload = decodeClerkOrMockToken(auth.split(' ')[1]);
    if (payload && payload.identityId) req.user = payload;
  } catch { /* an unreadable token is simply no identity */ }
  return next();
}

app.all('/api/umi', umiIdentify, umiProxy);
app.all('/api/umi/*splat', umiIdentify, umiProxy);
async function umiProxy(req, res) {
  const suffix = req.originalUrl.replace(/^\/api\/umi/, '') || '/config';
  const target = UMI_GATEWAY_URL + '/umi' + (suffix.startsWith('/') ? suffix : '/' + suffix);
  try {
    // The rail decides what a caller may touch, so it has to know who the
    // caller is. Node adds nothing of its own: it forwards the identity it
    // already authenticated.
    const fwd = { 'Content-Type': 'application/json' };
    // Either the session we authenticated, or the identity headers the
    // caller already presented (which is how production identifies people).
    if (req.user && req.user.identityId) {
      fwd['X-Fabric-Identity'] = req.user.identityId;
      fwd['X-Identity-Role'] = req.user.role || '';
    } else if (req.headers['x-fabric-identity'] || req.headers['x-identity-id']) {
      fwd['X-Fabric-Identity'] = req.headers['x-fabric-identity'] || req.headers['x-identity-id'];
      fwd['X-Identity-Role'] = req.headers['x-identity-role'] || '';
    }
    const init = { method: req.method, headers: fwd };
    if (!['GET', 'HEAD'].includes(req.method)) init.body = JSON.stringify(req.body || {});
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    init.signal = ctrl.signal;
    const upstream = await fetch(target, init);
    clearTimeout(timer);
    const text = await upstream.text();
    // Go answers unknown routes with plain-text "404 page not found". Sending
    // that under a JSON content type produced an opaque "Request failed 404"
    // in the browser, so wrap any non-JSON body in a real JSON error.
    let isJson = true;
    try { JSON.parse(text); } catch { isJson = false; }
    // Not everything the rail serves is JSON. /umi/metrics is Prometheus text
    // exposition by design, and treating "not JSON" as "broken" replaced a
    // perfectly good 200 with an error envelope -- under a 200 status, so a
    // caller could not even tell it had failed. Only a FAILED upstream gets
    // wrapped; a successful non-JSON body is passed through as it came.
    if (!isJson && upstream.ok) {
      return res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') || 'text/plain; charset=utf-8')
        .send(text);
    }
    if (!isJson) {
      return res.status(upstream.status === 404 ? 502 : upstream.status).json({
        error: upstream.status === 404 ? 'ERR_DRUNIX_ROUTE_UNKNOWN' : 'ERR_DRUNIX_BAD_RESPONSE',
        message: upstream.status === 404
          ? 'The Drunix gateway is running but does not serve this route. It is almost certainly an older build - rebuild and restart the Go gateway.'
          : `The Drunix gateway returned a non-JSON response (HTTP ${upstream.status}).`,
        upstreamStatus: upstream.status,
        upstreamBody: text.slice(0, 200),
      });
    }
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    res.status(503).json({
      error: 'ERR_UMI_RAIL_UNAVAILABLE',
      message: `UMI settlement rail (Go) not reachable at ${UMI_GATEWAY_URL}. Start it with: cd drunix-gateway && go run ./cmd/gateway`,
      rail: 'RBI Unified Market Interface (simulation)', language: 'golang', detail: String(e && e.message || e)
    });
  }
}
// Drunix ledger proxy — the UMI settlement chain lives in Go and is the durable,
// append-only one (Postgres-backed when DATABASE_URL is set). Node keeps its own
// in-memory property chain at /api/chain for the local demo; this exposes the Go
// chain to the Ledger Explorer so UMI blocks are actually visible. Pure proxy.
app.all('/api/drunix/*splat', drunixProxy);
async function drunixProxy(req, res) {
  const suffix = req.originalUrl.replace(/^\/api\/drunix/, '') || '/chain';
  const target = UMI_GATEWAY_URL + '/drunix' + (suffix.startsWith('/') ? suffix : '/' + suffix);
  try {
    const init = { method: req.method, headers: { 'Content-Type': 'application/json' } };
    if (!['GET', 'HEAD'].includes(req.method)) init.body = JSON.stringify(req.body || {});
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    init.signal = ctrl.signal;
    const upstream = await fetch(target, init);
    clearTimeout(timer);
    const text = await upstream.text();
    // Go answers unknown routes with plain-text "404 page not found". Sending
    // that under a JSON content type produced an opaque "Request failed 404"
    // in the browser, so wrap any non-JSON body in a real JSON error.
    let isJson = true;
    try { JSON.parse(text); } catch { isJson = false; }
    // Not everything the rail serves is JSON. /umi/metrics is Prometheus text
    // exposition by design, and treating "not JSON" as "broken" replaced a
    // perfectly good 200 with an error envelope -- under a 200 status, so a
    // caller could not even tell it had failed. Only a FAILED upstream gets
    // wrapped; a successful non-JSON body is passed through as it came.
    if (!isJson && upstream.ok) {
      return res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') || 'text/plain; charset=utf-8')
        .send(text);
    }
    if (!isJson) {
      return res.status(upstream.status === 404 ? 502 : upstream.status).json({
        error: upstream.status === 404 ? 'ERR_DRUNIX_ROUTE_UNKNOWN' : 'ERR_DRUNIX_BAD_RESPONSE',
        message: upstream.status === 404
          ? 'The Drunix gateway is running but does not serve this route. It is almost certainly an older build - rebuild and restart the Go gateway.'
          : `The Drunix gateway returned a non-JSON response (HTTP ${upstream.status}).`,
        upstreamStatus: upstream.status,
        upstreamBody: text.slice(0, 200),
      });
    }
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    res.status(503).json({
      error: 'ERR_DRUNIX_GATEWAY_UNAVAILABLE',
      message: `Drunix gateway (Go) not reachable at ${UMI_GATEWAY_URL}.`,
      detail: String(e && e.message || e)
    });
  }
}
// ============ END UMI RAIL PROXY ============

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AasthiChain Mock API Gateway + Frontend (Node.js live demo) listening on :${PORT} | FabricMode: mock | Tracks A1-A7 + Fintech UI per spec`);
  console.log(`Seed property: ${propId} | Balances: ${Object.keys(balances).length} | Transfers: ${Object.keys(transfers).length} (25 for pagination demo)`);
  console.log(`Frontend dist: ${path.join(__dirname, 'frontend', 'dist')} | UI: paper #F7F5F0, registry-navy #1E3A5F, Fraunces+Inter`);
});
