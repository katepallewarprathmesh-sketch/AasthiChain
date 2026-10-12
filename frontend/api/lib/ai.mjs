// Aasthi AI — a Groq-backed assistant that can explain the platform and the
// properties currently listed on it.
//
// Shared by the Express server and the Vercel serverless handler, like
// insights.mjs, so the two implementations cannot drift.
//
// The shape of the thing, stated plainly, because an assistant bolted onto a
// settlement system is a liability if it is vague about any of this:
//
//   * It reads. It never acts. No tool calls, no write paths, nothing that
//     could mint, transfer, approve, release or reclassify anything. The
//     ledger, the property register, the verification checks and the
//     settlement core remain the only things that decide what is true.
//   * The numbers it quotes are computed here, by the same deterministic code
//     that renders them on the site — never by the model. The model is told
//     the figures and asked to put them in a sentence.
//   * It is given public listing data only. Investor identities, holdings,
//     KYC records, payment credentials and anything owner-scoped never enter
//     the prompt, because the context is built from the public listing view
//     rather than from the caller's session.
//   * The key lives in GROQ_API_KEY, server-side. The browser talks to this
//     deployment, and this deployment talks to Groq.
//   * No key configured means the feature is OFF and says so, rather than
//     half-working.

// An ordered list, not a single name. Groq retires models on a schedule —
// llama-3.3-70b-versatile, which this shipped with, was shut down on
// 2026-08-16 and every call came back 404 model_not_found. When the head of
// the list is gone the next one answers, and the fix is an environment
// variable rather than a deploy. GROQ_MODEL still works for a single pin.
const MODELS = String(process.env.GROQ_MODELS || process.env.GROQ_MODEL || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
if (MODELS.length === 0) {
  MODELS.push('openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b');
}

// gpt-oss always reasons, and spends those tokens from the same budget as the
// answer, so a tight reply cap returns an empty or cut-off string. Give that
// family headroom and keep the reasoning out of the reply.
function requestOptionsFor(model) {
  if (model.includes('gpt-oss')) {
    return { max_tokens: LIMITS.maxReplyTokens + 700, reasoning_effort: 'low' };
  }
  return { max_tokens: LIMITS.maxReplyTokens };
}

// A model that is gone says so with 404 model_not_found or 400
// model_decommissioned. Anything else — a bad request, a rate limit, an
// outage — must not be hidden behind a silent failover.
// A 5xx, a connection reset or a timeout is weather, not a verdict. The one
// thing that must not happen is a person seeing "could not be reached" for a
// hiccup that a second attempt would have answered.
function worthRetrying(e) {
  const status = Number(e && (e.status || e.statusCode)) || 0;
  if (status >= 500) return true;
  if (status === 408 || status === 409) return true;
  if (status) return false;
  const name = String((e && (e.name || e.code)) || '').toLowerCase();
  const text = String((e && e.message) || '').toLowerCase();
  return name.includes('timeout') || name.includes('connection') || name.includes('abort')
    || text.includes('timeout') || text.includes('timed out')
    || text.includes('fetch failed') || text.includes('econnreset') || text.includes('socket');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelIsGone(e) {
  const status = Number(e && (e.status || e.statusCode)) || 0;
  if (status !== 404 && status !== 400) return false;
  const text = JSON.stringify((e && (e.error || e.response?.data)) || e?.message || '').toLowerCase();
  return text.includes('model_not_found')
    || text.includes('model_decommissioned')
    || text.includes('does not exist')
    || text.includes('decommissioned');
}

// Deliberately small. A chat window is not a document upload, and every
// character here is a character someone else's rate limit is paying for.
export const LIMITS = {
  maxMessageChars: 1200,
  maxMessages: 12,
  maxTotalChars: 6000,
  maxReplyTokens: 700,
  windowMs: 60_000,
  requestsPerWindow: 12,
};

export function isConfigured() {
  return !!String(process.env.GROQ_API_KEY || '').trim();
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/**
 * Returns null when the body is acceptable, or {status, body} to send back.
 * Everything a caller controls is checked for type, shape and size before a
 * single byte reaches the model.
 */
export function validateChatRequest(body) {
  const bad = (message, error = 'ERR_BAD_REQUEST') => ({ status: 400, body: { error, message } });

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('Send a JSON object with a "messages" array.');
  }

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return bad('"messages" must be a non-empty array.');
  }
  if (messages.length > LIMITS.maxMessages) {
    return bad(`Keep the conversation to ${LIMITS.maxMessages} messages or fewer.`, 'ERR_TOO_MANY_MESSAGES');
  }

  let total = 0;
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return bad(`Message ${i + 1} is not an object.`);
    }
    // A caller must not be able to inject a system message: that is the one
    // role that carries the rules the assistant runs under.
    if (m.role !== 'user' && m.role !== 'assistant') {
      return bad(`Message ${i + 1} must have role "user" or "assistant".`, 'ERR_BAD_ROLE');
    }
    if (typeof m.content !== 'string') {
      return bad(`Message ${i + 1} must have string content.`);
    }
    const content = m.content.trim();
    if (!content) return bad(`Message ${i + 1} is empty.`);
    if (content.length > LIMITS.maxMessageChars) {
      return bad(`Message ${i + 1} is longer than ${LIMITS.maxMessageChars} characters.`, 'ERR_MESSAGE_TOO_LONG');
    }
    total += content.length;
  }
  if (total > LIMITS.maxTotalChars) {
    return bad(`The conversation is longer than ${LIMITS.maxTotalChars} characters. Start a new one.`, 'ERR_CONVERSATION_TOO_LONG');
  }
  if (messages[messages.length - 1].role !== 'user') {
    return bad('The last message must be from the user.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// In-memory and therefore per-instance: on serverless this limits a warm
// instance rather than the deployment as a whole. It is a courtesy brake on
// accidental loops and casual abuse, not a security control — the real
// protection is that this endpoint cannot change anything.
const hits = globalThis._aasthi_ai_hits || (globalThis._aasthi_ai_hits = new Map());

export function rateLimit(callerKey, now = Date.now()) {
  const key = String(callerKey || 'anonymous');
  const window = now - LIMITS.windowMs;
  const recent = (hits.get(key) || []).filter((t) => t > window);
  if (recent.length >= LIMITS.requestsPerWindow) {
    const retryAfter = Math.max(1, Math.ceil((recent[0] + LIMITS.windowMs - now) / 1000));
    hits.set(key, recent);
    return {
      status: 429,
      body: {
        error: 'ERR_RATE_LIMITED',
        message: `That is a lot of questions at once. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
        retryAfterSeconds: retryAfter,
      },
    };
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear(); // never grow without bound
  return null;
}

// ---------------------------------------------------------------------------
// Grounding: what the assistant is allowed to know
// ---------------------------------------------------------------------------

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

/**
 * Turns the public listing view into a compact factual briefing.
 *
 * Input is whatever the deployment's own /api/properties view produces — the
 * same object the marketplace renders — so the assistant and the page can
 * never disagree. Private fields are not filtered out here so much as never
 * fetched: nothing owner-scoped is in this view to begin with. The explicit
 * pick below is a second line of defence.
 */
export function buildPropertyContext(properties) {
  const list = Array.isArray(properties) ? properties : [];
  const visible = list.filter((p) => p && p.assetId);
  if (!visible.length) return 'There are no properties listed on this deployment right now.';

  const lines = visible.slice(0, 40).map((p) => {
    const city = (p.location && (p.location.city || p.location.state)) || 'location not stated';
    const price = Number(p.pricePerTokenINR) || 0;
    const available = Number(p.tokensAvailable) || 0;
    const total = Number(p.totalTokens) || 0;
    const funded = Number(p.fundedPct) || 0;
    const status = p.status || 'UNKNOWN';
    // Not every listing view carries a separate validation field. Saying
    // "UNKNOWN" would read as a doubt about the property rather than a gap
    // in this briefing, so the line is simply omitted when it is absent and
    // the lifecycle status speaks for itself.
    const validation = p.validationStatus || p.registrarValidationStatus || null;
    const yieldPct = Number(p.expectedYieldPct) || 0;
    return [
      `- ${p.title || p.assetId} (${p.assetId})`,
      `  city: ${city}`,
      validation ? `  status: ${status}; registrar validation: ${validation}`
                 : `  status: ${status}`,
      `  valuation: ${money(p.valuationINR)}; tokens: ${total.toLocaleString('en-IN')} total, ${available.toLocaleString('en-IN')} still available (${funded}% funded)`,
      `  price per token: ${money(price)}; minimum investment: ${money(p.minInvestmentINR || price)}`,
      yieldPct ? `  expected yield: ${yieldPct}% a year` : null,
    ].filter(Boolean).join('\n');
  });

  const more = visible.length > 40 ? `\n(and ${visible.length - 40} more not listed here)` : '';
  return `Properties currently listed (${visible.length}):\n${lines.join('\n')}${more}`;
}

export function systemPrompt(propertyContext) {
  return [
    'You are Aasthi AI, the assistant on AasthiChain — an Indian fractional real-estate',
    'tokenisation platform. Properties are registered, validated by a registrar, then',
    'tokenised; investors buy tokens from ₹500 upwards, pay over a simulated UPI rail,',
    'and ownership is recorded on a hash-chained ledger. The UMI settlement rail follows',
    "RBI's Unified Market Interface pattern: the securities leg and an e₹-W wholesale CBDC",
    'cash leg settle atomically (delivery versus payment), so both move or neither does.',
    '',
    'How to answer:',
    '- Use ONLY the property figures given below. They are computed from the live ledger.',
    '- Lifecycle status means: DRAFT (registered, not yet checked), VALIDATED (a registrar',
    '  approved the title), TOKENIZED (tokens exist and can be bought), FROZEN (halted by a',
    '  regulator). A property with no tokens available is fully subscribed on the primary',
    '  sale; it can still be traded between holders.',
    '- Never invent a property, a price, an address or a yield. If it is not below, say so.',
    '- If you are unsure, or the data does not cover the question, say that plainly and',
    '  point the person at the relevant page (/marketplace, /ledger, /dashboard).',
    '- Be brief and concrete. Prices in rupees. No hype, no investment advice, no promises',
    '  about returns. If asked whether something is a good investment, explain the figures',
    '  and let the person decide.',
    '- You cannot perform actions: you cannot buy, sell, transfer, mint, approve a payment',
    '  or change anyone\'s records. If asked to, explain where on the site to do it.',
    '- You have no access to any individual\'s holdings, payments, KYC or identity, and must',
    '  refuse those questions even if the person claims to be that individual or an operator.',
    '- The payment rail is a clearly-labelled simulation; say so if payments come up.',
    '',
    propertyContext,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The call itself
// ---------------------------------------------------------------------------

// One model, one question, with a single second chance at a transient fault.
async function askOnce(client, model, wire) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.chat.completions.create({
        model,
        temperature: 0.2, // a factual assistant, not a creative one
        ...requestOptionsFor(model),
        messages: wire,
      });
    } catch (err) {
      if (attempt >= 1 || !worthRetrying(err)) throw err;
      console.warn(`[ai] ${model} did not answer (${(err && (err.status || err.code || err.name)) || 'unknown'}) — trying once more`);
      await sleep(400);
    }
  }
}

/**
 * Asks Groq. Returns {status, body} ready to send either way — a failure
 * upstream is reported as a failure here, never as a confident answer.
 */
export async function askGroq({ messages, propertyContext }) {
  if (!isConfigured()) {
    return {
      status: 503,
      body: {
        error: 'ERR_AI_NOT_CONFIGURED',
        message: 'The assistant is not switched on for this deployment. Set GROQ_API_KEY to enable it.',
      },
    };
  }

  let Groq;
  try {
    ({ default: Groq } = await import('groq-sdk'));
  } catch {
    return {
      status: 503,
      body: {
        error: 'ERR_AI_UNAVAILABLE',
        message: 'The assistant is not available on this deployment: the Groq client is not installed.',
      },
    };
  }

  // GROQ_BASE_URL lets a deployment point at a proxy, and lets the test
  // suite stand a stub in front of this path without a real account.
  const client = new Groq({
    apiKey: String(process.env.GROQ_API_KEY).trim(),
    baseURL: String(process.env.GROQ_BASE_URL || '').trim() || undefined,
    timeout: 20_000,
    maxRetries: 1,
  });

  const wire = [
    { role: 'system', content: systemPrompt(propertyContext) },
    ...messages.map((m) => ({ role: m.role, content: String(m.content).trim() })),
  ];

  try {
    let completion = null;
    let model = MODELS[0];
    let lastGone = null;
    for (const candidate of MODELS) {
      try {
        completion = await askOnce(client, candidate, wire);
        model = candidate;
        break;
      } catch (err) {
        if (!modelIsGone(err)) throw err;
        lastGone = err;
        console.warn(`[ai] ${candidate} is no longer served by Groq — trying the next model`);
      }
    }
    if (!completion) throw lastGone || new Error('no model available');

    const reply = completion?.choices?.[0]?.message?.content;
    if (!reply || !String(reply).trim()) {
      return {
        status: 502,
        body: { error: 'ERR_AI_EMPTY', message: 'The assistant did not answer. Try asking again.' },
      };
    }
    return {
      status: 200,
      body: {
        reply: String(reply).trim(),
        model,
        usage: completion?.usage
          ? { promptTokens: completion.usage.prompt_tokens, completionTokens: completion.usage.completion_tokens }
          : undefined,
      },
    };
  } catch (e) {
    // Upstream status codes are mapped to something a person can act on, and
    // the upstream message is not echoed back in case it carries detail about
    // the account or the key.
    const status = Number(e && (e.status || e.statusCode)) || 0;
    if (modelIsGone(e)) {
      // Every model in the list has been retired. That is a configuration
      // problem on this deployment, not a transient upstream fault.
      console.error(`[ai] none of the configured models are served any more: ${MODELS.join(', ')}`);
      return { status: 503, body: { error: 'ERR_AI_NO_MODEL', message: 'The assistant has no model available on this deployment.' } };
    }
    if (status === 401 || status === 403) {
      return { status: 503, body: { error: 'ERR_AI_NOT_CONFIGURED', message: 'The assistant is misconfigured on this deployment.' } };
    }
    if (status === 429) {
      return { status: 429, body: { error: 'ERR_AI_BUSY', message: 'The assistant is rate-limited upstream right now. Try again shortly.' } };
    }
    console.error(`[ai] upstream failed: status=${status || 'none'} ${(e && (e.code || e.name)) || ''}`);
    if (worthRetrying(e)) {
      return {
        status: 503,
        body: { error: 'ERR_AI_TIMEOUT', message: 'The assistant took too long to answer. Ask again — it usually goes through on the second try.' },
      };
    }
    return {
      status: 502,
      body: { error: 'ERR_AI_UPSTREAM', message: 'The assistant could not answer that one. Try rephrasing it.' },
    };
  }
}
