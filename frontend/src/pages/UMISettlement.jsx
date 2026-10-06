// UMI Settlement — RBI Unified Market Interface rail (SEBI Demat 2.0 pattern).
//
// Securities leg: Drunix property-fraction tokens on the permissioned ledger.
// Cash leg: wholesale CBDC (e₹-W) wallets.
// Together: atomic DvP — both legs move in one block, or neither moves.
//
// ALL logic lives in Go (drunix-gateway/umi.go). This page is a thin client over
// /api/umi/*, which the Node server reverse-proxies to the Go rail. If the rail
// is not running the page says so plainly and nothing else in the app changes.

import React, { useCallback, useEffect, useState } from 'react'

const C = {
  paper: '#F7F5F0', navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  ok: '#047857', okBg: '#ECFDF5', okLine: '#A7F3D0',
  bad: '#B91C1C', badBg: '#FEF2F2', badLine: '#FECACA',
  warn: '#B45309', warnBg: '#FFFBEB', warnLine: '#FDE68A',
}

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const num = (n) => Number(n || 0).toLocaleString('en-IN')

async function umi(path, options = {}) {
  const res = await fetch('/api/umi' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
    method: options.body ? (options.method || 'POST') : (options.method || 'GET'),
  })
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: 'ERR_BAD_RESPONSE', message: text.slice(0, 200) } }
  return { ok: res.ok, status: res.status, data }
}

// The rail returns machine codes. Operators need a sentence that says what to do.
const ERRORS = {
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

const input = { padding: '8px 10px', border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13, minWidth: 0, width: '100%' }
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
  // The page opened straight onto five operator cards — wallets, raw ids,
  // ISO 20022 traces. That is the right screen for someone running a
  // settlement rail and the wrong one for everybody else, so the detail is
  // now opt-in and the default view is the one thing people come here to do.
  const [mode, setMode] = useState('simple')
  // Result of a silent dry run against the current inputs. The rail can tell
  // us whether this trade would settle without moving anything, so there is
  // no reason to let someone click into a red error to find out.
  const [preflight, setPreflight] = useState(null)

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

  const seed = () => run(
    () => umi('/seed', { body: { assetId, holder: seller, tokens: 15000, authorisedTokens: 15000 } }),
    (d) => `Demo position seeded: ${seller} holds ${num(d.position)} tokens of ${assetId}`, 'dvp')

  const fund = () => run(
    () => umi(`/wallets/${encodeURIComponent(fundWho)}/fund`, { body: { amountINR: Number(fundAmt) } }),
    (d) => `e₹-W wallet ${d.wallet.walletId} funded ${money(d.fundedINR)} · block #${d.blockHeight}`, 'wallet')

  const settle = (dryRun) => run(
    () => umi('/dvp', { body: { assetId, seller, buyer, tokens: Number(tokens), pricePerTokenINR: Number(price), dryRun } }),
    (d) => dryRun
      ? `Pre-trade check: settleable — ${num(d.instruction.tokens)} tokens for ${money(d.instruction.cashINR)}. Nothing moved.`
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
    (d) => `e₹-W wallet ${d.wallet.walletId} topped up ${money(d.fundedINR)} — the cash leg is now covered`, 'dvp')

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
          text: `Settled — ${num(d.data.instruction.tokens)} tokens to ${buyer} against ${money(d.data.instruction.cashINR)} in e₹-W, committed as block #${d.data.instruction.blockHeight}.` })
      } else setFlash({ kind: 'err', where: 'quick', text: explain(d.data) })
      await refresh()
    } catch (e) {
      setFlash({ kind: 'err', where: 'quick', text: e.message })
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (mode !== 'simple' || !assetId || !seller || !buyer) { setPreflight(null); return }
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

  const propLabel = (id) => {
    const pr = properties.find(x => x.assetId === id)
    return pr ? `${pr.title} (${num(pr.totalTokens || 0)} tokens)` : id
  }

  const Field = ({ label, hint, children }) => (
    <label style={{ display: 'block', minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>{label}</span>
      {children}
      {hint ? <span style={{ display: 'block', fontSize: 11, color: C.mut, marginTop: 3 }}>{hint}</span> : null}
    </label>
  )

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
      <div className="container" style={{ padding: '28px 16px', maxWidth: 900 }}>
        <h1 style={{ fontFamily: 'Fraunces, Georgia, serif', color: C.navy }}>UMI Settlement Rail</h1>
        <div style={{ background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 12, padding: 18, color: C.warn }}>
          <strong>Rail offline.</strong>
          <p style={{ margin: '8px 0 0', fontSize: 13.5, color: '#7C4A03' }}>{railDown.message || 'The Go UMI gateway is not reachable.'}</p>
          <pre style={{ marginTop: 12, background: 'white', border: `1px solid ${C.warnLine}`, borderRadius: 8, padding: 12, fontSize: 12.5, overflowX: 'auto' }}>
cd drunix-gateway && go run ./cmd/gateway   # :21100{'\n'}# then (optional) UMI_GATEWAY_URL=http://127.0.0.1:21100 node mock-api-server.js</pre>
          <p style={{ margin: '10px 0 0', fontSize: 12.5 }}>All other AasthiChain features keep working — this rail is strictly additive.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="container" style={{ padding: '24px 16px 60px', maxWidth: 1080 }}>
      <header style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 28, color: C.navy, margin: 0 }}>UMI Settlement Rail</h1>
          <Pill tone="warn">SIMULATION</Pill>
          <Pill>Go · drunix-gateway/umi.go</Pill>
        </div>
        <p style={{ color: C.mut, fontSize: 13.5, maxWidth: 820, marginTop: 8 }}>
          {config?.pattern}
        </p>
        <p style={{ color: C.mut, fontSize: 12, maxWidth: 820 }}>{config?.disclaimer}</p>
        {mode === 'advanced' && (
          <button onClick={() => setMode('simple')}
            style={{ marginTop: 10, background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 12px', fontSize: 12.5, color: C.navy, cursor: 'pointer', fontWeight: 600 }}>
            ← Back to the simple view
          </button>
        )}
      </header>

      {/* ---------- Simple view: the one action, stated plainly ---------- */}
      {mode === 'simple' && (
        <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>Buy tokens with central bank money</h2>
          <p style={{ fontSize: 13, color: C.mut, marginTop: 6, marginBottom: 14, maxWidth: 640 }}>
            Tokens and cash change hands in the same instant. If either side cannot deliver, nothing moves at all.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
            <Field label="Property">
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
                {buyer} is short {money(shortfall)} — that will be topped up automatically before settling.
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
                    This property was listed in the marketplace, but its opening position was never issued on the rail — so there is nothing for {buyer} to buy.
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

          <div style={{ marginTop: 14, fontSize: 12.5, color: C.mut }}>
            Want the rail's own controls — wallets, dry runs, servicing, ISO 20022 traces, reconciliation?{' '}
            <button onClick={() => setMode('advanced')} style={{ background: 'none', border: 'none', color: C.navy, fontWeight: 600, textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: 12.5 }}>
              Open the full rail
            </button>
          </div>
        </section>
      )}

      {mode === 'advanced' && (<>
      <Card
        title="1 · Cash leg — wholesale CBDC (e₹-W) wallets"
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
        {wallets.length === 0 ? <p style={{ fontSize: 13, color: C.mut }}>No wallets yet — fund one to begin.</p> : (
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
          <Field label="Property">
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
          <strong>{num(tokens)} tokens</strong> of {propLabel(assetId)} — {num(tokens)} × {money(price)}.
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
              ? <>Wallet holds {money(buyerAvailable)} available against {money(cashINR)} due — short {money(shortfall)}.</>
              : <>{buyer} has no e₹-W wallet yet, so the whole {money(cashINR)} is unfunded.</>}
            <div style={{ marginTop: 8 }}>
              <button style={btn(false)} onClick={fundShortfall} disabled={!!busy}>
                Fund {money(shortfall)} into {buyer}
              </button>
            </div>
            <div style={{ marginTop: 7, color: '#92602A' }}>
              Settling anyway would be rejected as <code>ERR_UMI_INSUFFICIENT_CBDC</code> and recorded as a
              failed settlement — the rail refuses to move one leg without the other.
            </div>
          </div>
        )}
        <Notice flash={flash} where="dvp" onClose={() => setFlash(null)} />
      </Card>

      <Card
        title="3 · Programmable asset servicing"
        sub="Rent / coupon paid pro-rata straight into holders' CBDC wallets on the due date — no registrar file exchange, no reconciliation batch."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
          <Field label="Property"><PropertyPicker value={servAsset} onChange={(v) => {
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

      <Card title="4 · Instructions & ISO 20022 trace" sub="Every instruction keeps the message family a real securities-settlement rail would emit — sese.023 → sese.024 → pacs.009 → sese.025 → camt.054.">
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
            {si.failureReason && <div style={{ marginTop: 6, fontSize: 12.5, color: C.bad }}>{si.failureReason} — {si.failureDetail} <em>(neither leg moved)</em></div>}
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

      <Card title="5 · Reconciliation" sub="Conservation of central bank money, plus a full replay of the Drunix hash chain that carries every UMI block.">
        {recon && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
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
            Pilot register: {isins.map(i => `${i.isin} (${i.assetId})`).join(' · ')}
          </p>
        )}
      </Card>
      </>)}
    </div>
  )
}
