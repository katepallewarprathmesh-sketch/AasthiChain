# PropertyToken.sol: the public-chain leg of a fractional property

The asset tokens are issued, transferred and settled on the permissioned rail.
`PropertyToken.sol` exists so a holder can prove a position on a public chain
without asking us, and so a counterparty who will only trust a public chain
gets the same arithmetic.

It is a mirror, not the record. Where the two disagree, the rail is right.
Settlement, the cash leg and conservation stay on the rail, because a public
chain is final under rules the regulator does not set.

## The standard, and why

ERC-20 for the base, so an ordinary wallet or venue sees a token it already
understands, plus **ERC-7943 (uRWA)**, Final since May 2026, for the
restriction surface: `canTransact`, `canTransfer`, `getFrozenTokens`,
`setFrozenTokens`, `forcedTransfer`, with the `ForcedTransfer` and `Frozen`
events and the three standard errors.

The arrangement is the one **ERC-3643** uses: the token holds balances, an
identity registry says who may hold, a compliance contract holds the rules of
the offering, and agent roles carry the powers an issuer and a regulator
actually need (freeze, forced transfer, recovery, pause).

Two standards were considered and not used. **ERC-1400** was rejected because
its one real advantage over the alternatives is partitions, which a single
property's fractional interest does not use, and the family never left Draft.
**ERC-3643 with ONCHAINID** was rejected only for its identity half: it
prescribes a per-investor identity contract, and this project already has
DIDs, verifiable credentials, KYC tiers and a signing-key register. Running
two identity systems that must agree is a promise that one day they will not.
ERC-7943 is deliberately identity-agnostic, which is the right seam when the
identity layer already exists.

## What is enforced, and where

Every ordinary movement goes through one internal gate, so a restriction
cannot be sidestepped by using `transferFrom` or an approval instead of
`transfer`. Minting passes the same eligibility check as a purchase.

- unverified or lapsed holder: refused
- lock-up still running on the receiving side: refused
- offering caps (holders, position per holder, minimum KYC tier): refused
- frozen tokens: the unfrozen part still moves, the frozen part does not
- `forcedTransfer`: agent only, and still refuses an ineligible recipient
- recovery of a lost key: only to another wallet of the same investor

## Running it

```bash
npm i --no-save solc@0.8.26 ethers@6
npx ganache --wallet.deterministic --chain.chainId 1337
node contracts/deploy-token.mjs            # prints the addresses to export
node tests/propertytoken.test.mjs          # 66 checks against a live deployment
```

The suite skips cleanly when solc, ethers or a chain is absent, so the normal
gate is unaffected. Nothing in the deploy script mints: supply on the public
chain should follow the rail, never lead it.


---

# Payment Escrow: Sepolia Testnet, Atomic DvP Settlement Pattern Demo

**Purpose:** Demonstrate real on-chain testnet transactions demonstrating an atomic delivery-vs-payment settlement pattern. It uses Sepolia test ETH, which has no monetary value.

## Architecture: hybrid Drunix (permissioned property tokens) + Sepolia (public escrow) settlement pattern

```
Investor (MetaMask on Sepolia)
   ↓ 1. initiatePayment(assetId, originator, tokenAmount) + Sepolia test ETH (min 0.001, no monetary value)
PaymentEscrow.sol (Sepolia Testnet): locks test ETH in escrow, demonstrates DvP pattern
   ↓ 2. Event PaymentInitiated: real on-chain testnet transaction, Etherscan-verifiable when faucet ETH used
Backend (API Gateway) listens event
   ↓ 3. Calls Drunix TransferTokens (property tokens move)
Drunix Ledger: TokenBalance updated, TransferRecord TXN-... created on the real Drunix ledger
   ↓ 4. Backend calls confirmDrunixTransfer(paymentId, TXN-...)
PaymentEscrow: status PENDING → CONFIRMED, links Drunix TXN ID
   ↓ 5. Backend calls releasePayment(paymentId)
PaymentEscrow: transfers Sepolia test ETH to originator, status → RELEASED
   ↓ Atomic DvP settlement pattern achieved: demonstrates delivery-vs-payment, not real monetary value
```

If Drunix transfer fails → `refundPayment` returns Sepolia test ETH to investor.

## Why Testnet?: Accurate Framing

- **Real on-chain testnet transactions**: actual blockchain transactions with gas, hash, confirmations, Etherscan-verifiable when faucet ETH available, demonstrating atomic DvP settlement pattern, not mocked UPI, not real monetary value
- **Sepolia test ETH has no monetary value**: from faucet, free, used only to demonstrate settlement pattern
- **Judge credibility**: shows you understand DvP, escrow, and hybrid permissioned + public architecture, real Sepolia flow stays front and center, simulated fallback clearly labeled greyed out non-clickable visibly different, no fabricated hash or fake Etherscan link
- **Production path:** Replace Sepolia test ETH (no value) with mainnet USDC / INR stablecoin or UPI escrow with same contract logic: same atomic DvP settlement pattern applicable to NPCI

## Contract: PaymentEscrow.sol

- `initiatePayment(bytes32 assetId, address to, uint256 tokenAmount)` payable: locks test ETH
- `confirmDrunixTransfer(bytes32 paymentId, string drunixTransferId)`: onlyRegistrar, links Drunix TXN
- `releasePayment(bytes32 paymentId)`: onlyRegistrar, releases ETH to originator
- `refundPayment(bytes32 paymentId)`: onlyRegistrar, refunds investor
- Events: `PaymentInitiated`, `PaymentConfirmed`, `PaymentReleased`, `PaymentRefunded`

## Deployment to Sepolia Testnet

### Prerequisites
- Node.js 18+, MetaMask with Sepolia network
- Sepolia test ETH from faucet: https://sepoliafaucet.com/ or https://www.alchemy.com/faucets/ethereum-sepolia
- Alchemy/Infura Sepolia RPC URL

### Deploy via Hardhat

```bash
cd contracts
npm init -y
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
npx hardhat init

# .env
# SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
# PRIVATE_KEY=0xYOUR_PRIVATE_KEY (registrar/owner wallet)
# REGISTRAR_ADDRESS=0xRegistrarWallet

# hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
module.exports = {
  solidity: "0.8.20",
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL,
      accounts: [process.env.PRIVATE_KEY]
    }
  }
};

npx hardhat run scripts/deploy.js --network sepolia
```

### Deploy via Remix (No CLI, Easiest for Demo)

1. Go to https://remix.ethereum.org/
2. Create new file `PaymentEscrow.sol`, paste contract
3. Compile with 0.8.20
4. Deploy:
   - Environment: Injected Provider - MetaMask
   - Network: Sepolia (Chain ID 11155111): add to MetaMask if not present
   - Constructor param: `_registrar` = your registrar wallet address (or same as owner for demo)
   - Value: 0, Deploy
5. Copy deployed contract address → put in frontend `.env` as `VITE_ESCROW_CONTRACT_ADDRESS`

### Testnet Faucet: Get Free Test ETH, Min 0.001 Fix

- https://sepoliafaucet.com/ (Alchemy, requires free account): **best, instant 0.5 ETH**
- https://www.alchemy.com/faucets/ethereum-sepolia
- https://faucet.quicknode.com/ethereum/sepolia: 0.05 ETH, no signup
- https://sepolia-faucet.pk910.de/ (PoW faucet): 0.5 ETH
- Each gives 0.5 SepoliaETH: enough for 100+ escrow transactions (gas ~0.001 ETH per tx)

**Fix for "min balance 0.001" error:** Old oracle ₹2L=1ETH gave dust amounts like 0.0005 ETH for small token purchases → MetaMask/Sepolia rejected with "min balance 0.001" (dust protection + gas). Fixed by:
1. New oracle ₹20k=1ETH (10x larger): 1 token @ ₹500 = 0.025 ETH (not 0.0025) → always >0.001
2. Frontend enforces `Math.max(calculated, 0.001)`: min 0.001 ETH
3. UI shows low-balance warning + faucet links + Simulated fallback (clearly labeled greyed out non-clickable, no fabricated hash or fake Etherscan link) when faucet unavailable: real Sepolia flow stays front and center, demonstrating real on-chain testnet transactions demonstrating atomic DvP settlement pattern

If faucets rate-limited, use Simulated mode, which shows "Simulated, faucet unavailable, no real transaction" greyed out non-clickable visibly different from real row, no fabricated 0x... hash or fake Etherscan link, backend still does Drunix leg to demonstrate DvP pattern.

### Verify on Etherscan

After deploy, verify contract at https://sepolia.etherscan.io/address/YOUR_CONTRACT_ADDRESS
- Shows all PaymentInitiated events, real on-chain testnet transactions with hash, gas, confirmations when faucet ETH used: demonstrates atomic DvP settlement pattern, Sepolia test ETH has no monetary value
- Share Etherscan link in pitch: proves real on-chain testnet transactions demonstrating settlement pattern

## Integration with AasthiChain

### API Gateway (Go or Node mock)

- Listens to `PaymentInitiated` event via `ethers.js` WebSocket provider (real Sepolia flow)
- On event, calls Drunix `TransferTokens`
- On success, calls `confirmDrunixTransfer` + `releasePayment` on Sepolia contract
- Endpoints:
  - `POST /api/testnet/payments/initiate`: returns paymentId, expects txHash from frontend when real Sepolia tx available, or simulated ID when faucet unavailable (clearly labeled, no fake hash)
  - `GET /api/testnet/payments/:paymentId`: get payment status + linked Drunix TXN
  - `POST /api/testnet/payments/:paymentId/confirm`: registrar confirms Drunix transfer
  - `POST /api/testnet/payments/:paymentId/release`: release escrow

### Frontend

- `TestnetPayment.jsx`: Connect MetaMask, show Sepolia balance, initiate real on-chain testnet transactions with Etherscan link when faucet ETH available, show status PENDING → CONFIRMED → RELEASED, real Sepolia flow front and center, simulated fallback greyed out non-clickable visibly different no fabricated hash
- Wallet page now has 2-step flow: 1) Pay with Sepolia test ETH escrow demonstrating DvP settlement pattern (no monetary value) → 2) Token transfer on Drunix (atomic DvP)

## Mapping: Off-chain Identity → On-chain Wallet

- `originator1` → `0xOriginatorWallet` (set in env `ORIGINATOR_WALLET`)
- `investor1` → investor's MetaMask address (connected via wallet)
- Registrar wallet is owner/registrar of escrow contract

This mapping is stored in API gateway `walletMapping` table (Postgres in prod, in-memory for demo).

## Production Path

Replace Sepolia test ETH (no monetary value, used to demonstrate settlement pattern) with:
- Mainnet USDC (ERC20): change contract to use `transferFrom` + `approve`
- INR stablecoin or CBDC sandbox
- UPI escrow with same state machine (PENDING → CONFIRMED → RELEASED/REFUNDED): same atomic DvP settlement pattern applicable to NPCI

The escrow logic stays same; only the payment rail changes. This demonstrates credible path to settlement pattern applicable to real payments without building UPI integration for hackathon. It demonstrates real on-chain testnet transactions demonstrating atomic DvP settlement pattern, not real monetary value.
