// What the agent decides, as pure functions.
//
// WHY THE POLICY IS SEPARATE FROM THE RUNTIME
// The interesting question about an autonomous agent is never "can it make a
// request". It is "what would it decide, and can you check that decision
// without letting it loose on a live rail". So every judgement lives here, as
// functions from a snapshot of rail state to a list of intents, with no I/O
// and no clock of its own. The runtime in agent.mjs does the talking.
//
// That split is what makes the harness testable: tests/agentharness.test.mjs
// feeds these functions a hand-built state and asserts on the intents,
// including the ones they must refuse to form.
//
// THE DESIGN RULE
// The policy proposes; it never assumes. Every intent carries the reason it
// was formed and the figure it is worth, and the runtime asks the rail
// whether the mandate permits it before acting. An agent that decides it is
// allowed is not operating under a mandate, it is operating under a habit.

/**
 * Actions the rail knows how to bound.
 *
 * The caretaker forms only RELEASE_CONDITION intents, which is a deliberate
 * limit and not an oversight: an agent that could also sell things is a
 * different product with a different risk, and adding an action here should
 * be somebody's decision rather than a convenience. The rest of the list is
 * here so run.mjs can refuse to request a mandate for an action the rail
 * would not recognise, which otherwise fails at the first act rather than at
 * setup.
 */
export const KNOWN_ACTIONS = [
  'SETTLE_DVP',
  'PLACE_OFFER',
  'ANCHOR_DOCUMENT',
  'DELIVER_WORK',
  'RELEASE_CONDITION',
];

/** The only action this policy will ever form an intent for. */
export const POLICY_ACTION = 'RELEASE_CONDITION';

/**
 * The caretaker policy.
 *
 * The agent's job is deliberately dull: a conditional settlement is money
 * that has been locked against a named credential, and it sits locked until
 * somebody presents that credential. Nobody watches for that, so cash stays
 * reserved after the condition it was waiting for has already been satisfied,
 * and expires back to the payer for no reason other than inattention.
 *
 * A dull job is the right first job for an automated actor. The failure mode
 * of a clever agent is that nobody can say what it will do; the failure mode
 * of this one is that a release happens a few seconds earlier than a person
 * would have managed.
 *
 * @param {object} state
 * @param {Array}  state.conditions   the condition book, as the rail returns it
 * @param {Array}  state.credentials  the credential register, as the rail returns it
 * @param {number} state.nowMs        the runtime's clock, passed in rather than read
 * @param {object} limits             { remainingPaise, assets, actions } from the mandate
 * @returns {{intents: Array, skipped: Array}}
 */
export function decide(state, limits) {
  const intents = [];
  const skipped = [];

  const conditions = Array.isArray(state.conditions) ? state.conditions : [];
  const credentials = Array.isArray(state.credentials) ? state.credentials : [];
  const now = state.nowMs || 0;

  const note = (cond, why) => skipped.push({ conditionId: cond.conditionId, why });

  // The ceiling is spent down as intents are formed, not checked against the
  // opening figure each time. Three conditions that each fit under the
  // headroom do not all fit together, and an agent that forms all three
  // intents has the rail refuse the last one after the first two have
  // already moved somebody's money. A budget is a running total or it is
  // not a budget.
  let budget = limits && Number.isFinite(limits.remainingPaise) ? limits.remainingPaise : Infinity;

  for (const cond of conditions) {
    if (!cond || cond.status !== 'OPEN') continue;

    // The agent presents on behalf of exactly one person. A condition
    // somebody else is entitled to assert is none of its business, even
    // when the credential happens to resolve, and the rail would refuse it
    // with ERR_UMI_CONDITION_NOT_ASSERTER. Forming the intent anyway would
    // put a refusal on a stranger's agreement and bump its refusal count.
    if (state.principal && !eq(cond.asserter, state.principal)) {
      note(cond, `${cond.asserter} is entitled to assert this, not ${state.principal}`);
      continue;
    }

    // Expiry is the rail's business, not the agent's. Releasing a lapsed
    // condition would be the agent overriding a decision the rail has
    // already made, which is exactly what a mandate exists to prevent.
    const deadline = cond.deadlineAt ? Date.parse(cond.deadlineAt) : NaN;
    if (Number.isFinite(deadline) && now >= deadline) {
      note(cond, 'the deadline has passed; an expiry is the rail\'s to apply and not an agent\'s to reverse');
      continue;
    }

    const match = findCredential(credentials, cond);
    if (!match.credentialId) {
      note(cond, match.why);
      continue;
    }

    const amount = Number(cond.cashPaise || 0);
    if (!(amount > 0)) { note(cond, 'no cash is locked, so there is nothing to release'); continue; }

    // Local bounds are a courtesy, not the control. The rail re-checks every
    // one of these and its answer is the one that counts. Checking here only
    // saves spending the operator's attention on requests already known to
    // be refused.
    if (limits && Array.isArray(limits.actions) && !limits.actions.includes('RELEASE_CONDITION')) {
      note(cond, 'this mandate does not cover RELEASE_CONDITION'); continue;
    }
    if (limits && Array.isArray(limits.assets) && limits.assets.length > 0 &&
        cond.assetId && !limits.assets.includes(cond.assetId)) {
      note(cond, `the mandate does not cover ${cond.assetId}`); continue;
    }
    if (amount > budget) {
      note(cond, `needs ${amount} paise and the mandate has ${budget === Infinity ? 'no' : budget} left`); continue;
    }
    budget -= amount;

    intents.push({
      action: 'RELEASE_CONDITION',
      conditionId: cond.conditionId,
      assetId: cond.assetId || '',
      credentialId: match.credentialId,
      amountPaise: amount,
      because: `${cond.credentialType} ${match.credentialId} is issued to ${cond.asserter} and not revoked, ` +
        'and the condition waiting on it is still open',
    });
  }

  // Deterministic order. An agent whose behaviour depends on iteration order
  // cannot be reproduced from its log, and a log you cannot replay is not
  // evidence of anything.
  const byId = (a, b) => String(a.conditionId).localeCompare(String(b.conditionId));
  intents.sort(byId);
  skipped.sort(byId);
  return { intents, skipped };
}

/**
 * Find the credential that actually satisfies a condition.
 *
 * Every clause here is a way the agent could have been sloppy and released
 * somebody's money against the wrong piece of paper. "A credential exists
 * for this person" is not the claim the condition made, and treating the two
 * as equivalent is the whole class of bug worth preventing.
 */
export function findCredential(credentials, cond) {
  const want = String(cond.credentialType || '').trim();
  if (!want) return { credentialId: '', why: 'the condition names no credential type, so nothing can satisfy it' };

  let sawType = false, sawSubject = false, sawRevoked = false;

  for (const rec of credentials) {
    const c = rec && rec.credential;
    if (!c) continue;
    const types = Array.isArray(c.type) ? c.type : [c.type];
    if (!types.includes(want)) continue;
    sawType = true;

    const subject = (c.credentialSubject && c.credentialSubject.id) || '';
    if (!eq(subject, cond.asserter)) continue;
    sawSubject = true;

    // The asset matters. A title credential for a different property is a
    // valid credential and the wrong one.
    const credAsset = (c.credentialSubject && c.credentialSubject.assetId) || '';
    if (cond.assetId && credAsset && !eq(credAsset, cond.assetId)) continue;

    // If the condition named an issuer, only that issuer will do. Otherwise
    // the condition is satisfiable by anyone willing to sign, which is not a
    // condition.
    if (cond.issuer && !eq(stripDid(c.issuer), cond.issuer)) continue;

    if (rec.revoked) { sawRevoked = true; continue; }

    return { credentialId: c.id, why: '' };
  }

  if (sawRevoked) return { credentialId: '', why: `the only matching ${want} has been revoked` };
  if (sawSubject) return { credentialId: '', why: `a ${want} for ${cond.asserter} exists but not for this asset or issuer` };
  if (sawType) return { credentialId: '', why: `a ${want} exists but not one issued to ${cond.asserter}` };
  return { credentialId: '', why: `no ${want} has been issued to ${cond.asserter}` };
}

const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const stripDid = (issuer) => String(issuer || '').replace(/^did:aasthi:/, '');

/**
 * The stop rule, checked before every single act rather than once at startup.
 *
 * Three independent things can stop this agent: the passport being revoked,
 * the mandate being revoked or expired, and the operator's kill file. Any one
 * of them is sufficient, and the agent reports which. A runtime that checks
 * its authority once and then trusts its own memory of it is precisely the
 * thing a revocation needs to defeat.
 */
export function shouldStop({ passport, mandate, killed, nowMs }) {
  if (killed) return { stop: true, why: 'the operator stop file is present' };
  if (!passport) return { stop: true, why: 'this agent is not on the register' };
  // The register publishes a status string, not a boolean. Reading a
  // boolean that is not there yields undefined, which is falsy, which is a
  // revoked agent that keeps running: exactly the bug this check exists to
  // prevent. So match on the status, by name.
  //
  // REVOKED stops it, which is the rail's rule too.
  //
  // REVEAL_PENDING also stops it, and here this runtime is deliberately
  // stricter than the rail. A pending reveal means somebody has opened a
  // formal request to establish who is behind this pseudonym, with a stated
  // trigger. Continuing to move other people's money while that is in
  // progress is the wrong default, and pausing costs nothing that cannot be
  // resumed. The rail should not impose that on every operator; a
  // well-behaved agent should impose it on itself.
  const standing = String(passport.status || '').toUpperCase();
  if (passport.revoked === true || standing === 'REVOKED') {
    return { stop: true, why: 'the passport has been withdrawn' };
  }
  if (standing === 'REVEAL_PENDING') {
    return { stop: true, why: 'an identification request is open against this agent; it pauses rather than keeps spending' };
  }
  if (!mandate) return { stop: true, why: 'no mandate could be read' };
  // The passport and the mandate must name the same identity.
  //
  // MandateRegistry.Authorise checks standing against the name written on
  // the mandate. Grant a mandate to a free-text agent name while the
  // passport lives under its generated pseudonym and Standing reports the
  // agent as unregistered, the withdrawal branch never fires, and revoking
  // the passport stops nothing: the kill switch is wired to a name nothing
  // uses. The agent refuses to run in that configuration rather than run
  // unstoppably.
  if (passport.agentId && mandate.agent && !eq(passport.agentId, mandate.agent)) {
    return {
      stop: true,
      why: `the mandate names ${mandate.agent} but the passport is ${passport.agentId}; ` +
        'revoking the passport would not stop this agent, so it will not start',
    };
  }
  if (mandate.revoked) return { stop: true, why: `the mandate was revoked by ${mandate.revokedBy || 'somebody'}` };
  if (mandate.expiresAt && nowMs && Date.parse(mandate.expiresAt) <= nowMs) {
    return { stop: true, why: 'the mandate has expired' };
  }
  if (Number(mandate.limitPaise || 0) - Number(mandate.spentPaise || 0) <= 0) {
    return { stop: true, why: 'the mandate has no headroom left' };
  }
  return { stop: false, why: '' };
}

export default { decide, findCredential, shouldStop, KNOWN_ACTIONS, POLICY_ACTION };
