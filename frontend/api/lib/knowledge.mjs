// What the assistant is allowed to know about how this system works.
//
// Two kinds of grounding live here, and neither of them is the model's
// memory.
//
//   1. Retrieval over this repository's own documentation. The index is
//      built by scripts/build-knowledge.mjs and committed, so a deployment
//      needs no vector database, no embedding call and no network hop to
//      answer "what happens if nobody attests the refund". Scoring is BM25,
//      which is lexical, deterministic and inspectable: the same question
//      retrieves the same sections on every machine, and a wrong answer can
//      be traced to the section that produced it.
//   2. A briefing of the rail's current state, read from the rail itself at
//      question time: how much e₹ is outstanding, whether supply conserves,
//      which corridors are usable here and which are refused for want of a
//      licence, and the measured risk-model metrics.
//
// The honesty rules that matter: a number in the briefing is the rail's
// number, never the model's arithmetic; a measurement that has not been taken
// is reported as not taken rather than estimated; and when retrieval finds
// nothing relevant the assistant is told to say the documentation does not
// cover it, which is a better answer than a plausible one.

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

let INDEX = null;

export function loadIndex() {
  if (INDEX) return INDEX;
  try {
    const raw = readFileSync(new URL('./knowledge-index.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    INDEX = prepare(parsed);
  } catch {
    // A deployment without the index is not broken, it is merely ungrounded:
    // the assistant keeps the property context and is told it has no
    // documentation to quote.
    INDEX = prepare({ sections: [], sourceDigest: '' });
  }
  return INDEX;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'at', 'by', 'from',
  'with', 'what', 'how', 'why', 'when', 'who', 'does', 'do', 'did', 'can', 'could', 'would',
  'should', 'i', 'you', 'we', 'they', 'my', 'me', 'about', 'there', 'their', 'not', 'no', 'yes',
]);

export function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9₹%/.-]+/g, ' ')
    .split(' ')
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function prepare(parsed) {
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const docs = sections.map((s, i) => {
    // The heading and the document name are weighted by repetition: a
    // section titled "Refunds that pay themselves" in CBDC.md should win the
    // question that uses those words, ahead of a passing mention of refunds
    // in a document about something else.
    const tokens = tokenise(
      `${s.heading} ${s.heading} ${s.heading} ${s.doc} ${s.doc} ${s.doc} ${s.text}`,
    );
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { i, tf, length: tokens.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLength = docs.length ? docs.reduce((t, d) => t + d.length, 0) / docs.length : 1;
  return { ...parsed, sections, docs, df, avgLength };
}

// Plain BM25. k1 and b are the usual defaults; there is nothing to tune here
// and tuning it against a handful of questions would only overfit them.
export function retrieve(query, limit = 5, index = loadIndex()) {
  const terms = tokenise(query);
  if (!terms.length || !index.docs.length) return [];
  const N = index.docs.length;
  const k1 = 1.5;
  const b = 0.75;

  const unique = [...new Set(terms)];
  const scored = index.docs.map((d) => {
    let score = 0;
    let matched = 0;
    for (const t of unique) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched += 1;
      const n = index.df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / index.avgLength)));
    }
    // Coordination: a section that touches on three of the four words asked
    // about is worth more than one that repeats a single common word. Without
    // this, "what is atomic delivery versus payment" retrieved whichever
    // document happened to say "payment" most often.
    const coverage = unique.length ? matched / unique.length : 0;
    return { i: d.i, score: score * Math.pow(coverage, 1.5), matched, coverage };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || a.i - b2.i)
    .slice(0, limit)
    .map((s) => ({ ...index.sections[s.i], score: Number(s.score.toFixed(3)), coverage: Number(s.coverage.toFixed(2)) }));
}

/**
 * The retrieved sections, written out for the prompt.
 *
 * Only the last few turns are searched: a conversation that wandered should
 * retrieve for the question actually being asked, not for everything said so
 * far. Returns null when nothing scores, so the caller can say so rather than
 * pad the prompt with the least irrelevant section it could find.
 */
export function buildKnowledgeContext(messages, limit = 5) {
  const recent = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'user')
    .slice(-2)
    .map((m) => String(m.content || ''))
    .join(' ');
  const hits = retrieve(recent, limit);
  if (!hits.length) return null;

  // A weak best match means the question is not about anything written down
  // here, and a prompt padded with the least irrelevant section invites the
  // model to answer from it anyway. Half the words asked about must appear.
  if (hits[0].score < 2.5 || hits[0].coverage < 0.5) return null;

  const blocks = hits.map((h) => `--- ${h.doc}: ${h.heading} (${h.file})\n${h.text}`);
  return [
    'DOCUMENTATION (quoted from this project\'s own files, which are public in the repository):',
    ...blocks,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// The live rail
// ---------------------------------------------------------------------------

const money = (paise) => '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/**
 * A short factual briefing built from what the rail answers right now.
 *
 * Every figure is the rail's own. Anything the rail reports as unmeasured is
 * reported here as unmeasured: a throughput number carrying measured:false is
 * a benchmark that has not been run, and saying "about forty thousand a
 * second" because a struct had a field in it would be exactly the kind of
 * confident nonsense this file exists to prevent.
 */
export function buildRailContext({ cbdc, corridors, risk } = {}) {
  const lines = [];

  if (cbdc && cbdc.conservation) {
    const c = cbdc.conservation;
    lines.push(
      `Digital rupee layer (simulated, no central bank money): ${money(c.issuedPaise)} issued, ` +
      `${money(c.outstandingPaise)} outstanding, ${money(c.heldInWalletsPaise)} held in accounts, ` +
      `${money(c.offlineReservedPaise)} reserved for offline use, ${money(c.lockedInConditions)} locked against events. ` +
      `Supply conservation check: ${c.conserved ? 'passing' : 'FAILING'}.`,
    );
  }

  if (corridors && Array.isArray(corridors.corridors)) {
    const blocked = corridors.blockedCorridors || {};
    const usable = corridors.corridors.filter((x) => !blocked[x.id]).map((x) => x.name);
    lines.push(`Cross-border corridors configured: ${corridors.corridors.length}. Usable on this deployment: ${usable.join('; ') || 'none'}.`);
    for (const [id, missing] of Object.entries(blocked)) {
      lines.push(`Corridor ${id} refuses every payment here because this deployment holds none of: ${missing.join(', ')}.`);
    }
  }

  if (risk && typeof risk === 'object') {
    const m = risk.metrics || risk;
    if (m && (m.auc || m.accuracy)) {
      lines.push(
        `Fraud and settlement risk model (${risk.kind || 'trained in this repository'}): measured on ` +
        `${m.holdoutRows || 'held-out'} held-out rows, AUC ${m.auc}, accuracy ${m.accuracy}, precision ` +
        `${m.precision}, recall ${m.recall}, decision threshold ${m.threshold}. ${risk.dataSource || ''} ` +
        'The score is advisory: the published rules make the decision.',
      );
    }
  }

  if (!lines.length) return null;
  return [
    'LIVE RAIL STATE (read from this deployment at the moment the question was asked; these are the rail\'s own figures, not estimates):',
    ...lines.map((l) => '- ' + l),
  ].join('\n');
}

/**
 * Reads the rail for the briefing above. Never throws and never blocks an
 * answer: a rail that is slow or down costs the assistant its live figures,
 * not the whole reply.
 */
export async function readRail(baseUrl, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) return {};
  const get = async (path) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(base + path, { signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const [cbdc, corridors, risk] = await Promise.all([
    get('/umi/cbdc'),
    get('/umi/corridors'),
    get('/fraud/model'),
  ]);
  return { cbdc, corridors, risk };
}

// ---------------------------------------------------------------------------
// Looking a record up
// ---------------------------------------------------------------------------
//
// Summary state answers "how much is outstanding". It does not answer "what
// happened in settlement UMI-3F2A9C1B04", which is the question a person
// actually arrives with, and which the assistant could previously only
// decline.
//
// It is still not given a tool to call. A model deciding for itself which
// endpoint to hit is a model that can be talked into hitting one, and this
// sits in front of a settlement rail. Instead the identifiers in the question
// are recognised here, by pattern, and the matching records are fetched by
// this code and put in the prompt as facts. Deterministic, auditable, and
// incapable of being steered: an instruction id can only ever cause an
// instruction to be read.
//
// Only public, non-identity-scoped records are looked up. Nothing here reads
// a holding, a KYC record or anything else scoped to a person, because the
// assistant has no caller identity to be allowed it with.

const ID_PATTERNS = [
  { kind: 'instruction', re: /\bUMI-[0-9A-F]{6,}\b/gi },
  { kind: 'property', re: /\bPROP-[A-Z0-9-]+\b/gi },
  { kind: 'cbdc', re: /\bCBDC-[A-Z]+-[0-9A-F]{6,}\b/gi },
  { kind: 'transfer', re: /\bCBX-[0-9A-F]{6,}\b/gi },
  { kind: 'grant', re: /\bCBDC-GRANT-[0-9A-F]{6,}\b/gi },
];

const BLOCK_RE = /\bblock\s*#?\s*(\d{1,7})\b/i;

export function identifiersIn(text) {
  const q = String(text || '');
  const found = [];
  const seen = new Set();
  for (const { kind, re } of ID_PATTERNS) {
    for (const m of q.match(re) || []) {
      const id = m.toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ kind: id.startsWith('CBDC-GRANT-') ? 'grant' : kind, id });
    }
  }
  const block = BLOCK_RE.exec(q);
  if (block) found.push({ kind: 'block', id: block[1] });
  // A handful at most. A question listing twenty identifiers is not a
  // question, and fetching twenty records would be a way to make this
  // deployment hammer its own rail.
  return found.slice(0, 4);
}

const describeInstruction = (x) => [
  `Settlement instruction ${x.instructionId}: ${x.status || 'status not stated'}.`,
  x.assetId ? `Asset ${x.assetId}, ${x.tokens} tokens, seller ${x.seller}, buyer ${x.buyer}.` : null,
  x.cashLegINR !== undefined ? `Cash leg ₹${Number(x.cashLegINR).toLocaleString('en-IN')} in wholesale digital rupee.` : null,
  x.blockHeight ? `Recorded in block ${x.blockHeight}.` : null,
  x.failureReason ? `It did not settle: ${x.failureReason}` : null,
].filter(Boolean).join(' ');

const describeTransfer = (t) => [
  `Cross-border transfer ${t.transferId} on corridor ${t.corridorId}: ${String(t.status || '').replace(/_/g, ' ').toLowerCase()}.`,
  `${money(t.amountPaise)} from ${t.payer} to ${t.payee}, purpose ${t.purposeCode}.`,
  t.finality ? `Financially ${String(t.finality.financial || '').toLowerCase()}: ${t.finality.basis || ''}` : null,
  t.finality && t.finality.settlementWindow ? `Settlement window: ${t.finality.settlementWindow}.` : null,
  t.reportable ? 'Above the reporting threshold.' : null,
].filter(Boolean).join(' ');

const describeCondition = (c) => [
  `Conditional payment ${c.conditionId}: ${c.status}.`,
  `${money(c.amountPaise)} from ${c.payer} to ${c.payee}, released when ${c.attestor} attests ${c.eventType} for ${c.eventKey}.`,
  c.status === 'OPEN' ? `Deadline ${c.deadline}; if nobody attests by then the money returns to the payer.` : null,
  c.status === 'RELEASED' ? `Paid at ${c.settledAt}, with no claim filed.` : null,
  c.status === 'REFUNDED' ? 'Refunded automatically when the deadline passed unattested.' : null,
].filter(Boolean).join(' ');

const describeGrant = (g) => [
  `Purpose-bound grant ${g.grantId}: ${g.status}.`,
  `${money(g.amountPaise)} from ${g.sponsor} to ${g.beneficiary}, ${money(g.amountPaise - g.spentPaise)} unspent.`,
  g.condition ? `Spendable only for ${g.condition.purpose || 'the stated purpose'}${(g.condition.merchantCategories || []).length ? ' at ' + g.condition.merchantCategories.join(' or ') : ''}${(g.condition.allowedStates || []).length ? ' in ' + g.condition.allowedStates.join(' or ') : ''}.` : null,
].filter(Boolean).join(' ');

const describeBlock = (b) => [
  `Block ${b.height}, type ${b.type}, written ${b.timestamp}.`,
  b.txns ? `It carries ${b.txns.length} transaction(s).` : null,
  b.prevHash ? `It links to the previous block by hash, and the explorer at /ledger replays that linkage.` : null,
].filter(Boolean).join(' ');

/**
 * Fetches whatever the question named. Returns null when it named nothing, or
 * when nothing by that name exists: "no record with that reference" is itself
 * a fact worth putting in the prompt, so a wrong id gets a straight answer
 * rather than an invented settlement.
 */
export async function lookupRecords(messages, baseUrl, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const question = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'user').slice(-1).map((m) => String(m.content || '')).join(' ');
  const wanted = identifiersIn(question);
  if (!base || !wanted.length) return null;

  const get = async (path) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(base + path, { signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const lines = [];
  for (const { kind, id } of wanted) {
    if (kind === 'instruction') {
      const d = await get(`/umi/instructions/${encodeURIComponent(id)}`);
      const x = d && (d.instruction || d);
      lines.push(x && x.instructionId ? describeInstruction(x) : `No settlement instruction exists with the reference ${id}.`);
    } else if (kind === 'property') {
      const d = await get(`/umi/assets/${encodeURIComponent(id)}`);
      const a = d && (d.asset || d);
      lines.push(a && (a.assetId || a.isin)
        ? `Asset ${a.assetId || id}: ${a.assetClass || 'property'}${a.isin ? `, ISIN ${a.isin}` : ''}${a.totalTokens ? `, ${a.totalTokens} tokens issued` : ''}.`
        : `The settlement rail holds no tokenised asset record under ${id}. If that property appears in the listing data below, answer from the listing and say that it is not tokenised on the rail yet.`);
    } else if (kind === 'transfer') {
      const d = await get(`/umi/corridors/transfers/${encodeURIComponent(id)}`);
      const t = d && (d.transfer || d);
      lines.push(t && t.transferId ? describeTransfer(t) : `No cross-border transfer exists with the reference ${id}.`);
    } else if (kind === 'grant') {
      const d = await get('/umi/cbdc/grants');
      const g = ((d && d.grants) || []).find((x) => String(x.grantId).toUpperCase() === id);
      lines.push(g ? describeGrant(g) : `No purpose-bound grant exists with the reference ${id}.`);
    } else if (kind === 'cbdc') {
      const [cond, mv] = await Promise.all([get('/umi/cbdc/conditions'), get('/umi/cbdc/movements?limit=200')]);
      const c = ((cond && cond.conditions) || []).find((x) => String(x.conditionId).toUpperCase() === id);
      const m = ((mv && mv.movements) || []).find((x) => String(x.movementId).toUpperCase() === id);
      if (c) lines.push(describeCondition(c));
      else if (m) {
        lines.push(`Digital rupee movement ${m.movementId}: ${String(m.kind).replace(/_/g, ' ').toLowerCase()} of ${money(m.amountPaise)}` +
          `${m.from ? ' from ' + m.from : ''}${m.to ? ' to ' + m.to : ''}, ${m.mode === 'OFFLINE' ? 'carried offline' : 'online'}, ` +
          `financially ${String(m.finality?.financial || 'not recorded').toLowerCase()}, screening ${String(m.aml?.decision || 'not recorded').toLowerCase()}.`);
      } else lines.push(`No digital rupee record exists with the reference ${id}.`);
    } else if (kind === 'block') {
      const n = Number(id);
      // from is the height to start at, not an offset before it, and the
      // window has to be wide enough to contain the block asked for even
      // when the rail clamps the start.
      const d = await get(`/drunix/chain?limit=3&from=${Math.max(0, n - 1)}`);
      const b = ((d && d.blocks) || []).find((x) => Number(x.height) === n);
      lines.push(b
        ? describeBlock(b)
        : `The chain has no block ${n}${d && d.height ? `; its newest block is ${d.height}` : ''}.`);
    }
  }

  if (!lines.length) return null;
  return [
    'RECORDS LOOKED UP FOR THIS QUESTION (fetched from the rail by reference, exactly as it reports them):',
    ...lines.map((l) => '- ' + l),
    'If a reference was not found, say so plainly. Do not describe a record that was not returned.',
  ].join('\n');
}

export default { retrieve, buildKnowledgeContext, buildRailContext, readRail, loadIndex, tokenise, identifiersIn, lookupRecords };
