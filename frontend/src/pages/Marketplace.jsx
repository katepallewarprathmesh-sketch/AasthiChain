import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties.js'
import SimplePropertyCard from '../components/SimplePropertyCard.jsx'

export default function Marketplace({ user }) {
  const [filter, setFilter] = useState('')
  const [cityFilter, setCityFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [minYield, setMinYield] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [sort, setSort] = useState('')
  const [search, setSearch] = useState('')

  const { properties, loading, error, refresh } = useProperties(filter)

  const priceOf = p => Number(p.pricePerTokenINR) ||
    (p.totalTokens ? p.valuationINR / p.totalTokens : 0)

  // Filtering and sorting run client-side over the already-fetched list, so
  // changing a control is instant and costs no extra request.
  const filtered = properties.filter(p => {
    if (cityFilter && p.location?.city !== cityFilter) return false
    if (typeFilter && p.propertyType !== typeFilter) return false
    if (minYield && Number(p.expectedYieldPct || 0) < Number(minYield)) return false
    if (maxPrice && priceOf(p) > Number(maxPrice)) return false
    if (search) {
      const hay = `${p.title || ''} ${p.location?.city || ''} ${p.propertyType || ''}`.toLowerCase()
      if (!hay.includes(search.toLowerCase())) return false
    }
    return true
  })

  const sorters = {
    yield: (a, b) => Number(b.expectedYieldPct || 0) - Number(a.expectedYieldPct || 0),
    priceAsc: (a, b) => priceOf(a) - priceOf(b),
    priceDesc: (a, b) => priceOf(b) - priceOf(a),
    funded: (a, b) => Number(b.fundedPct || 0) - Number(a.fundedPct || 0),
    valuation: (a, b) => Number(b.valuationINR || 0) - Number(a.valuationINR || 0),
  }
  const shown = sort && sorters[sort] ? [...filtered].sort(sorters[sort]) : filtered

  const cities = [...new Set(properties.map(p => p.location?.city).filter(Boolean))].sort()
  const types = [...new Set(properties.map(p => p.propertyType).filter(Boolean))].sort()
  const clearAll = () => { setFilter(''); setCityFilter(''); setTypeFilter(''); setMinYield(''); setMaxPrice(''); setSort(''); setSearch('') }
  const activeFilters = [cityFilter, typeFilter, minYield, maxPrice, search, filter].filter(Boolean).length

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 16px' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>Properties</h1>
        <p style={{ color: '#6B7280', fontSize: 14, marginTop: 6, maxWidth: '60ch' }}>
          Own a piece of premium properties from ₹500. Secure, instant, no paperwork.
        </p>
      </div>

      <div style={{
        background: 'white',
        border: '1px solid #E5E7EB',
        borderRadius: 12,
        padding: '14px 16px',
        marginBottom: 20,
        display: 'flex',
        gap: 10,
        flexWrap: 'wrap',
        alignItems: 'center'
      }}>
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{
            padding: '8px 12px',
            border: '1px solid #E5E7EB',
            borderRadius: 8,
            fontSize: 13,
            background: 'white'
          }}
        >
          <option value="">All Properties</option>
          <option value="TOKENIZED">Available Now</option>
          <option value="DRAFT">Coming Soon</option>
        </select>

        <select
          value={cityFilter}
          onChange={e => setCityFilter(e.target.value)}
          style={{
            padding: '8px 12px',
            border: '1px solid #E5E7EB',
            borderRadius: 8,
            fontSize: 13,
            background: 'white'
          }}
        >
          <option value="">All Cities</option>
          {cities.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, background: 'white' }}
        >
          <option value="">All Types</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <select
          value={minYield}
          onChange={e => setMinYield(e.target.value)}
          title="Minimum expected rental yield"
          style={{ padding: '8px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, background: 'white' }}
        >
          <option value="">Any Yield</option>
          <option value="6">6%+ yield</option>
          <option value="8">8%+ yield</option>
          <option value="10">10%+ yield</option>
        </select>

        <select
          value={maxPrice}
          onChange={e => setMaxPrice(e.target.value)}
          title="Maximum price per token - your minimum investment"
          style={{ padding: '8px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, background: 'white' }}
        >
          <option value="">Any Entry Price</option>
          <option value="250">Under ₹250/token</option>
          <option value="500">Under ₹500/token</option>
          <option value="1000">Under ₹1,000/token</option>
        </select>

        <select
          value={sort}
          onChange={e => setSort(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, background: 'white' }}
        >
          <option value="">Sort: Default</option>
          <option value="yield">Highest yield</option>
          <option value="priceAsc">Lowest entry price</option>
          <option value="priceDesc">Highest entry price</option>
          <option value="funded">Most funded</option>
          <option value="valuation">Largest value</option>
        </select>

        <input
          placeholder="Search name, city or type"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            padding: '8px 12px',
            border: '1px solid #E5E7EB',
            borderRadius: 8,
            fontSize: 13,
            minWidth: 200,
            flex: 1
          }}
        />

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#9CA3AF' }}>{shown.length} of {properties.length} properties{activeFilters > 0 ? ` · ${activeFilters} filter${activeFilters > 1 ? 's' : ''}` : ''}</span>
          <button
            onClick={refresh}
            style={{
              padding: '8px 14px',
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              background: 'white',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <div style={{
            width: 32,
            height: 32,
            border: '3px solid #E5E7EB',
            borderTopColor: '#1E3A5F',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto'
          }}></div>
          <p style={{ color: '#6B7280', fontSize: 14, marginTop: 12 }}>Loading properties...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      ) : error ? (
        <div style={{
          background: '#FEF2F2',
          border: '1px solid #FECACA',
          borderRadius: 12,
          padding: 20,
          textAlign: 'center'
        }}>
          <p style={{ fontSize: 14, color: '#991B1B' }}>Failed to load: {error}</p>
          <button onClick={refresh} style={{
            marginTop: 12,
            padding: '8px 16px',
            background: '#1E3A5F',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer'
          }}>
            Try Again
          </button>
        </div>
      ) : shown.length === 0 ? (
        <div style={{
          background: 'white',
          border: '1px solid #E5E7EB',
          borderRadius: 12,
          padding: '40px 20px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: 32 }}>🏠</div>
          <p style={{ fontSize: 16, fontWeight: 600, marginTop: 12, color: '#111827' }}>No properties found</p>
          <p style={{ fontSize: 13, color: '#6B7280', marginTop: 6, maxWidth: '40ch', margin: '6px auto 0' }}>
            Try changing filters or search. Or register a new property if you are an owner.
          </p>
          <button onClick={clearAll} style={{
            marginTop: 16,
            padding: '8px 16px',
            border: '1px solid #E5E7EB',
            borderRadius: 8,
            background: 'white',
            cursor: 'pointer'
          }}>
            Clear Filters
          </button>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 16
        }}>
          {shown.map(prop => (
            <SimplePropertyCard key={prop.assetId} property={prop} />
          ))}
        </div>
      )}
    </div>
  )
}
