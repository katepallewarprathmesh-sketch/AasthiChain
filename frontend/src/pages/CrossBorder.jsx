import React, { useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost } from '../lib/umiFetch.js'
import { useAssetCatalogue, labelFor, labelForProperty, assetRef } from '../lib/assetNames.js'

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

/**
 * The route that works, stated before the route that does not.
 *
 * The page used to open with the prohibition, which read as "this feature is
 * not supported" when the opposite is true: funding an Indian property
 * purchase from a stablecoin held abroad is supported end to end here. What
 * is prohibited is one particular shape of it, paying the seller in tokens.
 * Leading with the refusal made a working leg look ornamental.
 */
function HowItWorks({ rules }) {
  const steps = [
    {
      t: 'You send the stablecoin outside India',
      d: 'The quote names an address belonging to the off-ramp provider, never a seller and never an Indian account. Above the transfer-information threshold the originator and beneficiary record travels with it.',
    },
    {
      t: 'The provider converts and remits rupees through banking channels',
      d: 'Conversion happens outside India. What comes back is a bank advice reference and an RBI purpose code: the evidence that money entered the country the way the law requires.',
    },
    {
      t: 'Your rupee wallet is credited, and the purchase settles in rupees',
      d: 'Nothing is credited without that attestation. From there the purchase runs down the ordinary delivery-versus-payment path, identical to a domestic buyer.',
    },
  ]
  return (
    <Card
      title="How the money actually arrives"
      sub="Three steps, all of them available on this screen. The leg is simulated, not absent."
      right={<Tag tone="live">Supported route</Tag>}
    >
      <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 10 }}>
        {steps.map((s) => (
          <li key={s.t}>
            <b>{s.t}</b>
            <div className="pg-card-sub" style={{ marginTop: 2 }}>{s.d}</div>
          </li>
        ))}
      </ol>
      {rules && (
        <p className="pg-card-sub" style={{ marginTop: 12 }}>
          Eligible buyers: {(rules.eligibleBuyers || []).join(', ')}. A foreign national of non-Indian origin is
          refused at the first step, and that refusal is a restriction on the buyer rather than on the payment method.
        </p>
      )}
    </Card>
  )
}

function Rules({ rules }) {
  if (!rules) return null
  const rate = rules.rateINRPerUSD != null ? rules.rateINRPerUSD : rules.indicativeRateINRPerUS
  return (
    <Card
      title="The limits on that route"
      sub="The constraint is the law, not the technology."
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
        <div>{rules.quoteLifeMinutes} minutes at an indicative {money(rate)} per dollar</div>
      </div>
      <p className="pg-card-sub" style={{ marginTop: 12 }}>{rules.paymentChannel}</p>
      <p className="pg-card-sub" style={{ marginTop: 8 }}><b>Not possible here:</b> {rules.prohibited}</p>
      <p className="pg-card-sub" style={{ marginTop: 8 }}>{rules.taxNote}</p>
      <p className="pg-card-sub" style={{ marginTop: 8, opacity: 0.85 }}>{rules.disclaimer}</p>
    </Card>
  )
}

const ASSET_KINDS = ['RESIDENTIAL', 'COMMERCIAL', 'AGRICULTURAL', 'PLANTATION', 'FARMHOUSE']
const CONSIDERATIONS = [
  { id: 'INR_BANKING_CHANNEL', label: 'Rupees through banking channels' },
  { id: 'NRE', label: 'NRE account' },
  { id: 'NRO', label: 'NRO account' },
  { id: 'FCNR', label: 'FCNR account' },
  { id: 'CRYPTO', label: 'Pay the seller in tokens' },
  { id: 'CASH', label: 'Cash' },
]
const TX_KINDS = ['ACQUISITION', 'LEASE', 'TRANSFER', 'FUNDING']

// Constants are shouted on the rail and read better in a dropdown as words.
const prettyKind = (k) => k.charAt(0) + k.slice(1).toLowerCase()

/**
 * The rule set a transaction is tested against.
 *
 * Before this existed the statutory basis lived in prose on this page and in
 * a Go switch nobody outside the repository could read. Here the rules are
 * data: each one names the instrument it comes from, the evaluation runs all
 * of them rather than stopping at the first failure, and an undeclared
 * jurisdiction refuses rather than falling through to permitted.
 */
function Jurisdictions() {
  const [list, setList] = useState([])
  const [code, setCode] = useState('IN-MH')
  const [detail, setDetail] = useState(null)
  const [decision, setDecision] = useState(null)
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState({
    kind: 'ACQUISITION', buyerStatus: 'NRI', nationality: 'INDIA',
    assetKind: 'RESIDENTIAL', consideration: 'INR_BANKING_CHANNEL', amountINR: 10000000, leaseYears: 5,
  })

  useEffect(() => {
    umiFetch('/jurisdictions').then(r => { if (r.ok) setList((r.data && r.data.jurisdictions) || []) })
  }, [])
  useEffect(() => {
    setDecision(null)
    umiFetch('/jurisdictions/' + encodeURIComponent(code)).then(r => setDetail(r.ok ? r.data : null))
  }, [code])

  const evaluate = async (e) => {
    e.preventDefault()
    setBusy(true)
    const { ok, data } = await umiPost('/jurisdictions/evaluate', {
      kind: probe.kind,
      jurisdiction: code,
      buyerStatus: probe.buyerStatus,
      nationality: probe.nationality,
      assetKind: probe.assetKind,
      consideration: probe.consideration,
      amountPaise: Math.round(Number(probe.amountINR || 0) * 100),
      leaseYears: Number(probe.leaseYears || 0),
    })
    setBusy(false)
    setDecision(ok ? data : { error: true, message: (data && data.message) || 'The rail refused the request.' })
  }

  const set = (k) => (e) => setProbe(p => ({ ...p, [k]: e.target.value }))
  const j = detail && detail.jurisdiction

  return (
    <Card
      title="The rule set this is tested against"
      sub="Law as data, not as a paragraph. Every rule names the instrument it comes from."
      right={<Tag tone="sim">Modelled</Tag>}
    >
      <div className="pg-kv">
        <div>Jurisdiction</div>
        <div>
          <select className="pg-input" value={code} onChange={(e) => setCode(e.target.value)}>
            {list.map(x => (
              <option key={x.code} value={x.code}>{x.code} · {x.name} · {x.designation}</option>
            ))}
          </select>
        </div>
        {j && (
          <>
            <div>Designation</div>
            <div>
              <Tag tone={j.designation === 'DESIGNATED' ? 'live' : 'neutral'}>{j.designation}</Tag>
              {j.designatedSince ? ' since ' + j.designatedSince : ''}
            </div>
            <div>Stamp duty</div>
            <div>{(j.stampDutyBps / 100).toFixed(2)}% of consideration</div>
            <div>Registration fee</div>
            <div>
              {(j.registrationFeeBps / 100).toFixed(2)}%
              {j.registrationFeeCapPaise ? ', capped at ' + money(j.registrationFeeCapPaise / 100) : ''}
            </div>
          </>
        )}
      </div>
      {j && j.note && <p className="pg-card-sub" style={{ marginTop: 10 }}>{j.note}</p>}

      {detail && (detail.rules || []).length > 0 && (
        <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
          {detail.rules.map(r => (
            <div key={r.id} className="pg-card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{r.id}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{r.statement}</div>
              <div className="pg-card-sub" style={{ marginTop: 4 }}>{r.instrument}</div>
              {r.simplifiedTo && (
                <div className="pg-card-sub" style={{ marginTop: 4, opacity: 0.85 }}>
                  Simplified: {r.simplifiedTo}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={evaluate} style={{ display: 'grid', gap: 10, marginTop: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Test a transaction against it</div>
        <div className="pg-kv">
          <div>Transaction</div>
          <div>
            <select className="pg-input" value={probe.kind} onChange={set('kind')}>
              {TX_KINDS.map(k => <option key={k} value={k}>{prettyKind(k)}</option>)}
            </select>
          </div>
          <div>Buyer status</div>
          <div>
            <select className="pg-input" value={probe.buyerStatus} onChange={set('buyerStatus')}>
              {STATUSES.map(st => <option key={st.id} value={st.id}>{st.label}</option>)}
            </select>
          </div>
          <div>Nationality</div>
          <div><input className="pg-input" value={probe.nationality} onChange={set('nationality')} /></div>
          <div>Asset kind</div>
          <div>
            <select className="pg-input" value={probe.assetKind} onChange={set('assetKind')}>
              {ASSET_KINDS.map(k => <option key={k} value={k}>{prettyKind(k)}</option>)}
            </select>
          </div>
          <div>Consideration</div>
          <div>
            <select className="pg-input" value={probe.consideration} onChange={set('consideration')}>
              {CONSIDERATIONS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div>Amount</div>
          <div><input className="pg-input" type="number" value={probe.amountINR} onChange={set('amountINR')} /></div>
          {probe.kind === 'LEASE' && (
            <>
              <div>Lease years</div>
              <div><input className="pg-input" type="number" value={probe.leaseYears} onChange={set('leaseYears')} /></div>
            </>
          )}
        </div>
        <div><button className="pg-btn" disabled={busy}>{busy ? 'Evaluating…' : 'Evaluate'}</button></div>
      </form>

      {decision && decision.error && (
        <div className="pg-card" style={{ marginTop: 12 }}>
          <Tag tone="bad">Refused</Tag>
          <p className="pg-card-sub" style={{ marginTop: 8 }}>{decision.message}</p>
        </div>
      )}

      {decision && !decision.error && (
        <div style={{ marginTop: 14 }}>
          <Tag tone={decision.allowed ? 'live' : 'bad'}>
            {decision.allowed ? 'Permitted' : 'Not permitted'}
          </Tag>
          <span className="pg-card-sub" style={{ marginLeft: 8 }}>
            {decision.rulesRun} rules ran, {decision.failed} failed
            {decision.block ? ', recorded at block ' + decision.block : ''}
          </span>
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            {(decision.results || []).map(r => (
              <div key={r.id} className="pg-card" style={{ padding: 12 }}>
                <Tag tone={r.passed ? 'live' : 'bad'}>{r.passed ? 'Passed' : 'Failed'}</Tag>
                <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6 }}>{r.id}</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>{r.statement}</div>
                {!r.passed && <div style={{ fontSize: 13, marginTop: 6 }}>{r.reason}</div>}
                <div className="pg-card-sub" style={{ marginTop: 4 }}>{r.instrument}</div>
              </div>
            ))}
          </div>
          {decision.indicativeCosts && (
            <div className="pg-kv" style={{ marginTop: 12 }}>
              <div>Stamp duty</div>
              <div>{money(decision.indicativeCosts.stampDutyPaise / 100)}</div>
              <div>Registration</div>
              <div>{money(decision.indicativeCosts.registrationFeePaise / 100)}</div>
              <div>Statutory total</div>
              <div><b>{money(decision.indicativeCosts.totalPaise / 100)}</b></div>
            </div>
          )}
          <p className="pg-card-sub" style={{ marginTop: 10, opacity: 0.85 }}>{decision.disclaimer}</p>
        </div>
      )}

      <p className="pg-card-sub" style={{ marginTop: 12, opacity: 0.85 }}>
        <b>What this is not:</b> a complete statement of the law, legal advice, or a register kept current
        against a gazette. Charges are indicative, state slabs and buyer-category rebates are not modelled,
        and the RERA check reads a declared flag rather than any state authority. What it does do is refuse
        by default: a jurisdiction nobody declared cannot transact here.
      </p>
    </Card>
  )
}

function Intent({ intent, properties, onChanged }) {
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
      title={intent.id + ' · ' + labelFor(intent.assetId, properties)}
      sub={'Quoted ' + new Date(intent.quotedAt).toLocaleString('en-IN')}
      right={<Tag tone={STEP_TONE[intent.status] || 'neutral'}>{intent.status.replace(/_/g, ' ').toLowerCase()}</Tag>}
    >
      <div className="pg-kv">
        <div>Property</div>
        <div>{labelFor(intent.assetId, properties)}<div className="pg-card-sub">{assetRef(intent.assetId)}</div></div>
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
        <div style={{ marginTop: 12 }}>
          <a className="pg-btn" href={'/property/' + encodeURIComponent(intent.assetId)}>Go to the property and buy</a>
          <p className="pg-card-sub" style={{ marginTop: 8 }}>
            Funded. The rupees are in your wallet and the purchase now settles through the ordinary
            delivery-versus-payment path, exactly as it would for a domestic buyer.
          </p>
        </div>
      )}
    </Card>
  )
}

export default function CrossBorder() {
  const { properties } = useAssetCatalogue()
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
    jurisdiction: 'IN-MH',
    assetKind: 'RESIDENTIAL',
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
      lede="An NRI, OCI or person of Indian origin holding USDC or EURC abroad can fund a purchase here: quote, send the coin to the off-ramp provider, and the rail credits rupees against the remittance attestation that comes back. What the law forbids is paying the seller in tokens, so that single step happens off-chain and outside India, and the rupees arrive through banking channels like any other inward remittance."
      badge={<Tag tone="sim">Simulated leg: no chain is connected, no custody is held and no money moves</Tag>}
    >
      <HowItWorks rules={rules} />
      <Rules rules={rules} />
      <Jurisdictions />

      <Card title="Ask for a funding quote" sub="Eligibility is checked before a quote exists. Try the foreign national option to see the refusal.">
        <form onSubmit={ask} style={{ display: 'grid', gap: 10 }}>
          <div className="pg-kv">
            <div>Property</div>
            <div>
              {properties.length ? (
                <select className="pg-input" value={form.assetId} onChange={set('assetId')}>
                  {!properties.some(p => p.assetId === form.assetId) && (
                    <option value={form.assetId}>{labelFor(form.assetId, properties)}</option>
                  )}
                  {properties.map(p => (
                    <option key={p.assetId} value={p.assetId}>{labelForProperty(p)}</option>
                  ))}
                </select>
              ) : (
                <input className="pg-input" value={form.assetId} onChange={set('assetId')} />
              )}
            </div>
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
            <div>Jurisdiction</div>
            <div>
              <select className="pg-input" value={form.jurisdiction} onChange={set('jurisdiction')}>
                <option value="IN-MH">IN-MH Maharashtra</option>
                <option value="IN-KA">IN-KA Karnataka</option>
                <option value="IN-TG">IN-TG Telangana</option>
                <option value="IN-WB">IN-WB West Bengal</option>
                <option value="IN">IN, state charges not modelled</option>
                <option value="XX-NOWHERE">XX-NOWHERE (undeclared, refuses)</option>
              </select>
            </div>
            <div>Asset kind</div>
            <div>
              <select className="pg-input" value={form.assetKind} onChange={set('assetKind')}>
                {ASSET_KINDS.map(k => <option key={k} value={k}>{prettyKind(k)}</option>)}
              </select>
            </div>
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
      {intents.map(i => <Intent key={i.id} intent={i} properties={properties} onChanged={load} />)}
    </PageShell>
  )
}
