# How AasthiChain fits together

The README describes what the product does. This file is for people reading or changing the code.

<div align="center">

<img src="architecture.png" alt="AasthiChain architecture: owners, registrars, investors and regulators work through a web experience; an access layer establishes who is calling and what they may touch; a settlement core moves the cash leg and the ownership leg as one atomic exchange; and every state change is written to an append-only record that the whole system answers to." width="100%">

</div>

<sub>Vector source: [`architecture.svg`](architecture.svg) — edit the SVG, then re-export the PNG
(command in [`DEPLOYMENT.md`](DEPLOYMENT.md)).</sub>

## The design rule

Every rule about money lives in one place — the settlement core, beside the ledger it protects. The
layers in front of it carry requests and identity and nothing else. **If a rule about money can be
found anywhere but the core, that is a bug.**

Concretely: the settlement core is Go, the web app and its API edge are JavaScript, and the edge
forwards settlement calls without deciding anything about them. It owns the property register, KYC
and the UPI payment lifecycle; it does not own balances, positions or the chain.

## The four layers

| Layer | Responsibility |
|---|---|
| **Experience** | what each role can see and do, and the public pages anyone may read |
| **Access** | establishes who is calling, and decides what that caller is entitled to touch |
| **Settlement** | holds the cash leg and the ownership leg, and moves them as one |
| **Work** | escrows a fee against a defined deliverable, and releases it only against anchored evidence (see [WORK_ORDERS.md](WORK_ORDERS.md)) |
| **Record** | the append-only history every other layer answers to |

The experience and the settlement core deploy independently, so either can be replaced — or fail —
without the other. When the core cannot be reached the app reports *unknown*; it never reports a
settlement surface as healthy because it could not ask.

## Authorisation

Entitlement is decided in front of the router rather than route by route, so a new surface is
covered the day it ships. The rules are:

- an unidentified caller is refused with 401, a stranger with 403;
- a supervisor — regulator or admin — may act for someone else where that is the role's job;
- attribution always comes from the authenticated caller, never from a field in the request body;
- reads are scoped as tightly as writes, including diagnostics, receipts and reconciliation views.

Each rule ships with a suite that asserts the refused action changed no state. Those suites live in
`tests/` and run from `regression.sh`.

## The record

Blocks are hash-linked and written to durable storage before in-memory state is updated, so nothing
can be true in the app and missing from the history. A block's transactions are frozen at commit:
the contents can never drift away from the merkle root they were hashed with, in memory or after a
reload.

If a stored chain fails verification on restore, the rail seals itself and serves read-only rather
than extending history it cannot vouch for. The way back is a supervisor-only repair that discards
the unverifiable tail and records, on the chain, every height and hash it dropped and who
authorised it.

## Two API implementations

`frontend/api/index.js` is the serverless handler that production serves. `mock-api-server.js` is an
Express rig used for local payment testing and as a fixture by several suites. **They implement the
same surface and must be patched together** — a fix applied to only one of them is a fix that is
live in exactly one environment.
