// The local stack must not lie about what it is running.
//
// This guards a trap that cost real debugging time. wait_for_port only asks
// "is something listening". When an older rail or app was still holding the
// port, the newly started process failed to bind, died quietly, and the
// script printed a healthy banner while every request was served by the old
// binary. The symptom is a route that exists in the source, exists in the
// built binary, and still returns 404, which sends you looking for the bug
// in entirely the wrong place.
//
// Two rules, read out of the script itself:
//   1. every port is claimed before it is used, and strays are stopped,
//   2. --stop clears strays too, because a pidfile is not the whole truth.
//
//   node tests/devstack.test.mjs

import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const sh = readFileSync(new URL('scripts/dev-stack.sh', root), 'utf8')
const mk = readFileSync(new URL('Makefile', root), 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')) }
}

console.log('\nlocal stack')

// 1. Both services claim their port before starting.
ok('the rail claims its port before starting', /claim_port rail "\$RAIL_PORT"/.test(sh))
ok('the app claims its port before starting', /claim_port app "\$APP_PORT"/.test(sh))
ok('claiming a port stops whatever was already holding it', /claim_port\(\)[\s\S]{0,200}stop_strays/.test(sh))
ok('a port that cannot be claimed stops the script instead of being ignored',
  /port \$2 is still held[\s\S]{0,400}exit 1/.test(sh))

// 2. The listener check alone is not treated as proof of a healthy start.
for (const [svc, pidvar] of [['rail', 'RAIL_PID'], ['app', 'APP_PID']]) {
  ok(`the ${svc} start is verified against the pid it launched`,
    new RegExp(`${pidvar}=\\$!`).test(sh) && new RegExp(`kill -0 "\\$${pidvar}"`).test(sh))
}

// 3. --stop really stops: pidfiles first, then anything left on the ports.
ok('--stop clears strays on the rail port', /--stop\)[\s\S]{0,900}stop_strays rail "\$RAIL_PORT"/.test(sh))
ok('--stop clears strays on the app port', /--stop\)[\s\S]{0,900}stop_strays app "\$APP_PORT"/.test(sh))

// 4. The stray matcher must know both processes by their real command lines.
//    A pattern that matches neither would make all of the above a no-op.
ok('the rail is matched by the binary it runs', /rail\)\s*echo "\^\/tmp\/umigw\$"/.test(sh))
ok('the app is matched by the command it runs', /app\)\s*echo "node server\\\.js"/.test(sh))

// 5. test-fresh depends on the stop actually stopping, because the harness
//    starts its own app with its own admin key. A leftover app on :8080
//    answers with the wrong key and a dozen suites fail for no real reason.
ok('test-fresh stops the stack before it rebuilds one', /test-fresh:[\s\S]{0,200}dev-stack\.sh --stop/.test(mk))

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
