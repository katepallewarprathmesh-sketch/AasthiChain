import React, { useMemo, useState } from 'react'
import {  } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties.js'
import {
  Button, Badge, Card, Field, Input, Select, Segmented, PropertyCard, SkeletonCard,
  EmptyState, ErrorState, Num, inr, inrShort, Progress, Breadcrumbs,
} from '../components/ui.jsx'

/**
 * Property discovery.
 *
 * The filtering and sorting logic is unchanged: it runs client-side over the
 * list the hook already fetched, so changing a control is instant and costs
 * no extra request. What changed is everything around it, plus three states
 * this page used to collapse into one: loading, genuinely empty, and "we
 * could not ask". A visitor who sees an empty grid should know which of
 * those three happened.
 *
 * The secondary market is deliberately only a signpost here. This page lists
 * primary offerings; resale prices and depth come from the market API on
 * /market, and inventing either would be inventing liquidity.
 */
export default function Marketplace() {
  const [filter, setFilter] = useState('')
  const [cityFilter, setCityFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [minYield, setMinYield] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [sort, setSort] = useState('')
  const [search, setSearch] = useState('')
  const [layout, setLayout] = useState('grid')

  const { properties, loading, error, refresh } = useProperties(filter)

  const priceOf = (p) => Number(p.pricePerTokenINR) ||
    (p.totalTokens ? p.valuationINR / p.totalTokens : 0)

  const filtered = useMemo(() => (properties || []).filter((p) => {
    if (cityFilter && p.location?.city !== cityFilter) return false
    if (typeFilter && p.propertyType !== typeFilter) return false
    if (minYield && Number(p.expectedYieldPct || 0) < Number(minYield)) return false
    if (maxPrice && priceOf(p) > Number(maxPrice)) return false
    if (search) {
      const hay = `${p.title || ''} ${p.location?.city || ''} ${p.location?.locality || ''} ${p.propertyType || ''}`.toLowerCase()
      if (!hay.includes(search.toLowerCase())) return false
    }
    return true
  }), [properties, cityFilter, typeFilter, minYield, maxPrice, search])

  const sorters = {
    yield: (a, b) => Number(b.expectedYieldPct || 0) - Number(a.expectedYieldPct || 0),
    priceAsc: (a, b) => priceOf(a) - priceOf(b),
    priceDesc: (a, b) => priceOf(b) - priceOf(a),
    funded: (a, b) => Number(b.fundedPct || 0) - Number(a.fundedPct || 0),
    valuation: (a, b) => Number(b.valuationINR || 0) - Number(a.valuationINR || 0),
  }
  const shown = sort && sorters[sort] ? [...filtered].sort(sorters[sort]) : filtered

  const cities = [...new Set((properties || []).map((p) => p.location?.city).filter(Boolean))].sort()
  const types = [...new Set((properties || []).map((p) => p.propertyType).filter(Boolean))].sort()
  const clearAll = () => {
    setFilter(''); setCityFilter(''); setTypeFilter(''); setMinYield('')
    setMaxPrice(''); setSort(''); setSearch('')
  }
  const activeFilters = [cityFilter, typeFilter, minYield, maxPrice, search, filter].filter(Boolean).length

  return (
    <main className="ax ax-wrap" style={{ paddingTop: 28, paddingBottom: 72 }}>
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Properties' }]} />

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 22, flexWrap: 'wrap', marginBottom: 26 }}>
        <div>
          <p className="ax-eyebrow">Primary market</p>
          <h1 className="ax-display ax-h2">Properties</h1>
          <p className="ax-lede" style={{ fontSize: 16 }}>
            Fractional ownership from ₹500. Every figure on a card comes from the property record;
            where something has not been published, the card says so.
          </p>
        </div>
        <Card pad="sm" style={{ minWidth: 'min(100%, 260px)' }}>
          <h2 className="ax-card-title" style={{ fontSize: 14 }}>Looking to buy from another holder?</h2>
          <p className="ax-body" style={{ fontSize: 13, marginTop: 6 }}>
            Resale offers live on the secondary market, priced by the people posting them.
          </p>
          <Button to="/market" variant="secondary" size="sm" style={{ marginTop: 12 }}>Open secondary market</Button>
        </Card>
      </header>

      {/* ------------------------------------------------------- controls */}
      <Card pad="sm" style={{ marginBottom: 22 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 12, alignItems: 'end' }}>
          <Field label="Search" htmlFor="mk-search">
            <Input
              id="mk-search" type="search" placeholder="Name, locality or city"
              value={search} onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Availability" htmlFor="mk-status">
            <Select id="mk-status" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All properties</option>
              <option value="TOKENIZED">Available now</option>
              <option value="DRAFT">Coming soon</option>
            </Select>
          </Field>
          <Field label="City" htmlFor="mk-city">
            <Select id="mk-city" value={cityFilter} onChange={(e) => setCityFilter(e.target.value)}>
              <option value="">All cities</option>
              {cities.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Type" htmlFor="mk-type">
            <Select id="mk-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Max token price" htmlFor="mk-price">
            <Select id="mk-price" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)}>
              <option value="">Any price</option>
              <option value="500">Up to ₹500</option>
              <option value="1000">Up to ₹1,000</option>
              <option value="5000">Up to ₹5,000</option>
            </Select>
          </Field>
          <Field label="Indicated yield" htmlFor="mk-yield" tip="Yield shown by the originator on the listing. It is an expectation, not a promise, and nothing here verifies it.">
            <Select id="mk-yield" value={minYield} onChange={(e) => setMinYield(e.target.value)}>
              <option value="">Any</option>
              <option value="6">6% and above</option>
              <option value="8">8% and above</option>
              <option value="10">10% and above</option>
            </Select>
          </Field>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--ax-line)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="ax-hint" role="status">
              {loading ? 'Loading properties' : <><Num>{shown.length}</Num> of <Num>{(properties || []).length}</Num> shown</>}
            </span>
            {activeFilters > 0 && (
              <Button variant="ghost" size="sm" onClick={clearAll}>Clear {activeFilters} filter{activeFilters > 1 ? 's' : ''}</Button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Field label="" htmlFor="mk-sort">
              <Select id="mk-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort properties">
                <option value="">Sort: default</option>
                <option value="priceAsc">Token price, low to high</option>
                <option value="priceDesc">Token price, high to low</option>
                <option value="valuation">Valuation, high to low</option>
                <option value="funded">Most funded</option>
                <option value="yield">Indicated yield</option>
              </Select>
            </Field>
            <Segmented
              label="Layout"
              value={layout}
              onChange={setLayout}
              options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}
            />
          </div>
        </div>
      </Card>

      {/* --------------------------------------------------------- results */}
      {error ? (
        <ErrorState
          title="Properties did not load"
          detail="The listing service did not answer, so nothing is shown. A stale cache would look identical to a live list, which is worse than an empty page."
          onRetry={refresh}
        />
      ) : loading ? (
        <div className="ax-grid ax-grid--auto">{[0, 1, 2, 3, 4, 5].map((i) => <SkeletonCard key={i} />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState
          title={activeFilters ? 'Nothing matches those filters' : 'No properties are listed yet'}
          body={activeFilters
            ? 'Try widening the price range or clearing the city filter.'
            : 'When an originator lists a property and a registrar attests to its title, it appears here.'}
          action={activeFilters ? <Button variant="secondary" size="sm" onClick={clearAll}>Clear filters</Button> : null}
        />
      ) : layout === 'grid' ? (
        <div className="ax-grid ax-grid--auto">
          {shown.map((p) => <PropertyCard key={p.assetId} p={p} />)}
        </div>
      ) : (
        <Card pad="sm">
          <div style={{ overflowX: 'auto' }}>
            <table className="ax-table">
              <caption className="ax-sr">Properties, as a table</caption>
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Location</th>
                  <th scope="col" className="ax-num">Valuation</th>
                  <th scope="col" className="ax-num">Per token</th>
                  <th scope="col">Funded</th>
                  <th scope="col">Title</th>
                  <th scope="col"><span className="ax-sr">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const price = priceOf(p)
                  const verified = p.verified === true || p.verificationStatus === 'VERIFIED' || p.registryVerified === true
                  const funded = Number(p.fundedPct)
                  return (
                    <tr key={p.assetId}>
                      <td style={{ fontWeight: 600 }}>{p.title || p.assetId}</td>
                      <td className="ax-hint">{[p.location?.locality, p.location?.city].filter(Boolean).join(', ') || 'Not stated'}</td>
                      <td className="ax-num">{p.valuationINR ? inrShort(p.valuationINR) : '–'}</td>
                      <td className="ax-num">{price ? inr(Math.round(price)) : '–'}</td>
                      <td style={{ minWidth: 'min(100%, 130px)' }}>
                        {Number.isFinite(funded) && funded > 0
                          ? <><Progress value={funded} label={`${Math.round(funded)} percent funded`} /><span className="ax-hint"><Num>{Math.round(funded)}%</Num></span></>
                          : <span className="ax-hint">Not published</span>}
                      </td>
                      <td>{verified ? <Badge tone="success">Registrar verified</Badge> : <Badge tone="warning">Pending</Badge>}</td>
                      <td><Button to={`/property/${encodeURIComponent(p.assetId)}`} size="sm" variant="secondary">View</Button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="ax-hint" style={{ marginTop: 26, maxWidth: '82ch' }}>
        A listing is a record on this platform, not a registered conveyance. Verification means a
        registrar participant attested to the title and the deed fingerprint matches; it does not mean
        this platform inspected the property. Values can fall, income can stop, and a fractional
        holding may be hard to sell when you want to sell it.
      </p>
    </main>
  )
}
