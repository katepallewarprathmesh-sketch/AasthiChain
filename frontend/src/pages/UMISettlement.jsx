// Aasthi Settlement Interface (ASI): our settlement rail, built to the
// pattern RBI's Unified Market Interface describes (SEBI Demat 2.0): a
// securities leg and a wholesale-CBDC cash leg that move as one.
//
// The name matters. This is our implementation, not a connection to the real
// UMI, and nothing here speaks to RBI or a depository. The API paths stay
// /api/umi/* because that is the pattern they implement.
//
// Securities leg: Drunix property-fraction tokens on the permissioned ledger.
// Cash leg: wholesale CBDC (e₹-W) wallets.
// Together: atomic DvP: both legs move in one block, or neither moves.
//
// ALL logic lives in Go (drunix-gateway/umi.go). This page is a thin client over
// /api/umi/*, which the Node server reverse-proxies to the Go rail. If the rail
// is not running the page says so plainly and nothing else in the app changes.

import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { prettifyAssetId } from '../lib/assetNames.js'
import { umiFetch as umi } from '../lib/umiFetch'
// These five panels sit below the settlement forms, which is the reason
// anyone opens this page. Loading them up front made the first paint wait
// for code most visitors scroll past, so they are split out and fetched
// when the page renders them rather than when it is requested.
const WorkDeskPanel = lazy(() => import('../components/WorkDeskPanel'))
const CarbonPanel = lazy(() => import('../components/CarbonPanel'))
const ThroughputPanel = lazy(() => import('../components/ThroughputPanel'))
const PrivateDataPanel = lazy(() => import('../components/PrivateDataPanel'))
const InteropPanel = lazy(() => import('../components/InteropPanel'))

function PanelFallback() {
  return <div className="pg-card pg-empty" style={{ marginTop: 16 }}>Loading…</div>
}

const C = {
  paper: '#F7F5F0', navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  ok: '#047857', okBg: '#ECFDF5', okLine: '#A7F3D0',
  bad: '#B91C1C', badBg: '#FEF2F2', badLine: '#FECACA',
  warn: '#B45309', warnBg: '#FFFBEB', warnLine: '#FDE68A',
}

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const num = (n) => Number(n || 0).toLocaleString('en-IN')

// The rail returns machine codes. Operators need a sentence that says what to do.
const ERRORS = {
  ERR_UMI_NO_IDENTITY: 'The rail could not tell who is asking. Sign in, then try again: this action is recorded against a named participant.',
  ERR_UMI_NOT_YOURS: 'That record belongs to another participant. Switch to their role, or ask as a regulator.',
  ERR_UMI_NOT_SUPERVISOR: 'Only a regulator or an operator can do this: it creates money rather than moving it.',
  ERR_UMI_NO_HOLDERS: 'Nobody holds this asset except the payer, so there is nobody to pay. Settle a DvP to a buyer first, then distribute.',
  ERR_UMI_INSUFFICIENT_CBDC: 'The buyer\u2019s e\u20B9-W wallet does not hold enough cash for this instruction. Use the top-up button shown above, or add cash in step 1, then retry.',
  ERR_UMI_INSUFFICIENT_TOKENS: 'The seller does not hold that many tokens. Open \u201CDemo setup\u201D to give them a starting position, or lower the token count.',
  ERR_UMI_INVALID_AMOUNT: 'Amount must be a positive number.',
  ERR_UMI_UNKNOWN_ASSET: 'No such assetId on the rail. Check the asset identifier.',
  ERR_UMI_SELF_TRADE: 'Buyer and seller are the same participant.',
}

const explain = (d) => {
  const code = d && d.error
  if (code && ERRORS[code]) return `${ERRORS[code]} (${code})`
  const msg = d && d.message && d.message !== code ? d.message : ''
  return [code || 'Request failed', msg].filter(Boolean).join(' \u2014 ')
}

// Result of an action, shown INSIDE the card that triggered it. An earlier
// version put this in a floating box at the bottom of the window, which read
// like a system alert detached from whatever the user had just clicked.
function Notice({ flash, where, onClose }) {
  if (!flash || flash.where !== where) return null
  const ok = flash.kind === 'ok'
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        marginTop: 12, padding: '10px 12px', borderRadius: 10, fontSize: 13,
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: ok ? C.okBg : C.badBg,
        border: `1px solid ${ok ? C.okLine : C.badLine}`,
        color: ok ? C.ok : C.bad,
      }}
    >
      <span aria-hidden="true" style={{ fontWeight: 700, lineHeight: 1.45 }}>{ok ? '✓' : '!'}</span>
      <span style={{ flex: 1, lineHeight: 1.45 }}>{flash.text}</span>
      <button onClick={onClose} aria-label="Dismiss"
        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 15, lineHeight: 1, padding: 0, opacity: .6 }}>×</button>
    </div>
  )
}

function Card({ title, sub, children, right }) {
  return (
    <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>{title}</h2>
          {sub && <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.mut, maxWidth: 760 }}>{sub}</p>}
        </div>
        {right}
      </div>
      <div style={{ marginTop: 14 }}>{children}</div>
    </section>
  )
}

function Pill({ tone = 'mut', children }) {
  const map = {
    ok: { c: C.ok, bg: C.okBg, b: C.okLine }, bad: { c: C.bad, bg: C.badBg, b: C.badLine },
    warn: { c: C.warn, bg: C.warnBg, b: C.warnLine }, mut: { c: C.mut, bg: '#F9FAFB', b: C.line },
  }[tone]
  return <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: .3, color: map.c, background: map.bg, border: `1px solid ${map.b}`, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>{children}</span>
}

const CONTROL_H = 37
// A select and a text input are drawn by the browser, not by us, and they do
// not agree on height from padding alone. Stating the height makes a row of
// mixed controls line up exactly.
const input = {
  height: CONTROL_H, boxSizing: 'border-box', padding: '8px 10px',
  border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13,
  minWidth: 0, width: '100%', background: 'white', color: C.navy,
}
const btn = (primary) => ({
  padding: '9px 16px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  border: primary ? 'none' : `1px solid ${C.line}`, background: primary ? C.navy : 'white', color: primary ? 'white' : C.navy,
})

export default function UMISettlement() {
  const [config, setConfig] = useState(null)
  const [railDown, setRailDown] = useState(null)
  const [wallets, setWallets] = useState([])
  const [instructions, setInstructions] = useState([])
  const [recon, setRecon] = useState(null)
  const [isins, setIsins] = useState([])
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)
  const [open, setOpen] = useState(null)

  const [assetId, setAssetId] = useState('PROP-GREEN-VALLEY-PUNE-001')
  const [seller, setSeller] = useState('originator1')
  const [buyer, setBuyer] = useState('investor1')
  const [tokens, setTokens] = useState(100)
  const [price, setPrice] = useState(500)
  const [fundWho, setFundWho] = useState('investor1')
  const [fundAmt, setFundAmt] = useState(100000)
  const [servAmt, setServAmt] = useState(6000)
  // Card 3 used to borrow card 2's assetId and seller, so it silently acted on
  // a property the reader never chose there. It picks its own now.
  const [servAsset, setServAsset] = useState('PROP-GREEN-VALLEY-PUNE-001')
  const [servPayer, setServPayer] = useState('originator1')
  const [properties, setProperties] = useState([])
  // The page opened straight onto five operator cards: wallets, raw ids,
  // ISO 20022 traces. That is the right screen for someone running a
  // settlement rail and the wrong one for everybody else, so the detail is
  // now opt-in and the default view is the one thing people come here to do.
  // The rail used to open folded into a single buy box, so the wallets,
  // instructions and reconciliation: the part that shows it is a real
  // settlement rail: were behind a link nobody clicked. Open it all.
  const [mode, setMode] = useState('advanced')
  // Result of a silent dry run against the current inputs. The rail can tell
  // us whether this trade would settle without moving anything, so there is
  // no reason to let someone click into a red error to find out.
  const [preflight, setPreflight] = useState(null)

  // Defining a basket was curl-only: investors could create, sell and redeem
  // units from the dashboard, but the basket itself had to be POSTed by hand.
  // The recipe is the whole contract of the instrument, so it is spelled out
  // per unit rather than hidden behind an id.
  const [baskets, setBaskets] = useState([])
  const [bId, setBId] = useState('PUNE-MUMBAI')
  const [bName, setBName] = useState('Pune + Mumbai Residential')
  const [legs, setLegs] = useState([
    { assetId: '', tokensPerUnit: 2, indicativePriceINR: 500 },
    { assetId: '', tokensPerUnit: 1, indicativePriceINR: 900 },
  ])
  const setLeg = (i, k, v) => setLegs(ls => ls.map((l, n) => (n === i ? { ...l, [k]: v } : l)))

  const refresh = useCallback(async () => {
    const cfg = await umi('/config')
    if (!cfg.ok) { setRailDown(cfg.data); return }
    setRailDown(null)
    setConfig(cfg.data)
    const [w, i, r, s] = await Promise.all([umi('/wallets'), umi('/instructions?limit=25'), umi('/reconciliation'), umi('/isin')])
    setWallets(w.data.wallets || [])
    setInstructions(i.data.instructions || [])
    setRecon(r.data)
    setIsins(s.data.register || [])
    const bk = await umi('/baskets')
    setBaskets(bk.ok ? (bk.data.baskets || []) : [])
    try {
      const pr = await fetch('/api/properties')
      const pd = await pr.json()
      const list = (Array.isArray(pd) ? pd : pd.properties || []).filter(x => x.assetId)
      setProperties(list)
    } catch { /* pickers fall back to the ids already selected */ }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Results stay put until the next action or an explicit dismiss: they sit
  // inside the relevant card now, so nothing is covering the page while a
  // user reads them.
  const run = async (fn, okMsg, where) => {
    setBusy(where || true); setFlash(null)
    try {
      const res = await fn()
      if (res.ok) setFlash({ kind: 'ok', where, text: okMsg(res.data) })
      else setFlash({ kind: 'err', where, text: explain(res.data) })
      await refresh()
      return res
    } catch (e) {
      setFlash({ kind: 'err', where, text: e.message })
    } finally { setBusy(false) }
  }

  const createBasket = () => run(
    () => umi('/baskets', {
      body: {
        basketId: bId.trim(),
        name: bName.trim() || bId.trim(),
        components: legs
          .filter(l => l.assetId && Number(l.tokensPerUnit) > 0)
          .map(l => ({
            assetId: l.assetId,
            tokensPerUnit: Number(l.tokensPerUnit),
            indicativePriceINR: Number(l.indicativePriceINR) || 0,
          })),
      },
    }),
    (d) => `Basket ${d.basket.basketId} defined · one unit = ${d.basket.components.map(x => `${x.tokensPerUnit} × ${propLabel(x.assetId)}`).join(' + ')} · block #${d.block?.height}`,
    'basket')

  const seed = () => run(
    () => umi('/seed', { body: { assetId, holder: seller, tokens: 15000, authorisedTokens: 15000 } }),
    (d) => `Demo position seeded: ${seller} holds ${num(d.position)} tokens of ${assetId}`, 'dvp')

  const fund = () => run(
    () => umi(`/wallets/${encodeURIComponent(fundWho)}/fund`, { body: { amountINR: Number(fundAmt) } }),
    (d) => `e₹-W wallet ${d.wallet.walletId} funded ${money(d.fundedINR)} · block #${d.blockHeight}`, 'wallet')

  const settle = (dryRun) => run(
    () => umi('/dvp', { body: { assetId, seller, buyer, tokens: Number(tokens), pricePerTokenINR: Number(price), dryRun } }),
    (d) => dryRun
      ? `Pre-trade check: settleable: ${num(d.instruction.tokens)} tokens for ${money(d.instruction.cashINR)}. Nothing moved.`
      : `DvP SETTLED atomically · ${num(d.instruction.tokens)} tokens ⇄ ${money(d.instruction.cashINR)} in e₹-W · block #${d.instruction.blockHeight}`, 'dvp')

  // The rail rejected a lot of settlements for ERR_UMI_INSUFFICIENT_CBDC
  // simply because nothing here compared the cash leg against the buyer's
  // wallet before sending it. A buyer who cannot pay is now visible before
  // the click, not reported afterwards as a failed settlement.
  const cashINR = Number(tokens) * Number(price)
  const buyerWallet = wallets.find(w => w.participant === buyer)
  const buyerAvailable = buyerWallet ? Number(buyerWallet.availableINR || 0) : 0
  const shortfall = buyerWallet ? Math.max(0, cashINR - buyerAvailable) : cashINR
  const canAfford = cashINR > 0 && shortfall === 0

  const fundShortfall = () => run(
    () => umi(`/wallets/${encodeURIComponent(buyer)}/fund`, { body: { amountINR: shortfall } }),
    (d) => `e₹-W wallet ${d.wallet.walletId} topped up ${money(d.fundedINR)}: the cash leg is now covered`, 'dvp')

  // Fund-then-settle as a single action. Doing this by hand across two cards
  // is what produced most of the failed settlements on the live rail.
  const quickSettle = async () => {
    setBusy('quick'); setFlash(null)
    try {
      if (shortfall > 0) {
        const f = await umi(`/wallets/${encodeURIComponent(buyer)}/fund`, { body: { amountINR: shortfall } })
        if (!f.ok) { setFlash({ kind: 'err', where: 'quick', text: explain(f.data) }); return }
      }
      const d = await umi('/dvp', { body: { assetId, seller, buyer, tokens: Number(tokens), pricePerTokenINR: Number(price) } })
      if (d.ok) {
        setFlash({ kind: 'ok', where: 'quick', instructionId: d.data.instruction.instructionId,
          text: `Settled: ${num(d.data.instruction.tokens)} tokens to ${buyer} against ${money(d.data.instruction.cashINR)} in e₹-W, committed as block #${d.data.instruction.blockHeight}.` })
      } else setFlash({ kind: 'err', where: 'quick', text: explain(d.data) })
      await refresh()
    } catch (e) {
      setFlash({ kind: 'err', where: 'quick', text: e.message })
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (!assetId || !seller || !buyer) { setPreflight(null); return }
    const t = Number(tokens), pr = Number(price)
    if (!t || t <= 0 || !pr || pr <= 0) { setPreflight(null); return }
    let cancelled = false
    const id = setTimeout(async () => {
      const d = await umi('/dvp', { body: { assetId, seller, buyer, tokens: t, pricePerTokenINR: pr, dryRun: true } })
      if (cancelled) return
      setPreflight(d.ok ? { ok: true } : { ok: false, code: d.data && d.data.error, message: explain(d.data) })
    }, 400)
    return () => { cancelled = true; clearTimeout(id) }
  }, [mode, assetId, seller, buyer, tokens, price, wallets])

  const servicing = () => run(
    () => umi('/servicing', { body: { assetId: servAsset, payer: servPayer, amountINR: Number(servAmt) } }),
    (d) => `Servicing paid: ${money(d.servicing.distributedINR)} credited pro-rata into ${d.servicing.payouts.length} CBDC wallet(s) · block #${d.servicing.blockHeight}`, 'servicing')

  // Everyone the rail already knows about, so the buyer/seller fields can be
  // a choice instead of a spelling test.
  const participants = Array.from(new Set([
    ...wallets.map(w => w.participant),
    ...properties.map(pr => pr.originatorId),
    seller, buyer, servPayer,
  ].filter(Boolean)))

  const propOf = (id) => properties.find(x => x.assetId === id)

  // An assetId is a database key, not a thing anyone recognises. Everywhere
  // a property is named for a person, name it the way they know it: the
  // title and the city, with the reference kept nearby for traceability.
  const propLabel = (id) => {
    const pr = propOf(id)
    if (!pr) return prettifyAssetId(id)
    const city = (pr.location && (pr.location.city || pr.location.state)) || ''
    // Most titles already carry the city ("Green Valley Villas - Pune"), and
    // appending it again read as "Pune: Pune".
    const title = String(pr.title || '').trim()
    if (!title) return `Untitled property · ${String(id).slice(0, 13)}…`
    const hasCity = city && title.toLowerCase().includes(city.toLowerCase())
    return city && !hasCity ? `${title}: ${city}` : title
  }

  // Price per token implied by the registered valuation, used to prefill the
  // indicative price so nobody has to work it out by hand.
  const pricePerToken = (id) => {
    const pr = propOf(id)
    const tokens = Number(pr && pr.totalTokens) || 0
    const value = Number(pr && pr.valuationINR) || 0
    return tokens > 0 && value > 0 ? Math.round(value / tokens) : 0
  }

  const propRef = (id) => {
    const pr = propOf(id)
    if (!pr) return id
    const perToken = pricePerToken(id)
    return `${num(pr.totalTokens || 0)} tokens${perToken ? ` · about ${money(perToken)} each` : ''} · ${id}`
  }

  // A row of fields only looks tidy if the labels, the controls and the hints
  // each sit on one shared line. They cannot, while every field is its own
  // little stack: give one field a hint and it grows, and whichever way the
  // row is aligned something ends up out of step: bottom-align and the
  // hinted control rides up, top-align and the hints dangle at odd heights.
  // So the field hands its three parts to the row's own grid (subgrid) and
  // lets the row line them up. Fields with no hint simply leave that cell
  // empty instead of closing the gap and dragging their control down.
  const Field = ({ label, hint, children }) => (
    <label style={{ display: 'grid', gridTemplateRows: 'subgrid', gridRow: 'span 3', minWidth: 0 }}>
      <span style={{ alignSelf: 'end', paddingBottom: 5, fontSize: 11.5, fontWeight: 700, color: C.navy, letterSpacing: .1 }}>{label}</span>
      <span style={{ display: 'block', minWidth: 0 }}>{children}</span>
      <span style={{ paddingTop: 4, fontSize: 11, lineHeight: 1.4, color: C.mut }}>{hint || null}</span>
    </label>
  )

  // Every form row on this page shares one shape, so a field dropped into any
  // of them lands on the same three lines as its neighbours.
  const fieldRow = (columns, extra) => ({
    display: 'grid', gridTemplateColumns: columns, gridTemplateRows: 'auto auto auto',
    columnGap: 10, rowGap: 0, alignItems: 'start', ...(extra || {}),
  })

  const PropertyPicker = ({ value, onChange }) => (
    properties.length
      ? <select style={input} value={value} onChange={e => onChange(e.target.value)}>
          {!properties.some(x => x.assetId === value) && <option value={value}>{value}</option>}
          {properties.map(pr => <option key={pr.assetId} value={pr.assetId}>{propLabel(pr.assetId)}</option>)}
        </select>
      : <input style={input} value={value} onChange={e => onChange(e.target.value)} />
  )

  const PartyPicker = ({ value, onChange }) => (
    participants.length
      ? <select style={input} value={value} onChange={e => onChange(e.target.value)}>
          {participants.map(x => <option key={x} value={x}>{x}</option>)}
        </select>
      : <input style={input} value={value} onChange={e => onChange(e.target.value)} />
  )

  if (railDown) {
    return (
      <div className="container pg pg-narrow">
        <h1 className="pg-title">Aasthi Settlement Interface</h1>
        <div style={{ background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 12, padding: 18, color: C.warn }}>
          <strong>Rail offline.</strong>
          <p style={{ margin: '8px 0 0', fontSize: 13.5, color: '#7C4A03' }}>{railDown.message || 'The Go UMI gateway is not reachable.'}</p>
          <pre style={{ marginTop: 12, background: 'white', border: `1px solid ${C.warnLine}`, borderRadius: 8, padding: 12, fontSize: 12.5, overflowX: 'auto' }}>
cd drunix-gateway && go run ./cmd/gateway   # :21100{'\n'}# then (optional) UMI_GATEWAY_URL=http://127.0.0.1:21100 node mock-api-server.js</pre>
          <p style={{ margin: '10px 0 0', fontSize: 12.5 }}>All other AasthiChain features keep working: this rail is additive.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="container umi-page pg" style={{ maxWidth: 1080 }}>
      <style>{`
        .umi-page input, .umi-page select { font-family: inherit; transition: border-color .12s, box-shadow .12s; }
        .umi-page input:focus-visible, .umi-page select:focus-visible {
          outline: none; border-color: ${C.navy}; box-shadow: 0 0 0 3px ${C.navy}1F;
        }
        .umi-page input:disabled, .umi-page select:disabled { background: #F9FAFB; color: ${C.mut}; }
        /* Spinners shove the caret about and nobody clicks them. */
        .umi-page input[type=number] { -moz-appearance: textfield; }
        .umi-page input[type=number]::-webkit-outer-spin-button,
        .umi-page input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .umi-page button:focus-visible { outline: 2px solid ${C.navy}; outline-offset: 2px; }
      `}</style>
      <header style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 className="pg-title">Aasthi Settlement Interface</h1>
          <Pill tone="warn">SIMULATION</Pill>
          <Pill>ASI · built to the UMI pattern</Pill>
          <Pill>Go · drunix-gateway</Pill>
        </div>
        <p style={{ color: C.mut, fontSize: 13.5, maxWidth: 820, marginTop: 8 }}>
          ASI is AasthiChain's own settlement rail. It follows the pattern RBI set out for the
          Unified Market Interface: a securities leg and a wholesale central-bank-money leg that
          settle as one: and implements it end to end here: wallets, atomic delivery-versus-payment,
          asset servicing, baskets and a full reconciliation of the books. It is not connected to
          RBI, NPCI or a depository, and does not claim to be.
        </p>
        <p style={{ color: C.mut, fontSize: 13.5, maxWidth: 820, marginTop: 8 }}>
          {config?.pattern}
        </p>
        <p style={{ color: C.mut, fontSize: 12, maxWidth: 820 }}>{config?.disclaimer}</p>
        {mode === 'advanced' && (
          <button onClick={() => setMode('simple')}
            style={{ marginTop: 10, background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 12px', fontSize: 12.5, color: C.navy, cursor: 'pointer', fontWeight: 600 }}>
            Hide the rail controls
          </button>
        )}
      </header>

      {/* ---------- Simple view: the one action, stated plainly ---------- */}
      {(
        <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>Buy tokens with central bank money</h2>
          <p style={{ fontSize: 13, color: C.mut, marginTop: 6, marginBottom: 14, maxWidth: 640 }}>
            Tokens and cash change hands in the same instant. If either side cannot deliver, nothing moves at all.
          </p>

          <div style={fieldRow('repeat(auto-fit, minmax(170px, 1fr))')}>
            <Field label="Property" hint={assetId ? propRef(assetId) : null}>
              <PropertyPicker value={assetId} onChange={(v) => {
                setAssetId(v)
                const pr = properties.find(x => x.assetId === v)
                if (pr && pr.originatorId) setSeller(pr.originatorId)
              }} />
            </Field>
            <Field label="Buyer"><PartyPicker value={buyer} onChange={setBuyer} /></Field>
            <Field label="How many tokens"><input style={input} type="number" value={tokens} onChange={e => setTokens(e.target.value)} /></Field>
            <Field label="Price per token"><input style={input} type="number" value={price} onChange={e => setPrice(e.target.value)} /></Field>
          </div>

          <div style={{ background: '#F8FAFC', border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px', fontSize: 13.5, color: '#334155', margin: '14px 0' }}>
            <strong>{buyer}</strong> buys <strong>{num(tokens)} tokens</strong> of {propLabel(assetId)} from <strong>{seller}</strong> for <strong>{money(cashINR)}</strong>.
            {shortfall > 0 && (
              <div style={{ marginTop: 6, color: '#7C4A03' }}>
                {buyer} is short {money(shortfall)}: that will be topped up automatically before settling.
              </div>
            )}
          </div>

          {/* Blocked states are explained before the click, in the page's own
              voice, with the one action that unblocks them. */}
          {preflight && !preflight.ok && (
            <div style={{ background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: '11px 13px', fontSize: 13, color: '#7C4A03', marginBottom: 12 }}>
              {preflight.code === 'ERR_UMI_INSUFFICIENT_SECURITIES' ? (
                <>
                  <strong>{seller} has no tokens of this property on the settlement rail yet.</strong>
                  <div style={{ marginTop: 4 }}>
                    This property was listed in the marketplace, but its opening position was never issued on the rail: so there is nothing for {buyer} to buy.
                  </div>
                  <div style={{ marginTop: 9 }}>
                    <button style={btn(false)} onClick={seed} disabled={!!busy}>
                      Issue {seller}&rsquo;s opening position
                    </button>
                  </div>
                </>
              ) : (
                <>{preflight.message}</>
              )}
            </div>
          )}

          <button style={{ ...btn(true), padding: '11px 20px', fontSize: 14, opacity: (preflight && !preflight.ok) ? 0.45 : 1 }}
            onClick={quickSettle}
            disabled={!!busy || !Number(tokens) || !Number(price) || !!(preflight && !preflight.ok)}>
            {busy === 'quick' ? 'Settling…' : (shortfall > 0 ? `Top up and settle ${money(cashINR)}` : `Settle ${money(cashINR)}`)}
          </button>

          {flash && flash.where === 'quick' && (
            <div style={{
              marginTop: 12, borderRadius: 10, padding: '11px 13px', fontSize: 13,
              background: flash.kind === 'ok' ? '#ECFDF5' : C.warnBg,
              border: `1px solid ${flash.kind === 'ok' ? '#A7F3D0' : C.warnLine}`,
              color: flash.kind === 'ok' ? '#065F46' : '#7C4A03',
            }}>
              {flash.text}
              {flash.instructionId && (
                <div style={{ marginTop: 6 }}>
                  <a href={`/ledger?tx=${encodeURIComponent(flash.instructionId)}`} style={{ color: C.navy, fontWeight: 600 }}>
                    See it on the ledger →
                  </a>
                </div>
              )}
            </div>
          )}

          {mode !== 'advanced' && (
          <div style={{ marginTop: 14, fontSize: 12.5, color: C.mut }}>
            Want the rail's own controls: wallets, dry runs, servicing, ISO 20022 traces, reconciliation?{' '}
            <button onClick={() => setMode('advanced')} style={{ background: 'none', border: 'none', color: C.navy, fontWeight: 600, textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: 12.5 }}>
              Open the full rail
            </button>
          </div>
          )}
        </section>
      )}

      {mode === 'advanced' && (<>
      <Card
        title="1 · Cash leg: wholesale CBDC (e₹-W) wallets"
        sub="Institutional central-bank-money wallets. Balances are held as integer paise, so the rail can prove it never creates or destroys money."
        right={<button style={btn(false)} onClick={refresh} disabled={!!busy}>Refresh</button>}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <input style={{ ...input, maxWidth: 190 }} value={fundWho} onChange={e => setFundWho(e.target.value)} placeholder="participant" />
          <input style={{ ...input, maxWidth: 150 }} type="number" value={fundAmt} onChange={e => setFundAmt(e.target.value)} placeholder="amount ₹" />
          <button style={btn(true)} onClick={fund} disabled={!!busy}>
            {busy === 'wallet' ? 'Funding…' : 'Fund from settlement bank'}
          </button>
        </div>
        <Notice flash={flash} where="wallet" onClose={() => setFlash(null)} />
        {wallets.length === 0 ? <p style={{ fontSize: 13, color: C.mut }}>No wallets yet: fund one to begin.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ textAlign: 'left', color: C.mut, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: .4 }}>
                <th style={{ padding: '6px 8px' }}>Wallet</th><th>Participant</th><th>Balance</th><th>Available</th>
              </tr></thead>
              <tbody>
                {wallets.map(w => (
                  <tr key={w.walletId} style={{ borderTop: `1px solid ${C.line}` }}>
                    <td style={{ padding: '8px', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{w.walletId}</td>
                    <td>{w.participant}</td>
                    <td style={{ fontWeight: 600 }}>{money(w.balanceINR)}</td>
                    <td style={{ color: w.reservedPaise ? C.warn : C.mut }}>{money(w.availableINR)}{w.reservedPaise ? ' (earmarked)' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="2 · Atomic DvP instruction"
        sub="Validate → match → lock BOTH legs → commit in one block. If either leg fails, nothing moves: there is no settlement-risk window."
      >
        <div style={fieldRow('repeat(auto-fit, minmax(170px, 1fr))', { marginBottom: 12 })}>
          <Field label="Property" hint={assetId ? propRef(assetId) : null}>
            <PropertyPicker value={assetId} onChange={(v) => {
              setAssetId(v)
              const pr = properties.find(x => x.assetId === v)
              if (pr && pr.originatorId) setSeller(pr.originatorId)
            }} />
          </Field>
          <Field label="Seller" hint="gives up tokens"><PartyPicker value={seller} onChange={setSeller} /></Field>
          <Field label="Buyer" hint="pays in e₹-W"><PartyPicker value={buyer} onChange={setBuyer} /></Field>
          <Field label="Tokens"><input style={input} type="number" value={tokens} onChange={e => setTokens(e.target.value)} /></Field>
          <Field label="Price per token"><input style={input} type="number" value={price} onChange={e => setPrice(e.target.value)} /></Field>
        </div>

        {/* Say the trade back in one plain sentence before anyone commits to it. */}
        <div style={{ background: '#F8FAFC', border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 12px', fontSize: 13, color: '#334155', marginBottom: 12 }}>
          <strong>{buyer}</strong> pays <strong>{money(cashINR)}</strong> to <strong>{seller}</strong> for{' '}
          <strong>{num(tokens)} tokens</strong> of {propLabel(assetId)}: {num(tokens)} × {money(price)}.
          Both legs move together or neither does.
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={btn(true)} onClick={() => settle(false)} disabled={!!busy || !canAfford}>
            {busy === 'dvp' ? 'Settling…' : `Settle ${money(cashINR)}`}
          </button>
          <button style={btn(false)} onClick={() => settle(true)} disabled={!!busy}>Check first</button>
          <button
            onClick={() => setOpen(open === 'demo' ? null : 'demo')}
            style={{ background: 'none', border: 'none', color: C.mut, fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
            {open === 'demo' ? 'Hide demo setup' : 'Demo setup'}
          </button>
        </div>
        {open === 'demo' && (
          <div style={{ marginTop: 10, border: `1px dashed ${C.line}`, borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 12.5, color: C.mut, marginBottom: 8 }}>
              Only needed on a fresh rail: give the seller a starting position to trade out of.
            </div>
            <button style={btn(false)} onClick={seed} disabled={!!busy}>Give {seller} 15,000 tokens of this property</button>
          </div>
        )}

        {cashINR > 0 && !canAfford && (
          <div style={{ marginTop: 10, background: C.warnBg, border: `1px solid ${C.warnLine}`,
            borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: '#7C4A03' }}>
            <strong>{buyer} cannot cover this cash leg.</strong>{' '}
            {buyerWallet
              ? <>Wallet holds {money(buyerAvailable)} available against {money(cashINR)} due: short {money(shortfall)}.</>
              : <>{buyer} has no e₹-W wallet yet, so the whole {money(cashINR)} is unfunded.</>}
            <div style={{ marginTop: 8 }}>
              <button style={btn(false)} onClick={fundShortfall} disabled={!!busy}>
                Fund {money(shortfall)} into {buyer}
              </button>
            </div>
            <div style={{ marginTop: 7, color: '#92602A' }}>
              Settling anyway would be rejected as <code>ERR_UMI_INSUFFICIENT_CBDC</code> and recorded as a
              failed settlement: the rail refuses to move one leg without the other.
            </div>
          </div>
        )}
        <Notice flash={flash} where="dvp" onClose={() => setFlash(null)} />
      </Card>

      <Card
        title="3 · Programmable asset servicing"
        sub="Rent / coupon paid pro-rata straight into holders' CBDC wallets on the due date: no registrar file exchange, no reconciliation batch."
      >
        <div style={fieldRow('repeat(auto-fit, minmax(170px, 1fr))', { marginBottom: 12 })}>
          <Field label="Property" hint={servAsset ? propRef(servAsset) : null}><PropertyPicker value={servAsset} onChange={(v) => {
            setServAsset(v)
            const pr = properties.find(x => x.assetId === v)
            if (pr && pr.originatorId) setServPayer(pr.originatorId)
          }} /></Field>
          <Field label="Paid by" hint="rent collected by"><PartyPicker value={servPayer} onChange={setServPayer} /></Field>
          <Field label="Amount to distribute"><input style={input} type="number" value={servAmt} onChange={e => setServAmt(e.target.value)} /></Field>
        </div>
        <div style={{ background: '#F8FAFC', border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 12px', fontSize: 13, color: '#334155', marginBottom: 12 }}>
          <strong>{money(servAmt)}</strong> from <strong>{servPayer}</strong>, split across everyone holding{' '}
          {propLabel(servAsset)} in proportion to their tokens.
        </div>
        <button style={btn(true)} onClick={servicing} disabled={!!busy}>
          {busy === 'servicing' ? 'Distributing…' : `Distribute ${money(servAmt)}`}
        </button>
        <Notice flash={flash} where="servicing" onClose={() => setFlash(null)} />
      </Card>

      {/* The lifecycle named in post-trade terms.
          The states were always a post-trade flow, but they were labelled in
          our own words, so a settlement person had to translate before they
          could judge whether it was right. Naming each one the way a CSD or a
          custodian would is not decoration: it is the difference between
          "some states" and a recognisable settlement cycle. */}
      <Card
        title="4 · Settlement lifecycle"
        sub="The same cycle a central securities depository runs, on a T+1 basis. Our state names are on the left, the post-trade term for each on the right."
      >
        <div style={{ display: 'grid', gap: 8 }}>
          {[
            ['CREATED', 'Trade captured', 'A settlement instruction is generated from the trade and sent to the rail. Nothing is reserved yet.', 'sese.023'],
            ['MATCHED', 'Matched and affirmed', 'The instruction is paired with its counterparty side and the economics agree. A mismatch stops here rather than settling wrongly.', 'sese.024'],
            ['LOCKED', 'Pre-settlement reservation', 'Securities and cash are both reserved at once. Neither side can spend what is committed, which is what makes the next step atomic.', 'pacs.009'],
            ['SETTLED', 'Final and irrevocable', 'Both legs deliver under one lock and the block commits. There is no observable state where one leg moved and the other did not.', 'sese.025 + camt.054'],
            ['FAILED', 'Settlement fail, rolled back', 'A fail releases both reservations and records the reason. Nothing partial survives, and the instruction can be retried once the shortfall is cleared.', 'sese.024 (rejected)'],
          ].map(([state, term, why, iso]) => (
            <div key={state} style={{ display: 'grid', gridTemplateColumns: '112px 1fr', gap: 12, alignItems: 'start', border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 12px' }}>
              <div>
                <Pill tone={state === 'SETTLED' ? 'ok' : state === 'FAILED' ? 'bad' : 'warn'}>{state}</Pill>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: C.mut, marginTop: 6 }}>{iso}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 650 }}>{term}</div>
                <div style={{ fontSize: 12.5, color: C.mut, lineHeight: 1.55, marginTop: 2 }}>{why}</div>
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: C.mut, marginTop: 12, lineHeight: 1.6 }}>
          Fails management is the part of post-trade that actually consumes people, so it is modelled
          rather than skipped: a failed instruction keeps its reason, reports the exact shortfall, and
          offers the one action that clears it. Settlement finality here means the block is committed;
          the securities leg is this ledger and the cash leg is the e₹-W wallet ledger.
        </p>
      </Card>

      <Card title="5 · Instructions & ISO 20022 trace" sub="Every instruction carries the message family a real securities-settlement rail would emit: sese.023 (instruction), sese.024 (status), pacs.009 (cash leg), sese.025 (confirmation), camt.054 (debit/credit advice).">
        {instructions.length === 0 ? <p style={{ fontSize: 13, color: C.mut }}>No instructions yet.</p> : instructions.map(si => (
          <div key={si.instructionId} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: C.navy }}>{si.instructionId} · {si.isin}</div>
                <div style={{ fontSize: 13, marginTop: 3 }}>
                  {num(si.tokens)} tokens {si.seller} → {si.buyer} &nbsp;⇄&nbsp; {money(si.cashINR)} e₹-W
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Pill tone={si.status === 'SETTLED' ? 'ok' : si.status === 'FAILED' ? 'bad' : 'warn'}>{si.status}</Pill>
                {si.blockHeight > 0 && <Pill>block #{si.blockHeight}</Pill>}
                <button style={{ ...btn(false), padding: '5px 10px' }} onClick={() => setOpen(open === si.instructionId ? null : si.instructionId)}>
                  {open === si.instructionId ? 'Hide' : 'Trace'}
                </button>
              </div>
            </div>
            {si.failureReason && (
              <div style={{ marginTop: 6, fontSize: 12.5, color: C.bad }}>
                {si.failureReason}: {si.failureDetail} <em>(neither leg moved)</em>
                {si.shortfallINR > 0 && (
                  // A past failure used to be a dead end: the reason was on
                  // screen but the fix was three fields away in another card.
                  // The rail now reports the exact gap, so offer the one action
                  // that clears it.
                  <button
                    style={{ ...btn(false), padding: '4px 9px', marginLeft: 8, fontSize: 12 }}
                    disabled={!!busy}
                    onClick={() => run(
                      () => umi(`/wallets/${encodeURIComponent(si.buyer)}/fund`, { body: { amountINR: si.shortfallINR } }),
                      (d) => `e₹-W wallet ${d.wallet.walletId} topped up ${money(d.fundedINR)}: retry the instruction above`, 'dvp')}
                  >
                    Top up {money(si.shortfallINR)} for {si.buyer}
                  </button>
                )}
              </div>
            )}
            {open === si.instructionId && (
              <ol style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#374151' }}>
                {(si.messages || []).map(m => (
                  <li key={m.seq} style={{ marginBottom: 4 }}>
                    <code style={{ color: C.navy, fontWeight: 700 }}>{m.family}</code> <span style={{ color: C.mut }}>{m.name}</span><br />{m.detail}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </Card>

      <Card title="6 · Reconciliation" sub="Conservation of central bank money, plus a full replay of the Drunix hash chain that carries every UMI block.">
        {recon && (
          <div style={fieldRow('repeat(auto-fit, minmax(170px, 1fr))')}>
            {[
              ['Wallets', num(recon.wallets)],
              ['Total e₹-W held', money(recon.totalBalanceINR)],
              ['Lifetime funded', money(recon.totalFundedINR)],
              ['Earmarked now', money(recon.totalReservedINR)],
              ['Settled', num(recon.settledInstructions)],
              ['Failed (no partial)', num(recon.failedInstructions)],
              ['Pilot ISINs', num(recon.pilotIsins)],
              ['Chain blocks', num(recon.chain?.blocks)],
            ].map(([k, v]) => (
              <div key={k} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, background: C.paper }}>
                <div style={{ fontSize: 11, color: C.mut, textTransform: 'uppercase', letterSpacing: .4 }}>{k}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.navy }}>{v}</div>
              </div>
            ))}
          </div>
        )}
        {recon && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Pill tone={recon.conserved ? 'ok' : 'bad'}>{recon.conserved ? 'Money conserved' : 'CONSERVATION BREACH'}</Pill>
            <Pill tone={recon.chain?.valid ? 'ok' : 'bad'}>{recon.chain?.valid ? 'Chain verified from genesis' : 'Chain broken'}</Pill>
          </div>
        )}
        {recon?.conservationNote && <p style={{ fontSize: 12.5, color: C.mut, marginTop: 10 }}>{recon.conservationNote}</p>}
        {isins.length > 0 && (
          <p style={{ fontSize: 12.5, color: C.mut, marginTop: 8 }}>
            Pilot register: {isins.map(i => `${i.isin}: ${propLabel(i.assetId)}`).join(' · ')}
          </p>
        )}
      </Card>

      <Card
        title="7 · Baskets: cross-property portfolio tokens"
        sub="One unit is a fixed recipe of several properties. Subscribing moves the underlying tokens into custody, so a unit is redeemable rather than notional. Investors create, sell and redeem units from their dashboard; defining the instrument happens here.">
        <div style={fieldRow('repeat(auto-fit, minmax(190px, 1fr))')}>
          <Field label="Basket id"><input style={input} value={bId} onChange={e => setBId(e.target.value)} /></Field>
          <Field label="Name"><input style={input} value={bName} onChange={e => setBName(e.target.value)} /></Field>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: C.mut, textTransform: 'uppercase', letterSpacing: .4, marginBottom: 6 }}>
            What one unit contains
          </div>
          {legs.map((l, i) => (
            <div key={i} style={fieldRow(
              // No trailing column on the first two legs: there is no remove
              // button on them, and an empty track still costs a grid gap.
              i >= 2 ? 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto' : 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)',
              { marginBottom: 10 })}>
              <Field label={`Property ${i + 1}`} hint={l.assetId ? propRef(l.assetId) : 'Pick from the properties already tokenised on the rail'}>
                <select
                  style={input}
                  value={l.assetId}
                  onChange={e => {
                    const id = e.target.value
                    setLeg(i, 'assetId', id)
                    // Prefill the indicative price from the registered
                    // valuation. It stays editable; it just means nobody has
                    // to divide a crore by fifteen thousand in their head.
                    const implied = pricePerToken(id)
                    if (implied && !Number(l.indicativePriceINR)) setLeg(i, 'indicativePriceINR', implied)
                  }}>
                  <option value="">select a property…</option>
                  {properties.map(p => {
                    // A basket needs distinct properties, so one already used
                    // in another leg is shown but cannot be picked twice.
                    const usedElsewhere = legs.some((other, n) => n !== i && other.assetId === p.assetId)
                    return (
                      <option key={p.assetId} value={p.assetId} disabled={usedElsewhere}>
                        {propLabel(p.assetId)}{usedElsewhere ? ': already in this basket' : ''}
                      </option>
                    )
                  })}
                </select>
              </Field>
              <Field label="Tokens per unit">
                <input style={input} type="number" min="1" value={l.tokensPerUnit} onChange={e => setLeg(i, 'tokensPerUnit', e.target.value)} />
              </Field>
              <Field label="Indicative ₹/token">
                <input style={input} type="number" min="0" value={l.indicativePriceINR} onChange={e => setLeg(i, 'indicativePriceINR', e.target.value)} />
              </Field>
              {/* A basket needs at least two properties, so the first two
                  legs can never be removed. The control used to sit there
                  permanently disabled, taking a column of the grid on every
                  row to offer something nobody could click. It now appears
                  from the third leg onward, which is the only place it
                  does anything. */}
              {i >= 2 && (
                <button
                  onClick={() => setLegs(ls => ls.filter((_, n) => n !== i))}
                  title="Remove this leg"
                  style={{ gridRow: 2, alignSelf: 'start', height: CONTROL_H, padding: '0 14px', borderRadius: 8, border: `1px solid ${C.line}`, background: 'white', color: C.mut, cursor: 'pointer', fontSize: 12.5 }}>
                  remove
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() => setLegs(ls => [...ls, { assetId: '', tokensPerUnit: 1, indicativePriceINR: 0 }])}
            style={{ padding: '7px 12px', borderRadius: 8, border: `1px dashed ${C.line}`, background: 'white', color: C.navy, cursor: 'pointer', fontSize: 12.5 }}>
            + another property
          </button>
        </div>

        {(() => {
          const chosen = legs.filter(l => l.assetId && Number(l.tokensPerUnit) > 0)
          const ids = chosen.map(l => l.assetId)
          const dupes = ids.length !== new Set(ids).size
          const ok = chosen.length >= 2 && !dupes
          const nav = chosen.reduce((t, l) => t + Number(l.tokensPerUnit) * (Number(l.indicativePriceINR) || 0), 0)
          return (
            <>
              <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: C.paper, border: `1px solid ${C.line}`, fontSize: 12.5, color: C.navy }}>
                {ok
                  ? <>One unit = <strong>{chosen.map(l => `${l.tokensPerUnit} × ${propLabel(l.assetId)}`).join('  +  ')}</strong>
                      {nav > 0 && <> · indicative NAV <strong>{money(nav)}</strong> per unit</>}</>
                  : <span style={{ color: C.mut }}>
                      {dupes
                        ? 'Two legs point at the same property: a basket needs at least two different ones.'
                        : 'Pick at least two different properties, each with tokens per unit above zero.'}
                    </span>}
              </div>
              <div style={{ marginTop: 10 }}>
                <button
                  onClick={createBasket}
                  disabled={!ok || !bId.trim() || busy === 'basket'}
                  style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: (!ok || !bId.trim()) ? '#9CA3AF' : C.navy, color: 'white', fontWeight: 600, fontSize: 13.5, cursor: (!ok || !bId.trim()) ? 'not-allowed' : 'pointer' }}>
                  {busy === 'basket' ? 'Defining…' : 'Define this basket'}
                </button>
              </div>
            </>
          )
        })()}

        <Notice flash={flash} where="basket" onClose={() => setFlash(null)} />

        {baskets.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: C.mut, textTransform: 'uppercase', letterSpacing: .4, marginBottom: 6 }}>
              Defined baskets
            </div>
            {baskets.map(b => (
              <div key={b.basketId} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, marginBottom: 8, background: 'white' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <strong style={{ color: C.navy, fontSize: 13.5 }}>{b.name || b.basketId}</strong>
                  <Pill tone={b.fullyBacked === false ? 'bad' : 'ok'}>
                    {b.fullyBacked === false ? 'Backing short' : 'Fully backed'}
                  </Pill>
                </div>
                <div style={{ fontSize: 12, color: C.mut, marginTop: 4 }}>
                  one unit = {(b.components || []).map(c => `${c.tokensPerUnit} × ${propLabel(c.assetId)}`).join(' + ')}
                  {' · '}{num(b.unitsOutstanding)} unit(s) outstanding
                  {b.navPerUnitINR ? <> · NAV {money(b.navPerUnitINR)}/unit</> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Suspense fallback={<PanelFallback />}>
        <WorkDeskPanel properties={properties} participants={participants} propLabel={propLabel} />
        <CarbonPanel participants={participants} />
        <ThroughputPanel />
        <PrivateDataPanel />
        <InteropPanel participants={participants} assetIds={properties.map((p) => p.assetId || p.id).filter(Boolean)} />
      </Suspense>
      </>)}
    </div>
  )
}
