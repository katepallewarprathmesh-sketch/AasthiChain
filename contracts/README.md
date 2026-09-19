# Payment Escrow — Sepolia Testnet — Real Money Involvement (Testnet)

**Purpose:** Involve real money flow without real money risk — uses Sepolia test ETH.

## Architecture — Hybrid: Drunix (permissioned property tokens) + Sepolia (public payment)

```
Investor (MetaMask on Sepolia)
   ↓ 1. initiatePayment(assetId, originator, tokenAmount) + test ETH
PaymentEscrow.sol (Sepolia Testnet) — locks test ETH
   ↓ 2. Event PaymentInitiated
Backend (API Gateway) listens event
   ↓ 3. Calls Drunix TransferTokens (property tokens move)
Drunix Ledger — TokenBalance updated, TransferRecord TXN-... created
   ↓ 4. Backend calls confirmDrunixTransfer(paymentId, TXN-...)
PaymentEscrow — status PENDING → CONFIRMED, links Drunix TXN ID
   ↓ 5. Backend calls releasePayment(paymentId)
PaymentEscrow — transfers test ETH to originator, status → RELEASED
   ↓ Atomic DvP (Delivery vs Payment) achieved
```

If Drunix transfer fails → `refundPayment` returns test ETH to investor.

## Why Testnet?

- **Real money flow** — actual blockchain transaction with gas, hash, confirmations — not mocked UPI
- **No real money risk** — Sepolia test ETH from faucet, free
- **Judge credibility** — shows you understand DvP, escrow, and hybrid permissioned + public architecture
- **Production path:** Replace test ETH with mainnet USDC / INR stablecoin or UPI escrow with same contract logic

## Contract: PaymentEscrow.sol

- `initiatePayment(bytes32 assetId, address to, uint256 tokenAmount)` payable — locks test ETH
- `confirmDrunixTransfer(bytes32 paymentId, string drunixTransferId)` — onlyRegistrar — links Drunix TXN
- `releasePayment(bytes32 paymentId)` — onlyRegistrar — releases ETH to originator
- `refundPayment(bytes32 paymentId)` — onlyRegistrar — refunds investor
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
   - Network: Sepolia (Chain ID 11155111) — add to MetaMask if not present
   - Constructor param: `_registrar` = your registrar wallet address (or same as owner for demo)
   - Value: 0, Deploy
5. Copy deployed contract address → put in frontend `.env` as `VITE_ESCROW_CONTRACT_ADDRESS`

### Testnet Faucet — Get Free Test ETH

- https://sepoliafaucet.com/ (Alchemy, requires free account)
- https://www.alchemy.com/faucets/ethereum-sepolia
- https://sepolia-faucet.pk910.de/ (PoW faucet)
- Each gives 0.5 SepoliaETH — enough for 100+ escrow transactions (gas ~0.001 ETH per tx)

### Verify on Etherscan

After deploy, verify contract at https://sepolia.etherscan.io/address/YOUR_CONTRACT_ADDRESS
- Shows all PaymentInitiated events, real testnet transactions with hash, gas, confirmations
- Share Etherscan link in pitch — proves real money flow

## Integration with AasthiChain

### API Gateway (Go or Node mock)

- Listens to `PaymentInitiated` event via `ethers.js` WebSocket provider
- On event, calls Drunix `TransferTokens`
- On success, calls `confirmDrunixTransfer` + `releasePayment` on Sepolia contract
- Endpoints:
  - `POST /api/testnet/payments/initiate` — returns paymentId, expects txHash from frontend
  - `GET /api/testnet/payments/:paymentId` — get payment status + linked Drunix TXN
  - `POST /api/testnet/payments/:paymentId/confirm` — registrar confirms Drunix transfer
  - `POST /api/testnet/payments/:paymentId/release` — release escrow

### Frontend

- `TestnetPayment.jsx` — Connect MetaMask, show Sepolia balance, initiate payment, show tx hash with Etherscan link, show status PENDING → CONFIRMED → RELEASED
- Wallet page now has 2-step flow: 1) Pay with testnet ETH (escrow) → 2) Token transfer on Drunix (atomic DvP)

## Mapping: Off-chain Identity → On-chain Wallet

- `originator1` → `0xOriginatorWallet` (set in env `ORIGINATOR_WALLET`)
- `investor1` → investor's MetaMask address (connected via wallet)
- Registrar wallet is owner/registrar of escrow contract

This mapping is stored in API gateway `walletMapping` table (Postgres in prod, in-memory for demo).

## Production Path

Replace Sepolia test ETH with:
- Mainnet USDC (ERC20) — change contract to use `transferFrom` + `approve`
- INR stablecoin or CBDC sandbox
- UPI escrow with same state machine (PENDING → CONFIRMED → RELEASED/REFUNDED)

The escrow logic stays same — only payment rail changes. This shows credible path to real money without building UPI integration for hackathon.
