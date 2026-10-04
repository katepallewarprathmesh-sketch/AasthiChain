import React from 'react'
import { Link } from 'react-router-dom'
import LegalShell, { H2, P, UL, SimulationNotice } from './LegalShell'
import { C, card } from '../tools/ToolShell'

export default function About() {
  return (
    <LegalShell
      title="About AasthiChain"
      subtitle="An open-source demonstration of how tokenised property could settle against digital rupee — built to show the mechanism, not to sell anything."
    >
      <H2>Why this exists</H2>
      <P>
        In September 2026 SEBI and the RBI launched Demat 2.0, a sandbox pilot in which
        corporate bonds are issued as native digital tokens on a permissioned ledger run
        by the depositories, and settled against wholesale central bank digital currency
        through the RBI's Unified Market Interface. Bond and cash move in the same
        instant. REC, L&amp;T and IIFL raised ₹1,025 crore through it.
      </P>
      <P>
        The interesting part is not the tokens. It is the settlement: when the asset and
        the money move together, the window in which one party has paid but not received
        disappears entirely, and with it the reconciliation machinery built to manage that
        risk.
      </P>
      <P>
        Property is the largest asset class in India and among the slowest to transfer. If
        a bond can settle this way, a fractional property interest can too. AasthiChain is
        an attempt to build that end to end and find out what actually becomes difficult.
      </P>

      <H2>What it does</H2>
      <UL>
        <li><strong>Tokenised ownership</strong> — a property is divided into units recorded on an append-only ledger.</li>
        <li><strong>Atomic delivery versus payment</strong> — the ownership leg and the cash leg commit inside a single block. If either fails, both roll back; there is no half-settled state.</li>
        <li><strong>A ledger that cannot be quietly edited</strong> — blocks are chained with SHA-512 hashes and merkle roots. Altering a committed block breaks verification, and the chain then refuses to extend rather than building on forged history.</li>
        <li><strong>Automated asset servicing</strong> — rental income is distributed to holders' wallets by contract, in proportion to their holdings.</li>
        <li><strong>A full audit trail</strong> — every settlement carries an ISO 20022-shaped message trace showing exactly where it succeeded or stopped.</li>
      </UL>

      <div style={{ ...card, marginTop: 22 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: C.ink, margin: '0 0 10px' }}>See it work</h2>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14.5, color: C.body, lineHeight: 1.95 }}>
          <li><Link to="/umi" style={{ color: C.navy, fontWeight: 600 }}>Run an atomic settlement</Link> — including a deliberate failure, to watch both legs roll back</li>
          <li><Link to="/ledger" style={{ color: C.navy, fontWeight: 600 }}>Inspect the ledger</Link> — verify the hash chain block by block</li>
          <li><Link to="/marketplace" style={{ color: C.navy, fontWeight: 600 }}>Browse the marketplace</Link> — no account needed</li>
        </ul>
      </div>

      <H2>How it is built</H2>
      <P>
        The settlement rail, the ledger and the gateways are written in Go, chosen because
        anything touching money benefits from being typed, boring and predictable under
        concurrency. Blocks are stored in PostgreSQL append-only, so a committed block
        survives restarts. The interface is React. The JavaScript layers are deliberately
        thin proxies with no settlement logic in them.
      </P>
      <P>
        Everything is covered by an automated regression suite and a render test across
        every page, on the principle that a new feature which breaks an existing one is
        not a feature.
      </P>

      <H2>Who built it</H2>
      <P>
        Prathmesh Katepallewar, from Jalna, Maharashtra. The project is developed in the
        open; the full history, including every mistake and correction, is in the
        repository.
      </P>

      <H2>Open source</H2>
      <P>
        The code is on{' '}
        <a href="https://github.com/katepallewarprathmesh-sketch/AasthiChain" target="_blank" rel="noopener noreferrer" style={{ color: C.navy, fontWeight: 600 }}>
          GitHub
        </a>. Issues, questions and corrections are welcome — particularly from anyone who
        works on market infrastructure and can point out where the model departs from how
        these systems really behave.
      </P>

      <SimulationNotice />
    </LegalShell>
  )
}
