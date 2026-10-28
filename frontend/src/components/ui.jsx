import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { propertyImage, REPRESENTATIVE_NOTE } from '../lib/propertyImages.js'
import { registryStatus } from '../lib/registryStatus.js'

/**
 * The AasthiChain design system, as components.
 *
 * Every page used to invent its own button, its own empty state and its own
 * way of saying "this part is simulated", which is why moving between them
 * felt like moving between products. This file is the single answer to those
 * questions. It adds no dependency: the styles are the `ax-*` tokens in
 * index.css, and the markup is semantic HTML.
 *
 * Two rules it enforces rather than suggests:
 *
 *   - **Status is never colour alone.** Every badge renders a dot *and* a
 *     word, so a red-green colour blindness or a greyscale print still reads
 *     correctly.
 *   - **Money is tabular.** Figures line up in columns, which is the
 *     difference between a financial product and a web page with numbers.
 */

/* ------------------------------------------------------------------ money */

/** Full precision, for inputs and confirmations: ₹75,00,000. */
export const inr = (paiseOrRupees, { fromPaise = false } = {}) => {
  const n = Number(paiseOrRupees || 0) / (fromPaise ? 100 : 1)
  if (!Number.isFinite(n)) return '–'
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

/** Short Indian form, for dense cards: ₹75 L, ₹1.2 Cr. Never used where the
 *  exact figure matters, because a rounded number in a confirmation is a lie. */
export const inrShort = (rupees) => {
  const n = Number(rupees || 0)
  if (!Number.isFinite(n) || n === 0) return '₹0'
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(n >= 1e8 ? 0 : 2).replace(/\.00$/, '') + ' Cr'
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(n >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' L'
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

/** A figure that lines up in a column. */
export const Num = ({ children, className = '', ...rest }) => (
  <span className={`ax-num ${className}`} {...rest}>{children}</span>
)

/** An identifier, hash or block height. Monospace, used sparingly. */
export const Mono = ({ children, title }) => (
  <span className="ax-mono" title={title}>{children}</span>
)

/* ---------------------------------------------------------------- buttons */

export function Button({ as, to, href, variant = 'primary', size, block, children, ...rest }) {
  const cls = [
    'ax-btn', `ax-btn--${variant}`,
    size === 'sm' ? 'ax-btn--sm' : '', block ? 'ax-btn--block' : '', rest.className || '',
  ].filter(Boolean).join(' ')
  const props = { ...rest, className: cls }
  if (to) return <Link to={to} {...props}>{children}</Link>
  if (href) return <a href={href} {...props}>{children}</a>
  const Tag = as || 'button'
  return <Tag type={Tag === 'button' ? (rest.type || 'button') : undefined} {...props}>{children}</Tag>
}

export const IconButton = ({ label, children, ...rest }) => (
  <button type="button" className="ax-iconbtn" aria-label={label} title={label} {...rest}>{children}</button>
)

/* ------------------------------------------------------------------ cards */

export function Card({ title, sub, right, children, raised, pad, style, as: Tag = 'section' }) {
  return (
    <Tag className={`ax-card ${raised ? 'ax-card--raised' : ''} ${pad === 'sm' ? 'ax-card--pad-sm' : ''}`} style={style}>
      {(title || right) && (
        <header style={{ display: 'flex', gap: 14, alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: sub ? 14 : 16 }}>
          <div style={{ minWidth: 0 }}>
            {title && <h3 className="ax-card-title">{title}</h3>}
            {sub && <p className="ax-body" style={{ marginTop: 5, fontSize: 13.5 }}>{sub}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </Tag>
  )
}

export function Metric({ label, value, foot, tip }) {
  return (
    <div className="ax-card ax-card--pad-sm">
      <div className="ax-metric-label">
        {label}
        {tip && <InfoTip text={tip} />}
      </div>
      <div className="ax-metric-value">{value}</div>
      {foot && <div className="ax-metric-foot">{foot}</div>}
    </div>
  )
}

/* ----------------------------------------------------------------- status */

const TONE_WORDS = {
  success: 'Verified', warning: 'Attention', error: 'Failed', info: 'Info',
  pending: 'Pending', sim: 'Simulated', off: 'Unavailable', gold: 'Premium',
}

/**
 * A status badge. `tone` sets the colour, the dot and the default word, but
 * the word is always rendered: colour never carries the meaning by itself.
 */
export const Badge = ({ tone = 'sim', children, title }) => (
  <span className={`ax-badge ax-badge--${tone}`} title={title}>
    <i aria-hidden="true" />
    {children || TONE_WORDS[tone] || tone}
  </span>
)

/** The one label that must never be missed. */
export const SimBadge = ({ children = 'Simulated' }) => (
  <Badge tone="sim" title="This part of the product is a simulation. No real money moves and no live institution is connected.">{children}</Badge>
)

/* ------------------------------------------------------------------ forms */

export function Field({ label, hint, error, htmlFor, children, tip }) {
  return (
    <div className="ax-field">
      {label && (
        <label className="ax-label" htmlFor={htmlFor}>
          {label}{tip && <> <InfoTip text={tip} /></>}
        </label>
      )}
      {children}
      {error ? <p className="ax-err">{error}</p> : hint ? <p className="ax-hint">{hint}</p> : null}
    </div>
  )
}

export const Input = ({ numeric, ...rest }) => (
  <input className={`ax-input ${numeric ? 'ax-input--num' : ''}`} {...rest} />
)

/** An amount in rupees, with the symbol inside the control. */
export const MoneyInput = ({ id, value, onChange, ...rest }) => (
  <div className="ax-inputwrap">
    <span className="ax-prefix" aria-hidden="true">₹</span>
    <input
      id={id} className="ax-input ax-input--num" inputMode="numeric" value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} {...rest}
    />
  </div>
)

export const Select = ({ children, ...rest }) => (
  <select className="ax-select" {...rest}>{children}</select>
)

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="ax-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value} role="tab" aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
        >{o.label}</button>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------- feedback */

export const Progress = ({ value, label }) => {
  const pct = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <div
      className="ax-progress" role="progressbar" aria-valuenow={Math.round(pct)}
      aria-valuemin={0} aria-valuemax={100} aria-label={label}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

export const Skeleton = ({ h = 14, w = '100%', style }) => (
  <div className="ax-skel" style={{ height: h, width: w, ...style }} aria-hidden="true" />
)

export function SkeletonCard() {
  return (
    <div className="ax-pcard" aria-hidden="true">
      <div className="ax-skel" style={{ aspectRatio: '16 / 10', borderRadius: 0 }} />
      <div className="ax-pcard-body">
        <Skeleton h={18} w="72%" />
        <Skeleton h={13} w="45%" />
        <Skeleton h={13} w="88%" />
      </div>
    </div>
  )
}

export function EmptyState({ title, body, action }) {
  return (
    <div className="ax-empty">
      <h3 className="ax-card-title" style={{ marginBottom: 6 }}>{title}</h3>
      {body && <p className="ax-body" style={{ margin: '0 auto', maxWidth: '52ch' }}>{body}</p>}
      {action && <div style={{ marginTop: 18 }}>{action}</div>}
    </div>
  )
}

/** A failure says what failed and offers the retry. It never pretends the
 *  data is simply empty, because "nothing here" and "we could not ask" are
 *  different facts. */
export function ErrorState({ title = 'That did not load', detail, onRetry }) {
  return (
    <div className="ax-empty" role="alert" style={{ borderColor: 'rgba(161,61,46,.3)', background: 'var(--ax-error-wash)' }}>
      <Badge tone="error">Could not load</Badge>
      <h3 className="ax-card-title" style={{ margin: '12px 0 6px' }}>{title}</h3>
      {detail && <p className="ax-body" style={{ margin: '0 auto', maxWidth: '52ch' }}>{detail}</p>}
      {onRetry && <div style={{ marginTop: 18 }}><Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button></div>}
    </div>
  )
}

export function InfoTip({ text }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="ax-tip" onMouseLeave={() => setOpen(false)}>
      <button
        type="button" aria-label={text} aria-expanded={open}
        onMouseEnter={() => setOpen(true)} onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)} onClick={(e) => { e.preventDefault(); setOpen((v) => !v) }}
      >?</button>
      {open && <span className="ax-tip-body" role="tooltip">{text}</span>}
    </span>
  )
}

/** Copy, with feedback that a screen reader announces rather than a colour
 *  change nobody hears. */
export function CopyButton({ value, label = 'Copy' }) {
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <>
      <button
        type="button" className="ax-iconbtn" aria-label={`${label}: ${value}`}
        onClick={async () => {
          try { await navigator.clipboard.writeText(String(value)) } catch { /* clipboard may be blocked; stay silent rather than claim a copy */ return }
          setDone(true); clearTimeout(timer.current); timer.current = setTimeout(() => setDone(false), 1800)
        }}
      >
        {done ? '✓' : '⧉'}
      </button>
      <span role="status" aria-live="polite" className="ax-sr">{done ? 'Copied' : ''}</span>
    </>
  )
}

export const Breadcrumbs = ({ items }) => (
  <nav aria-label="Breadcrumb" style={{ marginBottom: 14 }}>
    <ol style={{ display: 'flex', flexWrap: 'wrap', gap: 8, listStyle: 'none', margin: 0, padding: 0, fontSize: 13, color: 'var(--ax-muted)' }}>
      {items.map((it, i) => (
        <li key={it.label} style={{ display: 'flex', gap: 8 }}>
          {it.to ? <Link to={it.to} style={{ color: 'var(--ax-muted)' }}>{it.label}</Link> : <span aria-current="page" style={{ color: 'var(--ax-ink)' }}>{it.label}</span>}
          {i < items.length - 1 && <span aria-hidden="true">/</span>}
        </li>
      ))}
    </ol>
  </nav>
)

export const Timeline = ({ items }) => (
  <ol className="ax-timeline">
    {items.map((it, i) => (
      <li key={i} data-state={it.state || 'done'}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{it.title}</div>
        {it.meta && <div className="ax-hint" style={{ marginTop: 2 }}>{it.meta}</div>}
        {it.body && <div className="ax-body" style={{ marginTop: 4, fontSize: 13.5 }}>{it.body}</div>}
      </li>
    ))}
  </ol>
)

/** A confirmation for something consequential. It is a real dialog: focus
 *  moves into it, Escape closes it, and the confirm is a button somebody has
 *  to press. Decorative interactions never reach the action behind it. */
export function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', danger, onConfirm, onCancel }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    ref.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])
  if (!open) return null
  return (
    <div
      // A dialog taller than a landscape phone used to be clipped with no
      // way to reach its buttons: placeItems:center with no overflow centres
      // the overflow off both ends of the screen. Scroll the backdrop, pin
      // the card to the top once it stops fitting, and keep clear of the
      // home indicator.
      style={{
        position: 'fixed', inset: 0, background: 'rgba(23,33,43,.45)', zIndex: 150,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflowY: 'auto', overscrollBehavior: 'contain',
        padding: '18px 18px calc(18px + env(safe-area-inset-bottom))',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel?.() }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="ax-card ax-card--raised" style={{ maxWidth: 440, width: '100%', margin: 'auto' }}>
        <h3 className="ax-card-title">{title}</h3>
        {body && <p className="ax-body" style={{ marginTop: 10 }}>{body}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button
            ref={ref} size="sm" onClick={onConfirm}
            style={danger ? { background: 'var(--ax-error)' } : undefined}
          >{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}

export function Toasts({ items, onDismiss }) {
  if (!items?.length) return null
  return (
    <div className="ax-toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="ax-toast" onClick={() => onDismiss?.(t.id)}>{t.message}</div>
      ))}
    </div>
  )
}

export function useToasts() {
  const [items, setItems] = useState([])
  const push = (message) => {
    const id = Math.random().toString(36).slice(2)
    setItems((xs) => [...xs, { id, message }])
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200)
  }
  return { items, push, dismiss: (id) => setItems((xs) => xs.filter((x) => x.id !== id)) }
}

/* ------------------------------------------------------------- photography */

/**
 * Architecture, drawn rather than photographed.
 *
 * The brief asks for photography. A stock photograph of a building that is
 * not one of these properties, presented beside real listings, is a small
 * lie of exactly the kind this project spends its time avoiding, and the
 * in-app preview cannot load external images at all. So where a listing has
 * no image of its own, this draws a calm architectural placeholder, seeded
 * from the listing id so each one is recognisably itself.
 */
export function ArchPlaceholder({ seed = '', label }) {
  let h = 0
  for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) % 997
  const cols = 4 + (h % 3)
  const rows = 5 + (h % 4)
  const tint = ['#DCE6DF', '#E4E0D4', '#DEE3E7'][h % 3]
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label={label || 'Architectural illustration placeholder'} style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="320" height="200" fill={tint} />
      <g fill="#173B2B" opacity="0.1">
        <rect x="18" y="86" width="86" height="114" />
        <rect x="214" y="104" width="88" height="96" />
      </g>
      <g fill="#173B2B" opacity="0.22">
        <rect x="112" y="46" width="96" height="154" />
      </g>
      <g fill="#F6F3EB" opacity="0.75">
        {Array.from({ length: rows }).map((_, r) =>
          Array.from({ length: cols }).map((_, c) => (
            <rect key={`${r}-${c}`} x={122 + c * (76 / cols)} y={58 + r * (130 / rows)} width={76 / cols - 7} height={130 / rows - 9} />
          ))
        )}
      </g>
      <rect x="0" y="186" width="320" height="14" fill="#173B2B" opacity="0.14" />
    </svg>
  )
}

/** One property, rendered the same way everywhere it appears. */
export function PropertyCard({ p, href }) {
  const price = Number(p.pricePerTokenINR) || (p.totalTokens ? Number(p.valuationINR) / Number(p.totalTokens) : 0)
  const available = Number(p.availableTokens ?? p.tokensAvailable ?? NaN)
  const funded = Number(p.fundedPct)
  const reg = registryStatus(p)
  const img = propertyImage(p)
  const to = href || `/property/${encodeURIComponent(p.assetId)}`
  return (
    <article className="ax-pcard">
      <div className="ax-pcard-media">
        {img.src
          ? <img src={img.src} alt={img.isRepresentative ? '' : `${p.title || p.assetId}`} loading="lazy" />
          : <ArchPlaceholder seed={p.assetId} label={`Illustration for ${p.title || p.assetId}`} />}
        <Badge tone={reg.tone} title={reg.at ? `Validated ${new Date(reg.at).toLocaleDateString('en-IN')}` : undefined}>{reg.label}</Badge>
        {/* The picture is generic unless the owner supplied one. Saying so on
            the image itself is the only place a reader will reliably see it. */}
        {img.isRepresentative && (
          <span
            title={REPRESENTATIVE_NOTE}
            style={{
              position: 'absolute', right: 10, bottom: 10, fontSize: 10.5, fontWeight: 600,
              padding: '3px 8px', borderRadius: 999, background: 'rgba(23,33,43,.72)', color: '#fff',
            }}
          >Representative image</span>
        )}
      </div>
      <div className="ax-pcard-body">
        <div>
          <h3 className="ax-card-title" style={{ fontSize: 16 }}>{p.title || p.assetId}</h3>
          <p className="ax-body" style={{ fontSize: 13, marginTop: 3 }}>
            {[p.location?.locality, p.location?.city, p.location?.state].filter(Boolean).join(', ') || 'Location not stated'}
          </p>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 12px', margin: 0 }}>
          <div>
            <dt className="ax-hint" style={{ margin: 0 }}>Valuation</dt>
            <dd style={{ margin: '2px 0 0', fontWeight: 600 }}><Num>{inrShort(p.valuationINR)}</Num></dd>
          </div>
          <div>
            <dt className="ax-hint" style={{ margin: 0 }}>Per token</dt>
            <dd style={{ margin: '2px 0 0', fontWeight: 600 }}><Num>{price ? inr(Math.round(price)) : '–'}</Num></dd>
          </div>
        </dl>
        {Number.isFinite(funded) && funded > 0 && (
          <div>
            <Progress value={funded} label={`${Math.round(funded)} percent funded`} />
            <p className="ax-hint" style={{ marginTop: 6 }}>
              <Num>{Math.round(funded)}%</Num> funded
              {Number.isFinite(available) ? <> · <Num>{available.toLocaleString('en-IN')}</Num> tokens available</> : null}
            </p>
          </div>
        )}
      </div>
      <div className="ax-pcard-foot">
        <span className="ax-hint">
          {price ? <>From <Num style={{ color: 'var(--ax-ink)', fontWeight: 600 }}>{inr(Math.round(price))}</Num></> : 'Price not published'}
        </span>
        <Button to={to} size="sm" variant="secondary">View property</Button>
      </div>
    </article>
  )
}
