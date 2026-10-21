import React, { useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost } from '../lib/umiFetch.js'

/**
 * Paying for property from outside India.
 *
 * The leg existed on the rail with no screen, which made the most
 * counter-intuitive part of the system invisible: a stablecoin cannot pay for
 * Indian property, so the rail converts it outside India and credits rupees
 * only against a remittance attestation. A refusal is as much the point of
 * this page as a quote, so refusals are shown in full rather than swallowed.
 *
 * Everything here reads and writes through umiFetch, which attaches who is
 * asking. The page computes nothing of its own.
 */

const STATUSES = [
  { id: 'NRI', label: 'NRI (Indian citizen abroad)' },
  { id: 'OCI', label: 'OCI cardholder' },
  { id: 'PIO', label: 'Person of Indian origin' },
  { id: 'RESIDENT', label: 'Resident in India' },
  { id: 'FOREIGN_NATIONAL', label: 'Foreign national, not of Indian origin' },
]

const STEP_TONE = {
  QUOTED: 'neutral',
  PAYMENT_RECORDED: 'live',
  OFFRAMPED: 'live',
  EXPIRED: 'bad',
}

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })

function Rules({ rules }) {
  if (!rules) return null
  return (
    <Card
      title="What this leg will and will not do"
      sub="Read before filling anything in. The constraint is the law, not the technology."
      right={<Tag tone="sim">Simulated</Tag>}
    >
      <div className="pg-kv">
        <div>Settles in</div>
        <div><b>{rules.settlementCurrency}</b>, through banking channels</div>
        <div>Accepted</div>
        <div>{(rules.acceptedStablecoins || []).join(', ')}</div>
        <div>May buy</div>
        <div>{(rules.eligibleBuyers || []).join(', ')}</div>
        <div>May not buy</div>
        <div>{(rules.ineligibleBuyers || []).join(', ')}</div>
        <div>Transfer information</div>
        <div>Full originator and beneficiary record above ${rules.travelRuleThresholdUSD}</div>
        <div>Quote holds for</div>
        <div>{rules.quoteLifeMinutes} minutes at an indicative {money(rules.indicativeRateINRPerUS)} per dollar</div>
      </div>
      <p className="pg-card-sub" style={{ marginTop: 12 }}>{rules.paymentChannel}</p>
      <p className="pg-card-sub" style={{ marginTop: 8 }}><b>Not possible here:</b> {rules.prohibited}</p>
      <p className="pg-card-sub" style={{ marginTop: 8 }}>{rules.taxNote}</p>
      <p className="pg-card-sub" style={{ marginTop: 8, opacity: 0.85 }}>{rules.disclaimer}</p>
    </Card>
  )
}

function Intent({ intent, onChanged }) {
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const act = async (path, body) => {
    setBusy(path); setErr('')
    const { ok, data } = await umiPost('/crossborder/' + encodeURIComponent(intent.id) + path, body || {})
    setBusy('')
    if (!ok) { setErr((data && data.message) || 'The rail refused that step.'); return }
    onChanged()
  }

  return (
    <Card
      title={intent.id + ' · ' + intent.assetId}
      sub={'Quoted ' + new Date(intent.quotedAt).toLocaleString('en-IN')}
      right={<Tag tone={STEP_TONE[intent.status] || 'neutral'}>{intent.status.replace(/_/g, ' ').toLowerCase()}</Tag>}
    >
      <div className="pg-kv">
        <div>Purchase</div>
        <div>{money(intent.amountINR)}</div>
        <div>You send</div>
        <div>{intent.amountCoin} {intent.stablecoin} on {intent.network}</div>
        <div>Rate</div>
        <div>{money(intent.rateINRPerUnit)} per unit ({intent.rateSource})</div>
        <div>Send to</div>
        <div><code>{intent.payTo}</code>, {intent.payToIs}</div>
        <div>Transfer information</div>
        <div>{intent.travelRuleApplied ? 'Collected: above the threshold' : 'Not required at this size'}</div>
        <div>Quote expires</div>
        <div>{new Date(intent.expiresAt).toLocaleString('en-IN')}</div>
        {intent.transferRef ? (<><div>Transfer reference</div><div><code>{intent.transferRef}</code>, recorded, not verified</div></>) : null}
        {intent.offrampAdviceRef ? (<><div>Bank advice</div><div><code>{intent.offrampAdviceRef}</code>, purpose code {intent.purposeCode}</div></>) : null}
        {intent.creditedINR ? (<><div>Credited to your wallet</div><div><b>{money(intent.creditedINR)}</b>, net of the provider spread</div></>) : null}
      </div>

      {err && <div className="pg-card pg-empty" style={{ marginTop: 12 }}>{err}</div>}

      {intent.status === 'QUOTED' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input
            className="pg-input"
            placeholder="Transfer reference from your wallet"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
          <button className="pg-btn" disabled={!ref.trim() || busy} onClick={() => act('/payment', { transferRef: ref.trim() })}>
            {busy ? 'Recording…' : 'I have sent it'}
          </button>
        </div>
      )}

      {intent.status === 'PAYMENT_RECORDED' && (
        <div style={{ marginTop: 12 }}>
          <button className="pg-btn" disabled={busy} onClick={() => act('/offramp')}>
            {busy ? 'Converting…' : 'Run the off-ramp and remit rupees'}
          </button>
          <p className="pg-card-sub" style={{ marginTop: 8 }}>
            The provider converts outside India and attests the inward remittance. Only that credits your rupee wallet.
          </p>
        </div>
      )}

      {intent.status === 'OFFRAMPED' && (
        <p className="pg-card-sub" style={{ marginTop: 12 }}>
          Funded. The purchase now settles through the ordinary delivery-versus-payment path, in rupees.
        </p>
      )}
    </Card>
  )
}

export default function CrossBorder() {
  const [rules, setRules] = useState(null)
  const [intents, setIntents] = useState([])
  const [err, setErr] = useState('')
  const [refusal, setRefusal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    assetId: 'PROP-GREEN-VALLEY-PUNE-001',
    amountINR: 885000,
    stablecoin: 'USDC',
    buyerStatus: 'NRI',
    nationality: 'INDIA',
    kycRef: 'KYC-7781',
  })

  const load = async () => {
    const r = await umiFetch('/crossborder/rules')
    if (r.ok) setRules(r.data)
    const m = await umiFetch('/crossborder?limit=20')
    if (m.ok) setIntents((m.data && m.data.intents) || [])
    else setErr((m.data && m.data.message) || 'Sign in to see your funding requests.')
  }

  useEffect(() => { load() }, [])

  const party = (name) => ({
    name, address: '1 Example Street, Dubai', country: 'AE',
    accountRef: '0xabc0000000000000000000000000000000000001',
  })

  const ask = async (e) => {
    e.preventDefault()
    setBusy(true); setRefusal(null)
    const { ok, data } = await umiPost('/crossborder', {
      ...form,
      amountINR: Number(form.amountINR),
      originator: party('Buyer'),
      beneficiary: party('Off-ramp provider'),
    })
    setBusy(false)
    if (!ok) { setRefusal(data || {}); return }
    load()
  }

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <PageShell
      eyebrow="Cross-border funding"
      title="Paying from outside India"
      lede="Tokens cross a border easily; the money for Indian property does not. The law wants rupees through banking channels, and a foreign national of non-Indian origin cannot buy here whatever they pay with. So the stablecoin is converted outside India and your rupee wallet is credited only against a remittance attestation."
      badge={<Tag tone="sim">Simulated leg: no chain is connected, no custody is held and no money moves</Tag>}
    >
      <Rules rules={rules} />

      <Card title="Ask for a funding quote" sub="Eligibility is checked before a quote exists. Try the foreign national option to see the refusal.">
        <form onSubmit={ask} style={{ display: 'grid', gap: 10 }}>
          <div className="pg-kv">
            <div>Asset</div>
            <div><input className="pg-input" value={form.assetId} onChange={set('assetId')} /></div>
            <div>Amount</div>
            <div><input className="pg-input" type="number" value={form.amountINR} onChange={set('amountINR')} /></div>
            <div>Buyer status</div>
            <div>
              <select className="pg-input" value={form.buyerStatus} onChange={set('buyerStatus')}>
                {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div>Nationality</div>
            <div><input className="pg-input" value={form.nationality} onChange={set('nationality')} /></div>
            <div>KYC reference</div>
            <div><input className="pg-input" value={form.kycRef} onChange={set('kycRef')} /></div>
            <div>Stablecoin</div>
            <div>
              <select className="pg-input" value={form.stablecoin} onChange={set('stablecoin')}>
                <option value="USDC">USDC</option>
                <option value="EURC">EURC</option>
              </select>
            </div>
          </div>
          <div><button className="pg-btn" disabled={busy}>{busy ? 'Checking…' : 'Check and quote'}</button></div>
        </form>

        {refusal && (
          <div className="pg-card" style={{ marginTop: 12 }}>
            <Tag tone="bad">Refused</Tag>
            <p className="pg-card-sub" style={{ marginTop: 8 }}>{refusal.message || refusal.error}</p>
            <p className="pg-card-sub" style={{ marginTop: 8, opacity: 0.85 }}>
              The refusal is written to the ledger as a block, so the gate can be audited rather than taken on trust.
            </p>
          </div>
        )}
      </Card>

      {err && !intents.length && <div className="pg-card pg-empty">{err}</div>}
      {intents.map(i => <Intent key={i.id} intent={i} onChanged={load} />)}
    </PageShell>
  )
}
