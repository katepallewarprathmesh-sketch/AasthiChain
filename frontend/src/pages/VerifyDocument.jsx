// Public document verification.
//
// This is the page the whole document subsystem exists for. Someone holding a
// PDF — a buyer, a lender, a lawyer, a tax officer — drops it here and learns
// whether it is the document AasthiChain anchored, or a changed copy.
//
// The file never leaves the browser. SHA-256 is computed with crypto.subtle
// and only the 64-hex digest is sent. That is also why this works offline
// against any IPFS gateway: the digest is the whole identity of the document.
import React, { useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'

const NAVY = '#1E3A5F'
const PAPER = '#F7F5F0'

async function sha256Hex(file) {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function Row({ label, children, mono }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '9px 0', borderBottom: '1px solid #F3F4F6', fontSize: 13 }}>
      <div style={{ width: 150, flexShrink: 0, color: '#6B7280' }}>{label}</div>
      <div style={{
        color: '#111827', wordBreak: 'break-all', flex: 1,
        fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
        fontSize: mono ? 12 : 13,
      }}>{children}</div>
    </div>
  )
}

function Verdict({ v }) {
  // Three outcomes, and they are deliberately not all "red or green". A
  // document can be genuine but withdrawn, which is a different conversation
  // from a document that was altered.
  const anchored = v.anchored
  const bad = !anchored
  const warn = anchored && (v.status !== 'ACTIVE' || v.expired)

  const tone = bad
    ? { bg: '#FEF2F2', border: '#FCA5A5', fg: '#991B1B', mark: '✕' }
    : warn
      ? { bg: '#FFFBEB', border: '#FCD34D', fg: '#92400E', mark: '!' }
      : { bg: '#F0FDF4', border: '#86EFAC', fg: '#166534', mark: '✓' }

  const headline = bad
    ? 'This document is not in the register'
    : warn
      ? (v.expired ? 'Anchored, but past its validity date' : `Anchored, but marked ${v.status}`)
      : 'Genuine and current'

  const detail = bad
    ? 'No record matches this file. Either it was never anchored by AasthiChain, or its contents have been changed since — even by a single character. Ask whoever gave it to you for the version they registered.'
    : warn
      ? (v.status === 'REVOKED'
        ? 'This document was anchored by AasthiChain and then withdrawn. It is authentic but should no longer be relied on. If it was replaced, ask for the superseding document.'
        : v.status === 'SUPERSEDED'
          ? 'This is a genuine earlier version. A newer document has replaced it.'
          : 'This document is genuine but is outside the validity window it was registered with.')
      : 'Every byte of this file matches what was recorded on the ledger. It has not been altered since it was anchored.'

  return (
    <div style={{ background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 26, height: 26, borderRadius: '50%', background: tone.fg, color: 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700,
        }}>{tone.mark}</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: tone.fg }}>{headline}</div>
      </div>
      <p style={{ fontSize: 13.5, color: tone.fg, lineHeight: 1.65, margin: '12px 0 0' }}>{detail}</p>

      {anchored && (
        <div style={{ marginTop: 16, background: 'white', borderRadius: 10, padding: '4px 16px 10px' }}>
          {v.docType && <Row label="Document type">{String(v.docType).replace(/_/g, ' ').toLowerCase()}</Row>}
          {v.assetId && (
            <Row label="Property">
              <Link to={`/property/${v.assetId}`} style={{ color: NAVY, fontWeight: 600 }}>{v.assetId}</Link>
            </Row>
          )}
          <Row label="Anchored at" >{v.anchoredAt ? new Date(v.anchoredAt).toLocaleString('en-IN') : '—'}</Row>
          <Row label="Ledger block">#{v.blockHeight}</Row>
          <Row label="Block hash" mono>{v.blockHash}</Row>
          <Row label="IPFS address" mono>{v.cid}</Row>
          <Row label="SHA-256" mono>{v.sha256}</Row>
        </div>
      )}

      {anchored && v.cid && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: tone.fg, lineHeight: 1.6 }}>
          Don't take our word for it — fetch the same document straight from the
          public IPFS network:{' '}
          <a href={`https://ipfs.io/ipfs/${v.cid}`} target="_blank" rel="noreferrer"
             style={{ color: NAVY, fontWeight: 600, wordBreak: 'break-all' }}>
            ipfs.io/ipfs/{v.cid.slice(0, 18)}…
          </a>
        </div>
      )}
    </div>
  )
}

export default function VerifyDocument() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const [digest, setDigest] = useState('')
  const [manual, setManual] = useState('')
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)

  const runVerify = useCallback(async (payload, label, localDigest) => {
    setBusy(true); setError(''); setResult(null)
    setFileName(label || ''); setDigest(localDigest || '')
    try {
      const res = await api.umiVerifyDocument(payload)
      const v = res?.verification || res?.data?.verification
      if (!v) throw new Error('The register did not return a verdict.')
      setResult(v)
    } catch (e) {
      setError(e?.message || 'Could not reach the document register.')
    } finally {
      setBusy(false)
    }
  }, [])

  const onFile = useCallback(async (file) => {
    if (!file) return
    setBusy(true); setError(''); setResult(null); setFileName(file.name)
    try {
      const hex = await sha256Hex(file)
      await runVerify({ sha256: hex }, file.name, hex)
    } catch (e) {
      setError('Could not read that file in the browser.')
      setBusy(false)
    }
  }, [runVerify])

  const onManual = useCallback(() => {
    const q = manual.trim()
    if (!q) return
    // A CID and a SHA-256 are both accepted; the register tells them apart.
    const payload = /^[0-9a-fA-F]{64}$/.test(q) ? { sha256: q.toLowerCase() } : { cid: q }
    runVerify(payload, q, /^[0-9a-fA-F]{64}$/.test(q) ? q.toLowerCase() : '')
  }, [manual, runVerify])

  return (
    <div style={{ minHeight: '100vh', background: PAPER, padding: '40px 20px 80px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <h1 style={{
          fontFamily: 'Fraunces, Georgia, serif', fontSize: 34, color: NAVY,
          margin: 0, lineHeight: 1.2,
        }}>
          Verify a property document
        </h1>
        <p style={{ fontSize: 15, color: '#4B5563', lineHeight: 1.7, marginTop: 12 }}>
          Drop in a title deed, validation certificate, contract note or payment
          receipt. We will tell you whether it is exactly the document that was
          recorded on the ledger, or a copy that has been changed.
        </p>
        <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.65, marginTop: 8 }}>
          <strong style={{ color: '#374151' }}>Your file is never uploaded.</strong>{' '}
          It is fingerprinted inside your browser and only the fingerprint is
          sent. Nothing here requires an account.
        </p>

        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files?.[0]) }}
          onClick={() => inputRef.current?.click()}
          style={{
            marginTop: 26, background: dragging ? '#EEF2FF' : 'white',
            border: `2px dashed ${dragging ? NAVY : '#D1D5DB'}`,
            borderRadius: 14, padding: '38px 20px', textAlign: 'center', cursor: 'pointer',
            transition: 'background 120ms, border-color 120ms',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 650, color: NAVY }}>
            {busy ? 'Checking…' : 'Drop a document here, or click to choose'}
          </div>
          <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 7 }}>
            PDF, image or any file. It stays on your device.
          </div>
          <input ref={inputRef} type="file" style={{ display: 'none' }}
                 onChange={e => onFile(e.target.files?.[0])} />
        </div>

        <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>
          <input
            value={manual}
            onChange={e => setManual(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onManual() }}
            placeholder="…or paste an IPFS address (bafkrei…) or SHA-256"
            style={{
              flex: 1, padding: '11px 13px', borderRadius: 9, border: '1px solid #D1D5DB',
              fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              background: 'white', color: '#111827',
            }}
          />
          <button onClick={onManual} disabled={busy || !manual.trim()} style={{
            padding: '11px 20px', borderRadius: 9, border: 'none', background: NAVY,
            color: 'white', fontSize: 13.5, fontWeight: 650,
            cursor: busy || !manual.trim() ? 'default' : 'pointer',
            opacity: busy || !manual.trim() ? 0.5 : 1,
          }}>Check</button>
        </div>

        {fileName && digest && (
          <div style={{
            marginTop: 16, fontSize: 12, color: '#6B7280',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all',
          }}>
            {fileName} → {digest}
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 18, background: '#FEF2F2', border: '1px solid #FCA5A5',
            borderRadius: 10, padding: 15, fontSize: 13.5, color: '#991B1B',
          }}>{error}</div>
        )}

        {result && <div style={{ marginTop: 22 }}><Verdict v={result} /></div>}

        <div style={{
          marginTop: 40, background: 'white', border: '1px solid #E5E7EB',
          borderRadius: 12, padding: '20px 22px',
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>
            Why you don't have to trust us
          </h2>
          <p style={{ fontSize: 13.5, color: '#4B5563', lineHeight: 1.7, marginTop: 10 }}>
            Every anchored document gets an IPFS address derived from its
            contents by standard maths — change one byte and the address
            changes. That address, plus the exact time, is written into a block
            on the AasthiChain ledger, and each block carries the hash of the
            one before it. To fake a document, someone would have to rewrite
            every block that came after it, on every copy of the ledger.
          </p>
          <p style={{ fontSize: 13.5, color: '#4B5563', lineHeight: 1.7, marginTop: 10 }}>
            You can also skip this page entirely. Run{' '}
            <code style={{
              background: '#F3F4F6', padding: '2px 6px', borderRadius: 4, fontSize: 12,
            }}>ipfs add --cid-version=1 --raw-leaves yourfile.pdf</code>{' '}
            yourself, and compare the address to the one on the{' '}
            <Link to="/ledger" style={{ color: NAVY, fontWeight: 600 }}>public ledger</Link>.
            Our servers are not part of that check.
          </p>
          <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.65, marginTop: 12 }}>
            Identity documents are handled differently: KYC evidence is
            fingerprinted but never stored, so a DigiLocker record can be proven
            without anyone — including us — being able to retrieve it.
          </p>
        </div>
      </div>
    </div>
  )
}
