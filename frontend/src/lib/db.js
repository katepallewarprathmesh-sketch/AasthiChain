// Database abstraction layer supports file-backed (hackathon) and Postgres (production)
// Phase 4: Persistent production database
// Usage: const db = getDB(); await db.properties.get(id)

import fs from 'fs'
import path from 'path'
import os from 'os'

const TMP_DIR = os.tmpdir()

// File-backed store (current)
class FileStore {
  constructor(filePath, defaultValue = {}) {
    this.filePath = filePath
    this.defaultValue = defaultValue
    this.cache = null
  }

  load() {
    if (this.cache) return this.cache
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8')
        this.cache = JSON.parse(data)
        return this.cache
      }
    } catch (e) {
      console.error(`FileStore load failed ${this.filePath}`, e.message)
    }
    this.cache = this.defaultValue
    return this.cache
  }

  save(data) {
    this.cache = data
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf8')
    } catch (e) {
      // /tmp may not be writable
    }
    return data
  }

  get(key) {
    const all = this.load()
    return key ? all[key] : all
  }

  set(key, value) {
    const all = this.load()
    all[key] = value
    return this.save(all)
  }

  delete(key) {
    const all = this.load()
    delete all[key]
    return this.save(all)
  }

  all() {
    return this.load()
  }
}

// Postgres store (production) lazy loaded only if DATABASE_URL set
class PostgresStore {
  constructor(tableName) {
    this.tableName = tableName
    this.pool = null
  }

  async getPool() {
    if (this.pool) return this.pool
    try {
      // Dynamic import to avoid bundling pg in frontend
      const { Pool } = await import('pg')
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      })
      return this.pool
    } catch (e) {
      console.error('Postgres Pool failed', e.message)
      throw e
    }
  }

  async get(key) {
    const pool = await this.getPool()
    if (!key) {
      const res = await pool.query(`SELECT data FROM ${this.tableName}`)
      const all = {}
      res.rows.forEach(row => {
        const d = row.data
        all[d.assetId || d.paymentId || d.transferId || d.identityId || 'unknown'] = d
      })
      return all
    }
    const res = await pool.query(`SELECT data FROM ${this.tableName} WHERE id = $1`, [key])
    return res.rows[0]?.data || null
  }

  async set(key, value) {
    const pool = await this.getPool()
    await pool.query(
      `INSERT INTO ${this.tableName} (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    )
    return value
  }

  async delete(key) {
    const pool = await this.getPool()
    await pool.query(`DELETE FROM ${this.tableName} WHERE id = $1`, [key])
  }

  async all() {
    return this.get(null)
  }
}

// Factory
function createStore(name, filePath, defaultValue) {
  if (process.env.DATABASE_URL) {
    // Production: use Postgres
    return new PostgresStore(name)
  }
  // Hackathon: file-backed + globalThis fallback (existing behavior)
  return new FileStore(filePath, defaultValue)
}

// Global stores (singleton)
let stores = null

export function getDB() {
  if (stores) return stores

  const isPostgres = !!process.env.DATABASE_URL

  stores = {
    mode: isPostgres ? 'postgres' : 'file-backed',
    properties: createStore('properties', path.join(TMP_DIR, 'aasthi_properties.json'), {}),
    balances: createStore('balances', path.join(TMP_DIR, 'aasthi_balances.json'), {}),
    transfers: createStore('transfers', path.join(TMP_DIR, 'aasthi_transfers.json'), {}),
    kyc: createStore('kyc', path.join(TMP_DIR, 'aasthi_kyc.json'), {}),
    idempotency: createStore('idempotency', path.join(TMP_DIR, 'aasthi_idem.json'), {}),
    npciPayments: createStore('npci_payments', path.join(TMP_DIR, 'aasthi_npci.json'), {}),
    npciBalances: createStore('npci_balances', path.join(TMP_DIR, 'aasthi_npci_balances.json'), {}),
    utrIndex: createStore('utr_index', path.join(TMP_DIR, 'aasthi_utr_index.json'), {}),
    webhooks: createStore('webhooks', path.join(TMP_DIR, 'aasthi_webhooks.json'), []),

    // Helper to check if using Postgres
    isPersistent: () => isPostgres,
    isFileBacked: () => !isPostgres,

    // Migration helper init tables
    async init() {
      if (!isPostgres) {
        console.log('[DB] Using file-backed store (hackathon mode) /tmp/aasthi_*.json + globalThis')
        return { mode: 'file-backed', message: 'File-backed persistence survives warm instances, use Postgres for production' }
      }
      try {
        const pool = await this.properties.getPool()
        // Create tables if not exist
        await pool.query(`
          CREATE TABLE IF NOT EXISTS properties (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE TABLE IF NOT EXISTS balances (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE TABLE IF NOT EXISTS kyc (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE TABLE IF NOT EXISTS idempotency (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE TABLE IF NOT EXISTS npci_payments (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE TABLE IF NOT EXISTS npci_balances (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE TABLE IF NOT EXISTS utr_index (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ);
          CREATE INDEX IF NOT EXISTS idx_properties_status ON properties ((data->>'status'));
          CREATE INDEX IF NOT EXISTS idx_transfers_asset ON transfers ((data->>'assetId'));
          CREATE INDEX IF NOT EXISTS idx_npcipayments_status ON npci_payments ((data->>'status'));
          CREATE INDEX IF NOT EXISTS idx_npcipayments_utr ON npci_payments ((data->>'utr'));
        `)
        console.log('[DB] Postgres initialized tables created')
        return { mode: 'postgres', message: 'Postgres persistent production ready' }
      } catch (e) {
        console.error('[DB] Postgres init failed', e.message)
        return { mode: 'file-backed-fallback', error: e.message }
      }
    }
  }

  return stores
}

// For API routes get store with globalThis fallback (existing behavior, no break)
export function getStoreWithFallback(name, globalKey, defaultValue) {
  const db = getDB()
  const store = db[name]
  // If file-backed, also sync with globalThis for backward compatibility
  if (!process.env.DATABASE_URL) {
    const globalData = globalThis[globalKey]
    if (globalData && Object.keys(globalData).length > 0) {
      // Merge globalThis into file store if file empty
      const fileData = store.all()
      if (Object.keys(fileData).length === 0) {
        store.save(globalData)
      }
    }
  }
  return store
}

export default getDB
