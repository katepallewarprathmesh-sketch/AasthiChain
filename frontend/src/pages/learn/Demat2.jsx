import React from 'react'
import ArticleShell, { H2, H3, P, UL, Callout, TryIt } from './ArticleShell'
import { C, card } from '../tools/ToolShell'

export default function Demat2() {
  return (
    <ArticleShell
      slug="what-is-demat-2"
      title="What is Demat 2.0?"
      standfirst="SEBI's sandbox pilot issues corporate bonds as native digital tokens on a depository-run ledger, settled against central bank digital currency. It is not a new demat account — it is a different way of recording and settling the security itself."
      readingTime={8}
      faq={FAQ}
      related={RELATED}
    >
      <H2>The short version</H2>
      <P>
        Demat 2.0 is a regulatory sandbox pilot announced jointly by the RBI and SEBI at
        the Global Fintech Fest in September 2026. Corporate bonds are issued as{' '}
        <strong>native digital tokens</strong> on a permissioned distributed ledger owned
        and operated by India's depositories, and the cash leg settles in{' '}
        <strong>wholesale central bank digital currency</strong> through the RBI's
        Unified Market Interface. Securities and money move in the same instant.
      </P>
      <P>
        In the first three days — 7 to 9 September 2026 — REC, L&amp;T and IIFL raised{' '}
        <strong>₹1,025 crore</strong> through it.
      </P>

      <Callout title="What it is not">
        It is not a replacement for your demat account, not a cryptocurrency, and not a
        public blockchain. A Demat 2.0 account is an extension of the demat account you
        already have, the ledger is permissioned with the depositories and exchanges as
        its nodes, and a pilot ISIN is an ordinary ISIN flagged as part of the pilot.
      </Callout>

      <H2>What changes, concretely</H2>
      <H3>The security is born digital</H3>
      <P>
        Today a bond exists as an entry in a depository's database, created from a
        physical or electronic issuance record. Under Demat 2.0 the token on the ledger{' '}
        <em>is</em> the security — there is no separate master record it is a reflection
        of. That removes the possibility of the two disagreeing, which is what
        reconciliation exists to detect.
      </P>

      <H3>Settlement is atomic</H3>
      <P>
        The bond leg moves on the depositories' ledger and the cash leg moves in
        wholesale e₹, connected through UMI, inside a single operation. There is no
        window in which the buyer has paid but holds nothing, so there is no settlement
        risk to margin against.
      </P>

      <TryIt to="/umi" label="Run an atomic settlement">
        AasthiChain reproduces this pattern for property instead of bonds: a securities
        leg and an e₹-W cash leg committed in one block, with a failure mode you can
        trigger to watch both legs roll back.
      </TryIt>

      <H3>Asset servicing runs itself</H3>
      <P>
        Coupon payments and redemptions are executed by smart contract. On the due date
        the ledger already knows who holds what, so the money is credited directly to
        holders' CBDC wallets. No registrar produces a beneficiary file, no file is sent
        to a paying agent, no one reconciles the result. The bondholder list is visible
        simultaneously to every authorised institution rather than being assembled and
        circulated.
      </P>

      <H3>Reconciliation largely disappears</H3>
      <P>
        This is the quiet one, and probably the biggest. Much of the cost of
        post-trade infrastructure is not the transfer itself; it is many institutions
        each keeping their own record and then agreeing with each other afterwards. One
        shared record that all of them read removes the disagreement rather than
        resolving it faster.
      </P>

      <H2>What stays exactly the same</H2>
      <P>
        This is the part that gets lost when the pilot is described as disruptive.
        Everything protecting the investor is unchanged:
      </P>
      <UL>
        <li>Credit rating requirements</li>
        <li>Debenture trustee appointment</li>
        <li>Listing and disclosure obligations</li>
        <li>Investor eligibility rules</li>
        <li>Valuation norms</li>
      </UL>
      <P>
        Demat 2.0 changes the <em>plumbing</em> of issuance and settlement. It does not
        change what a bond is, who may buy one, or what the issuer must disclose.
      </P>

      <H2>How the pieces fit</H2>
      <div style={{ ...card, background: C.soft, margin: '22px 0', fontSize: 14, lineHeight: 1.9, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', overflowX: 'auto' }}>
        <div>Issuer (REC, L&amp;T, IIFL)</div>
        <div>   │ issues a native digital token, pilot ISIN</div>
        <div>   ▼</div>
        <div>Permissioned DLT — nodes: depositories + exchanges</div>
        <div>   │ securities leg</div>
        <div>   ├──────────────┐</div>
        <div>   │              │ atomic DvP</div>
        <div>   │              ▼</div>
        <div>   │        UMI (RBI Unified Market Interface)</div>
        <div>   │              │ cash leg</div>
        <div>   │              ▼</div>
        <div>   │        Wholesale CBDC (e₹-W)</div>
        <div>   ▼</div>
        <div>Investor's Demat 2.0 account + CBDC wallet</div>
      </div>

      <H2>Trading and transfer, for now</H2>
      <P>
        In the current stage there is no priced secondary market for these tokens.
        Investors can transfer peer to peer through the depositories, which is a transfer
        mechanism rather than a market. A full secondary market is expected in a later
        stage of the pilot. That ordering is deliberate: prove issuance, settlement and
        servicing work before adding price discovery and liquidity on top.
      </P>

      <H2>Why bonds first?</H2>
      <P>
        Corporate bonds are an unusually good test case. Issuance is relatively
        infrequent and the amounts are large, so the cost of each settlement matters.
        Servicing is mechanical — coupons on a schedule — which makes it ideal for
        automation. Participants are institutions already subject to KYC, so the
        permissioned model fits. And India's corporate bond market has long been
        criticised for weak liquidity and heavy post-trade friction, which is precisely
        what this attacks.
      </P>

      <Callout title="What came before" tone="warn">
        This is not the first step. UMI's earlier pilot handled tokenised certificates of
        deposit, and the RBI has been running wholesale e₹ for secondary-market
        government securities settlement since 1 November 2022. Demat 2.0 is the point
        where the two converge on a security issued digitally from the start.
      </Callout>

      <H2>What it means if you are building</H2>
      <P>
        The pattern generalises past bonds. Any asset that can be represented as a
        registry entry and settled against a cash leg can use the same shape — which is
        the premise AasthiChain tests with fractional property: tokenised units on an
        append-only ledger, settled atomically against simulated e₹-W, with rental income
        distributed by contract the way a coupon would be.
      </P>

      <TryIt to="/ledger" label="Inspect the ledger">
        Every settlement commits a block, chained with SHA-512 and merkle roots. The
        explorer replays and re-verifies the chain from genesis, so the record can be
        checked rather than trusted.
      </TryIt>
    </ArticleShell>
  )
}

const FAQ = [
  {
    q: 'What is Demat 2.0?',
    a: "Demat 2.0 is a SEBI regulatory-sandbox pilot, announced with the RBI in September 2026, in which corporate bonds are issued as native digital tokens on a permissioned distributed ledger operated by India's depositories and settled against wholesale central bank digital currency through the RBI's Unified Market Interface, so that the bond and the cash move atomically.",
  },
  {
    q: 'Do I need a new demat account for Demat 2.0?',
    a: 'No. A Demat 2.0 account is an extension of the demat account you already hold, not a separate account with a different provider.',
  },
  {
    q: 'Is Demat 2.0 a cryptocurrency or a public blockchain?',
    a: 'Neither. The ledger is permissioned and owned by the depositories, with depositories and exchanges as its nodes. The instruments are regulated corporate bonds with ordinary ISINs flagged as part of the pilot, and the cash leg settles in central bank money rather than any crypto asset.',
  },
  {
    q: 'Which companies have issued bonds under Demat 2.0?',
    a: 'REC, L&T and IIFL were the first issuers, raising a combined ₹1,025 crore between 7 and 9 September 2026.',
  },
  {
    q: 'Can Demat 2.0 bonds be traded?',
    a: 'Not on a priced secondary market in the current stage. Investors can transfer holdings peer to peer through the depositories, which is a transfer facility rather than a market. A secondary market is expected in a later stage of the pilot.',
  },
  {
    q: 'Does Demat 2.0 change the rules protecting bond investors?',
    a: 'No. Credit rating, debenture trustee, listing, disclosure, investor eligibility and valuation requirements all continue to apply unchanged. The pilot changes how the security is recorded and settled, not what it is or who may buy it.',
  },
]

const RELATED = [
  { to: '/learn/what-is-atomic-dvp', label: 'What is atomic DvP settlement?', note: 'the mechanism underneath it' },
  { to: '/learn/what-is-umi', label: "What is the RBI's Unified Market Interface?", note: 'the rail carrying the cash leg' },
  { to: '/umi', label: 'Run a settlement', note: 'the pattern, live' },
]
