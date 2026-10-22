import React, { useCallback, useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost, explainRail } from '../lib/umiFetch.js'

/**
 * The digital rupee layer, with a screen.
 *
 * Everything here already existed on the rail and could only be seen through
 * the API, which made the two most interesting behaviours invisible: money
 * that refuses to be spent outside its purpose, and a refund that pays itself
 * when an event is attested instead of when somebody files a claim.
 *
 * The page computes nothing: every number, including the conservation check
 * and both kinds of finality, comes from the rail exactly as the rail reports
 * it, and every action is the rail's own endpoint rather than a local edit.
 *
 * Actions are shown to a signed-in participant only, and the rail still
 * decides: issuing asks for a regulator, spending outside a purpose is
 * refused at the point of sale, and a corridor with no licence refuses by
 * name. A refusal is printed as the rail worded it rather than softened.
 */

const money = (paise) => '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })

const FINALITY_TONE = { FINAL: 'live', PROVISIONAL: 'sim' }
const STATUS_TONE = {
  SETTLED: 'live', RELEASED: 'live', OPEN: 'neutral', AWAITING_CLAIM: 'sim',
  AWAITING_FOREIGN_LEG: 'sim', REFUNDED: 'neutral', EXHAUSTED: 'neutral', EXPIRED: 'bad',
}

function Finality({ f }) {
  if (!f) return <span className="pg-card-sub">not recorded</span>
  return (
    <div>
      <Tag tone={FINALITY_TONE[f.financial] || 'neutral'}>
        {f.financial === 'FINAL' ? 'Financially final' : 'Financially provisional'}
      </Tag>{' '}
      <Tag tone="neutral">Block {f.blockHeight}</Tag>
      <p className="pg-card-sub" style={{ marginTop: 6 }}>{f.basis}</p>
      {f.settlementWindow && (
        <p className="pg-card-sub" style={{ marginTop: 4 }}><b>Still open:</b> {f.settlementWindow}</p>
      )}
    </div>
  )
}

function Overview({ status }) {
  if (!status) return null
  const c = status.conservation || {}
  return (
    <Card
      title="What this layer is"
      sub="A simulated digital rupee that lives on the ledger rather than in a table beside it."
      right={<Tag tone="sim">Simulated</Tag>}
    >
      <div className="pg-kv">
        <div>Issued</div><div>{money(c.issuedPaise)}</div>
        <div>Outstanding</div><div>{money(c.outstandingPaise)}</div>
        <div>Held in accounts</div><div>{money(c.heldInWalletsPaise)}</div>
        <div>Reserved for offline use</div><div>{money(c.offlineReservedPaise)}</div>
        <div>Locked against events</div><div>{money(c.lockedInConditions)}</div>
        <div>Supply conserved</div>
        <div>{c.conserved ? <Tag tone="live">Yes, issued equals held plus redeemed</Tag> : <Tag tone="bad">No</Tag>}</div>
      </div>
      <p className="pg-card-sub" style={{ marginTop: 12 }}>{c.meaning}</p>
      {status.finality && (
        <div style={{ marginTop: 14 }}>
          <h3 className="pg-card-title" style={{ fontSize: 16 }}>Two different kinds of final</h3>
          <p className="pg-card-sub" style={{ marginTop: 6 }}><b>Technical:</b> {status.finality.technical}</p>
          <p className="pg-card-sub" style={{ marginTop: 4 }}><b>Financial:</b> {status.finality.financial}</p>
        </div>
      )}
      <p className="pg-card-sub" style={{ marginTop: 12, opacity: 0.85 }}>{status.disclaimer}</p>
    </Card>
  )
}

function Accounts({ accounts }) {
  if (!accounts.length) return null
  return (
    <Card title="Accounts" sub="Balances in integer paise. Reserved and locked value sits inside the balance, not beside it.">
      <div style={{ overflowX: 'auto' }}>
        <table className="pg-table">
          <thead>
            <tr><th>Holder</th><th>Segment</th><th>KYC</th><th>Balance</th><th>Offline</th><th>Locked</th></tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.holder}>
                <td>{a.holder}</td>
                <td>{a.segment === 'WHOLESALE' ? 'Wholesale' : 'Retail'}</td>
                <td>{a.kycTier === 'FULL_KYC' ? 'Full' : 'Minimal'}</td>
                <td>{money(a.balancePaise)}</td>
                <td>{a.offlineReservedPaise ? money(a.offlineReservedPaise) : '-'}</td>
                <td>{a.lockedPaise ? money(a.lockedPaise) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Grants({ grants }) {
  if (!grants.length) return null
  return (
    <Card
      title="Money that can only be spent one way"
      sub="A sponsor binds funds to a purpose. The rail refuses a spend outside the rule at the point of sale, rather than reconciling it afterwards."
    >
      {grants.map((g) => {
        const cond = g.condition || {}
        return (
          <div key={g.grantId} className="pg-row" style={{ padding: '12px 0', borderTop: '1px solid #E2E8F0' }}>
            <div><b>{cond.purpose || 'Purpose-bound'}</b> {' '}
              <Tag tone={STATUS_TONE[g.status] || 'neutral'}>{g.status}</Tag>
            </div>
            <p className="pg-card-sub" style={{ marginTop: 4 }}>
              {money(g.amountPaise)} to {g.beneficiary}, {money(g.amountPaise - g.spentPaise)} left.
            </p>
            <p className="pg-card-sub" style={{ marginTop: 4 }}>
              Spendable at {(cond.merchantCategories || ['any merchant']).join(', ')}
              {cond.allowedStates && cond.allowedStates.length ? ' in ' + cond.allowedStates.join(', ') : ''}
              {cond.expiresAt ? ', until ' + new Date(cond.expiresAt).toLocaleDateString() : ''}.
            </p>
          </div>
        )
      })}
    </Card>
  )
}

function Conditions({ conditions }) {
  if (!conditions.length) return null
  return (
    <Card
      title="Refunds that pay themselves"
      sub="Money locked against an event. When the named party attests the event the payment happens immediately, with no claim filed and no form submitted. If the deadline passes without one, the money returns to the payer."
    >
      {conditions.map((c) => (
        <div key={c.conditionId} className="pg-row" style={{ padding: '12px 0', borderTop: '1px solid #E2E8F0' }}>
          <div>
            <b>{c.eventType.replace(/_/g, ' ').toLowerCase()}</b>{' '}
            <span className="pg-card-sub">{c.eventKey}</span>{' '}
            <Tag tone={STATUS_TONE[c.status] || 'neutral'}>{c.status}</Tag>
          </div>
          <p className="pg-card-sub" style={{ marginTop: 4 }}>
            {money(c.amountPaise)} from {c.payer} to {c.payee}, attested by {c.attestor}.
            {c.status === 'OPEN' ? ' Deadline ' + new Date(c.deadline).toLocaleString() + '.' : ''}
            {c.status === 'RELEASED' ? ' Paid ' + new Date(c.settledAt).toLocaleString() + '.' : ''}
            {c.status === 'REFUNDED' ? ' Returned to the payer when nobody attested the event.' : ''}
          </p>
          {c.finality && <Finality f={c.finality} />}
        </div>
      ))}
    </Card>
  )
}

function Corridors({ corridors, blocked }) {
  if (!corridors.length) return null
  return (
    <Card
      title="Crossing a border"
      sub="Five rails, each with its own authorisation, ceilings and settlement model. A payment is refused by the corridor that cannot carry it, and the missing authorisation is named."
    >
      <div style={{ overflowX: 'auto' }}>
        <table className="pg-table">
          <thead>
            <tr><th>Corridor</th><th>Settles</th><th>Ceiling</th><th>Usable here</th></tr>
          </thead>
          <tbody>
            {corridors.map((c) => {
              const missing = (blocked || {})[c.id]
              return (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    <div className="pg-card-sub">{c.settlementWindow}</div>
                  </td>
                  <td>{c.settlementModel === 'ATOMIC_ON_LEDGER' ? 'Atomically, here'
                    : c.settlementModel === 'HTLC_CROSS_LEDGER' ? 'Across two ledgers, hash-locked'
                      : 'Later, on somebody else\'s clock'}</td>
                  <td>{c.perTransactionCapPaise ? money(c.perTransactionCapPaise) : 'no fixed ceiling'}</td>
                  <td>{missing
                    ? <><Tag tone="bad">No</Tag><div className="pg-card-sub">needs {missing.join(', ')}</div></>
                    : <Tag tone="live">Yes</Tag>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Transfers({ transfers, user, reload }) {
  if (!transfers.length) return null
  const act = run(reload)
  return (
    <Card title="Cross-border payments" sub="Where each one actually sits, rather than whether a screen said done.">
      {transfers.map((t) => (
        <div key={t.transferId} className="pg-row" style={{ padding: '12px 0', borderTop: '1px solid #E2E8F0' }}>
          <div>
            <b>{money(t.amountPaise)}</b> {t.payer} to {t.payee}{' '}
            <Tag tone={STATUS_TONE[t.status] || 'neutral'}>{t.status.replace(/_/g, ' ').toLowerCase()}</Tag>
          </div>
          <p className="pg-card-sub" style={{ marginTop: 4 }}>{t.corridorId} · {t.purposeCode}{t.travelRuleApplied ? ' · originator and beneficiary recorded' : ''}{t.reportable ? ' · reportable' : ''}</p>
          <Finality f={t.finality} />
          {user && t.status === 'AWAITING_CLAIM' && (
            <ActionForm
              hint="Hash locked. Whoever knows the secret behind the lock can claim it; if nobody does before the timeout, the money goes back to the payer on its own."
              fields={[{ name: 'secret', label: 'Secret', placeholder: 'the preimage of the hash lock' }]}
              submitLabel="Claim"
              onSubmit={(f) => act(`/corridors/transfers/${encodeURIComponent(t.transferId)}/claim`, { secret: f.secret },
                (d) => `Claimed. The transfer is now ${String(d.transfer.status).toLowerCase()}.`)}
            />
          )}
          {user && t.status === 'AWAITING_FOREIGN_LEG' && (
            <ActionForm
              hint="The other leg settles on somebody else's books. Confirming here records that it arrived; until then this payment is recorded, not settled."
              fields={[]}
              submitLabel="Confirm the other leg"
              onSubmit={() => act(`/corridors/transfers/${encodeURIComponent(t.transferId)}/confirm`, {},
                (d) => `Confirmed. The transfer is now ${String(d.transfer.status).toLowerCase()}.`)}
            />
          )}
        </div>
      ))}
    </Card>
  )
}

function Movements({ movements }) {
  if (!movements.length) return null
  return (
    <Card title="Recent movements" sub="Every movement carries its screening and both finalities.">
      <div style={{ overflowX: 'auto' }}>
        <table className="pg-table">
          <thead>
            <tr><th>Kind</th><th>Amount</th><th>From</th><th>To</th><th>Mode</th><th>Final</th><th>Screening</th></tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.movementId}>
                <td>{m.kind.replace(/_/g, ' ').toLowerCase()}</td>
                <td>{money(m.amountPaise)}</td>
                <td>{m.from || "-"}</td>
                <td>{m.to || "-"}</td>
                <td>{m.mode === 'OFFLINE' ? 'Offline' : 'Online'}</td>
                <td><Tag tone={FINALITY_TONE[m.finality?.financial] || 'neutral'}>{m.finality?.financial || "-"}</Tag></td>
                <td>
                  {m.aml?.decision || "-"}
                  {m.aml?.reportable ? <div className="pg-card-sub">reportable</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}


// ---------------------------------------------------------------- actions --
//
// One form component for every action, because the shape is always the same:
// a few fields, one button, and the rail's answer printed verbatim. Hand
// rolling eight of these would have produced eight slightly different error
// behaviours.

function ActionForm({ fields, submitLabel, onSubmit, hint, busyLabel = 'Working' }) {
  const initial = {}
  for (const f of fields) initial[f.name] = f.value === undefined ? '' : f.value
  const [form, setForm] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const go = async (e) => {
    e.preventDefault()
    setBusy(true)
    setResult(null)
    try {
      const r = await onSubmit(form)
      setResult(r)
    } catch (err) {
      setResult({ ok: false, message: String(err && err.message ? err.message : err) })
    }
    setBusy(false)
  }

  return (
    <form onSubmit={go}>
      {hint && <p className="pg-card-sub" style={{ marginTop: 0, marginBottom: 12 }}>{hint}</p>}
      <div className="pg-grid" style={{ gap: 12 }}>
        {fields.map((f) => (
          <div key={f.name}>
            <label className="pg-field" htmlFor={'dr-' + f.name}>{f.label}</label>
            {f.options ? (
              <select id={'dr-' + f.name} className="pg-input" value={form[f.name]} onChange={set(f.name)}>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === 'checkbox' ? (
              <input id={'dr-' + f.name} type="checkbox" checked={!!form[f.name]} onChange={set(f.name)} />
            ) : (
              <input
                id={'dr-' + f.name}
                className="pg-input"
                type={f.type || 'text'}
                value={form[f.name]}
                placeholder={f.placeholder || ''}
                onChange={set(f.name)}
              />
            )}
            {f.note && <p className="pg-card-sub" style={{ marginTop: 4 }}>{f.note}</p>}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="pg-btn" type="submit" disabled={busy}>{busy ? busyLabel : submitLabel}</button>
      </div>
      {result && (
        <div style={{ marginTop: 12 }}>
          <Tag tone={result.ok ? 'live' : 'bad'}>{result.ok ? 'Done' : 'Refused'}</Tag>
          <p className="pg-card-sub" style={{ marginTop: 6 }}>{result.message}</p>
        </div>
      )}
    </form>
  )
}

// Every action funnels through here so a refusal always reads the same way:
// the rail's own sentence, never a rewrite of it.
const run = (reload) => async (path, body, say) => {
  const { ok, data } = await umiPost(path, body)
  if (ok) await reload()
  return { ok, message: ok ? say(data) : explainRail(data) }
}

const paise = (rupees) => Math.round(Number(rupees || 0) * 100)
const PURPOSES = ['P2P_FAMILY_MAINTENANCE', 'P2P_GIFT', 'GOODS_IMPORT', 'SERVICES_EXPORT', 'EDUCATION', 'TRAVEL']

function ActionDesk({ user, corridors, grants, reload }) {
  const [tab, setTab] = useState('issue')
  const act = run(reload)
  const me = (user && (user.identityId || user.id || user.username)) || ''
  const usable = ((corridors && corridors.corridors) || []).filter((c) => !((corridors && corridors.blockedCorridors) || {})[c.id])
  const blockedList = ((corridors && corridors.corridors) || []).filter((c) => ((corridors && corridors.blockedCorridors) || {})[c.id])

  if (!user) {
    return (
      <Card title="Doing something here" sub="Every action on this layer is recorded against a named participant.">
        <p className="pg-card-sub">
          Sign in to issue, transfer, lock money against an event, attest one, bind money to a purpose,
          carry value offline or send across a corridor. Reading needs no account; moving money does.
        </p>
      </Card>
    )
  }

  const tabs = [
    ['issue', 'Issue and redeem'],
    ['transfer', 'Transfer'],
    ['condition', 'Lock against an event'],
    ['attest', 'Attest an event'],
    ['grant', 'Bind to a purpose'],
    ['spend', 'Spend a grant'],
    ['offline', 'Offline value'],
    ['corridor', 'Send across a border'],
  ]

  return (
    <Card
      title="Doing something here"
      sub="These are the rail's own endpoints. The rail decides: a refusal is printed exactly as it was worded, including which authorisation or rule was missing."
      right={<Tag tone="neutral">Signed in as {me || user.role}</Tag>}
    >
      <div className="pg-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="pg-tab" onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'issue' && (
        <div className="pg-grid" style={{ gap: 24 }}>
          <ActionForm
            hint="Issuing creates money, so the rail asks for a regulator or an operator. A bank-funded issue is technically final immediately and financially provisional until its settlement window closes: both are shown separately rather than averaged into one word."
            fields={[
              { name: 'holder', label: 'Holder', value: me },
              { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '5000' },
              { name: 'segment', label: 'Segment', value: 'RETAIL', options: [{ value: 'RETAIL', label: 'Retail' }, { value: 'WHOLESALE', label: 'Wholesale' }] },
              { name: 'kycTier', label: 'KYC tier', value: 'MIN_KYC', options: [{ value: 'MIN_KYC', label: 'Minimal (caps apply)' }, { value: 'FULL_KYC', label: 'Full' }] },
              { name: 'bank', label: 'Funded from the bank rail', type: 'checkbox', value: false, note: 'Leave this off for a direct issue.' },
            ]}
            submitLabel="Issue"
            onSubmit={(f) => act('/cbdc/issue', {
              holder: f.holder, amountPaise: paise(f.amount), segment: f.segment,
              kycTier: f.kycTier, fundedByBankRail: !!f.bank,
            }, (d) => `${money(d.movement.amountPaise)} issued to ${d.account.holder}. Financially ${String(d.movement.finality.financial).toLowerCase()}, recorded in block ${d.movement.finality.blockHeight}.`)}
          />
          <ActionForm
            hint="Redeeming destroys money again, so the conservation check at the top of this page keeps balancing."
            fields={[
              { name: 'holder', label: 'Holder', value: me },
              { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '1000' },
            ]}
            submitLabel="Redeem"
            onSubmit={(f) => act('/cbdc/redeem', { holder: f.holder, amountPaise: paise(f.amount) },
              (d) => `${money(d.movement.amountPaise)} redeemed. Outstanding supply fell by the same amount.`)}
          />
        </div>
      )}

      {tab === 'transfer' && (
        <ActionForm
          hint="A transfer between two accounts on this layer is final when the block is written: there is no settlement window and no suspense account behind it."
          fields={[
            { name: 'from', label: 'From', value: me },
            { name: 'to', label: 'To', placeholder: 'originator1' },
            { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '500' },
          ]}
          submitLabel="Transfer"
          onSubmit={(f) => act('/cbdc/transfer', { from: f.from, to: f.to, amountPaise: paise(f.amount) },
            (d) => `${money(d.movement.amountPaise)} moved to ${d.movement.to}. Screening said ${String(d.movement.aml?.decision || 'nothing').toLowerCase()}.`)}
        />
      )}

      {tab === 'condition' && (
        <ActionForm
          hint="This is the refund nobody has to ask for. The money leaves the payer's spendable balance now and is paid to the payee the moment the named attestor reports the event. If the deadline passes first it returns to the payer without a claim."
          fields={[
            { name: 'payer', label: 'Payer', value: me },
            { name: 'payee', label: 'Payee', placeholder: 'originator1' },
            { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '3000' },
            { name: 'eventType', label: 'Event', value: 'POSSESSION_HANDOVER', placeholder: 'FLIGHT_CANCELLED' },
            { name: 'eventKey', label: 'Which one', placeholder: 'PROP-GREEN-VALLEY-PUNE-001' },
            { name: 'attestor', label: 'Who is trusted to report it', placeholder: 'registrar1' },
            { name: 'deadlineHours', label: 'Deadline in hours', type: 'number', value: '24' },
          ]}
          submitLabel="Lock the money"
          onSubmit={(f) => act('/cbdc/conditions', {
            payer: f.payer, payee: f.payee, amountPaise: paise(f.amount),
            eventType: f.eventType, eventKey: f.eventKey, attestor: f.attestor,
            deadlineHours: Number(f.deadlineHours || 24),
          }, (d) => `${money(d.condition.amountPaise)} locked. ${d.condition.attestor} can release it until ${new Date(d.condition.deadline).toLocaleString()}.`)}
        />
      )}

      {tab === 'attest' && (
        <ActionForm
          hint="Reporting an event releases only the conditions that named you as their attestor. Anything else stays locked, which is the whole safeguard: saying a flight was cancelled does not let you empty somebody else's escrow."
          fields={[
            { name: 'eventType', label: 'Event', value: 'POSSESSION_HANDOVER' },
            { name: 'eventKey', label: 'Which one', placeholder: 'PROP-GREEN-VALLEY-PUNE-001' },
          ]}
          submitLabel="Report the event"
          onSubmit={(f) => act('/cbdc/events', { eventType: f.eventType, eventKey: f.eventKey },
            (d) => `${(d.released || []).length} condition(s) released, worth ${money((d.released || []).reduce((t, c) => t + c.amountPaise, 0))}. ${d.note || ''}`)}
        />
      )}

      {tab === 'grant' && (
        <ActionForm
          hint="Purpose-bound money: a food allowance that cannot buy fuel, a subsidy that works in one state only. The rule travels with the money and is checked when it is spent, not reconciled afterwards."
          fields={[
            { name: 'sponsor', label: 'Sponsor', value: me },
            { name: 'beneficiary', label: 'Beneficiary', placeholder: 'investor2' },
            { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '2000' },
            { name: 'purpose', label: 'Purpose', placeholder: 'Monthly food allowance' },
            { name: 'categories', label: 'Merchant categories', placeholder: 'GROCERY, PHARMACY', note: 'Comma separated. Leave blank for any merchant.' },
            { name: 'states', label: 'States', placeholder: 'Maharashtra', note: 'Comma separated. Leave blank for anywhere.' },
          ]}
          submitLabel="Bind the money"
          onSubmit={(f) => {
            const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean)
            return act('/cbdc/grants', {
              sponsor: f.sponsor, beneficiary: f.beneficiary, amountPaise: paise(f.amount),
              condition: { purpose: f.purpose, merchantCategories: list(f.categories), allowedStates: list(f.states) },
            }, (d) => `${money(d.grant.amountPaise)} bound to ${d.grant.condition.purpose || 'a purpose'} for ${d.grant.beneficiary}.`)
          }}
        />
      )}

      {tab === 'spend' && (
        <ActionForm
          hint="Try a spend that breaks the rule. A grocery grant presented at a fuel merchant is refused here, at the point of sale, with the reason named."
          fields={[
            { name: 'grantId', label: 'Grant', value: grants[0] ? grants[0].grantId : '', options: grants.length ? grants.map((g) => ({ value: g.grantId, label: `${(g.condition || {}).purpose || g.grantId} (${money(g.amountPaise - g.spentPaise)} left)` })) : undefined, placeholder: 'CBDC-GRANT-...' },
            { name: 'merchant', label: 'Merchant', placeholder: 'KIRANA-01' },
            { name: 'merchantCategory', label: 'Merchant category', placeholder: 'GROCERY' },
            { name: 'state', label: 'State', placeholder: 'Maharashtra' },
            { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '250' },
          ]}
          submitLabel="Spend"
          onSubmit={(f) => act(`/cbdc/grants/${encodeURIComponent(f.grantId)}/spend`, {
            merchant: f.merchant, merchantCategory: f.merchantCategory, state: f.state, amountPaise: paise(f.amount),
          }, (d) => `${money(d.movement.amountPaise)} spent at ${f.merchant}. ${money(d.grant.amountPaise - d.grant.spentPaise)} of the grant is left.`)}
        />
      )}

      {tab === 'offline' && (
        <OfflineDesk me={me} act={act} />
      )}

      {tab === 'corridor' && (
        <div className="pg-grid" style={{ gap: 24 }}>
          <ActionForm
            hint="Check first. This answers whether the corridor would carry the payment, what it would cost in delay, and which authorisation is missing if it would not, without moving anything."
            fields={[
              { name: 'corridorId', label: 'Corridor', value: (usable[0] && usable[0].id) || '', options: ((corridors && corridors.corridors) || []).map((c) => ({ value: c.id, label: c.name })) },
              { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '10000' },
              { name: 'purposeCode', label: 'Purpose', value: PURPOSES[0], options: PURPOSES.map((p) => ({ value: p, label: p.replace(/_/g, ' ').toLowerCase() })) },
            ]}
            submitLabel="Check"
            onSubmit={async (f) => {
              const { ok, data } = await umiPost('/corridors/check', { corridorId: f.corridorId, amountPaise: paise(f.amount), purposeCode: f.purposeCode, payer: me })
              if (!ok) return { ok: false, message: explainRail(data) }
              const c = data.check || {}
              return { ok: !!c.allowed, message: c.allowed
                ? `Allowed. Settles ${String(c.settlementModel || '').replace(/_/g, ' ').toLowerCase()}, ${c.settlementWindow || 'immediately'}.${c.travelRuleApplies ? ' Originator and beneficiary details are required at this amount.' : ''}`
                : `Refused: ${(c.reasons || [c.reason]).filter(Boolean).join('; ')}` }
            }}
          />
          <ActionForm
            hint="Sending puts the money where the settlement model says it goes. On an atomic corridor it is final in one block; on a hash-locked one it waits in suspense for the secret; on a bank corridor it is recorded and nothing settles until the window closes."
            fields={[
              { name: 'corridorId', label: 'Corridor', value: (usable[0] && usable[0].id) || '', options: ((corridors && corridors.corridors) || []).map((c) => ({ value: c.id, label: c.name })) },
              { name: 'payee', label: 'Payee', placeholder: 'investor2' },
              { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '10000' },
              { name: 'purposeCode', label: 'Purpose', value: PURPOSES[0], options: PURPOSES.map((p) => ({ value: p, label: p.replace(/_/g, ' ').toLowerCase() })) },
              { name: 'originator', label: 'Originator details', placeholder: 'required above the travel rule threshold' },
              { name: 'beneficiary', label: 'Beneficiary details', placeholder: 'required above the travel rule threshold' },
              { name: 'hashLock', label: 'Hash lock', placeholder: '64 hex characters, hash-locked corridor only' },
              { name: 'timeoutHours', label: 'Timeout in hours', type: 'number', value: '24' },
            ]}
            submitLabel="Send"
            onSubmit={(f) => act('/corridors/send', {
              corridorId: f.corridorId, payer: me, payee: f.payee, amountPaise: paise(f.amount),
              purposeCode: f.purposeCode, originator: f.originator, beneficiary: f.beneficiary,
              hashLock: f.hashLock, timeoutHours: Number(f.timeoutHours || 24),
            }, (d) => `${money(d.transfer.amountPaise)} on ${d.transfer.corridorId}: ${String(d.transfer.status).replace(/_/g, ' ').toLowerCase()}.`)}
          />
          {blockedList.length > 0 && (
            <p className="pg-card-sub">
              {blockedList.map((c) => c.name).join(' and ')} {blockedList.length > 1 ? 'are' : 'is'} listed but refuses every payment here,
              because this deployment holds none of the authorisations {blockedList.length > 1 ? 'they' : 'it'} needs. Sending anyway
              is the honest way to see what the refusal says.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

// Offline value is a two-step story, so the issued voucher has to survive
// between the two forms: it is the thing that was carried away from the
// ledger, and redeeming it is what proves it was only spent once.
function OfflineDesk({ me, act }) {
  const [voucher, setVoucher] = useState(null)

  return (
    <div className="pg-grid" style={{ gap: 24 }}>
      <ActionForm
        hint="Value reserved on the ledger and carried away from it: a signed voucher a receiving device can verify with no connectivity. The reservation stays inside the holder's balance, so the supply still conserves."
        fields={[
          { name: 'holder', label: 'Holder', value: me },
          { name: 'device', label: 'Device', placeholder: 'PHONE-01' },
          { name: 'amount', label: 'Amount in rupees', type: 'number', placeholder: '400' },
        ]}
        submitLabel="Issue a voucher"
        onSubmit={async (f) => {
          const r = await act('/cbdc/offline/issue', { holder: f.holder, device: f.device, amountPaise: paise(f.amount) },
            (d) => { setVoucher(d.voucher); return `Voucher ${d.voucher.voucherId} for ${money(d.voucher.amountPaise)}, usable until ${new Date(d.voucher.expiresAt).toLocaleString()}.` })
          return r
        }}
      />
      {voucher ? (
        <div>
          <p className="pg-card-sub" style={{ marginTop: 0 }}>
            Holding voucher <span className="pg-mono">{voucher.voucherId}</span> for {money(voucher.amountPaise)}.
            Redeem it twice: the second attempt is refused and names who redeemed it first.
          </p>
          <ActionForm
            fields={[{ name: 'payee', label: 'Redeem to', placeholder: 'originator1' }]}
            submitLabel="Redeem the voucher"
            onSubmit={(f) => act('/cbdc/offline/redeem', { voucher, payee: f.payee },
              (d) => `Redeemed to ${f.payee}. ${money(d.movement.amountPaise)} is back on the ledger and the reservation is released.`)}
          />
        </div>
      ) : (
        <p className="pg-card-sub">Issue a voucher first; it will appear here so it can be redeemed.</p>
      )}
    </div>
  )
}

// Screening is shown next to the money it stops, rather than in a compliance
// console nobody opens. The list is public: a person refused by a screen is
// entitled to see what they were screened against.
function Screening({ aml, cases, user, reload }) {
  const [checked, setChecked] = useState(null)
  if (!aml) return null
  const act = run(reload)
  const counts = aml.cases || {}

  return (
    <Card
      title="Sanctions and politically exposed person screening"
      sub="A name is matched against a list before the money moves. A match stops the payment and opens a case; a near match opens a case and lets a person decide, because a resemblance is a question rather than an answer."
      right={<Tag tone={aml.listIsSynthetic ? 'sim' : 'live'}>{aml.listIsSynthetic ? 'Synthetic list' : 'Configured list'}</Tag>}
    >
      <div className="pg-kv">
        <div>List</div><div>{aml.listName}</div>
        <div>Entries</div><div>{aml.listSize} ({aml.sanctionEntries} sanctions, {aml.pepEntries} politically exposed)</div>
        <div>Stops a payment at</div><div>{aml.thresholds?.block} similarity</div>
        <div>Opens a case at</div><div>{aml.thresholds?.review} similarity</div>
        <div>Cases</div>
        <div>{counts.OPEN || 0} open, {counts.UNDER_REVIEW || 0} in review, {counts.CLEARED || 0} cleared, {counts.REPORTED || 0} reported</div>
        <div>Reports produced</div><div>{aml.reports || 0}</div>
      </div>

      <div style={{ marginTop: 16 }}>
        <ActionForm
          hint="Screen a name without moving anything. This is the same check the payment path runs, against the same list."
          fields={[{ name: 'name', label: 'Name to screen', placeholder: 'Dmitri Volkanov' }]}
          submitLabel="Screen"
          onSubmit={async (f) => {
            const { ok, data } = await umiPost('/aml/screen', { name: f.name })
            if (!ok) return { ok: false, message: explainRail(data) }
            setChecked(data.screening)
            return { ok: data.screening.decision === 'CLEAR', message: data.screening.note }
          }}
        />
      </div>

      {checked && checked.matches && checked.matches.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 className="pg-card-title" style={{ fontSize: 16 }}>Why it matched</h3>
          {checked.matches.map((m) => (
            <div key={m.entry.listId + m.matchedOn} className="pg-row" style={{ padding: '10px 0', borderTop: '1px solid #E2E8F0' }}>
              <div>
                <b>{m.entry.name}</b>{' '}
                <Tag tone={m.entry.kind === 'PEP' ? 'neutral' : 'bad'}>{m.entry.kind === 'PEP' ? 'politically exposed' : 'sanctioned'}</Tag>{' '}
                <Tag tone="neutral">score {m.score}</Tag>
              </div>
              <p className="pg-card-sub" style={{ marginTop: 4 }}>
                Matched on {m.matchedOn}. {m.why}. Listed under {m.entry.programme}, source {m.entry.source}.
              </p>
            </div>
          ))}
        </div>
      )}

      {user && cases.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <h3 className="pg-card-title" style={{ fontSize: 16 }}>Open cases</h3>
          <p className="pg-card-sub">A hit is not a decision. Somebody reviews it, writes down what they concluded, and either clears it or escalates it into a report.</p>
          {cases.map((c) => (
            <div key={c.caseId} className="pg-row" style={{ padding: '12px 0', borderTop: '1px solid #E2E8F0' }}>
              <div>
                <b>{c.subject}</b>{' '}
                <Tag tone={c.status === 'CLEARED' ? 'live' : c.status === 'REPORTED' ? 'bad' : 'sim'}>{c.status.replace(/_/g, ' ').toLowerCase()}</Tag>
              </div>
              <p className="pg-card-sub" style={{ marginTop: 4 }}>
                {c.caseId}{c.relatedRef ? ' · ' + c.relatedRef : ''}{c.amountPaise ? ' · ' + money(c.amountPaise) : ''}
                {c.reviewer ? ' · reviewer ' + c.reviewer : ''}{c.reportId ? ' · report ' + c.reportId : ''}
              </p>
              {(c.notes || []).slice(-2).map((n, i) => (
                <p key={i} className="pg-card-sub" style={{ marginTop: 2 }}>{n.action.toLowerCase()}: {n.text}</p>
              ))}
              {(c.status === 'OPEN' || c.status === 'UNDER_REVIEW') && (
                <div className="pg-grid" style={{ gap: 16, marginTop: 8 }}>
                  <ActionForm
                    fields={[{ name: 'reason', label: 'Clear it, with grounds', placeholder: 'Same name, different passport and date of birth' }]}
                    submitLabel="Clear"
                    onSubmit={(f) => act(`/aml/cases/${encodeURIComponent(c.caseId)}/clear`, { reason: f.reason },
                      () => 'Cleared, with the grounds recorded against your name.')}
                  />
                  <ActionForm
                    fields={[
                      { name: 'grounds', label: 'Grounds for suspicion', placeholder: 'Name matches a listed entity; purpose inconsistent' },
                      { name: 'narrative', label: 'What was observed', placeholder: 'Payment to an entity matching a listed party, no documentation' },
                    ]}
                    submitLabel="Produce a report"
                    onSubmit={(f) => act(`/aml/cases/${encodeURIComponent(c.caseId)}/report`, {
                      grounds: String(f.grounds || '').split(';').map((x) => x.trim()).filter(Boolean),
                      narrative: f.narrative,
                    }, (d) => `Report ${d.report.reportId} produced, hash recorded in block ${d.report.blockHeight}. It has not been filed with anybody.`)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="pg-card-sub" style={{ marginTop: 14, opacity: 0.85 }}>{aml.disclaimer}</p>
    </Card>
  )
}

export default function DigitalRupee({ user = null }) {
  const [status, setStatus] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [grants, setGrants] = useState([])
  const [conditions, setConditions] = useState([])
  const [movements, setMovements] = useState([])
  const [corridors, setCorridors] = useState(null)
  const [transfers, setTransfers] = useState([])
  const [aml, setAml] = useState(null)
  const [amlCases, setAmlCases] = useState([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const get = async (path, fallback) => {
      const { ok, data } = await umiFetch(path)
      return ok ? data : fallback
    }
    const [st, acc, gr, co, mv, cor, tr, aml, amlCases] = await Promise.all([
      get('/cbdc', null),
      get('/cbdc/accounts', {}),
      get('/cbdc/grants', {}),
      get('/cbdc/conditions', {}),
      get('/cbdc/movements?limit=25', {}),
      get('/corridors', null),
      get('/corridors/transfers?limit=15', {}),
      get('/aml', null),
      get('/aml/cases?limit=10', {}),
    ])
    if (!st) setErr('This deployment does not have the digital rupee layer mounted.')
    setStatus(st)
    setAccounts(acc.accounts || [])
    setGrants(gr.grants || [])
    setConditions(co.conditions || [])
    setMovements(mv.movements || [])
    setCorridors(cor)
    setTransfers(tr.transfers || [])
    setAml(aml)
    setAmlCases(amlCases.cases || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <PageShell
      eyebrow="Digital rupee"
      title="Central bank money, on the ledger"
      lede="Money that can be bound to a purpose, carried offline, and released by a rule rather than a claim form. Both kinds of finality are shown separately, because a ledger entry and a settled payment are not the same thing."
      badge={<Tag tone="sim">Simulated. No central bank money is issued here.</Tag>}
    >
      {err && <Card title="Not available"><p className="pg-card-sub">{err}</p></Card>}
      {loading && !status && <Card title="Loading"><p className="pg-card-sub">Reading the rail.</p></Card>}
      <Overview status={status} />
      <ActionDesk user={user} corridors={corridors} grants={grants} reload={load} />
      <Conditions conditions={conditions} />
      <Grants grants={grants} />
      <Accounts accounts={accounts} />
      <Corridors corridors={(corridors && corridors.corridors) || []} blocked={corridors && corridors.blockedCorridors} />
      <Transfers transfers={transfers} user={user} reload={load} />
      <Screening aml={aml} cases={amlCases} user={user} reload={load} />
      <Movements movements={movements} />
      {status && accounts.length === 0 && (
        <Card title="Nothing has happened yet">
          <p className="pg-card-sub">
            No digital rupees have been issued on this deployment. The layer is mounted and the rules are
            enforced; there is simply nothing to show until money is issued.
          </p>
        </Card>
      )}
    </PageShell>
  )
}
