import React, { useState, useEffect } from 'react'
import { money } from '../lib/format.js'
import api from '../lib/api.js'

// SOLID: Single Responsibility Only regulator audit for layman

export default function Regulator({ user }) {
  const [transfers, setTransfers] = useState([])
  const [properties, setProperties] = useState([])
  const [filterAsset, setFilterAsset] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    fetchAll()
  }, [user?.identityId, filterAsset])

  const fetchAll = async () => {
    try {
      const propData = await api.listProperties()
      setProperties(propData.properties || [])

      const histData = await api.getTransferHistory(filterAsset, '', 10, '')
      setTransfers(histData.transfers || [])
    } catch {}
  }

  const handleFreeze = async (assetId) => {
    const reason = prompt('Why freeze this property? (e.g., fraud detected)')
    if (!reason) return
    if (!confirm(`Freeze ${assetId}? No transfers possible until unfrozen. Reason: ${reason}`)) return
    
    try {
      await api.freezeProperty(assetId, reason)
      alert(`Property frozen: ${assetId}`)
      fetchAll()
    } catch (e) {
      alert(`Freeze failed: ${e.message}`)
    }
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 16px', minWidth: 0 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>Audit & Safety</h1>
      <p style={{ color: '#6B7280', fontSize: 14, marginTop: 6, maxWidth: '70ch' }}>
        Monitor all properties and transfers, and produce the reports a securities
        regulator would ask for. Nothing here is filed with or seen by SEBI, RBI,
        NPCI, NSDL or CDSL.
      </p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 18, borderBottom: '1px solid #E5E7EB', paddingBottom: 0 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '9px 14px',
              background: 'none',
              border: 'none',
              borderBottom: tab === t.id ? '2px solid #1E3A5F' : '2px solid transparent',
              color: tab === t.id ? '#1E3A5F' : '#6B7280',
              fontSize: 13,
              fontWeight: tab === t.id ? 700 : 500,
              cursor: 'pointer',
              marginBottom: -1
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (<>

      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 20 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>All Properties</h3>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16, maxHeight: 400, overflowY: 'auto' }}>
          {properties.map(p => (
            <div key={p.assetId} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              background: '#F9FAFB',
              border: '1px solid #F3F4F6',
              borderRadius: 8,
              padding: 14,
              minWidth: 0
            }}>
              <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', overflowWrap: 'anywhere' }}>{p.title}</div>
                <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
                  {p.location?.city || ''} • {money(p.valuationINR)} • {p.totalTokens || 0} tokens • {p.status}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 }}>
                <button
                  onClick={() => handleFreeze(p.assetId)}
                  style={{
                    padding: '6px 12px',
                    background: 'white',
                    color: '#DC2626',
                    border: '1px solid #FECACA',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  Freeze
                </button>
                <button
                  onClick={async () => {
                    if (!confirm(`Remove listing "${p.title}" from the marketplace? Investors keep their tokens; ledger history is preserved.`)) return
                    try {
                      await api.deleteProperty(p.assetId)
                      setProperties(props => props.filter(x => x.assetId !== p.assetId))
                    } catch (e) {
                      alert(e.data?.message || e.message || 'Delete failed')
                    }
                  }}
                  style={{ padding: '6px 12px', background: '#DC2626', color: 'white', border: '1px solid #DC2626', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  Remove Listing
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Recent Transfers</h3>
          <select
            value={filterAsset}
            onChange={e => setFilterAsset(e.target.value)}
            style={{
              padding: '8px 12px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              fontSize: 13,
              background: 'white'
            }}
          >
            <option value="">All Properties</option>
            {properties.map(p => <option key={p.assetId} value={p.assetId}>{p.title?.slice(0, 20)}</option>)}
          </select>
        </div>

        <div className="audit-scroll" style={{ overflowX: 'auto', marginTop: 16, WebkitOverflowScrolling: 'touch' }}>
          <table className="audit-table" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr style={{ color: '#9CA3AF', borderBottom: '1px solid #F3F4F6', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
                <th style={{ padding: '10px 8px' }}>From → To</th>
                <th style={{ padding: '10px 8px' }}>Tokens</th>
                <th style={{ padding: '10px 8px' }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map(t => (
                <tr key={t.transferId} style={{ borderBottom: '1px solid #F9FAFB' }}>
                  <td style={{ padding: '10px 8px', overflowWrap: 'anywhere' }}>{t.fromId} → {t.toId}</td>
                  <td style={{ padding: '10px 8px', fontWeight: 600 }}>{t.amount}</td>
                  <td style={{ padding: '10px 8px', color: '#6B7280', fontSize: 12 }}>{new Date(t.txTimestamp).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {transfers.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: '#9CA3AF', fontSize: 13 }}>No transfers yet</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            fontSize: 12,
            color: '#9CA3AF',
            background: 'none',
            border: '1px dashed #E5E7EB',
            padding: '6px 12px',
            borderRadius: 20,
            cursor: 'pointer'
          }}
        >
          {showAdvanced ? 'Hide' : 'Show'} Advanced
        </button>
      </div>

      {showAdvanced && (
        <div style={{ marginTop: 16, background: '#F9FAFB', border: '1px dashed #E5E7EB', borderRadius: 12, padding: 16 }}>
          <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: '#6B7280' }}>Advanced For Developers</h4>
          <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>Technical audit details</p>
          <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace', background: 'white', overflowX: 'auto', overflowWrap: 'anywhere', padding: 10, borderRadius: 6, border: '1px solid #E5E7EB' }}>
            Total properties: {properties.length}<br/>
            Total transfers: {transfers.length}<br/>
            User: {user?.identityId} ({user?.role})<br/>
            Indexes: idx_transfer_asset_time, idx_balance_asset
          </div>
        </div>
      )}
      </>)}

      {tab === 'captable' && <CapTablePanel properties={properties} />}
      {tab === 'audit' && <AuditPanel properties={properties} />}
      {tab === 'alerts' && <AlertsPanel />}
      {tab === 'scheme' && <SchemePanel properties={properties} />}
      {tab === 'actions' && <ActionLogPanel />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Supervisory reporting panels.
//
// These read /api/regulator/* — the evidence surface a securities regulator
// consumes. Nothing below is filed with or acknowledged by any regulator; the
// server states that on every response and the UI repeats it.
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'captable', label: 'Cap table' },
  { id: 'audit', label: 'Audit export' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'scheme', label: 'SM REIT check' },
  { id: 'actions', label: 'Action log' },
]

const NAVY = '#1E3A5F'
const INK = '#111827'
const MUTED = '#6B7280'
const LINE = '#E5E7EB'

function Card({ title, sub, children, right }) {
  return (
    <div style={{ background: 'white', border: `1px solid ${LINE}`, borderRadius: 12, padding: 20, marginTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: INK, margin: 0 }}>{title}</h3>
          {sub && <p style={{ fontSize: 13, color: MUTED, marginTop: 6, maxWidth: '68ch', lineHeight: 1.55 }}>{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

function StatusChip({ status }) {
  const map = {
    PASS: { bg: '#ECFDF5', fg: '#047857', bd: '#A7F3D0' },
    FAIL: { bg: '#FEF2F2', fg: '#B91C1C', bd: '#FECACA' },
    NOT_MODELLED: { bg: '#F9FAFB', fg: '#6B7280', bd: '#E5E7EB' },
    HIGH: { bg: '#FEF2F2', fg: '#B91C1C', bd: '#FECACA' },
    MEDIUM: { bg: '#FFFBEB', fg: '#B45309', bd: '#FDE68A' },
    LOW: { bg: '#F9FAFB', fg: '#6B7280', bd: '#E5E7EB' },
  }
  const c = map[status] || map.LOW
  return (
    <span style={{ background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {String(status).replace(/_/g, ' ')}
    </span>
  )
}

function Empty({ children }) {
  return <div style={{ textAlign: 'center', padding: '28px 0', color: '#9CA3AF', fontSize: 13 }}>{children}</div>
}

function AssetPicker({ properties, value, onChange }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{ padding: '8px 12px', border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 13, background: 'white', maxWidth: 260 }}
    >
      {properties.map(p => <option key={p.assetId} value={p.assetId}>{p.title}</option>)}
    </select>
  )
}

// Shared fetch wrapper — surfaces the server's own error text rather than a generic one.
function useReport(path, deps, enabled = true) {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  useEffect(() => {
    let live = true
    if (!enabled) { setState({ loading: false, data: null, error: null }); return }
    setState(s => ({ ...s, loading: true, error: null }))
    api.request(path)
      .then(d => { if (live) setState({ loading: false, data: d, error: null }) })
      .catch(e => { if (live) setState({ loading: false, data: null, error: e.data?.message || e.message }) })
    return () => { live = false }
  }, deps)
  return state
}

function Loading() {
  return <div style={{ padding: '24px 0', color: '#9CA3AF', fontSize: 13 }}>Loading…</div>
}

function ErrorNote({ children }) {
  return (
    <div style={{ marginTop: 14, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 12, fontSize: 13, color: '#B91C1C' }}>
      {children}
    </div>
  )
}

// --- Cap table -------------------------------------------------------------

function CapTablePanel({ properties }) {
  const [assetId, setAssetId] = useState(properties[0]?.assetId || '')
  const [asOf, setAsOf] = useState('')
  useEffect(() => { if (!assetId && properties[0]) setAssetId(properties[0].assetId) }, [properties])

  const q = `/api/regulator/cap-table?assetId=${encodeURIComponent(assetId)}${asOf ? `&asOf=${encodeURIComponent(new Date(asOf).toISOString())}` : ''}`
  const { loading, data, error } = useReport(q, [assetId, asOf], Boolean(assetId))

  return (
    <Card
      title="Unit holder register"
      sub="Who holds what, and whether the register reconciles with the tokens actually issued. Set a date to replay the register backwards through every transfer since — a cap table you cannot re-derive for a past date is not evidence."
      right={<AssetPicker properties={properties} value={assetId} onChange={setAssetId} />}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
        <label style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>As of</label>
        <input
          type="datetime-local"
          value={asOf}
          onChange={e => setAsOf(e.target.value)}
          style={{ padding: '7px 10px', border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 13 }}
        />
        {asOf && (
          <button onClick={() => setAsOf('')} style={{ fontSize: 12, color: MUTED, background: 'none', border: `1px solid ${LINE}`, borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>
            Back to today
          </button>
        )}
      </div>

      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 16, paddingTop: 16, borderTop: `1px solid #F3F4F6` }}>
            <Stat label="Holders" value={data.holderCount} />
            <Stat label="Issued" value={`${data.reconciliation.issuedTokens.toLocaleString('en-IN')} / ${data.reconciliation.mintedTokens.toLocaleString('en-IN')}`} />
            <Stat label="Largest holder" value={`${data.concentration.largestHolderPercent}%`} />
            <Stat label="HHI" value={data.concentration.hhi} hint={data.concentration.hhi > 2500 ? 'concentrated' : 'dispersed'} />
            <Stat label="Reconciles" value={data.reconciliation.balanced ? 'Yes' : 'NO'} />
          </div>

          {data.asOfMode === 'REPLAYED_TO_CUTOFF' && (
            <div style={{ marginTop: 14, background: '#F9FAFB', border: `1px dashed ${LINE}`, borderRadius: 8, padding: 10, fontSize: 12, color: MUTED }}>
              Replayed to {new Date(data.asOf).toLocaleString('en-IN')} — {data.transfersRewound} transfer(s) rolled back.
            </div>
          )}

          <div style={{ overflowX: 'auto', marginTop: 16 }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr style={{ color: '#9CA3AF', borderBottom: `1px solid #F3F4F6`, textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
                  <th style={{ padding: '10px 8px' }}>Holder</th>
                  <th style={{ padding: '10px 8px' }}>Tokens</th>
                  <th style={{ padding: '10px 8px' }}>Share</th>
                  <th style={{ padding: '10px 8px' }}>Value</th>
                  <th style={{ padding: '10px 8px' }}>KYC</th>
                </tr>
              </thead>
              <tbody>
                {data.holders.map(h => (
                  <tr key={h.ownerId} style={{ borderBottom: '1px solid #F9FAFB' }}>
                    <td style={{ padding: '10px 8px', fontWeight: 600, overflowWrap: 'anywhere' }}>{h.ownerId}</td>
                    <td style={{ padding: '10px 8px' }}>{h.tokens.toLocaleString('en-IN')}</td>
                    <td style={{ padding: '10px 8px' }}>{h.percentOfIssued}%</td>
                    <td style={{ padding: '10px 8px' }}>{money(h.valueINR)}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <StatusChip status={h.kycStatus === 'VERIFIED' ? 'PASS' : 'FAIL'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.holders.length === 0 && <Empty>No holders at this date</Empty>}
          </div>
        </>
      )}
    </Card>
  )
}

function Stat({ label, value, hint }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#9CA3AF', fontWeight: 700, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: INK, marginTop: 3 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{hint}</div>}
    </div>
  )
}

// --- Audit export ----------------------------------------------------------

function AuditPanel({ properties }) {
  const [assetId, setAssetId] = useState('')
  const [verify, setVerify] = useState(null)
  const [busy, setBusy] = useState(false)
  const q = `/api/regulator/audit-export${assetId ? `?assetId=${encodeURIComponent(assetId)}` : ''}`
  const { loading, data, error } = useReport(q, [assetId])

  const runVerify = async (tamper) => {
    setBusy(true); setVerify(null)
    try {
      const doc = JSON.parse(JSON.stringify(data))
      if (tamper && doc.records.length > 1) {
        doc.records[1].tokens = (doc.records[1].tokens || 0) + 1
      }
      const r = await api.request('/api/regulator/audit-verify', { method: 'POST', body: JSON.stringify(doc) })
      setVerify({ ...r, tampered: Boolean(tamper) })
    } catch (e) {
      setVerify({ error: e.data?.message || e.message })
    } finally {
      setBusy(false)
    }
  }

  const csvUrl = `/api/regulator/audit-export?format=csv${assetId ? `&assetId=${encodeURIComponent(assetId)}` : ''}`

  return (
    <Card
      title="Tamper-evident audit export"
      sub="Every token movement, payment and supervisory action in one record set. Each row is hashed and each hash folds in the one before it, so altering or removing any single row breaks every hash after it."
      right={
        <select value={assetId} onChange={e => setAssetId(e.target.value)} style={{ padding: '8px 12px', border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 13, background: 'white', maxWidth: 260 }}>
          <option value="">All properties</option>
          {properties.map(p => <option key={p.assetId} value={p.assetId}>{p.title}</option>)}
        </select>
      }
    >
      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 16, paddingTop: 16, borderTop: '1px solid #F3F4F6' }}>
            <Stat label="Records" value={data.recordCount} />
            <Stat label="Chain" value="SHA-512" hint="each row folds in the previous hash" />
            <Stat label="Signature" value="HMAC-SHA512" hint="demo key, not an HSM" />
          </div>

          <div style={{ marginTop: 14, fontSize: 11, fontFamily: 'monospace', color: MUTED, background: '#F9FAFB', border: `1px solid ${LINE}`, borderRadius: 8, padding: 10, overflowWrap: 'anywhere' }}>
            chainHead {data.integrity.chainHead.slice(0, 48)}…
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <button onClick={() => runVerify(false)} disabled={busy} style={btn(NAVY, 'white')}>Verify integrity</button>
            <button onClick={() => runVerify(true)} disabled={busy} style={btn('white', '#B91C1C', '#FECACA')}>Tamper with a row, then verify</button>
            <a href={csvUrl} style={{ ...btn('white', INK, LINE), textDecoration: 'none', display: 'inline-block' }}>Download CSV</a>
          </div>

          {verify && !verify.error && (
            <div style={{
              marginTop: 14,
              background: verify.verified ? '#ECFDF5' : '#FEF2F2',
              border: `1px solid ${verify.verified ? '#A7F3D0' : '#FECACA'}`,
              borderRadius: 8, padding: 12, fontSize: 13, color: verify.verified ? '#047857' : '#B91C1C'
            }}>
              <strong>{verify.verified ? 'Chain intact and signature valid.' : 'Verification failed.'}</strong>{' '}
              {verify.tampered
                ? 'One row was edited in the browser before sending. The server re-derived every hash and rejected it — this is the check working.'
                : `${verify.recordCount} records re-derived independently from the document.`}
              {(verify.failures || []).length > 0 && (
                <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 11 }}>
                  row {verify.failures[0].seq} · {verify.failures[0].problem} · {verify.failures[0].ref}
                </div>
              )}
            </div>
          )}
          {verify?.error && <ErrorNote>{verify.error}</ErrorNote>}

          <div style={{ marginTop: 16, fontSize: 12, color: MUTED, lineHeight: 1.6, borderTop: '1px solid #F3F4F6', paddingTop: 12 }}>
            <strong style={{ color: INK }}>Legal weight: none.</strong> The signing key lives in process memory. It is not
            hardware-backed and not a registered signing certificate. The integrity chain is real; the signature proves
            only that this server produced the document.
          </div>

          <div style={{ overflowX: 'auto', marginTop: 16 }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', minWidth: 620 }}>
              <thead>
                <tr style={{ color: '#9CA3AF', borderBottom: '1px solid #F3F4F6', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
                  <th style={{ padding: '10px 8px' }}>#</th>
                  <th style={{ padding: '10px 8px' }}>When</th>
                  <th style={{ padding: '10px 8px' }}>Type</th>
                  <th style={{ padding: '10px 8px' }}>Parties</th>
                  <th style={{ padding: '10px 8px' }}>Amount</th>
                  <th style={{ padding: '10px 8px' }}>Hash</th>
                </tr>
              </thead>
              <tbody>
                {data.records.slice(-25).reverse().map(r => (
                  <tr key={r.seq} style={{ borderBottom: '1px solid #F9FAFB' }}>
                    <td style={{ padding: '9px 8px', color: MUTED }}>{r.seq}</td>
                    <td style={{ padding: '9px 8px', color: MUTED, whiteSpace: 'nowrap' }}>{r.occurredAt ? new Date(r.occurredAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                    <td style={{ padding: '9px 8px', fontWeight: 600 }}>{r.type.replace(/_/g, ' ').toLowerCase()}</td>
                    <td style={{ padding: '9px 8px', overflowWrap: 'anywhere' }}>{r.fromParty || '—'}{r.toParty ? ` → ${r.toParty}` : ''}</td>
                    <td style={{ padding: '9px 8px' }}>{r.amountINR ? money(r.amountINR) : (r.tokens ? `${r.tokens} tokens` : '—')}</td>
                    <td style={{ padding: '9px 8px', fontFamily: 'monospace', fontSize: 10, color: '#9CA3AF' }}>{r.recordHash.slice(0, 10)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.recordCount > 25 && <div style={{ fontSize: 11, color: '#9CA3AF', padding: '10px 8px' }}>Showing the 25 most recent of {data.recordCount}. The CSV contains all of them.</div>}
          </div>
        </>
      )}
    </Card>
  )
}

function btn(bg, fg, bd) {
  return {
    padding: '8px 14px', background: bg, color: fg,
    border: `1px solid ${bd || bg}`, borderRadius: 8,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  }
}

// --- Alerts ----------------------------------------------------------------

function AlertsPanel() {
  const [nonce, setNonce] = useState(0)
  const { loading, data, error } = useReport('/api/regulator/alerts', [nonce])
  const [busy, setBusy] = useState('')

  const dispose = async (alertId, disposition) => {
    setBusy(alertId)
    try {
      await api.request('/api/regulator/alerts/disposition', {
        method: 'POST',
        body: JSON.stringify({ alertId, disposition }),
      })
      setNonce(n => n + 1)
    } catch (e) {
      alert(e.data?.message || e.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Card
      title="Suspicious activity screen"
      sub="Six rules run over live state. Every alert carries the evidence that triggered it, so a reviewer can disagree with the machine instead of taking its word."
    >
      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 16, paddingTop: 16, borderTop: '1px solid #F3F4F6' }}>
            <Stat label="Open high" value={data.openBySeverity.HIGH} />
            <Stat label="Open medium" value={data.openBySeverity.MEDIUM} />
            <Stat label="Total raised" value={data.alertCount} />
          </div>

          {data.alerts.length === 0 && <Empty>No alerts. All six rules ran and none matched.</Empty>}

          {data.alerts.map(a => (
            <div key={a.alertId} style={{ marginTop: 14, border: `1px solid ${LINE}`, borderRadius: 10, padding: 14, background: a.disposition === 'CLEARED' ? '#FAFAFA' : 'white' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                  <StatusChip status={a.severity} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>{a.rule}</span>
                  <span style={{ fontSize: 13, color: MUTED, overflowWrap: 'anywhere' }}>{a.ruleName}</span>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: a.disposition === 'OPEN' ? '#B45309' : MUTED }}>{a.disposition.replace(/_/g, ' ')}</span>
              </div>

              <div style={{ marginTop: 10, fontSize: 12, color: MUTED, fontFamily: 'monospace', background: '#F9FAFB', borderRadius: 6, padding: 10, overflowWrap: 'anywhere' }}>
                {Object.entries(a.subject).map(([k, v]) => `${k}=${v}`).join('  ')}
                <br />
                {Object.entries(a.evidence).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ')}
              </div>

              <div style={{ marginTop: 10, fontSize: 13, color: INK }}>
                <strong style={{ fontWeight: 600 }}>Recommended:</strong> {a.recommendedAction}
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {['UNDER_REVIEW', 'CLEARED', 'ESCALATED'].map(d => (
                  <button
                    key={d}
                    disabled={busy === a.alertId || a.disposition === d}
                    onClick={() => dispose(a.alertId, d)}
                    style={{
                      ...btn('white', a.disposition === d ? '#9CA3AF' : INK, LINE),
                      fontSize: 12,
                      cursor: a.disposition === d ? 'default' : 'pointer',
                    }}
                  >
                    {d.replace(/_/g, ' ').toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <details style={{ marginTop: 18 }}>
            <summary style={{ fontSize: 12, color: MUTED, cursor: 'pointer', fontWeight: 600 }}>The six rules</summary>
            <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: 12, color: MUTED, lineHeight: 1.8 }}>
              {data.rules.map(r => <li key={r.id}><strong style={{ color: INK }}>{r.id}</strong> — {r.name} ({r.severity.toLowerCase()})</li>)}
            </ul>
          </details>
        </>
      )}
    </Card>
  )
}

// --- SM REIT gap analysis --------------------------------------------------

function SchemePanel({ properties }) {
  const [assetId, setAssetId] = useState(properties[0]?.assetId || '')
  useEffect(() => { if (!assetId && properties[0]) setAssetId(properties[0].assetId) }, [properties])
  const { loading, data, error } = useReport(`/api/regulator/scheme-report?assetId=${encodeURIComponent(assetId)}`, [assetId], Boolean(assetId))

  return (
    <Card
      title="SM REIT eligibility — gap analysis"
      sub="Measured against SEBI (REIT) Regulations 2014, Chapter VIB, inserted by the 2024 amendment. This report is designed to fail where the platform falls short; a compliance report that always passes is theatre."
      right={<AssetPicker properties={properties} value={assetId} onChange={setAssetId} />}
    >
      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 16, paddingTop: 16, borderTop: '1px solid #F3F4F6' }}>
            <Stat label="Pass" value={data.summary.pass} />
            <Stat label="Fail" value={data.summary.fail} />
            <Stat label="Not modelled" value={data.summary.notModelled} />
          </div>

          <div style={{ marginTop: 14, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: 12, fontSize: 13, color: '#92400E', lineHeight: 1.6 }}>
            {data.summary.plainReading}
          </div>

          <div style={{ marginTop: 16 }}>
            {data.checks.map(c => (
              <div key={c.id} style={{ borderTop: '1px solid #F3F4F6', padding: '12px 0' }}>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{c.requirement}</div>
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 3 }}>{c.source}</div>
                  </div>
                  <StatusChip status={c.status} />
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>Observed: {c.observed}</div>
                {c.note && <div style={{ fontSize: 12, color: '#B45309', marginTop: 5 }}>{c.note}</div>}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, fontSize: 12, color: MUTED, lineHeight: 1.6, borderTop: '1px solid #F3F4F6', paddingTop: 12 }}>
            {data.framework}
          </div>
        </>
      )}
    </Card>
  )
}

// --- Supervisory action log ------------------------------------------------

function ActionLogPanel() {
  const { loading, data, error } = useReport('/api/regulator/actions', [])
  return (
    <Card
      title="Supervisory action log"
      sub="Every freeze and unfreeze, with the written reason and the named actor, hash-linked in sequence. A freeze with no recorded reason is a status change, not a supervisory act."
    >
      {loading && <Loading />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {data && data.actions.length === 0 && <Empty>No supervisory actions recorded yet. Freeze a property on the Overview tab and it will appear here.</Empty>}
      {data && data.actions.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 16 }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', minWidth: 560 }}>
            <thead>
              <tr style={{ color: '#9CA3AF', borderBottom: '1px solid #F3F4F6', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
                <th style={{ padding: '10px 8px' }}>#</th>
                <th style={{ padding: '10px 8px' }}>Action</th>
                <th style={{ padding: '10px 8px' }}>Asset</th>
                <th style={{ padding: '10px 8px' }}>Reason</th>
                <th style={{ padding: '10px 8px' }}>By</th>
                <th style={{ padding: '10px 8px' }}>When</th>
              </tr>
            </thead>
            <tbody>
              {data.actions.slice().reverse().map(a => (
                <tr key={a.actionId} style={{ borderBottom: '1px solid #F9FAFB' }}>
                  <td style={{ padding: '10px 8px', color: MUTED }}>{a.seq}</td>
                  <td style={{ padding: '10px 8px', fontWeight: 700, color: a.action === 'FREEZE' ? '#B91C1C' : '#047857' }}>{a.action}</td>
                  <td style={{ padding: '10px 8px', overflowWrap: 'anywhere', fontSize: 12 }}>{a.assetId}</td>
                  <td style={{ padding: '10px 8px', overflowWrap: 'anywhere' }}>{a.reason}</td>
                  <td style={{ padding: '10px 8px', fontSize: 12 }}>{a.actor}</td>
                  <td style={{ padding: '10px 8px', color: MUTED, fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(a.at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
