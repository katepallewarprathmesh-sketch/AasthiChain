# Five-minute demo walkthrough

Written for a judging table: what to click, what to say, and (the part that matters most)
**what not to claim**. Every number below was read off the live deployment, not the design doc.

Live app: `https://aasthi-chain.vercel.app` · settlement core: `https://aasthichain.onrender.com`

---

## Before you start

Two minutes of housekeeping that will save you a bad question:

- **Sign in first.** The settlement rail acts on named participants; signed out, the wallet and
  instruction panels refuse you by design, and that looks like a bug if it happens on stage.
- **Open `/umi` once** so the chunk is warm. First paint after a cold Render start can take a few
  seconds while the core wakes.
- **Know your current numbers** (check them again before you walk in, they move):
  17 e₹-W wallets · ₹2,32,09,509 funded and conserved · 29 settled and 114 failed instructions ·
  6 pilot ISINs · ledger height 238, verifying.
- **The failed instructions are not a blemish, so do not hide them.** Most are probe traffic from
  testing the refusal paths. If a judge spots the ratio, the answer is that a rail which never
  records a failure is a rail that is hiding them, and you can open one and show the rollback.

---

## The five minutes

### 1 · Open on the problem, not the tech (30s)

> "A flat in Pune costs sixty lakh. Fractional ownership solves that, but the moment you split a
> property into tokens, you need somewhere the ownership and the money move together. That's the
> part everyone skips."

Don't open with blockchain. Open with the settlement problem; the ledger is the answer to it.

### 2 · Marketplace → one property (45s)

Show a listing. Point at **Green Valley Villas, Pune: ₹75,00,000 across 15,000 tokens, so ₹500 a
token.** Say that number out loud; it's the one a judge will divide to check you.

Then: *"Every holding you see is a position on a ledger, and the register and the ledger agree.
I'll prove that in a second."*

### 3 · The settlement interface (90s, the centrepiece)

Go to **/umi**, the **Aasthi Settlement Interface**.

> "This is our settlement rail. It's built to the pattern RBI set out for the Unified Market
> Interface under SEBI's Demat 2.0: a securities leg and a wholesale-CBDC cash leg that settle as
> one. It is our implementation of that pattern. It is not a line into the real UMI, and the page
> says so."

Say that sentence more or less verbatim. Volunteering the limitation is what makes the rest
credible, and the page carries a SIMULATION badge anyway, and it is far better that you mention it first.

Then run one atomic DvP:

- Pick a seller, a buyer, a few tokens.
- **Point at the dry run** before you commit: the rail tells you whether it would settle without
  moving anything. *"We don't let people click into a red error to find out."*
- Settle. Read the result: tokens moved, cash moved, **one block**.

> "Both legs or neither. There is no state where the buyer has the tokens and the seller doesn't
> have the money."

### 4 · Make it prove itself (60s, the part that wins arguments)

Scroll to **Reconciliation** and read the two lines out:

- **Σ wallet balances == lifetime funding.** The rail cannot create or destroy central-bank money.
  Currently ₹2,32,09,509 funded, conserved: true.
- **No asset has more tokens outstanding than were issued**, and the full hash chain replays valid
  at height 210.

> "It isn't that we tested this once. The rail re-derives it on every request, and if it were ever
> false this page would say so instead of hiding it."

If someone asks for the audit trail, open an instruction and show the **ISO 20022 message families**:
`sese.023 → sese.024 → pacs.009 → sese.025 → camt.054`. The trail a depository would recognise.

### 4b · The two checks on a listing itself (45s, optional but strong)

Open a property and point at the line under the address:

> "When this was listed, the pincode was checked against the national postal directory, live. It
> confirms the address exists and where it is. It is not proof of ownership, and the page does not
> pretend otherwise: if the directory is unreachable the listing says the address was not checked
> rather than showing a tick it did not earn."

Then the deed check:

> "Hash your own copy of the deed in your browser and compare it with the ledger. Only the digest
> leaves your machine. A changed file is refused in those words."

The point to land: *"This is the only boundary in the system that is genuinely live, and it is
labelled as such on the trust page. Everything else is labelled simulation. We would rather have
one honest live check than fourteen claimed ones."*

### 5 · Work orders: paying for upkeep on delivery (60s)

Scroll to **section 8** on the same page.

> "A tokenised building still has to be inspected, repaired and revalued. That cost normally sits
> off-ledger on an invoice nobody can audit. So we applied the same discipline to it: the fee is
> reserved on the owner's wallet when the order is funded, and it only moves to the worker in the
> same step that anchors the deliverable's hash to the chain."

The line to land:

> "That's the premise gig-work platforms are built on, pay follows task completion, implemented
> against our rail. The talent boundary is an adapter and it is marked `simulation`: we integrate
> with nobody today, and the code says so on every payload rather than in a footnote."

Open an order, fund it, show the available balance drop while the *balance* stays the same.
*"Reserved money can't be spent on a settlement either; the DvP engine already reads availability,
so we didn't have to teach it anything new."*

### 6 · Close on verifiability (15s)

> "Everything you just saw is in one public repository: the settlement core in Go, 79 integration
> suites and 39 Go test files, green in CI on every commit. You can clone it and re-run the
> conservation proof yourself."

---

## Questions you will get

**"Is this connected to the real UMI?"**
No. UMI is a regulated rail reachable only through a bank partner or the SEBI sandbox. This
implements the published pattern end to end and says `simulation` on every response. *Answer this
one fast and without hedging; hesitation here costs more than the limitation does.*

**"Is anything here actually connected to the outside world?"**
One thing: the postal directory the address check calls, and the payment provider's test
environment. The trust page counts them, names them and marks everything else as simulation. Give
the small true number rather than a large vague one.

**"Is the money real?"**
No. The cash leg is simulated wholesale CBDC in integer paise. The UPI leg runs against a payment
provider's **test** environment, with signed requests and callbacks the provider validates, not
ones we grade ourselves.

**"What stops a double-spend?"**
Both legs move under one lock, and the ledger is append-only and hash-linked. A failed settlement
writes a failure block rather than vanishing.

**"Why Go for the core and JavaScript for the app?"**
Every rule about money lives in one process next to the ledger it protects. The web layer forwards
and decides nothing, so there's exactly one place to audit.

**"What's the hardest bug you fixed?"**
Good answer, and true: the cap table on one asset had drifted to seven times its issued supply, and
nothing flagged it because the supply ceiling was *derived from the book it was supposed to
constrain*. A limit computed from the thing it limits can never be breached. We pinned the declared
figure, removed the phantom supply as a recorded block, and no real holder lost a token.

**"What would you not ship to production?"**
The demo seeding and the simulation adapters. Also worth naming: the settlement core trusts the web
app's identity headers, which is only safe behind a shared secret, so we added one.

---

## Do not say

- "RBI-approved", "NPCI-integrated", "regulator-certified". None are true.
- "Blockchain" as the headline. Lead with settlement; the ledger is how, not what.
- Any live figure you haven't re-checked that morning. The numbers above move.

## Known blemishes to fix before judging

- A test listing titled **"Mint Scope Probe"** (0 tokens, no address) is still publicly visible in
  the marketplace. It is validated, so the draft filter admits it, which is the right rule applied
  to junk data. Remove it from the regulator or admin view; withdrawal now sticks, so one press is
  enough. It is the first thing a judge clicks.
- Three listings carry a city and a pincode that do not go together, **Lonavala and Panvel at
  411045**, which is Pune. The address check flags these the moment the listing is opened, so
  either fix the data or be ready to say, truthfully, that the check caught our own seed data.
- `identityTrust` reads **`open`** until `UMI_PROXY_SECRET` is set on both hosts. Nobody will check
  this at a demo table, but "we found and closed it" is a far better story than "it's still open".
