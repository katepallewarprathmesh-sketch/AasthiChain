// SOLID: Single Responsibility — Only handles local cache
// Interface Segregation — Small focused interface

export function useLocalCache() {
  const saveProperty = (prop) => {
    try {
      const existing = JSON.parse(localStorage.getItem('aasthi_created_properties') || '[]')
      const idx = existing.findIndex(p => p.assetId === prop.assetId)
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], ...prop, updatedAt: new Date().toISOString() }
      } else {
        existing.push({ ...prop, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      }
      localStorage.setItem('aasthi_created_properties', JSON.stringify(existing))
      localStorage.setItem('aasthi_last_property', prop.assetId)
      return true
    } catch (e) {
      console.error('Cache save failed', e)
      return false
    }
  }

  const loadProperties = () => {
    try {
      return JSON.parse(localStorage.getItem('aasthi_created_properties') || '[]')
    } catch {
      return []
    }
  }

  const getLastPropertyId = () => {
    try {
      return localStorage.getItem('aasthi_last_property') || ''
    } catch {
      return ''
    }
  }

  const clearCache = () => {
    try {
      localStorage.removeItem('aasthi_created_properties')
      localStorage.removeItem('aasthi_last_property')
    } catch {}
  }

  return { saveProperty, loadProperties, getLastPropertyId, clearCache }
}
