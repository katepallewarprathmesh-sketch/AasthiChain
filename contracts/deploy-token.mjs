// Deploy the property token stack to a local EVM chain and print the addresses.
//
//   node contracts/deploy-token.mjs [assetId] [symbol]
//
// Needs a chain listening on EVM_RPC_URL (default http://127.0.0.1:8545).
// Start one with:  npx ganache --wallet.deterministic --chain.chainId 1337
//
// Three contracts go up, in the ERC-3643 arrangement: an identity registry
// that says who may hold, a compliance contract that holds the offering's
// rules, and the token itself. The deployer becomes the issuing agent.
//
// Nothing here mints. The supply on a public chain should only ever follow a
// position that already exists on the rail, so minting is a separate,
// deliberate act by an agent.
import { readFileSync } from 'node:fs'
import solc from 'solc'
import { JsonRpcProvider, ContractFactory, keccak256, toUtf8Bytes } from 'ethers'

const RPC = process.env.EVM_RPC_URL || 'http://127.0.0.1:8545'
const SRC = 'contracts/PropertyToken.sol'

const RAIL_ASSET_ID = process.argv[2] || 'PROP-SOLARIS-PUNE-001'
const SYMBOL = process.argv[3] || 'AXPROP'

// Offering rules. Zero disables a rule, and a disabled rule should be a
// decision somebody made rather than a default nobody noticed.
const MAX_HOLDERS = Number(process.env.TOKEN_MAX_HOLDERS || 200)
const MAX_PER_HOLDER = Number(process.env.TOKEN_MAX_PER_HOLDER || 1000)
const MIN_KYC_TIER = Number(process.env.TOKEN_MIN_KYC_TIER || 1)

const input = {
  language: 'Solidity',
  sources: { 'PropertyToken.sol': { content: readFileSync(SRC, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // solc 0.8.26 defaults to cancun and emits MCOPY, which most local nodes
    // reject as an invalid opcode. Pin the target.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}
const out = JSON.parse(solc.compile(JSON.stringify(input)))
const fatal = (out.errors || []).filter(e => e.severity === 'error')
if (fatal.length) {
  for (const e of fatal) console.error(e.formattedMessage)
  process.exit(1)
}
const units = out.contracts['PropertyToken.sol']

const provider = new JsonRpcProvider(RPC)
const signer = await provider.getSigner(0)
const deployer = await signer.getAddress()

async function deploy(name, args) {
  const u = units[name]
  const c = await new ContractFactory(u.abi, u.evm.bytecode.object, signer).deploy(...args)
  await c.waitForDeployment()
  return c
}

const identities = await deploy('IdentityRegistry', [])
const compliance = await deploy('Compliance', [MAX_HOLDERS, MAX_PER_HOLDER, MIN_KYC_TIER])
const token = await deploy('PropertyToken', [
  `AasthiChain ${RAIL_ASSET_ID}`,
  SYMBOL,
  keccak256(toUtf8Bytes(RAIL_ASSET_ID)),
  await identities.getAddress(),
  await compliance.getAddress(),
])
// Bound once and never again, so the holder cap cannot be fed a forged count.
await (await compliance.bindToken(await token.getAddress())).wait()

console.log(`PropertyToken     ${await token.getAddress()}  (${SYMBOL}, mirrors ${RAIL_ASSET_ID})`)
console.log(`IdentityRegistry  ${await identities.getAddress()}`)
console.log(`Compliance        ${await compliance.getAddress()}  holders<=${MAX_HOLDERS}, perHolder<=${MAX_PER_HOLDER}, tier>=${MIN_KYC_TIER}`)
console.log(`issuing agent     ${deployer}`)
console.log('')
console.log('export EVM_RPC_URL=' + RPC)
console.log('export EVM_TOKEN_ADDRESS=' + (await token.getAddress()))
console.log('export EVM_IDENTITY_REGISTRY_ADDRESS=' + (await identities.getAddress()))
console.log('export EVM_COMPLIANCE_ADDRESS=' + (await compliance.getAddress()))
console.log('export EVM_SENDER_ADDRESS=' + deployer)
console.log('')
console.log('The rail remains the record. Supply here should follow the rail, never lead it.')
