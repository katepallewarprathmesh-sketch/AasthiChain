import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SignInButton } from '@clerk/react'
import { isClerkConfigured } from '../App.jsx'
import { useProperties } from '../hooks/useProperties.js'
import {
  Button, Badge, SimBadge, Card, Metric, PropertyCard, SkeletonCard, EmptyState, ErrorState,
  Field, MoneyInput, Num, Mono, inr, inrShort, InfoTip,
} from '../components/ui.jsx'

/* ============================================================================
   AasthiChain home page.

   The product this fronts is a settlement rail with a property marketplace on
   top of it, and the page has to work for two readers at once: somebody who
   has never bought a fraction of anything, and somebody evaluating whether
   the infrastructure underneath is real. The order below is deliberate:
   plain language first, the system index further down, and the honest limits
   never further than one screen from a claim.

   The one rule this page must not break: a simulated thing must never be
   able to read as a real one. Every surface that touches simulated money
   carries the label, and no figure here is invented. Listings come from the
   API; the calculator says in its own heading that it is illustrative.
   ========================================================================== */

function useLightChrome() {
  // The shared navigation adapts to this flag. The home page is an ivory and
  // white surface now, so the dark glass treatment would be unreadable over
  // it. Setting it here keeps App.jsx untouched.
  useEffect(() => {
    document.documentElement.setAttribute('data-landing-theme', 'light')
    try { localStorage.setItem('aasthi_theme', 'light') } catch { /* private mode is fine */ }
    window.dispatchEvent(new CustomEvent('aasthi-theme', { detail: 'light' }))
    document.body.style.background = '#FFFFFF'
    return () => { document.body.style.background = '' }
  }, [])
}

/* A calm architectural scene, drawn rather than photographed.
   A stock photograph of a building that is not one of these properties,
   placed beside real listings, is the kind of small untruth this project
   spends its time avoiding. */
function HeroArt() {
  return (
    <svg viewBox="0 0 560 420" role="img" aria-label="Illustration of contemporary apartment buildings" style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F6F3EB" /><stop offset="100%" stopColor="#E9EFEA" />
        </linearGradient>
      </defs>
      <rect width="560" height="420" rx="18" fill="url(#sky)" />
      <circle cx="452" cy="86" r="34" fill="#C5A56A" opacity="0.22" />
      <g fill="#173B2B">
        <rect x="46" y="188" width="118" height="232" opacity="0.14" />
        <rect x="396" y="150" width="124" height="270" opacity="0.14" />
        <rect x="178" y="92" width="204" height="328" opacity="0.26" />
      </g>
      <g fill="#F6F3EB" opacity="0.82">
        {Array.from({ length: 9 }).map((_, r) =>
          Array.from({ length: 5 }).map((_, c) => (
            <rect key={`a${r}${c}`} x={196 + c * 36} y={112 + r * 33} width="24" height="20" rx="2" />
          ))
        )}
      </g>
      <g fill="#FFFFFF" opacity="0.5">
        {Array.from({ length: 6 }).map((_, r) =>
          Array.from({ length: 3 }).map((_, c) => (
            <rect key={`b${r}${c}`} x={60 + c * 34} y={206 + r * 34} width="22" height="18" rx="2" />
          ))
        )}
        {Array.from({ length: 7 }).map((_, r) =>
          Array.from({ length: 3 }).map((_, c) => (
            <rect key={`c${r}${c}`} x={410 + c * 36} y={168 + r * 34} width="24" height="18" rx="2" />
          ))
        )}
      </g>
      <rect x="0" y="404" width="560" height="16" fill="#173B2B" opacity="0.1" />
    </svg>
  )
}

/* The index of what is actually built. Each entry links to the screen that
   shows it and carries the honest label for that part. */
const SHIPPED = [
  { to: '/umi', t: 'Unified Market Interface rail', tag: 'Simulated rail, real logic',
    d: 'Wholesale CBDC wallets, the settlement lifecycle and atomic delivery versus payment in integer paise, with an ISO 20022 trace on every instruction.' },
  { to: '/proof', t: 'Attestation and credentials', tag: 'Real signatures',
    d: 'Who vouched for an asset, what they vouched for, and a signature anyone can check without asking this service. Withdrawing an attestation names the holders exposed by it.' },
  { to: '/proof', t: 'Authority for software agents', tag: 'No agent runs here',
    d: 'An owner can delegate bounded authority: named actions, a spending limit the rail counts itself, a hard expiry and revocation that bites on the next request.' },
  { to: '/crossborder', t: 'Paying from outside India', tag: 'Simulated leg',
    d: 'A stablecoin is converted outside India and the rupee wallet is credited only against a remittance attestation, because the consideration for Indian property has to arrive through banking channels.' },
  { to: '/cbdc', t: 'Digital rupee and its corridors', tag: 'Simulated money, real rules',
    d: 'Funds bound to a purpose that refuse to be spent elsewhere, value that works offline, and a refund that pays itself when an event is attested. Screening, verification and interoperability sit on the same page.' },
  { to: '/ledger', t: 'Ledger explorer', tag: 'Open to anyone',
    d: 'Every block, every settlement, every notice, hash-chained and readable without an account.' },
  { to: '/market', t: 'Resale and price discovery', tag: 'Live in the demo',
    d: 'A secondary market for tokens, settled on the same rail as the primary sale rather than beside it.' },
  { to: '/umi', t: 'Asset servicing and income', tag: 'Live in the demo',
    d: 'Rent and coupon distributions land pro rata in holders wallets on the due date, with no file exchange between registries.' },
  { to: '/umi', t: 'Cross-chain settlement', tag: 'Pattern demonstration',
    d: 'A hash-locked transfer between ledgers, framed the way interoperability frameworks do it, so the asset is not trapped on one chain.' },
  { to: '/umi', t: 'Private data between parties', tag: 'Fabric-style',
    d: 'Evidence shared only with the parties entitled to it, with the hash on the shared ledger and a time to live on the data.' },
  { to: '/umi', t: 'Beyond property', tag: 'Same core',
    d: 'Carbon credits, baskets and an escrowed work desk run on the identical issuance, settlement and reconciliation core. That is the argument for it being infrastructure rather than one product.' },
  { to: '/trust', t: 'What is real and what is not', tag: 'Read this first',
    d: 'One page listing every simulated edge of the system, kept honest on purpose, including the parts that make the demo easier.' },
]

const FAQ = [
  { q: 'What am I actually buying?',
    a: 'A token recorded against a property on this ledger, representing a fraction of its value. On this deployment that record is a demonstration: it is not a registered transfer of immovable property, and it does not by itself make anybody an owner in law.' },
  { q: 'Why ₹500?',
    a: 'A property is divided into tokens of equal value, so a ₹75,00,000 property becomes 15,000 tokens of ₹500. The floor exists so the question stops being whether you have lakhs available and starts being whether the property is worth owning.' },
  { q: 'What does "verified" mean here?',
    a: 'That a registrar participant has attested to the title and that the deed fingerprint on the ledger matches the document presented. It does not mean this platform has independently inspected the property or that the attestation is true. A false statement produces a precise, well-evidenced, false record, which is why the attestor is named beside it.' },
  { q: 'Can I sell?',
    a: 'There is a secondary market in the demo, settled on the same rail as the primary sale. Whether a buyer exists at a price is not something any platform can promise, and nothing here estimates liquidity.' },
  { q: 'Is my money at risk in this demo?',
    a: 'No real money moves here. Payments run against test providers or a simulated rail, and every screen that touches money says which. Nothing on this site is an offer, and none of it is investment advice.' },
]

export default function Landing({ user }) {
  useLightChrome()
  const { properties, loading, error, refresh } = useProperties('')
  const featured = useMemo(() => (properties || []).slice(0, 3), [properties])

  // Illustrative only: a token price typed by the reader, not a quote. The
  // authoritative price, availability and limits come from the property page,
  // which reads them from the API.
  const [amount, setAmount] = useState('5000')
  const tokenPrice = 500
  const tokens = Math.floor((Number(amount) || 0) / tokenPrice)

  const [blocks, setBlocks] = useState(null)
  const [blocksFailed, setBlocksFailed] = useState(false)
  useEffect(() => {
    let alive = true
    fetch('/api/drunix/chain?limit=4')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setBlocks(Array.isArray(d.blocks) ? d.blocks : []) })
      .catch(() => { if (alive) setBlocksFailed(true) })
    return () => { alive = false }
  }, [])

  return (
    <main className="ax">
      {/* ---------------------------------------------------------- hero */}
      <section className="ax-section" style={{ background: 'var(--ax-ivory)', paddingTop: 64 }}>
        <div className="ax-wrap" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,.95fr)', gap: 48, alignItems: 'center' }}>
          <div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
              <Badge tone="gold">Fractional property</Badge>
              <SimBadge>Settlement rail simulated</SimBadge>
            </div>
            <h1 className="ax-display ax-h1">Own a fraction of India&rsquo;s real estate.</h1>
            <p className="ax-lede">
              Explore property ownership from ₹500, with transparent records and clearly explained
              investment terms.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 30 }}>
              <Button to="/marketplace">Explore properties</Button>
              <Button to="#how-it-works" variant="secondary" as="a" href="#how-it-works">How it works</Button>
            </div>
            <p className="ax-hint" style={{ marginTop: 18, maxWidth: '54ch' }}>
              This deployment is a working demonstration. No real money moves, and nothing here is an
              offer or investment advice.
            </p>
          </div>

          <div>
            <HeroArt />
            {/* The explainer card. Illustrative figures, labelled as such on
                the card itself rather than in a footnote. */}
            <div className="ax-card ax-card--raised" style={{ marginTop: -46, marginLeft: 18, marginRight: 18, position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <h2 className="ax-card-title" style={{ fontSize: 15 }}>How a property is divided</h2>
                <Badge tone="info">Illustrative</Badge>
              </div>
              <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, margin: '16px 0 0' }}>
                {[
                  ['Property value', '₹75,00,000'],
                  ['Tokens issued', '15,000'],
                  ['Price per token', '₹500'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="ax-hint" style={{ margin: 0 }}>{k}</dt>
                    <dd style={{ margin: '4px 0 0', fontWeight: 650, fontSize: 17 }}><Num>{v}</Num></dd>
                  </div>
                ))}
              </dl>
              <p className="ax-hint" style={{ marginTop: 14 }}>
                An example, not a listing. Real properties below carry their own figures from the register.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ featured listings */}
      <section className="ax-section" id="properties">
        <div className="ax-wrap">
          <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap', marginBottom: 28 }}>
            <div>
              <p className="ax-eyebrow">Open listings</p>
              <h2 className="ax-display ax-h2">Properties on the register</h2>
              <p className="ax-lede" style={{ fontSize: 16 }}>
                Every card below is a record returned by the platform, not a sample. Where a figure is
                missing, the card says so rather than filling the gap.
              </p>
            </div>
            <Button to="/marketplace" variant="secondary">View all properties</Button>
          </header>

          {error ? (
            <ErrorState
              title="The listings did not load"
              detail="The marketplace service did not answer. Nothing is shown rather than showing a cached guess."
              onRetry={refresh}
            />
          ) : loading ? (
            <div className="ax-grid ax-grid--3">{[0, 1, 2].map((i) => <SkeletonCard key={i} />)}</div>
          ) : featured.length === 0 ? (
            <EmptyState
              title="No properties are listed yet"
              body="When an originator lists a property and a registrar attests to its title, it appears here."
              action={<Button to="/marketplace" variant="secondary" size="sm">Open the marketplace</Button>}
            />
          ) : (
            <div className="ax-grid ax-grid--3">
              {featured.map((p) => <PropertyCard key={p.assetId} p={p} />)}
            </div>
          )}
        </div>
      </section>

      {/* -------------------------------------------------- how it works */}
      <section className="ax-section ax-section--ivory" id="how-it-works">
        <div className="ax-wrap">
          <p className="ax-eyebrow">How it works</p>
          <h2 className="ax-display ax-h2">Three steps, no blockchain vocabulary required.</h2>
          <div className="ax-grid ax-grid--3" style={{ marginTop: 32 }}>
            {[
              ['01', 'Discover a property', 'Browse listings with their valuation, the price of one token, how much is still available and who attested to the title.'],
              ['02', 'Review and invest', 'Enter an amount, see exactly how many tokens it buys and what it costs, then confirm. The result you see is the one the settlement core returned.'],
              ['03', 'Track what you own', 'Your holdings, the income distributed against them and every settlement that touched them stay visible, with a public record behind each entry.'],
            ].map(([n, t, d]) => (
              <div key={n} className="ax-card" style={{ background: '#fff' }}>
                <div className="ax-mono" style={{ color: 'var(--ax-gold)', fontWeight: 700, fontSize: 13 }}>{n}</div>
                <h3 className="ax-card-title" style={{ marginTop: 10 }}>{t}</h3>
                <p className="ax-body" style={{ marginTop: 8 }}>{d}</p>
              </div>
            ))}
          </div>
          <p className="ax-hint" style={{ marginTop: 20, maxWidth: '70ch' }}>
            Fractional ownership simply means a property is divided into equal units and you hold some
            of them. The ledger underneath records who holds what; you never have to touch it.
          </p>
        </div>
      </section>

      {/* ----------------------------------------------------- calculator */}
      <section className="ax-section">
        <div className="ax-wrap ax-grid ax-grid--2" style={{ alignItems: 'center', gap: 40 }}>
          <div>
            <p className="ax-eyebrow">Work out the maths</p>
            <h2 className="ax-display ax-h2">What does ₹5,000 buy?</h2>
            <p className="ax-lede" style={{ fontSize: 16 }}>
              At ₹500 a token, an amount simply divides. The calculator on a property page uses that
              property&rsquo;s real token price, its availability and the limits the settlement core enforces.
            </p>
            <Button to="/tools" variant="secondary" style={{ marginTop: 22 }}>Open the calculators</Button>
          </div>
          <Card
            title="Token calculator"
            sub="Illustrative at ₹500 a token. Not a quote, and not tied to a listing."
            right={<Badge tone="info">Illustrative</Badge>}
            raised
          >
            <Field label="Amount to invest" htmlFor="ax-calc" hint="Whole tokens only: a part token cannot be issued.">
              <MoneyInput id="ax-calc" value={amount} onChange={setAmount} aria-describedby="ax-calc-out" />
            </Field>
            <div id="ax-calc-out" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 18 }}>
              <Metric label="Tokens" value={<Num>{tokens.toLocaleString('en-IN')}</Num>} />
              <Metric label="Cost" value={<Num>{inr(tokens * tokenPrice)}</Num>} foot={tokens * tokenPrice !== Number(amount || 0) ? `${inr(Math.max(0, (Number(amount) || 0) - tokens * tokenPrice))} left over` : 'Exact'} />
            </div>
            <p className="ax-hint" style={{ marginTop: 14 }}>
              No return is shown here. Rent and resale depend on the property and the market, and a
              projected yield on a landing page is a guess dressed as a number.
            </p>
          </Card>
        </div>
      </section>

      {/* ------------------------------------------------------- trust */}
      <section className="ax-section ax-section--forest">
        <div className="ax-wrap">
          <p className="ax-eyebrow" style={{ color: 'var(--ax-gold)' }}>Trust and transparency</p>
          <h2 className="ax-display ax-h2" style={{ maxWidth: '18ch' }}>What the record proves, and what it does not.</h2>
          <div className="ax-grid ax-grid--3" style={{ marginTop: 34 }}>
            {[
              ['Registrar title validation', 'A registrar participant attests that the title is what the listing says. The attestation is signed, and withdrawing it names every holder it exposed.'],
              ['Deed fingerprinting', 'The deed is hashed and only the fingerprint is stored. The document never leaves your machine during verification, and a changed byte changes the fingerprint.'],
              ['Append-only ownership', 'Entries are added, never edited. Each block carries the hash of the one before it, so a quiet correction after the fact is detectable.'],
              ['Atomic delivery versus payment', 'Tokens and money move in one operation. There is no moment where one side has paid and the other has not.'],
              ['Public verification', 'The ledger, the attestations and the signatures can be checked by anyone, without an account and without asking this service to vouch for itself.'],
              ['A ledger record is not a title deed', 'This is the limit worth stating plainly. A record here shows what this system was told and what it settled. Legal ownership of immovable property in India is established at the sub-registrar, not here.'],
            ].map(([t, d], i) => (
              <div key={t} style={{ borderTop: '1px solid rgba(255,255,255,.16)', paddingTop: 18 }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 650, color: i === 5 ? 'var(--ax-gold)' : '#fff' }}>{t}</h3>
                <p className="ax-body" style={{ marginTop: 8 }}>{d}</p>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 34 }}>
            <Button to="/verify" variant="onforest">Verify a deed</Button>
            <Button to="/trust" variant="ghost" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}>What is real and what is not</Button>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ ledger preview */}
      <section className="ax-section">
        <div className="ax-wrap">
          <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
            <div>
              <p className="ax-eyebrow">The record</p>
              <h2 className="ax-display ax-h2">Ledger explorer</h2>
              <p className="ax-lede" style={{ fontSize: 16 }}>The most recent entries, as the chain returned them.</p>
            </div>
            <Button to="/ledger" variant="secondary">Open the explorer</Button>
          </header>

          <Card pad="sm">
            {blocksFailed ? (
              <ErrorState title="The chain did not answer" detail="No block heights are shown rather than showing numbers nobody can check." />
            ) : blocks === null ? (
              <div style={{ display: 'grid', gap: 10 }}>{[0, 1, 2].map((i) => <div key={i} className="ax-skel" style={{ height: 44 }} />)}</div>
            ) : blocks.length === 0 ? (
              <EmptyState title="No blocks yet" body="Nothing has been settled on this instance of the chain." />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="ax-table">
                  <caption className="ax-sr">Most recent ledger entries</caption>
                  <thead>
                    <tr><th scope="col">Height</th><th scope="col">Type</th><th scope="col">Recorded</th><th scope="col">Block hash</th></tr>
                  </thead>
                  <tbody>
                    {blocks.slice(0, 4).map((b) => (
                      <tr key={b.height ?? b.hash}>
                        <td className="ax-num"><Mono>#{b.height}</Mono></td>
                        <td>{String(b.type || '').replace(/_/g, ' ').toLowerCase() || 'entry'}</td>
                        <td className="ax-hint" style={{ whiteSpace: 'nowrap' }}>{b.timestamp ? new Date(b.timestamp).toLocaleString('en-IN') : 'not stated'}</td>
                        <td><Mono title={b.hash}>{String(b.hash || '').slice(0, 18)}…</Mono></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </section>

      {/* ================= WHAT IS INSIDE =================
          The home page once described the first six months of the project and
          nothing after it. Everything built since existed only behind a URL
          somebody had to be told about. This is the index of what is actually
          in here, with the honest label on each one. */}
      <section className="ax-section ax-section--ivory" id="inside">
        <div className="ax-wrap">
          <p className="ax-eyebrow">What is inside</p>
          <h2 className="ax-display ax-h2">The whole system, not just the storefront.</h2>
          <p className="ax-lede" style={{ fontSize: 16 }}>
            Each of these is built and running, and each says plainly which part of it is a simulation.
            Nothing here is a roadmap item.
          </p>
          <div className="ax-grid ax-grid--auto" style={{ marginTop: 32 }}>
            {SHIPPED.map((f) => (
              <Link key={f.t} to={f.to} className="ax-card" style={{ textDecoration: 'none', color: 'inherit', background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                  <h3 className="ax-card-title" style={{ fontSize: 15.5 }}>{f.t}</h3>
                  <Badge tone={/Simulated|No agent|Pattern/i.test(f.tag) ? 'sim' : 'success'}>{f.tag}</Badge>
                </div>
                <p className="ax-body" style={{ marginTop: 10, fontSize: 13.5 }}>{f.d}</p>
                <span style={{ display: 'inline-block', marginTop: 12, fontSize: 13, fontWeight: 600, color: 'var(--ax-green)' }}>Open →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ FAQ */}
      <section className="ax-section">
        <div className="ax-wrap" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,.8fr) minmax(0,1.2fr)', gap: 44 }}>
          <div>
            <p className="ax-eyebrow">Questions</p>
            <h2 className="ax-display ax-h2">Before you start</h2>
            <p className="ax-lede" style={{ fontSize: 16 }}>
              The answers people actually need, including the ones that are inconvenient for us.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 22 }}>
              <Button to="/learn" variant="secondary" size="sm">Learn the system</Button>
              <Button to="/support" variant="ghost" size="sm">Support</Button>
            </div>
          </div>
          <div>
            {FAQ.map((f) => (
              <details key={f.q} style={{ borderBottom: '1px solid var(--ax-line)', padding: '16px 0' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 15.5, color: 'var(--ax-ink)' }}>{f.q}</summary>
                <p className="ax-body" style={{ marginTop: 10 }}>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- risk */}
      <section className="ax-section ax-section--line" style={{ paddingTop: 44, paddingBottom: 44 }}>
        <div className="ax-wrap">
          <Card style={{ background: 'var(--ax-warning-wash)', borderColor: 'rgba(154,107,22,.28)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <Badge tone="warning">Risk disclosure</Badge>
              <Badge tone="sim">SIMULATION</Badge>
            </div>
            <p className="ax-body" style={{ color: 'var(--ax-ink)', maxWidth: '88ch' }}>
              Property values fall as well as rise, rental income can stop, and a fractional holding can be
              hard to sell when you want to sell it. This deployment is a demonstration: the settlement rail,
              the digital rupee wallets and the identity checks are simulated, payment flows run against test
              providers, and it is not connected to a live national payments rail or a production chain.
              Nothing here is an offer, a solicitation or investment advice, and a record on this ledger is
              not proof of legal title to immovable property.
            </p>
          </Card>
        </div>
      </section>

      {/* ------------------------------------------------------- footer */}
      <footer style={{ background: 'var(--ax-forest)', color: 'rgba(237,242,238,.78)', padding: '52px 0 36px' }}>
        <div className="ax-wrap">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) repeat(3, minmax(0,1fr))', gap: 32 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
                  <path d="M13 3 23 10v13h-7v-7h-6v7H3V10z" fill="none" stroke="#C5A56A" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
                <span style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 19, color: '#fff', fontWeight: 600 }}>AasthiChain</span>
              </div>
              <p className="ax-body" style={{ marginTop: 12, maxWidth: '38ch' }}>
                Fractional property ownership on a settlement rail that shows its working.
              </p>
            </div>
            {[
              ['Product', [['Explore properties', '/marketplace'], ['Ledger explorer', '/ledger'], ['Settlement rail', '/umi'], ['Verify a deed', '/verify']]],
              ['Learn', [['Learn', '/learn'], ['Calculators', '/tools'], ['Insights', '/insights'], ['About', '/about']]],
              ['Company', [['Support', '/support'], ['Privacy', '/privacy'], ['Terms', '/terms'], ['Trust', '/trust']]],
            ].map(([heading, links]) => (
              <nav key={heading} aria-label={heading}>
                <h2 style={{ fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,.55)', margin: '0 0 12px' }}>{heading}</h2>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 9 }}>
                  {links.map(([label, to]) => (
                    <li key={to}><Link to={to} style={{ color: 'rgba(237,242,238,.82)', textDecoration: 'none', fontSize: 14 }}>{label}</Link></li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,.14)', marginTop: 34, paddingTop: 20, display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span>A demonstration of market infrastructure. Simulated settlement, real code.</span>
            {!user && isClerkConfigured && (
              <SignInButton mode="modal">
                <button className="ax-btn ax-btn--ghost ax-btn--sm" style={{ color: '#fff' }}>Sign in</button>
              </SignInButton>
            )}
          </div>
        </div>
      </footer>
    </main>
  )
}
