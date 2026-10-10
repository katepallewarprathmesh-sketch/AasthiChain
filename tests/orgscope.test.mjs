// Organisation membership has to mean something.
//
// Nothing checked it. Any signed-in user could list every organisation on
// the deployment, read any org's member list and pending invitations, and —
// the serious one — issue themselves an 'admin' invitation into an
// organisation they had nothing to do with and then accept it. Two calls, no
// membership, no token, no email round-trip:
//
//   POST /api/orgs/<victim>/invitations {email, role:'admin'}  -> 201
//   POST /api/invitations/accept {invitationId}                -> 200 admin
//
// Accepting is checked against who the invitation was addressed to, not
// against who happens to know its id.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role = 'Investor', mspId = 'InvestorMSP') =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const OWNER = tokenFor('investor1');
const OUTSIDER = tokenFor('investor2');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, token, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

console.log(`organisation membership (${API})`);

const tag = randomBytes(4).toString('hex');
const created = await call('/api/orgs', OWNER, {
  method: 'POST', body: JSON.stringify({ name: `Scope Fund ${tag}`, slug: `scope-fund-${tag}` }),
});
const org = created.body && (created.body.id || (created.body.organization && created.body.organization.id));
t('investor1 can create an organisation', created.status === 201 && !!org, `got ${created.status}`);
if (!org) { console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); }

// --- an outsider sees nothing
const outsiderList = await call('/api/orgs', OUTSIDER);
const visible = ((outsiderList.body && outsiderList.body.organizations) || []).map((o) => o.id);
t('an outsider does not see it in the org list', !visible.includes(org), visible.join(','));

const outsiderMembers = await call(`/api/orgs/${org}/members`, OUTSIDER);
t('an outsider cannot read the member list', outsiderMembers.status === 403, `got ${outsiderMembers.status}`);

const outsiderInvites = await call(`/api/orgs/${org}/invitations`, OUTSIDER);
t('an outsider cannot read pending invitations', outsiderInvites.status === 403, `got ${outsiderInvites.status}`);

// --- the escalation this suite exists for
const selfInvite = await call(`/api/orgs/${org}/invitations`, OUTSIDER, {
  method: 'POST', body: JSON.stringify({ email: 'investor2@aasthichain', role: 'admin' }),
});
t('an outsider cannot invite themselves in', selfInvite.status === 403, `got ${selfInvite.status}`);
t('  and is told why', selfInvite.body && selfInvite.body.error === 'ERR_NOT_ORG_ADMIN', JSON.stringify(selfInvite.body));

const membersAfter = await call(`/api/orgs/${org}/members`, OWNER);
const userIds = ((membersAfter.body && membersAfter.body.members) || []).map((m) => m.user_id);
t('the org still has only its owner', userIds.length === 1 && userIds[0] === 'investor1', userIds.join(','));

// --- the legitimate path still works end to end
const invited = await call(`/api/orgs/${org}/invitations`, OWNER, {
  method: 'POST', body: JSON.stringify({ email: 'investor2@aasthichain', role: 'member' }),
});
t('the owner can invite someone', invited.status === 201 && !!invited.body.id, `got ${invited.status}`);

// An invitation addressed to investor2 must not be claimable by anyone else.
const wrongPerson = await call('/api/invitations/accept', tokenFor('originator1', 'Originator', 'OriginatorMSP'), {
  method: 'POST', body: JSON.stringify({ invitationId: invited.body.id }),
});
t('a third party cannot claim that invitation', wrongPerson.status === 403, `got ${wrongPerson.status}`);
t('  refused as not-invited rather than bad-request',
  wrongPerson.body && wrongPerson.body.error === 'ERR_NOT_INVITED', JSON.stringify(wrongPerson.body));

const accepted = await call('/api/invitations/accept', OUTSIDER, {
  method: 'POST', body: JSON.stringify({ invitationId: invited.body.id }),
});
t('the invited person can accept', accepted.status === 200, `got ${accepted.status}`);
t('  and joins with the role they were offered',
  accepted.body && accepted.body.member && accepted.body.member.role === 'member',
  JSON.stringify(accepted.body && accepted.body.member));

// Now a member, they can read the org — and it appears in their list.
const nowMember = await call(`/api/orgs/${org}/members`, OUTSIDER);
t('a member can read the member list', nowMember.status === 200, `got ${nowMember.status}`);
const nowVisible = ((await call('/api/orgs', OUTSIDER)).body.organizations || []).map((o) => o.id);
t('and now sees the org in their list', nowVisible.includes(org));

// A plain member is not an admin: they must not be able to invite.
const memberInvites = await call(`/api/orgs/${org}/invitations`, OUTSIDER, {
  method: 'POST', body: JSON.stringify({ email: 'mallory@evil.test', role: 'admin' }),
});
t('a plain member still cannot invite', memberInvites.status === 403, `got ${memberInvites.status}`);

// Supervision is unaffected.
const supervisor = await call(`/api/orgs/${org}/members`, REGULATOR);
t('a regulator can still read any org', supervisor.status === 200, `got ${supervisor.status}`);

// An unknown org is a 404, not a 403 that confirms nothing exists.
const ghost = await call('/api/orgs/org_does_not_exist/members', OUTSIDER);
t('an unknown org is 404', ghost.status === 404, `got ${ghost.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
