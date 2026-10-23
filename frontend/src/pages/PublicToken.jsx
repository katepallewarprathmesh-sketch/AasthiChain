import React, { useCallback, useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost } from '../lib/umiFetch.js'

/**
 * The property token on a public chain, and the rail that writes it.
 *
 * WHAT THIS PAGE IS FOR
 * contracts/PropertyToken.sol has existed and passed its tests for a while,
 * and nothing called it. A contract nobody calls is a sample. This screen is
 * where the rail actually writes to it: register a holder's Ethereum address,
 * then mirror their rail position onto the chain.
 *
 * THE RULE THE PAGE EXISTS TO ENFORCE
 *   an on-chain balance never exceeds the holder's position on the rail
 * A mirror that can exceed the register is a second issuance of the same
 * property. So the mint is the shortfall and nothing else, and every way of
 * breaking the rule is refused with the arithmetic shown.
 *
 * THE DIRECTION IS ONE WAY, which the page says in its own words rather than
 * in a footnote. The rail writes to the chain. A transfer made directly on
 * the chain is not written back, because the rail is the register of title.
 * The consequence is drift, so the comparison table reports it per wallet.
 */

const short = (a) => (a && a.length > 14 ? a.slice(0, 8) + '…' + a.slice(-6) : a || '')

function Status({ st }) {
  if (!st) return null
  const live = st.configured && st.fundedForWrites
  return (
    <Card
      title="The signer and the contract"
      sub={st.network + (st.chainId ? ' · chain ' + st.chainId : '')}
      right={<Tag tone={live ? 'live' : 'warn'}>{live ? 'Can write' : st.configured ? 'Out of gas' : 'Read only'}</Tag>}
    >
      <div className="pg-kv">
        <div>Token contract</div>
        <div>{st.tokenAddress ? short(st.tokenAddress) : 'not deployed'}</div>
        <div>Identity registry</div>
        <div>{st.identityAddress ? short(st.identityAddress) : 'not deployed'}</div>
        <div>Signer</div>
        <div>{st.signer ? short(st.signer) : 'no key loaded'}</div>
        <div>Gas balance</div>
        <div>{st.balanceEth ? st.balanceEth + ' ETH' : '0'}</div>
        <div>Writes made</div>
        <div>{st.writes || 0}</div>
      </div>

      {!st.configured && (
        <p className="pg-card-sub" style={{ marginTop: 12 }}>
          Nothing is hidden behind the words "not configured": the rail is missing{' '}
          <b>{(st.missing || []).join(', ')}</b>. Set those and this page writes to a real chain.
        </p>
      )}
      {st.configured && st.chainIdAgrees === false && (
        <p className="pg-card-sub" style={{ marginTop: 12 }}>
          The configured chain id is {st.chainId} but the node reports {st.chainIdFromNode}. Every
          transaction signed here would be rejected as replay protected for a different chain.
        </p>
      )}
      {st.rpcError && <p className="pg-card-sub" style={{ marginTop: 12 }}>The node did not answer: {st.rpcError}</p>}

      <p className="pg-card-sub" style={{ marginTop: 12 }}>
        Standards: {(st.contract && st.contract.standards || []).join(' · ')}
      </p>
    </Card>
  )
}

function Compare({ data, assetId, onAsset }) {
  const rows = (data && data.wallets) || []
  return (
    <Card
      title="The chain against the register"
      sub="Each linked wallet's on-chain balance beside the rail position it mirrors"
      right={data ? <Tag tone={data.agrees ? 'live' : 'bad'}>{data.agrees ? 'In step' : 'Drift'}</Tag> : null}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          className="pg-input"
          value={assetId}
          onChange={e => onAsset(e.target.value)}
          placeholder="asset id"
          style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit' }}
        />
      </div>
      {!rows.length && (
        <p className="pg-empty">
          No wallet has been registered for this asset yet. Until a holder's address is in the
          on-chain identity registry, the token contract will not let it hold anything.
        </p>
      )}
      {rows.map(r => (
        <div key={r.wallet} className="pg-card" style={{ padding: 12, marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600 }}>{r.holder}</span>
            <Tag tone={r.agrees ? 'live' : 'bad'}>{r.agrees ? 'matches' : 'drift ' + r.drift}</Tag>
          </div>
          <div className="pg-kv" style={{ marginTop: 8 }}>
            <div>Wallet</div>
            <div>{short(r.wallet)}</div>
            <div>Rail position</div>
            <div>{r.railPosition}</div>
            <div>On chain</div>
            <div>{r.onChain === undefined ? 'not read' : r.onChain}</div>
          </div>
          {r.reading && <p className="pg-card-sub" style={{ marginTop: 8 }}>{r.reading}</p>}
          {r.error && <p className="pg-card-sub" style={{ marginTop: 8 }}>{r.error}</p>}
        </div>
      ))}
      {data && <p className="pg-card-sub" style={{ marginTop: 12 }}>{data.whatThisProves}</p>}
      {data && <p className="pg-card-sub" style={{ marginTop: 8, opacity: 0.85 }}>{data.whatThisDoesNotProve}</p>}
    </Card>
  )
}

export default function PublicToken() {
  const [st, setSt] = useState(null)
  const [records, setRecords] = useState([])
  const [compare, setCompare] = useState(null)
  const [assetId, setAssetId] = useState('PROP-SOLARIS-PUNE-001')
  const [holder, setHolder] = useState('investor1')
  const [wallet, setWallet] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(null)

  const load = useCallback(async (asset) => {
    const s = await umiFetch('/token')
    if (s.ok) { setSt(s.data); setRecords((s.data && s.data.records) || []) }
    const c = await umiFetch('/token/compare?assetId=' + encodeURIComponent(asset))
    if (c.ok) setCompare(c.data)
  }, [])

  useEffect(() => { load(assetId) }, [load, assetId])

  const run = async (path, body) => {
    setBusy(true)
    const { ok, data } = await umiPost(path, body)
    setBusy(false)
    setOutcome({ ok, data })
    load(assetId)
  }

  return (
    <PageShell
      title="Property token on a public chain"
      subtitle="An ERC-20 with the ERC-7943 restriction interface, arranged the way ERC-3643 arranges one, written by this rail"
    >
      <Status st={st} />

      <Card
        title="Register a holder, then mirror their position"
        sub="Two writes, both signed by this process, both ending in a transaction anyone can read"
      >
        <div style={{ display: 'grid', gap: 10 }}>
          <input
            value={holder} onChange={e => setHolder(e.target.value)} placeholder="rail holder, e.g. investor1"
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit' }}
          />
          <input
            value={wallet} onChange={e => setWallet(e.target.value)} placeholder="0x… Ethereum address"
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="pg-btn" disabled={busy} onClick={() => run('/token/link', { holder, wallet })}>
              {busy ? 'Signing…' : 'Register this address on chain'}
            </button>
            <button className="pg-btn pg-btn-ghost" disabled={busy} onClick={() => run('/token/mirror', { assetId, holder })}>
              Mirror the rail position
            </button>
          </div>
        </div>

        {outcome && (
          <div className="pg-card" style={{ padding: 12, marginTop: 12 }}>
            <Tag tone={outcome.ok ? 'live' : 'bad'}>{outcome.ok ? 'Sent' : 'Refused'}</Tag>
            <p className="pg-card-sub" style={{ marginTop: 8 }}>
              {outcome.ok
                ? 'Transaction ' + ((outcome.data.record && outcome.data.record.txHash) || '')
                : (outcome.data && (outcome.data.message || outcome.data.error))}
            </p>
            {!outcome.ok && outcome.data && outcome.data.refusalRecorded && (
              <p className="pg-card-sub" style={{ marginTop: 6, opacity: 0.85 }}>
                The refusal is on the ledger as UMI_TOKEN_REFUSED. A decision that leaves no trace
                cannot be audited.
              </p>
            )}
            {outcome.ok && outcome.data.record && outcome.data.record.explorer && (
              <p className="pg-card-sub" style={{ marginTop: 6 }}>
                <a href={outcome.data.record.explorer} target="_blank" rel="noreferrer">Open it in a block explorer</a>
              </p>
            )}
          </div>
        )}

        <p className="pg-card-sub" style={{ marginTop: 12 }}>
          Registering writes the holder's KYC tier and a hash of their DID, never the identity
          itself. Mirroring mints the difference between the chain and the rail, so a wallet that
          is already level is refused rather than topped up by zero.
        </p>
      </Card>

      <Compare data={compare} assetId={assetId} onAsset={setAssetId} />

      <Card title="Writes this rail has made" sub="Newest first">
        {!records.length && <p className="pg-empty">Nothing has been written to a public chain from this process yet.</p>}
        {records.map(r => (
          <div key={r.id} className="pg-card" style={{ padding: 12, marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 600 }}>{r.action} · {r.holder}</span>
              <Tag tone={r.simulated ? 'warn' : 'live'}>{r.simulated ? 'local chain' : 'public chain'}</Tag>
            </div>
            <div className="pg-card-sub" style={{ marginTop: 6 }}>
              {r.tokens ? r.tokens + ' tokens · ' : ''}{short(r.txHash)} · {r.at}
            </div>
            {r.explorer && (
              <p className="pg-card-sub" style={{ marginTop: 6 }}>
                <a href={r.explorer} target="_blank" rel="noreferrer">Open in a block explorer</a>
              </p>
            )}
          </div>
        ))}
      </Card>

      <Card title="What this does not claim">
        <p className="pg-card-sub">
          <b>The chain is not the register.</b> Title to Indian immovable property is not
          transferable by a public blockchain, so this contract mirrors a position the rail already
          records. Settlement, the cash leg and the register stay on the rail.
        </p>
        <p className="pg-card-sub" style={{ marginTop: 10 }}>
          <b>It is one way.</b> A transfer made directly between two linked wallets on the public
          chain is not reflected back here. It shows up in the comparison above as drift, which is
          reported rather than reconciled, because quietly rewriting the register to match a public
          chain is exactly what must not happen.
        </p>
        <p className="pg-card-sub" style={{ marginTop: 10 }}>
          <b>The signing is ours.</b> The secp256k1 signing, the nonces and the transaction
          encoding are implemented in this rail and pinned to the EIP-155 reference vector by a
          test. That implementation is not constant time and is intended for a testnet key. A
          production deployment signs in an HSM.
        </p>
      </Card>
    </PageShell>
  )
}
