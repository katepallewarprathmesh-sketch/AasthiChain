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
    
    // Read as text first: a non-JSON body (an HTML error page, or a plain-text
    // 404 from an upstream service) used to collapse into "Request failed 404"
    // with no indication of what had actually gone wrong.
    const raw = await res.text()
    let data
    try {
      data = raw ? JSON.parse(raw) : {}
    } catch {
      const snippet = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
      const error = new Error(
        res.status === 404
          ? `${path} is not available on this deployment (HTTP 404).${snippet ? ' Server said: ' + snippet : ''}`
          : `The server returned an unreadable response (HTTP ${res.status}).${snippet ? ' ' + snippet : ''}`
      )
      error.status = res.status
      error.nonJson = true
      throw error
    }

    if (!res.ok) {
      const error = new Error(data.message || data.error || `HTTP ${res.status}`)
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

  // Public on purpose: a verification surface nobody can read is worthless.
  // Named for the dossier, not "verify", because verifyProperty() below is
  // already the government land-record lookup.
  async propertyVerification(assetId) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}/verify`)
  }
  async verifyPropertyDocument(assetId, documentHash) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}/verify-document`, {
      method: 'POST',
      body: JSON.stringify({ documentHash }),
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

  // Operations queue — Registrar/Regulator only, 403 otherwise.
  async getAdminOps() {
    return this.request('/api/admin/ops')
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
  // UMI settlement chain (Go rail, durable + append-only). Separate from the
  // Node demo chain above: this is the one UMI commits every settlement to.
  async getUmiChain(limit = 60, from) {
    const q = from === undefined ? '' : `&from=${from}`
    return this.request(`/api/drunix/chain?limit=${limit}${q}`)
  }
  async umiWallets() { return this.request('/api/umi/wallets') }
  async umiInstructions() { return this.request('/api/umi/instructions') }
  async umiIncome(participant) { return this.request(`/api/umi/income/${encodeURIComponent(participant)}`) }
  // Cross-property portfolio tokens. A basket unit is a claim on a fixed
  // recipe of property tokens held in custody, so one number can stand for
  // several properties at once.
  async umiBaskets() { return this.request('/api/umi/baskets') }
  async umiBasket(basketId) { return this.request(`/api/umi/baskets/${encodeURIComponent(basketId)}`) }
  async umiBasketHoldings(participant) { return this.request(`/api/umi/holdings/${encodeURIComponent(participant)}`) }
  async umiBasketSubscribe(basketId, holder, units) {
    return this.request(`/api/umi/baskets/${encodeURIComponent(basketId)}/subscribe`, {
      method: 'POST', body: JSON.stringify({ holder, units: Number(units) })
    })
  }
  // Selling units for e₹-W cash. dryRun answers "would this work" and
  // commits nothing, so the investor can be warned before they commit.
  async umiBasketSell(basketId, { seller, buyer, units, pricePerUnitINR, dryRun = false }) {
    return this.request(`/api/umi/baskets/${encodeURIComponent(basketId)}/dvp`, {
      method: 'POST',
      body: JSON.stringify({ seller, buyer, units: Number(units), pricePerUnitINR: Number(pricePerUnitINR), dryRun })
    })
  }
  async umiBasketRedeem(basketId, holder, units) {
    return this.request(`/api/umi/baskets/${encodeURIComponent(basketId)}/redeem`, {
      method: 'POST', body: JSON.stringify({ holder, units: Number(units) })
    })
  }
  async umiOwnership(assetId, from, to) {
    const q = new URLSearchParams()
    if (from) q.set('from', from)
    if (to) q.set('to', to)
    const qs = q.toString()
    return this.request(`/api/umi/ownership/${encodeURIComponent(assetId)}${qs ? '?' + qs : ''}`)
  }
  async chainHead() { return this.request('/api/chain/head') }
  async tamperChain(height) {
    return this.request('/api/chain/tamper', { method: 'POST', body: JSON.stringify({ height }) })
  }
  async restoreChain(height = -1) {
    return this.request('/api/chain/restore', { method: 'POST', body: JSON.stringify({ height }) })
  }
  // ---- Programmable ownership: NAV, yield, governance, credit, swaps ----
  async portfolioNav(identityId) { return this.request(`/api/portfolio/${encodeURIComponent(identityId)}/nav`) }
  async distributeYield(assetId, amountINR) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}/yield/distribute`, { method: 'POST', body: JSON.stringify({ amountINR }) })
  }
  async getProposals(assetId) { return this.request(`/api/properties/${encodeURIComponent(assetId)}/governance`) }
  async createProposal(assetId, title, description) {
    return this.request(`/api/properties/${encodeURIComponent(assetId)}/governance`, { method: 'POST', body: JSON.stringify({ title, description }) })
  }
  async voteProposal(assetId, govId, choice) {
    return this.request(`/api/governance/${encodeURIComponent(assetId)}/${encodeURIComponent(govId)}/vote`, { method: 'POST', body: JSON.stringify({ choice }) })
  }
  async pledgeCollateral(assetId, tokens) {
    return this.request('/api/credit/pledge', { method: 'POST', body: JSON.stringify({ assetId, tokens }) })
  }
  async repayLoan(loanId) {
    return this.request('/api/credit/repay', { method: 'POST', body: JSON.stringify({ loanId }) })
  }
  async getLoans(identityId) { return this.request(`/api/credit/loans/${encodeURIComponent(identityId)}`) }
  async atomicSwap(giveAssetId, giveTokens, getAssetId, getTokens, counterparty) {
    return this.request('/api/swap', { method: 'POST', body: JSON.stringify({ giveAssetId, giveTokens, getAssetId, getTokens, counterparty }) })
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
