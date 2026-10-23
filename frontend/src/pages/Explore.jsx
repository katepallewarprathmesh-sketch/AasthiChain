import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'

/**
 * One place that lists everything.
 *
 * The site had grown past what a navbar can carry: a person who had not been
 * told that the digital rupee layer, the corridors, the proof page and six
 * calculators existed had no way to find out. The answer is not a longer
 * navbar, which makes the important things harder to see, but one directory
 * that names every page in a sentence, with a filter over it.
 *
 * The list is written here by hand rather than derived from the router,
 * because a route is not a description: what a person needs is what the page
 * is for, and whether signing in is required to use it.
 */

const SECTIONS = [
  {
    name: 'Invest',
    blurb: 'Buying, holding and selling a share of a property.',
    items: [
      { path: '/marketplace', title: 'Marketplace', what: 'Every property open for investment, with the ledger id behind each one.' },
      { path: '/dashboard', title: 'Dashboard', what: 'What you hold, what it is worth and what it has paid.', signin: true },
      { path: '/wallet', title: 'Wallet', what: 'Your balances and the record of every movement in and out.', signin: true },
      { path: '/market', title: 'Resale market', what: 'Buy and sell existing holdings between investors.', signin: true },
      { path: '/insights', title: 'Insights', what: 'Yields, occupancy and the numbers behind the listings.' },
    ],
  },
  {
    name: 'Money and settlement',
    blurb: 'How value actually moves, and what is final rather than merely recorded.',
    items: [
      { path: '/umi', title: 'Settlement interface', what: 'Atomic delivery versus payment: the property leg and the cash leg commit in one block or neither moves.' },
      { path: '/cbdc', title: 'Digital rupee', what: 'Money bound to a purpose, value carried offline, and refunds that pay themselves when an event is attested.' },
      { path: '/crossborder', title: 'Cross-border', what: 'Paying in from outside India, with the tax and reporting rules applied rather than assumed.' },
      { path: '/keys', title: 'Key register', what: 'Prove a signing key is yours, and watch it screened for the entropy failures that have broken real certificate authorities.' },
      { path: '/feeds', title: 'Feeds and backing', what: 'Signed rate feeds that refuse when stale, and backing attestations that stop issuance when withdrawn.' },
      { path: '/cards', title: 'Card rail and disputes', what: 'The split a merchant never sees, and the chargeback ladder that can reverse a settled payment four months later.' },
      { path: '/ledger', title: 'Ledger explorer', what: 'Every block, its hash linkage and its merkle root, verifiable in the browser.' },
      { path: '/proof', title: 'Proof', what: 'What has been anchored to a public chain and how to check it yourself.' },
    ],
  },
  {
    name: 'Check for yourself',
    blurb: 'Nothing here asks to be believed.',
    items: [
      { path: '/verify', title: 'Verify a document', what: 'Hash a file in your browser and see whether that hash is on the ledger.' },
      { path: '/trust', title: 'Trust', what: 'What is real, what is simulated, and what has not been built. Stated plainly.' },
      { path: '/support', title: 'Support', what: 'How to get help, and what happens when something goes wrong.' },
    ],
  },
  {
    name: 'Learn',
    blurb: 'Short explanations, no prior knowledge assumed.',
    items: [
      { path: '/learn', title: 'Learn index', what: 'Every explainer in one list.' },
      { path: '/learn/what-is-umi', title: 'What the Unified Market Interface is', what: 'The settlement pattern this system is built to.' },
      { path: '/learn/what-is-atomic-dvp', title: 'What atomic delivery versus payment is', what: 'Why both legs committing together removes the risk of one arriving without the other.' },
      { path: '/learn/what-is-demat-2', title: 'What Demat 2.0 is', what: 'Native digital securities, and what changes for an investor.' },
      { path: '/about', title: 'About', what: 'What this project is and who built it.' },
    ],
  },
  {
    name: 'Calculators',
    blurb: 'Free, nothing stored, everything runs in your browser.',
    items: [
      { path: '/tools', title: 'All calculators', what: 'The full set in one place.' },
      { path: '/tools/rental-yield-calculator', title: 'Rental yield', what: 'Gross and net yield on a property.' },
      { path: '/tools/fractional-investment-calculator', title: 'Fractional investment', what: 'What a part share returns over time.' },
      { path: '/tools/stamp-duty-calculator', title: 'Stamp duty', what: 'Duty and registration on a purchase.' },
      { path: '/tools/home-loan-emi-calculator', title: 'Home loan EMI', what: 'Monthly instalment, interest and schedule.' },
      { path: '/tools/rent-vs-buy-calculator', title: 'Rent versus buy', what: 'Which is cheaper over a holding period.' },
      { path: '/tools/capital-gains-tax-calculator', title: 'Capital gains tax', what: 'Tax on a sale, short and long term.' },
    ],
  },
  {
    name: 'Operate',
    blurb: 'For the originator, the registrar and the regulator. The rail checks the role, not the screen.',
    items: [
      { path: '/admin', title: 'Admin', what: 'Issue a property, mint units and manage a listing.', signin: true },
      { path: '/admin/ops', title: 'Operations', what: 'Work orders, escrow and the day to day desk.', signin: true },
      { path: '/regulator', title: 'Audit', what: 'The regulator view: holdings, flags and the full movement history.', signin: true },
    ],
  },
]

export default function Explore() {
  const [q, setQ] = useState('')

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return SECTIONS
    return SECTIONS
      .map((s) => ({
        ...s,
        items: s.items.filter((i) =>
          (i.title + ' ' + i.what + ' ' + i.path + ' ' + s.name).toLowerCase().includes(needle)),
      }))
      .filter((s) => s.items.length > 0)
  }, [q])

  const total = SECTIONS.reduce((t, s) => t + s.items.length, 0)
  const showing = sections.reduce((t, s) => t + s.items.length, 0)

  return (
    <PageShell
      eyebrow="Find anything"
      title="Everything on AasthiChain"
      lede="Every page, in one list, with a sentence on what it is for. The navbar carries the few screens used daily; this carries the rest, so nothing is reachable only by knowing the URL."
    >
      <Card title="Search" sub={`${showing} of ${total} pages shown. Type a word: refund, offline, tax, verify, corridor.`}>
        <label className="pg-field" htmlFor="explore-q">What are you looking for</label>
        <input
          id="explore-q"
          className="pg-input"
          type="search"
          value={q}
          placeholder="refund, stamp duty, ledger, regulator"
          onChange={(e) => setQ(e.target.value)}
        />
      </Card>

      {sections.map((s) => (
        <Card key={s.name} title={s.name} sub={s.blurb}>
          {s.items.map((i) => (
            <div key={i.path} className="pg-row" style={{ padding: '12px 0', borderTop: '1px solid #E2E8F0' }}>
              <Link to={i.path} style={{ fontWeight: 600, textDecoration: 'none' }}>{i.title}</Link>
              {i.signin && <> <Tag tone="neutral">sign in</Tag></>}
              <p className="pg-card-sub" style={{ marginTop: 4 }}>{i.what}</p>
            </div>
          ))}
        </Card>
      ))}

      {showing === 0 && (
        <Card title="Nothing matches that">
          <p className="pg-card-sub">
            No page name or description contains that word. Clearing the box brings all {total} back.
          </p>
        </Card>
      )}
    </PageShell>
  )
}
