// Diagnostic: compare what the two servers actually RETURN, not just whether
// they answer.
//
// tests/apiparity.test.mjs proves every Express route is reachable on the
// serverless handler. That is not enough — /api/umi/metrics was reachable on
// both and still answered wrongly on one, and /api/npci/reconcile answered
// with an entirely different vocabulary on each. This walks every GET route,
// calls both servers, and reports differing content types or top-level keys.
//
// Deliberately NOT a CI test: several differences are legitimately data
// dependent (one server has payments the other does not), so it needs a human
// to read it. Run it after touching either server:
//
//   bash scripts/devup.sh && <start rail + app>  then
//   node scripts/api-shape-audit.mjs
//
// Expect a short tail of unconsumed metadata keys (fabricMode, indexUsed and
// friends). What matters is a key the frontend actually reads.

// Reachability was not enough: /api/umi/metrics existed on both servers and
// still answered wrongly on one. Compare what each actually returns.
import fs from 'fs';
// Express guards most routes with authMiddleware; without a bearer it answers
// {error:...} and every route looks like a mismatch. Mint the demo token the
// app itself issues.
const TOKEN = Buffer.from(JSON.stringify({
  identityId:'registrar1', mspId:'RegistrarMSP', role:'Registrar', exp: Date.now()+3600000,
})).toString('base64');
const AUTH = { 'X-Fabric-Identity':'registrar1', Authorization: 'Bearer ' + TOKEN };
process.env.UMI_GATEWAY_URL = 'http://localhost:21100';
const { default: serverless } = await import('/home/user/repo/frontend/api/index.js');

const src = fs.readFileSync('/home/user/repo/mock-api-server.js', 'utf8');
const SAMPLE = {
  ':id':'PROP-GREEN-VALLEY-PUNE-001', ':assetId':'PROP-GREEN-VALLEY-PUNE-001',
  ':ownerId':'investor1', ':identityId':'investor1', ':participant':'investor1',
  ':paymentId':'PAY-1', ':offerId':'OFR-1', ':cid':'bafk', ':loanId':'L-1',
  ':proposalId':'P-1', ':height':'1', ':basketId':'B-1', ':isin':'INE000A01001', ':utr':'UTR1',
};
const fill = p => p.split('/').map(s => s.startsWith(':') ? (SAMPLE[s]||'x') : s).join('/');
// Streaming endpoints never finish by design; probing them hangs the audit.
const STREAMING = new Set(['/api/umi/events', '/api/ledger/stream']);
const routes = [...new Set([...src.matchAll(/app\.get\(\s*'([^']+)'/g)].map(m=>m[1]))]
  .filter(r => !STREAMING.has(r));

function cap(){const r={_s:200,_b:null,_h:{}};r.status=c=>{r._s=c;return r};
 r.json=b=>{r._b=b;return r};r.send=b=>{r._b=b;return r};
 r.setHeader=(k,v)=>{r._h[k.toLowerCase()]=v;return r};r.writeHead=()=>r;r.end=()=>r;return r}

const keys = v => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort() : (Array.isArray(v)?['<array>']:[typeof v]);
const diffs = [];

for (const route of routes) {
  const url = fill(route);
  let exp;
  try {
    const r = await fetch('http://localhost:8080' + url, {
      headers:AUTH, signal: AbortSignal.timeout(8000) });
    const txt = await r.text();
    let body; try { body = JSON.parse(txt) } catch { body = txt }
    exp = { s:r.status, ct:(r.headers.get('content-type')||'').split(';')[0], body };
  } catch(e) { continue }

  const res = cap();
  try {
    await Promise.race([
      serverless({ url, method:'GET', headers:{...AUTH, 'x-fabric-identity':'registrar1'} }, res),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('timed out after 8s')), 8000)),
    ]);
  }
  catch(e) { diffs.push([route,'serverless threw', e.message]); continue }
  const sct = (res._h['content-type']||'application/json').split(';')[0];
  const sbody = typeof res._b === 'string' ? (()=>{try{return JSON.parse(res._b)}catch{return res._b}})() : res._b;

  if (exp.ct !== sct) { diffs.push([route,'content-type', `express=${exp.ct} serverless=${sct}`]); continue }
  const a = keys(exp.body), b = keys(sbody);
  const onlyExpress = a.filter(k=>!b.includes(k));
  const onlyServerless = b.filter(k=>!a.includes(k));
  if (onlyExpress.length || onlyServerless.length) {
    diffs.push([route,'keys', `missing=[${onlyExpress}] extra=[${onlyServerless}]`]);
  }
}
console.log(`\nchecked ${routes.length} GET routes; ${diffs.length} differ\n`);
for (const [r,k,d] of diffs) console.log(`  ${r}\n      ${k}: ${d}`);
