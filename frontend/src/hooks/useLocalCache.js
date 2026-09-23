// SOLID: Single Responsibility — Only handles local cache
// Interface Segregation — Small focused interface
// Holds: created properties cache + user holdings overlay (receipts) so a
// cold serverless instance can re-materialize balances via receipts

const HOLDINGS_KEY = 'aasthi_holdings_v1'

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

  // ===== Holdings overlay — per-user token balances with buy receipts =====
  const loadHoldingsMap = () => {
    try {
      const m = JSON.parse(localStorage.getItem(HOLDINGS_KEY) || '{}')
      return m && typeof m === 'object' ? m : {}
    } catch {
      return {}
    }
  }

  const saveHoldingsMap = (map) => {
    try {
      localStorage.setItem(HOLDINGS_KEY, JSON.stringify(map))
      return true
    } catch {
      return false
    }
  }

  // Record a successful buy: adds tokens + keeps the payment receipt for server self-heal
  const recordBuy = (identityId, { assetId, title, tokenPrice, valuationINR, totalTokens, originatorId, tokenAmount, receipt }) => {
    if (!identityId || !assetId || !(parseInt(tokenAmount) > 0)) return false
    const map = loadHoldingsMap()
    if (!map[identityId]) map[identityId] = {}
    const h = map[identityId][assetId] || {
      balance: 0,
      title: title || assetId.slice(0, 16),
      tokenPrice: tokenPrice || 0,
      valuationINR: valuationINR || 0,
      totalTokens: totalTokens || 0,
      originatorId: originatorId || '',
      receipts: []
    }
    h.balance = (h.balance || 0) + parseInt(tokenAmount)
    if (title) h.title = title
    if (tokenPrice) h.tokenPrice = tokenPrice
    if (valuationINR) h.valuationINR = valuationINR
    if (totalTokens) h.totalTokens = totalTokens
    if (originatorId) h.originatorId = originatorId
    if (receipt && receipt.paymentId) {
      h.receipts = [
        ...((h.receipts || []).filter(r => r.paymentId !== receipt.paymentId)).slice(-20),
        { ...receipt, recordedAt: new Date().toISOString() }
      ]
    }
    h.updatedAt = new Date().toISOString()
    map[identityId][assetId] = h
    return saveHoldingsMap(map)
  }

  // Adjust balance after a transfer out (negative delta)
  const adjustHolding = (identityId, assetId, delta) => {
    const map = loadHoldingsMap()
    const h = map[identityId]?.[assetId]
    if (!h) return false
    h.balance = Math.max(0, (h.balance || 0) + parseInt(delta || 0))
    h.updatedAt = new Date().toISOString()
    return saveHoldingsMap(map)
  }

  // Server is authoritative when it has >= local — sync down after Refresh
  const syncHoldingFromServer = (identityId, assetId, serverBalance) => {
    const map = loadHoldingsMap()
    const h = map[identityId]?.[assetId]
    if (!h && !(serverBalance > 0)) return false
    if (h && (serverBalance || 0) >= (h.balance || 0)) {
      h.balance = serverBalance || 0
      h.updatedAt = new Date().toISOString()
      return saveHoldingsMap(map)
    }
    return false
  }

  const loadHoldings = (identityId) => {
    const map = loadHoldingsMap()
    return (identityId && map[identityId]) || {}
  }

  return {
    saveProperty,
    loadProperties,
    getLastPropertyId,
    clearCache,
    recordBuy,
    adjustHolding,
    syncHoldingFromServer,
    loadHoldings
  }
}
