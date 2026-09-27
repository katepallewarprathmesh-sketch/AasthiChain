// Support page: fund open-source development of AasthiChain.
// Primary channel: GitHub Sponsors (payouts to India via Stripe Connect).
// Direct channel: UPI (works when the maintainer sets UPI_ID below).
//
// MAINTAINER: paste your UPI ID here to activate the UPI card (QR + deep link
// render automatically). Example: 'yourname@oksbi'
const UPI_ID = '80105301033@axl'

import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import qrcode from 'qrcode-generator'

const SPONSORS_URL = 'https://github.com/sponsors/katepallewarprathmesh-sketch'
const BMC_URL = 'https://buymeacoffee.com/prathmesh_1903'

function upiLink(vpa) {
  return `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent('AasthiChain OSS')}&cu=INR&tn=${encodeURIComponent('AasthiChain open-source support')}`
}

function QrCard() {
  const [copied, setCopied] = useState(false)
  if (!UPI_ID) {
    return (
      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>One-time UPI</h3>
        <div style={{ marginTop: 12, padding: '26px 16px', border: '1px dashed #D1D5DB', borderRadius: 10, textAlign: 'center', background: '#F9FAFB' }}>
          <div style={{ fontSize: 26 }}>?</div>
          <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8, lineHeight: 1.6 }}>
            UPI support activates once the maintainer adds their UPI ID.<br />
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#9CA3AF' }}>src/pages/Support.jsx &rarr; UPI_ID</span>
          </div>
        </div>
      </div>
    )
  }
  const qr = qrcode(0, 'M')
  qr.addData(upiLink(UPI_ID))
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  const copy = async () => {
    try { await navigator.clipboard.writeText(UPI_ID); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch {}
  }
  return (
    <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>One-time UPI</h3>
      <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ width: 148, height: 148, padding: 8, border: '1px solid #E5E7EB', borderRadius: 10, background: 'white', flexShrink: 0 }}
          dangerouslySetInnerHTML={{ __html: svg.replace('<svg', '<svg style="width:100%;height:100%;display:block"') }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.6 }}>
            Scan with any UPI app (PhonePe, GooglePay, Paytm, BHIM) or tap below on mobile. Money goes directly to the maintainer's bank account. No platform fees.
          </div>
          <button onClick={copy} style={{ marginTop: 10, padding: '8px 12px', fontSize: 12, fontFamily: 'monospace', fontWeight: 600, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, cursor: 'pointer', color: '#374151' }}>
            {copied ? 'Copied!' : UPI_ID}
          </button>
          <a href={upiLink(UPI_ID)} style={{ display: 'block', textAlign: 'center', marginTop: 10, padding: '10px 16px', background: '#1E3A5F', color: 'white', textDecoration: 'none', fontSize: 13, fontWeight: 600, borderRadius: 8 }}>
            Open UPI app to pay
          </a>
        </div>
      </div>
    </div>
  )
}

export default function Support() {
  const costs = [
    ['Database (Neon Postgres)', 'ledger state, payments, audit trail'],
    ['Hosting (Vercel)', 'the app you are using right now'],
    ['Domain + TLS', 'aasthi-chain.vercel.app today, custom domain next'],
    ['Testnet ledger nodes', 'Drunix simulation and future Fabric testnet'],
  ]
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 16px 64px' }}>
      <Link to="/" style={{ fontSize: 13, color: '#1E3A5F', textDecoration: 'none', fontWeight: 500 }}>&larr; Back to AasthiChain</Link>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827', margin: '14px 0 6px' }}>Support this project</h1>
      <p style={{ fontSize: 14, color: '#6B7280', lineHeight: 1.7, maxWidth: '70ch' }}>
        AasthiChain is open-source: a permissioned fractional-ownership platform on a hash-chained Drunix ledger,
        with honest, clearly-labeled payment rails. Donations fund infrastructure and continued development.
        Support is a donation to open-source work. It is not an investment, and it confers no ownership, returns, or tokens.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginTop: 22 }}>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>GitHub Sponsors</h3>
          <p style={{ fontSize: 12.5, color: '#6B7280', lineHeight: 1.6, marginTop: 8 }}>
            Monthly or one-time, card or your local methods. Payouts reach the maintainer in India via Stripe Connect.
          </p>
          <div style={{ marginTop: 10, fontSize: 12, color: '#374151', lineHeight: 1.9 }}>
            <div>&#8377;100 Supporter: name in the README supporters list</div>
            <div>&#8377;500 Backer: above + sponsor badge on the repo</div>
            <div>&#8377;2,000 Infrastructure Patron: covers a month of running costs</div>
          </div>
          <a href={SPONSORS_URL} target="_blank" rel="noopener" style={{ display: 'block', textAlign: 'center', marginTop: 14, padding: '11px 16px', background: '#24292F', color: 'white', textDecoration: 'none', fontSize: 13, fontWeight: 600, borderRadius: 8 }}>
            &#10084; Sponsor on GitHub
          </a>
        </div>

        <QrCard />

        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Buy Me a Coffee</h3>
          <p style={{ fontSize: 12.5, color: '#6B7280', lineHeight: 1.6, marginTop: 8 }}>
            enjoyed the demo? bought tokens with test money? send a real coffee. one-time, card or UPI, international friendly.
          </p>
          <a href={BMC_URL} target="_blank" rel="noopener" style={{ display: 'block', textAlign: 'center', marginTop: 14, padding: '11px 16px', background: '#FFDD00', color: '#0D0C22', textDecoration: 'none', fontSize: 13, fontWeight: 700, borderRadius: 8 }}>
            &#9749; buymeacoffee.com/prathmesh_1903
          </a>
        </div>
      </div>

      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 14 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Where the money goes</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginTop: 12 }}>
          {costs.map(([t, d]) => (
            <div key={t} style={{ background: '#F9FAFB', border: '1px solid #F3F4F6', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{t}</div>
              <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 4, lineHeight: 1.6 }}>{d}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: '#9CA3AF', marginTop: 12, lineHeight: 1.6 }}>
          A short "what your support funded" note is posted with each meaningful milestone. Statements are kept for transparency.
        </div>
      </div>
    </div>
  )
}
