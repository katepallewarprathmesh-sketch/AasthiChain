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
| `agent/policy.py` | every decision, as pure functions of a state snapshot. No I/O, no clock. |
| `agent/runtime.py` | the runtime: observe, check the stop rule, dry-run each intent, act, record. |
| `agent/run.py` | the CLI: `setup`, `once`, `watch`, `stop`, `start`, `log`. |
| `agent/adversary.py` | the adversarial harness: 18 attempts to exceed the mandate. |
| `agent/tests/test_policy.py` | the policy suite, 25 checks, most of them refusals. |
| `.agent/` | local state: config, an append-only JSONL run log, the stop file. Not tracked. |

## Why Python, and why nothing else

Python because this is an agent harness, and that is what agent harnesses are
written in: the people who will read it, extend it or point a model at it work
in that language, and picking the language the rest of the repository happens
to use would be choosing the author's convenience over the reader's.

The rail is Go because it holds money. The site is JavaScript because it runs
in a browser. Neither of those facts says anything about what an agent should
be written in.

The standard library and nothing else, on purpose. `urllib` makes the handful
of calls this needs and `unittest` runs the tests, so there is no lockfile, no
virtualenv and no package index between a reader and a running agent. A harness
with install instructions is a harness that does not get run.

The split is the point. The interesting question about an autonomous agent is never whether it can
make a request, it is what it would decide and whether that decision can be checked without letting
it loose on a live rail. So the judgements are pure and `agent/tests/test_policy.py` feeds them
hand-built states, including every state they must refuse to act on.

Those tests run inside the one gate the repository has. `tests/agentharness.test.mjs` is a thin
adapter that shells out to `unittest`, because `make test-fresh` walks `tests/*.test.mjs` and a
suite that only runs when somebody remembers a second command is a suite that rots. The adapter
asserts nothing about behaviour itself; if it ever did, the behaviour would have two sources of
truth and they would drift.

```
python3 agent/run.py setup --principal investor1 --limit 5000
python3 agent/run.py once
python3 agent/run.py watch --every 15
python3 agent/run.py stop
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

The port to Python added a fourth, which is the language's rather than the rail's: the rail answers
RFC3339 with a trailing `Z`, and `datetime.fromisoformat` rejected that before Python 3.11. A direct
transliteration would have raised on every pass on an older interpreter. Timestamps are now parsed
through one helper that returns nothing rather than throwing, because a date the agent cannot read
is a reason to be careful and never a reason to fall over.

A fourth thing was not a defect but a missing rule: an agent's own pseudonym is never a buyer, a
seller or an asserter, so `GET /umi/conditions` returned it an empty book and the delegation was
useless. Presenting a valid mandate now widens what an agent may see to exactly what its principal
may see, and no further. Without that, an operator feeds the agent condition ids out of band or,
worse, hands it a supervisor identity.

## The other two harnesses

One harness is not enough, because the caretaker is well behaved. It checks its own limits before
acting, which makes it good evidence that the happy path works and almost no evidence for the claim
the rail actually makes: that the rail enforces the bounds rather than the agent choosing to honour
them. A well-behaved agent cannot tell a real control from a politely observed convention.

### The adversary, `agent/adversary.py`

Python and HTTP, for the same reason the caretaker is: the claim is about an outsider, and an
in-process test can reach fields no caller can reach. This one holds nothing but an identity header,
a mandate id and a socket.

Eighteen attacks, each an attempt to move money the mandate does not cover: a single act over the
ceiling, the ceiling in slices, the ceiling all at once, one condition presented by eight callers
simultaneously, a replay of what already worked, an asset outside the allowlist, an action never
granted, no mandate at all, somebody else's mandate, an invented mandate, an agent granting itself
authority, an invented credential, reading a stranger's book and a stranger's wallet, and carrying
on after being revoked.

It reports `held` or `BREACHED` per attack and exits non-zero if anything got through.

It also states what it cannot test. The rail trusts the `X-Fabric-Identity` header because
authentication happens at the proxy in front of it, so anything that can reach the rail directly can
claim any identity. That is a real property of the deployment, the control for it is network
placement rather than the mandate layer, and a harness that quietly omitted it would be claiming
more than it had earned.

### The concurrency harness, `drunix-gateway/agentconcurrency_test.go`

Go and in-process, and this is where "chosen per need" earns itself. The question here is not
whether an outsider gets special treatment, it is whether the rail's own accounting survives
simultaneous callers. HTTP is the wrong instrument for that twice over: a data race is invisible
through a socket, and network jitter hides exactly the interleavings that break things. These run
in-process so `go test -race` can see the memory.

Five conservation laws: a condition settles exactly once however many agents present it at the same
moment, a ceiling bounds the total rather than each request, separate agents keep separate budgets,
a revocation is a fact rather than a race, and cash and tokens are conserved whatever the
interleaving.

```
go test -tags real -race -run Concurrent ./...
```

## What the other two harnesses found

The adversary found nothing, which is the result it should usually produce. The concurrency harness
found three defects on its first run, all of them money.

**A condition settled five times.** `Present` read `status == OPEN`, released the lock, did all its
work, and only wrote `RELEASED` at the very end. Twenty-four callers all passed the gate and the
seller was paid five times out of a buyer who had locked the cash once. A condition is now claimed
under the lock that checks it, with an unexported in-flight marker: unexported because it is a
detail of one process and not a state of the agreement, so it must never appear on the wire or in
the ledger.

**A ceiling of Rs 5,000 was spent three times over.** `Authorise` compared `SpentPaise` against the
limit under a read lock and returned; `Consume` added the spend later under a write lock. Nothing
held a lock across the pair, so every concurrent caller read the same unchanged figure and every one
was told there was room. The limit bounded each request and did not bound the total, which is not
what a limit is. There is now `Reserve`, which takes the money at the moment permission is given and
returns a finaliser that either records the use or hands the headroom back. Charging first and
refunding on failure is the only ordering that cannot overspend.

**A data race, and a decision made against stale state.** The deadline check read the live record
outside the lock rather than the snapshot it had just claimed.

All three were in code that had shipped, been reviewed and been covered by tests. None of the
existing tests called anything twice at once.

## What it is not

- It is not running in any deployment. The screen at `/agents` shows whether one is, from the spend
  recorded against each grant rather than from a sentence.
- The run log is the agent marking its own homework. `/agents` deliberately reads the register and
  the mandate book instead: a compromised agent writes a flattering log, and it cannot edit the
  rail. If the two disagree, the rail is right and the agent is the story.
- Stopping an agent stops it acting. It reverses nothing it already did, and nothing here can.
