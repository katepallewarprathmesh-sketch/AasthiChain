// An invitation is addressed to a person, not to a local part.
//
// The accept path matched only the bit of the email before the @, so an
// invitation sent to cfo@some-other-company.example was accepted by whoever
// was identified as "cfo" on this deployment. An invitation carries a role,
// so that was a way to be handed membership — sometimes admin — of an
// organisation nobody had invited you to. Worse in production, where every
// signed-in person is currently filed as investor1: any invitation to
// investor1@anything was claimable by any stranger with an account.
//
// The rule being pinned here: an invitation pinned to an identity matches
// that identity; otherwise the signed-in email must match in full. The old
// loose match survives only in demo deployments, where identities are
// literally named investor1 and carry no email at all.
import { invitationIsFor } from '../frontend/api/lib/authstore.js';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const demoToken = (identityId, role = 'Investor') =>
  Buffer.from(JSON.stringify({ identityId, mspId: 'M', role, exp: Date.now() + 3600000 })).toString('base64');

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: parsed || {}, raw: JSON.stringify(parsed || {}) };
}

console.log(`Invitation scope (${API})`);

// ---------- the rule itself, with no server in the way ----------
const inv = { email: 'cfo@a-company-i-never-joined.example', role: 'admin' };

t('a stranger sharing the local part is refused in production',
  invitationIsFor(inv, 'cfo', { email: 'cfo@my-own-domain.example' }) === false);

t('the invited person, matched on the full address, is admitted',
  invitationIsFor(inv, 'cfo', { email: 'CFO@A-Company-I-Never-Joined.Example' }) === true);

t('with no verified email there is no match in production',
  invitationIsFor(inv, 'cfo', {}) === false);

t('demo deployments keep the local-part match',
  invitationIsFor(inv, 'cfo', { allowLocalPart: true }) === true);

t('an invitation pinned to an identity matches only that identity',
  invitationIsFor({ ...inv, identity_id: 'investor2' }, 'investor2') === true &&
  invitationIsFor({ ...inv, identity_id: 'investor2' }, 'investor1', { allowLocalPart: true }) === false);

t('an invitation with no address matches nobody',
  invitationIsFor({ email: '', role: 'admin' }, 'investor1', { allowLocalPart: true }) === false);

// ---------- and over the wire ----------
const owner = demoToken('registrar1', 'Registrar');
const org = await call('/api/orgs', {
  method: 'POST', token: owner,
  body: { name: 'Invitation Scope Co', slug: `inv-scope-${Date.now()}` },
});
const orgId = org.body.id || (org.body.organization && org.body.organization.id);

if (!orgId) {
  t('an organisation could be created to test against', false, `${org.status} ${org.raw.slice(0, 160)}`);
} else {
  const made = await call(`/api/orgs/${encodeURIComponent(orgId)}/invitations`, {
    method: 'POST', token: owner,
    body: { email: 'investor2@an-unrelated-firm.example', role: 'admin' },
  });
  t('an owner can invite someone', made.status === 201 || made.status === 200, `got ${made.status}`);
  const invitationId = made.body.id;

  const wrongPerson = await call('/api/invitations/accept', {
    method: 'POST', token: demoToken('investor1'),
    body: { invitationId },
  });
  t('someone else holding the invitation id cannot accept it',
    wrongPerson.status === 403 && /ERR_NOT_INVITED/.test(wrongPerson.raw),
    `got ${wrongPerson.status} ${wrongPerson.raw.slice(0, 140)}`);

  const accepted = await call('/api/invitations/accept', {
    method: 'POST', token: demoToken('investor2'),
    body: { invitationId },
  });
  t('the invited person can accept', accepted.status === 200, `got ${accepted.status} ${accepted.raw.slice(0, 140)}`);
  t('  and is admitted at the invited role',
    (accepted.body.member || {}).role === 'admin', accepted.raw.slice(0, 140));

  const twice = await call('/api/invitations/accept', {
    method: 'POST', token: demoToken('investor2'),
    body: { invitationId },
  });
  t('an invitation cannot be accepted twice', twice.status >= 400, `got ${twice.status}`);

  const unknown = await call('/api/invitations/accept', {
    method: 'POST', token: demoToken('investor2'),
    body: { invitationId: 'inv_does-not-exist' },
  });
  t('an invented invitation id is refused', unknown.status >= 400, `got ${unknown.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
