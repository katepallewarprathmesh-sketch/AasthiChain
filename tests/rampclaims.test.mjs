// Ramp claims: what the public copy is allowed to say about moving money.
//
// WHAT THIS GUARDS
// The cross-border leg is the one place in this product where a sentence can
// create legal exposure that no amount of correct code undoes. Indian
// enforcement against crypto-linked remittance is not about ledgers, it is
// about whether a platform held, converted or routed value without being
// authorised to, and the evidence is usually the platform's own marketing.
//
// Today the copy is careful. Conversion is described as happening outside
// India, through a named third-party provider, with a bank advice reference
// and an RBI purpose code as the thing that lets rupees be credited, and the
// whole leg is badged as simulated. None of that carefulness is enforced
// anywhere. A single well-meant copy edit (shortening "the off-ramp provider
// converts" to "we convert", dropping a Simulated tag to make a screen look
// more impressive) would turn an honest demonstration into an advertisement
// for an unauthorised service, and nothing in the repository would notice.
//
// So these checks hold the specific sentences that do the legal work:
//
//   1. AasthiChain never claims to convert, hold, custody or exchange crypto
//      itself. The counterparty is always the provider.
//   2. Nowhere invites a user to send coin to us, or offers to buy, sell or
//      trade it.
//   3. Any screen that discusses the off-ramp carries a simulated marker.
//   4. The FEMA evidence trail (outside India, bank advice, purpose code,
//      banking channels) stays in the copy rather than being compressed away.
//   5. No screen claims live NPCI, RBI or registrar connectivity.
//   6. The rail still refuses to credit rupees without a complete attestation,
//      so the copy and the code say the same thing.
//
// This is a static read of tracked source. It needs no running stack.
//
//   node tests/rampclaims.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const root = new URL('../', import.meta.url).pathname;
const src = (rel) => readFileSync(join(root, rel), 'utf8');

const walk = (dir, out = []) => {
  for (const e of readdirSync(join(root, dir))) {
    const rel = dir + '/' + e;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(jsx|js)$/.test(e)) out.push(rel);
  }
  return out;
};

// Every file the user can actually read words from.
const uiFiles = walk('frontend/src').filter(f => !/\.test\./.test(f));
const uiText = uiFiles.map(f => ({ f, t: src(f) }));

const hits = (re) => uiText.filter(({ t }) => re.test(t)).map(({ f }) => f);

const run = () => {
  console.log('Ramp claims');

  // ------------------------------------------- 1. we are not the converter ---
  // First person conversion. "The provider converts" is the only correct
  // shape; "we convert", "our off-ramp", "AasthiChain converts" are not.
  const firstPerson = [
    /\b(we|AasthiChain)\s+(convert|exchange|custody|hold your (crypto|coin|stablecoin|usdc))/i,
    /\bour\s+(off-?ramp|on-?ramp|exchange|custody)\b/i,
    /\bAasthiChain\s+(converts|exchanges|custodies)\b/i,
  ];
  for (const re of firstPerson) {
    const bad = hits(re);
    ok('no copy says ' + re.source.slice(0, 44) + '…', bad.length === 0, bad.join(', '));
  }

  // --------------------------------------------- 2. no invitation to ramp ---
  const invitations = [
    { re: /\bsend (your |us )?(crypto|coin|usdc|eurc|stablecoin)s? to (us|AasthiChain)\b/i, what: 'inviting coin to be sent to us' },
    { re: /\b(buy|sell|trade|swap) (crypto|bitcoin|usdt|stablecoins?)\b/i, what: 'offering to buy, sell or trade crypto' },
    { re: /\bcrypto (exchange|trading)\b/i, what: 'describing itself as an exchange' },
    { re: /\b(on-?ramp|off-?ramp) (service|provider)? ?(we|by AasthiChain) (run|operate|provide)/i, what: 'claiming to run a ramp' },
    { re: /\bwithdraw (your )?(crypto|coin|usdc) to (your )?bank\b/i, what: 'offering a withdrawal route' },
  ];
  for (const { re, what } of invitations) {
    const bad = hits(re);
    ok('no copy is ' + what, bad.length === 0, bad.join(', '));
  }

  // ------------------------------------- 3. ramp screens are badged as sim ---
  // Any screen that discusses the off-ramp at all must also say, on that same
  // screen, that the leg is simulated. The two must travel together.
  const rampScreens = uiText.filter(({ f, t }) =>
    /pages\//.test(f) && /off-?ramp/i.test(t));
  ok('at least one screen discusses the off-ramp', rampScreens.length > 0);
  const unbadged = rampScreens.filter(({ t }) => !/simulat(ed|ion)/i.test(t));
  ok('every screen that discusses the off-ramp also says it is simulated',
    unbadged.length === 0, unbadged.map(x => x.f).join(', '));

  // -------------------------------------------- 4. the FEMA evidence trail ---
  // These four ideas are what make the described route lawful rather than a
  // hawala description. Losing any one of them changes the meaning.
  const cb = src('frontend/src/pages/CrossBorder.jsx');
  const required = [
    { re: /outside India/i, what: 'conversion happens outside India' },
    { re: /banking channels/i, what: 'rupees arrive through banking channels' },
    { re: /bank advice/i, what: 'a bank advice reference is the evidence' },
    { re: /purpose code/i, what: 'an RBI purpose code travels with it' },
    { re: /off-?ramp provider/i, what: 'the counterparty is a named provider' },
    { re: /never a seller and never an Indian account|never an Indian account/i, what: 'the receiving address is never an Indian account' },
    { re: /paying the seller in tokens/i, what: 'the prohibited shape is stated' },
  ];
  for (const { re, what } of required) {
    ok('the cross-border page still states that ' + what, re.test(cb));
  }

  // ------------------------------------------ 5. no live-connectivity claim ---
  // The negations ("no live NPCI credentials") must survive; the assertions
  // must never appear.
  const liveClaims = [
    /\b(connected|integrated|wired) (directly )?(to|with) (NPCI|the RBI|RBI|the registrar)\b/i,
    /\blive (NPCI|RBI|registrar) (connection|integration|credentials are)\b/i,
    /\b(NPCI|RBI|registrar)[- ]approved\b/i,
    /\b(licen[sc]ed|authorised|authorized) by (the )?(RBI|SEBI|NPCI)\b/i,
  ];
  for (const re of liveClaims) {
    const bad = hits(re);
    ok('no copy claims ' + re.source.slice(0, 40) + '…', bad.length === 0, bad.join(', '));
  }

  // ------------------------------------------- 6. the code agrees with it ---
  // The copy promises that nothing is credited without an attestation. The
  // rail must actually refuse, or the page is a lie with a passing test suite.
  const go = src('drunix-gateway/crossborder.go');
  ok('the rail refuses an attestation with no advice reference',
    /AdviceRef\)\s*==\s*""/.test(go));
  ok('the rail refuses an attestation with no purpose code',
    /PurposeCode\)\s*==\s*""/.test(go));
  ok('the rail refuses a non-positive remitted amount',
    /AmountINR\s*<=\s*0/.test(go));
  ok('crediting rupees is the only step gated on the attestation',
    /only step that creates|credited only against/i.test(go));

  // The simulated provider must stay labelled as simulated in the code too,
  // so that a real provider is a deliberate swap and not an accident.
  ok('the off-ramp provider in the rail is explicitly a simulation',
    /SimulatedOfframp/.test(go));

  console.log('\n  ' + passed + '/' + (passed + failed) + ' passed');
  process.exit(failed ? 1 : 0);
};

run();
