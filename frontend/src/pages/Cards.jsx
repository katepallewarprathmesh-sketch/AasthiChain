import React, { useCallback, useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost } from '../lib/umiFetch.js'

/**
 * The card rail: what the money loses on the way, and how long it can be
 * taken back.
 *
 * WHY THIS PAGE EXISTS
 * Every other corridor in this system moves an amount and settles it. A card
 * does neither of those things cleanly. The merchant never receives what the
 * cardholder paid, because the issuer, the network and the acquirer each take
 * a cut first, and in India some of those cuts are capped by law rather than
 * negotiated. And an approval is not a payment: it is a guarantee that a
 * party who was not in the transaction can reverse for four months, or
 * eighteen on some grounds.
 *
 * Both halves are shown here because they are the two things that make card
 * money behave unlike ledger money, and both were previously described in a
 * sentence on the corridors page rather than implemented.
 *
 * WHAT IS REAL
 * The arithmetic, the statutory caps, the network deadlines and the liability
 * rules, each citing where it comes from. What is not real is the connection:
 * no scheme membership, no authorisation, no clearing, no money.
 */

const rupees = (paise) => '₹' + Number((paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const pct = (bps) => (Number(bps || 0) / 100).toFixed(2) + '%'
const dt = (iso) => { try { return new Date(iso).toLocaleString('en-IN') } catch { return String(iso || '') } }

const INSTRUMENTS = [
  { id: 'RUPAY_DEBIT', label: 'RuPay debit (charge-free by statute)' },
  { id: 'OTHER_DEBIT', label: 'Other debit (RBI capped)' },
  { id: 'CREDIT', label: 'Credit (no regulatory cap)' },
  { id: 'CREDIT_CROSS_BORDER', label: 'Credit, cross-border' },
]
const CHANNELS = [
  { id: 'ONLINE', label: 'Online' },
  { id: 'POS', label: 'Card present at a terminal' },
  { id: 'QR', label: 'QR code' },
]

const STATUS_TONE = {
  PRESENTED: 'neutral',
  CHARGED_BACK: 'bad',
  REPRESENTED: 'live',
  PRE_ARBITRATION: 'bad',
  ARBITRATION: 'bad',
  RESOLVED_MERCHANT: 'live',
  RESOLVED_ISSUER: 'bad',
}

/** What a payment costs, and who takes it. */
function Economics() {
  const [q, setQ] = useState({
    amountINR: 100000, instrument: 'CREDIT', channel: 'ONLINE', smallMerchant: false,
  })
  const [split, setSplit] = useState(null)
  const [err, setErr] = useState('')

  const price = useCallback(async (next) => {
    const body = {
      amountPaise: Math.round(Number(next.amountINR || 0) * 100),
      instrument: next.instrument, channel: next.channel, smallMerchant: next.smallMerchant,
    }
    const { ok, data } = await umiPost('/cards/price', body)
    if (ok) { setSplit(data); setErr('') } else { setSplit(null); setErr((data && data.message) || 'No published rate for that combination.') }
  }, [])

  useEffect(() => { price(q) }, [])

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    const next = { ...q, [k]: v }
    setQ(next); price(next)
  }

  const bar = (label, paise, colour) => {
    if (!split || !split.mdrPaise) return null
    const share = Math.max(0, Math.min(100, (paise / split.mdrPaise) * 100))
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span>{label}</span><span>{rupees(paise)}</span>
        </div>
        <div style={{ height: 8, background: '#F1F5F9', borderRadius: 4, marginTop: 4 }}>
          <div style={{ width: share + '%', height: '100%', background: colour, borderRadius: 4 }} />
        </div>
      </div>
    )
  }

  return (
    <Card
      title="Where the money actually goes"
      sub="A card payment is split three ways before the merchant sees it."
      right={<Tag tone="sim">Modelled</Tag>}
    >
      <div className="pg-kv">
        <div>Amount</div>
        <div><input className="pg-input" type="number" value={q.amountINR} onChange={set('amountINR')} /></div>
        <div>Instrument</div>
        <div>
          <select className="pg-input" value={q.instrument} onChange={set('instrument')}>
            {INSTRUMENTS.map(i => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        </div>
        <div>Acceptance</div>
        <div>
          <select className="pg-input" value={q.channel} onChange={set('channel')}>
            {CHANNELS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div>Small merchant</div>
        <div>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={q.smallMerchant} onChange={set('smallMerchant')} />
            {' '}turnover up to ₹20 lakh last financial year
          </label>
        </div>
      </div>

      {err && <div className="pg-card" style={{ marginTop: 12 }}><Tag tone="bad">Refused</Tag><p className="pg-card-sub" style={{ marginTop: 8 }}>{err}</p></div>}

      {split && (
        <div style={{ marginTop: 16 }}>
          <div className="pg-kv">
            <div>Merchant discount rate</div>
            <div>
              <b>{rupees(split.mdrPaise)}</b> at {pct(split.mdrBps)}
              {split.perTransactionCapApplied ? ' (the per-transaction ceiling bit first)' : ''}
              {split.statutoryRate ? ' ' : ''}
              {split.statutoryRate && <Tag tone="live">Statutory</Tag>}
            </div>
            <div>GST on the fee</div>
            <div>{rupees(split.gstOnFeePaise)} at 18%, charged on top rather than out of it</div>
            <div>Merchant receives</div>
            <div><b>{rupees(split.merchantReceivesPaise)}</b>, an effective cost of {pct(split.effectiveMerchantCostBps)}</div>
            {split.cardholderPaysPaise > split.amountPaise && (
              <>
                <div>Cardholder is billed</div>
                <div><b>{rupees(split.cardholderPaysPaise)}</b>, including {rupees(split.issuerFXMarkupPaise)} of issuer currency markup and {rupees(split.crossBorderAssessmentPaise)} of network assessment</div>
              </>
            )}
          </div>

          {split.mdrPaise > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>The split, to the paise</div>
              {bar('Interchange, to the issuing bank', split.interchangePaise, '#1D4ED8')}
              {bar('Scheme fee, to the network', split.schemeFeePaise, '#7C3AED')}
              {bar('Acquirer margin, what is left', split.acquirerMarginPaise, '#047857')}
              <p className="pg-card-sub" style={{ marginTop: 10 }}>
                These three sum to the merchant discount rate exactly. When a statutory ceiling bites, the
                issuer and the network are paid first and the acquirer absorbs the shortfall, which is why
                small-merchant debit acceptance is sold at a loss.
              </p>
            </div>
          )}

          <p className="pg-card-sub" style={{ marginTop: 10 }}><b>Authority:</b> {split.authority}</p>
          {split.note && <p className="pg-card-sub" style={{ marginTop: 8 }}>{split.note}</p>}
        </div>
      )}
    </Card>
  )
}

/** The published rules, before anyone transacts against them. */
function Posture({ posture }) {
  if (!posture) return null
  return (
    <Card title="The deadlines, before you need them" sub="The two networks run different clocks. A process written for one misses dates on the other.">
      <div style={{ display: 'grid', gap: 10 }}>
        {(posture.networks || []).map(n => (
          <div key={n.network} className="pg-card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 600 }}>{n.network}</div>
            <div className="pg-kv" style={{ marginTop: 8 }}>
              <div>Cardholder may file</div>
              <div>within {n.cardholderFilingDays} days, up to {n.extendedFilingDays} on delivery grounds</div>
              <div>Merchant answers</div>
              <div>{n.merchantResponseName}, within {n.merchantResponseDays} days</div>
              <div>Pre-arbitration</div>
              <div>{n.preArbitrationDays} days</div>
              <div>Arbitration</div>
              <div>filed within {n.arbitrationFilingDays} days, USD {n.arbitrationFeeUSD} to the loser</div>
            </div>
            <p className="pg-card-sub" style={{ marginTop: 8 }}>{n.note}</p>
          </div>
        ))}
      </div>
      <p className="pg-card-sub" style={{ marginTop: 12 }}><b>Liability shift:</b> {posture.liabilityShift}</p>
      <p className="pg-card-sub" style={{ marginTop: 8 }}><b>Invariant:</b> {posture.invariant}</p>
    </Card>
  )
}

/** One payment and the rung it has reached. */
function Dispute({ payment, codes, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [code, setCode] = useState('')

  const forNetwork = (codes || []).filter(c => c.network === payment.network)
  const chosen = code || (forNetwork[0] && forNetwork[0].code) || ''

  const step = async (path, body) => {
    setBusy(true); setMsg('')
    const { ok, data } = await umiPost('/cards/' + encodeURIComponent(payment.paymentId) + path, body || {})
    setBusy(false)
    if (!ok) setMsg((data && data.message) || 'Refused.')
    onChanged()
  }

  const s = payment.status
  return (
    <Card
      title={payment.paymentId + ' · ' + rupees(payment.amountPaise) + ' on ' + payment.network}
      sub={'Presented ' + dt(payment.presentedAt) + (payment.threeDSAuthenticated ? ' · cardholder authenticated through 3-D Secure' : ' · no 3-D Secure')}
      right={<Tag tone={STATUS_TONE[s] || 'neutral'}>{s.replace(/_/g, ' ')}</Tag>}
    >
      <div className="pg-kv">
        <div>Merchant keeps</div>
        <div>{rupees(payment.split.merchantReceivesPaise)} of {rupees(payment.amountPaise)}</div>
        <div>Currently liable</div>
        <div>{payment.liableParty ? <Tag tone={payment.liableParty === 'MERCHANT' ? 'bad' : 'live'}>{payment.liableParty}</Tag> : 'nobody, the payment stands'}</div>
        {payment.reasonCode && (<><div>Reason code</div><div>{payment.reasonCode}</div></>)}
        {payment.nextDeadlineAt && (<><div>Next deadline</div><div>{payment.nextDeadlineFor} by {dt(payment.nextDeadlineAt)}</div></>)}
        {payment.arbitrationFeeUSD > 0 && (<><div>Case fee</div><div>USD {payment.arbitrationFeeUSD}, paid by the losing side</div></>)}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {s === 'PRESENTED' && (
          <>
            <select className="pg-input" style={{ maxWidth: 320 }} value={chosen} onChange={(e) => setCode(e.target.value)}>
              {forNetwork.map(c => <option key={c.code} value={c.code}>{c.code} · {c.description}</option>)}
            </select>
            <button className="pg-btn" disabled={busy} onClick={() => step('/chargeback', { reasonCode: chosen })}>
              Issuer files a chargeback
            </button>
          </>
        )}
        {s === 'CHARGED_BACK' && (
          <button className="pg-btn" disabled={busy} onClick={() => step('/represent', { evidence: 'Delivery confirmation, the authentication record and the terms shown at checkout.' })}>
            Merchant answers with evidence
          </button>
        )}
        {s === 'REPRESENTED' && (
          <button className="pg-btn" disabled={busy} onClick={() => step('/prearbitrate', { detail: 'The cardholder maintains the goods never arrived.' })}>
            Issuer pre-arbitrates
          </button>
        )}
        {s === 'PRE_ARBITRATION' && (
          <>
            <button className="pg-btn" disabled={busy} onClick={() => step('/arbitrate', { merchantWins: true })}>
              Network rules for the merchant
            </button>
            <button className="pg-btn pg-btn-ghost" disabled={busy} onClick={() => step('/arbitrate', { merchantWins: false })}>
              Network rules for the issuer
            </button>
          </>
        )}
      </div>

      {msg && <p className="pg-card-sub" style={{ marginTop: 10 }}><b>Refused:</b> {msg}</p>}

      <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
        {(payment.history || []).map((h, i) => (
          <div key={i} className="pg-card" style={{ padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>
              {h.stage.replace(/_/g, ' ')} · {dt(h.at)} · {h.by}
              {h.block ? ' · block ' + h.block : ''}
            </div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{h.detail}</div>
            {h.deadlineThatApplied && <div className="pg-card-sub" style={{ marginTop: 4 }}>Clock: {h.deadlineThatApplied}</div>}
          </div>
        ))}
      </div>
    </Card>
  )
}

export default function Cards() {
  const [posture, setPosture] = useState(null)
  const [payments, setPayments] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    amountINR: 50000, network: 'VISA', instrument: 'CREDIT', channel: 'ONLINE', authenticated: false,
  })

  const load = useCallback(async () => {
    const p = await umiFetch('/cards/posture')
    if (p.ok) setPosture(p.data)
    const l = await umiFetch('/cards')
    if (l.ok) setPayments((l.data && l.data.payments) || [])
    else setErr((l.data && l.data.message) || 'Could not read the desk.')
  }, [])

  useEffect(() => { load() }, [load])

  const present = async (e) => {
    e.preventDefault()
    setBusy(true); setErr('')
    const { ok, data } = await umiPost('/cards', {
      network: form.network,
      amountPaise: Math.round(Number(form.amountINR || 0) * 100),
      instrument: form.instrument,
      channel: form.channel,
      threeDSAuthenticated: form.authenticated,
    })
    setBusy(false)
    if (!ok) setErr((data && data.message) || 'Refused.')
    load()
  }

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm(f => ({ ...f, [k]: v }))
  }

  return (
    <PageShell
      eyebrow="Card rail"
      title="Interchange and the dispute ladder"
      lede="A card payment is the only corridor here where the merchant does not receive what the buyer paid, and where a settled payment can be taken back four months later by somebody who was not party to it. This page shows both: the split between issuer, network and acquirer to the paise, and every rung of the chargeback ladder with the clock that governs it."
      badge={<Tag tone="sim">No scheme membership: nothing is authorised, cleared or settled with a network</Tag>}
    >
      <Economics />
      <Posture posture={posture} />

      <Card title="Present a payment and dispute it" sub="Authorise a card payment, then take it through the ladder. Authenticate it first to see the fraud route close.">
        <form onSubmit={present} style={{ display: 'grid', gap: 10 }}>
          <div className="pg-kv">
            <div>Amount</div>
            <div><input className="pg-input" type="number" value={form.amountINR} onChange={set('amountINR')} /></div>
            <div>Network</div>
            <div>
              <select className="pg-input" value={form.network} onChange={set('network')}>
                <option value="VISA">Visa</option>
                <option value="MASTERCARD">Mastercard</option>
              </select>
            </div>
            <div>Instrument</div>
            <div>
              <select className="pg-input" value={form.instrument} onChange={set('instrument')}>
                {INSTRUMENTS.map(i => <option key={i.id} value={i.id}>{i.label}</option>)}
              </select>
            </div>
            <div>Acceptance</div>
            <div>
              <select className="pg-input" value={form.channel} onChange={set('channel')}>
                {CHANNELS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div>3-D Secure</div>
            <div>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={form.authenticated} onChange={set('authenticated')} />
                {' '}the cardholder authenticated
              </label>
            </div>
          </div>
          <div><button className="pg-btn" disabled={busy}>{busy ? 'Presenting…' : 'Present the payment'}</button></div>
        </form>
        {err && <p className="pg-card-sub" style={{ marginTop: 10 }}><b>Refused:</b> {err}</p>}
      </Card>

      {payments.map(p => <Dispute key={p.paymentId} payment={p} codes={(posture && posture.reasonCodes) || []} onChanged={load} />)}

      <Card title="What this screen cannot do">
        <p className="pg-card-sub">
          There is no card here. This deployment holds no scheme membership and no PCI DSS attestation, so
          nothing is authorised with a network, nothing is presented into clearing, and no money moves on this
          desk. What is real is the arithmetic and the rules: the statutory caps cite the RBI circular and the
          Payment and Settlement Systems Act, the deadlines and case fees are the published network ones, and
          the liability shift behaves as it does in the rules, which means it protects a merchant against a
          fraud ground and does nothing at all against a goods-not-received one.
        </p>
        <p className="pg-card-sub" style={{ marginTop: 10 }}>
          The credit rate shown is a declared default of {pct(200)} rather than a regulated figure, because
          credit card acceptance in India carries no cap and is priced between the merchant, the acquirer and
          the network. Treat it as illustrative of the shape, not as a quote.
        </p>
      </Card>
    </PageShell>
  )
}
