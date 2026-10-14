#!/usr/bin/env node
// Does my Neon database actually hold AasthiChain's data?
//
// Connects with DATABASE_URL and reports every table this project writes,
// whether it exists, and how many rows are in it. Read-only: it runs SELECT
// and nothing else, so it is safe against production.
//
//   DATABASE_URL='postgresql://...sslmode=require' node scripts/neon-check.mjs
//
// Run it twice, once against the rail's connection string and once against
// the app's, to prove both are pointed at the same database.

import pg from '../frontend/node_modules/pg/lib/index.js'

const DSN = process.env.DATABASE_URL || process.env.POSTGRES_URL || ''
if (!DSN) {
  console.error('Set DATABASE_URL to your Neon connection string (the pooled one, keep ?sslmode=require).')
  process.exit(2)
}

// Written by drunix-gateway (Go, on Render).
const RAIL = [
  ['umi_block', 'the ledger itself, append-only'],
  ['umi_wallet', 'e-rupee-W wallet balances'],
  ['umi_position', 'token holdings per asset and holder'],
  ['umi_isin', 'pilot ISIN assignments'],
  ['umi_instruction', 'settlement instructions and their outcome'],
  ['umi_servicing', 'rent and coupon payouts'],
  ['umi_meta', 'funded total, settled and failed counters'],
  ['umi_idempotency', 'replayed responses for retried POSTs'],
  ['umi_outbox', 'events still waiting to be published'],
]

// Written by the Node app (Vercel).
const APP = [
  ['properties', 'listings'],
  ['balances', 'token balances held by the app'],
  ['transfers', 'transfer history'],
  ['npci_payments', 'UPI collect requests'],
  ['npci_balances', 'UPI-side balances'],
  ['utr_index', 'UTR to payment lookup'],
  ['idempotency', 'app-side idempotency keys'],
  ['webhooks', 'received webhook deliveries'],
  ['kyc', 'KYC records'],
  ['account', 'auth accounts'],
  ['session', 'auth sessions'],
  ['project_config', 'deployment configuration'],
]

const client = new pg.Client({ connectionString: DSN, ssl: { rejectUnauthorized: false } })

function host(dsn) {
  try { return new URL(dsn).host } catch { return '(unparseable)' }
}

async function report(title, tables) {
  console.log(`\n${title}`)
  let present = 0, rows = 0
  for (const [t, what] of tables) {
    let line
    try {
      const r = await client.query(`SELECT count(*)::int AS n FROM "${t}"`)
      const n = r.rows[0].n
      present++; rows += n
      line = `  ${String(n).padStart(7)}  ${t.padEnd(16)} ${what}`
    } catch (e) {
      line = e.code === '42P01'
        ? `        -  ${t.padEnd(16)} not created yet`
        : `    ERROR  ${t.padEnd(16)} ${e.message}`
    }
    console.log(line)
  }
  console.log(`  ${present}/${tables.length} tables present, ${rows} rows`)
  return present
}

try {
  await client.connect()
  console.log(`Connected to ${host(DSN)}`)
  const db = await client.query('SELECT current_database() AS db, version() AS v')
  console.log(`Database: ${db.rows[0].db}`)
  console.log(`Server:   ${db.rows[0].v.split(',')[0]}`)

  const rail = await report('Settlement rail (drunix-gateway, Go):', RAIL)
  const app = await report('Application (Node):', APP)

  console.log('\nReading:')
  if (rail === 0 && app === 0) {
    console.log('  Nothing here yet. Either this is the wrong database, or neither')
    console.log('  service has started against it. Tables are created on first start.')
  } else if (rail === 0) {
    console.log('  The app writes here, the rail does not. Set DATABASE_URL on the')
    console.log('  rail (Render) to this same string and restart it.')
  } else if (app === 0) {
    console.log('  The rail writes here, the app does not. Set DATABASE_URL on the')
    console.log('  app (Vercel) to this same string and redeploy.')
  } else {
    console.log('  Both the rail and the app are writing to this database.')
  }

  // The chain is the one table where a count alone can mislead: it has to be
  // continuous to mean anything.
  try {
    const h = await client.query('SELECT count(*)::int AS n, min(height)::int AS lo, max(height)::int AS hi FROM umi_block')
    const { n, lo, hi } = h.rows[0]
    if (n > 0) {
      const gaps = hi - lo + 1 - n
      console.log(`\nChain: ${n} blocks, heights ${lo} to ${hi}${gaps ? `, ${gaps} MISSING` : ', no gaps'}`)
      if (gaps) console.log('  A gap means blocks were deleted. The rail verifies linkage at boot and will refuse to extend a broken chain.')
    }
  } catch { /* table absent, already reported above */ }
} catch (e) {
  console.error(`\nCould not connect: ${e.message}`)
  console.error('Check the string is the POOLED Neon connection string and still ends with ?sslmode=require.')
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
