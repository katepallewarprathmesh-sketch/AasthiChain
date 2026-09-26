// SOLID: Single Responsibility API abstraction
// Dependency Inversion Pages depend on this abstraction, not concrete fetch
// Open/Closed Open for extension via new methods, closed for modification

class ApiClient {
  constructor() {
    this.baseUrl = ''
  }

  getAuthHeaders() {
    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const userStr = localStorage.getItem('aasthi_user')
      let identityId = 'investor1'
      if (userStr) {
        identityId = JSON.parse(userStr).identityId || 'investor1'
      }
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Fabric-Identity': identityId
      }
    } catch {
      return { 'Content-Type': 'application/json' }
    }
  }

  async request(path, options = {}) {
    const headers = { ...this.getAuthHeaders(), ...(options.headers || {}) }
    const res = await fetch(path, { ...options, headers })
    
    let data
    try {
      data = await res.json()
    } catch {
      throw new Error(`Request failed ${res.status} ${path}`)
    }
    
    if (!res.ok) {
      const error = new Error(data.error || data.message || `HTTP ${res.status}`)
      error.data = data
      error.status = res.status
      throw error
    }
    
    return data
  }

  // Properties SRP: Single responsibility for property operations
  async listProperties(status = '') {
    const url = status ? `/api/properties?status=${status}` : '/api/properties'
    return this.request(url)
  }

  async getProperty(assetId) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}`)
  }

  async registerProperty(payload) {
    return this.request('/api/properties', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': `idem-${Date.now()}` },
      body: JSON.stringify(payload)
    })
  }

  async validateProperty(assetId, decision) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}/validate`, {
      method: 'POST',
      body: JSON.stringify({ decision })
    })
  }

  async mintProperty(assetId, totalTokens) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}/mint`, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': `mint-${assetId}` },
      body: JSON.stringify({ totalTokens })
    })
  }

  async freezeProperty(assetId, reason) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}/freeze`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    })
  }

  // Balances SRP
  async getBalance(assetId, ownerId) {
    return this.request(`/api/balances/${encodeURIComponent(assetId)}/${encodeURIComponent(ownerId)}`)
  }

  async getWallet(ownerId) {
    return this.request(`/api/balances/wallet/${encodeURIComponent(ownerId)}`)
  }

  // Transfers SRP
  // clientState (optional): { property, receipts, claimedBalance } lets a cold
  // serverless instance re-materialize the sender's balance from verified receipts
  // ---- Drunix block ledger (public open-layer endpoints) ----
  async getChain(limit = 50) { return this.request(`/api/chain?limit=${limit}`) }
  async verifyChain() { return this.request('/api/chain/verify') }
  async chainHead() { return this.request('/api/chain/head') }
  async tamperChain(height) {
    return this.request('/api/chain/tamper', { method: 'POST', body: JSON.stringify({ height }) })
  }
  async restoreChain(height = -1) {
    return this.request('/api/chain/restore', { method: 'POST', body: JSON.stringify({ height }) })
  }

  async transferTokens(assetId, fromId, toId, amount, clientState) {
    return this.request('/api/transfers', {
      method: 'POST',
      body: JSON.stringify({ assetId, fromId, toId, amount, clientState })
    })
  }

  async getTransferHistory(assetId = '', ownerId = '', pageSize = 10, bookmark = '') {
    const params = new URLSearchParams()
    if (assetId) params.set('assetId', assetId)
    if (ownerId) params.set('ownerId', ownerId)
    if (pageSize) params.set('pageSize', pageSize)
    if (bookmark) params.set('bookmark', bookmark)
    return this.request(`/api/transfers/history?${params}`)
  }

  // NPCI UPI SRP: Single responsibility for payments
  async initiateCollect(payload) {
    return this.request('/api/npci/collect', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': `collect-${payload.assetId}-${payload.tokenAmount}-${Date.now()}` },
      body: JSON.stringify(payload)
    })
  }

  async approvePayment(paymentId, payerId, payment) {
    return this.request(`/api/npci/payments/${encodeURIComponent(paymentId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ payerId, payment })
    })
  }

  async releasePayment(paymentId, drunixTransferId, payment) {
    return this.request(`/api/npci/payments/${encodeURIComponent(paymentId)}/release`, {
      method: 'POST',
      body: JSON.stringify({ drunixTransferId, payment })
    })
  }

  async refundPayment(paymentId, reason) {
    return this.request(`/api/npci/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    })
  }

  async declinePayment(paymentId, reason) {
    return this.request(`/api/npci/payments/${encodeURIComponent(paymentId)}/decline`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    })
  }

  async getPayment(paymentId) {
    return this.request(`/api/npci/payments/${encodeURIComponent(paymentId)}`)
  }

  // Self-heal for serverless multi-instance races re-upload payment state the client holds
  async reattachPayment(paymentId, payment) {
    return this.request(`/api/npci/payments/${encodeURIComponent(paymentId)}/reattach`, {
      method: 'POST',
      body: JSON.stringify({ payment })
    })
  }

  // Ensure server knows this payment GET, and reattach on 404 (SRP: one place for the retry policy)
  async ensurePayment(payment) {
    if (!payment || !payment.paymentId) return payment
    try {
      return await this.getPayment(payment.paymentId)
    } catch (e) {
      if (e.status === 404) {
        await this.reattachPayment(payment.paymentId, payment)
        return this.getPayment(payment.paymentId)
      }
      throw e
    }
  }

  async getNpciConfig() {
    return this.request('/api/npci/config')
  }

  async listNpciPayments(limit = 20) {
    return this.request(`/api/npci/payments?limit=${limit}`)
  }

  async getNpciWebhooks() {
    return this.request('/api/npci/webhooks')
  }

  async getPaymentByUTR(utr) {
    return this.request(`/api/npci/utr/${encodeURIComponent(utr)}`)
  }

  async getReconciliation() {
    return this.request('/api/npci/reconcile')
  }

  // Auth & organization (Neon schema entities additive, Open/Closed)
  async getSession() {
    return this.request('/api/auth/session')
  }

  async logout() {
    return this.request('/api/auth/logout', { method: 'POST' })
  }

  async getAuthSchema() {
    return this.request('/api/auth/schema')
  }

  async getJwks() {
    return this.request('/api/auth/jwks')
  }

  async createOrganization(payload) {
    return this.request('/api/orgs', { method: 'POST', body: JSON.stringify(payload) })
  }

  async listOrganizations() {
    return this.request('/api/orgs')
  }

  async inviteMember(orgId, payload) {
    return this.request(`/api/orgs/${encodeURIComponent(orgId)}/invitations`, { method: 'POST', body: JSON.stringify(payload) })
  }

  // PayU S2S reconciliation asks PayU (verify_payment) for the real status
  // of a PENDING payment and heals it server-side (CONFIRMED/DECLINED)
  async reconcilePayu(paymentId) {
    return this.request('/api/npci/payu/reconcile', { method: 'POST', body: JSON.stringify({ paymentId }) })
  }

  // Server-side settlement completes a CONFIRMED payment (tokens move server-side;
  // survives closed tabs / lost browser state). Idempotent.
  async settlePayment(paymentId, paymentCopy) {
    return this.request(`/api/npci/payments/${encodeURIComponent(paymentId)}/settle`, { method: 'POST', body: JSON.stringify({ payment: paymentCopy || null }) })
  }

  async deleteProperty(assetId) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}`, { method: 'DELETE' })
  }

  async acceptInvitation(invitationId) {
    return this.request('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ invitationId }) })
  }

  async createVerification(identifier) {
    return this.request('/api/auth/verification', { method: 'POST', body: JSON.stringify({ identifier }) })
  }

  async verifyVerification(identifier, value) {
    return this.request('/api/auth/verification/verify', { method: 'POST', body: JSON.stringify({ identifier, value }) })
  }

  // KYC SRP
  async getKYC(identityId) {
    return this.request(`/api/kyc/${encodeURIComponent(identityId)}`)
  }

  async updateKYC(identityId, status) {
    return this.request(`/api/kyc/${encodeURIComponent(identityId)}`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    })
  }

  // DigiLocker SRP
  async initDigiLocker(identityId) {
    return this.request('/api/kyc/digilocker/init', {
      method: 'POST',
      body: JSON.stringify({ identityId })
    })
  }

  async callbackDigiLocker(identityId, code, state) {
    return this.request('/api/kyc/digilocker/callback', {
      method: 'POST',
      body: JSON.stringify({ identityId, code, state })
    })
  }

  async pullDigiLockerDoc(identityId, docType) {
    return this.request('/api/kyc/digilocker/pull-document', {
      method: 'POST',
      body: JSON.stringify({ identityId, docType })
    })
  }

  // Property verification SRP
  async verifyProperty(assetId, source = 'bhoomi') {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}/verify`, {
      method: 'POST',
      body: JSON.stringify({ source })
    })
  }
}

// Singleton DIP: Depend on abstraction, single instance
export const api = new ApiClient()
export default api
