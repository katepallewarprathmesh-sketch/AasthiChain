# Governance

Consortium infrastructure succeeds or fails on governance, not cryptography. A permissioned
settlement network validated by a handful of large institutions is not a public blockchain,
whatever the token looks like, and the questions that decide whether it works are the same
ones the card networks and the depositories spent decades on.

This project is a simulation, so it cannot answer those questions for a real network. What
it can do is state them, say what the code currently assumes, and be honest about which
assumptions would not survive contact with a real consortium. Nothing below describes an
agreement with any organisation.

## Who may do what, as the code actually stands

| Role | May do | Enforced where |
| --- | --- | --- |
| Originator | create a listing, mint tokens for a validated listing, sell | rail authorisation and chaincode endorsement policy |
| Registrar | validate a listing, attest a title, withdraw an attestation | rail authorisation |
| Investor | buy, hold, receive servicing income, delegate bounded authority to an agent | rail authorisation |
| Regulator | supervisory reads, mint, restate supply, see every blotter | rail authorisation |
| Agent | only what a mandate grants it, and only for its principal | the mandate layer, on the settlement path |

Minting is open to the originator and the regulator as well as the owner. That is a demo
decision, taken so an investor identity holding a listing is not stuck, and it is disclosed
on the trust page rather than buried here. `DEMO_ROLE_SWITCH=false` closes the role switcher
that makes the widening reachable.

## The five questions

**Who is eligible to join, and what is the process.** In the code: nobody joins. The
identity set is fixed at five demo participants plus whatever agents a principal delegates
to. There is no onboarding path, no membership committee and no application. A real
deployment needs all three, and the absence is the honest answer rather than an oversight to
be papered over.

**Who sets fees, and can they change.** There are no fees anywhere in this system. No
transaction charges a participant, and the settlement asset is simulated wholesale CBDC in
integer paise. Any figure a demo shows is a price between two parties, never a network fee.

**What happens when a validator's commercial interest conflicts with the network's.** The
sharpest version here is the attestor: the party that vouches for an asset is usually
connected to the party that benefits from it trading. The code does not resolve the conflict.
What it does is make the attestor's record public, countable and tied to outcomes: who
vouched, how often they withdrew, and who was holding when they did. See
the attestation layer.

**What does exit look like.** A participant cannot leave. There is no offboarding,
no settlement of open positions on exit, and no rule about what happens to attestations
signed by a departed attestor. Today a withdrawn attestation leaves its signature valid and
its exposure recorded; a departing attestor would need the same treatment and does not have
it.

**How are smaller participants represented.** Not at all. There is one supervisory role and
it can see and do everything. A real consortium has to answer whether the smallest member
has a vote, a veto or only a complaint, and this code takes no position.

## What the ledger guarantees, and what it does not

Guaranteed by the code and covered by tests: append-only with detectable tampering, atomic
delivery versus payment in a single block, idempotent settlement, supply conservation,
authority bounded and counted for delegated agents, and signed attestations whose anchor can
be checked independently of this service.

Not guaranteed, and not claimed: legal finality, enforceable accountability for an attestor,
any connection to RBI, SEBI, a depository or a bank, or recovery for a holder who relied on
an attestation that turned out to be wrong. The last one is a governance problem, not a
ledger problem, and it is the one worth arguing about.
