// The property token: does the restricted token actually restrict?
//
// A compliance token is only worth the transfers it refuses, so almost every
// assertion below is a refusal. The suite compiles PropertyToken.sol and, if
// a local EVM is reachable, deploys it and drives the real contract: an
// unverified buyer, a holder cap, a per-holder cap, a lock-up, a freeze, a
// withdrawn KYC claim, a forced transfer and a key recovery.
//
// It skips cleanly when solc, ethers or a chain is missing, so the normal
// gate is unaffected:
//   npm i --no-save solc@0.8.26 ethers@6
//   npx ganache --wallet.deterministic --chain.chainId 1337
//   node tests/propertytoken.test.mjs

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const RPC = process.env.EVM_RPC_URL || 'http://127.0.0.1:8545'

let passed = 0
let failed = 0
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log('  ok   ' + label) }
  else { failed++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')) }
}
const done = () => {
  console.log(`\n  propertytoken: ${passed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}

let solc
try {
  solc = require('solc')
} catch {
  console.log('\n  solc is not installed, skipping the property token test.')
  console.log('  install it with: npm i --no-save solc@0.8.26\n')
  process.exit(0)
}

console.log('\nProperty token (ERC-20 + ERC-7943, ERC-3643 shape), solc ' + solc.version() + '\n')

/* ------------------------------------------------------------------ compile */

const source = readFileSync('contracts/PropertyToken.sol', 'utf8')
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'PropertyToken.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', // solc 0.8.26 defaults to cancun and emits MCOPY, which local nodes reject
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
})))

const errors = (out.errors || []).filter(e => e.severity === 'error')
ok('the contracts compile with no errors', errors.length === 0, errors.map(e => e.formattedMessage).join('\n'))
if (errors.length) done()

const warnings = (out.errors || []).filter(e => e.severity === 'warning')
ok('the contracts compile with no warnings', warnings.length === 0, warnings.map(e => e.formattedMessage).join('\n'))

const units = out.contracts['PropertyToken.sol']
const C = name => units[name]
for (const name of ['PropertyToken', 'IdentityRegistry', 'Compliance']) {
  ok(`${name} produces deployable bytecode`, (C(name)?.evm?.bytecode?.object || '').length > 0)
}

const names = abi => abi.filter(e => e.type === 'function').map(e => e.name)
const tokenFns = names(C('PropertyToken').abi)

// ERC-20, so an ordinary wallet or exchange sees a token it already understands.
for (const fn of ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf', 'transfer', 'approve', 'allowance', 'transferFrom']) {
  ok(`ERC-20 surface: ${fn}`, tokenFns.includes(fn))
}

// ERC-7943 (uRWA), Final May 2026: the restriction surface.
for (const fn of ['canTransact', 'canTransfer', 'getFrozenTokens', 'setFrozenTokens', 'forcedTransfer']) {
  ok(`ERC-7943 surface: ${fn}`, tokenFns.includes(fn))
}
const evs = C('PropertyToken').abi.filter(e => e.type === 'event').map(e => e.name)
ok('ERC-7943 events ForcedTransfer and Frozen are declared', evs.includes('ForcedTransfer') && evs.includes('Frozen'))
const errs = C('PropertyToken').abi.filter(e => e.type === 'error').map(e => e.name)
for (const e of ['ERC7943CannotTransact', 'ERC7943CannotTransfer', 'ERC7943InsufficientUnfrozenBalance']) {
  ok(`ERC-7943 error ${e} is declared`, errs.includes(e))
}

// The honest part: the contract says in its own source that the rail is the record.
ok('the source states the public chain is a mirror, not the record',
   /MIRROR, not the record/.test(source) && /the rail is authoritative/.test(source))
ok('the token carries the rail asset id it mirrors', tokenFns.includes('railAssetId'))

// No upgrade path and no owner withdrawal: the rules cannot be swapped out
// from under a holder after they buy.
ok('there is no proxy upgrade hook', !/upgradeTo|delegatecall/.test(source))

/* ------------------------------------------------------------------- deploy */

let ethers
try {
  ethers = await import('ethers')
} catch {
  console.log('\n  ethers is not installed, skipping the on-chain behaviour checks.')
  done()
}

let provider, signers
try {
  provider = new ethers.JsonRpcProvider(RPC)
  await provider.getBlockNumber()
  signers = []
  const accounts = await provider.listAccounts()
  for (const a of accounts.slice(0, 5)) signers.push(await provider.getSigner(a.address))
  if (signers.length < 5) throw new Error('need five funded accounts')
} catch (e) {
  console.log(`\n  no EVM at ${RPC}, skipping the on-chain behaviour checks.`)
  console.log('  start one with: npx ganache --wallet.deterministic --chain.chainId 1337\n')
  done()
}

const [issuer, alice, bob, carol, mallory] = signers
const deploy = async (name, args) => {
  const f = new ethers.ContractFactory(C(name).abi, C(name).evm.bytecode.object, issuer)
  const c = await f.deploy(...args)
  await c.waitForDeployment()
  return c
}
const reverts = async (p, label) => {
  try { await p; ok(label, false, 'the call succeeded when it should have been refused'); return null }
  catch (e) { ok(label, true); return e }
}

const registry = await deploy('IdentityRegistry', [])
//   maxHolders 3, maxPerHolder 600 tokens, minimum KYC tier 1
const compliance = await deploy('Compliance', [3, 600, 1])
const assetId = ethers.keccak256(ethers.toUtf8Bytes('PROP-SOLARIS-PUNE-001'))
const token = await deploy('PropertyToken', [
  'AasthiChain Solaris Pune 001', 'AXSOL', assetId, await registry.getAddress(), await compliance.getAddress(),
])
await (await compliance.bindToken(await token.getAddress())).wait()

const did = who => ethers.keccak256(ethers.toUtf8Bytes('did:aasthi:' + who))
const IN = ethers.hexlify(ethers.toUtf8Bytes('IN'))
await (await registry.register(issuer.address, did('originator1'), 2, IN, 0)).wait()
await (await registry.register(alice.address, did('investor1'), 2, IN, 0)).wait()
await (await registry.register(bob.address, did('investor2'), 2, IN, 0)).wait()

ok('an unverified wallet cannot transact', (await token.canTransact(mallory.address)) === false)
ok('a verified wallet can transact', (await token.canTransact(alice.address)) === true)

await (await token.mint(alice.address, 500)).wait()
ok('the issuer can mint to a verified holder', (await token.balanceOf(alice.address)) === 500n)
ok('minting moves total supply', (await token.totalSupply()) === 500n)

await reverts(token.mint(mallory.address, 1), 'minting to an unverified wallet is refused')

ok('canTransfer refuses an unverified recipient',
   (await token.canTransfer(alice.address, mallory.address, 1)) === false)
await reverts(token.connect(alice).transfer(mallory.address, 1),
              'a transfer to an unverified recipient reverts')

await (await token.connect(alice).transfer(bob.address, 100)).wait()
ok('an eligible transfer settles', (await token.balanceOf(bob.address)) === 100n)
ok('the sender is debited', (await token.balanceOf(alice.address)) === 400n)

// transferFrom must pass the same gate, or the restriction is decorative.
await (await token.connect(alice).approve(mallory.address, 50)).wait()
await reverts(token.connect(mallory).transferFrom(alice.address, mallory.address, 50),
              'an approval cannot route tokens around the eligibility gate')

/* --------------------------------------------------------------- the caps */

await reverts(token.mint(bob.address, 600), 'the per-holder cap refuses an oversized position')
ok('the per-holder cap is visible before the attempt, not only on revert',
   (await token.canReceive(bob.address, 600)) === false &&
   (await token.canReceive(bob.address, 400)) === true)

// Holder cap of three: issuer, alice and bob are already in.
await (await registry.register(carol.address, did('investor3'), 2, IN, 0)).wait()
ok('holder count tracks reality', (await token.holders()) === 2n)
await (await token.mint(carol.address, 10)).wait()
ok('a third holder is admitted at the cap', (await token.holders()) === 3n)
await (await registry.register(mallory.address, did('investor4'), 2, IN, 0)).wait()
await reverts(token.mint(mallory.address, 1), 'the holder cap refuses a fourth holder')
ok('a cap breach leaves the holder count unchanged', (await token.holders()) === 3n)

// A tier below the offering's minimum is refused even when verified.
await (await registry.register(mallory.address, did('investor4'), 0, IN, 0)).wait()
ok('a holder below the minimum KYC tier cannot receive',
   (await token.canReceive(mallory.address, 1)) === false)

/* ----------------------------------------------------- lock-up and freeze */

const future = Math.floor(Date.now() / 1000) + 86400
await (await registry.register(carol.address, did('investor3'), 2, IN, future)).wait()
await reverts(token.connect(alice).transfer(carol.address, 1), 'a lock-up refuses an incoming transfer')
await (await registry.register(carol.address, did('investor3'), 2, IN, 0)).wait()

await (await token.setFrozenTokens(alice.address, 350)).wait()
ok('the frozen amount is readable', (await token.getFrozenTokens(alice.address)) === 350n)
ok('the unfrozen part still moves', (await token.canTransfer(alice.address, bob.address, 50)) === true)
await reverts(token.connect(alice).transfer(bob.address, 100),
              'a transfer against frozen tokens is refused')
await (await token.connect(alice).transfer(bob.address, 50)).wait()
ok('a transfer within the unfrozen balance settles', (await token.balanceOf(alice.address)) === 350n)

// setFrozenTokens overwrites, as ERC-7943 specifies, rather than adding.
await (await token.setFrozenTokens(alice.address, 0)).wait()
ok('setFrozenTokens overwrites rather than accumulating',
   (await token.getFrozenTokens(alice.address)) === 0n)

/* ----------------------------------------------- withdrawn KYC, enforcement */

await (await registry.remove(bob.address, 'periodic re-screening lapsed')).wait()
ok('a withdrawn claim stops the next transfer, not the one after renewal',
   (await token.canTransact(bob.address)) === false)
await reverts(token.connect(bob).transfer(alice.address, 1), 'a lapsed holder cannot send')
await (await registry.register(bob.address, did('investor2'), 2, IN, 0)).wait()

// Forced transfer: the enforcement path, and still not a back door.
await (await token.setFrozenTokens(alice.address, 350)).wait()
const before = await token.balanceOf(carol.address)
const rc = await (await token.forcedTransfer(alice.address, carol.address, 300)).wait()
ok('a forced transfer moves frozen tokens', (await token.balanceOf(carol.address)) === before + 300n)
ok('a forced transfer unfreezes only what it moved',
   (await token.getFrozenTokens(alice.address)) === 50n)

const topics = rc.logs.map(l => l.topics[0])
const sig = s => ethers.id(s)
const iFrozen = topics.indexOf(sig('Frozen(address,uint256)'))
const iTransfer = topics.indexOf(sig('Transfer(address,address,uint256)'))
const iForced = topics.indexOf(sig('ForcedTransfer(address,address,uint256)'))
ok('the unfreeze is logged before the transfer, as ERC-7943 requires',
   iFrozen >= 0 && iTransfer >= 0 && iFrozen < iTransfer)
ok('a forced transfer emits both Transfer and ForcedTransfer', iForced > iTransfer)

await reverts(token.forcedTransfer(alice.address, mallory.address, 1),
              'even a forced transfer cannot place tokens with an ineligible holder')
await reverts(token.connect(alice).forcedTransfer(bob.address, alice.address, 1),
              'a holder cannot force a transfer')
await reverts(token.connect(alice).setFrozenTokens(bob.address, 1),
              'a holder cannot freeze somebody else')

/* -------------------------------------------------------------- recovery */

// A replacement wallet for the same investor, which is the only kind of
// recovery that is not a transfer of ownership in disguise.
await (await registry.register(mallory.address, did('investor1'), 2, IN, 0)).wait()
const lost = await token.balanceOf(alice.address)
const frozenBefore = await token.getFrozenTokens(alice.address)
await (await token.recover(alice.address, mallory.address)).wait()
ok('recovery moves the whole position to the replacement wallet',
   (await token.balanceOf(mallory.address)) === lost && (await token.balanceOf(alice.address)) === 0n)
ok('recovery carries the freeze across rather than clearing it',
   (await token.getFrozenTokens(mallory.address)) === frozenBefore)
await reverts(token.recover(mallory.address, bob.address),
              'recovery to a different investor is refused')

/* ------------------------------------------------------- pause and mirror */

await (await token.setPaused(true)).wait()
ok('a pause stops every holder transacting', (await token.canTransact(mallory.address)) === false)
await reverts(token.connect(mallory).transfer(bob.address, 1), 'a paused token refuses transfers')
await (await token.setPaused(false)).wait()

const mr = await (await token.mirror(600, 'rail position as of this block')).wait()
ok('the mirror statement is recorded on chain',
   mr.logs.some(l => l.topics[0] === sig('Mirrored(uint256,uint256,string)')))

// Conservation, the same invariant the rail asserts.
const sum = (await token.balanceOf(mallory.address)) + (await token.balanceOf(bob.address))
  + (await token.balanceOf(carol.address)) + (await token.balanceOf(issuer.address))
ok('balances sum to total supply', sum === (await token.totalSupply()))

ok('ERC-165 reports the ERC-7943 fungible interface',
   await token.supportsInterface(
     C('PropertyToken').abi.filter(e => e.type === 'function' &&
       ['forcedTransfer', 'setFrozenTokens', 'canTransact', 'getFrozenTokens', 'canTransfer'].includes(e.name))
       .map(e => ethers.id(`${e.name}(${e.inputs.map(i => i.type).join(',')})`).slice(0, 10))
       .reduce((a, b) => ethers.hexlify(
         ethers.getBytes(a).map((x, i) => x ^ ethers.getBytes(b)[i])))))

done()
