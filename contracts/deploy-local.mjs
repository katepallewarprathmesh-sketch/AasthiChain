// Deploy DocumentRegistry.sol to a local EVM chain and print the address.
//
//   node contracts/deploy-local.mjs
//
// Needs a chain listening on EVM_RPC_URL (default http://127.0.0.1:8545).
// Start one with:  npx ganache --wallet.deterministic --chain.chainId 1337
//
// Prints the three environment variables the gateway needs, so the output can
// be pasted straight into a shell.
import { readFileSync } from 'node:fs'
import solc from 'solc'
import { JsonRpcProvider, ContractFactory } from 'ethers'

const RPC = process.env.EVM_RPC_URL || 'http://127.0.0.1:8545'
const SRC = 'contracts/DocumentRegistry.sol'

function compile() {
  const input = {
    language: 'Solidity',
    sources: { 'DocumentRegistry.sol': { content: readFileSync(SRC, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Pin the target EVM. solc 0.8.26 defaults to cancun, which emits MCOPY
      // for memory struct copies; most chains and local nodes do not
      // implement it yet, and the failure looks like a mysterious "invalid
      // opcode" on every function that returns a struct.
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
  const c = out.contracts['DocumentRegistry.sol'].DocumentRegistry
  return { abi: c.abi, bytecode: c.evm.bytecode.object }
}

const { abi, bytecode } = compile()
const provider = new JsonRpcProvider(RPC)
const signer = await provider.getSigner(0)
const deployer = await signer.getAddress()

const registry = await new ContractFactory(abi, bytecode, signer).deploy()
await registry.waitForDeployment()
const address = await registry.getAddress()

// The deployer is a registrar by construction; the gateway signs as the same
// account unless EVM_SENDER_ADDRESS says otherwise.
console.log(`DocumentRegistry deployed at ${address}`)
console.log(`deployer / registrar      ${deployer}`)
console.log('')
console.log('export EVM_RPC_URL=' + RPC)
console.log('export EVM_REGISTRY_ADDRESS=' + address)
console.log('export EVM_SENDER_ADDRESS=' + deployer)
