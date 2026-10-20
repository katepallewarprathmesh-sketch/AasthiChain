# Aasthi AI: from assistant to agent

Status: design note, not shipped. Written 20 Oct 2026 from current external research plus what
this repository already has. Nothing here claims a capability that exists today.

## The question

Can Aasthi AI become an agent, or a "perfect model" for real estate?

Short answer: an agent, yes, and this repository is unusually well placed to build one. A perfect
model, no, and chasing one is the wrong spend. The two paths are different projects and only one
of them pays off here.

## Why not a model

The evidence against training or fine-tuning a real estate model as the headline feature:

- REAL (arXiv 2507.03477), the only serious benchmark for housing transactions and services, built
  from 5,316 expert-checked entries: the best public model averages about 50 percent on its
  multiple-choice topics, and every model tested scores below 50 percent on reasoning. When a query
  contains a fictional place name, hallucination runs 61 to 93 percent, against under 6 percent
  when the entity is real. A model asked about a property that does not exist invents it.
- Where LLMs do measurably help valuation, they help as a feature extractor, not as the valuer. On
  9,842 Oslo transactions, LLM-extracted features fed into XGBoost cut valuation RMSE from 10.53 to
  7.97 percent. The gradient-boosted model stayed the model. Separate work finds LLMs systematically
  overconfident on price intervals and weak on spatial and temporal reasoning.
- Retrieval beats training for this class of problem. Reported reductions in hallucination from
  grounding a model in retrieved source documents run 70 to 90 percent, and the 2026 enterprise
  default is retrieval first, prompting second, fine-tuning only for format or style.

So: no fine-tune, no in-house valuation model, no "Aasthi AI estimates this flat is worth X". What
is worth building is the retrieval and tool layer underneath, because that is where the accuracy
actually comes from.

## Why an agent, and why here

The repeated finding across 2026 industry reporting is that agentic real estate fails on data, not
on intelligence. McKinsey's framing is the "factual layer": property, unit, lease and vendor records
that the agent treats as ground truth, which in practice live in spreadsheets, undigitised PDFs and
systems that do not talk to each other. When that layer is wrong, an agent does not make a small
mistake, it executes a confident wrong action at speed. A second thread says the missing piece is
infrastructure rather than models: listing systems do not expose permissioned, machine-callable
interfaces, so an agent has nowhere safe to act.

AasthiChain already is that missing layer, for its own scope:

| What an agent needs | What the rail already has |
|---|---|
| A factual layer that cannot be quietly edited | An append-only chain, replayable and restart-durable |
| Evidence that a claim was made by somebody accountable | Signed credentials, attestation accountability, and now proof of backing |
| Bounded authority to act | Agent mandates: named actions, expiry, spend counted on the ledger |
| A way to pay only on a verified result | The outcome layer: acceptance criteria, escrow, verification, dispute window |
| An audit trail of what the agent did | Every consequential action commits a block |

That combination is exactly what the external agent-payment work is converging on: a signed,
scoped authorisation from a human (Google's AP2 mandates, now with the FIDO Alliance) sitting above
whatever rail moves the money, with a hard rule that irreversible actions pause for a person. The
mandate layer here predates that reading and matches its shape. The gap is not authority, it is
that nothing currently drives it except a human clicking.

## What Aasthi AI is today

A read-only assistant. It is given public listing data, never session or holder data, it computes
every number in deterministic code and asks the model only to phrase it, it makes no tool calls and
has no write path, and it is off entirely when no key is configured. That is the correct starting
point and none of it should be relaxed.

Its limitation is also exact: it cannot answer "which of these assets is actually backed", "what
happened in settlement 4f2a", or "show me every attestation this registrar withdrew", because it
cannot look anything up. It only knows what was stuffed into its prompt.

## The design: a proposing agent, not an acting one

Three tiers, with the boundary between them enforced in code rather than in the prompt.

**Tier 1, grounded reads.** Give the assistant a small set of read-only tools over the rail: asset
and coverage lookup, ledger search, settlement status, attestation history, credential
verification, portfolio summary for the caller's own identity. Every tool is scoped by the caller's
identity header, so the agent can never read more than the person asking could read. Answers cite
the block or the record they came from, and the agent is required to say "not in the record"
rather than guess. This is the entire accuracy story, and it is most of the value.

**Tier 2, proposals.** The agent may draft an action but never perform it: a settlement
instruction, a work order with acceptance criteria, a backing refresh reminder, a reconciliation
query. It returns a signed-off-by-nobody proposal object that the UI renders with its arguments
visible, and a person approves it. The MCP specification's own guidance is the rule to copy here:
reads can run freely, anything irreversible, money-moving, permission-changing or outbound pauses
for a human who can see the exact arguments before dispatch.

**Tier 3, mandated execution.** Only once Tier 2 is boring. An approved proposal executes under an
existing agent mandate: named action, expiry, spend ceiling, every use counted on the ledger. No
new authority mechanism is needed, which is the point of having built the mandate layer first. An
agent without a valid mandate gets the same refusal any other caller gets.

A useful property of staging it this way: Tier 1 is independently valuable, and if Tier 2 never
ships, nothing is half-built.

## Honest scope: what it must refuse

- No price estimates, no yield projections, no "good investment" judgements. The platform does not
  publish an AVM and the agent must not become one by accident.
- No statements about people or neighbourhoods. Describe the property, never the likely buyer.
- No claim that an attestation is true. The rail checks arithmetic, not reality, and the agent
  inherits that limit word for word.
- No reading of another participant's holdings, KYC, payment details or private collection values,
  enforced by the identity header rather than by instruction.
- No invented record. If a lookup returns nothing, the answer is that nothing was found.

## India-specific constraints that shape the build

- A listing card is an advertisement under RERA section 11(2), so any text the agent generates
  about a project has to carry the registration number and must not state possession dates, carpet
  area or amenities that differ from the filing. Practically: generated copy is drafted, never
  published, and anything factual comes from the record rather than the model.
- The DPDP Act treats a chatbot operator as a data fiduciary. Rules were notified 13 Nov 2025,
  consent-manager obligations land 13 Nov 2026, the substantive duties 13 May 2027. What that means
  for this build: notice before the conversation, itemised description of what is processed, a
  retention and deletion path for transcripts and any embeddings, masked logs, and a named
  processor relationship with whatever model provider is called. The two highest-risk gaps named in
  the field guidance are prompt injection and unmasked personal data sent to the provider.
- Prompt injection deserves its own line. The moment the agent reads attacker-influenced text, a
  listing description or an uploaded document, that text can try to steer a tool call. Tier 1 and
  the identity scoping contain the blast radius, which is a further argument for not giving the
  model write tools.

## Evaluation, because "it felt good" is not a result

Before any of this is called working, a fixed question set with known answers drawn from the seeded
demo data, run as a suite like everything else here:

- grounded answer rate: every factual claim traceable to a record the tools returned
- abstention: does it say "not in the record" when the record is empty, measured with deliberately
  fictional asset ids, which is the REAL benchmark's exact failure mode
- scope: zero leakage of another identity's data across the whole set
- refusal: valuation, advice and demographic prompts refused
- proposal correctness: generated instructions validate against the rail's own schema

A number from that suite is publishable. A demo transcript is not.

## Order of work

1. Tool layer plus identity scoping, read-only, with the evaluation suite written alongside it.
2. Citations in the UI: each answer shows the blocks and records behind it.
3. Proposals with human approval, arguments visible, nothing dispatched without a click.
4. An MCP server exposing the same read tools, so external agents can use the rail as the factual
   layer. This is the piece the rest of the industry is missing and the cheapest differentiator
   available here.
5. Mandated execution, only after 3 and 4 have been boring for a while.

## What this is not

Not a deal-sourcing pipeline, not lead generation, not voice, not a CRM assistant. Those are real
products and other people are building them. The thing only this repository can offer is an
assistant whose every answer is backed by a record that a third party can verify independently.
