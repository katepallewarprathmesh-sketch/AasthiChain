import React, { useCallback, useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch } from '../lib/umiFetch.js'

/**
 * Outside facts: the rates a settlement depends on, and the attestations a
 * token depends on.
 *
 * WHY THESE TWO LIVE ON ONE PAGE
 * They answer the same question from opposite ends. A signed feed says "this
 * number came from a named key at a named time, and it stops being usable at
 * a declared age". A backing attestation says "a named attestor stood behind
 * this much of a real asset, as of a date, and issuance stops when that
 * statement goes stale or is withdrawn". Both are about refusing to let an
 * unverifiable outside fact silently become a settled position.
 *
 * Both had rail code, blocks and tests, and no screen. A refusal that nobody
 * can see is indistinguishable from a system that never checks.
 */

const num = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 4 })
const rupees = (paise) => '₹' + Number((paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const dt = (iso) => { try { return new Date(iso).toLocaleString('en-IN') } catch { return String(iso || '') } }

const age = (sec) => {
  const s = Number(sec || 0)
  if (s < 90) return s + ' s old'
  if (s < 5400) return Math.round(s / 60) + ' min old'
  return Math.round(s / 3600) + ' h old'
}

// The five states a feed value can be in. Each is a refusal except the first,
// and each refuses for a different reason, which is why they are not
// collapsed into "unavailable".
const FEED_STATE = {
  USABLE: { tone: 'live', says: 'Fresh, attributed and inside the deviation band.' },
  STALE: { tone: 'bad', says: 'Older than the age this feed declared usable, so it refuses rather than serving a number that looks current.' },
  NO_QUORUM: { tone: 'bad', says: 'Fewer publishers than the feed requires. One voice where two were demanded is not a price.' },
  NO_DATA: { tone: 'neutral', says: 'Registered, but nothing has been published to it yet.' },
  RETIRED: { tone: 'neutral', says: 'Withdrawn deliberately. Past readings stand; nothing new is accepted.' },
  UNATTRIBUTABLE: { tone: 'bad', says: 'A reading whose signing key is no longer trusted, so it cannot be attributed to anyone.' },
}

const BACK_STATE = {
  ATTESTED: 'live', STALE: 'bad', WITHDRAWN: 'bad', NONE: 'neutral',
}

function Feeds({ feeds }) {
  if (!feeds.length) return <p className="pg-card-sub">No feed is registered on this rail.</p>
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {feeds.map(({ feed, value, observations }) => {
        const st = FEED_STATE[(value && value.state) || 'NO_DATA'] || FEED_STATE.NO_DATA
        return (
          <div key={feed.feedId} className="pg-card" style={{ margin: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <b style={{ fontSize: 13.5 }}>{feed.feedId}</b>
                <div className="pg-card-sub">{feed.description}</div>
              </div>
              <Tag tone={st.tone}>{String((value && value.state) || 'NO DATA').replace(/_/g, ' ').toLowerCase()}</Tag>
            </div>

            <div className="pg-kv" style={{ marginTop: 10 }}>
              <div>Value</div>
              <div>
                {value && value.usable
                  ? <><b>{num(value.value)}</b> {feed.unit}</>
                  : <span style={{ color: '#B91C1C' }}>refused: no usable value</span>}
                {value && value.observedAt && (
                  <div className="pg-card-sub">{age(value.ageSec)}, observed {dt(value.observedAt)}</div>
                )}
              </div>
              <div>Why that state</div>
              <div>{st.says}</div>
              <div>Publishers</div>
              <div>
                {(feed.publishers || []).join(', ') || 'none'}
                <div className="pg-card-sub">
                  {feed.minPublishers} required, {value ? value.observers : 0} seen,
                  {' '}{observations} observation{observations === 1 ? '' : 's'} recorded
                </div>
              </div>
              <div>Stops being usable at</div>
              <div>{feed.maxStalenessSec} s, deviation band {feed.maxDeviationPct}%</div>
              {value && value.sources && value.sources.length > 0 && (
                <>
                  <div>Signed by</div>
                  <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, overflowWrap: 'anywhere' }}>
                    {value.sources.join(', ')}
                  </div>
                </>
              )}
              {value && value.block ? (<><div>Block</div><div>{value.block}</div></>) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Backing({ data }) {
  const assets = (data && data.assets) || []
  if (!assets.length) return <p className="pg-card-sub">Nothing has been attested on this rail yet.</p>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#6B7280' }}>
            {['Asset', 'State', 'Outstanding', 'Backed', 'Coverage', 'Attestor', 'As of', 'May issue'].map(h => (
              <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {assets.map(a => (
            <tr key={a.assetId}>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6', overflowWrap: 'anywhere' }}>
                {a.assetId}
                {a.reading && <div className="pg-card-sub" style={{ maxWidth: 420 }}>{a.reading}</div>}
              </td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>
                <Tag tone={BACK_STATE[a.status] || 'neutral'}>{String(a.status || '').toLowerCase()}</Tag>
              </td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>{num(a.tokensOutstanding)}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>
                {num(a.backedUnits)}
                {a.valuationPaise ? <div className="pg-card-sub">{rupees(a.valuationPaise)}</div> : null}
              </td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>{num(a.coveragePercent)}%</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>
                {a.attestor}
                {a.method && <div className="pg-card-sub">{a.method}</div>}
              </td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6', whiteSpace: 'nowrap' }}>{dt(a.asOf)}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #F3F4F6' }}>
                <Tag tone={a.mayIssue ? 'live' : 'bad'}>{a.mayIssue ? 'yes' : 'no'}</Tag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function FeedsPage() {
  const [feeds, setFeeds] = useState([])
  const [posture, setPosture] = useState(null)
  const [backing, setBacking] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const [f, p, b] = await Promise.all([
      umiFetch('/oracle/feeds', { method: 'GET' }),
      umiFetch('/oracle/posture', { method: 'GET' }),
      umiFetch('/backing', { method: 'GET' }),
    ])
    if (!f.ok && !b.ok) { setErr('The rail did not answer for feeds or backing.'); return }
    setErr('')
    setFeeds((f.ok && f.data && f.data.feeds) || [])
    setPosture((p.ok && p.data) || null)
    setBacking((b.ok && b.data) || null)
  }, [])

  useEffect(() => { load().catch(() => setErr('The rail is unreachable.')) }, [load])

  return (
    <PageShell
      eyebrow="Outside facts"
      title="Signed feeds and backing attestations"
      lede="A settlement is only as good as the outside facts it rests on: the rate used to convert a payment, and somebody's statement that a real asset exists behind a token. Neither is made true by putting it on a ledger. What a ledger can do is make each one attributable to a named key, timely, and refusable once it goes stale."
      badge={<Tag tone="sim">Simulated attestors and publishers. The signatures, ages and refusals are real.</Tag>}
    >
      {err && <Card title="Unavailable"><p className="pg-card-sub">{err}</p></Card>}

      <Card
        title={`Signed feeds (${feeds.length})`}
        sub="Every reading is signed by a registered key. Every feed declares the age at which its values stop being usable, and refuses rather than serving a stale number."
        right={posture && <Tag tone={posture.configured ? 'live' : 'neutral'}>{posture.configured ? 'configured' : 'not configured'}</Tag>}
      >
        <Feeds feeds={feeds} />
      </Card>

      <Card
        title="Backing"
        sub="Issuance is refused past the attested figure, and once an attestation goes stale or is withdrawn."
        right={backing && backing.attested != null && <Tag tone="neutral">{backing.attested} attested</Tag>}
      >
        <Backing data={backing} />
        {backing && backing.onFailure && (
          <p className="pg-card-sub" style={{ marginTop: 10 }}>{backing.onFailure}</p>
        )}
        {backing && backing.model && (
          <p className="pg-card-sub" style={{ marginTop: 6 }}>{backing.model}</p>
        )}
      </Card>

      {posture && (
        <Card title="What this is not" sub="Stated here rather than left for a reader to assume.">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: '#4B5563', lineHeight: 1.8 }}>
            {(posture.limits || []).map((l, i) => <li key={i}>{l}</li>)}
          </ul>
          {(posture.rules || []).length > 0 && (
            <>
              <b style={{ fontSize: 12.5, display: 'block', marginTop: 12 }}>The rules it does enforce</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#4B5563', lineHeight: 1.8 }}>
                {posture.rules.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </>
          )}
        </Card>
      )}
    </PageShell>
  )
}
