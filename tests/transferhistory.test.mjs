// Pages through /api/transfers/history the way the component does and checks
// the invariants that matter: no duplicates across pages, nothing skipped,
// strict newest-first ordering, and every row actually involving the user.
const BASE='http://localhost:8080', ME='investor1';
const tok = Buffer.from(JSON.stringify({identityId:ME,mspId:'InvestorMSP',role:'Investor',exp:Date.now()+9e6})).toString('base64');
const get = async (u) => {
  const r = await fetch(BASE+u, { headers: { authorization: 'Bearer '+tok } });
  if (!r.ok) throw new Error(u+' -> '+r.status);
  return r.json();
};
let p=0,f=0; const t=(n,c)=>{ if(c){p++;console.log('  ok   '+n);} else {f++;console.log('  FAIL '+n);} };

const first = await get(`/api/transfers/history?ownerId=${ME}&pageSize=8`);
t('endpoint returns rows', Array.isArray(first.transfers) && first.transfers.length > 0);
t('page respects pageSize', first.transfers.length <= 8);
t('reports a total', Number(first.total) >= first.transfers.length);

// walk every page
const seen = [], ids = new Set();
let mark = '', guard = 0, page = first;
while (true) {
  for (const r of page.transfers) { seen.push(r); ids.add(r.transferId); }
  if (!page.hasMore || ++guard > 20) break;
  mark = page.bookmark;
  page = await get(`/api/transfers/history?ownerId=${ME}&pageSize=8&bookmark=${encodeURIComponent(mark)}`);
}
t('paging terminates', guard <= 20);
t('no duplicate rows across pages', ids.size === seen.length);
t('paged through every row', seen.length === Number(first.total));
t('every row involves the user', seen.every(r => r.fromId === ME || r.toId === ME));
t('strict newest-first', seen.every((r,i) => i === 0 || new Date(seen[i-1].txTimestamp) >= new Date(r.txTimestamp)));
t('rows carry a ledger reference', seen.every(r => typeof r.transferId === 'string' && r.transferId.length > 0));
t('direction is derivable', seen.every(r => (r.toId === ME) !== (r.fromId === ME) || r.toId === r.fromId));

// privacy: the endpoint must not serve someone else's history unauthenticated
const anon = await fetch(`${BASE}/api/transfers/history?ownerId=${ME}`);
t('requires authentication', anon.status === 401 || anon.status === 403);

console.log(`\n${p}/${p+f} passed  (${seen.length} transactions paged)`);
process.exit(f?1:0);
