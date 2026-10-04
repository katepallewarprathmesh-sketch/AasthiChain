import React from 'react'
import ArticleShell, { H2, H3, P, UL, Callout, TryIt } from './ArticleShell'
import { C, card } from '../tools/ToolShell'

export default function AtomicDvP() {
  return (
    <ArticleShell
      slug="what-is-atomic-dvp"
      title="What is atomic DvP settlement?"
      standfirst="Delivery versus payment means the asset and the money change hands together. Atomic DvP means there is no instant in between — and that single property removes an entire category of risk from financial markets."
      readingTime={7}
      faq={FAQ}
      related={RELATED}
    >
      <H2>The problem it solves</H2>
      <P>
        Imagine selling a car to a stranger. You can hand over the keys and hope they pay,
        or they can pay and hope you hand over the keys. Whoever moves first is exposed.
        The usual answer is an escrow agent — a third party both sides trust, who holds
        one side until the other arrives.
      </P>
      <P>
        Financial markets have the same problem at enormous scale, and they call that
        exposure <strong>settlement risk</strong>, or principal risk. The most cited
        example is Bankhaus Herstatt, a German bank shut down by regulators in 1974 in
        the middle of the settlement day. Counterparties had already paid Deutschmarks
        and were waiting on dollars that never came. The risk is still named after it:{' '}
        <em>Herstatt risk</em>.
      </P>

      <H2>What DvP actually means</H2>
      <P>
        Delivery versus payment is a settlement rule: the delivery of the security
        happens if and only if the payment happens. Neither leg completes alone. The
        Bank for International Settlements defines three models, and the difference
        between them matters:
      </P>
      <UL>
        <li><strong>Model 1</strong> — gross, trade by trade, both legs simultaneously.</li>
        <li><strong>Model 2</strong> — securities settle gross and in real time, cash settles net at the end of the cycle.</li>
        <li><strong>Model 3</strong> — both settle net, at the end of the cycle.</li>
      </UL>
      <P>
        Models 2 and 3 are efficient with liquidity, because netting means far less money
        has to move. The cost is time: a gap opens between trade and final settlement,
        and in that gap someone is exposed.
      </P>

      <H2>What "atomic" adds</H2>
      <P>
        Atomic is a term borrowed from databases. An atomic operation either completes
        entirely or has no effect at all — there is no state in which it is half-done.
        Applied to settlement, it means the two legs are not merely coordinated, they are
        the same indivisible event.
      </P>

      <div style={{ ...card, background: C.soft, margin: '22px 0', fontSize: 14.5, lineHeight: 1.8, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', overflowX: 'auto' }}>
        <div style={{ color: C.muted, marginBottom: 8, fontFamily: 'inherit' }}>Conventional settlement — a window exists</div>
        <div>10:00  trade agreed</div>
        <div>10:00  buyer's cash committed</div>
        <div style={{ color: '#B91C1C' }}>     ↕  exposure: one side has paid, nothing received</div>
        <div>T+1    securities delivered</div>
        <div style={{ marginTop: 14, color: C.muted, fontFamily: 'inherit' }}>Atomic DvP — no window</div>
        <div>10:00  trade agreed</div>
        <div style={{ color: C.good }}>10:00  securities AND cash move in one committed block</div>
        <div style={{ color: C.good }}>       (or neither moves, and the instruction is FAILED)</div>
      </div>

      <P>
        The important half is the failure case. If the buyer's wallet is short, or the
        seller no longer holds the units, or the ledger write fails, the correct outcome
        is not a partially settled trade needing someone to unwind it. It is{' '}
        <strong>nothing happened</strong>, plus a record saying why.
      </P>

      <Callout title="Why this is more than an efficiency gain">
        Remove the window and you remove what the window required: margin posted against
        settlement risk, reconciliation between two sets of books, exception queues,
        failed-trade buy-ins, and the capital held against counterparty exposure. The
        settlement rule change is small. The machinery it makes unnecessary is not.
      </Callout>

      <H2>How a settlement engine implements it</H2>
      <P>
        An instruction moves through a short lifecycle, and the ordering is the whole
        design:
      </P>
      <UL>
        <li><strong>CREATED</strong> — the instruction exists with both legs described.</li>
        <li><strong>MATCHED</strong> — both sides agree the terms.</li>
        <li><strong>LOCKED</strong> — the securities <em>and</em> the cash are reserved at the same time. Either reservation failing stops everything here, with nothing moved.</li>
        <li><strong>SETTLED</strong> — both transfers are written in one committed block.</li>
        <li><strong>FAILED</strong> — any reservation or validation failed; locks are released and no balance changed.</li>
      </UL>
      <P>
        The reason to lock both legs before moving either is the same reason a database
        acquires all its locks before committing a transaction. If you move the
        securities and then discover the cash is short, you are already in the state
        atomicity exists to prevent.
      </P>

      <TryIt to="/umi" label="Run an atomic settlement">
        The settlement page runs the full lifecycle against a live ledger, and has a
        failure mode you can trigger deliberately: watch an instruction end FAILED with
        both legs rolled back and the balances unchanged.
      </TryIt>

      <H2>Why central bank money matters here</H2>
      <P>
        Atomic settlement needs both legs on a system that can commit them together. The
        securities leg is straightforward if the asset is recorded on a ledger. The cash
        leg is the hard part: commercial bank money lives in bank systems with their own
        timing and their own credit risk.
      </P>
      <P>
        This is why tokenised settlement projects keep arriving at central bank money.
        Wholesale central bank digital currency — in India, <strong>e₹-W</strong> — is a
        settlement asset that can sit on the same infrastructure as the securities leg
        and carries no credit risk, because it is a direct claim on the central bank. The
        RBI has been piloting wholesale e₹ for government securities settlement since
        November 2022.
      </P>

      <H2>Where this is actually happening</H2>
      <P>
        India's Demat 2.0 pilot, launched in September 2026, issues corporate bonds as
        native digital tokens on a depository-operated ledger and settles them against
        wholesale CBDC through the RBI's Unified Market Interface. Bond and cash move in
        the same instant. REC, L&amp;T and IIFL raised ₹1,025 crore through it in the
        first three days.
      </P>

      <TryIt to="/ledger" label="Inspect the ledger">
        Every settlement here commits a block. The explorer replays the chain from
        genesis and re-verifies the hashes and merkle roots, so you can check the record
        rather than trust it.
      </TryIt>

      <H3>The honest limitations</H3>
      <P>
        Atomic DvP eliminates principal risk — the risk of paying and receiving nothing.
        It does not eliminate <em>replacement cost risk</em>: if your counterparty fails
        before settling, you still have to replace the trade at whatever the price has
        moved to. It also demands pre-funding, because you cannot net across a day if
        every trade settles instantly, which means more liquidity sitting idle. That
        trade-off — liquidity efficiency against settlement risk — is exactly why netted
        models still exist.
      </P>
    </ArticleShell>
  )
}

const FAQ = [
  {
    q: 'What does DvP stand for?',
    a: 'Delivery versus payment. It is a settlement mechanism in which the transfer of securities occurs if, and only if, the corresponding payment occurs, so that neither party is left having delivered without receiving.',
  },
  {
    q: 'What is the difference between DvP and atomic DvP?',
    a: 'DvP is the principle that the two legs are linked. Atomic DvP is the stronger guarantee that they are a single indivisible operation, with no intermediate state in which one leg has completed and the other has not. Conventional DvP can still involve a delay between the legs; atomic settlement removes it.',
  },
  {
    q: 'What is settlement risk?',
    a: 'The risk that one party to a trade delivers its side but does not receive the other. It is also called principal risk or Herstatt risk, after Bankhaus Herstatt, which was closed mid-settlement-day in 1974 leaving counterparties who had already paid Deutschmarks without the dollars they were owed.',
  },
  {
    q: 'Does atomic settlement require a blockchain?',
    a: 'No. Atomicity is a property of the settlement system, not of any particular technology, and conventional central securities depositories have achieved model 1 DvP for years. Shared ledgers make it easier by putting both legs on one system that can commit them in a single operation, which is why tokenisation projects tend to adopt it.',
  },
  {
    q: 'What is the downside of atomic settlement?',
    a: 'It requires pre-funding. If every trade settles instantly and in full, participants cannot net their obligations across the day, so more cash and more securities must be available up front. It also does not remove replacement cost risk — the cost of re-doing a trade at a worse price if a counterparty fails beforehand.',
  },
]

const RELATED = [
  { to: '/learn/what-is-demat-2', label: 'What is Demat 2.0?', note: "SEBI's tokenised bond pilot, and what it changes" },
  { to: '/learn/what-is-umi', label: "What is the RBI's Unified Market Interface?", note: 'the rail carrying the cash leg' },
  { to: '/tools/rental-yield-calculator', label: 'Rental yield calculator', note: 'free, no signup' },
]
