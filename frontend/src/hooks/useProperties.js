// SOLID: Single Responsibility — Only fetches properties
// Interface Segregation — Returns only needed data
// Dependency Inversion — Depends on api abstraction, not concrete fetch

import { useState, useEffect, useCallback } from 'react'
import api from '../lib/api.js'

function loadLocalCache() {
  try {
    return JSON.parse(localStorage.getItem('aasthi_created_properties') || '[]')
  } catch {
    return []
  }
}

function mergeProperties(backendProps, cachedProps) {
  const mergedMap = new Map()
  backendProps.forEach(p => mergedMap.set(p.assetId, p))
  cachedProps.forEach(cachedProp => {
    if (!mergedMap.has(cachedProp.assetId)) {
      const enriched = {
        ...cachedProp,
        status: cachedProp.status || 'DRAFT',
        registrarValidationStatus: cachedProp.registrarValidationStatus || 'PENDING',
        totalTokens: cachedProp.totalTokens || 10000,
        valuationINR: cachedProp.valuationINR || 6000000,
        location: cachedProp.location || { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
        isCached: true
      }
      mergedMap.set(cachedProp.assetId, enriched)
    } else {
      const existing = mergedMap.get(cachedProp.assetId)
      mergedMap.set(cachedProp.assetId, { ...cachedProp, ...existing })
    }
  })
  return Array.from(mergedMap.values())
}

export function useProperties(filterStatus = '') {
  const [properties, setProperties] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchProperties = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.listProperties(filterStatus)
      let backendProps = data.properties || []
      
      // Merge with local cache for persistence fix
      const cached = loadLocalCache()
      const merged = mergeProperties(backendProps, cached)
      
      setProperties(merged)
    } catch (e) {
      setError(e.message)
      // Fallback to cache + demo
      try {
        const cached = loadLocalCache()
        if (cached.length > 0) {
          setProperties(cached)
        } else {
          setProperties([{
            assetId: 'PROP-GREEN-VALLEY-PUNE-001',
            title: 'Green Valley Villas - Pune',
            location: { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
            valuationINR: 7500000,
            totalTokens: 15000,
            registrarValidationStatus: 'VALIDATED',
            status: 'TOKENIZED',
            originatorId: 'originator1'
          }])
        }
      } catch {
        setProperties([])
      }
    } finally {
      setLoading(false)
    }
  }, [filterStatus])

  useEffect(() => {
    fetchProperties()
  }, [fetchProperties])

  return { properties, loading, error, refresh: fetchProperties }
}

export function useProperty(assetId) {
  const [property, setProperty] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchProperty = useCallback(async () => {
    if (!assetId) {
      setLoading(false)
      return
    }
    
    setLoading(true)
    setError('')
    try {
      const data = await api.getProperty(assetId)
      const prop = data.property || data
      setProperty(prop)
      
      // Update cache
      try {
        const cached = loadLocalCache()
        const idx = cached.findIndex(p => p.assetId === prop.assetId)
        if (idx >= 0) {
          cached[idx] = { ...cached[idx], ...prop, updatedAt: new Date().toISOString() }
          localStorage.setItem('aasthi_created_properties', JSON.stringify(cached))
        }
      } catch {}
    } catch (e) {
      // Try cache fallback
      try {
        const cached = loadLocalCache()
        const found = cached.find(p => p.assetId === assetId)
        if (found) {
          setProperty(found)
          setError('')
          setLoading(false)
          return
        }
      } catch {}
      
      setError(e.message)
      // Fallback demo
      if (!property) {
        setProperty({
          assetId: assetId,
          title: 'Green Valley Villas - Pune',
          location: { state: 'Maharashtra', city: 'Pune', pincode: '411045' },
          valuationINR: 7500000,
          totalTokens: 15000,
          registrarValidationStatus: 'VALIDATED',
          status: 'TOKENIZED',
          originatorId: 'originator1'
        })
      }
    } finally {
      setLoading(false)
    }
  }, [assetId])

  useEffect(() => {
    fetchProperty()
  }, [fetchProperty])

  return { property, loading, error, refresh: fetchProperty }
}
