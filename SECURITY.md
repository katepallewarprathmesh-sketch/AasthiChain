# Security policy

AasthiChain moves tokens against money. Even as a demonstration, a flaw in that path is worth
reporting carefully, and this file is here so you do not have to report it in public.

## Reporting a vulnerability

**Use [GitHub's private vulnerability reporting](https://github.com/katepallewarprathmesh-sketch/AasthiChain/security/advisories/new)**,
the Security tab of this repository. It is private between you and the maintainer.

Please do **not** open a public issue for anything that lets someone move a token, spend money twice,
read another person's holdings, or write to the ledger without authorisation.

A useful report says what you did, what happened, and what you expected instead. A request and its
response, or a failing test, is worth more than a description. You do not need a proof-of-concept
exploit; a clear explanation of the hole is enough.

Expect an acknowledgement within a few days. This is a single-maintainer project, not a funded
security programme: there is no bounty, and the honest answer on timelines is "as fast as one person
can". You will be credited in the fix unless you would rather not be.

## Scope

**In scope**, the parts that are real:

- authorisation: anything that lets a caller read or change what they are not entitled to
- settlement: double-spends, half-settled states, a failed leg that still moved money, retry replay
- supply: minting beyond authorised supply, or a conservation check that can be made to pass falsely
- the ledger: writing history that does not verify, or altering history that already does
- the supervisory halt, and the repair path that can lift it
- authentication: forging a session, escalating to Registrar/Regulator, or acting as another identity
- the payment leg: signature or callback-hash handling in `frontend/api/index.js` and
  `mock-api-server.js`
- secret handling and anything that leaks credentials or holder identity

**Out of scope**, the parts that are openly simulated, and documented as such in the
[README](README.md):

- the UMI/ASI rail is **not** connected to RBI, NPCI or any depository, and the e₹-W wallets are not
  real central bank money. "The CBDC is fake" is the design, not a finding.
- government-issued KYC, the land-record lookup, and the public-chain escrow experiment are
  simulated surfaces.
- demo identities and `DEMO_AUTH` are a demonstration affordance. That `investor1` logs in without a
  password is intended; that `investor1` can reach `investor2`'s wallet would not be.
- no real money moves anywhere in this repository.

Findings in a dependency are welcome, but please check whether it is reachable from our code first.

## Known weaknesses

Kept here deliberately, so nobody spends time rediscovering them:

- **`UMI_PROXY_SECRET` is unset in the live deployment.** Until it is set on *both* the app and the
  rail, the rail believes the identity headers it is sent, so a caller who can reach the rail
  directly can claim to be a regulator. The gate is implemented and tested; it is simply not
  switched on yet. See the deployment notes.
- **The demo deployment is seeded and public.** Treat every figure on the live site as demonstration
  data.
- Two legacy assets carry a small supply discrepancy against their register, recorded on the chain
  rather than quietly corrected.

## Supported versions

`main` only. There are no releases or maintenance branches; fixes land on `main` and deploy from
there.
