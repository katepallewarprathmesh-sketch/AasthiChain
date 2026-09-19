# AasthiChain

Fractional real estate tokenization platform built on [Drunix](https://github.com/npci/drunix), 
NPCI's open-source enterprise blockchain platform (a Hyperledger Fabric fork).

Built for the **Drunix Hackathon in collaboration with Citi** — Problem Statement 2: Real Asset Tokenization.

## Problem

Real estate in India is illiquid, slow to transfer, and locked behind large minimum ticket sizes. 
Ownership records are fragmented across registries with no single verifiable source of truth.

## Solution

AasthiChain tokenizes property into fractional, tradeable digital ownership units on a permissioned 
multi-organization Drunix network — enabling instant, auditable transfers and low minimum investment.

## Architecture

- **Originator org** — onboards and tokenizes properties
- **Registrar org** — validates legal ownership against land records
- **Investor org** — holds and trades fractional tokens
- **Regulator org** — read-only audit access across the network

## Tech Stack

- Drunix (Hyperledger Fabric fork) — ledger
- Go — chaincode & backend
- PostgreSQL — on-chain SQL storage (Drunix feature)
- React — investor dashboard

## License

Apache License 2.0
