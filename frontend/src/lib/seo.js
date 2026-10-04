// Per-route SEO metadata for a single-page app.
//
// A SPA serves one index.html for every URL, so without this every page shares
// the same <title> and description. Search engines then see twelve pages that
// look identical and rank none of them. This module rewrites the head on each
// navigation: title, description, canonical, Open Graph, Twitter card, and the
// robots directive.
//
// Deliberately dependency-free (no react-helmet) and SSR-safe: when there is no
// document (the smoke renderer, any future prerender) every function no-ops.

export const SITE_NAME = 'AasthiChain'
export const SITE_URL = 'https://aasthi-chain.vercel.app'
export const DEFAULT_IMAGE = `${SITE_URL}/og-default.png`

// Title pattern follows the playbook: main keyword first, brand last.
// Keep titles under ~60 characters so Google does not truncate them.
export const ROUTE_SEO = {
  '/': {
    title: 'Fractional Real Estate Investing from ₹500 | AasthiChain',
    description:
      'Invest in fractional real estate from ₹500. Tokenised property ownership settled on a hash-chained ledger with atomic delivery-versus-payment. Interactive demo, no signup cost.',
  },
  '/marketplace': {
    title: 'Fractional Property Investments in India | AasthiChain',
    description:
      'Browse fractional property investments across Indian cities. Compare rental yield, token price and minimum investment on residential and commercial real estate. Free to browse.',
  },
  '/ledger': {
    title: 'Ownership Ledger Explorer — Verify Every Block | AasthiChain',
    description:
      'Inspect the append-only ownership ledger block by block. SHA-512 linkage, merkle roots and live chain verification for every tokenised property transfer.',
  },
  '/umi': {
    title: 'UMI Settlement Rail — Atomic DvP in e₹-W | AasthiChain',
    description:
      "Watch an atomic delivery-versus-payment settle on a simulation of RBI's Unified Market Interface: securities leg and wholesale CBDC cash leg commit in one block, or neither moves.",
  },
  '/tools': {
    title: 'Free Property Investment Calculators | AasthiChain',
    description:
      'Free calculators for property investors: rental yield and fractional investment returns. No signup, nothing stored, everything runs in your browser.',
  },
  '/tools/rental-yield-calculator': {
    title: 'Rental Yield Calculator — Gross & Net | AasthiChain',
    description:
      'Calculate gross and net rental yield on any property. Accounts for maintenance, property tax, insurance, vacancy and stamp duty to show what you actually earn.',
  },
  '/tools/fractional-investment-calculator': {
    title: 'Fractional Investment Calculator for Property | AasthiChain',
    description:
      'Work out returns on fractional property ownership: tokens purchased, ownership share, rental income and projected value after appreciation. Free, no signup.',
  },
  '/about': {
    title: 'About AasthiChain — Tokenised Property Settlement Demo',
    description:
      'Why AasthiChain exists: an open-source demonstration of atomic delivery-versus-payment settlement for tokenised real estate, following the SEBI Demat 2.0 and RBI UMI pattern.',
  },
  '/privacy': {
    title: 'Privacy Policy | AasthiChain',
    description:
      'No third-party trackers, no advertising, and your IP address is never stored. What this site collects, what it does not, and how Do Not Track is honoured.',
  },
  '/terms': {
    title: 'Terms of Use | AasthiChain',
    description:
      'Conditions for using AasthiChain. This is a demonstration of settlement technology: no real money, no real property, no investment advice.',
  },
  '/support': {
    title: 'Help & Support | AasthiChain',
    description:
      'Answers on fractional property investment, tokenised ownership, settlement and how the AasthiChain demo works.',
  },
  '/login': { title: `Sign in | ${SITE_NAME}`, description: 'Sign in to AasthiChain.', noindex: true },

  // Private surfaces. These carry noindex because they are per-user or
  // operator-only: they would be thin, duplicated or confidential in search
  // results. Note they are NOT disallowed in robots.txt - a blocked crawler
  // can never read the noindex tag, so the page can still get indexed from
  // external links. Let the crawler in, then tell it not to index.
  '/dashboard': { title: `Investor Dashboard | ${SITE_NAME}`, description: 'Your holdings, income and settlement activity.', noindex: true },
  '/wallet': { title: `Wallet | ${SITE_NAME}`, description: 'Your tokens, balances and CBDC settlement wallet.', noindex: true },
  '/admin': { title: `Admin | ${SITE_NAME}`, description: 'Operator console.', noindex: true },
  '/regulator': { title: `Regulator View | ${SITE_NAME}`, description: 'Supervisory view of the registry.', noindex: true },
  '/insights': { title: `Insights | ${SITE_NAME}`, description: 'Private operator analytics.', noindex: true },
}

const FALLBACK = ROUTE_SEO['/']

// Property pages are dynamic (/property/:id) and get their metadata from the
// loaded property instead of this table.
export function seoForPath(pathname) {
  if (!pathname) return FALLBACK
  if (ROUTE_SEO[pathname]) return ROUTE_SEO[pathname]
  if (pathname.startsWith('/property/')) {
    // Filled in from the live catalogue by PropertyDetail once loaded; this is
    // the pre-load fallback.
    return {
      title: `Property Details | ${SITE_NAME}`,
      description: 'Rental yield, token price, ownership split and settlement history for this fractional property investment.',
    }
  }
  return FALLBACK
}

function setMeta(attr, key, content) {
  if (typeof document === 'undefined') return
  let el = document.head.querySelector(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function setLink(rel, href) {
  if (typeof document === 'undefined') return
  let el = document.head.querySelector(`link[rel="${rel}"]`)
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', rel)
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

// applySeo rewrites the document head for a path. Safe to call on every
// navigation; never throws, so a metadata problem can never break the app.
export function applySeo(pathname, overrides = {}) {
  if (typeof document === 'undefined') return
  try {
    const base = seoForPath(pathname)
    const seo = { ...base, ...overrides }
    const url = SITE_URL + (pathname === '/' ? '' : pathname)

    document.title = seo.title
    setMeta('name', 'description', seo.description)

    // One canonical URL per page, so ranking signals are not split across
    // duplicate paths.
    setLink('canonical', url)

    // noindex keeps private pages out of results; "follow" still lets link
    // equity flow through them.
    setMeta('name', 'robots', seo.noindex ? 'noindex, follow' : 'index, follow')

    setMeta('property', 'og:title', seo.title)
    setMeta('property', 'og:description', seo.description)
    setMeta('property', 'og:url', url)
    setMeta('property', 'og:type', 'website')
    setMeta('property', 'og:site_name', SITE_NAME)
    setMeta('property', 'og:image', seo.image || DEFAULT_IMAGE)
    setMeta('name', 'twitter:card', 'summary_large_image')
    setMeta('name', 'twitter:title', seo.title)
    setMeta('name', 'twitter:description', seo.description)
    setMeta('name', 'twitter:image', seo.image || DEFAULT_IMAGE)
  } catch {
    /* metadata is never worth breaking a render over */
  }
}
