# Interface and type safety: what is worth doing, and what is not

A plan, not a change. Nothing here has been implemented. It exists so the
decision is made deliberately rather than halfway through a refactor.

Two questions were asked: should the interface look more like the complex
blockchain products, and should the codebase move to TypeScript. The honest
answers are "partly, and not in the way the phrase suggests" and "yes, but
only the part that pays for itself".

`Landing.jsx` is frozen and its redesign was cancelled. Nothing in this plan
touches it.

## 1. What the good crypto interfaces actually do

The surface reading of Uniswap, Aave, Etherscan or a portfolio dashboard is
"dense, dark, lots of numbers". That is the least important thing about them,
and copying it produces a screen that looks serious and tells you nothing. The
patterns that those products are actually praised for are these:

**Consequence, not state.** `Health factor: 1.4` is protocol state. `Your
position is liquidated if ETH falls 18%` is the same number translated into
what it means for the person reading it. The test is whether you can finish
the sentence "so what". If you cannot, the metric is not ready to ship.

**The transaction is a sequence, not a button.** Submitted, confirming,
confirmed, with an explorer link at the end, and submitted, failed, retry on
the other branch. Blocking the screen and then showing a result is the thing
dApp audits have marked down since 2018.

**Approval is separated from action, and both are named.** A signature that
grants spending permission is a different risk from the payment itself, and
a user who cannot tell them apart cannot consent to either.

**Failure is explained in the user's terms.** Not "transaction reverted" but
which of balance, allowance, slippage or wrong network caused it.

**Fintech tables have their own rules.** One primary figure per screen in the
largest type. Tabular numerals, right aligned, consistent decimals, because
proportional digits make a column of money ragged and slow to compare.
Pending rows visually distinct from settled rows, never silently mixed, since
people reconcile these against statements. Progressive disclosure: summary
row, expandable detail, full audit trail on demand.

**The empty state is onboarding.** A first visit should explain the product,
not show zeros.

### Where AasthiChain already does this

More than a redesign-minded reading would suggest, and this matters because
the gap is narrower than it looks:

- Refusals carry an error code, a reason in plain words, and a block on the
  ledger. That is further than most products go: the refusal is auditable.
- The public token screen now states why a button is disabled and which
  setting is missing, before the click rather than after it.
- Empty states explain the mechanism. The token comparison table says that a
  wallet must be in the on-chain identity registry before it can hold
  anything, which is onboarding disguised as an empty state.
- The drift panel reports disagreement between chain and register instead of
  reconciling it away.
- The boundary sections say plainly what the product does not claim.

### The real gaps

1. **No shared transaction-state component**, in a product whose entire
   subject is state transitions. Each screen renders progress its own way.
   The settlement rail has the richest status model in the codebase and the
   interface flattens it per page.
2. **No design tokens.** All 62 components style inline. Spacing, radius,
   type scale and the status colours are retyped per file, which is why two
   panels that should look identical do not.
3. **Numbers are not typeset as money.** No tabular numerals, inconsistent
   decimals, amounts not consistently right aligned in tables.
4. **Pending and settled rows look the same** in several tables.
5. **One primary figure per screen** is not enforced. Some screens open with
   six equally weighted numbers, which means none of them is the answer.

### Proposed work, in value order

| Step | What | Why it is first or last |
|---|---|---|
| A | `tokens.js`: spacing, radius, type scale, status colours, money formatting, all exported from one place | Every later step depends on it, and it removes the drift that makes the app feel unfinished |
| B | `<Money>` and `<Amount>`: tabular numerals, right aligned, fixed decimals, paise rendered as paise | Highest ratio of perceived quality to effort in any financial interface |
| C | `<TxState>`: one component for the submitted, pending, settled, refused, expired sequence, reading the rail's own statuses, with the explorer or ledger link at the terminal state | The product is a state machine and the interface should show one |
| D | Pending rows styled distinctly in every table; summary row expanding to detail expanding to the ledger block | Reconciliation is what these users do |
| E | One primary figure per screen, with its change and its timestamp | Cheap, and it is what makes a dashboard readable at a glance |
| F | A "so what" pass over every number on `/umi` and the property pages | The highest-value and slowest step, because it is editorial rather than technical |

Explicitly not proposed: a dark trading-desk theme, animated charts, a
connect-wallet-first home page, or anything that makes the product look like
a DEX. AasthiChain is a register of title with a money leg. A screen that
looks like a perpetuals exchange would misrepresent it, and the jury is being
asked to believe the register.

## 2. TypeScript

### The measurement first

| | |
|---|---|
| Frontend | 20,534 lines, 62 `.jsx`, 13 `.js` |
| Type annotations today | zero `propTypes`, zero JSDoc types |
| Serverless handler | one file, about 6,200 lines, plus `api/lib/*.mjs` |
| Test suites | 164, all plain Node, none type aware |

At 20k lines the published guidance is unanimous: incremental with
`allowJs`, never a rename sweep, and never `strict` on day one. The failure
mode is equally well documented, including a team that spent six months and
50,000 lines and reported no measurable drop in bugs.

### The honest case for and against

A renaming migration of 62 components would cost days, break nothing a test
catches, and mostly re-encode prop shapes that already work. That is the part
not worth doing now.

The part worth doing is the boundary. The most expensive defects this project
has actually had were shape mismatches across a boundary, not inside a
component:

- two implementations of the same 82 routes drifting, with four defects
  traced to it (the open D5 finding)
- a rail response consumed with a field that was not always present
- an environment variable read as one shape and written as another

Those are exactly what a type checker at the boundary catches and what
renaming `Button.jsx` to `Button.tsx` does not.

### Proposed path

**Phase 1, half a day, no file renamed.** Add `tsconfig.json` with
`allowJs: true`, `checkJs: false`, `strict: false`, `noEmit: true`. Add
`tsc --noEmit` to CI, where it checks nothing yet. The infrastructure exists
and cannot regress.

**Phase 2, the part with the value.** Write `types/rail.d.ts` describing the
rail's responses and the handler's request and response shapes: one
declaration of what a payment, a wallet, a block, an anchor and a refusal
look like. Turn `checkJs: true` on for `frontend/src/lib/` and
`frontend/api/lib/` only. These are the files where the boundary lives.

**Phase 3, the contract test, which is D5.** With the shapes declared once,
both implementations of the 82 routes can be checked against the same
declaration rather than against each other. That closes an open audit finding
rather than opening a new project.

**Phase 4, opportunistic.** New components in `.tsx`. Existing ones converted
only when they are being edited anyway. No sweep, no deadline, no sprint
dedicated to it.

**Phase 5, only if phases 2 and 3 paid off.** `strict` one flag at a time,
`strictNullChecks` first, since null is what actually bites.

### Recommendation

Do phase 1 and 2 now; they are small, reversible and they aim at a defect
class this repository demonstrably has. Do phase 3 next because it is an open
audit item wearing a different hat. Treat phases 4 and 5 as background work
with no completion date. Do not rename 62 components.

## 3. Sequencing against everything else

The interface work and the type work both compete with the open audit items
and with whatever the next hackathon round asks for. If only one thing gets
done, it should be **A plus B plus C**: tokens, money typesetting, and a
single transaction-state component. That is roughly a day, it is visible in
the first ten seconds of a demo, and usability and clarity in the live demo
is fifteen per cent of the official rubric.

TypeScript is invisible to a jury. It is worth doing for the codebase, not
for the score, and it should be said that way rather than dressed up.
