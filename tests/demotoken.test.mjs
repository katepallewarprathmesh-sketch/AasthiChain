// Extracts the REAL auth block from frontend/api/index.js and evaluates it, so
// this harness cannot drift from production code. A stray require() in that
// ESM file - which once 500'd every route - fails this suite.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../frontend/api/index.js'), 'utf8');
const start = src.indexOf('const DEMO_AUTH =');
const endD = src.indexOf('\n}\n', src.indexOf('function decodeToken')) + 3;
if (start < 0 || endD < 3) throw new Error('could not locate the auth block');
const block = src.slice(start, endD);
if (/\brequire\(/.test(block)) throw new Error('FAIL: require() in an ESM module - this breaks every route');

const mk = (demo) => {
  const body = block
    .replace("String(process.env.DEMO_AUTH || '').toLowerCase() === 'true'", String(demo))
    .replace("process.env.DEMO_AUTH_SECRET || crypto.randomBytes(32).toString('hex')", "'fixed-test-secret'");
  return new Function('crypto', 'Buffer', 'clerkVerificationEnabled', 'verifyClerkJWT',
    body + '\nreturn {mockJWT,verifyMockToken,decodeToken};')(crypto, Buffer, false, () => null);
};
const ON = mk(true), OFF = mk(false);
let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };
const bare = o => Buffer.from(JSON.stringify(o)).toString('base64');

console.log('DEMO_AUTH unset (production):');
t('hand-made base64 token rejected', OFF.decodeToken(bare({ identityId: 'x', role: 'Regulator', exp: Date.now() + 9e6 })) === null);
t('even a correctly signed demo token rejected', OFF.decodeToken(ON.mockJWT('x', 'M', 'Regulator')) === null);
t('garbage rejected', OFF.decodeToken('!!!') === null);

console.log('\nDEMO_AUTH=true (local development):');
const good = ON.mockJWT('investor1', 'Org1MSP', 'Investor');
t('legitimately issued token verifies', ON.verifyMockToken(good)?.identityId === 'investor1');
t('junk signature rejected', ON.verifyMockToken(good.split('.')[0] + '.deadbeef') === null);
const esc = bare({ identityId: 'investor1', mspId: 'Org1MSP', role: 'Regulator', exp: Date.now() + 9e6 });
t('role escalated to Regulator, signature reused, rejected', ON.verifyMockToken(esc + '.' + good.split('.')[1]) === null);
const expd = bare({ identityId: 'x', role: 'Investor', exp: Date.now() - 1000 });
t('expired rejected', ON.verifyMockToken(expd + '.' + crypto.createHmac('sha256', 'fixed-test-secret').update(expd).digest('base64url')) === null);
const wrong = bare({ identityId: 'x', role: 'Regulator', exp: Date.now() + 9e6 });
t('signed with the wrong secret rejected', ON.verifyMockToken(wrong + '.' + crypto.createHmac('sha256', 'attacker').update(wrong).digest('base64url')) === null);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
