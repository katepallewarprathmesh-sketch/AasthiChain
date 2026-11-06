// The regulatory sandbox submission, as data.
//
// WHY THIS IS A FILE AND NOT A DOCUMENT
// A sandbox application is the one artefact where a claim and the code have
// to agree exactly, because the reader's job is to find the gap between
// them. Written as prose in two places, the page and the document drift
// within a month and the drift is always in the flattering direction.
//
// So the proposal lives here once. The /sandbox screen renders it,
// scripts/build-sandbox-doc.mjs generates docs/SANDBOX_PROPOSAL.md from it,
// and tests/sandbox.test.mjs refuses to pass if the generated document is
// stale, if a containment names a file that does not exist, if a failure
// mode has no stated symptom, or if anything here starts claiming an
// approval we do not have.
//
// WHAT MAKES A SUBMISSION WORK
// A sandbox exists to create regulatory clarity, not to prove that software
// runs. Four things carry the weight, and they are the four sections below:
// name the specific friction, scope it so small that reversing it is
// uninteresting, state the failure modes before anyone asks, and say what
// will have been learned either way.

/** One-line identity, used by the page header and the document title. */
export const PROPOSAL = {
  title: 'Fractional property settlement with a wholesale cash leg',
  applicant: 'AasthiChain (Rudraksha Aasthi)',
  venue: 'Regulatory sandbox cohort submission, draft',
  status: 'DRAFT. Not submitted, not approved, not under review.',
  summary:
    'A cohort-scoped test of whether registrar-verified fractional property can settle against a ' +
    'wholesale central bank money leg at retail ticket sizes, with multilateral netting, without ' +
    'creating a settlement-risk window and without any participant funding a gross position.',
}

/** 1. The friction. Specific, sourced, and not a market-size slide. */
export const FRICTION = {
  statement:
    'Indian property is indivisible in practice, slow to transfer, and expensive to verify. The ' +
    'smallest credible exposure to institutional-grade real estate is a ten lakh rupee SM REIT ' +
    'unit; below that, a household\u2019s only options are unregulated or illiquid.',
  evidence: [
    {
      claim: 'Land and property disputes are roughly two thirds of civil litigation, and a title dispute runs for about two decades.',
      source: 'Samiullah v. State of Bihar, 2025 INSC 1292',
    },
    {
      claim: 'The regulated floor for a fractional real-estate unit is ten lakh rupees, in schemes of fifty to five hundred crore with at least two hundred unitholders.',
      source: 'SEBI SM REIT framework',
    },
    {
      claim: 'Verification is repeated per venue. A buyer who has already been checked by one platform is checked again by the next, because nothing a holder carries can be verified by a second venue.',
      source: 'Observed in the design of every platform surveyed, including our own before this build',
    },
  ],
  whyNow:
    'The cash leg is the part that has not been solved. A depository can issue a token today; what ' +
    'stalls is settling it against money, because atomic delivery versus payment is gross ' +
    'settlement and gross settlement demands funded cash for every leg. India can sequence this ' +
    'differently from markets that shipped the asset leg first and left settlement to participants.',
}

/** 2. The contained scope. Small enough that reversing it is boring. */
export const SCOPE = {
  statement:
    'One city, one asset class, registrar-verified titles only, hard caps on value and ' +
    'participants, and a single switch that ends it.',
  bounds: [
    { bound: 'Geography', value: 'One metropolitan area, one state registrar' },
    { bound: 'Asset class', value: 'Completed, revenue-generating commercial property only. No under-construction, no land parcels' },
    { bound: 'Title', value: 'Only titles carrying a registrar-signed credential anchored on the ledger. No self-declared ownership' },
    { bound: 'Participants', value: 'Capped cohort, KYC-complete, resident Indian investors only for the first phase' },
    { bound: 'Ticket size', value: 'Floor of five hundred rupees, per-participant cap for the cohort duration' },
    { bound: 'Scheme value', value: 'A single capped pool, well below the SM REIT floor, so nothing here competes with a regulated product' },
    { bound: 'Cash leg', value: 'Wholesale central bank money within the cohort. No retail custody of client funds by the platform' },
    { bound: 'Duration', value: 'One cohort period, with a stated end date rather than a renewal assumption' },
  ],
  reversibility:
    'The asset leg and the cash leg are separate modules behind one settlement call. Disabling the ' +
    'cash rail stops all settlement immediately and leaves every position readable and ' +
    'transferable through the ordinary registrar process. No participant depends on us remaining ' +
    'operational to prove what they hold: credentials are verifiable offline and positions are ' +
    'anchored on an append-only ledger.',
}

/**
 * 3. The failure modes, stated first.
 *
 * Each one carries the observable symptom, what is already implemented, and
 * the file and test that back it. An entry whose containment is "none" says
 * so: an application that claims everything is handled is the one a regulator
 * stops believing.
 */
export const FAILURE_MODES = [
  {
    mode: 'The issuer becomes insolvent',
    symptom: 'Holders own tokens in an entity that cannot operate the asset or distribute income.',
    containment: 'NOT IMPLEMENTED. Recourse is recorded as absent rather than implied. No waterfall, no indemnity, no insurer, no reserve is encoded today, and the attestation endpoint says so in the response rather than in a footnote.',
    implemented: false,
    file: 'drunix-gateway/attestation.go',
    test: 'tests/attestation.test.mjs',
  },
  {
    mode: 'An attestation turns out to be wrong or is withdrawn',
    symptom: 'Tokens exist against backing that is no longer evidenced.',
    containment: 'Withdrawing a backing attestation blocks further issuance against that asset immediately, and the refusal is recorded on the ledger rather than handled quietly.',
    implemented: true,
    file: 'drunix-gateway/backing.go',
    test: 'tests/backing.test.mjs',
  },
  {
    mode: 'The cash leg does not complete',
    symptom: 'Ownership moves and money does not, or the reverse.',
    containment: 'Settlement locks both legs and commits them in one block. There is no observable state in which one leg moved. A netting batch keeps the same promise across every leg in it: all of them settle or none do.',
    implemented: true,
    file: 'drunix-gateway/netting.go',
    test: 'tests/netting.test.mjs',
  },
  {
    mode: 'A participant cannot fund their obligation',
    symptom: 'A settlement fails late, after others have relied on it.',
    containment: 'Funding is checked before anything locks, the shortfall is named in the refusal, and a netting batch reports every participant\u2019s net position before it is settled rather than discovering the gap mid-batch.',
    implemented: true,
    file: 'drunix-gateway/netting.go',
    test: 'tests/netting.test.mjs',
  },
  {
    mode: 'A credential is revoked after a counterparty has relied on it',
    symptom: 'A second venue accepts a holder on evidence that is no longer valid.',
    containment: 'Revocation is published as a whole status list with the ledger height it was read at, so a verifier polls one cacheable document. A presentation bundle verifies offline; only revocation needs a network, and that is stated inside the bundle.',
    implemented: true,
    file: 'drunix-gateway/portability.go',
    test: 'tests/credentialportability.test.mjs',
  },
  {
    mode: 'An automated agent acts beyond its authority',
    symptom: 'Value moves under a delegation the principal did not intend.',
    containment: 'Agents hold explicit mandates with named actions, a rupee ceiling and an expiry, re-checked by the rail on every act rather than trusted. The asymmetry that used to be declared here is closed: a principal can now revoke their own agent in one request, with no supervisor and no custodian ceremony, and revoking the passport makes every mandate it holds inert at once. A real harness runs against this surface in agent/, which is how three defects in it were found rather than argued about.',
    implemented: true,
    file: 'drunix-gateway/agentid.go',
    test: 'drunix-gateway/agentstop_test.go',
  },
  {
    mode: 'An agent pseudonym has to be re-identified',
    symptom: 'A supervisor needs to know who is behind an automated actor, and either cannot, or can too easily.',
    containment: 'A passport seals its principal and recovery takes a threshold of named custodians, with every approval written to the chain. NOT IMPLEMENTED as real custody: the threshold arithmetic is genuine but one process holds every share, so the split protects against a careless operator and not against a compromised deployment. Separating the shares across parties who do not share a host is the work, and it is not done.',
    implemented: false,
    file: 'drunix-gateway/agentid.go',
    test: 'drunix-gateway/agentid_test.go',
  },
  {
    mode: 'A signing key is weak or compromised',
    symptom: 'A signature that should be unforgeable is forged.',
    containment: 'Keys are screened on registration for the entropy failures that have broken real certificate authorities, and possession is proved against a server-issued challenge rather than asserted.',
    implemented: true,
    file: 'drunix-gateway/keyregistry.go',
    test: 'tests/operatorkeyscope.test.mjs',
  },
  {
    mode: 'The durable record falls behind the ledger',
    symptom: 'A restart loses state that participants were told was final.',
    containment: 'Money-moving requests are refused while committed blocks are still unpersisted, and the distance behind is published rather than inferred. Reads stay available, because going dark is a worse answer than a slightly stale one.',
    implemented: true,
    file: 'drunix-gateway/umi_server.go',
    test: 'tests/sealedrail.test.mjs',
  },
  {
    mode: 'The platform is used to move value across a border outside banking channels',
    symptom: 'An on-ramp or off-ramp operating without authorisation, which is what enforcement actions in this sector are actually about.',
    containment: 'The cross-border leg converts outside India through a named third-party provider, credits rupees only against a bank advice reference and an RBI purpose code, and never pays a seller in tokens. A test holds the public copy to that description so it cannot drift into an advertisement.',
    implemented: true,
    file: 'drunix-gateway/crossborder.go',
    test: 'tests/rampclaims.test.mjs',
  },
  {
    mode: 'A payment is fraudulent or structured to evade a threshold',
    symptom: 'Settlement completes on money that should have been stopped.',
    containment: 'Payments are scored before settlement, velocity is counted per payer over a window, and transfers above the information threshold carry originator and beneficiary records.',
    implemented: true,
    file: 'drunix-gateway/fraud.go',
    test: 'tests/aml.test.mjs',
  },
]

/** 4. What the cohort is for. One question, answerable either way. */
export const LEARNING = {
  question:
    'Can registrar-verified fractional property settle against a wholesale central bank money leg ' +
    'at retail ticket sizes, under multilateral netting, while conserving both cash and ownership ' +
    'exactly and without any participant funding a gross position?',
  measures: [
    'Netting efficiency achieved on real cohort flow: gross obligations against cash actually moved, per session.',
    'Peak funding a participant needed under netting, against what gross settlement would have demanded of the same participant.',
    'Settlement failures, with the cause of each, and whether any produced a partial state.',
    'Time from registrar credential issuance to a second party verifying it without contacting us.',
    'Conservation checks: cash and tokens before and after every batch, reconciled against the ledger replay.',
  ],
  negativeResult:
    'If netting at these ticket sizes saves little, or if conservation cannot be shown under ' +
    'concurrent load, that is a finding worth the cohort. It would say the cash leg should stay ' +
    'gross and that the complexity of netting is not earned at this scale, which is useful to ' +
    'anyone else about to build it.',
  notAsking: [
    'No licence, authorisation or registration is claimed or implied by this document.',
    'No live connectivity to RBI, NPCI or any state registrar exists today. Every rail named here is a simulation unless a cohort provides the real one.',
    'The signing keys in the current build derive from a seed published in the repository, so signatures prove integrity and not authority until a cohort key is issued.',
  ],
}

/** Everything, in the order a reader should meet it. */
export const SANDBOX = { PROPOSAL, FRICTION, SCOPE, FAILURE_MODES, LEARNING }

export default SANDBOX
