// Rail backfill: dry run only. This script never writes.
//
// It reads the operator queues from a deployment, classifies every candidate
// payment, and prints what a backfill would do. Nothing here touches the rail
// and nothing here commits a block. Running it is always safe.
//
// Why a dry run exists at all: the rail's ledger is append-only. A block
// written in error cannot be removed, only compensated, which leaves the
// mistake visible in the history forever. So the classification gets looked
// at by a person before anything is written.
//
//   node scripts/backfill-dryrun.mjs
//   APP=https://aasthi-chain.vercel.app ADMIN_KEY=... node scripts/backfill-dryrun.mjs

const APP = (process.env.APP || 'https://aasthi-chain.vercel.app').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

const ops = await fetch(`${APP}/api/admin/ops`, { headers: { 'x-admin-key': ADMIN_KEY } })
  .then((r) => r.json());

if (!ops || !ops.queues) {
  console.error('Could not read the operator queues. Check APP and ADMIN_KEY.');
  process.exit(1);
}

const stuck = ops.queues.stuckPayments || [];
const expired = ops.queues.expiredPending || [];
const sum = (rows) => rows.reduce((a, r) => a + (r.amountINR || 0), 0);

console.log(`\nSource: ${APP}`);
console.log(`Read at: ${ops.generatedAt}\n`);

console.log('CANDIDATES AS THEY ACTUALLY ARE');
console.log(`  stuck payments   ${String(stuck.length).padStart(3)} rows   ${inr(sum(stuck))}`);
console.log(`  expired pending  ${String(expired.length).padStart(3)} rows   ${inr(sum(expired))}`);
console.log(`  total            ${String(stuck.length + expired.length).padStart(3)} rows   ${inr(sum(stuck) + sum(expired))}\n`);

// The distinction that decides the whole exercise.
console.log('CLASSIFICATION');
console.log('  SETTLE-ABLE  a payment whose money was captured but whose tokens');
console.log('               never moved. The ledger is missing a settlement that');
console.log('               really happened, so writing it corrects the record.');
console.log('  MUST NOT     a payment that never completed. No money was captured.');
console.log('               Writing a settlement would create ownership against');
console.log('               cash that does not exist, which is not a backfill, it');
console.log('               is an invention.\n');

const settleable = stuck.filter((r) => (r.tokenAmount || 0) > 0);
const noTokens = stuck.filter((r) => !(r.tokenAmount || 0));

console.log('VERDICT');
console.log(`  settle-able        ${String(settleable.length).padStart(3)} rows   ${inr(sum(settleable))}`);
console.log(`  stuck, no token qty ${String(noTokens.length).padStart(2)} rows   ${inr(sum(noTokens))}   (cannot size the securities leg)`);
console.log(`  expired, excluded  ${String(expired.length).padStart(3)} rows   ${inr(sum(expired))}   (never captured)\n`);

if (settleable.length) {
  console.log('WHAT WOULD BE WRITTEN (settle-able only)');
  for (const r of settleable) {
    console.log(`  ${r.paymentId}  ${r.payerId.padEnd(12)} ${String(r.tokenAmount).padStart(5)} tok  ${inr(r.amountINR).padStart(12)}  ${r.assetId}`);
  }
  console.log(`\n  ${settleable.length} blocks, ${inr(sum(settleable))} total.\n`);
}

console.log('NOT EXECUTED. This script has no write path by design.');
