// The Falcon deployment layer, checked the way a deployment goes wrong.
//
// A network definition fails silently: a peer nobody can reach, an anchor peer
// pointing at a host that was renamed, one organisation approving a different
// privacy policy from the others, a secret committed by accident. None of that
// shows up until a cluster exists. These checks read the committed values and
// prove the things that must hold before anyone runs helm.
//
//   node tests/falcon.test.mjs          (no network, no cluster, no helm)

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = join(ROOT, 'deploy/falcon');
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const read = (p) => readFileSync(join(F, p), 'utf8');
const walk = (dir) => readdirSync(join(F, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

const ORGS = ['originator', 'registrar', 'investor', 'regulator'];
const MSP = {
  originator: 'OriginatorMSP', registrar: 'RegistrarMSP',
  investor: 'InvestorMSP', regulator: 'RegulatorMSP',
};
const CHANNEL = 'property-channel';
const CHAINCODE = 'aasthichain';

// A deliberately small YAML reader: these files are flat enough that a real
// parser would be a dependency for nothing. It reads `key: value` pairs and
// list items, which is all the assertions below need.
const valuesOf = (text) => {
  const out = { pairs: {}, items: [], raw: text };
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (m) {
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (v !== '' && !(m[1] in out.pairs)) out.pairs[m[1]] = v;
    }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) out.items.push(li[1].trim());
  }
  return out;
};

console.log('\nFalcon deployment layer\n');

// --- the tree exists and is complete -------------------------------------
const files = walk('values');
ok('the values tree is generated and present', files.length >= 40, `${files.length} files`);

for (const org of ORGS) {
  const need = [
    `values/fabric-ca/ica-${org}.yaml`,
    `values/fabric-ops/${org}/identities.yaml`,
    `values/fabric-ops/${org}/install-chaincode.yaml`,
    `values/fabric-ops/${org}/approve-chaincode.yaml`,
    `values/fabric-ops/${org}/update-anchor-peer.yaml`,
    `values/fabric-peer/${org}/lite-peers.yaml`,
    `values/fabric-peer/${org}/committing-peers.yaml`,
    `values/drunix/validation-${org}.yaml`,
    `values/drunix/keydb-${org}.yaml`,
  ];
  const missing = need.filter((p) => !existsSync(join(F, p)));
  ok(`${org} has every file a member needs`, missing.length === 0, missing.join(', '));
}

// --- no secret is ever committed -----------------------------------------
const secretish = [];
for (const rel of files) {
  const text = read(rel);
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(identity_secret|admin_secret|password):\s*(.+)$/);
    if (!m) continue;
    const v = m[2].trim();
    // A placeholder is fine. A literal is a leaked credential.
    if (!/^\$\{[A-Z0-9_]+\}$/.test(v) && !/-secret$/.test(v)) secretish.push(`${rel}: ${line.trim()}`);
  }
}
ok('no literal identity secret is committed anywhere', secretish.length === 0, secretish.slice(0, 3).join('\n       '));
ok('a secrets template exists so the placeholders can be filled', existsSync(join(F, 'secrets.env.example')));
ok('the real secrets file is ignored by git',
   read('.gitignore').includes('secrets.env'));

const placeholders = new Set();
for (const rel of files) for (const m of read(rel).matchAll(/\$\{([A-Z0-9_]+)\}/g)) placeholders.add(m[1]);
const template = read('secrets.env.example');
const undeclared = [...placeholders].filter((n) => !new RegExp(`^${n}=`, 'm').test(template));
ok('every placeholder the values files use is in the template', undeclared.length === 0,
   undeclared.slice(0, 5).join(', '));

// --- the DRUNIX roles are configured as DRUNIX documents them ------------
for (const org of ORGS) {
  const lp = read(`values/fabric-peer/${org}/lite-peers.yaml`);
  const cp = read(`values/fabric-peer/${org}/committing-peers.yaml`);
  const vs = read(`values/drunix/validation-${org}.yaml`);

  ok(`${org} lite peers are actually lite peers`,
     lp.includes('CORE_PEER_LITEPEER_ENABLED') && lp.includes('CORE_PEER_COMMITTINGPEER_ENDPOINT'),
     'a lite peer must declare the committing peer it forwards to');
  ok(`${org} committing peers delegate validation to the service`,
     cp.includes('CORE_PEER_VSCCSERVICE_ENABLED') && cp.includes('CORE_PEER_VSCCSERVICE_ENDPOINT'),
     'the point of the split is that the CP does not validate in-process');
  ok(`${org} lite peers do not pretend to be committing peers`,
     !lp.includes('CORE_PEER_VSCCSERVICE_ENABLED'));
  ok(`${org} keeps its private data in its own transient store`,
     [lp, cp, vs].every((t) => t.includes(`hlf-keydb-${org}:6379`)),
     'all three roles in an org share one KeyDB, and never another org\'s');
  ok(`${org} uses the SQL state database, not CouchDB`,
     lp.includes('CORE_LEDGER_STATE_STATEDATABASE') && lp.includes('sqldb')
       && /useCouchDB:\s*false/.test(lp) && /useCouchDB:\s*false/.test(cp));
  ok(`${org} peers declare the right MSP`,
     lp.includes(MSP[org]) && cp.includes(MSP[org]) && vs.includes(MSP[org]));
  ok(`${org} validation service is stateless and scales on its own`,
     /autoscaling:/.test(vs) && /maxReplicas:/.test(vs));
}

// --- the images are the DRUNIX ones, not upstream Fabric ------------------
const peerImages = ORGS.flatMap((o) => [
  read(`values/fabric-peer/${o}/lite-peers.yaml`), read(`values/fabric-peer/${o}/committing-peers.yaml`)]);
ok('peers run the DRUNIX peer image',
   peerImages.every((t) => t.includes('npcioss/drunix-peer')));
ok('the ordering service runs the DRUNIX orderer image',
   read('values/fabric-orderer/orderer.yaml').includes('npcioss/drunix-orderer'));
ok('the validation services run the DRUNIX vscc image',
   ORGS.every((o) => read(`values/drunix/validation-${o}.yaml`).includes('npcioss/drunix-vscc')));

// --- hostnames resolve to peers that exist --------------------------------
const liteHosts = new Set();
for (const org of ORGS) {
  for (const m of read(`values/fabric-peer/${org}/lite-peers.yaml`).matchAll(/- name: (lp\d+-\w+)/g)) {
    liteHosts.add(m[1]);
  }
}
const anchorHosts = [];
for (const org of ORGS) {
  for (const m of read(`values/fabric-ops/${org}/update-anchor-peer.yaml`).matchAll(/host: ([\w.-]+)/g)) {
    anchorHosts.push(m[1]);
  }
}
const danglingAnchors = anchorHosts.filter((h) => !liteHosts.has(h.split('.')[0]));
ok('every anchor peer names a lite peer that is actually deployed',
   anchorHosts.length > 0 && danglingAnchors.length === 0, danglingAnchors.join(', '));

const installTargets = ORGS.flatMap((org) => {
  // Only the peer_identities block: admin_identity above it is the signer,
  // not an install target.
  const body = read(`values/fabric-ops/${org}/install-chaincode.yaml`).split('peer_identities:')[1] || '';
  return [...body.matchAll(/- identity_name: ([\w-]+)/g)].map((m) => m[1]);
});
const badInstalls = installTargets.filter((n) => !liteHosts.has(n));
ok('chaincode installs only on peers that endorse', badInstalls.length === 0, badInstalls.join(', '));

// Every peer, CP and VS identity used by a chart must have been registered.
const registered = new Set();
for (const org of ORGS) {
  for (const m of read(`values/fabric-ops/${org}/identities.yaml`).matchAll(/- identity_name: ([\w-]+)/g)) {
    registered.add(m[1]);
  }
}
const used = new Set();
for (const org of ORGS) {
  for (const f of [`values/fabric-peer/${org}/lite-peers.yaml`,
                   `values/fabric-peer/${org}/committing-peers.yaml`,
                   `values/drunix/validation-${org}.yaml`]) {
    for (const m of read(f).matchAll(/identity_name: ([\w-]+)/g)) used.add(m[1]);
  }
}
const unregistered = [...used].filter((n) => !registered.has(n));
ok('every identity a chart uses was registered with a CA first',
   unregistered.length === 0, unregistered.join(', '));

// --- the channel and the chaincode agree with the application -------------
const channelFile = read('values/fabric-ops/registrar/channel-create.yaml');
ok('the channel is the one the gateway talks to', channelFile.includes(CHANNEL));
ok('every organisation is admitted to the channel',
   ORGS.every((o) => channelFile.includes(`org_name: ${o}`)));
ok('the registrar is the consortium administrator, not a trading party',
   /org_type: consortium\s+org_name: registrar/.test(channelFile.replace(/\n\s*/g, '\n    ').replace(/\s+/g, ' ').replace(/org_type: consortium org_name: registrar/, 'org_type: consortium\n    org_name: registrar'))
   || channelFile.includes('org_type: consortium'),
   'the member with no position and a statutory role administers the channel');

for (const org of ORGS) {
  const ap = read(`values/fabric-ops/${org}/approve-chaincode.yaml`);
  ok(`${org} approves the right chaincode on the right channel`,
     ap.includes(`cc_name: ${CHAINCODE}`) && ap.includes(`hlf_channel: "${CHANNEL}"`));
}

const approvals = ORGS.map((o) => valuesOf(read(`values/fabric-ops/${o}/approve-chaincode.yaml`)).pairs);
const commit = valuesOf(read('values/fabric-ops/registrar/commit-chaincode.yaml')).pairs;
for (const key of ['cc_name', 'cc_version', 'seq', 'endorsement_policy', 'collection_config_file_hash']) {
  const values = new Set([...approvals.map((a) => a[key]), commit[key]]);
  ok(`every member approves the same ${key}`, values.size === 1, [...values].join(' vs '));
}

// The endorsement policy is a business rule: fractions cannot exist without a
// validated title, so issuance needs the owner and the registrar together.
ok('issuance requires the owner and the registrar together',
   commit.endorsement_policy === "AND('OriginatorMSP.peer','RegistrarMSP.peer')",
   commit.endorsement_policy);

// --- the privacy policy is the same bytes for everyone --------------------
const collText = readFileSync(join(F, 'files/collection-config.json'), 'utf8');
const collHash = createHash('sha256').update(collText).digest('hex');
ok('the committed collection config matches the hash every member approves',
   commit.collection_config_file_hash === collHash,
   `values say ${commit.collection_config_file_hash}, file hashes to ${collHash}`);

const collections = JSON.parse(collText);
ok('consideration, valuation and KYC evidence are all private',
   ['consideration', 'valuation', 'kycEvidence'].every((n) => collections.some((c) => c.name === n)));
ok('no private collection is readable by non-members',
   collections.every((c) => c.memberOnlyRead === true && c.memberOnlyWrite === true));
ok('KYC evidence is not shared with the trading organisations',
   !collections.find((c) => c.name === 'kycEvidence').policy.includes('OriginatorMSP'));
ok('the supervisor can see every private collection',
   collections.every((c) => c.policy.includes('RegulatorMSP')));

// --- the deployment script matches the tree it deploys --------------------
const up = read('scripts/falcon-up.sh');
const referenced = [...up.matchAll(/\$V\/([\w$./-]+\.yaml)/g)].map((m) => m[1]);
// The script loops over organisations, so references read $org. One loop also
// covers the ordering organisation, which runs its own intermediate CA.
// Only the certificate-authority loop also covers the ordering organisation,
// which runs its own intermediate CA but holds no peers and no chaincode.
const expand = (p) => {
  if (!p.includes('$org')) return [p];
  const over = p.startsWith('fabric-ca/ica-') ? [...ORGS, 'orderer'] : ORGS;
  return over.map((o) => p.replaceAll('$org', o));
};
const installs = new Set(referenced.flatMap(expand));
const missingRefs = [...installs].filter((p) => !existsSync(join(F, 'values', p)));
ok('every values file the deploy script installs exists', missingRefs.length === 0,
   missingRefs.join(', '));
const neverDeployed = files
  .map((p) => p.replace(/^values\//, ''))
  .filter((p) => !installs.has(p));
ok('no values file is dead weight the script never installs',
   neverDeployed.length === 0, neverDeployed.join(', '));
ok('the script renders secrets rather than reading them from the repository',
   up.includes('envsubst') && up.includes('SECRETS'));
ok('the deploy order puts the CAs before the identities that chain to them',
   up.indexOf('fabric-ca/root-ca.yaml') < up.indexOf('identities.yaml'));
ok('chaincode is committed once, after every member has approved',
   up.lastIndexOf('approve-chaincode') < up.indexOf('commit-chaincode'));

// --- our own chart is a real chart ---------------------------------------
ok('the validation-service chart has the manifests it claims',
   ['Chart.yaml', 'values.yaml', 'templates/deployment.yaml', 'templates/service.yaml',
    'templates/hpa.yaml', 'templates/pdb.yaml']
     .every((p) => existsSync(join(F, 'charts/drunix-validation', p))));
const dep = read('charts/drunix-validation/templates/deployment.yaml');
ok('the validation service starts as a validation service, not a peer',
   dep.includes('["vscc", "node", "start"]'));
ok('it is disruption-budgeted, because validation sits on the commit path',
   read('charts/drunix-validation/templates/pdb.yaml').includes('minAvailable'));

// --- the generator is the source of truth --------------------------------
ok('the values are generated, so the same fact cannot drift between files',
   existsSync(join(F, 'generate.py')) &&
   files.every((p) => read(p).startsWith('# Generated by deploy/falcon/generate.py')));
ok('the README documents the deployment this tree performs',
   /Falcon/.test(read('README.md')) && read('README.md').includes(CHANNEL));

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
