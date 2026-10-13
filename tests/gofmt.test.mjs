// Go sources must be gofmt-clean, and we must find out before CI does.
//
// CI's very first Go step is `gofmt -l .`, and a non-empty list fails the job
// before anything is built or tested. diagnostics.go went in with a map
// literal whose keys were aligned by hand to a width gofmt disagreed with.
// Everything else was green: it built, it vetted, it passed `go test -race`,
// the whole local gate was clean. So the break was invisible locally and the
// Go job failed on that commit and on every commit after it, because the
// unformatted file simply stayed there.
//
// The gap was in the local gate, not in CI: regression.sh ran no Go checks at
// all. This suite closes that by running the exact check CI runs, in the same
// sweep as everything else.
//
// It fails rather than skips when Go is missing. A formatting check that
// quietly passes when it cannot look is how the original break survived.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const MODULES = ['chaincode', 'api-gateway', 'drunix-gateway', 'payment-gateway'];

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// gofmt ships with Go but is not always on PATH in a bare shell.
function findGofmt() {
  const candidates = ['gofmt'];
  for (const dir of ['/tmp/go/bin', '/usr/local/go/bin', '/usr/lib/go/bin']) {
    candidates.push(join(dir, 'gofmt'));
  }
  for (const c of candidates) {
    try {
      execFileSync(c, ['-h'], { stdio: 'ignore' });
      return c;
    } catch (e) {
      // `gofmt -h` exits non-zero but still proves the binary runs.
      if (e && e.status !== undefined && e.code !== 'ENOENT') return c;
    }
  }
  return null;
}

const gofmt = findGofmt();
t('gofmt is available to check with', Boolean(gofmt),
  'install Go or add it to PATH; a formatting check that cannot look must not pass');

if (gofmt) {
  for (const m of MODULES) {
    const dir = join(ROOT, m);
    if (!existsSync(dir)) { t(`${m} exists`, false, 'module directory missing'); continue; }
    let listed = '';
    try {
      listed = execFileSync(gofmt, ['-l', '.'], { cwd: dir, encoding: 'utf8' }).trim();
    } catch (e) {
      t(`${m} is gofmt-clean`, false, `gofmt failed: ${e.message}`);
      continue;
    }
    const files = listed ? listed.split('\n').filter(Boolean) : [];
    t(`${m} is gofmt-clean`, files.length === 0,
      files.length ? `run: (cd ${m} && gofmt -w ${files.join(' ')})` : '');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
