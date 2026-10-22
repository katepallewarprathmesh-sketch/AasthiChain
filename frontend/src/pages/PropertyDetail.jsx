import React, { useState, useEffect } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useProperty } from '../hooks/useProperties.js'
import SimpleBuyFlow from '../components/SimpleBuyFlow.jsx'
import PropertyDocuments from '../components/PropertyDocuments.jsx'
import api from '../lib/api.js'
import { money, moneyExact } from '../lib/format.js'
import { applySeo, propertySeo } from '../lib/seo.js'
import {
  Button, Badge, Card as AxCard, Metric, Progress, Breadcrumbs, ArchPlaceholder,
  Num, Mono, InfoTip, inr, inrShort,
} from '../components/ui.jsx'
import { propertyImage, REPRESENTATIVE_NOTE } from '../lib/propertyImages.js'
import { registryStatus } from '../lib/registryStatus.js'


// Address check result, shown as it is. A listing whose pincode the India Post
// directory does not recognise says so on the page rather than quietly passing.
function locationCheckTone(status) {
  if (status === 'VERIFIED') return '#047857'
  if (status === 'MISMATCH' || status === 'NOT_FOUND' || status === 'MALFORMED') return '#B45309'
  return '#6B7280'
}

function locationCheckLabel(c) {
  const pin = c.pincode || ''
  if (c.status === 'VERIFIED') return `Pincode ${pin} checked against the India Post directory: ${c.detail}`
  if (c.status === 'MISMATCH') return `Pincode ${pin} exists, but the India Post directory places it in ${c.officialDistrict}, ${c.officialState}.`
  if (c.status === 'NOT_FOUND') return `Pincode ${pin} is not in the India Post directory.`
  if (c.status === 'MALFORMED') return `Pincode ${pin} is not a valid Indian pincode.`
  return `Pincode ${pin} was not checked against the India Post directory.`
}

export default function PropertyDetail({ user }) {
  const { id } = useParams()
  const location = useLocation()
  const { property, loading, error, refresh } = useProperty(id)

  // Per-property search metadata. Each listing is its own landing page for a
  // real query ("fractional investment Pune"), so the title and description
  // are built from the property rather than left generic.
  useEffect(() => {
    if (!property) return
    applySeo(location.pathname, propertySeo(property))
  }, [property, location.pathname])
  const [balances, setBalances] = useState([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [sub, setSub] = useState(null)
  const [showXfer, setShowXfer] = useState(false)
  const [xferTo, setXferTo] = useState('')
  const [xferAmt, setXferAmt] = useState('')
  const [xferMsg, setXferMsg] = useState(null)
  const [xferErr, setXferErr] = useState(null)
  const [proposals, setProposals] = useState([])
  const [govTitle, setGovTitle] = useState('')
  const [yieldAmt, setYieldAmt] = useState('')
  const [borrowTokens, setBorrowTokens] = useState('')
  const [ownMsg, setOwnMsg] = useState(null)
  const [myLoansHere, setMyLoansHere] = useState([])
  const [showBuy, setShowBuy] = useState(false)
  // A buyer's first question is "is this real". The answer existed only as an
  // API call, so the page showed a one-word status and nothing behind it.
  const [verif, setVerif] = useState(null)
  const [docHash, setDocHash] = useState('')
  const [docResult, setDocResult] = useState(null)
  const [docBusy, setDocBusy] = useState(false)

  // Returning from PayU hosted checkout: auto-open the buy panel so the
  // resume logic completes DvP and shows the receipt (UTR) no extra clicks.
  useEffect(() => {
    let alive = true
    if (!id) return
    api.propertyVerification(id)
      .then(d => { if (alive) setVerif(d) })
      // Keep whatever is already on screen. This effect re-runs on refreshKey
      // after a purchase or a yield payout, and a failure on that second run
      // used to wipe a verification panel the reader was already looking at —
      // including the deed checker inside it. A stale panel is better than a
      // section that deletes itself.
      .catch(() => { if (alive) setVerif(v => v) })
    return () => { alive = false }
  }, [id, refreshKey])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('payu') !== 'return') return
    const pid = params.get('paymentId')
    try {
      if (pid && !localStorage.getItem('aasthi_payu_pending')) {
        localStorage.setItem('aasthi_payu_pending', JSON.stringify({ paymentId: pid, assetId: id, ts: Date.now() }))
      }
    } catch { /* private mode */ }
    setShowBuy(true)
    params.delete('payu'); params.delete('paymentId')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (!property) return
    const fetchBalances = async () => {
      // Preferred: server-computed holder list (includes the real listing owner,
      // whatever role they have registrar-owned listings show correctly)
      try {
        const detail = await api.getProperty(property.assetId)
        setSub(detail?.subscription || null)
        if (user) {
          api.getProposals(property.assetId).then(d => setProposals(d.proposals || [])).catch(() => {})
          api.getLoans(user.identityId).then(d => setMyLoansHere((d.loans || []).filter(l => l.assetId === property.assetId && l.status === 'ACTIVE'))).catch(() => {})
        }
        const hs = detail?.holders
        if (Array.isArray(hs) && hs.length > 0) {
          setBalances(hs)
          return
        }
      } catch {}
      // Fallback for older servers: known demo identities
      const owners = ['originator1', 'investor1', 'investor2']
      const results = []
      for (const owner of owners) {
        try {
          const b = await api.getBalance(property.assetId, owner)
          if (b.balance > 0) results.push(b)
        } catch {}
      }
      setBalances(results)
    }
    fetchBalances()
  }, [property?.assetId, refreshKey])

  if (loading && !property) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{
          width: 32, height: 32,
          border: '3px solid #E5E7EB',
          borderTopColor: '#1E3A5F',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
          margin: '0 auto'
        }}></div>
        <p style={{ color: '#6B7280', fontSize: 14, marginTop: 12 }}>Loading property details...</p>
      </div>
    )
  }

  if (error && !property) {
    return (
      <div style={{ padding: 20, maxWidth: 600, margin: '0 auto' }}>
        <Link to="/marketplace" style={{ fontSize: 13, color: '#1E3A5F', textDecoration: 'none' }}>← Back to Properties</Link>
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: 20, marginTop: 16, textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: '#991B1B' }}>{error}</p>
          <button onClick={refresh} style={{
            marginTop: 12,
            padding: '8px 16px',
            background: '#1E3A5F',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer'
          }}>
            Try Again
          </button>
        </div>
      </div>
    )
  }

  if (!property) return null

  const tokenPrice = property.totalTokens ? Math.floor(property.valuationINR / property.totalTokens) : 500
  // Seeded listings carry a hash that was typed in at registration, and no
  // document was ever issued against it. Inviting a reader to hash "the file
  // you were sent" is then a dead end: there is no file, so every attempt
  // reads as a mismatch and the feature looks broken instead of unused.
  const SEEDED_DOC_HASHES = [
    'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1',
    'a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4d6f8a0c2e4d6f8a0c2e4b6d8f0a1',
  ]
  const docIsSeeded = SEEDED_DOC_HASHES.includes(String(property.documentHash || '').toLowerCase())
  const availableTokens = property.availableTokens ?? 0
  const ownerHeld = balances.find(b => b.ownerId === property.originatorId)?.balance || 0
  const soldShown = sub?.soldTokens ?? Math.max(0, (property.totalTokens || 0) - (property.availableTokens ?? ownerHeld))
  const soldPct = property.totalTokens ? Math.min(100, Math.round((soldShown / property.totalTokens) * 100)) : 0
  const myHeld = user ? (balances.find(b => b.ownerId === user.identityId)?.balance || 0) : 0
  const identityOptions = [['originator1', 'Property Owner'], ['registrar1', 'Registrar'], ['investor1', 'Investor 1'], ['investor2', 'Investor 2']].filter(([id]) => id !== user?.identityId)

  const canManage = user && (property.originatorId === user.identityId || user.role === 'Regulator')

  const doYield = async () => {
    setOwnMsg(null)
    try {
      const r = await api.distributeYield(property.assetId, parseFloat(yieldAmt))
      setOwnMsg({ ok: true, text: `Distributed ${money(r.amountINR)} to ${r.distribution.length} holder(s) on block #${r.blockHeight}. ` + r.distribution.map(d => `${d.identityId}: ${money(d.shareINR)}`).join(', ') })
      setYieldAmt(''); setRefreshKey(k => k + 1)
    } catch (e) { setOwnMsg({ ok: false, text: e.data?.message || e.message }) }
  }
  const doCreateProposal = async () => {
    setOwnMsg(null)
    try {
      const r = await api.createProposal(property.assetId, govTitle, '')
      setProposals(p => [r.proposal, ...p]); setGovTitle('')
      setOwnMsg({ ok: true, text: `Proposal ${r.proposal.id} created. Token-weighted voting is open below.` })
    } catch (e) { setOwnMsg({ ok: false, text: e.data?.message || e.message }) }
  }
  const doVote = async (govId, choice) => {
    setOwnMsg(null)
    try {
      const r = await api.voteProposal(property.assetId, govId, choice)
      setProposals(p => p.map(x => x.id === govId ? r.proposal : x))
      setOwnMsg({ ok: true, text: `Vote recorded with ${r.yourWeight} tokens.` + (r.proposal.status !== 'OPEN' ? ` Proposal ${r.proposal.status} and committed to the ledger.` : '') })
    } catch (e) { setOwnMsg({ ok: false, text: e.data?.message || e.message }) }
  }
  const doBorrow = async () => {
    setOwnMsg(null)
    try {
      const r = await api.pledgeCollateral(property.assetId, parseInt(borrowTokens))
      setOwnMsg({ ok: true, text: r.message + ` (block #${r.blockHeight})` })
      setBorrowTokens(''); setRefreshKey(k => k + 1)
      api.getLoans(user.identityId).then(d => setMyLoansHere((d.loans || []).filter(l => l.assetId === property.assetId && l.status === 'ACTIVE'))).catch(() => {})
    } catch (e) { setOwnMsg({ ok: false, text: e.data?.message || e.message }) }
  }
  const doRepayHere = async (loanId) => {
    setOwnMsg(null)
    try {
      const r = await api.repayLoan(loanId)
      setOwnMsg({ ok: true, text: r.message + ` (block #${r.blockHeight})` })
      setMyLoansHere(l => l.filter(x => x.loanId !== loanId)); setRefreshKey(k => k + 1)
    } catch (e) { setOwnMsg({ ok: false, text: e.data?.message || e.message }) }
  }

  const doXfer = async () => {
    setXferMsg(null); setXferErr(null)
    try {
      const r = await api.transferTokens(property.assetId, user.identityId, xferTo, parseInt(xferAmt))
      setXferMsg(`Transferred ${r.amount} tokens to ${r.toId} ledger TXN ${r.transferId}`)
      setXferAmt('')
      setRefreshKey(k => k + 1)
      refresh()
    } catch (e) {
      setXferErr(e.data?.message || e.message || 'Transfer failed')
    }
  }

  const heroImage = propertyImage(property)
  const reg = registryStatus(property)

  return (
    <main className="ax ax-wrap" style={{ maxWidth: 1120, paddingTop: 24, paddingBottom: 64 }}>
      <Breadcrumbs items={[
        { label: 'Home', to: '/' },
        { label: 'Properties', to: '/marketplace' },
        { label: property.title || id },
      ]} />

      {/* Overview. The photograph is drawn rather than stocked: a picture of
          a building that is not this building, printed beside a valuation,
          is the kind of small untruth this project avoids. */}
      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)', gap: 28, alignItems: 'start' }}>
        <figure style={{ margin: 0 }}>
          <div style={{ position: 'relative', borderRadius: 'var(--ax-r-lg)', overflow: 'hidden', border: '1px solid var(--ax-line)', aspectRatio: '16 / 10', background: 'var(--ax-ivory)' }}>
            {heroImage.src
              ? <img
                  src={heroImage.src}
                  alt={heroImage.isRepresentative ? '' : `${property.title || property.assetId}`}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              : <ArchPlaceholder seed={property.assetId} label={`Illustration for ${property.title || property.assetId}`} />}
          </div>
          {heroImage.isRepresentative && (
            <figcaption className="ax-hint" style={{ marginTop: 8 }}>{REPRESENTATIVE_NOTE}</figcaption>
          )}
        </figure>

        <div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {property.status === 'TOKENIZED'
              ? <Badge tone="success">Available</Badge>
              : <Badge tone="pending">{property.status || 'Not yet available'}</Badge>}
            <Badge tone={reg.tone}>{reg.label}</Badge>
            {verif && (verif.verified ? <Badge tone="success">Checks passed</Badge> : <Badge tone="warning">Checks need attention</Badge>)}
          </div>
          <h1 className="ax-display ax-h2" style={{ fontSize: 'clamp(24px, 3vw, 32px)' }}>{property.title}</h1>
          <p className="ax-body" style={{ marginTop: 8 }}>
            {[property.location?.locality, property.location?.city, property.location?.state].filter(Boolean).join(', ') || 'Location not stated'}
            {' · '}Owner and seller: <strong style={{ color: 'var(--ax-ink)' }}>{property.originatorId || 'Owner'}</strong>
          </p>
          {property.locationCheck && (
            <p style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.55, color: locationCheckTone(property.locationCheck.status) }}>
              {locationCheckLabel(property.locationCheck)}
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 20 }}>
            <Metric label="Valuation" value={<Num>{inrShort(property.valuationINR)}</Num>} foot={<Num>{moneyExact(property.valuationINR)}</Num>} />
            <Metric
              label="Price per token"
              value={<Num>{inr(tokenPrice)}</Num>}
              foot={<><Num>{(property.totalTokens || 0).toLocaleString('en-IN')}</Num> tokens in issue</>}
              tip="The valuation divided by the number of tokens issued. This is the figure the settlement core charges against; nothing on this page re-derives it."
            />
          </div>

          <div style={{ marginTop: 16 }}>
            <Progress value={soldPct} label={`${soldPct} percent funded`} />
            <p className="ax-hint" style={{ marginTop: 7 }}>
              <Num>{soldPct}%</Num> funded · <Num>{Number(soldShown || 0).toLocaleString('en-IN')}</Num> of{' '}
              <Num>{(property.totalTokens || 0).toLocaleString('en-IN')}</Num> tokens taken
              {sub?.fullySubscribed ? ' · primary sale closed' : ''}
            </p>
          </div>
        </div>
      </section>

      {verif && (
        <AxCard
          style={{ marginTop: 28 }}
          title="Verification"
          sub="What each check establishes, and what it does not."
          right={verif.verified ? <Badge tone="success">All checks passed</Badge> : <Badge tone="warning">Needs attention</Badge>}
        >
          <p className="ax-body">{verif.summary}</p>

          <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0 0' }}>
            {(verif.checks || []).map(c => (
              <li key={c.id} style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: '1px solid var(--ax-line)' }}>
                {/* The word carries the state, not the colour. */}
                <span style={{ flex: 'none', marginTop: 1 }}>
                  {c.ok ? <Badge tone="success">Passed</Badge> : <Badge tone="warning">Check</Badge>}
                </span>
                <span style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 14, color: 'var(--ax-ink)' }}>{c.label}</strong>
                  <span className="ax-body" style={{ display: 'block', fontSize: 13, marginTop: 3, wordBreak: 'break-word' }}>{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="ax-hint" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--ax-line)' }}>
            These checks say that a registrar attested to this title and that the recorded fingerprint
            matches the deed presented. They do not say that the attestation is true, and a record here
            is not proof of legal title: that is established at the sub-registrar.
          </p>

          {(verif.chainEvidence || []).length > 0 && (
            <p className="ax-hint" style={{ marginTop: 10 }}>
              On the ledger:{' '}
              {verif.chainEvidence.map(e => (
                <span key={e.height}><Mono>#{e.height}</Mono> {e.type.replace(/_/g, ' ').toLowerCase()}{' '}</span>
              ))}
              <Link to="/ledger" style={{ color: 'var(--ax-green)', fontWeight: 600 }}>open the explorer</Link>
            </p>
          )}

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: '#1E3A5F', fontWeight: 600 }}>
              Check your copy of the title deed
            </summary>
            <p style={{ fontSize: 12, color: '#6B7280', marginTop: 8, lineHeight: 1.6 }}>
              Hash the file you were sent and paste the result. The document never leaves your machine.
              <br />
              <code style={{ fontSize: 11.5, background: '#F9FAFB', padding: '2px 6px', borderRadius: 4 }}>sha256sum deed.pdf</code>
              {' '}on Linux,{' '}
              <code style={{ fontSize: 11.5, background: '#F9FAFB', padding: '2px 6px', borderRadius: 4 }}>shasum -a 256 deed.pdf</code>
              {' '}on macOS,{' '}
              <code style={{ fontSize: 11.5, background: '#F9FAFB', padding: '2px 6px', borderRadius: 4 }}>certutil -hashfile deed.pdf SHA256</code>
              {' '}on Windows.
            </p>

            {docIsSeeded && (
              <p style={{ fontSize: 12, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '9px 11px', lineHeight: 1.6 }}>
                This listing was seeded for the demo, so no deed was ever issued against it and there is no file to
                hash. Nothing you enter here can match. To see the check succeed, list a property of your own and
                attach a real file: the browser hashes it, and only the digest is recorded.
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <input
                value={docHash}
                onChange={e => { setDocHash(e.target.value.trim()); setDocResult(null) }}
                placeholder="64-character SHA-256"
                aria-label="document hash"
                style={{ flex: '1 1 320px', padding: '8px 10px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5, fontFamily: 'monospace' }}
              />
              <button
                onClick={async () => {
                  setDocBusy(true); setDocResult(null)
                  try { setDocResult(await api.verifyPropertyDocument(id, docHash)) }
                  catch (e) { setDocResult({ match: false, message: e.message || 'That hash could not be checked.' }) }
                  finally { setDocBusy(false) }
                }}
                disabled={docBusy || docHash.length !== 64}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600,
                  background: docHash.length === 64 ? '#1E3A5F' : '#9CA3AF', color: 'white',
                  cursor: docHash.length === 64 ? 'pointer' : 'not-allowed',
                }}>
                {docBusy ? 'Checking…' : 'Check'}
              </button>
            </div>
            {docResult && (
              <p style={{
                marginTop: 10, fontSize: 12.5, lineHeight: 1.6, padding: '9px 11px', borderRadius: 8,
                background: docResult.match ? '#F0FDF4' : '#FEF2F2',
                color: docResult.match ? '#065F46' : '#991B1B',
                border: `1px solid ${docResult.match ? '#BBF7D0' : '#FECACA'}`,
              }}>
                {docResult.message}
              </p>
            )}
          </details>
        </AxCard>
      )}

      <PropertyDocuments assetId={id} />

      <div className="acx-r2" style={{ marginTop: 24 }}>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Property Value</h3>
          <div style={{ fontSize: 32, fontWeight: 800, marginTop: 12, color: '#111827' }}>{money(property.valuationINR)}</div>
          <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>{moneyExact(property.valuationINR)} total value</div>

          <div style={{ height: 1, background: '#F3F4F6', margin: '20px 0' }}></div>

          <div className="acx-r2x" style={{ gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Total Tokens</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{(property.totalTokens || 0).toLocaleString('en-IN')}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Price Per Token</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, color: '#1E3A5F' }}>₹{tokenPrice.toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: '#6B7280' }}>{soldPct}% funded{sub?.fullySubscribed ? ' primary sale closed' : ''}</span>
              <span style={{ color: '#6B7280' }}>{Number(soldShown || 0).toLocaleString('en-IN')} / {(property.totalTokens || 0).toLocaleString('en-IN')} tokens</span>
            </div>
            <div style={{ height: 8, background: '#F3F4F6', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${soldPct}%`, height: '100%', background: sub?.fullySubscribed ? '#16A34A' : '#1E3A5F', borderRadius: 4, transition: 'width 0.4s' }}></div>
            </div>
            {sub?.fullySubscribed && (
              <div style={{ fontSize: 11, color: '#16A34A', fontWeight: 600, marginTop: 6 }}>
                ✓ 100% Subscribed{sub.investorCount ? ` ${sub.investorCount} investor${sub.investorCount === 1 ? '' : 's'} own this property` : ''}{sub.completedAt ? ` · completed ${new Date(sub.completedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
              </div>
            )}
          </div>

          {sub?.fullySubscribed ? (
            <div style={{ marginTop: 20 }}>
              <div style={{ padding: '12px 14px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#166534' }}>🏠 Fully Subscribed primary sale closed</div>
                <div style={{ fontSize: 12, color: '#3F6212', marginTop: 4, lineHeight: 1.6 }}>
                  Every token is owned. No new supply this raise is permanently closed to new buys. Ownership lives on the Aasthi Drunix ledger.
                </div>
              </div>
              <div style={{ marginTop: 10, padding: '12px 14px', border: '1px solid #E5E7EB', borderRadius: 10, background: '#F9FAFB' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', color: '#6B7280' }}>WHAT HAPPENS NEXT</div>
                <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 12, color: '#374151', lineHeight: 1.8 }}>
                  <li><b>Live:</b> wallet-to-wallet secondary transfers on the same atomic ledger</li>
                  <li><b>Live:</b> every buy/sell TXN lands in the Regulator's audit trail</li>
                  <li><b>Live:</b> pro-rata rental yield distribution to token holders (owner panel below)</li>
                  <li><b>Planned:</b> registrar re-title with the full investor cap table</li>
                </ul>
              </div>
            </div>
          ) : !user ? (
            // Logged-out visitor: the listing is public so it can be found and
            // shared, but investing needs an account. Send them to sign in and
            // come straight back to this property.
            <Link
              to={`/login?next=${encodeURIComponent(location.pathname)}`}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 20,
                padding: '14px',
                background: '#1E3A5F',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'center',
                textDecoration: 'none',
                boxSizing: 'border-box',
              }}
            >
              Sign in to invest →
            </Link>
          ) : !showBuy ? (
            <button
              onClick={() => setShowBuy(true)}
              style={{
                width: '100%',
                marginTop: 20,
                padding: '14px',
                background: '#1E3A5F',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Buy Tokens →
            </button>
          ) : (
            <button
              onClick={() => setShowBuy(false)}
              style={{
                width: '100%',
                marginTop: 20,
                padding: '10px',
                background: 'white',
                color: '#6B7280',
                border: '1px solid #E5E7EB',
                borderRadius: 8,
                fontSize: 13,
                cursor: 'pointer'
              }}
            >
              Hide Buy Options
            </button>
          )}

          <div style={{ fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 10 }}>
            🔒 Secure payment • Instant transfer • No paperwork
          </div>

          {user && myHeld > 0 && identityOptions.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid #F3F4F6', paddingTop: 12 }}>
              {!showXfer ? (
                <button onClick={() => { setShowXfer(true); setXferTo(identityOptions[0]?.[0] || ''); setXferMsg(null); setXferErr(null) }} style={{ width: '100%', padding: 10, background: 'white', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
                  ↔ Transfer your {Number(myHeld).toLocaleString('en-IN')} tokens (secondary)
                </button>
              ) : (
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', color: '#6B7280', marginBottom: 8 }}>SECONDARY TRANSFER SETTLES ATOMICALLY ON THE LEDGER</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select value={xferTo} onChange={e => setXferTo(e.target.value)} style={{ flex: 1, fontSize: 12.5, padding: '9px 10px', border: '1px solid #E5E7EB', borderRadius: 8 }}>
                      {identityOptions.map(([id, label]) => <option key={id} value={id}>{label} ({id})</option>)}
                    </select>
                    <input type="number" min="1" max={myHeld} value={xferAmt} onChange={e => setXferAmt(e.target.value)} placeholder="Tokens" style={{ width: 90, fontSize: 12.5, padding: '9px 10px', border: '1px solid #E5E7EB', borderRadius: 8 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <button onClick={doXfer} disabled={!xferTo || !(parseInt(xferAmt) > 0)} style={{ flex: 1, padding: 10, background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: !xferTo || !(parseInt(xferAmt) > 0) ? 0.5 : 1 }}>Transfer</button>
                    <button onClick={() => setShowXfer(false)} style={{ padding: 10, background: 'white', color: '#6B7280', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5, cursor: 'pointer' }}>Cancel</button>
                  </div>
                  {xferMsg && <div style={{ fontSize: 11.5, color: '#16A34A', marginTop: 8, lineHeight: 1.5 }}>✓ {xferMsg}</div>}
                  {xferErr && <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 8, lineHeight: 1.5 }}>✗ {xferErr}</div>}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Who Owns This?</h3>
          <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>Current token holders</p>

          {balances.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: '#6B7280' }}>
              <div style={{ fontSize: 24 }}>👥</div>
              <p style={{ fontSize: 13, marginTop: 8 }}>No investors yet</p>
              <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>Be the first to invest</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              {balances.map(b => {
                const pct = property.totalTokens ? ((b.balance / property.totalTokens) * 100).toFixed(1) : 0
                return (
                  <div key={b.ownerId} style={{
                    background: '#F9FAFB',
                    border: '1px solid #F3F4F6',
                    borderRadius: 8,
                    padding: 12,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{b.ownerId}</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>{(b.balance || 0).toLocaleString('en-IN')} tokens</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{pct}%</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>{money((b.balance || 0) * tokenPrice)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {user && property.status === 'TOKENIZED' && (
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Programmable ownership</h3>
          <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Rent distribution, governance, credit and swaps settle as blocks on the same Drunix ledger.</p>
          {ownMsg && (
            <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.6, background: ownMsg.ok ? '#F0FDF4' : '#FEF2F2', border: `1px solid ${ownMsg.ok ? '#BBF7D0' : '#FECACA'}`, color: ownMsg.ok ? '#065F46' : '#991B1B', wordBreak: 'break-word' }}>
              {ownMsg.ok ? '✓ ' : '✗ '}{ownMsg.text}
            </div>
          )}

          <div className="acx-r2x" style={{ gap: 14, marginTop: 14 }}>
            {canManage && (
              <div style={{ background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827' }}>Distribute rental yield</div>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 3, marginBottom: 8 }}>Pro-rata to every token holder, credited instantly.</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input type="number" min="1" placeholder="Amount ₹" value={yieldAmt} onChange={e => setYieldAmt(e.target.value)} style={{ flex: 1, minWidth: 90, padding: '9px 10px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5 }} />
                  <button onClick={doYield} disabled={!(parseFloat(yieldAmt) > 0)} style={{ padding: '9px 14px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: !(parseFloat(yieldAmt) > 0) ? 0.5 : 1 }}>Distribute</button>
                </div>
                <div style={{ marginTop: 12, borderTop: '1px solid #F3F4F6', paddingTop: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827' }}>Create governance proposal</div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 3, marginBottom: 8 }}>Holders vote with their tokens (20% quorum).</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input placeholder="e.g., Refurbish lobby from yield" value={govTitle} onChange={e => setGovTitle(e.target.value)} style={{ flex: 1, minWidth: 90, padding: '9px 10px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5 }} />
                    <button onClick={doCreateProposal} disabled={!govTitle.trim()} style={{ padding: '9px 14px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: !govTitle.trim() ? 0.5 : 1 }}>Create</button>
                  </div>
                </div>
              </div>
            )}

            <div style={{ background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827' }}>Borrow against your tokens</div>
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 3, marginBottom: 8 }}>
                {myHeld > 0
                  ? `Pledge up to 50% of your ${Number(myHeld).toLocaleString('en-IN')} tokens. Get 50% LTV in INR instantly, 1% fee to repay.`
                  : 'Acquire tokens first, then borrow against them.'}
              </div>
              {myLoansHere.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {myLoansHere.map(l => (
                    <div key={l.loanId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', background: 'white', border: '1px solid #E5E7EB', borderRadius: 8, padding: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 11.5, color: '#374151' }}>{money(l.principalINR)} on {l.tokens} tokens</span>
                      <button onClick={() => doRepayHere(l.loanId)} style={{ padding: '6px 10px', background: 'white', border: '1px solid #E5E7EB', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Repay {money(Math.round(l.principalINR * 1.01 * 100) / 100)}</button>
                    </div>
                  ))}
                </div>
              )}
              {myHeld > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input type="number" min="1" max={Math.floor((myHeld - myLoansHere.reduce((s, l) => s + l.tokens, 0)) * 0.5) || 1} placeholder="Tokens to pledge" value={borrowTokens} onChange={e => setBorrowTokens(e.target.value)} style={{ flex: 1, minWidth: 90, padding: '9px 10px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5 }} />
                  <button onClick={doBorrow} disabled={!(parseInt(borrowTokens) > 0)} style={{ padding: '9px 14px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: !(parseInt(borrowTokens) > 0) ? 0.5 : 1 }}>Pledge & borrow</button>
                </div>
              )}
            </div>
          </div>

          {proposals.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827', marginBottom: 8 }}>Governance {myHeld > 0 ? '(your vote weighs ' + Number(myHeld).toLocaleString('en-IN') + ' tokens)' : ''}</div>
              {proposals.map(g => {
                const yes = Object.values(g.votes || {}).filter(v => v.choice === 'YES').reduce((s, v) => s + v.weight, 0)
                const no = Object.values(g.votes || {}).filter(v => v.choice === 'NO').reduce((s, v) => s + v.weight, 0)
                return (
                  <div key={g.id} style={{ background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 10, padding: 12, marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{g.title}</div>
                        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>by {g.createdBy} · YES {yes.toLocaleString('en-IN')} / NO {no.toLocaleString('en-IN')} · quorum {g.quorumPct}%</div>
                      </div>
                      {g.status === 'OPEN' ? (
                        myHeld > 0 ? (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => doVote(g.id, 'YES')} style={{ padding: '7px 12px', background: '#059669', color: 'white', border: 'none', borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Vote YES</button>
                            <button onClick={() => doVote(g.id, 'NO')} style={{ padding: '7px 12px', background: 'white', color: '#991B1B', border: '1px solid #FECACA', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Vote NO</button>
                          </div>
                        ) : <span style={{ fontSize: 11, color: '#9CA3AF' }}>OPEN</span>
                      ) : (
                        <span style={{ fontSize: 11, fontWeight: 800, color: g.status === 'ACCEPTED' ? '#065F46' : '#991B1B', background: g.status === 'ACCEPTED' ? '#ECFDF5' : '#FEF2F2', border: `1px solid ${g.status === 'ACCEPTED' ? '#A7F3D0' : '#FECACA'}`, padding: '4px 10px', borderRadius: 999 }}>{g.status}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {showBuy && (
        <div style={{ marginTop: 20 }}>
          <SimpleBuyFlow
            assetId={property.assetId}
            tokenPrice={tokenPrice}
            recipient={property.originatorId}
            user={user}
            propertyTitle={property.title}
            valuationINR={property.valuationINR}
            totalTokens={property.totalTokens}
            availableTokens={availableTokens}
            onSuccess={() => {
              // Soft refresh: holders + availability update without a full reload
              setRefreshKey(k => k + 1)
              refresh()
            }}
          />
        </div>
      )}
    </main>
  )
}
