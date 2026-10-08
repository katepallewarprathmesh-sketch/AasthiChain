import { useState, useEffect, useCallback } from 'react'
import api from '../lib/api.js'

// Secondary marketplace: holders selling to each other rather than everyone
// buying from the original owner. The page is deliberately plain about what
// it is — an order book whose every purchase settles as the same atomic
// delivery-versus-payment used everywhere else. Nothing here can move a token
// without the cash moving in the same instant.

const C = {
  navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  bad: '#B91C1C', ok: '#047857', warn: '#B45309',
}
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN')
const input = {
  border: `1px solid ${C.line}`, borderRadius: 8, padding: '7px 10px',
  fontSize: 13, minWidth: 0,
}
const btn = (primary) => ({
  border: primary ? 'none' : `1px solid ${C.line}`,
  background: primary ? C.navy : '#fff',
  color: primary ? '#fff' : '#111827',
  borderRadius: 8, padding: '7px 13px', fontSize: 13,
  fontWeight: 600, cursor: 'pointer',
})

export default function SecondaryMarket({ user }) {
  const me = (user && user.identityId) || ''
  const [offers, setOffers] = useState([])
  const [flash, setFlash] = useState(null)
  // Kept apart from `flash` on purpose. `flash` carries the result of something
  // the user did ("offer created"), and run() refreshes the book straight after
  // setting it — so if loading shared that slot, a successful reload would wipe
  // the confirmation the user just earned.
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')

  const [form, setForm] = useState({ assetId: '', tokens: '', price: '' })

  const load = useCallback(async () => {
    try {
      const d = await api.umiOffers(filter || undefined)
      setOffers((d && d.offers) || [])
      // Clear it. A hosted rail that was merely asleep answers fine on the
      // retry, and leaving the old warning up next to a freshly loaded book
      // told the user the page was broken when it had already recovered.
      setLoadError('')
    } catch (e) {
      setLoadError('Could not load the book: ' + e.message)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const run = async (fn, okText) => {
    setBusy(true); setFlash(null)
    try {
      const d = await fn()
      setFlash({ kind: 'ok', text: okText(d) })
      await load()
    } catch (e) {
      // The rail sends a plain-English message with every rejection; prefer it.
      setFlash({ kind: 'err', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  const create = () => run(
    () => api.umiCreateOffer({
      assetId: form.assetId.trim(), seller: me,
      tokens: Number(form.tokens), pricePerTokenINR: Number(form.price),
    }),
    (d) => `Listed ${d.offer.tokensTotal} tokens of ${d.offer.assetId} at ${money(d.offer.pricePerTokenINR)} each.`)

  const take = (o, tokens) => run(
    () => api.umiTakeOffer(o.offerId, { buyer: me, tokens }),
    (d) => `Bought ${tokens} tokens for ${money(d.instruction.cashINR)} — settled atomically in block #${d.instruction.blockHeight}.`)

  const check = (o, tokens) => run(
    () => api.umiTakeOffer(o.offerId, { buyer: me, tokens, dryRun: true }),
    (d) => `Would settle: ${tokens} tokens for ${money(d.instruction.cashINR)}. Nothing has moved.`)

  const cancel = (o) => run(
    () => api.umiCancelOffer(o.offerId, me),
    () => `Offer ${o.offerId} withdrawn.`)

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 20px 60px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: '#9CA3AF', textTransform: 'uppercase' }}>
        Secondary market · simulation
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 800, color: '#111827', margin: '6px 0 4px' }}>Marketplace</h1>
      <p style={{ fontSize: 13.5, color: C.mut, maxWidth: '68ch', lineHeight: 1.6 }}>
        Buy fractions from other holders rather than from the original owner. Every purchase
        settles as delivery-versus-payment: the tokens and the money move together, or neither
        does. An offer here is only an intention — it holds nothing until someone takes it.
      </p>

      {loadError && (
        <div style={{
          margin: '12px 0', padding: '10px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.6,
          background: '#FEF2F2', border: '1px solid #FECACA', color: C.bad,
        }}>
          {loadError}
          <button
            type="button"
            onClick={load}
            style={{
              marginLeft: 10, padding: '4px 12px', borderRadius: 6, border: '1px solid #FECACA',
              background: 'white', color: C.bad, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}>
            Try again
          </button>
        </div>
      )}

      {flash && (
        <div style={{
          margin: '14px 0', padding: '10px 14px', borderRadius: 10, fontSize: 13,
          background: flash.kind === 'ok' ? '#ECFDF5' : '#FEF2F2',
          border: `1px solid ${flash.kind === 'ok' ? '#A7F3D0' : '#FECACA'}`,
          color: flash.kind === 'ok' ? C.ok : C.bad,
        }}>{flash.text}</div>
      )}

      {!me && (
        <div style={{ margin: '14px 0', padding: '10px 14px', borderRadius: 10, fontSize: 13,
          background: '#FFFBEB', border: '1px solid #FDE68A', color: C.warn }}>
          Sign in to list tokens or buy from the book. You can still browse.
        </div>
      )}

      {me && (
        <section style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12,
          padding: '16px 18px', margin: '16px 0' }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 10px' }}>Sell tokens you hold</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={{ ...input, flex: '2 1 220px' }} placeholder="asset id, e.g. PROP-GREEN-VALLEY-PUNE-001"
              value={form.assetId} onChange={e => setForm({ ...form, assetId: e.target.value })} />
            <input style={{ ...input, flex: '1 1 110px' }} type="number" placeholder="tokens"
              value={form.tokens} onChange={e => setForm({ ...form, tokens: e.target.value })} />
            <input style={{ ...input, flex: '1 1 130px' }} type="number" placeholder="₹ per token"
              value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} />
            <button style={btn(true)} disabled={busy || !form.assetId || !form.tokens || !form.price}
              onClick={create}>{busy ? 'Working…' : 'List for sale'}</button>
          </div>
          <p style={{ fontSize: 12.5, color: C.mut, margin: '8px 0 0' }}>
            You can only offer tokens you actually hold, and only once — tokens already promised
            in another open offer do not count twice.
          </p>
        </section>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '18px 0 8px' }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Open offers</h2>
        <input style={{ ...input, maxWidth: 280 }} placeholder="filter by asset id"
          value={filter} onChange={e => setFilter(e.target.value)} />
        <button style={btn(false)} onClick={load} disabled={busy}>Refresh</button>
      </div>

      {offers.length === 0 ? (
        // "Nothing is for sale" is a claim about the book. If the book could
        // not be read, we are not entitled to make it — the error above says
        // what is actually known.
        loadError ? null : (
        <p style={{ fontSize: 13.5, color: C.mut }}>
          Nothing is for sale right now{filter ? ' for that asset' : ''}.
        </p>
        )
      ) : offers.map(o => (
        <OfferRow key={o.offerId} offer={o} me={me} busy={busy}
          onTake={take} onCheck={check} onCancel={cancel} />
      ))}
    </div>
  )
}

function OfferRow({ offer: o, me, busy, onTake, onCheck, onCancel }) {
  const [qty, setQty] = useState('')
  const mine = o.seller === me
  const n = Number(qty)
  const valid = n > 0 && n <= o.tokensRemaining

  return (
    <div style={{
      background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12,
      padding: '12px 16px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong style={{ fontSize: 14 }}>{o.assetId}</strong>
          <span style={{ color: C.mut, fontSize: 13 }}>
            {' · '}{o.tokensRemaining} of {o.tokensTotal} left at {money(o.pricePerTokenINR)} each
            {' · '}seller {mine ? 'you' : o.seller}
          </span>
          {o.fills && o.fills.length > 0 && (
            <div style={{ fontSize: 12, color: C.mut, marginTop: 3 }}>
              {o.fills.length} fill{o.fills.length === 1 ? '' : 's'} so far
            </div>
          )}
        </div>
        <code style={{ fontSize: 12, color: C.navy }}>{o.offerId}</code>
      </div>

      {me && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {mine ? (
            <button style={btn(false)} disabled={busy} onClick={() => onCancel(o)}>Withdraw offer</button>
          ) : (
            <>
              <input style={{ ...input, maxWidth: 120 }} type="number" placeholder="tokens"
                value={qty} onChange={e => setQty(e.target.value)} />
              {/* The dry run exists so a buyer can find out they are short
                  before a failed settlement is written to the ledger. */}
              <button style={btn(false)} disabled={busy || !valid} onClick={() => onCheck(o, n)}>Check first</button>
              <button style={btn(true)} disabled={busy || !valid} onClick={() => onTake(o, n)}>
                {valid ? `Buy for ${money(n * o.pricePerTokenINR)}` : 'Buy'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
