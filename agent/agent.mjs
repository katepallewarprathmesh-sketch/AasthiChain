// The runtime: the part that actually talks to the rail.
//
// This is a real autonomous actor, not a simulation of one. It holds a
// passport on the agent register, acts under a mandate its principal granted,
// and every request it makes goes through the ordinary HTTP surface with its
// own identity and its mandate in a header. The rail gives it no special
// treatment and no private entrance. That is the point: if the guardrails
// only hold for well-behaved callers they are not guardrails.
//
// THE FOUR RULES THIS RUNTIME FOLLOWS
//
// 1. Ask before acting. Every intent goes to POST /umi/mandates/{id}/check
//    first, which changes nothing and answers whether the act would be
//    permitted. An agent that discovers its limits by hitting them has
//    already hit them.
//
// 2. Re-read authority every cycle. Passport and mandate are fetched at the
//    top of each pass, not cached from startup. A revocation has to be able
//    to stop an agent that is already running, and a runtime that trusts its
//    own memory of its authority is precisely what defeats one.
//
// 3. Record the refusals. The log keeps every attempt the rail turned down,
//    with the rail's own reason. The refusals are the evidence that the
//    bounds work; a log of successes proves only that the happy path exists.
//
// 4. Stop when told, by any of three independent means: the passport
//    revoked, the mandate revoked or exhausted, or an operator stop file on
//    disk. The stop file is checked on every pass so a human with shell
//    access can halt it without the rail's cooperation.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, shouldStop } from './policy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const DEFAULTS = {
  rail: process.env.RAIL || 'http://localhost:21100',
  // The log and the stop file live beside the repo, not inside it: a running
  // agent's state is not source.
  logPath: process.env.AGENT_LOG || path.join(ROOT, '.agent', 'runs.jsonl'),
  stopPath: process.env.AGENT_STOP || path.join(ROOT, '.agent', 'STOP'),
};

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/** One HTTP call, with the agent's identity and mandate on every request. */
async function call(cfg, method, p, body) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Fabric-Identity': cfg.agentId,
    'X-Identity-Role': 'Agent',
  };
  if (cfg.mandateId) headers['X-Agent-Mandate'] = cfg.mandateId;

  const res = await fetch(cfg.rail + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // A hung rail must not hang the agent. Without this the loop can stall
    // for minutes on a single socket and silently stop being an agent.
    signal: AbortSignal.timeout(cfg.timeoutMs || 10_000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

/** Read everything the policy needs, in one pass, before deciding anything. */
async function observe(cfg) {
  const [passport, mandate, conditions, credentials] = await Promise.all([
    call(cfg, 'GET', `/umi/agents/${encodeURIComponent(cfg.agentId)}`),
    call(cfg, 'GET', `/umi/mandates/${encodeURIComponent(cfg.mandateId)}`),
    call(cfg, 'GET', '/umi/conditions'),
    call(cfg, 'GET', '/umi/credentials?limit=200'),
  ]);
  return {
    passport: passport.ok ? (passport.data.agent || passport.data) : null,
    mandate: mandate.ok ? (mandate.data.mandate || mandate.data) : null,
    conditions: (conditions.data && conditions.data.conditions) || [],
    credentials: (credentials.data && credentials.data.credentials) || [],
  };
}

/**
 * One pass: observe, check authority, decide, ask, act, record.
 *
 * Returns the pass record rather than printing it, so tests can assert on
 * the decisions without parsing output.
 */
export async function runOnce(cfg) {
  const started = new Date().toISOString();
  const nowMs = Date.now();
  const pass = {
    at: started, agentId: cfg.agentId, mandateId: cfg.mandateId,
    stopped: false, why: '', considered: 0, acted: [], refused: [], skipped: [],
  };

  const killed = await exists(cfg.stopPath);
  const seen = await observe(cfg);

  const stop = shouldStop({ passport: seen.passport, mandate: seen.mandate, killed, nowMs });
  if (stop.stop) {
    pass.stopped = true;
    pass.why = stop.why;
    await record(cfg, pass);
    return pass;
  }

  const limits = {
    remainingPaise: Number(seen.mandate.limitPaise || 0) - Number(seen.mandate.spentPaise || 0),
    assets: seen.mandate.assets || [],
    actions: seen.mandate.actions || [],
  };
  pass.headroomPaise = limits.remainingPaise;

  const { intents, skipped } = decide(
    { conditions: seen.conditions, credentials: seen.credentials, nowMs }, limits);
  pass.considered = seen.conditions.length;
  pass.skipped = skipped;

  for (const intent of intents) {
    // Rule 1: ask first. A check moves nothing and costs one round trip.
    const check = await call(cfg, 'POST', `/umi/mandates/${encodeURIComponent(cfg.mandateId)}/check`, {
      // The check route is denominated in rupees, the rest of the rail in
      // paise. Converting here rather than guessing is the difference
      // between a check that bounds the act and one that waves it through
      // a hundred times too small.
      action: intent.action, assetId: intent.assetId, amountINR: intent.amountPaise / 100,
    });
    const allowed = check.ok && check.data && (check.data.allowed === true ||
      (check.data.check && check.data.check.allowed === true));
    if (!allowed) {
      pass.refused.push({
        ...intent, stage: 'check', status: check.status,
        railSaid: reasonFrom(check.data),
      });
      continue;
    }

    const did = await call(cfg, 'POST', `/umi/conditions/${encodeURIComponent(intent.conditionId)}/present`, {
      credentialId: intent.credentialId,
    });
    if (did.ok) {
      pass.acted.push({ ...intent, status: did.status, block: blockFrom(did.data) });
    } else {
      // Rule 3: a refusal at the act is the most valuable line in the log.
      // The rail said no after saying the mandate allowed it, which means
      // something other than the mandate stopped it, and that is worth
      // keeping verbatim.
      pass.refused.push({ ...intent, stage: 'act', status: did.status, railSaid: reasonFrom(did.data) });
    }
  }

  await record(cfg, pass);
  return pass;
}

const reasonFrom = (d) => {
  if (!d) return 'no answer';
  if (d.message) return `${d.error ? d.error + ': ' : ''}${d.message}`;
  if (d.check && d.check.reason) return d.check.reason;
  if (d.reason) return d.reason;
  return d.error || 'refused without a reason';
};

const blockFrom = (d) => (d && d.condition && d.condition.releasedBlock) || 0;

/** Append-only run log. The agent's own record of what it did and was told. */
async function record(cfg, pass) {
  await mkdir(path.dirname(cfg.logPath), { recursive: true });
  await writeFile(cfg.logPath, JSON.stringify(pass) + '\n', { flag: 'a' });
}

/** Read the log back, newest first. Used by the rail-side status route. */
export async function readLog(logPath, limit = 50) {
  try {
    const text = await readFile(logPath, 'utf8');
    return text.trim().split('\n').filter(Boolean).slice(-limit).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch { return []; }
}

export default { runOnce, readLog, DEFAULTS };
