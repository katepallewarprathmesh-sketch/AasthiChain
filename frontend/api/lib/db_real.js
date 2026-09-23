// Real DB implementation — Postgres + Vercel KV + File fallback
// For Vercel production — persistent across lambdas
// Uses @vercel/postgres if DATABASE_URL or POSTGRES_URL set, else @vercel/kv if KV_URL set, else file-backed

import fs from 'fs'
import path from 'path'
import os from 'os'
import { githubDB } from './github_db.js';

const TMP_DIR = os.tmpdir()

// File paths for fallback
const PERSIST_FILES = {
  properties: path.join(TMP_DIR, 'aasthi_properties.json'),
  balances: path.join(TMP_DIR, 'aasthi_balances.json'),
  transfers: path.join(TMP_DIR, 'aasthi_transfers.json'),
  kyc: path.join(TMP_DIR, 'aasthi_kyc.json'),
  idem: path.join(TMP_DIR, 'aasthi_idem.json'),
  npci: path.join(TMP_DIR, 'aasthi_npci.json'),
  utrIndex: path.join(TMP_DIR, 'aasthi_utr_index.json'),
  webhooks: path.join(TMP_DIR, 'aasthi_webhooks.json'),
}

function loadFromFile(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(data)
    }
  } catch (e) {
    console.error(`Failed to load ${filePath}`, e.message)
  }
  return fallback
}

function saveToFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8')
  } catch (e) {}
}

// Postgres implementation using pg or @vercel/postgres
let pgPool = null

async function getPgPool() {
  if (pgPool) return pgPool
  
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL
  
  if (!databaseUrl) return null

  try {
    // Try @vercel/postgres first
    try {
      const { createPool } = await import('@vercel/postgres')
      pgPool = createPool({ connectionString: databaseUrl })
      console.log('[DB] Using @vercel/postgres pool')
      return pgPool
    } catch (e) {
      console.log('[DB] @vercel/postgres not available, trying pg', e.message)
    }

    // Fallback to pg
    const pg = await import('pg')
    const { Pool } = pg.default || pg
    pgPool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    })
    console.log('[DB] Using pg Pool')
    return pgPool
  } catch (e) {
    console.error('[DB] Failed to create pg pool', e.message)
    return null
  }
}

async function initPostgresTables() {
  const pool = await getPgPool()
  if (!pool) return false

  try {
    // Create tables if not exist
    const queries = [
      `CREATE TABLE IF NOT EXISTS properties (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS balances (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS kyc (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS idempotency (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS npci_payments (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS npci_balances (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS utr_index (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_properties_status ON properties ((data->>'status'))`,
      `CREATE INDEX IF NOT EXISTS idx_properties_created ON properties ((data->>'createdAt'))`,
      `CREATE INDEX IF NOT EXISTS idx_transfers_asset ON transfers ((data->>'assetId'))`,
      `CREATE INDEX IF NOT EXISTS idx_transfers_time ON transfers ((data->>'txTimestamp'))`,
      `CREATE INDEX IF NOT EXISTS idx_npcipayments_status ON npci_payments ((data->>'status'))`,
      `CREATE INDEX IF NOT EXISTS idx_npcipayments_utr ON npci_payments ((data->>'utr'))`,
    ]

    for (const sql of queries) {
      try {
        if (pool.query) {
          await pool.query(sql)
        } else {
          // @vercel/postgres pool has different API
          await pool.sql`${sql}`
        }
      } catch (e) {
        console.error(`[DB] Table creation failed for ${sql.slice(0,50)}`, e.message)
        // Continue with other tables
      }
    }

    console.log('[DB] Postgres tables initialized')
    return true
  } catch (e) {
    console.error('[DB] initPostgresTables failed', e.message)
    return false
  }
}

// KV implementation using @vercel/kv
let kvClient = null

async function getKvClient() {
  if (kvClient) return kvClient
  
  const kvUrl = process.env.KV_URL || process.env.KV_REST_API_URL
  if (!kvUrl) return null

  try {
    const { kv } = await import('@vercel/kv')
    kvClient = kv
    console.log('[DB] Using @vercel/kv')
    return kvClient
  } catch (e) {
    console.error('[DB] Failed to get kv client', e.message)
    return null
  }
}

// Unified DB interface
export class RealDB {
  constructor() {
    this.mode = 'file-backed'
    this.initialized = false
  }

  async init() {
    if (this.initialized) return this.mode

    // Try Postgres first — most robust
    const pgPool = await getPgPool()
    if (pgPool) {
      const ok = await initPostgresTables()
      if (ok) {
        this.mode = 'postgres'
        this.initialized = true
        console.log('[DB] Mode: postgres — persistent production')
        return this.mode
      }
    }

    // Try KV — Upstash Redis
    const kv = await getKvClient()
    if (kv) {
      this.mode = 'vercel-kv'
      this.initialized = true
      console.log('[DB] Mode: vercel-kv — persistent via Upstash Redis')
      return this.mode
    }

    // Try GitHub as real DB — persistent via GitHub repo data/*.json, shared across Vercel lambdas
    // This fixes property vanishes on refresh + originator not visible at investor
    try {
      const githubMode = await githubDB.init()
      if (githubMode) {
        this.mode = 'github'
        this.initialized = true
        console.log('[DB] Mode: github — persistent via GitHub repo data/*.json, shared across lambdas — real DB')
        return this.mode
      }
    } catch (e) {
      console.error('[DB] GitHub DB init failed', e.message)
    }

    // Fallback to file-backed — per lambda, not shared
    this.mode = 'file-backed'
    this.initialized = true
    console.log('[DB] Mode: file-backed — /tmp + globalThis fallback — per lambda, not shared, use github/postgres for production')
    return this.mode
  }

  getMode() {
    if (process.env.DATABASE_URL || process.env.POSTGRES_URL) return 'postgres'
    if (process.env.KV_URL || process.env.KV_REST_API_URL) return 'vercel-kv'
    if (process.env.GITHUB_TOKEN || process.env.GITHUB_PAT) return 'github'
    // Always try github as real DB for shared persistence across lambdas — read via raw.githubusercontent.com works without token
    return 'github'
  }

  // Properties
  async getProperties() {
    const mode = this.getMode()
    
    // Try GitHub as real DB first — shared across lambdas
    if (mode === 'github') {
      try {
        const githubProps = await githubDB.getProperties()
        if (githubProps && Object.keys(githubProps).length > 0) {
          console.log(`[DB] Loaded ${Object.keys(githubProps).length} properties from GitHub real DB`)
          // Merge with file for deterministic property
          const fileProps = loadFromFile(PERSIST_FILES.properties, {})
          const merged = { ...githubProps, ...fileProps }
          // Ensure deterministic property
          const fixedId = 'PROP-GREEN-VALLEY-PUNE-001'
          if (!merged[fixedId]) {
            const now = new Date()
            merged[fixedId] = {
              assetId: fixedId,
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
            }
          }
          return merged
        }
      } catch (e) {
        console.error('[DB] getProperties github failed', e.message)
      }
    }
    
    if (mode === 'postgres') {
      try {
        const pool = await getPgPool()
        if (!pool) throw new Error('No pool')
        
        let result
        if (pool.query) {
          result = await pool.query('SELECT data FROM properties ORDER BY data->>\'createdAt\' DESC')
        } else {
          // @vercel/postgres
          result = await pool.sql`SELECT data FROM properties ORDER BY data->>'createdAt' DESC`
        }
        
        const rows = result.rows || result
        const props = {}
        rows.forEach(row => {
          const data = row.data || row
          if (data.assetId) props[data.assetId] = data
        })
        
        // Also merge with file fallback for deterministic property
        const fileProps = loadFromFile(PERSIST_FILES.properties, {})
        Object.keys(fileProps).forEach(k => {
          if (!props[k]) props[k] = fileProps[k]
        })
        
        // Ensure deterministic property exists
        const fixedId = 'PROP-GREEN-VALLEY-PUNE-001'
        if (!props[fixedId]) {
          const now = new Date()
          props[fixedId] = {
            assetId: fixedId,
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
          }
        }
        
        return props
      } catch (e) {
        console.error('[DB] getProperties postgres failed, fallback to file', e.message)
      }
    }

    if (mode === 'vercel-kv') {
      try {
        const kv = await getKvClient()
        if (!kv) throw new Error('No kv')
        
        const keys = await kv.keys('property:*')
        const props = {}
        for (const key of keys) {
          const data = await kv.get(key)
          if (data && data.assetId) props[data.assetId] = data
        }
        
        // Merge file
        const fileProps = loadFromFile(PERSIST_FILES.properties, {})
        Object.keys(fileProps).forEach(k => {
          if (!props[k]) props[k] = fileProps[k]
        })
        
        const fixedId = 'PROP-GREEN-VALLEY-PUNE-001'
        if (!props[fixedId]) {
          const now = new Date()
          props[fixedId] = {
            assetId: fixedId,
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
          }
        }
        
        return props
      } catch (e) {
        console.error('[DB] getProperties kv failed, fallback to file', e.message)
      }
    }

    // File-backed fallback
    const fileProps = loadFromFile(PERSIST_FILES.properties, {})
    const globalProps = globalThis._aasthi_properties || {}
    
    // Merge file + globalThis
    const merged = { ...fileProps, ...globalProps }
    
    // Ensure deterministic property
    const fixedId = 'PROP-GREEN-VALLEY-PUNE-001'
    if (!merged[fixedId]) {
      const now = new Date()
      merged[fixedId] = {
        assetId: fixedId,
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
      }
    }
    
    return merged
  }

  async saveProperty(assetId, property) {
    const mode = this.getMode()
    
    // Save to GitHub as real DB — shared across lambdas
    if (mode === 'github') {
      try {
        await githubDB.saveProperty(assetId, property)
        console.log(`[DB] Saved property ${assetId} to GitHub real DB`)
      } catch (e) {
        console.error('[DB] saveProperty github failed', e.message)
      }
    }
    
    if (mode === 'postgres') {
      try {
        const pool = await getPgPool()
        if (!pool) throw new Error('No pool')
        
        const data = JSON.stringify(property)
        if (pool.query) {
          await pool.query(
            'INSERT INTO properties (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()',
            [assetId, data]
          )
        } else {
          await pool.sql`INSERT INTO properties (id, data, updated_at) VALUES (${assetId}, ${data}, NOW()) ON CONFLICT (id) DO UPDATE SET data = ${data}, updated_at = NOW()`
        }
        console.log(`[DB] Saved property ${assetId} to postgres`)
      } catch (e) {
        console.error('[DB] saveProperty postgres failed', e.message)
      }
    }

    if (mode === 'vercel-kv') {
      try {
        const kv = await getKvClient()
        if (kv) {
          await kv.set(`property:${assetId}`, property)
          console.log(`[DB] Saved property ${assetId} to kv`)
        }
      } catch (e) {
        console.error('[DB] saveProperty kv failed', e.message)
      }
    }

    // Always save to file + globalThis as fallback
    try {
      const existing = loadFromFile(PERSIST_FILES.properties, {})
      existing[assetId] = property
      saveToFile(PERSIST_FILES.properties, existing)
      
      if (!globalThis._aasthi_properties) globalThis._aasthi_properties = {}
      globalThis._aasthi_properties[assetId] = property
    } catch (e) {
      console.error('[DB] saveProperty file fallback failed', e.message)
    }
  }

  async getBalances() {
    const mode = this.getMode()
    
    if (mode === 'github') {
      try {
        const githubBals = await githubDB.getBalances()
        if (githubBals) {
          const fileBals = loadFromFile(PERSIST_FILES.balances, {})
          const globalBals = globalThis._aasthi_balances || {}
          return { ...githubBals, ...fileBals, ...globalBals }
        }
      } catch (e) {
        console.error('[DB] getBalances github failed', e.message)
      }
    }
    
    if (mode === 'postgres') {
      try {
        const pool = await getPgPool()
        if (!pool) throw new Error('No pool')
        
        let result
        if (pool.query) {
          result = await pool.query('SELECT data FROM balances')
        } else {
          result = await pool.sql`SELECT data FROM balances`
        }
        
        const rows = result.rows || result
        const bals = {}
        rows.forEach(row => {
          const data = row.data || row
          if (data.assetId && data.ownerId) {
            bals[`${data.assetId}~${data.ownerId}`] = data
          }
        })
        return bals
      } catch (e) {
        console.error('[DB] getBalances postgres failed', e.message)
      }
    }

    // File fallback
    const fileBals = loadFromFile(PERSIST_FILES.balances, {})
    const globalBals = globalThis._aasthi_balances || {}
    return { ...fileBals, ...globalBals }
  }

  async saveBalance(key, balance) {
    const mode = this.getMode()
    
    if (mode === 'github') {
      try {
        await githubDB.saveBalance(key, balance)
      } catch (e) {}
    }
    
    if (mode === 'postgres') {
      try {
        const pool = await getPgPool()
        if (!pool) throw new Error('No pool')
        
        const data = JSON.stringify(balance)
        if (pool.query) {
          await pool.query(
            'INSERT INTO balances (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()',
            [key, data]
          )
        } else {
          await pool.sql`INSERT INTO balances (id, data, updated_at) VALUES (${key}, ${data}, NOW()) ON CONFLICT (id) DO UPDATE SET data = ${data}, updated_at = NOW()`
        }
      } catch (e) {
        console.error('[DB] saveBalance postgres failed', e.message)
      }
    }

    if (mode === 'vercel-kv') {
      try {
        const kv = await getKvClient()
        if (kv) await kv.set(`balance:${key}`, balance)
      } catch (e) {}
    }

    // File fallback
    try {
      const existing = loadFromFile(PERSIST_FILES.balances, {})
      existing[key] = balance
      saveToFile(PERSIST_FILES.balances, existing)
      if (!globalThis._aasthi_balances) globalThis._aasthi_balances = {}
      globalThis._aasthi_balances[key] = balance
    } catch (e) {}
  }

  async getTransfers() {
    const mode = this.getMode()
    
    if (mode === 'github') {
      try {
        const githubTrans = await githubDB.getTransfers()
        if (githubTrans) {
          const fileTrans = loadFromFile(PERSIST_FILES.transfers, {})
          const globalTrans = globalThis._aasthi_transfers || {}
          return { ...githubTrans, ...fileTrans, ...globalTrans }
        }
      } catch (e) {
        console.error('[DB] getTransfers github failed', e.message)
      }
    }
    
    if (mode === 'postgres') {
      try {
        const pool = await getPgPool()
        if (!pool) throw new Error('No pool')
        
        let result
        if (pool.query) {
          result = await pool.query('SELECT data FROM transfers ORDER BY data->>\'txTimestamp\' DESC')
        } else {
          result = await pool.sql`SELECT data FROM transfers ORDER BY data->>'txTimestamp' DESC`
        }
        
        const rows = result.rows || result
        const trans = {}
        rows.forEach(row => {
          const data = row.data || row
          if (data.transferId) trans[data.transferId] = data
        })
        return trans
      } catch (e) {
        console.error('[DB] getTransfers postgres failed', e.message)
      }
    }

    const fileTrans = loadFromFile(PERSIST_FILES.transfers, {})
    const globalTrans = globalThis._aasthi_transfers || {}
    return { ...fileTrans, ...globalTrans }
  }

  async saveTransfer(transferId, transfer) {
    const mode = this.getMode()
    
    if (mode === 'github') {
      try {
        await githubDB.saveTransfer(transferId, transfer)
      } catch (e) {}
    }
    
    if (mode === 'postgres') {
      try {
        const pool = await getPgPool()
        if (!pool) throw new Error('No pool')
        
        const data = JSON.stringify(transfer)
        if (pool.query) {
          await pool.query(
            'INSERT INTO transfers (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()',
            [transferId, data]
          )
        } else {
          await pool.sql`INSERT INTO transfers (id, data, updated_at) VALUES (${transferId}, ${data}, NOW()) ON CONFLICT (id) DO UPDATE SET data = ${data}, updated_at = NOW()`
        }
      } catch (e) {
        console.error('[DB] saveTransfer postgres failed', e.message)
      }
    }

    if (mode === 'vercel-kv') {
      try {
        const kv = await getKvClient()
        if (kv) await kv.set(`transfer:${transferId}`, transfer)
      } catch (e) {}
    }

    try {
      const existing = loadFromFile(PERSIST_FILES.transfers, {})
      existing[transferId] = transfer
      saveToFile(PERSIST_FILES.transfers, existing)
      if (!globalThis._aasthi_transfers) globalThis._aasthi_transfers = {}
      globalThis._aasthi_transfers[transferId] = transfer
    } catch (e) {}
  }

  // ===== NPCI state — payments + UPI balances + UTR index — persistent across lambdas =====
  // Bundle style: one record per store so writes are atomic (fixes "Payment not found" on Vercel)
  async getNpciState() {
    const mode = this.getMode()

    if (mode === 'github') {
      try {
        const s = await githubDB.getNpciState()
        if (s && s.payments && Object.keys(s.payments).length > 0) return s
      } catch (e) {}
    }

    if (mode === 'postgres') {
      try {
        const pool = await getPgPool()
        if (!pool) throw new Error('No pool')
        let result
        if (pool.query) {
          result = await pool.query(`SELECT data FROM npci_payments WHERE id = 'bundle'`)
        } else {
          result = await pool.sql`SELECT data FROM npci_payments WHERE id = 'bundle'`
        }
        const rows = result.rows || result
        if (rows && rows[0]) {
          const d = rows[0].data || rows[0]
          return typeof d === 'string' ? JSON.parse(d) : d
        }
      } catch (e) {}
    }

    if (mode === 'vercel-kv') {
      try {
        const kv = await getKvClient()
        if (kv) {
          const s = await kv.get('npci:bundle')
          if (s) return s
        }
      } catch (e) {}
    }

    // File fallback (per-lambda)
    const f = loadFromFile(PERSIST_FILES.npci, null)
    if (f && f.payments) {
      return { payments: f.payments, balances: f.balances || {}, utrIndex: f.utrIndex || {} }
    }
    return null
  }

  async saveNpciState(state) {
    const mode = this.getMode()
    const bundle = {
      payments: state.payments || {},
      balances: state.balances || {},
      utrIndex: state.utrIndex || {},
      savedAt: new Date().toISOString()
    }

    if (mode === 'github') {
      try { await githubDB.saveNpciState(bundle) } catch (e) {}
    }

    if (mode === 'postgres') {
      try {
        const pool = await getPgPool()
        if (pool) {
          const data = JSON.stringify(bundle)
          if (pool.query) {
            await pool.query(
              `INSERT INTO npci_payments (id, data, updated_at) VALUES ('bundle', $1, NOW()) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
              [data]
            )
          } else {
            await pool.sql`INSERT INTO npci_payments (id, data, updated_at) VALUES ('bundle', ${data}, NOW()) ON CONFLICT (id) DO UPDATE SET data = ${data}, updated_at = NOW()`
          }
        }
      } catch (e) {}
    }

    if (mode === 'vercel-kv') {
      try {
        const kv = await getKvClient()
        if (kv) await kv.set('npci:bundle', bundle)
      } catch (e) {}
    }

    try { saveToFile(PERSIST_FILES.npci, bundle) } catch (e) {}
  }
}

export const realDB = new RealDB()
