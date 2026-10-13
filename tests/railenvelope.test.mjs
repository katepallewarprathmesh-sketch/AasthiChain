// Nobody noticed four panels were reading the wrong object.
//
// umiFetch answers an envelope, { ok, status, data }, and the payload is
// under .data. Four panels in a row treated the envelope AS the payload:
// `const a = await umi('/assets'); a.assets` is always undefined, so the
// carbon table, the throughput figures, the private data collections and the
// interop connectors all rendered as empty husks against a rail that was
// answering correctly. Nothing failed, because an empty list is a legitimate
// state and no test was looking.
//
// This reads the source of every component that talks to the rail and checks
// that the result of a umiFetch call is used through the envelope. It is a
// static check rather than a render test on purpose: the bug is a shape
// mistake at the call site, which is exactly what a static check can see and
// a 200-response render test would happily reproduce.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
};

const ROOTS = ['frontend/src/components', 'frontend/src/pages'];

const files = [];
for (const root of ROOTS) {
  let entries = [];
  try { entries = readdirSync(root); } catch { continue; }
  for (const name of entries) {
    const full = join(root, name);
    if (statSync(full).isFile() && /\.jsx?$/.test(name)) files.push(full);
  }
}
t('found the rail-facing source files', files.length > 0, `${files.length} files`);

// Properties the envelope itself legitimately has.
const ENVELOPE = new Set(['ok', 'status', 'data', 'then', 'catch', 'finally']);

// Short names like d, r and res get reused all over a file, so the check is
// windowed: only the handful of lines right after the binding, which is
// where a call site reads its own result. A wider window reports a different
// variable with the same name and the suite stops being believed.
const WINDOW = 8;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!/umiFetch|umiPost/.test(src)) continue;
  const lines = src.split('\n');

  const offenders = [];
  lines.forEach((line, idx) => {
    const m = line.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:umi|umiFetch|umiPost)\s*\(/);
    if (!m) return;
    const name = m[1];
    const window = lines.slice(idx, idx + WINDOW).join('\n');
    const reads = [...window.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((x) => x[1]);
    const usesEnvelope = reads.some((prop) => prop === 'data' || prop === 'ok');
    for (const prop of reads) {
      if (!ENVELOPE.has(prop) && !usesEnvelope) offenders.push(`line ${idx + 1}: ${name}.${prop}`);
    }
  });

  t(`${file} reads the rail through { ok, data }`,
    offenders.length === 0,
    offenders.length ? `payload read straight off the envelope: ${[...new Set(offenders)].join('; ')}` : '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
