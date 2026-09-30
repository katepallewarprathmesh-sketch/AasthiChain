// Auth & Organization store — implements the Neon schema entities that were
// missing from the code (see uploads/image-1.png diagram):
//   user, account, session, organization, member, invitation, verification,
//   jwt, project_config
// SRP: only auth/org persistence + identity lifecycle.
// DIP: same API over Postgres (Neon, first-class columns matching the schema)
// or in-memory Maps (mock/dev). Callers never touch SQL.
// ESM module (frontend package "type": "module").

import crypto from 'crypto'

const TABLES = {
  user: `CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    email TEXT,
    email_not_verified BOOLEAN DEFAULT FALSE,
    name TEXT,
    image TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    first_name TEXT,
    last_name TEXT
  )`,
  account: `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    account_id TEXT,
    email TEXT,
    display_name TEXT,
    avatar_url TEXT,
    external_identifier TEXT,
    external_id TEXT,
    type TEXT,
    provider TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  session: `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    active_organization_id TEXT,
    token TEXT,
    user_agent TEXT,
    ip_address TEXT,
    extra_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  organization: `CREATE TABLE IF NOT EXISTS organization (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT UNIQUE,
    logo TEXT,
    client_id TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  member: `CREATE TABLE IF NOT EXISTS member (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    user_id TEXT,
    role TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  invitation: `CREATE TABLE IF NOT EXISTS invitation (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    email TEXT,
    role TEXT,
    status TEXT DEFAULT 'pending',
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    invited_by TEXT
  )`,
  verification: `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT,
    value TEXT,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  jwt: `CREATE TABLE IF NOT EXISTS jwt (
    id TEXT PRIMARY KEY,
    token_key TEXT,
    public_key TEXT,
    private_key TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  project_config: `CREATE TABLE IF NOT EXISTS project_config (
    id TEXT PRIMARY KEY,
    name TEXT,
    org_id TEXT,
    domain_url TEXT,
    cookie_domain TEXT,
    limited_logins BOOLEAN DEFAULT FALSE,
    disable_sign_up BOOLEAN DEFAULT FALSE,
    enabled_providers JSONB,
    email_at_first_login BOOLEAN DEFAULT FALSE,
    single_page_app BOOLEAN DEFAULT TRUE,
    magic_link_config JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`
}

function uid(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomUUID()
}

export class AuthStore {
  constructor() {
    this.mode = 'memory'
    this.pool = null
    this.initialized = false
    // in-memory mirrors (dev/mock fallback)
    this.mem = { user: new Map(), account: new Map(), session: new Map(), organization: new Map(), member: new Map(), invitation: new Map(), verification: new Map(), jwt: new Map(), project_config: new Map() }
  }

  databaseUrl() {
    return process.env.DATABASE_URL || process.env.POSTGRES_URL || ''
  }

  async init() {
    if (this.initialized) return this.mode
    const url = this.databaseUrl()
    if (url) {
      try {
        const pg = await import('pg')
        const { Pool } = pg.default || pg
        this.pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 })
        for (const ddl of Object.values(TABLES)) {
          await this.pool.query(ddl)
        }
        // default project_config row (matches diagram defaults)
        await this.pool.query(
          `INSERT INTO project_config (id, name, single_page_app) VALUES ($1, $2, TRUE) ON CONFLICT (id) DO NOTHING`,
          ['pcfg_default', 'aasthichain']
        )
        this.mode = 'postgres'
        console.log('[AuthStore] Mode: postgres — Neon schema entities (user/account/session/organization/member/invitation/verification/jwt/project_config)')
      } catch (e) {
        console.error('[AuthStore] postgres init failed, memory mode:', e.message)
        this.pool = null
      }
    }
    if (!this.pool) this.mode = 'memory'
    this.initialized = true
    return this.mode
  }

  getMode() { return this.initialized ? this.mode : 'memory' }

  // ===== user =====
  async getOrCreateUser({ id, email, firstName, lastName, name, image }) {
    await this.init()
    const now = new Date()
    if (this.mode === 'postgres') {
      const existing = await this.pool.query(`SELECT * FROM "user" WHERE id = $1`, [id])
      if (existing.rows[0]) {
        await this.pool.query(`UPDATE "user" SET updated_at = NOW() WHERE id = $1`, [id])
        return existing.rows[0]
      }
      const fullName = name || [firstName, lastName].filter(Boolean).join(' ') || id
      await this.pool.query(
        `INSERT INTO "user" (id, email, name, image, first_name, last_name, email_not_verified) VALUES ($1,$2,$3,$4,$5,$6,FALSE)`,
        [id, email || `${id}@aasthichain.demo`, fullName, image || null, firstName || null, lastName || null]
      )
      return (await this.pool.query(`SELECT * FROM "user" WHERE id = $1`, [id])).rows[0]
    }
    let u = this.mem.user.get(id)
    if (!u) {
      u = { id, email: email || `${id}@aasthichain.demo`, email_not_verified: false, name: name || id, image: image || null, first_name: firstName || null, last_name: lastName || null, created_at: now, updated_at: now, deleted_at: null }
      this.mem.user.set(id, u)
    } else {
      u.updated_at = now
    }
    return u
  }

  async getUser(id) {
    await this.init()
    if (this.mode === 'postgres') return (await this.pool.query(`SELECT * FROM "user" WHERE id = $1`, [id])).rows[0] || null
    return this.mem.user.get(id) || null
  }

  async listUsers(limit = 50) {
    await this.init()
    if (this.mode === 'postgres') return (await this.pool.query(`SELECT * FROM "user" ORDER BY created_at DESC LIMIT $1`, [limit])).rows
    return [...this.mem.user.values()].slice(0, limit)
  }

  // ===== account (external identity provider link, e.g. Clerk/OAuth) =====
  async createAccount({ userId, provider, type, email, displayName, avatarUrl, externalId }) {
    await this.init()
    const id = uid('acc')
    const row = { id, user_id: userId, account_id: id, email: email || null, display_name: displayName || null, avatar_url: avatarUrl || null, external_identifier: externalId || null, external_id: externalId || null, type: type || 'oauth', provider: provider || 'mock', created_at: new Date(), updated_at: new Date() }
    if (this.mode === 'postgres') {
      await this.pool.query(
        `INSERT INTO account (id, user_id, account_id, email, display_name, avatar_url, external_identifier, external_id, type, provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.id, row.user_id, row.account_id, row.email, row.display_name, row.avatar_url, row.external_identifier, row.external_id, row.type, row.provider]
      )
    } else {
      this.mem.account.set(id, row)
    }
    return row
  }

  // ===== session =====
  async createSession({ userId, token, activeOrganizationId, userAgent, ip, extraData }) {
    await this.init()
    const id = uid('sess')
    const row = { id, user_id: userId, active_organization_id: activeOrganizationId || null, token, user_agent: userAgent || null, ip_address: ip || null, extra_data: extraData || {}, created_at: new Date(), updated_at: new Date() }
    if (this.mode === 'postgres') {
      await this.pool.query(
        `INSERT INTO session (id, user_id, active_organization_id, token, user_agent, ip_address, extra_data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [row.id, row.user_id, row.active_organization_id, row.token, row.user_agent, row.ip_address, JSON.stringify(row.extra_data)]
      )
    } else {
      this.mem.session.set(id, row)
      this.mem.session.set('tok:' + token, row)
    }
    return row
  }

  async getSessionByToken(token) {
    await this.init()
    if (!token) return null
    if (this.mode === 'postgres') {
      const r = await this.pool.query(`SELECT * FROM session WHERE token = $1`, [token])
      return r.rows[0] || null
    }
    return this.mem.session.get('tok:' + token) || null
  }

  async revokeSession(token) {
    await this.init()
    if (this.mode === 'postgres') {
      await this.pool.query(`DELETE FROM session WHERE token = $1`, [token])
      return true
    }
    const s = this.mem.session.get('tok:' + token)
    if (s) { this.mem.session.delete('tok:' + token); this.mem.session.delete(s.id) }
    return true
  }

  // ===== organization =====
  async createOrganization({ name, slug, logo, clientId, metadata }) {
    await this.init()
    const id = uid('org')
    const safeSlug = (slug || name || 'org').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || id
    const row = { id, name, slug: safeSlug, logo: logo || null, client_id: clientId || null, metadata: metadata || {}, created_at: new Date(), updated_at: new Date() }
    if (this.mode === 'postgres') {
      try {
        await this.pool.query(`INSERT INTO organization (id, name, slug, logo, client_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)`, [row.id, row.name, row.slug, row.logo, row.client_id, JSON.stringify(row.metadata)])
      } catch (e) {
        if (String(e.message).includes('duplicate key')) throw new Error('organization slug already exists: ' + row.slug)
        throw e
      }
    } else {
      for (const o of this.mem.organization.values()) {
        if (o.slug === row.slug) throw new Error('organization slug already exists: ' + row.slug)
      }
      this.mem.organization.set(id, row)
    }
    return row
  }

  async listOrganizations() {
    await this.init()
    if (this.mode === 'postgres') return (await this.pool.query(`SELECT * FROM organization ORDER BY created_at DESC LIMIT 100`)).rows
    return [...this.mem.organization.values()]
  }

  async getOrganization(id) {
    await this.init()
    if (this.mode === 'postgres') return (await this.pool.query(`SELECT * FROM organization WHERE id = $1`, [id])).rows[0] || null
    return this.mem.organization.get(id) || null
  }

  // ===== member =====
  async addMember({ organizationId, userId, role }) {
    await this.init()
    const id = uid('mem')
    const row = { id, organization_id: organizationId, user_id: userId, role: role || 'member', created_at: new Date() }
    if (this.mode === 'postgres') {
      const dup = await this.pool.query(`SELECT id FROM member WHERE organization_id = $1 AND user_id = $2`, [organizationId, userId])
      if (dup.rows[0]) return (await this.pool.query(`SELECT * FROM member WHERE id = $1`, [dup.rows[0].id])).rows[0]
      await this.pool.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1,$2,$3,$4)`, [row.id, row.organization_id, row.user_id, row.role])
    } else {
      for (const m of this.mem.member.values()) {
        if (m.organization_id === organizationId && m.user_id === userId) return m
      }
      this.mem.member.set(id, row)
    }
    return row
  }

  async listMembers(organizationId) {
    await this.init()
    if (this.mode === 'postgres') return (await this.pool.query(`SELECT * FROM member WHERE organization_id = $1 ORDER BY created_at`, [organizationId])).rows
    return [...this.mem.member.values()].filter(m => m.organization_id === organizationId)
  }

  async listMembershipsForUser(userId) {
    await this.init()
    if (this.mode === 'postgres') {
      return (await this.pool.query(
        `SELECT m.role, o.id AS organization_id, o.name, o.slug FROM member m JOIN organization o ON o.id = m.organization_id WHERE m.user_id = $1`,
        [userId]
      )).rows
    }
    const out = []
    for (const m of this.mem.member.values()) {
      if (m.user_id !== userId) continue
      const o = this.mem.organization.get(m.organization_id)
      if (o) out.push({ role: m.role, organization_id: o.id, name: o.name, slug: o.slug })
    }
    return out
  }

  // ===== invitation =====
  async createInvitation({ organizationId, email, role, invitedBy, expiresInHours = 168 }) {
    await this.init()
    const id = uid('inv')
    const row = { id, organization_id: organizationId, email: String(email || '').toLowerCase(), role: role || 'member', status: 'pending', expires_at: new Date(Date.now() + expiresInHours * 3600 * 1000), created_at: new Date(), invited_by: invitedBy || null }
    if (this.mode === 'postgres') {
      await this.pool.query(`INSERT INTO invitation (id, organization_id, email, role, status, expires_at, invited_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [row.id, row.organization_id, row.email, row.role, row.status, row.expires_at, row.invited_by])
    } else {
      this.mem.invitation.set(id, row)
    }
    return row
  }

  async acceptInvitation(invitationId, userId) {
    await this.init()
    let inv
    if (this.mode === 'postgres') {
      inv = (await this.pool.query(`SELECT * FROM invitation WHERE id = $1`, [invitationId])).rows[0]
    } else {
      inv = this.mem.invitation.get(invitationId)
    }
    if (!inv) throw new Error('invitation not found: ' + invitationId)
    if (inv.status !== 'pending') throw new Error('invitation already ' + inv.status)
    if (new Date(inv.expires_at) < new Date()) {
      await this.setInvitationStatus(invitationId, 'expired')
      throw new Error('invitation expired')
    }
    await this.setInvitationStatus(invitationId, 'accepted')
    return await this.addMember({ organizationId: inv.organization_id, userId, role: inv.role })
  }

  async setInvitationStatus(id, status) {
    if (this.mode === 'postgres') await this.pool.query(`UPDATE invitation SET status = $2 WHERE id = $1`, [id, status])
    else if (this.mem.invitation.get(id)) this.mem.invitation.get(id).status = status
  }

  async listInvitations(organizationId) {
    await this.init()
    if (this.mode === 'postgres') return (await this.pool.query(`SELECT * FROM invitation WHERE organization_id = $1 ORDER BY created_at DESC`, [organizationId])).rows
    return [...this.mem.invitation.values()].filter(i => i.organization_id === organizationId)
  }

  // ===== verification (email/phone OTP-style) =====
  async createVerification({ identifier, expiresInMinutes = 30 }) {
    await this.init()
    const id = uid('ver')
    const value = String(Math.floor(100000 + Math.random() * 900000)) // 6-digit code
    const row = { id, identifier: String(identifier).toLowerCase(), value, expires_at: new Date(Date.now() + expiresInMinutes * 60 * 1000), updated_at: new Date() }
    if (this.mode === 'postgres') {
      await this.pool.query(`INSERT INTO verification (id, identifier, value, expires_at) VALUES ($1,$2,$3,$4)`, [row.id, row.identifier, row.value, row.expires_at])
    } else {
      this.mem.verification.set(id, row)
    }
    return { id, identifier: row.identifier, expires_at: row.expires_at } // value never returned to client
  }

  async consumeVerification(identifier, value) {
    await this.init()
    const ident = String(identifier).toLowerCase()
    if (this.mode === 'postgres') {
      const r = await this.pool.query(`SELECT * FROM verification WHERE identifier = $1 AND value = $2 AND expires_at > NOW() ORDER BY updated_at DESC LIMIT 1`, [ident, String(value)])
      if (!r.rows[0]) return false
      await this.pool.query(`DELETE FROM verification WHERE identifier = $1`, [ident])
      return true
    }
    for (const [k, v] of this.mem.verification.entries()) {
      if (v.identifier === ident && v.value === String(value)) {
        if (new Date(v.expires_at) < new Date()) return false
        this.mem.verification.delete(k)
        return true
      }
    }
    return false
  }

  // ===== jwt (signing keys) =====
  async getOrCreateJwtKeys() {
    await this.init()
    if (this.mode === 'postgres') {
      const existing = (await this.pool.query(`SELECT * FROM jwt ORDER BY created_at DESC LIMIT 1`)).rows[0]
      if (existing) return existing
    } else {
      for (const j of this.mem.jwt.values()) return j
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const id = uid('jwt')
    const row = { id, token_key: id, public_key: pubPem, private_key: privPem, created_at: new Date(), updated_at: new Date() }
    if (this.mode === 'postgres') {
      await this.pool.query(`INSERT INTO jwt (id, token_key, public_key, private_key) VALUES ($1,$2,$3,$4)`, [row.id, row.token_key, row.public_key, row.private_key])
    } else {
      this.mem.jwt.set(id, row)
    }
    return row
  }

  // JWKS (RFC 7517) from the stored Ed25519 public key — for downstream verifiers
  async getJwks() {
    const row = await this.getOrCreateJwtKeys()
    try {
      const jwk = crypto.createPublicKey(row.public_key).export({ format: 'jwk' })
      return { keys: [{ ...jwk, kid: row.token_key, use: 'sig', alg: 'EdDSA' }] }
    } catch {
      return { keys: [] }
    }
  }

  // ===== project_config =====
  async getProjectConfig() {
    await this.init()
    if (this.mode === 'postgres') {
      const r = (await this.pool.query(`SELECT * FROM project_config ORDER BY created_at LIMIT 1`)).rows[0]
      if (r) return r
    } else {
      for (const c of this.mem.project_config.values()) return c
    }
    return { id: 'pcfg_default', name: 'aasthichain', single_page_app: true, disable_sign_up: false, limited_logins: false, email_at_first_login: false, enabled_providers: [], magic_link_config: {} }
  }

  async upsertProjectConfig(patch) {
    await this.init()
    const current = await this.getProjectConfig()
    const next = { ...current, ...patch, updated_at: new Date() }
    if (this.mode === 'postgres') {
      await this.pool.query(
        `UPDATE project_config SET name=$2, domain_url=$3, cookie_domain=$4, limited_logins=$5, disable_sign_up=$6, enabled_providers=$7, email_at_first_login=$8, single_page_app=$9, magic_link_config=$10, updated_at=NOW() WHERE id=$1`,
        [current.id, next.name || null, next.domain_url || null, next.cookie_domain || null, !!next.limited_logins, !!next.disable_sign_up, JSON.stringify(next.enabled_providers || []), !!next.email_at_first_login, next.single_page_app !== false, JSON.stringify(next.magic_link_config || {})]
      )
      return (await this.pool.query(`SELECT * FROM project_config WHERE id = $1`, [current.id])).rows[0]
    }
    this.mem.project_config.set(current.id, next)
    return next
  }

  // ===== convenience: full login lifecycle =====
  // token: the app's actual session token (mockJWT/Clerk) — stored so
  // GET /api/auth/session can resolve the exact token the client presents.
  async login(identityId, { role, mspId, token, userAgent, ip, provider } = {}) {
    const user = await this.getOrCreateUser({ id: identityId, name: identityId, firstName: identityId.split(/[0-9]/)[0] || identityId })
    // account link per provider (mock provider by default — Clerk/OAuth ready)
    await this.createAccount({ userId: identityId, provider: provider || 'mock', type: 'oauth', email: user.email, displayName: identityId, externalId: identityId })
    const sessionToken = token || Buffer.from(JSON.stringify({ identityId, mspId: mspId || 'InvestorMSP', role: role || 'Investor', exp: Date.now() + 3600000 })).toString('base64')
    const session = await this.createSession({ userId: identityId, token: sessionToken, userAgent, ip, extraData: { role: role || 'Investor', mspId: mspId || 'InvestorMSP' } })
    const memberships = await this.listMembershipsForUser(identityId)
    return { user, session, token, memberships }
  }

  // Entities implemented — traceability to the Neon schema diagram
  static schemaEntities() {
    return [
      { table: 'user', fields: ['id', 'email', 'email_not_verified', 'name', 'image', 'created_at', 'updated_at', 'deleted_at', 'first_name', 'last_name'] },
      { table: 'account', fields: ['id', 'user_id', 'account_id', 'email', 'display_name', 'avatar_url', 'external_identifier', 'external_id', 'type', 'provider', 'created_at', 'updated_at'] },
      { table: 'session', fields: ['id', 'user_id', 'active_organization_id', 'token', 'user_agent', 'ip_address', 'extra_data', 'created_at', 'updated_at'] },
      { table: 'organization', fields: ['id', 'name', 'slug', 'logo', 'client_id', 'metadata', 'created_at', 'updated_at'] },
      { table: 'member', fields: ['id', 'organization_id', 'user_id', 'role', 'created_at'] },
      { table: 'invitation', fields: ['id', 'organization_id', 'email', 'role', 'status', 'expires_at', 'created_at', 'invited_by'] },
      { table: 'verification', fields: ['id', 'identifier', 'value', 'expires_at', 'updated_at'] },
      { table: 'jwt', fields: ['id', 'token_key', 'public_key', 'private_key', 'created_at', 'updated_at'] },
      { table: 'project_config', fields: ['id', 'name', 'org_id', 'domain_url', 'cookie_domain', 'limited_logins', 'disable_sign_up', 'enabled_providers', 'email_at_first_login', 'single_page_app', 'magic_link_config'] }
    ]
  }
}

// Singleton — DIP: app depends on this abstraction
export const authStore = new AuthStore()
export default authStore
