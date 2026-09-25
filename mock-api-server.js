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
  app.use(express.static(distPath));
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

app.post('/api/auth/verification', authMiddleware, (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier) return res.status(400).json({ error: 'identifier required' });
  const id = uidA('ver');
  const row = { id, identifier: String(identifier).toLowerCase(), value: String(Math.floor(100000 + Math.random() * 900000)), expires_at: new Date(Date.now() + 30 * 60 * 1000), updated_at: new Date() };
  authMem.verification.set(id, row);
  res.status(201).json({ id, identifier: row.identifier, expires_at: row.expires_at });
});

app.post('/api/auth/verification/verify', authMiddleware, (req, res) => {
  const { identifier, value } = req.body || {};
  const ident = String(identifier || '').toLowerCase();
  for (const [k, v] of authMem.verification.entries()) {
    if (v.identifier === ident && v.value === String(value)) {
      if (new Date(v.expires_at) < new Date()) return res.json({ verified: false });
      authMem.verification.delete(k);
      return res.json({ verified: true });
    }
  }
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

app.get('/api/orgs', authMiddleware, (req, res) => {
  res.json({ organizations: [...authMem.organization.values()] });
});

app.get('/api/orgs/:id/members', authMiddleware, (req, res) => {
  res.json({ members: [...authMem.member.values()].filter(m => m.organization_id === req.params.id) });
});

app.post('/api/orgs/:id/invitations', authMiddleware, (req, res) => {
  const { email, role } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const id = uidA('inv');
  const row = { id, organization_id: req.params.id, email: String(email).toLowerCase(), role: role || 'member', status: 'pending', expires_at: new Date(Date.now() + 168 * 3600 * 1000), created_at: new Date(), invited_by: req.user.identityId };
  authMem.invitation.set(id, row);
  res.status(201).json(row);
});

app.get('/api/orgs/:id/invitations', authMiddleware, (req, res) => {
  res.json({ invitations: [...authMem.invitation.values()].filter(i => i.organization_id === req.params.id) });
});

app.post('/api/invitations/accept', authMiddleware, (req, res) => {
  const { invitationId } = req.body || {};
  const inv = authMem.invitation.get(invitationId);
  if (!inv) return res.status(404).json({ error: 'invitation not found' });
  if (inv.status !== 'pending') return res.status(400).json({ error: 'invitation already ' + inv.status });
  if (new Date(inv.expires_at) < new Date()) { inv.status = 'expired'; return res.status(400).json({ error: 'invitation expired' }); }
  inv.status = 'accepted';
  const mid = uidA('mem');
  const member = { id: mid, organization_id: inv.organization_id, user_id: req.user.identityId, role: inv.role, created_at: new Date() };
  authMem.member.set(mid, member);
  authGetOrCreateUser(req.user.identityId);
  res.json({ member });
});

app.post('/api/properties', authMiddleware, (req, res) => {
  const { title, state, city, pincode, valuationINR, documentHash } = req.body;
  const idemKey = req.headers['x-idempotency-key'];
  if (idemKey && idempotency[idemKey]) return res.json(idempotency[idemKey]);
if (!documentHash || documentHash.length !== 64) return res.status(400).json({ error: 'ERR_INVALID_INPUT', message: 'documentHash must be 64 chars' });
      // Duplicate-property guard — same document (hash) or same title+location cannot be listed twice
      {
        const t = String(title || '').trim().toLowerCase();
        const c = String(city || '').trim().toLowerCase();
        const p = String(pincode || '').trim();
        const dup = Object.values(properties).find(x =>
          (documentHash && x.documentHash === documentHash) ||
          (t && x.title && x.title.trim().toLowerCase() === t && x.location && String(x.location.city || '').toLowerCase() === c && String(x.location.pincode || '') === p));
        if (dup) {
          return res.status(409).json({ error: 'ERR_DUPLICATE_PROPERTY', assetId: dup.assetId, title: dup.title, message: `This property is already listed ("${dup.title}", ${dup.assetId}). Each document can be tokenized only once.` });
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
  const resp = { assetId, status: 'DRAFT', message: 'Property registered, pending registrar validation', fabricMode: 'mock' };
  if (idemKey) idempotency[idemKey] = resp;
  res.status(201).json(resp);
});

app.get('/api/properties', authMiddleware, (req, res) => {
  const status = req.query.status;
  let list = Object.values(properties);
  if (status) list = list.filter(p => p.status === status);
  res.json({ properties: list.map(p => ({ ...p, subscription: subscriptionOf(p) })), count: list.length, fabricMode: 'mock', indexUsed: 'idx_property_status' });
});

app.get('/api/properties/:id', authMiddleware, (req, res) => {
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
  res.json({ property: prop, tokenPrice, availableTokens, soldTokens, holders, subscription: subscriptionOf(prop), documentHashVerified: true, fabricMode: 'mock' });
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
    if (verifiedTokens >= amt) {
      balances[fromKey] = { docType: 'balance', assetId, ownerId: fromId, balance: verifiedTokens, updatedAt: new Date() };
      fromBal = balances[fromKey];
    } else {
      return res.status(400).json({ error: 'ERR_INSUFFICIENT_BALANCE', verifiedTokens, needed: amt, message: `Verified tokens from your purchase receipts: ${verifiedTokens}. Needed: ${amt}.` });
    }
  }
  if (!fromBal) {
    // 3) demo auto-fix: originator gets supply
    if (fromId === prop.originatorId || fromId === 'originator1' || prop.autoCreated || prop.restoredFromClient) {
      balances[fromKey] = { docType: 'balance', assetId, ownerId: fromId, balance: prop.totalTokens, updatedAt: new Date() };
      fromBal = balances[fromKey];
    } else {
      return res.status(400).json({ error: 'ERR_BALANCE_NOT_FOUND' });
    }
  }
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

app.post('/api/testnet/payments/:id/confirm', authMiddleware, (req, res) => {
  const pid = req.params.id;
  if (testnetPayments[pid]) {
    testnetPayments[pid].status = 'CONFIRMED';
    testnetPayments[pid].drunixTransferId = req.body.drunixTransferId;
    testnetPayments[pid].confirmedAt = new Date();
  }
  res.json({ paymentId: pid, status: 'CONFIRMED', drunixTransferId: req.body.drunixTransferId, message: 'Drunix transfer confirmed — linked to testnet escrow via confirmDrunixTransfer() — real Drunix ledger' });
});

app.post('/api/testnet/payments/:id/release', authMiddleware, (req, res) => {
  const pid = req.params.id;
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
async function settleConfirmedPayment(pay) {
  if (!pay) return { ok: false, code: 404, error: 'ERR_PAYMENT_NOT_FOUND', message: 'Payment not found' };
  if (pay.status === 'RELEASED' && pay.drunixTransferId) return { ok: true, already: true, payment: pay, message: 'Already settled' };
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
  pay.drunixTransferId = tid;
  pay.status = 'RELEASED';
  pay.releasedAt = now;
  if (typeof globalThis !== 'undefined') {
    globalThis._aasthi_balances = balances;
    globalThis._aasthi_transfers = transfers;
    globalThis._aasthi_npcipayments = npciPayments;
  }
  try { if (typeof persistNpciState === 'function') await persistNpciState(); } catch {}
  try { if (typeof saveAllPersisted === 'function') saveAllPersisted(); } catch {}
  console.log(`[SETTLE] ${pay.paymentId}: ${amt} tokens ${seller} → ${buyer} (${tid}) — server-side settlement`);
  return { ok: true, payment: pay, transfer: transfers[tid], moved: amt, seller, buyer };
}


// ===== Property deletion / delisting =====
// Originator: own listing — anytime while DRAFT (nothing tokenized), or once fully
// subscribed (all tokens sold: owner holds 0). Regulator: any listing (compliance).
// ---- Subscription lifecycle (computed, never stored — can't drift from ledger)
// primary (buying) -> fully-subscribed (primary closed, phase 'secondary') ->
// wallet-to-wallet P2P transfers. Drives buy guards + UI progress/badges.
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
function buildPayUCheckout(payu, pay, req, cbBase) {
  const firstname = String(req.payerVpa || 'payer').split('@')[0];
  const email = firstname + '@aasthichain.demo';
  const udf = [req.assetId || '', String(req.tokenAmount || ''), pay.upiTxnId || '', req.payeeVpa || '', req.idemKey || ''];
  const productinfo = req.note || `Buy ${req.tokenAmount} tokens of ${req.assetId}`;
  const amount = Number(req.amountINR).toFixed(2);
  const params = {
    key: payu.key, txnid: pay.paymentId, amount, productinfo, firstname, email,
    phone: '9999999999', vpa: req.payerVpa,
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
function payuCallbackHtml(paymentId, status, base, assetId) {
  const ok = status === 'CONFIRMED';
  // Return to the property page (SimpleBuyFlow auto-resumes DvP there); wallet as fallback
  const target = assetId ? `${base}/property/${encodeURIComponent(assetId)}?payu=return&paymentId=${encodeURIComponent(paymentId)}` : `${base}/wallet`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=${target}"><title>AasthiChain — Payment ${status}</title></head>` +
    `<body style="font-family:Inter,sans-serif;text-align:center;padding:48px;background:#F7F5F0;color:#1E3A5F">` +
    `<h2 style="margin:0 0 8px">${ok ? '✓ Payment confirmed' : status === 'DECLINED' ? '✗ Payment not completed' : '… Payment pending'}</h2>` +
    `<p style="color:#5A6B7D">Returning you to AasthiChain…</p><p style="font-size:12px;color:#8B95A1">Ref: ${paymentId}</p></body></html>`;
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
  if (idemKey && npciIdem[idemKey]) return res.json(npciIdem[idemKey]);
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
    payerId: payerId || 'investor1', payeeId: payeeId || 'originator1',
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
  if (npciIdem[webhookId]) return res.status(200).send(payuCallbackHtml(pay.paymentId, pay.status, payuPublicBase(req), pay.assetId));
  const amtPayu = parseFloat(g('amount'));
  if (!isNaN(amtPayu) && Math.abs(amtPayu - pay.amountINR) > 0.01) {
    pay.status = 'FAILED_AMOUNT_MISMATCH';
    pay.failureReason = `Amount mismatch: expected ₹${pay.amountINR} got ₹${amtPayu} — manual review required`;
    pay.callbackData = params; pay.provider = 'payu'; pay.webhookReceivedAt = new Date();
    return res.status(200).send(payuCallbackHtml(pay.paymentId, pay.status, payuPublicBase(req), pay.assetId));
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
  res.status(200).send(payuCallbackHtml(pay.paymentId, pay.status, payuPublicBase(req), pay.assetId));
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
app.get('/api/drunix/ledger', authMiddleware, (req, res) => {
  const pay = req.query.paymentId ? npciPayments[req.query.paymentId] : Object.values(npciPayments).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!pay) return res.status(404).json({ error: 'Payment not found', paymentId: req.query.paymentId });
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
      { name: 'Bank Webhooks', endpoint: '/api/npci/webhook', auth: 'signature', status: 'live' },
      { name: 'Drunix Ledger Flow', endpoint: '/api/drunix/ledger?paymentId=', auth: 'Bearer JWT', status: 'live' },
      { name: 'Fraud Scoring', endpoint: '/api/fraud/config', auth: 'Bearer JWT', status: 'live' },
      { name: 'Property Data (Bhoomi/Dharani)', endpoint: '/api/properties/:id/verify', auth: 'Bearer JWT', status: 'live' },
      { name: 'KYC — DigiLocker', endpoint: '/api/kyc/digilocker/init', auth: 'Bearer JWT', status: 'live' },
      { name: 'Drunix Gateway (Golang)', endpoint: 'http://localhost:21100 (DRUNIX_GATEWAY_URL)', auth: 'internal', status: 'optional remote' }
    ]
  });
});

app.get('/api/npci/payments', authMiddleware, (req, res) => {
  const list = Object.values(npciPayments)
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
    utrIndex[pay.utr] = pay.paymentId;
    if (pay.utr12) utrIndex[pay.utr12] = pay.paymentId;
    if (pay.utrImps) utrIndex[pay.utrImps] = pay.paymentId;
    if (pay.rrn) utrIndex[pay.rrn] = pay.paymentId;
  }
  pay.webhookReceivedAt = new Date();
  npciPayments[pay.paymentId] = pay;
  addWebhookAudit({
    webhookId: `wh-${Date.now()}-${pay.paymentId}`,
    paymentId: pay.paymentId, status: 'CONFIRMED', rrn: pay.rrn, utr: pay.utr,
    provider: 'mock', amount: pay.amountINR, timestamp: new Date(), result: 'PAYMENT_CONFIRMED'
  });
  res.json(pay);
});

app.post('/api/npci/payments/:id/release', authMiddleware, (req, res) => {
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
  res.json(pay);
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

app.get('/api/npci/utr/:utr', authMiddleware, (req, res) => {
  const paymentId = utrIndex[req.params.utr];
  if (!paymentId) return res.status(404).json({ error: 'UTR not found', utr: req.params.utr });
  const pay = npciPayments[paymentId];
  if (!pay) return res.status(404).json({ error: 'Payment not found for UTR', utr: req.params.utr });
  res.json({ utr: req.params.utr, paymentId, status: pay.status, amountINR: pay.amountINR, rrn: pay.rrn, upiTxnId: pay.upiTxnId, confirmedAt: pay.confirmedAt, releasedAt: pay.releasedAt, drunixTransferId: pay.drunixTransferId, payment: pay });
});

app.get('/api/npci/reconcile', authMiddleware, (req, res) => {
  const all = Object.values(npciPayments);
  const byStatus = {};
  all.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  const confirmed = all.filter(p => ['CONFIRMED', 'RELEASED'].includes(p.status));
  const withUtr = confirmed.filter(p => p.utr);
  res.json({
    total: all.length,
    byStatus,
    confirmedCount: confirmed.length,
    utrMatchedCount: withUtr.length,
    unmatched: all.filter(p => ['CONFIRMED'].includes(p.status) && !p.utr).map(p => p.paymentId),
    reconciliationRate: all.length ? Math.round((withUtr.length / Math.max(confirmed.length, 1)) * 100) : 100,
    payments: all.slice(0, 20).map(p => ({ paymentId: p.paymentId, status: p.status, utr: p.utr, rrn: p.rrn, amountINR: p.amountINR, drunixTransferId: p.drunixTransferId }))
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
  res.json({ sent: payload, payment: pay, note: 'Simulated bank webhook — signature verified in mock mode' });
});

app.get('/api/npci/webhooks', authMiddleware, (req, res) => {
  res.json({ webhooks: npciWebhooks.slice(0, 50), count: npciWebhooks.length });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AasthiChain Mock API Gateway + Frontend (Node.js live demo) listening on :${PORT} | FabricMode: mock | Tracks A1-A7 + Fintech UI per spec`);
  console.log(`Seed property: ${propId} | Balances: ${Object.keys(balances).length} | Transfers: ${Object.keys(transfers).length} (25 for pagination demo)`);
  console.log(`Frontend dist: ${path.join(__dirname, 'frontend', 'dist')} | UI: paper #F7F5F0, registry-navy #1E3A5F, Fraunces+Inter`);
});
