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
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const run = async (fn, okMsg) => {
    setBusy(true); setFlash(null)
    try {
      const res = await fn()
      if (res.ok) setFlash({ kind: 'ok', text: okMsg(res.data) })
      else setFlash({ kind: 'err', text: `${res.data.error || 'Failed'} — ${res.data.message || ''}` })
      await refresh()
      return res
    } catch (e) {
      setFlash({ kind: 'err', text: e.message })
    } finally { setBusy(false) }
  }

  const seed = () => run(
    () => umi('/seed', { body: { assetId, holder: seller, tokens: 15000 } }),
    (d) => `Demo position seeded: ${seller} holds ${num(d.position)} tokens of ${assetId}`)

  const fund = () => run(
    () => umi(`/wallets/${encodeURIComponent(fundWho)}/fund`, { body: { amountINR: Number(fundAmt) } }),
    (d) => `e₹-W wallet ${d.wallet.walletId} funded ${money(d.fundedINR)} · block #${d.blockHeight}`)

  const settle = (dryRun) => run(
    () => umi('/dvp', { body: { assetId, seller, buyer, tokens: Number(tokens), pricePerTokenINR: Number(price), dryRun } }),
    (d) => dryRun
      ? `Pre-trade check: settleable — ${num(d.instruction.tokens)} tokens for ${money(d.instruction.cashINR)}. Nothing moved.`
      : `DvP SETTLED atomically · ${num(d.instruction.tokens)} tokens ⇄ ${money(d.instruction.cashINR)} in e₹-W · block #${d.instruction.blockHeight}`)

  const servicing = () => run(
    () => umi('/servicing', { body: { assetId, payer: seller, amountINR: Number(servAmt) } }),
    (d) => `Servicing paid: ${money(d.servicing.distributedINR)} credited pro-rata into ${d.servicing.payouts.length} CBDC wallet(s) · block #${d.servicing.blockHeight}`)

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
      </header>

      {flash && (
        <div style={{
          marginBottom: 14, padding: '11px 14px', borderRadius: 10, fontSize: 13,
          background: flash.kind === 'ok' ? C.okBg : C.badBg,
          border: `1px solid ${flash.kind === 'ok' ? C.okLine : C.badLine}`,
          color: flash.kind === 'ok' ? C.ok : C.bad,
        }}>{flash.text}</div>
      )}

      <Card
        title="1 · Cash leg — wholesale CBDC (e₹-W) wallets"
        sub="Institutional central-bank-money wallets. Balances are held as integer paise, so the rail can prove it never creates or destroys money."
        right={<button style={btn(false)} onClick={refresh} disabled={busy}>Refresh</button>}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <input style={{ ...input, maxWidth: 190 }} value={fundWho} onChange={e => setFundWho(e.target.value)} placeholder="participant" />
          <input style={{ ...input, maxWidth: 150 }} type="number" value={fundAmt} onChange={e => setFundAmt(e.target.value)} placeholder="amount ₹" />
          <button style={btn(true)} onClick={fund} disabled={busy}>Fund from settlement bank</button>
        </div>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
          <input style={input} value={assetId} onChange={e => setAssetId(e.target.value)} placeholder="assetId" />
          <input style={input} value={seller} onChange={e => setSeller(e.target.value)} placeholder="seller" />
          <input style={input} value={buyer} onChange={e => setBuyer(e.target.value)} placeholder="buyer" />
          <input style={input} type="number" value={tokens} onChange={e => setTokens(e.target.value)} placeholder="tokens" />
          <input style={input} type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="₹ / token" />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={btn(true)} onClick={() => settle(false)} disabled={busy}>Settle DvP</button>
          <button style={btn(false)} onClick={() => settle(true)} disabled={busy}>Dry run (no state change)</button>
          <button style={btn(false)} onClick={seed} disabled={busy}>Seed demo position for seller</button>
          <span style={{ fontSize: 12.5, color: C.mut }}>Cash leg: <strong>{money(Number(tokens) * Number(price))}</strong></span>
        </div>
      </Card>

      <Card
        title="3 · Programmable asset servicing"
        sub="Rent / coupon paid pro-rata straight into holders' CBDC wallets on the due date — no registrar file exchange, no reconciliation batch."
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...input, maxWidth: 150 }} type="number" value={servAmt} onChange={e => setServAmt(e.target.value)} />
          <button style={btn(true)} onClick={servicing} disabled={busy}>Distribute from {seller}</button>
          <span style={{ fontSize: 12.5, color: C.mut }}>pro-rata across holders of {assetId}</span>
        </div>
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
    </div>
  )
}
