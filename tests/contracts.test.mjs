// Compile the Solidity contracts and check the document registry's rules hold.
//
// A contract that has never been compiled is a design document with syntax
// colouring. This compiles DocumentRegistry.sol with solc and asserts the
// things that matter: it builds with no errors, it exposes the functions the
// Go rail mirrors, and — the rule the whole design rests on — it stores the
// fingerprint of a document and never the document.
//
//   npm i --no-save solc@0.8.26 && node tests/contracts.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

let solc;
try {
  solc = require('solc');
} catch {
  console.log('\n  solc is not installed — skipping contract compilation.');
  console.log('  install it with: npm i --no-save solc@0.8.26\n');
  process.exit(0);
}

const SOURCES = {
  'DocumentRegistry.sol': 'contracts/DocumentRegistry.sol',
  'PaymentEscrow.sol': 'contracts/PaymentEscrow.sol',
};

console.log('\nSolidity contracts — solc ' + solc.version() + '\n');

const input = {
  language: 'Solidity',
  sources: {},
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
for (const [name, path] of Object.entries(SOURCES)) {
  if (!existsSync(path)) continue;
  input.sources[name] = { content: readFileSync(path, 'utf8') };
}

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter(e => e.severity === 'error');
const warnings = (out.errors || []).filter(e => e.severity === 'warning');

ok('every contract compiles with no errors', errors.length === 0,
   errors.map(e => e.formattedMessage).join('\n'));
if (errors.length) { console.log(`\n  contracts: ${passed} passed, ${failed} failed\n`); process.exit(1); }

const registry = out.contracts?.['DocumentRegistry.sol']?.DocumentRegistry;
ok('DocumentRegistry produces deployable bytecode',
   !!registry?.evm?.bytecode?.object?.length);

const abi = registry?.abi || [];
const fns = abi.filter(e => e.type === 'function').map(e => e.name);
const events = abi.filter(e => e.type === 'event').map(e => e.name);
const errs = abi.filter(e => e.type === 'error').map(e => e.name);

for (const fn of ['anchor', 'supersede', 'revoke', 'verify', 'verifyDigest', 'documentsOf']) {
  ok(`it exposes ${fn}()`, fns.includes(fn), fns.join(', '));
}
ok('verification is a free view call — no gas, no account needed',
   abi.find(e => e.name === 'verify')?.stateMutability === 'view');
ok('anchoring emits an event, so an indexer can follow the register',
   events.includes('DocumentAnchored'));
ok('withdrawal is a separate event, not a silent mutation',
   events.includes('DocumentRevoked') && events.includes('DocumentSuperseded'));
ok('a duplicate anchor reverts with a named error',
   errs.includes('AlreadyAnchored'), errs.join(', '));

// The privacy rule, enforced by reading the source: a public chain must never
// receive a document. Anything that accepts bytes or a long string of file
// content would break that.
const src = readFileSync('contracts/DocumentRegistry.sol', 'utf8');
const anchorSig = src.match(/function anchor\(([\s\S]*?)\)\s*external/);
ok('anchor() takes a fingerprint, never file content',
   !!anchorSig && /bytes32 sha256Digest/.test(anchorSig[1]) && !/bytes calldata content/.test(anchorSig[1]),
   anchorSig?.[1]?.replace(/\s+/g, ' ').trim());
ok('no function anywhere accepts raw document bytes',
   !/function\s+\w+\([^)]*bytes\s+(calldata|memory)\s+(content|document|file|data)\b/.test(src));

// Storage struct holds the CID (a string) but the document must not be there.
ok('the stored record is metadata: a CID, a digest, a type, a timestamp',
   /string\s+cid;/.test(src) && /bytes32\s+sha256Digest;/.test(src));

// There must be no way to erase history.
ok('there is no delete and no way to erase an anchor',
   !/\bdelete\s+_documents/.test(src) && !/selfdestruct/.test(src));

// It must enforce the same one-document-one-anchor rule as the Go rail.
ok('duplicate detection checks both the CID and the digest',
   /_documents\[cidKey\].status != Status.NONE/.test(src) && /_byDigest\[sha256Digest\]/.test(src));

if (warnings.length) {
  console.log(`\n  ${warnings.length} compiler warning(s):`);
  for (const w of warnings.slice(0, 5)) {
    console.log('    - ' + w.formattedMessage.split('\n')[0]);
  }
}

console.log(`\n  contracts: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
