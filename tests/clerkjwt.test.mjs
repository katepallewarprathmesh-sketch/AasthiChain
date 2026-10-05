// Verifies frontend/api/lib/clerkjwt.mjs against a real RSA keypair served
// from a local JWKS endpoint, including the standard JWT forgery attacks.
import crypto from 'crypto';
import http from 'http';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: otherPub, privateKey: otherPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'ins_test_kid_1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

let served = { keys: [jwk] };
let hits = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/.well-known/jwks.json') {
    hits++; res.setHeader('content-type','application/json'); res.end(JSON.stringify(served));
  } else { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ISSUER = `http://127.0.0.1:${server.address().port}`;
process.env.CLERK_ISSUER = ISSUER;

const { ensureClerkKeys, verifyClerkJWT, clerkVerificationEnabled } = await import('../frontend/api/lib/clerkjwt.mjs');

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now()/1000);
function sign(header, payload, key = privateKey) {
  const body = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url');
  return `${body}.${sig}`;
}
const claims = (o={}) => ({ sub:'user_2abc', iss:ISSUER, exp:now()+3600, nbf:now()-10, ...o });
const H = { alg:'RS256', typ:'JWT', kid:KID };

let pass=0, fail=0;
const t=(n,c)=>{ if(c){pass++;console.log('  ok   '+n);} else {fail++;console.log('  FAIL '+n);} };

t('verification enabled by CLERK_ISSUER', clerkVerificationEnabled === true);
t('nothing verifies before keys are primed', verifyClerkJWT(sign(H, claims())) === null);
await ensureClerkKeys();
t('JWKS was fetched', hits === 1);

console.log('\nlegitimate tokens:');
t('valid token verifies', verifyClerkJWT(sign(H, claims()))?.sub === 'user_2abc');
t('claims are returned', verifyClerkJWT(sign(H, claims({ fabricIdentity:'investor2' })))?.fabricIdentity === 'investor2');
t('30s clock skew tolerated', verifyClerkJWT(sign(H, claims({ exp: now()-30 })))?.sub === 'user_2abc');

console.log('\nforgery:');
t('the exact current hole - unsigned, hand-made JWT - rejected',
  verifyClerkJWT(`${b64(H)}.${b64(claims({sub:'user_attacker'}))}.`) === null);
t('alg:none rejected', verifyClerkJWT(`${b64({alg:'none',kid:KID})}.${b64(claims())}.`) === null);
const pubPem = publicKey.export({type:'spki',format:'pem'});
const hsHead = b64({alg:'HS256',typ:'JWT',kid:KID}), hsBody = b64(claims({sub:'user_attacker'}));
t('HS256 confusion (public key as HMAC secret) rejected',
  verifyClerkJWT(`${hsHead}.${hsBody}.${crypto.createHmac('sha256',pubPem).update(`${hsHead}.${hsBody}`).digest('base64url')}`) === null);
t('signed by a different key rejected', verifyClerkJWT(sign(H, claims(), otherPriv)) === null);
const good = sign(H, claims());
const [h,,s] = good.split('.');
t('payload swapped, signature reused rejected', verifyClerkJWT(`${h}.${b64(claims({sub:'user_attacker'}))}.${s}`) === null);
t('unknown kid rejected', verifyClerkJWT(sign({...H,kid:'kid_not_in_jwks'}, claims())) === null);
t('garbage rejected', verifyClerkJWT('not.a.jwt') === null);
t('empty rejected', verifyClerkJWT('') === null);
t('non-string rejected', verifyClerkJWT(null) === null);

console.log('\nclaims:');
t('expired beyond skew rejected', verifyClerkJWT(sign(H, claims({ exp: now()-3600 }))) === null);
t('not-yet-valid rejected', verifyClerkJWT(sign(H, claims({ nbf: now()+600 }))) === null);
t('wrong issuer rejected', verifyClerkJWT(sign(H, claims({ iss:'https://evil.example.com' }))) === null);
t('missing sub rejected', verifyClerkJWT(sign(H, { iss:ISSUER, exp:now()+3600 })) === null);

console.log('\nresilience:');
served = 'BOOM';                       // Clerk returns garbage
await ensureClerkKeys({ force: true });
t('bad JWKS response does not evict a working cache', verifyClerkJWT(sign(H, claims()))?.sub === 'user_2abc');
server.close();                        // Clerk unreachable
await ensureClerkKeys({ force: true });
t('unreachable Clerk does not lock users out', verifyClerkJWT(sign(H, claims()))?.sub === 'user_2abc');

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
