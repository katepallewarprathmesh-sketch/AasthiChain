import React from 'react'
import ArticleShell, { H2, H3, P, UL, Callout, TryIt } from './ArticleShell'
import { C, card } from '../tools/ToolShell'

export default function UMI() {
  return (
    <ArticleShell
      slug="what-is-umi"
      title="What is the RBI's Unified Market Interface (UMI)?"
      standfirst="UPI made payments between people interoperable. UMI aims to do the same for financial markets: a common interface connecting tokenised assets to settlement in central bank money."
      readingTime={7}
      faq={FAQ}
      related={RELATED}
    >
      <Callout title="Disambiguation" tone="warn">
        Several unrelated things are called UMI. This article is about the Reserve Bank
        of India's <strong>Unified Market Interface</strong>, financial market
        infrastructure. It is not Umi Network, and not the Metaplex Umi JavaScript
        framework for Solana.
      </Callout>

      <H2>The idea</H2>
      <P>
        India's markets run on separate systems: depositories for securities, exchanges
        for trading, banks and NPCI rails for money. Each works well. Connecting them
        means interfaces, file exchanges, timing windows and reconciliation between
        institutions that each keep their own record.
      </P>
      <P>
        The Unified Market Interface is the RBI's proposal for a common, multi-layered
        platform where tokenised financial assets can be issued, held and settled
        against central bank money — so a connection between an asset and its cash leg
        is a standard interface rather than a bespoke integration. It was unveiled at the
        Global Fintech Fest in 2025 and appears in the RBI's FY26 annual report.
      </P>

      <Callout title="The UPI comparison, and its limits">
        UPI is the obvious analogy: before it, every bank-to-bank payment path was its
        own integration; after it, there was one interface. UMI applies that thought to
        market infrastructure. But the comparison should not be pushed too far — UPI is a
        live retail system used by hundreds of millions of people, while UMI is at the
        pilot stage, wholesale, and limited to regulated institutions.
      </Callout>

      <H2>The piece that makes it work: e₹-W</H2>
      <P>
        An interface for settling assets needs a settlement asset. UMI's is{' '}
        <strong>wholesale central bank digital currency</strong>, written e₹-W — digital
        rupees issued by the RBI for use between financial institutions, not the retail
        e₹ in a consumer wallet.
      </P>
      <P>
        Central bank money matters here for one reason: it carries no credit risk.
        Settling in commercial bank money means holding a claim on a bank, and that
        claim is only as good as the bank. A claim on the central bank is final. The RBI
        has run a wholesale e₹ pilot for secondary-market government securities
        settlement since 1 November 2022.
      </P>

      <H2>What UMI enables</H2>
      <UL>
        <li><strong>Atomic DvP</strong> — the securities leg and the cash leg commit together, or neither does.</li>
        <li><strong>Programmable servicing</strong> — coupons, redemptions and distributions paid directly into holders' CBDC wallets on the due date, by contract.</li>
        <li><strong>A shared record</strong> — authorised institutions see the same holder list at the same moment, instead of exchanging files and reconciling.</li>
        <li><strong>Standard interfaces</strong> — new asset classes connect to settlement without a bespoke build each time.</li>
      </UL>

      <TryIt to="/umi" label="Run an atomic settlement">
        AasthiChain simulates this rail for fractional property: a securities leg on a
        hash-chained ledger, a cash leg in simulated e₹-W, committed in one block — plus
        a failure you can trigger deliberately to watch both legs roll back.
      </TryIt>

      <H2>Where it has been used</H2>
      <H3>Tokenised certificates of deposit</H3>
      <P>
        An earlier UMI pilot covered tokenised CDs — a short-dated, well-understood
        instrument, sensible for a first test.
      </P>

      <H3>Demat 2.0</H3>
      <P>
        The larger one. SEBI's sandbox pilot issues corporate bonds as native digital
        tokens on a depository-operated permissioned ledger, with UMI carrying the cash
        leg in e₹-W so bond and money move in the same instant. REC, L&amp;T and IIFL
        raised ₹1,025 crore in the first three days of September 2026.
      </P>

      <H2>How the layers sit</H2>
      <div style={{ ...card, background: C.soft, margin: '22px 0', fontSize: 14, lineHeight: 1.9, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', overflowX: 'auto' }}>
        <div>Asset layer      tokenised bonds, CDs, (potentially) other assets</div>
        <div>      │</div>
        <div>Interface layer  UMI — standard connection between asset and cash</div>
        <div>      │</div>
        <div>Settlement layer e₹-W wholesale CBDC, central bank money</div>
        <div>      │</div>
        <div>Participants     depositories, exchanges, banks, institutions</div>
      </div>

      <H2>What is still unsettled</H2>
      <P>
        Being accurate about the state of this matters more than enthusiasm:
      </P>
      <UL>
        <li><strong>It is a pilot.</strong> Wholesale, regulated institutions, limited scope. Not open infrastructure anyone can build on.</li>
        <li><strong>There is no public API.</strong> Access is through the SEBI regulatory sandbox, not a developer portal.</li>
        <li><strong>Scope beyond bonds is not settled.</strong> The pattern generalises in principle; which assets actually follow is a policy question, not a technical one.</li>
        <li><strong>Liquidity needs work.</strong> Atomic settlement requires pre-funding, since participants cannot net across the day. That is a real cost, and part of why netted models persist.</li>
      </UL>

      <H2>Why a demonstration is worth building</H2>
      <P>
        Since there is no public API, the way to understand the pattern is to implement
        it. AasthiChain reproduces the shape — pilot ISIN assignment, instruction
        lifecycle, atomic DvP against a simulated CBDC wallet, automated servicing, an
        ISO 20022-style message trace, every settlement committed to an append-only
        ledger — for fractional property rather than bonds, to find out what genuinely
        becomes difficult when you build it rather than describe it.
      </P>

      <TryIt to="/ledger" label="Inspect the ledger">
        Blocks are chained with SHA-512 and merkle roots, stored append-only. Alter a
        committed block and verification fails and the rail refuses to extend the chain.
      </TryIt>
    </ArticleShell>
  )
}

const FAQ = [
  {
    q: "What is the RBI's Unified Market Interface?",
    a: 'UMI is a Reserve Bank of India initiative for a common, multi-layered platform connecting tokenised financial assets to settlement in wholesale central bank digital currency, so that assets and cash can settle atomically through standard interfaces rather than bespoke integrations. It was unveiled at the Global Fintech Fest in 2025 and features in the RBI FY26 annual report.',
  },
  {
    q: 'Is UMI the same as UPI?',
    a: 'No. UPI is a live retail payments interface used by hundreds of millions of people. UMI applies a similar idea of standard interoperability to wholesale market infrastructure — securities settlement between regulated institutions — and is currently at pilot stage.',
  },
  {
    q: 'What is e₹-W?',
    a: 'Wholesale central bank digital currency: digital rupees issued by the RBI for settlement between financial institutions, as distinct from retail e₹ held by consumers. Because it is a direct claim on the central bank it carries no credit risk, which is what makes it suitable as a settlement asset. The RBI has piloted it for government securities settlement since November 2022.',
  },
  {
    q: 'Is there a public UMI API developers can use?',
    a: 'No. There is no public production API. Access is via the SEBI regulatory sandbox and is limited to participating regulated institutions. Independent projects can only reproduce the pattern in simulation.',
  },
  {
    q: 'How does UMI relate to Demat 2.0?',
    a: "Demat 2.0 is SEBI's pilot for issuing corporate bonds as native digital tokens on a depository-run permissioned ledger. UMI is the interface connecting that securities leg to the cash leg in wholesale CBDC, which is what allows the bond and the money to settle atomically.",
  },
]

const RELATED = [
  { to: '/learn/what-is-demat-2', label: 'What is Demat 2.0?', note: 'the pilot built on this rail' },
  { to: '/learn/what-is-atomic-dvp', label: 'What is atomic DvP settlement?', note: 'the mechanism it enables' },
  { to: '/umi', label: 'Run a settlement', note: 'the pattern, live' },
]
