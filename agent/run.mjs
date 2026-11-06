#!/usr/bin/env node
// The harness entry point: set an agent up, or let it run.
//
//   node agent/run.mjs setup                  register a passport and grant a mandate
//   node agent/run.mjs once                   one pass, then exit
//   node agent/run.mjs watch --every 15       keep going until stopped
//   node agent/run.mjs stop                   write the stop file
//   node agent/run.mjs log                    what it has done and been refused
//
// Configuration is read from .agent/config.json, written by `setup`.
//
// WHY A SEPARATE PROCESS AND NOT A GOROUTINE IN THE RAIL
// An agent that lives inside the rail is a feature of the rail, and proves
// nothing about whether the rail can withstand one. This runs outside, over
// HTTP, with no privileges the rail does not hand to any other caller, so
// every bound it respects is a bound the rail enforced rather than one the
// agent chose to honour.
//
// RUNNING IT IS A DELIBERATE ACT
// Nothing starts this automatically, no deployment runs it, and `setup` has
// to be performed by a named principal. An autonomous actor that starts
// itself is not something to add quietly.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce, readLog, DEFAULTS } from './agent.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIR = process.env.AGENT_HOME || path.join(ROOT, '.agent');
const CONFIG = path.join(DIR, 'config.json');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'once';
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const rail = process.env.RAIL || flag('rail', 'http://localhost:21100');

const headers = (id, role) => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role,
});

async function api(method, p, id, role, body) {
  const res = await fetch(rail + p, {
    method, headers: headers(id, role),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${data.message || data.error || text.slice(0, 160)}`);
  return data;
}

const loadConfig = async () => JSON.parse(await readFile(CONFIG, 'utf8'));

// ---------------------------------------------------------------------------

async function setup() {
  const principal = flag('principal', 'investor1');
  const role = flag('role', 'Investor');
  const limitINR = Number(flag('limit', '5000'));
  const hours = Number(flag('hours', '24'));

  // ORDER MATTERS, AND IT IS NOT THE OBVIOUS ONE.
  //
  // The passport is registered first, and the mandate is then granted to the
  // pseudonym the register just issued. Doing it the other way round, which
  // is what the passport's own mandateId field invites, produces an agent
  // whose mandate names one identity and whose passport names another. The
  // rail checks an agent's standing by the name on the mandate, so that
  // agent keeps working after its passport is revoked: the kill switch is
  // wired to a name nothing uses.
  //
  // Granting to the pseudonym makes revocation of the passport inert every
  // mandate the agent holds, which is the behaviour the register promises.
  const registered = await api('POST', '/umi/agents', principal, role, {
    purpose: 'Releases conditional settlements whose named credential has been issued and not revoked.',
    version: '1.0.0',
    custodians: ['registrar1', 'regulator1'],
    threshold: 2,
  });
  const passport = registered.agent || registered;

  // Note what is being granted: one action, a hard rupee ceiling, and an
  // expiry. An agent granted everything indefinitely is a second set of
  // credentials for the principal, not a delegate.
  const granted = await api('POST', '/umi/mandates', principal, role, {
    agent: passport.agentId,
    actions: ['RELEASE_CONDITION'],
    limitINR,
    expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
    purpose: 'Release conditional settlements once the named credential exists.',
  });
  const mandate = granted.mandate || granted;

  const cfg = {
    rail,
    principal,
    // The agent acts under its pseudonym, which is also the name on the
    // mandate. One identity, so one revocation reaches everything.
    agentId: passport.agentId,
    passportId: passport.agentId,
    mandateId: mandate.mandateId,
    logPath: DEFAULTS.logPath,
    stopPath: DEFAULTS.stopPath,
  };
  await mkdir(DIR, { recursive: true });
  await writeFile(CONFIG, JSON.stringify(cfg, null, 2) + '\n');

  console.log('agent ready');
  console.log('  principal   ' + principal);
  console.log('  acts as     ' + cfg.agentId);
  console.log('  passport    ' + cfg.passportId);
  console.log('  mandate     ' + cfg.mandateId + `  (RELEASE_CONDITION, Rs ${limitINR}, ${hours}h)`);
  console.log('  stop with   node agent/run.mjs stop');
  console.log(`  or revoke   POST /umi/agents/${cfg.passportId}/revoke as ${principal}`);
}

function report(pass) {
  if (pass.stopped) { console.log(`stopped: ${pass.why}`); return; }
  console.log(`pass ${pass.at}  considered ${pass.considered}  acted ${pass.acted.length}  refused ${pass.refused.length}  skipped ${pass.skipped.length}`);
  for (const a of pass.acted) console.log(`  acted    ${a.conditionId}  ${a.amountPaise} paise  block ${a.block}`);
  for (const r of pass.refused) console.log(`  refused  ${r.conditionId}  at ${r.stage}: ${r.railSaid}`);
  for (const s of pass.skipped) console.log(`  skipped  ${s.conditionId}: ${s.why}`);
}

async function once() {
  const pass = await runOnce(await loadConfig());
  report(pass);
  return pass;
}

async function watch() {
  const every = Number(flag('every', '15')) * 1000;
  const cfg = await loadConfig();
  console.log(`watching every ${every / 1000}s. Stop with: node agent/run.mjs stop`);
  for (;;) {
    const pass = await runOnce(cfg);
    report(pass);
    // A stop is final. Looping after one would make the stop advisory, and
    // an advisory stop is not a stop.
    if (pass.stopped) return;
    await new Promise(r => setTimeout(r, every));
  }
}

async function main() {
  switch (cmd) {
    case 'setup': return setup();
    case 'once': return void (await once());
    case 'watch': return watch();
    case 'stop': {
      const cfg = await loadConfig().catch(() => ({ stopPath: DEFAULTS.stopPath }));
      await mkdir(path.dirname(cfg.stopPath), { recursive: true });
      await writeFile(cfg.stopPath, new Date().toISOString() + '\n');
      console.log('stop file written. The next pass will halt.');
      return;
    }
    case 'start': {
      const cfg = await loadConfig();
      await rm(cfg.stopPath, { force: true });
      console.log('stop file cleared.');
      return;
    }
    case 'log': {
      const cfg = await loadConfig();
      for (const p of await readLog(cfg.logPath, Number(flag('limit', '20')))) report(p);
      return;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      console.error('  setup | once | watch | stop | start | log');
      process.exit(2);
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
