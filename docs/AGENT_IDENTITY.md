# Agent identity: accountable pseudonymity

Design note for the agent passport layer. Written 20 Oct 2026, grounded in the 2026 agent-identity
work rather than invented. Read this before the code in the rail.

## The problem

The mandate layer already answers "what is this agent allowed to do, on whose behalf, under what
limit, until when". That is the authority half, and it is the half most of the industry is still
missing: the EU wallet framework verifies the principal to the hilt and says almost nothing about a
piece of software presenting a bounded grant of someone else's authority.

What it does not answer is the accountability half. Today a mandate names its principal in the
clear on a public ledger. That is one of three architectures a jurisdiction can pick:

1. **User-sovereign.** The principal holds credentials and discloses selectively. Strong against
   overreach, but accountability depends on the principal cooperating, and per-transaction consent
   does not scale to software making thousands of decisions.
2. **State-escrow.** Identity withheld from commercial counterparties and held by government,
   released by legal process. Accountability does not depend on cooperation, at the cost of
   concentrating a re-identification capability in one place.
3. **Cryptographic threshold.** Opening the pseudonym requires several independent parties to
   cooperate, enforced mathematically rather than institutionally. Best abuse resistance, hardest
   to operate.

Naming the principal in the clear is none of these. It is the counterparty-sees-everything default,
which is the one option nobody is arguing for.

## What is built here

The third architecture, with the trigger and the record borrowed from the second.

- An agent acts under a **pseudonym**: `agent:aasthi:<hash>`. Counterparties see the pseudonym, the
  agent's stated purpose, and the fact that a liable principal stands behind it. They do not see
  who.
- The principal is **split across named custodians** with Shamir's secret sharing over GF(256). Any
  `k` of `n` custodians can reconstruct it; `k - 1` learn nothing at all, which is a property of
  the scheme rather than a promise of good behaviour.
- Opening the pseudonym is a **governed event, not a lookup**. Somebody opens a request with a
  stated trigger, custodians contribute shares one at a time, and the identity is reconstructed
  only when the threshold is reached.
- **Every step is a block**: the request, each approval, and the reveal itself. A principal can
  never be un-masked quietly, and the record of who asked, who agreed and why outlives the people
  involved. A request that nobody completes expires and stays on the chain as an unanswered ask.
- The passport binds to the agent's **purpose and version label** and to its mandate, so the
  question "which exact software acted" has an answer separate from "who answers for it".

## What it is not

- **The custody is simulated.** All shares live in one process on one host. The protocol is real
  (the arithmetic genuinely requires `k` shares) but the distribution is not: a host operator has
  every share. Real deployment means one share per organisation, held by that organisation. The
  API says this in the response rather than in a footnote.
- **It is not anonymity.** The pseudonym is re-identifiable by design, so under the data-protection
  reading that applies here it remains personal data and must be treated as such. The claim is
  accountable pseudonymity, nothing stronger.
- **No zero-knowledge proof of principal attributes.** The sponsorship fact is asserted by the rail
  from its own participant register, not proved to a third party cryptographically.
- **It does not make the agent legal.** Which legal person answers for an agent is a question of
  law. This records an answer and makes it recoverable; it does not create one.

## Rules

- Only the principal registers an agent, and a participant may not register itself as its own
  agent.
- Custodians must be distinct, at least two, and the threshold must be at least two and no greater
  than the number of custodians. A threshold of one is refused: that is the state-escrow model with
  the safeguards removed.
- Only a named custodian may contribute a share, and only once per request.
- A revoked passport still reveals. Revocation stops the agent acting; it does not erase who was
  accountable for what it already did.
- The reveal returns the principal to the requester and writes the principal into the block. An
  opened identity is opened in public, because a quiet reveal is a worse failure than no reveal.

## Surface

Rail routes, all additive, under the existing identity headers:

| Route | Who | What |
|---|---|---|
| `GET /umi/agents` | anyone | pseudonyms, purpose, custodian set, threshold, state |
| `POST /umi/agents` | the principal | register an agent, seal the principal, get the pseudonym |
| `GET /umi/agents/{id}` | anyone | one passport, plus any open or completed reveal |
| `POST /umi/agents/{id}/revoke` | principal or supervisor | stop the agent acting |
| `POST /umi/agents/{id}/reveal` | supervisor or a custodian | open a request with a stated trigger |
| `POST /umi/agents/{id}/reveal/approve` | a named custodian | contribute one share |

Blocks: `AGENT_REGISTERED`, `AGENT_REVOKED`, `AGENT_REVEAL_REQUESTED`, `AGENT_REVEAL_APPROVED`,
`AGENT_REVEALED`, `AGENT_REVEAL_EXPIRED`.

## Why this matters beyond the demo

Cross-border recognition is the stated endgame for agent identity, and it will favour whoever built
to an open, inspectable pattern. The pattern here is deliberately boring: a pseudonym, a bounded
mandate, a threshold escrow, and an append-only record of every time the escrow was opened. None of
it is novel cryptography. The novelty, such as it is, is that all four are in one rail and every
one of them is checkable by somebody who does not trust the operator.
