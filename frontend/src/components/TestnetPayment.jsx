import React, { useState, useEffect } from 'react'

// Sepolia escrow contract. `contracts/PaymentEscrow.sol` is written but NOT deployed:
// with no address configured this stays the zero address, and the on-chain path is
// unavailable.
const CONTRACT_ADDRESS = import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000'
const SEPOLIA_CHAIN_ID = '0xaa36a7'

// A contract is only "deployed" if we were given a non-zero address.
export const isContractDeployed = (addr = CONTRACT_ADDRESS) =>
  typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr) && !/^0x0+$/.test(addr)

/**
 * Sepolia escrow — settlement-pattern demonstration.
 *
 * This component previously claimed to make "real, Etherscan-verifiable" Sepolia
 * transactions. It did not: it generated a random hex string, labelled it
 * isSimulated:false, and rendered an Etherscan link that resolved to nothing.
 * That fabricated an on-chain proof, so it was removed.
 *
 * What is real here: MetaMask connection, your account address, your Sepolia
 * balance, and the Drunix token transfer (steps 3-4), which does hit the ledger.
 * What is not: the escrow leg. No SepoliaETH moves and no transaction is broadcast.
 *
 * Two things must land before the on-chain path can exist:
 *   1. PaymentEscrow.sol deployed, with VITE_ESCROW_CONTRACT_ADDRESS set.
 *   2. An identity -> EVM address mapping. The escrow needs an address for the
 *      payee; the app only has Fabric identity ids such as 'originator1'.
 */
export default function TestnetPayment({ assetId, tokenAmount, tokenPrice, onPaymentComplete, onPaymentConfirmed, recipient }) {
  const handleComplete = onPaymentComplete || onPaymentConfirmed
  const [wallet, setWallet] = useState(null)
  const [balance, setBalance] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [paymentId, setPaymentId] = useState('')
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [drunixTx, setDrunixTx] = useState('')

  const contractLive = isContractDeployed()

  // Indicative conversion only — no oracle is consulted and nothing is priced in ETH.
  const rawEth = tokenAmount ? (tokenAmount * tokenPrice / 20000) : 0
  const indicativeEth = rawEth ? Math.max(rawEth, 0.001).toFixed(4) : '0.0010'

  useEffect(() => {
    let mounted = true
    const init = async () => { if (mounted) await checkWallet() }
    init()
    const handleAccountsChanged = () => { if (mounted) checkWallet() }
    const handleChainChanged = () => { if (mounted) checkWallet() }
    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on('accountsChanged', handleAccountsChanged)
      window.ethereum.on('chainChanged', handleChainChanged)
    }
    return () => {
      mounted = false
      if (window.ethereum && window.ethereum.removeListener) {
        window.ethereum.removeListener('accountsChanged', handleAccountsChanged)
        window.ethereum.removeListener('chainChanged', handleChainChanged)
      }
    }
  }, [])

  // Reads real data from MetaMask: a real address and a real balance.
  const checkWallet = async () => {
    try {
      if (!window.ethereum) return
      const accounts = await window.ethereum.request({ method: 'eth_accounts' }).catch(() => [])
      if (accounts && accounts.length) {
        setWallet(accounts[0])
        const cid = await window.ethereum.request({ method: 'eth_chainId' }).catch(() => null)
        setChainId(cid)
        const wei = await window.ethereum.request({ method: 'eth_getBalance', params: [accounts[0], 'latest'] }).catch(() => null)
        if (wei) setBalance((parseInt(wei, 16) / 1e18).toFixed(4))
      }
    } catch {
      /* wallet unavailable — the demo still runs */
    }
  }

  const connectWallet = async () => {
    if (!window.ethereum) { setError('MetaMask not detected. Install it, or run the settlement-pattern demo below.'); return }
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' })
      await checkWallet()
    } catch (e) {
      setError(e.message)
    }
  }

  const switchToSepolia = async () => {
    if (!window.ethereum) return
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA_CHAIN_ID }] })
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: SEPOLIA_CHAIN_ID,
            chainName: 'Sepolia Testnet',
            nativeCurrency: { name: 'SepoliaETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://rpc.sepolia.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
            blockExplorerUrls: ['https://sepolia.etherscan.io']
          }]
        })
      }
    }
    await checkWallet()
  }

  /**
   * Runs the DvP *pattern* end to end. The escrow leg is not broadcast anywhere;
   * the Drunix token transfer is real. Nothing here invents a transaction hash,
   * and the record is always stored with isSimulated: true.
   */
  const runPatternDemo = async () => {
    setStatus('paying')
    setError('')
    setPaymentId('')
    setDrunixTx('')

    const simulatedId = 'SIM-' + Math.random().toString(36).slice(2, 10).toUpperCase()
    setPaymentId(simulatedId)
    setStatus('pending')

    try {
      const token = localStorage.getItem('aasthi_token') || ''
      const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

      await fetch('/api/testnet/payments/initiate', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          assetId, tokenAmount,
          estimatedEth: indicativeEth,
          txHash: '',               // never fabricate a hash
          paymentId: simulatedId,
          from: wallet || 'unconnected_wallet',
          to: recipient || 'originator1',
          isSimulated: true,
          realTx: false
        })
      })

      const drunixRes = await fetch('/api/transfers', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ assetId, toId: recipient || 'investor2', amount: parseInt(tokenAmount) || 1 })
      })
      const drunixData = await drunixRes.json()

      if (!drunixRes.ok) {
        setStatus('failed')
        setError(`Drunix transfer failed: ${drunixData.error || 'unknown error'} — in a live escrow this is where refundPayment() would fire.`)
        return
      }

      setDrunixTx(drunixData.transferId)
      setStatus('confirmed')

      await fetch(`/api/testnet/payments/${simulatedId}/confirm`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ drunixTransferId: drunixData.transferId })
      })
      await fetch(`/api/testnet/payments/${simulatedId}/release`, { method: 'POST', headers: authHeaders })

      setStatus('released')
      if (handleComplete) {
        try { handleComplete(simulatedId, drunixData.transferId) } catch {}
        try { handleComplete({ paymentId: simulatedId, txHash: '', drunixTransferId: drunixData.transferId, isSimulated: true }) } catch {}
      }
    } catch (e) {
      setStatus('failed')
      setError(`Settlement-pattern demo failed: ${e.message}`)
    }
  }

  const busy = status === 'paying' || status === 'pending'
  const stepDot = (done, pending) => ({
    width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
    background: done ? '#2F6B4F' : pending ? '#FFD166' : '#E5E7EB',
    color: done ? 'white' : 'black',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10
  })

  return (
    <div className="card" style={{ borderColor: 'var(--registry-navy)', background: 'var(--surface)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ background: '#8A7D6B', color: 'white', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>PATTERN DEMO</span>
            Sepolia escrow — delivery-versus-payment pattern
          </h3>
          <p style={{ fontSize: 11, color: 'var(--ink-60)', maxWidth: '78ch', marginTop: 6 }}>
            Shows how a cash escrow on a public chain would pair with a securities transfer on Drunix.
            <strong> No Sepolia transaction is broadcast and no SepoliaETH moves.</strong> The Drunix token
            transfer in steps 3–4 is real. For settlement that is genuinely atomic, see the on-ledger cash
            leg (<code>SettleDvP</code>), which commits both legs in a single transaction.
          </p>
        </div>
        <div style={{ fontSize: 10, background: 'var(--paper)', border: '1px solid var(--ink-8)', padding: '4px 8px', borderRadius: 4, color: 'var(--ink-40)' }}>
          {contractLive
            ? <>Contract: {CONTRACT_ADDRESS.slice(0, 10)}… · Sepolia 11155111</>
            : <>Escrow contract not deployed · Sepolia 11155111</>}
        </div>
      </div>

      {/* Honest statement of what is missing, instead of a button that pretends. */}
      <div style={{ marginTop: 14, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#92400E' }}>Why the on-chain path is switched off</div>
        <ul style={{ fontSize: 11, color: '#6B5B3E', margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
          <li><code>contracts/PaymentEscrow.sol</code> is written but not deployed — <code>VITE_ESCROW_CONTRACT_ADDRESS</code> is unset.</li>
          <li>The escrow needs an EVM address for the payee. The app only holds Fabric identity ids such as <code>originator1</code>; no identity-to-address mapping exists yet.</li>
        </ul>
        <div style={{ fontSize: 10, color: '#8A7D6B', marginTop: 6 }}>
          Until both are resolved, this panel runs the pattern without touching Sepolia. It will never display a transaction hash or an explorer link it cannot substantiate.
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16, gap: 16 }}>
        <div style={{ background: 'var(--paper)', border: '1px solid var(--ink-8)', borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-40)', marginBottom: 8 }}>Trade details</div>
          <div style={{ fontSize: 12, lineHeight: 1.8 }}>
            <div>Property: <strong>{assetId ? assetId.slice(0, 22) + '…' : 'Select from marketplace'}</strong></div>
            <div>Tokens: <span className="tabular" style={{ fontWeight: 700 }}>{tokenAmount || 0}</span></div>
            <div>Price: <span className="tabular">₹{tokenPrice ? tokenPrice.toLocaleString('en-IN') : 0}/token</span></div>
            <div>Value: <span className="tabular" style={{ fontWeight: 700 }}>₹{tokenAmount && tokenPrice ? (tokenAmount * tokenPrice).toLocaleString('en-IN') : 0}</span></div>
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--ink-8)' }}>
              <div style={{ fontSize: 10, color: 'var(--ink-40)' }}>Indicative only, at a fixed ₹20,000 = 1 ETH. No oracle, no quote, nothing payable.</div>
              <div className="tabular" style={{ fontSize: 20, fontFamily: 'Fraunces', fontWeight: 700, color: 'var(--ink-40)' }}>{indicativeEth} ETH</div>
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--paper)', border: '1px solid var(--ink-8)', borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-40)', marginBottom: 8 }}>Wallet</div>
          {!wallet ? (
            <>
              <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 8 }}>Connecting is optional — it only reads your address and balance. The demo runs either way.</div>
              <button className="btn btn-secondary" onClick={connectWallet} style={{ width: '100%' }}>Connect MetaMask (read-only)</button>
            </>
          ) : (
            <div style={{ fontSize: 11, lineHeight: 1.8 }}>
              <div>Account: <span className="tabular">{wallet.slice(0, 6)}…{wallet.slice(-4)}</span></div>
              <div>Balance: <span className="tabular">{balance ?? '—'} ETH</span> <span style={{ color: '#9CA3AF' }}>(real, read from chain)</span></div>
              <div>Network: {chainId === SEPOLIA_CHAIN_ID
                ? <span style={{ color: '#2F6B4F', fontWeight: 600 }}>Sepolia</span>
                : <>
                    <span style={{ color: '#8A6D00' }}>not Sepolia</span>{' '}
                    <button className="btn" onClick={switchToSepolia} style={{ fontSize: 10, padding: '1px 6px' }}>switch</button>
                  </>}
              </div>
              <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 6 }}>Your balance is not spent or checked against the trade — nothing is payable.</div>
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={runPatternDemo}
            disabled={busy}
            style={{ width: '100%', marginTop: 10 }}
          >
            {status === 'paying' ? 'Starting…' : status === 'pending' ? 'Running…' : 'Run the DvP pattern (no Sepolia transaction)'}
          </button>

          {error && <div style={{ marginTop: 10, background: 'rgba(161,61,46,0.08)', border: '1px solid rgba(161,61,46,0.15)', color: '#A13D2E', padding: '8px 10px', borderRadius: 6, fontSize: 10 }}>{error}</div>}
        </div>
      </div>

      {(paymentId || drunixTx) && (
        <div style={{ marginTop: 14, background: 'var(--surface)', border: '1px solid var(--ink-12)', borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
            DvP flow — escrow leg simulated, Drunix leg real
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={stepDot(false, false)}>–</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#8A7D6B' }}>1. Escrow lock — not executed</div>
              <div style={{ fontSize: 10, color: '#9CA3AF' }}>
                Would lock {indicativeEth} ETH in PaymentEscrow.sol. No transaction was broadcast, so there is no hash and no explorer link.
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={stepDot(!!paymentId, status === 'pending')}>{paymentId ? '✓' : '○'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>2. Escrow reference created</div>
              <div style={{ fontSize: 10, color: '#6B7280' }}>Reference: <span className="tabular">{paymentId || '…'}</span> — an application record, not an on-chain escrow.</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={stepDot(!!drunixTx, status === 'pending')}>{drunixTx ? '✓' : '○'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>3. Drunix token transfer <span style={{ color: '#2F6B4F' }}>(real)</span></div>
              <div style={{ fontSize: 10, color: '#6B7280' }}>TransferTokens moves the property tokens and writes a block to the Drunix ledger.</div>
              {drunixTx && <div style={{ fontSize: 9, fontFamily: 'monospace', marginTop: 2 }}>Drunix txn: {drunixTx.slice(0, 20)}… — verify via /api/chain/verify</div>}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={stepDot(status === 'released', false)}>{status === 'released' ? '✓' : '○'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>4. Escrow release — simulated</div>
              <div style={{ fontSize: 10, color: '#6B7280' }}>
                Marks the reference released. No SepoliaETH moved. Note the weakness this illustrates: two chains means two transactions, so a crash between steps 3 and 4 leaves tokens delivered and cash unreleased — which is exactly why the on-ledger cash leg settles both in one transaction.
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 9, color: '#9CA3AF', maxWidth: '82ch', lineHeight: 1.5, background: 'var(--paper)', border: '1px solid #E5E7EB', borderRadius: 6, padding: 8 }}>
        Scope: an illustration of cross-chain DvP, not a payment product. No real money, no token sale, no
        investment offer. The escrow leg is not executed; the Drunix leg is. Production would settle the cash
        leg in central-bank money over UMI rather than on a public chain.
      </div>
    </div>
  )
}
