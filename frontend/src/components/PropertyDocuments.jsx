import React, { useEffect, useState } from 'react'
import api from '../lib/api.js'

// The document register for one property.
//
// The important interaction here is "check my copy". The browser hashes the
// file with WebCrypto and sends only the resulting digest, so the deed never
// leaves the machine — which is both the privacy-preserving answer and the
// honest one, because verification genuinely does not require us to see the
// document. It replaces asking a buyer to run sha256sum in a terminal and
// paste 64 characters, which almost nobody will do.

const STATUS_STYLES = {
  ACTIVE: { bg: '#F0FDF4', fg: '#047857', border: '#BBF7D0', label: 'Current' },
  SUPERSEDED: { bg: '#F8FAFC', fg: '#475569', border: '#E2E8F0', label: 'Superseded' },
  REVOKED: { bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA', label: 'Revoked' },
}

function prettyType(t) {
  return String(t || '').replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase())
}

function bytesLabel(n) {
  if (!n) return null
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Hash a file in the browser. Returns lowercase hex, the same shape the
// ledger stores.
async function sha256OfFile(file) {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export default function PropertyDocuments({ assetId }) {
  const [docs, setDocs] = useState(null)       // null = loading, [] = none, false = unreachable
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState(null)
  const [fileName, setFileName] = useState('')

  useEffect(() => {
    let alive = true
    api.umiDocuments(assetId)
      .then(r => { if (alive) setDocs(Array.isArray(r.documents) ? r.documents : []) })
      .catch(() => { if (alive) setDocs(false) })
    return () => { alive = false }
  }, [assetId])

  async function checkFile(file) {
    if (!file) return
    setChecking(true); setResult(null); setFileName(file.name)
    try {
      const sha256 = await sha256OfFile(file)
      const res = await api.umiVerifyDocument({ sha256 })
      setResult({ ...(res.verification || {}), sha256 })
    } catch (e) {
      setResult({ error: e.message || 'That file could not be checked.' })
    } finally {
      setChecking(false)
    }
  }

  if (docs === false) return null // register unreachable: say nothing rather than imply there are no documents

  return (
    <section style={{ marginTop: 24, background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>Documents</h3>
        <span style={{ fontSize: 11.5, color: '#6B7280' }}>
          Addressed by IPFS CID · anchored to the ledger
        </span>
      </div>

      <p style={{ fontSize: 12.5, color: '#4B5563', marginTop: 8, lineHeight: 1.6 }}>
        Each document is named by a hash of its own contents, so a changed file gets a different
        name and stops matching. You do not have to trust this page: hash your copy and compare.
      </p>

      {docs === null && <p style={{ fontSize: 12.5, color: '#6B7280' }}>Loading…</p>}

      {Array.isArray(docs) && docs.length === 0 && (
        <p style={{ fontSize: 12.5, color: '#6B7280', margin: '8px 0 0' }}>
          No document has been anchored for this property yet.
        </p>
      )}

      {Array.isArray(docs) && docs.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
          {docs.map(d => {
            const st = STATUS_STYLES[d.status] || STATUS_STYLES.ACTIVE
            return (
              <li key={d.cid} style={{ padding: '12px 0', borderTop: '1px solid #F3F4F6' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13, color: '#111827' }}>{prettyType(d.docType)}</strong>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20,
                    background: st.bg, color: st.fg, border: `1px solid ${st.border}`,
                  }}>{st.label}</span>
                  {d.expired && (
                    <span style={{ fontSize: 11, color: '#B45309' }}>validity period ended</span>
                  )}
                  {d.visibility === 'digestOnly' && (
                    <span style={{ fontSize: 11, color: '#6B7280' }}>fingerprint only — not stored</span>
                  )}
                </div>

                {d.statusReason && (
                  <p style={{ fontSize: 12, color: '#B91C1C', margin: '4px 0 0' }}>{d.statusReason}</p>
                )}

                <code style={{
                  display: 'block', fontSize: 11, color: '#4B5563', marginTop: 6,
                  wordBreak: 'break-all', fontFamily: 'monospace',
                }}>{d.cid}</code>

                <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {d.blockHeight ? <span>ledger block #{d.blockHeight}</span> : null}
                  {bytesLabel(d.sizeBytes) ? <span>{bytesLabel(d.sizeBytes)}</span> : null}
                  {d.issuer ? <span>issued by {d.issuer}</span> : null}
                  {d.visibility === 'public' && d.pinned && (
                    <a href={`/api/umi/documents/fetch/${d.cid}`} target="_blank" rel="noreferrer"
                       style={{ color: '#1E3A5F', fontWeight: 600 }}>open document</a>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Verify a copy — hashing happens in the browser. */}
      <div style={{ marginTop: 16, padding: 14, background: '#F9FAFB', border: '1px dashed #D1D5DB', borderRadius: 10 }}>
        <strong style={{ fontSize: 13, color: '#111827' }}>Check the copy you were sent</strong>
        <p style={{ fontSize: 12, color: '#6B7280', margin: '6px 0 10px', lineHeight: 1.6 }}>
          Your file is hashed here in your browser and never uploaded. Only the fingerprint is sent.
        </p>
        <input
          type="file"
          aria-label="document to check"
          onChange={e => checkFile(e.target.files && e.target.files[0])}
          style={{ fontSize: 12.5 }}
        />
        {checking && <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8 }}>Hashing {fileName}…</p>}

        {result && !checking && (
          <div style={{
            marginTop: 10, padding: 12, borderRadius: 8, fontSize: 12.5, lineHeight: 1.6,
            background: result.anchored && result.status === 'ACTIVE' ? '#F0FDF4'
              : result.anchored ? '#FFFBEB' : '#FEF2F2',
            border: `1px solid ${result.anchored && result.status === 'ACTIVE' ? '#BBF7D0'
              : result.anchored ? '#FDE68A' : '#FECACA'}`,
            color: result.anchored && result.status === 'ACTIVE' ? '#047857'
              : result.anchored ? '#B45309' : '#B91C1C',
          }}>
            {result.error
              ? result.error
              : result.anchored
                ? <>
                    <strong>{result.verdict}</strong>
                    {result.blockHeight ? <> — anchored in ledger block #{result.blockHeight}.</> : null}
                  </>
                : <>
                    <strong>This file does not match anything on the register.</strong>
                    {' '}Either it was never anchored, or it is not the document that was.
                  </>}
            <code style={{ display: 'block', fontSize: 10.5, marginTop: 6, wordBreak: 'break-all', opacity: 0.8 }}>
              sha256 {result.sha256}
            </code>
          </div>
        )}
      </div>
    </section>
  )
}
