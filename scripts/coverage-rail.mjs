// How much of the rail do the tests provably exercise?
//
// Borrowed from Scapia's write-up of their Argus test lab (October 2026). The
// part worth stealing was not the device farm: it was the second tool they
// built, which asks a harder question than "do the tests pass". They map every
// action a user can take, replay the suite against that map on paper, and give
// each action one of three verdicts: covered, possible, or not covered. Their
// own answer was uncomfortable (24.6% of commerce actions certainly covered,
// trains under 2%) and publishing it was the point.
//
// This repository has the same blind spot. "143 checks, 0 failed" says nothing
// about how much of the rail those checks touch, and a passing suite that
// exercises a third of the endpoints is a passing suite.
//
// WHAT THIS DOES
//
// 1. Builds the catalogue of actions the rail exposes, from the route tables
//    declared at the top of each server file, and cross-checks every declared
//    prefix against the mux registrations so the catalogue cannot drift into
//    fiction.
// 2. Replays every suite in tests/ on paper: each request a suite makes is
//    matched to an action by method and path, with path parameters
//    normalised.
// 3. Gives each action a verdict.
//      covered      a suite certainly issues this method against this path
//      possible     a suite hits the path but the method is not provable from
//                   the source, or the path is assembled at runtime
//      not covered  nothing in the suite reaches it
//
// It reads source only: no rail is started and nothing is executed, so the
// same commit gives the same number on any machine.
//
//   node scripts/coverage-rail.mjs            human readable
//   node scripts/coverage-rail.mjs --json     machine readable
//   node scripts/coverage-rail.mjs --gaps     only what is not covered

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = join(ROOT, 'drunix-gateway');
const TESTS = join(ROOT, 'tests');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// ---------------------------------------------------------------------------
// 1. The catalogue
// ---------------------------------------------------------------------------

// Route tables are declared as a comment block at the top of each server file:
//
//	GET  /umi/aml/watchlist             the list itself
//
// That is the contract the file claims. It is only usable as a catalogue if it
// cannot quietly diverge from what is registered, which is what checkDrift
// below is for.
function catalogue() {
  const actions = [];
  const files = readdirSync(GATEWAY).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));

  for (const file of files) {
    const src = readFileSync(join(GATEWAY, file), 'utf8');
    for (const line of src.split('\n')) {
      const m = line.match(/^\/\/\t(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]+)/);
      if (!m) continue;
      const [, method, rawPath] = m;
      const path = normalisePath(rawPath);
      if (!path.startsWith('/')) continue;
      if (actions.some((a) => a.method === method && a.path === path)) continue;
      actions.push({ method, path, file, declaredAs: rawPath });
    }
  }
  return actions.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

// A declared path is useful only if the mux actually serves its prefix.
function checkDrift(actions) {
  const registered = new Set();
  for (const file of readdirSync(GATEWAY).filter((f) => f.endsWith('.go'))) {
    const src = readFileSync(join(GATEWAY, file), 'utf8');
    for (const m of src.matchAll(/mux\.HandleFunc\(\s*"([^"]+)"/g)) registered.add(m[1]);
  }
  const orphans = [];
  for (const a of actions) {
    const served = [...registered].some((r) => (r.endsWith('/') ? a.path.startsWith(r) || a.path + '/' === r : a.path === r));
    if (!served) orphans.push(a);
  }
  return orphans;
}

// Path parameters are written several ways across the codebase. One shape.
function normalisePath(p) {
  return p
    .replace(/\[\?[^\]]*\]/g, '')        // GET /umi/aml/cases[?limit=] -> /umi/aml/cases
    .replace(/\?.*$/, '')
    .replace(/\{[^}]+\}/g, '{p}')        // {id}, {holder} -> {p}
    .replace(/\/$/, '')
    || '/';
}

// ---------------------------------------------------------------------------
// 2. Replaying the suites on paper
// ---------------------------------------------------------------------------

// Every request a suite can make, as (method, path). Methods come from the
// helper name where the suite uses one (get/post/rail/put/del), from an
// explicit `method:` where it uses fetch directly, and are left unknown when
// neither is provable: an unknown method is reported as possible, never as
// covered, because the whole point is to stop counting maybes as proof.
function requestsFromTests() {
  const hits = new Map(); // normalised path -> Set of methods ('?' for unknown)
  if (!existsSync(TESTS)) return hits;

  const record = (path, method) => {
    const key = normalisePath(stripBase(path));
    if (!key.startsWith('/')) return;
    if (!hits.has(key)) hits.set(key, new Set());
    hits.get(key).add(method);
  };

  for (const file of readdirSync(TESTS).filter((f) => f.endsWith('.test.mjs'))) {
    const src = readFileSync(join(TESTS, file), 'utf8');
    const bases = basePrefixes(src);
    // Curried helpers bind the method once and are then called under another
    // name: const asRegistrar = post('registrar1', 'Registrar'). Follow the
    // alias, or every suite written that way reads as untested.
    const alias = {};
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(get|post|put|patch|del|delete)\s*\(/gi)) {
      alias[m[1]] = m[2].toLowerCase();
    }
    const recordAll = (path, method) => { for (const b of bases) record(b + path, method); };

    // A path assembled by concatenation is still a path: '/umi/backing/' + id.
    const concatenated = new Set();
    for (const m of src.matchAll(/(['"`])(\/[^'"`]*\/)\1\s*\+\s*\w/g)) concatenated.add(m[2] + '{p}');

    // Helper-style calls: post('/umi/x', ...), get(`/umi/y/${id}`), rail('/z')
    const helperNames = ['get', 'post', 'put', 'patch', 'del', 'delete', 'rail', 'umi', 'api', 'req', ...Object.keys(alias)];
    const helperRe = new RegExp(`\\b(${helperNames.join('|')})\\s*\\(\\s*(['"\`])([^'"\`]+)\\2`, 'g');
    for (const m of src.matchAll(helperRe)) {
      const helper = (alias[m[1]] || m[1]).toLowerCase();
      const path = m[3];
      if (!path.startsWith('/')) continue;
      const method =
        helper === 'get' ? 'GET'
          : helper === 'post' ? 'POST'
            : helper === 'put' ? 'PUT'
              : helper === 'patch' ? 'PATCH'
                : helper === 'del' || helper === 'delete' ? 'DELETE'
                  : '?';
      recordAll(path, method);
      if (concatenated.has(path + '{p}') || concatenated.has(path)) recordAll(path.replace(/\/$/, '') + '/{p}', method);
    }

    // rail('/umi/x', { method: 'POST', ... }) and the curried helpers built on
    // top of it: the method sits in the options object next to the path.
    for (const m of src.matchAll(/\b\w+\(\s*(['"`])(\/[^'"`]*)\1\s*(?:\+\s*[\w.$]+\s*)?,\s*\{([\s\S]{0,200}?)\}/g)) {
      const method = m[3].match(/method:\s*['"](\w+)['"]/i);
      if (method) {
        recordAll(m[2], method[1].toUpperCase());
        continue;
      }
      // fetch defaults to GET, so an options object carrying headers and no
      // method is a provable GET. A payload object is not an options object,
      // which is why this looks for headers rather than for any object.
      if (/headers\s*[:(]/.test(m[3])) recordAll(m[2], 'GET');
    }

    // Direct fetch, where the method sits in the options object nearby.
    for (const m of src.matchAll(/fetch\(\s*([^)]{0,400}?)\)/gs)) {
      const blob = m[1];
      const pm = blob.match(/(['"`])((?:\/|[^'"`]*\/api)[^'"`]*)\1/);
      if (!pm) continue;
      const mm = blob.match(/method:\s*['"](\w+)['"]/i);
      const path = pm[2].replace(/^.*?(?=\/(?:api|umi|drunix|fraud)\b)/, '');
      recordAll(path, mm ? mm[1].toUpperCase() : 'GET');
    }
  }
  return hits;
}

// A suite's helpers hide the prefix. `get('/aml')` in one file means
// /umi/aml, because that file's helper is defined as BASE + '/api/umi' + path,
// while another file writes the full path. Rather than parse every helper
// shape, collect the base literals a file uses and try each of them: a request
// counts against an action if any of the file's bases makes it match. That is
// generous in principle and exact in practice, because the bases are a short
// known list and a wrong guess cannot invent an action that does not exist.
function basePrefixes(src) {
  const bases = new Set(['']);
  for (const m of src.matchAll(/(['"`])(\/api\/umi|\/api|\/umi)(?=['"`$])/g)) bases.add(m[2]);
  return [...bases];
}

// Suites address the rail through several prefixes (directly on :21100, or
// proxied under /api/umi). Reduce them all to the rail's own path.
function stripBase(p) {
  let out = p.replace(/^https?:\/\/[^/]+/, '');
  out = out.replace(/^\/api\/umi(?=\/|$)/, '/umi');
  out = out.replace(/^\/api(?=\/(?:drunix|fraud|umi)\b)/, '');
  // A template segment is a path parameter whatever it interpolates.
  out = out.replace(/\$\{[^}]*\}/g, '{p}');
  return out;
}

// ---------------------------------------------------------------------------
// 3. The verdicts
// ---------------------------------------------------------------------------

function verdictFor(action, hits) {
  // Compare shapes, not strings: an action's {p} matches any single segment,
  // so '/umi/backing/NOBODY-ATTESTED-THIS' in a suite proves
  // 'GET /umi/backing/{p}'. Without this the measurement reads as zero for
  // every module whose suite uses a real identifier, which is all of them.
  const pattern = new RegExp('^' + action.path
    .split('/')
    .map((seg) => (seg === '{p}' ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/') + '$');

  let sawPath = false;
  for (const [path, methods] of hits) {
    if (!pattern.test(path)) continue;
    sawPath = true;
    if (methods.has(action.method)) return 'covered';
  }
  return sawPath ? 'possible' : 'not covered';
}

function group(action) {
  const parts = action.path.split('/').filter(Boolean);
  if (parts[0] === 'umi') return parts[1] || 'umi';
  return parts[0] || 'root';
}

function main() {
  const args = process.argv.slice(2);
  const actions = catalogue();
  const hits = requestsFromTests();
  const orphans = checkDrift(actions);

  const rows = actions.map((a) => ({ ...a, group: group(a), verdict: verdictFor(a, hits) }));
  const counts = { covered: 0, possible: 0, 'not covered': 0 };
  for (const r of rows) counts[r.verdict]++;
  const total = rows.length;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);

  const byGroup = {};
  for (const r of rows) {
    byGroup[r.group] ||= { total: 0, covered: 0, possible: 0 };
    byGroup[r.group].total++;
    if (r.verdict === 'covered') byGroup[r.group].covered++;
    if (r.verdict === 'possible') byGroup[r.group].possible++;
  }

  const summary = {
    actions: total,
    covered: counts.covered,
    possible: counts.possible,
    notCovered: counts['not covered'],
    coveredPercent: pct(counts.covered),
    possiblePercent: pct(counts.possible),
    undeclaredOrDriftedRoutes: orphans.map((o) => `${o.method} ${o.path} (${o.file})`),
    byGroup,
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify({ summary, rows }, null, 2));
    return;
  }

  if (args.includes('--gaps')) {
    console.log('\nNot covered by any suite\n');
    for (const r of rows.filter((x) => x.verdict !== 'covered')) {
      console.log(`  ${r.verdict === 'possible' ? 'possible   ' : 'not covered'}  ${r.method.padEnd(6)} ${r.path}`);
    }
    console.log('');
    return;
  }

  console.log('\nRail action coverage (source analysis, nothing is executed)\n');
  console.log(`  ${total} actions declared across the rail`);
  console.log(`  covered      ${counts.covered} (${pct(counts.covered)}%)`);
  console.log(`  possible     ${counts.possible} (${pct(counts.possible)}%)`);
  console.log(`  not covered  ${counts['not covered']} (${pct(counts['not covered'])}%)`);
  console.log('\n  by area:');
  for (const [g, c] of Object.entries(byGroup).sort((a, b) => b[1].total - a[1].total)) {
    const p = Math.round((c.covered / c.total) * 100);
    console.log(`    ${g.padEnd(14)} ${String(c.covered).padStart(3)}/${String(c.total).padEnd(3)} ${String(p).padStart(3)}%`);
  }
  if (orphans.length) {
    console.log('\n  declared but not served by any registered route:');
    for (const o of orphans) console.log(`    ${o.method} ${o.path}  (${o.file})`);
  }
  console.log('');
}

main();

export { catalogue, requestsFromTests, verdictFor, checkDrift, normalisePath, stripBase };
