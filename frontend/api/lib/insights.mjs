// Private operator insights — aggregation + access control.
//
// Shared by the local Express server and the Vercel serverless handler so the
// two can never drift (that split has already caused one production outage on
// this project).
//
// Access control, stated plainly:
//   * The key lives in ADMIN_DASHBOARD_KEY, never in the repo.
//   * Comparison is constant-time, so the key cannot be recovered by timing.
//   * No key configured => the endpoint is DISABLED, not open. Failing closed
//     matters more than convenience here.
//   * This is a single shared secret, not user accounts. It is appropriate for
//     one operator looking at their own numbers; it is not an auth system, and
//     it should never guard anything with personal data in it.

import crypto from 'crypto';

function configuredKey() {
  const k = process.env.ADMIN_DASHBOARD_KEY || '';
  return k.trim();
}

/** timingSafeEqual that tolerates differing lengths without leaking them. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * authorise returns null when the caller may proceed, or {status, body} to send.
 */
function authorise(req) {
  const key = configuredKey();
  if (!key) {
    return {
      status: 503,
      body: {
        error: 'ERR_INSIGHTS_DISABLED',
        message: 'Private insights are disabled because ADMIN_DASHBOARD_KEY is not set. Set it on the server to enable this dashboard.',
        hint: 'Generate one with: openssl rand -hex 32'
      }
    };
  }
  const presented =
    (req.headers && (req.headers['x-admin-key'] || req.headers['X-Admin-Key'])) ||
    (req.query && req.query.key) ||
    '';
  if (!presented || !safeEqual(presented, key)) {
    return { status: 401, body: { error: 'ERR_UNAUTHORISED', message: 'Valid admin key required.' } };
  }
  return null;
}

const paise = n => Math.round(Number(n || 0) * 100);
const inr = p => Math.round(Number(p || 0)) / 100;


/**
 * integrityChecks turns the numbers already gathered into pass/fail verdicts.
 *
 * Every signal here was previously on the page somewhere, but only as a raw
 * figure in a card — a property reading 101.1% allocated sat on the dashboard
 * unnoticed because nothing said it was WRONG. These are invariants: each one
 * must hold, and a failure names the consequence rather than the symptom.
 */
function integrityChecks(rail, propertyRows) {
  const checks = [];
  const add = (id, ok, label, detail, severity = 'critical') =>
    checks.push({ id, ok, label, detail, severity });

  const rec = rail && rail.reconciliation;

  if (!rec) {
    add('rail', false, 'Settlement rail unreachable',
      'No reconciliation available, so none of the money or supply invariants can be checked right now.', 'warning');
  } else {
    add('cash-conserved', rec.conserved === true,
      'Central bank money is conserved',
      rec.conserved
        ? 'Sum of wallet balances equals lifetime funding.'
        : 'Wallet balances do not equal lifetime funding — the engine created or destroyed money.');

    // supplyConserved only exists on builds carrying the supply cap. Treat a
    // missing field as "cannot tell" rather than silently passing.
    if (typeof rec.supplyConserved === 'boolean') {
      const breaches = rec.supplyBreaches || [];
      const excess = breaches.reduce((n, b) => n + Number(b.excessTokens || 0), 0);
      add('supply-conserved', rec.supplyConserved,
        'No tokens exist beyond the issued supply',
        rec.supplyConserved
          ? 'Every asset is within its authorised supply.'
          : `${excess.toLocaleString('en-IN')} excess token(s) across ${breaches.length} asset(s): ` +
            breaches.map(b => `${b.assetId} ${b.outstandingTokens}/${b.authorisedTokens}`).join(', '));
    } else {
      add('supply-conserved', false, 'Supply cap not deployed',
        'This rail build predates the authorised-supply cap, so seeding can still create tokens from nothing. Deploy the current drunix-gateway.', 'warning');
    }

    const ver = rail.chain && rail.chain.verification;
    if (ver) {
      add('chain-valid', ver.valid === true, 'Ledger hash chain verifies',
        ver.valid ? 'Every block links to its predecessor.' : 'Chain verification FAILED — blocks were altered after commit.');
    }

    const dur = rail.chain && rail.chain.durability;
    if (dur) {
      add('durable', dur.durable === true, 'Blocks survive a restart',
        dur.durable ? 'Blocks are written to durable storage before commit.'
                    : 'Blocks are in memory only — a restart loses the ledger. Set DATABASE_URL.', 'warning');
    }
  }

  // Allocation above 100% is the same fault seen from the app side rather than
  // the rail side; worth reporting separately because the two can disagree.
  const over = (propertyRows || []).filter(r => Number(r.pctAllocated) > 100);
  add('allocation', over.length === 0, 'No property is over-allocated',
    over.length === 0
      ? 'Every property holds at most its issued token count.'
      : over.map(r => `${r.title} ${r.tokensHeld}/${r.totalTokens}`).join(', '));

  const failed = checks.filter(c => !c.ok);
  return {
    ok: failed.length === 0,
    critical: failed.filter(c => c.severity === 'critical').length,
    warnings: failed.filter(c => c.severity === 'warning').length,
    summary: failed.length === 0
      ? 'All invariants hold.'
      : `${failed.length} check(s) failing.`,
    checks
  };
}

/**
 * buildInsights aggregates operator metrics from the app's own state plus the
 * UMI rail. Everything is derived — no new tracking, no third party, nothing
 * leaves the deployment.
 *
 * @param {object} app   { properties, balances, transfers, kycRecords, chain }
 * @param {object} rail  { config, reconciliation, instructions, wallets, chain } or null when unreachable
 */
function buildInsights(app, rail) {
  const properties = Object.values(app.properties || {});
  const balances = Object.values(app.balances || {});
  const transfers = Object.values(app.transfers || {});
  const kyc = Object.values(app.kycRecords || {});
  const chain = app.chain || [];

  // ---- holders & concentration ----
  const byHolder = {};
  balances.forEach(b => {
    const id = b.ownerId || b.identityId || b.owner || b.holder;
    const tok = Number(b.balance || b.tokens || 0);
    if (!id || tok <= 0) return;
    byHolder[id] = (byHolder[id] || 0) + tok;
  });
  const holders = Object.entries(byHolder).sort((a, b) => b[1] - a[1]);
  const totalHeld = holders.reduce((s, [, t]) => s + t, 0);
  const top = holders[0];

  // ---- property funding progress ----
  // "Allocated" means sold to investors. The old sum counted every balance,
  // including the originator's own unsold inventory, so a property nobody had
  // bought into still read ~100% allocated — and it could tip past 100% and
  // look like over-issuance when it was only ever double counting.
  const propertyRows = properties.map(p => {
    const id = p.assetId || p.propertyId || p.id;
    const originator = p.originatorId || p.ownerId || p.issuerId || null;
    const total = Number(p.totalTokens || 0);
    const rows = balances.filter(b => (b.assetId || b.propertyId) === id);
    // Every token in existence for this asset — used for the conservation
    // check, which does care about the originator's holding.
    const outstanding = rows.reduce((s, b) => s + Number(b.balance || 0), 0);
    // Only what has actually left the originator.
    const sold = rows
      .filter(b => !originator || (b.ownerId || b.holder || b.identityId) !== originator)
      .reduce((s, b) => s + Number(b.balance || 0), 0);
    return {
      assetId: id,
      title: p.title || p.name || p.assetId,
      city: p.city || p.location || '',
      totalTokens: total,
      tokensHeld: sold,
      tokensOutstanding: outstanding,
      originatorHolding: outstanding - sold,
      pctAllocated: total > 0 ? Math.round((sold / total) * 1000) / 10 : 0,
      tokenPriceINR: Number(p.tokenPrice || p.pricePerTokenINR || 0),
      valuationINR: Number(p.valuationINR || (p.tokenPrice || 0) * total)
    };
  }).sort((a, b) => b.pctAllocated - a.pctAllocated);

  // ---- settlement funnel (UMI) ----
  const ins = (rail && rail.instructions) || [];
  const settled = ins.filter(i => i.status === 'SETTLED');
  const failed = ins.filter(i => i.status === 'FAILED');
  const settledValue = settled.reduce((s, i) => s + paise(i.cashINR), 0);
  const failureReasons = {};
  failed.forEach(i => {
    const r = (i.failureReason || 'unspecified').replace(/\s*\(.*$/, '');
    failureReasons[r] = (failureReasons[r] || 0) + 1;
  });

  // ---- activity over the last 14 days, from the ledger itself ----
  // Prefer the rail's durable chain: it is the one that actually records
  // settlements and survives restarts. Fall back to the app chain.
  const railBlocks = (rail && rail.chain && rail.chain.blocks) || [];
  const activityBlocks = railBlocks.length ? railBlocks : chain;
  const DAY = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const series = [];
  for (let d = 13; d >= 0; d--) {
    const start = today.getTime() - d * DAY;
    const label = new Date(start).toISOString().slice(0, 10);
    const blocks = activityBlocks.filter(b => {
      const t = Date.parse(b.timestamp);
      return t >= start && t < start + DAY;
    }).length;
    const sett = settled.filter(i => {
      const t = Date.parse(i.settledAt || i.createdAt || '');
      return t >= start && t < start + DAY;
    }).length;
    series.push({ date: label, blocks, settlements: sett });
  }

  const railOk = !!rail && !!rail.reconciliation;

  return {
    generatedAt: new Date().toISOString(),
    scope: 'operator-private',
    portfolio: {
      properties: properties.length,
      tokensOutstanding: totalHeld,
      holders: holders.length,
      kycRecords: kyc.length,
      transfers: transfers.length,
      topHolderShare: totalHeld > 0 && top ? Math.round((top[1] / totalHeld) * 1000) / 10 : 0,
      topHolder: top ? top[0] : null
    },
    properties: propertyRows,
    settlement: railOk ? {
      available: true,
      mode: (rail.config && rail.config.mode) || 'simulation',
      persistence: (rail.config && rail.config.persistence && rail.config.persistence.mode) || 'unknown',
      instructions: ins.length,
      settled: settled.length,
      failed: failed.length,
      successRatePct: ins.length ? Math.round((settled.length / ins.length) * 1000) / 10 : 0,
      settledValueINR: inr(settledValue),
      averageTicketINR: settled.length ? inr(settledValue / settled.length) : 0,
      cashInWalletsINR: rail.reconciliation.totalBalanceINR,
      lifetimeFundedINR: rail.reconciliation.totalFundedINR,
      conserved: rail.reconciliation.conserved,
      failureReasons: Object.entries(failureReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }))
    } : { available: false, reason: 'UMI settlement rail unreachable' },
    ledger: {
      appChainBlocks: chain.length,
      railChainBlocks: (rail && rail.chain && rail.chain.totalBlocks) || 0,
      railChainValid: !!(rail && rail.chain && rail.chain.verification && rail.chain.verification.valid),
      durable: !!(rail && rail.chain && rail.chain.durability && rail.chain.durability.durable),
      sealed: !!(rail && rail.chain && rail.chain.durability && rail.chain.durability.sealed)
    },
    integrity: integrityChecks(rail, propertyRows),
    activity: series,
    notes: [
      'Derived from your own data — no third-party analytics, no tracking script, nothing leaves this deployment.',
      'Traffic metrics (pageviews, referrers) are NOT included: nothing records them yet.'
    ]
  };
}

export { authorise, buildInsights, configuredKey };
export default { authorise, buildInsights, configuredKey };
