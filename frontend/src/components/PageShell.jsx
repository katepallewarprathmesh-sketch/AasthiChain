import React from 'react'

/**
 * One page header for every page.
 *
 * Every screen used to roll its own container width, heading size and
 * spacing, so moving between them felt like moving between three products.
 * This is the single place that decides what the top of a page looks like:
 * an eyebrow, a Fraunces title, a short lede, optional actions on the right,
 * then the page's own content underneath.
 *
 * It deliberately does nothing clever. Pages keep their existing bodies; only
 * the frame around them is shared, which is what makes it safe to adopt one
 * page at a time.
 */
export default function PageShell({
  eyebrow,
  title,
  lede,
  actions = null,
  badge = null,
  width = 'wide',
  children,
}) {
  return (
    <div className={`pg ${width === 'narrow' ? 'pg-narrow' : ''}`}>
      <header className="pg-head">
        <div style={{ minWidth: 0 }}>
          {eyebrow && <div className="pg-eyebrow">{eyebrow}</div>}
          <h1 className="pg-title">{title}</h1>
          {lede && <p className="pg-lede">{lede}</p>}
          {badge && <div style={{ marginTop: 12 }}>{badge}</div>}
        </div>
        {actions && <div className="pg-actions">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

/** A card in the shared style. Pages may still use their own markup. */
export function Card({ title, sub, right, children, style }) {
  return (
    <section className="pg-card" style={style}>
      {(title || right) && (
        <div className="pg-card-head">
          <div style={{ minWidth: 0 }}>
            {title && <h2 className="pg-card-title">{title}</h2>}
            {sub && <p className="pg-card-sub">{sub}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

/** A short, honest label. Simulated things must look different to real ones. */
export function Tag({ tone = 'neutral', children }) {
  return <span className={`pg-tag pg-tag-${tone}`}>{children}</span>
}
