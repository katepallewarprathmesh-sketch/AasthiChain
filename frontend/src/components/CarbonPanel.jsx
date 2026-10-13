import React, { useEffect, useState } from 'react'
import { umiFetch as umi, umiPost, explainRail } from '../lib/umiFetch'

// Carbon credits: the same settlement core, one lifecycle it did not have.
//
// The point this panel has to make is not "we support carbon". It is that
// the settlement core never knew what a property was, so a second asset
// class was a registry entry rather than a rewrite, and the only genuinely
// new thing is retirement: a terminal state where a credit is permanently
// consumed and must never trade again.
//
// So the numbers on screen are the conservation statement, not a balance.
// outstanding + retired <= authorised is what makes double counting
// detectable, and it is shown as arithmetic the reader can check rather than
// as a green tick they have to trust.

const C = {
  navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  green: '#047857', greenBg: '#ECFDF5', warn: '#B45309', warnBg: '#FFFBEB',
}

const input = {
  width: '100%', padding: '9px 11px', border: `1px solid ${C.line}`,
  borderRadius: 9, fontSize: 13, boxSizing: 'border-box',
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, color: C.mut, textTransform: 'uppercase', letterSpacing: .4, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: C.mut, marginTop: 4 }}>{hint}</div>}
    </label>
  )
}

const n = (v) => Number(v || 0).toLocaleString('en-IN')

export default function CarbonPanel({ participants = [] }) {
  const [assets, setAssets] = useState([])
  const [retirements, setRetirements] = useState([])
  const [assetId, setAssetId] = useState('')
  const [holder, setHolder] = useState('')
  const [tokens, setTokens] = useState('')
  const [beneficiary, setBeneficiary] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const load = async () => {
    try {
      // umiFetch answers {ok, status, data}. Reading the payload straight
      // off that envelope is how this panel spent a release showing an
      // empty table against a rail that was answering perfectly.
      const a = await umi('/assets')
      const carbon = (a.ok ? (a.data.assets || []) : []).filter((x) => x.profile && x.profile.assetClass === 'CARBON')
      setAssets(carbon)
      if (!assetId && carbon.length) {
        setAssetId(carbon[0].profile.assetId)
      }
      const r = await umi('/carbon/retirements')
      setRetirements(r.ok ? (r.data.retirements || []) : [])
    } catch {
      // The rail being unreachable is already reported by the page around
      // this panel; a second red box here would just be noise.
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const retire = async () => {
    setBusy(true); setMsg(null)
    try {
      // Bodyless-GET trap: this MUST go through umiPost. See
      // tests/railmethods.test.mjs.
      const res = await umiPost('/carbon/retire', {
        assetId, holder, tokens: Number(tokens), beneficiary, reason,
      })
      // The rail reports a refusal as a status code, not an exception, so
      // without this check a rejected retirement printed a cheerful
      // confirmation about undefined credits.
      if (!res.ok || !res.data || !res.data.retirement) {
        setMsg({ ok: false, text: explainRail(res.data) })
        return
      }
      const r = res.data.retirement
      setMsg({
        ok: true,
        text: `Retired ${n(r.tokens)} credits for ${r.beneficiary}. `
          + `Block ${r.blockHeight} is the certificate, and this cannot be undone.`,
      })
      setTokens('')
      await load()
    } catch (e) {
      setMsg({ ok: false, text: (e.data && e.data.message) || e.message || 'Retirement was refused.' })
    } finally {
      setBusy(false)
    }
  }

  const selected = assets.find((a) => a.profile.assetId === assetId)

  return (
    <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>
        9 · Carbon credits: a second asset class, and a terminal state
      </h2>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.mut, maxWidth: 760 }}>
        The settlement core never knew what a property was, so a credit settles through the same atomic DvP with no
        special case. What carbon adds is retirement: a credit is permanently consumed against someone's emissions and
        must never trade again. The retired total keeps counting against issued supply, which is what makes the same
        tonne impossible to sell twice.
      </p>

      {assets.length === 0 && (
        <div style={{ marginTop: 14, fontSize: 13, color: C.mut }}>No carbon assets are registered on this rail yet.</div>
      )}

      {assets.map((a) => {
        const p = a.profile
        const authorised = a.authorisedTokens || 0
        const outstanding = a.outstandingTokens || 0
        const retired = a.retiredTokens || 0
        return (
          <div key={p.assetId} style={{ marginTop: 14, border: `1px solid ${C.line}`, borderRadius: 11, padding: 14 }}>
            <div style={{ fontWeight: 700, color: C.navy, fontSize: 14 }}>{p.name || p.assetId}</div>
            <div style={{ fontSize: 11.5, color: C.mut, marginTop: 3 }}>
              {p.assetId}{p.vintage ? ` · vintage ${p.vintage}` : ''}{p.country ? ` · ${p.country}` : ''}
              {p.projectId ? ` · project ${p.projectId}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 11 }}>
              <div><div style={{ fontSize: 11, color: C.mut }}>Issued</div><div style={{ fontWeight: 700 }}>{n(authorised)}</div></div>
              <div><div style={{ fontSize: 11, color: C.mut }}>In circulation</div><div style={{ fontWeight: 700 }}>{n(outstanding)}</div></div>
              <div><div style={{ fontSize: 11, color: C.mut }}>Retired</div><div style={{ fontWeight: 700, color: C.green }}>{n(retired)}</div></div>
            </div>
            <div style={{
              marginTop: 10, fontSize: 12, fontFamily: 'ui-monospace, monospace',
              color: a.conserved ? C.green : '#B91C1C',
              background: a.conserved ? C.greenBg : '#FEF2F2',
              border: `1px solid ${a.conserved ? '#A7F3D0' : '#FECACA'}`,
              borderRadius: 8, padding: '7px 10px',
            }}>
              {n(outstanding)} in circulation + {n(retired)} retired = {n(outstanding + retired)} of {n(authorised)} ever issued
              {a.conserved ? ' · conserved' : ' · BREACH, credits exist beyond what was issued'}
            </div>
          </div>
        )
      })}

      {assets.length > 0 && (
        <div style={{ marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.navy, marginBottom: 10 }}>Retire credits</div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            <Field label="Asset">
              <select style={input} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                {assets.map((a) => <option key={a.profile.assetId} value={a.profile.assetId}>{a.profile.name || a.profile.assetId}</option>)}
              </select>
            </Field>
            <Field label="Holder" hint="Whose credits are being consumed">
              <select style={input} value={holder} onChange={(e) => setHolder(e.target.value)}>
                <option value="">Select</option>
                {participants.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Credits"><input style={input} value={tokens} onChange={(e) => setTokens(e.target.value)} inputMode="numeric" /></Field>
            <Field label="Claimed for" hint="The organisation offsetting">
              <input style={input} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} />
            </Field>
            <Field label="Reason"><input style={input} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </div>
          <button
            onClick={retire}
            disabled={busy || !assetId || !holder || !Number(tokens)}
            style={{
              marginTop: 12, padding: '9px 16px', borderRadius: 9, border: 'none',
              background: busy ? '#9CA3AF' : C.navy, color: 'white', fontWeight: 600, fontSize: 13,
              cursor: busy ? 'default' : 'pointer',
            }}>
            {busy ? 'Retiring...' : 'Retire permanently'}
          </button>
          <span style={{ marginLeft: 10, fontSize: 11.5, color: C.mut }}>
            There is no un-retire. A retirement that could be reversed would not be one.
          </span>
          {selected && (
            <div style={{ fontSize: 11.5, color: C.mut, marginTop: 6 }}>
              {n(selected.outstandingTokens)} credits are currently in circulation for this asset.
            </div>
          )}
          {msg && (
            <div style={{
              marginTop: 11, padding: '9px 12px', borderRadius: 9, fontSize: 12.5,
              background: msg.ok ? C.greenBg : '#FEF2F2',
              border: `1px solid ${msg.ok ? '#A7F3D0' : '#FECACA'}`,
              color: msg.ok ? C.green : '#B91C1C',
            }}>{msg.text}</div>
          )}
        </div>
      )}

      {retirements.length > 0 && (
        <div style={{ marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.navy, marginBottom: 8 }}>Retirement register</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: C.mut, fontSize: 11, textTransform: 'uppercase', letterSpacing: .4 }}>
                  <th style={{ padding: '6px 8px' }}>Retirement</th>
                  <th style={{ padding: '6px 8px' }}>Credits</th>
                  <th style={{ padding: '6px 8px' }}>Claimed for</th>
                  <th style={{ padding: '6px 8px' }}>Reason</th>
                  <th style={{ padding: '6px 8px' }}>Proof</th>
                </tr>
              </thead>
              <tbody>
                {retirements.map((r) => (
                  <tr key={r.retirementId} style={{ borderTop: `1px solid ${C.line}` }}>
                    <td style={{ padding: '7px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>{r.retirementId}</td>
                    <td style={{ padding: '7px 8px', fontWeight: 600 }}>{n(r.tokens)}</td>
                    <td style={{ padding: '7px 8px' }}>{r.beneficiary}</td>
                    <td style={{ padding: '7px 8px', color: C.mut }}>{r.reason || '-'}</td>
                    <td style={{ padding: '7px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>block {r.blockHeight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
