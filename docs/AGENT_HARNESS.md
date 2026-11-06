# The agent harness

A real process that holds a passport, takes a mandate from a named principal, and acts on the rail
over the ordinary HTTP surface. It lives in `agent/` and nothing starts it automatically.

The rail already had the authority half of delegated action: mandates with named actions, a rupee
ceiling and an expiry, re-checked on every act. What it did not have was anything that exercised
them. Bounds nobody has pushed against are a design, not a control, so this exists mostly to be the
thing that pushes.

## What it does

A conditional settlement is money locked against a named credential. It sits locked until somebody
presents that credential, and nobody is watching for the moment one becomes presentable, so cash
stays reserved after the condition it was waiting on has already been satisfied and eventually
expires back to the payer for no better reason than inattention. The agent watches for that and
presents.

A dull job is the right first job for an automated actor. The failure mode of a clever agent is
that nobody can say what it will do; the failure mode of this one is that a release happens a few
seconds earlier than a person would have managed.

## Shape

| File | What |
|---|---|
| `agent/policy.mjs` | every decision, as pure functions of a state snapshot. No I/O, no clock. |
| `agent/agent.mjs` | the runtime: observe, check the stop rule, dry-run each intent, act, record. |
| `agent/run.mjs` | the CLI: `setup`, `once`, `watch`, `stop`, `start`, `log`. |
| `.agent/` | local state: config, an append-only JSONL run log, the stop file. Not tracked. |

The split is the point. The interesting question about an autonomous agent is never whether it can
make a request, it is what it would decide and whether that decision can be checked without letting
it loose on a live rail. So the judgements are pure and `tests/agentharness.test.mjs` feeds them
hand-built states, including every state they must refuse to act on.

```
node agent/run.mjs setup --principal investor1 --limit 5000
node agent/run.mjs once
node agent/run.mjs watch --every 15
node agent/run.mjs stop
```

## How it is bounded

Four independent things stop it, and any one is sufficient:

1. the passport is revoked, which the principal can now do themselves,
2. the mandate is revoked, expired, or out of headroom,
3. the local stop file, so an unreachable rail is never the reason an operator cannot halt it,
4. an open identification request, where the runtime is deliberately stricter than the rail: while
   somebody is formally trying to establish who is behind this pseudonym, it pauses.

The stop rule is checked before every act rather than once at startup. A runtime that checks its
authority once and then trusts its own memory of it is precisely the thing a revocation needs to
defeat.

Before acting, every intent is dry-run through `POST /umi/mandates/{id}/check`, which consumes
nothing. The local bounds in `policy.mjs` are a courtesy that saves spending an operator's attention
on requests already known to be refused. The rail's answer is the one that counts. An agent that
decides it is allowed is not operating under a mandate, it is operating under a habit.

## What running it found

Three defects, none of which reading the code had surfaced.

**The kill switch was wired to a name nothing used.** `MandateRegistry.Authorise` checks standing
against the name written on the mandate. The first version granted the mandate to a readable agent
name while the passport lived under its generated pseudonym, so `Standing` reported the agent as
unregistered, the withdrawal branch never fired, and revoking the passport stopped nothing. The
passport's own `mandateId` field actively invites that ordering. The agent now refuses to start when
the two names disagree, rather than running unstoppably.

**A revoked agent kept running.** The register publishes a status string, not a boolean. The runtime
read `passport.revoked`, got `undefined`, and carried on. Found by revoking a real passport and
watching the next pass act anyway.

**A refusal named the wrong reason.** See the section of the same name in
[`docs/AGENT_IDENTITY.md`](AGENT_IDENTITY.md).

A fourth thing was not a defect but a missing rule: an agent's own pseudonym is never a buyer, a
seller or an asserter, so `GET /umi/conditions` returned it an empty book and the delegation was
useless. Presenting a valid mandate now widens what an agent may see to exactly what its principal
may see, and no further. Without that, an operator feeds the agent condition ids out of band or,
worse, hands it a supervisor identity.

## What it is not

- It is not running in any deployment. The screen at `/agents` shows whether one is, from the spend
  recorded against each grant rather than from a sentence.
- The run log is the agent marking its own homework. `/agents` deliberately reads the register and
  the mandate book instead: a compromised agent writes a flattering log, and it cannot edit the
  rail. If the two disagree, the rail is right and the agent is the story.
- Stopping an agent stops it acting. It reverses nothing it already did, and nothing here can.
