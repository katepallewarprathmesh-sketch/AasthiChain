// UMI-pattern settlement simulator (JavaScript mirror of payment-gateway/settlement).
//
// Models the settlement pattern published for SEBI's "Demat 2.0" pilot, where the
// security leg lives on a permissioned ledger owned by the depositories and the cash
// leg settles in RBI wholesale CBDC through the Unified Market Interface (UMI).
//
// HONESTY CONTRACT — enforced by code below, not by comments:
//   * every response carries settlementRail and simulated: true
//   * centralBankMoney is always false
//   * regulatoryStatus is always SIMULATED_NOT_CONNECTED
//   * nothing here is connected to RBI, SEBI, NPCI, NSDL or CDSL
//
// Balances are in-process integers in paise. No real money exists in this file.

import crypto from 'crypto';

export const RAIL = 'UMI_SIM';
export const REGULATORY_STATUS = 'SIMULATED_NOT_CONNECTED';

export const PHASE = {
  RESERVED: 'RESERVED',
  MATCHED: 'MATCHED',
  SETTLED: 'SETTLED',
  UNWOUND: 'UNWOUND',
};

// Participant classes mirror the institutional cast of the real pilot rather than
// inventing new roles, so the simulation maps cleanly onto the published design.
export const PARTICIPANT_CLASSES = [
  'INVESTOR',
  'ISSUER_SPV',
  'INVESTMENT_MANAGER',
  'TRUSTEE',
  'DEPOSITORY',
  'BANK',
];

const HOLD_WINDOW_MS = 15 * 60 * 1000;

function deriveRef(prefix, ...parts) {
  const h = crypto.createHash('sha512');
  for (const p of parts) h.update(String(p) + '|');
  return `${prefix}-${h.digest('hex').slice(0, 16).toUpperCase()}`;
}

function err(code, message, http = 400) {
  const e = new Error(message || code);
  e.code = code;
  e.http = http;
  return e;
}

export function createUMISim(state = {}) {
  // State is injectable so a serverless instance can rehydrate it from globalThis.
  const wallets = state.wallets || {};
  const locks = state.locks || {};
  const dvps = state.dvps || {};
  const actions = state.actions || [];

  function capabilities() {
    return {
      rail: RAIL,
      atomic: true,
      centralBankMoney: false,
      simulated: true,
      regulatoryStatus: REGULATORY_STATUS,
      settlementWindow: 'instant (both legs commit together)',
      pattern: {
        name: 'SEBI Demat 2.0 / RBI Unified Market Interface',
        publicSource: 'SEBI press release and FAQs, 10 September 2026',
        modelled: [
          'security leg on a permissioned ledger owned by the record-keeper',
          'cash leg reserved before the trade is matched',
          'both legs commit atomically or neither commits',
          'asset servicing pushed to holder wallets by ledger event',
          'secondary trading routed through an existing RFQ venue, not a new exchange',
        ],
        notModelled: [
          'real wholesale CBDC (e-rupee)',
          'any connection to RBI, SEBI, NPCI, NSDL or CDSL',
          'depository ownership of the ledger',
          'any regulatory approval, pilot participation or sandbox admission',
        ],
      },
      legalNote:
        'Fractional real-estate offerings to retail investors in India are regulated ' +
        'under the SEBI SM REIT framework, where the current minimum investment is ' +
        'Rs 10 lakh. The Rs 500 figure in this product demonstrates divisibility only.',
    };
  }

  function openWallet({ participantId, participantClass = 'INVESTOR', bank = 'Simulated Participating Bank', openingPaise = 0 }) {
    if (!participantId) throw err('ERR_UNKNOWN_PARTICIPANT', 'participantId is required');
    if (!PARTICIPANT_CLASSES.includes(participantClass)) {
      throw err('ERR_INVALID_PARTICIPANT_CLASS', `participantClass must be one of ${PARTICIPANT_CLASSES.join(', ')}`);
    }
    if (!Number.isInteger(openingPaise) || openingPaise < 0) {
      throw err('ERR_INVALID_AMOUNT', 'openingPaise must be a non-negative integer (paise)');
    }
    if (wallets[participantId]) return serialiseWallet(wallets[participantId]);

    wallets[participantId] = {
      participantId,
      participantClass,
      participatingBank: bank,
      balancePaise: openingPaise,
      heldPaise: 0,
      openedAt: new Date().toISOString(),
    };
    return serialiseWallet(wallets[participantId]);
  }

  function getWallet(participantId) {
    const w = wallets[participantId];
    if (!w) throw err('ERR_UNKNOWN_PARTICIPANT', `no simulated wallet for ${participantId}`, 404);
    return serialiseWallet(w);
  }

  function listWallets() {
    return Object.values(wallets).map(serialiseWallet);
  }

  function serialiseWallet(w) {
    return {
      ...w,
      availablePaise: w.balancePaise - w.heldPaise,
      settlementRail: RAIL,
      centralBankMoney: false,
      simulated: true,
      regulatoryStatus: REGULATORY_STATUS,
    };
  }

  // Reserve locks the cash leg WITHOUT moving money. This is what makes the later
  // settle atomic: the funds are already proven to exist and cannot be double-spent.
  function reserve({ dvpId, assetId, payerId, payeeId, amountPaise, tokenCount, reference }) {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw err('ERR_INVALID_AMOUNT', 'amountPaise must be a positive integer');
    if (!Number.isInteger(tokenCount) || tokenCount <= 0) throw err('ERR_INVALID_AMOUNT', 'tokenCount must be a positive integer');

    const payer = wallets[payerId];
    const payee = wallets[payeeId];
    if (!payer) throw err('ERR_UNKNOWN_PARTICIPANT', `payer ${payerId} has no simulated wallet`, 404);
    if (!payee) throw err('ERR_UNKNOWN_PARTICIPANT', `payee ${payeeId} has no simulated wallet`, 404);
    if (payer.balancePaise - payer.heldPaise < amountPaise) {
      throw err('ERR_INSUFFICIENT_FUNDS', 'payer wallet cannot cover this reservation', 409);
    }

    const now = new Date();
    const id = dvpId || deriveRef('DVP', assetId, payerId, payeeId, now.toISOString());
    const lock = {
      lockId: deriveRef('LOCK', id, payerId, now.toISOString()),
      dvpId: id,
      assetId,
      payerId,
      payeeId,
      amountPaise,
      tokenCount,
      reference: reference || '',
      phase: PHASE.RESERVED,
      reservedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HOLD_WINDOW_MS).toISOString(),
    };
    payer.heldPaise += amountPaise;
    locks[lock.lockId] = lock;
    dvps[id] = { dvpId: id, phases: [{ phase: PHASE.RESERVED, at: lock.reservedAt }], lockId: lock.lockId };
    return decorate(lock);
  }

  // AtomicSettle commits both legs together. The security leg is supplied by the
  // ledger; this verifies the two legs describe the same trade before moving anything.
  function atomicSettle({ lockId, ledgerTxId, assetId, fromId, toId, tokenCount }) {
    const lock = locks[lockId];
    if (!lock) throw err('ERR_LOCK_NOT_FOUND', `no reservation ${lockId}`, 404);
    if (lock.phase !== PHASE.RESERVED) throw err('ERR_LOCK_ALREADY_CONSUMED', `reservation is ${lock.phase}`, 409);
    if (!ledgerTxId) throw err('ERR_LEG_AMOUNT_MISMATCH', 'ledgerTxId (security leg reference) is required');
    if (fromId !== lock.payeeId || toId !== lock.payerId) {
      throw err('ERR_LEG_AMOUNT_MISMATCH', 'security leg counterparties do not match the cash leg', 409);
    }
    if (tokenCount !== lock.tokenCount) {
      throw err('ERR_LEG_AMOUNT_MISMATCH', 'security leg token count does not match the reservation', 409);
    }

    const payer = wallets[lock.payerId];
    const payee = wallets[lock.payeeId];
    if (!payer || !payee) throw err('ERR_UNKNOWN_PARTICIPANT', 'participant wallet disappeared', 409);
    if (payer.heldPaise < lock.amountPaise || payer.balancePaise < lock.amountPaise) {
      throw err('ERR_INSUFFICIENT_FUNDS', 'refusing to half-settle a trade', 409);
    }

    const now = new Date();
    payer.balancePaise -= lock.amountPaise;
    payer.heldPaise -= lock.amountPaise;
    payee.balancePaise += lock.amountPaise;
    lock.phase = PHASE.SETTLED;

    const trace = dvps[lock.dvpId];
    if (trace) {
      trace.phases.push({ phase: PHASE.MATCHED, at: now.toISOString() });
      trace.phases.push({ phase: PHASE.SETTLED, at: now.toISOString() });
    }

    return decorate({
      dvpId: lock.dvpId,
      lockId: lock.lockId,
      phase: PHASE.SETTLED,
      assetId: assetId || lock.assetId,
      cashRef: deriveRef('ERUPEE-SIM', lock.dvpId, ledgerTxId, now.toISOString()),
      ledgerTxId,
      amountPaise: lock.amountPaise,
      tokenCount: lock.tokenCount,
      settledAt: now.toISOString(),
    });
  }

  function unwind({ lockId, reason }) {
    const lock = locks[lockId];
    if (!lock) throw err('ERR_LOCK_NOT_FOUND', `no reservation ${lockId}`, 404);
    if (lock.phase !== PHASE.RESERVED) throw err('ERR_LOCK_ALREADY_CONSUMED', `reservation is ${lock.phase}`, 409);

    const payer = wallets[lock.payerId];
    if (!payer) throw err('ERR_UNKNOWN_PARTICIPANT', 'payer wallet disappeared', 409);
    payer.heldPaise -= lock.amountPaise;
    lock.phase = PHASE.UNWOUND;
    lock.unwoundReason = reason || 'unspecified';

    const trace = dvps[lock.dvpId];
    if (trace) trace.phases.push({ phase: PHASE.UNWOUND, at: new Date().toISOString(), reason: lock.unwoundReason });

    return decorate(lock);
  }

  function getDvP(dvpId) {
    const trace = dvps[dvpId];
    if (!trace) throw err('ERR_DVP_NOT_FOUND', `no DvP ${dvpId}`, 404);
    return decorate({ ...trace, lock: locks[trace.lockId] ? decorate(locks[trace.lockId]) : null });
  }

  // Corporate actions model the "smart contract pays the holder's wallet on the due
  // date" behaviour. Splits are supplied in paise so no rounding can create money;
  // this verifies the total before paying anybody, and pays everybody or nobody.
  function distributeCorporateAction({ assetId, kind = 'RENT', fromId, splits }) {
    if (!splits || typeof splits !== 'object' || Object.keys(splits).length === 0) {
      throw err('ERR_INVALID_AMOUNT', 'splits must be a non-empty map of participantId -> paise');
    }
    const payer = wallets[fromId];
    if (!payer) throw err('ERR_UNKNOWN_PARTICIPANT', `paying participant ${fromId} has no wallet`, 404);

    let total = 0;
    for (const [participantId, paise] of Object.entries(splits)) {
      if (!Number.isInteger(paise) || paise <= 0) throw err('ERR_INVALID_AMOUNT', `split for ${participantId} must be a positive integer in paise`);
      if (!wallets[participantId]) throw err('ERR_UNKNOWN_PARTICIPANT', `holder ${participantId} has no wallet`, 404);
      total += paise;
    }
    if (payer.balancePaise - payer.heldPaise < total) {
      throw err('ERR_INSUFFICIENT_FUNDS', 'refusing to pay a partial distribution', 409);
    }

    payer.balancePaise -= total;
    for (const [participantId, paise] of Object.entries(splits)) {
      wallets[participantId].balancePaise += paise;
    }

    const now = new Date();
    const action = {
      actionId: deriveRef('CA-SIM', assetId, kind, now.toISOString()),
      assetId,
      kind,
      fromId,
      splits,
      totalPaise: total,
      holders: Object.keys(splits).length,
      executedAt: now.toISOString(),
    };
    actions.push(action);
    return decorate(action);
  }

  function listCorporateActions(assetId) {
    const list = assetId ? actions.filter(a => a.assetId === assetId) : actions;
    return list.map(decorate);
  }

  // Self-test of the conformance checklist, runnable in production against live state.
  // It uses throwaway participant ids so it can never touch real demo balances.
  function conformance() {
    const probe = createUMISim({ wallets: {}, locks: {}, dvps: {}, actions: [] });
    const checks = [];
    const check = (id, title, fn) => {
      try {
        fn();
        checks.push({ id, title, status: 'PASS' });
      } catch (e) {
        checks.push({ id, title, status: 'FAIL', detail: e.code || e.message });
      }
    };
    const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
    const expectThrows = (code, fn) => {
      try { fn(); } catch (e) { if (e.code === code) return; throw new Error(`got ${e.code}, want ${code}`); }
      throw new Error(`expected ${code}, got success`);
    };

    probe.openWallet({ participantId: '_probe_investor', participantClass: 'INVESTOR', openingPaise: 1000000 });
    probe.openWallet({ participantId: '_probe_spv', participantClass: 'ISSUER_SPV', openingPaise: 0 });

    check('C1', 'Rail never claims to be real', () => {
      const c = probe.capabilities();
      expect(c.simulated === true, 'simulated must be true');
      expect(c.centralBankMoney === false, 'centralBankMoney must be false');
      expect(c.regulatoryStatus === REGULATORY_STATUS, 'regulatoryStatus must be SIMULATED_NOT_CONNECTED');
    });

    let lock;
    check('C2', 'Reserving the cash leg moves no money', () => {
      lock = probe.reserve({ assetId: 'PROBE', payerId: '_probe_investor', payeeId: '_probe_spv', amountPaise: 250000, tokenCount: 5 });
      expect(probe.getWallet('_probe_investor').balancePaise === 1000000, 'balance changed on reserve');
      expect(probe.getWallet('_probe_investor').heldPaise === 250000, 'hold not recorded');
      expect(probe.getWallet('_probe_spv').balancePaise === 0, 'payee credited early');
    });

    check('C3', 'Both legs commit together with linked references', () => {
      const r = probe.atomicSettle({ lockId: lock.lockId, ledgerTxId: 'TXN-probe', assetId: 'PROBE', fromId: '_probe_spv', toId: '_probe_investor', tokenCount: 5 });
      expect(r.ledgerTxId === 'TXN-probe', 'security leg reference lost');
      expect(!!r.cashRef, 'cash leg reference missing');
      expect(probe.getWallet('_probe_spv').balancePaise === 250000, 'payee not credited');
      expect(probe.getWallet('_probe_investor').heldPaise === 0, 'hold not released');
    });

    check('C4', 'Settled reservations cannot be replayed', () => {
      expectThrows('ERR_LOCK_ALREADY_CONSUMED', () =>
        probe.atomicSettle({ lockId: lock.lockId, ledgerTxId: 'TXN-probe', assetId: 'PROBE', fromId: '_probe_spv', toId: '_probe_investor', tokenCount: 5 }));
    });

    check('C5', 'Mismatched security leg aborts with no money moved', () => {
      const l = probe.reserve({ assetId: 'PROBE', payerId: '_probe_investor', payeeId: '_probe_spv', amountPaise: 100000, tokenCount: 2 });
      expectThrows('ERR_LEG_AMOUNT_MISMATCH', () =>
        probe.atomicSettle({ lockId: l.lockId, ledgerTxId: 'TXN-bad', assetId: 'PROBE', fromId: 'someone-else', toId: '_probe_investor', tokenCount: 2 }));
      expect(probe.getWallet('_probe_spv').balancePaise === 250000, 'money moved on a failed trade');
      probe.unwind({ lockId: l.lockId, reason: 'conformance cleanup' });
    });

    check('C6', 'Wallets cannot be oversubscribed', () => {
      const big = probe.getWallet('_probe_investor').availablePaise;
      probe.reserve({ assetId: 'PROBE', payerId: '_probe_investor', payeeId: '_probe_spv', amountPaise: big, tokenCount: 1 });
      expectThrows('ERR_INSUFFICIENT_FUNDS', () =>
        probe.reserve({ assetId: 'PROBE', payerId: '_probe_investor', payeeId: '_probe_spv', amountPaise: 1, tokenCount: 1 }));
    });

    check('C7', 'Corporate actions pay everybody or nobody', () => {
      probe.openWallet({ participantId: '_probe_pool', participantClass: 'INVESTMENT_MANAGER', openingPaise: 600000 });
      probe.distributeCorporateAction({ assetId: 'PROBE', kind: 'RENT', fromId: '_probe_pool', splits: { _probe_investor: 480000, _probe_spv: 120000 } });
      expect(probe.getWallet('_probe_pool').balancePaise === 0, 'pool not fully drawn');
      expectThrows('ERR_INSUFFICIENT_FUNDS', () =>
        probe.distributeCorporateAction({ assetId: 'PROBE', kind: 'RENT', fromId: '_probe_pool', splits: { _probe_investor: 1, _probe_spv: 1 } }));
    });

    check('C8', 'Invalid amounts are rejected before any state changes', () => {
      expectThrows('ERR_INVALID_AMOUNT', () =>
        probe.reserve({ assetId: 'PROBE', payerId: '_probe_investor', payeeId: '_probe_spv', amountPaise: 0, tokenCount: 5 }));
      expectThrows('ERR_INVALID_AMOUNT', () =>
        probe.reserve({ assetId: 'PROBE', payerId: '_probe_investor', payeeId: '_probe_spv', amountPaise: -1, tokenCount: 5 }));
    });

    const passed = checks.filter(c => c.status === 'PASS').length;
    return decorate({
      suite: 'UMI pattern conformance',
      reference: 'payment-gateway/settlement/conformance_test.go',
      goEquivalent: 'payment-gateway/settlement/conformance_test.go',
      passed,
      total: checks.length,
      allPassed: passed === checks.length,
      checks,
    });
  }

  // decorate is the single choke point that enforces the honesty contract on output.
  function decorate(obj) {
    return {
      ...obj,
      settlementRail: RAIL,
      centralBankMoney: false,
      simulated: true,
      regulatoryStatus: REGULATORY_STATUS,
    };
  }

  return {
    capabilities,
    openWallet,
    getWallet,
    listWallets,
    reserve,
    atomicSettle,
    unwind,
    getDvP,
    distributeCorporateAction,
    listCorporateActions,
    conformance,
    _state: { wallets, locks, dvps, actions },
  };
}

// Shared instance for serverless warm starts.
export function getSharedUMISim() {
  if (!globalThis._aasthi_umi_sim) {
    globalThis._aasthi_umi_state = globalThis._aasthi_umi_state || { wallets: {}, locks: {}, dvps: {}, actions: [] };
    globalThis._aasthi_umi_sim = createUMISim(globalThis._aasthi_umi_state);
  }
  return globalThis._aasthi_umi_sim;
}
