// Drunix Ledger Explorer the blockchain, visible.
// Every settlement (mint / token transfer / escrow release) is a block:
// SHA-512 chained (prevHash) + merkle-committed (txnsRoot). This page replays
// and verifies the chain live, and demonstrates tamper-evidence the core of
// decentralized trust with a clearly-labeled SIMULATION.
// The read endpoints are an open layer: no auth, no PII usable by agents & DPI.

import React, { useCallback, useEffect, useState } from 'react'
import { Badge, Button, CopyButton, Mono, Num } from '../components/ui.jsx'
import { prettifyAssetId } from '../lib/assetNames.js'
import { useLocation } from 'react-router-dom'
import api from '../lib/api.js'
import useLedgerStream from '../lib/useLedgerStream.js'

const TYPE_STYLES = {
  GENESIS: { label: 'Genesis', color: '#64748B', bg: '#F1F5F9', border: '#E2E8F0' },
  TOKEN_MINTED: { label: 'Token Minted', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  TOKEN_TRANSFERRED: { label: 'Token Transferred', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  ESCROW_RELEASED: { label: 'Escrow Released', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  // UMI rail (RBI Unified Market Interface / SEBI Demat 2.0 pattern) — additive
  UMI_WALLET_FUNDED: { label: 'UMI · e₹-W Funded', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_ISIN_ASSIGNED: { label: 'UMI · Pilot ISIN', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_DVP_SETTLED: { label: 'UMI · Atomic DvP Settled', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_DVP_FAILED: { label: 'UMI · DvP Failed (no partial)', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_SERVICING_PAID: { label: 'UMI · Servicing Paid', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  // Basket (multi-property unit) lifecycle
  UMI_BASKET_CREATED: { label: 'UMI · Basket Defined', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_BASKET_SUBSCRIBED: { label: 'UMI · Basket Units Issued', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_BASKET_REDEEMED: { label: 'UMI · Basket Units Redeemed', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_BASKET_TRANSFERRED: { label: 'UMI · Basket Units Transferred', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_BASKET_DVP_SETTLED: { label: 'UMI · Basket DvP Settled', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  // Asset registry, evidence and private data
  UMI_ASSET_REGISTERED: { label: 'UMI · Asset Registered', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  UMI_CARBON_RETIRED: { label: 'UMI · Carbon Retired', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_DOC_ANCHORED: { label: 'UMI · Document Anchored', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_DOC_STATUS: { label: 'UMI · Document Status', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_PDC_WRITE: { label: 'UMI · Private Data Write', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_PDC_PURGED: { label: 'UMI · Private Data Purged', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_SUPPLY_RESTATED: { label: 'UMI · Supply Restated', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  // Cross-chain interop (hash-locked)
  UMI_CREDENTIAL_ISSUED: { label: 'Credential · Issued', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  UMI_CREDENTIAL_REVOKED: { label: 'Credential · Revoked', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_KEY_REGISTERED: { label: 'Signing Key · Registered', color: '#065F46', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_KEY_REJECTED: { label: 'Signing Key · Refused as Weak', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_KEY_REVOKED: { label: 'Signing Key · Revoked', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_KEY_AUDITED: { label: 'Signing Keys · Re-screened', color: '#1E40AF', bg: '#EFF6FF', border: '#BFDBFE' },
  UMI_FEED_REGISTERED: { label: 'Signed Feed · Registered', color: '#1E3A8A', bg: '#EFF6FF', border: '#BFDBFE' },
  UMI_FEED_PUBLISHED: { label: 'Signed Feed · Reading', color: '#065F46', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_FEED_REJECTED: { label: 'Signed Feed · Refused', color: '#991B1B', bg: '#FEF2F2', border: '#FECACA' },
  UMI_FEED_RETIRED: { label: 'Signed Feed · Retired', color: '#78350F', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_ATTESTATION_WITHDRAWN: { label: 'Attestation · Withdrawn', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_MANDATE_GRANTED: { label: 'Mandate · Granted', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  UMI_MANDATE_USED: { label: 'Mandate · Used', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  UMI_MANDATE_REVOKED: { label: 'Mandate · Revoked', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_INTEROP_LOCKED: { label: 'Interop · Locked', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_INTEROP_COMMITTED: { label: 'Interop · Committed', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_INTEROP_ABORTED: { label: 'Interop · Aborted', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  // Agent passports (pseudonymous actors, principal under threshold escrow)
  AGENT_REGISTERED: { label: 'Agent · Registered', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  AGENT_REVOKED: { label: 'Agent · Revoked', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  AGENT_REVEAL_REQUESTED: { label: 'Agent · Identification Requested', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  AGENT_REVEAL_APPROVED: { label: 'Agent · Custodian Approved', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  AGENT_REVEALED: { label: 'Agent · Principal Identified', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  AGENT_REVEAL_EXPIRED: { label: 'Agent · Request Lapsed', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  // Proof of backing (issuance against an attested figure)
  UMI_CHAIN_ANCHORED: { label: 'Anchored · Public Chain', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_CBDC_ISSUED: { label: 'e₹ Issued', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_CBDC_TRANSFERRED: { label: 'e₹ Transferred', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_CBDC_REDEEMED: { label: 'e₹ Redeemed', color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  UMI_CBDC_GRANTED: { label: 'Purpose-Bound Grant', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  UMI_CBDC_SPENT: { label: 'Grant Spent', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  UMI_CBDC_REFUSED: { label: 'Refused by Rule', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_CBDC_OFFLINE_ISSUED: { label: 'Offline Voucher Issued', color: '#A16207', bg: '#FEFCE8', border: '#FDE68A' },
  UMI_CBDC_OFFLINE_REDEEMED: { label: 'Offline Payment Reconciled', color: '#A16207', bg: '#FEFCE8', border: '#FDE68A' },
  UMI_CBDC_CONDITION_OPENED: { label: 'Conditional Payment Locked', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  UMI_CBDC_CONDITION_RELEASED: { label: 'Condition Met · Paid', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  UMI_CBDC_CONDITION_REFUNDED: { label: 'Condition Lapsed · Refunded', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  UMI_CORRIDOR_INITIATED: { label: 'Cross-Border Initiated', color: '#4338CA', bg: '#EEF2FF', border: '#C7D2FE' },
  UMI_CORRIDOR_SETTLED: { label: 'Cross-Border Settled', color: '#4338CA', bg: '#EEF2FF', border: '#C7D2FE' },
  UMI_CORRIDOR_LOCKED: { label: 'Cross-Ledger Lock', color: '#4338CA', bg: '#EEF2FF', border: '#C7D2FE' },
  UMI_CORRIDOR_CLAIMED: { label: 'Secret Revealed · Claimed', color: '#4338CA', bg: '#EEF2FF', border: '#C7D2FE' },
  UMI_CORRIDOR_REFUNDED: { label: 'Lock Expired · Refunded', color: '#4338CA', bg: '#EEF2FF', border: '#C7D2FE' },
  UMI_CORRIDOR_REFUSED: { label: 'Corridor Refused', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_CBDC_INTEROP_PAID: { label: 'Paid Across Instruments', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  UMI_CBDC_INTEROP_SETTLED: { label: 'Far Scheme Settled', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_CBDC_INTEROP_CONVERTED: { label: 'Deposit Converted', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  UMI_CBDC_INTEROP_REFUSED: { label: 'Interoperability Refused', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_KYC_SUBMITTED: { label: 'KYC Submitted', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_KYC_VERIFIED: { label: 'Identity Verified · Hash Only', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_KYC_REFUSED: { label: 'Verification Refused', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_KYC_EXPIRED: { label: 'Verification Lapsed', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_AGENT_PROPOSED: { label: 'Agent Proposed · Not Performed', color: '#3730A3', bg: '#EEF2FF', border: '#C7D2FE' },
  UMI_AGENT_APPROVED: { label: 'Approved by a Person', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_AGENT_REJECTED: { label: 'Proposal Rejected', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_AGENT_STALE: { label: 'Proposal Stale · Nothing Performed', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_AML_HIT: { label: 'Screening Hit', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_AML_CASE_OPENED: { label: 'AML Case Opened', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_AML_CASE_CLEARED: { label: 'AML Case Cleared', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_AML_REPORT_FILED: { label: 'Suspicious Transaction Report', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_AML_REFUSED: { label: 'Refused · Sanctions Match', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_TOKEN_LINKED: { label: 'Public token · Address registered', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_TOKEN_MIRRORED: { label: 'Public token · Position mirrored', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_TOKEN_REFUSED: { label: 'Public token · Refused', color: '#9F1239', bg: '#FFF1F2', border: '#FECDD3' },
  UMI_OFFER_LISTED: { label: 'Offer · Listed', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_OFFER_TAKEN: { label: 'Offer · Taken', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_OFFER_CANCELLED: { label: 'Offer · Withdrawn', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_CARD_PRESENTED: { label: 'Card · Presented', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_CARD_DISPUTED: { label: 'Card · Charged Back', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_CARD_REPRESENTED: { label: 'Card · Merchant Answered', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  UMI_CARD_ESCALATED: { label: 'Card · Escalated', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_CARD_RESOLVED: { label: 'Card · Dispute Resolved', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_CARD_REFUSED: { label: 'Card · Dispute Refused', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_JURISDICTION_EVALUATED: { label: 'Jurisdiction · Rules Passed', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_JURISDICTION_REFUSED: { label: 'Jurisdiction · Rule Failed', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_CBX_QUOTED: { label: 'Cross-border · Quoted', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  UMI_CBX_REFUSED: { label: 'Cross-border · Refused', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_CBX_PAYMENT_RECORDED: { label: 'Cross-border · Transfer Reported', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  UMI_CBX_OFFRAMPED: { label: 'Cross-border · Remitted in INR', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  UMI_CBX_EXPIRED: { label: 'Cross-border · Quote Lapsed', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  UMI_BACKING_ATTESTED: { label: 'Backing · Attested', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  UMI_BACKING_WITHDRAWN: { label: 'Backing · Withdrawn', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  UMI_ISSUE_BLOCKED: { label: 'Issuance · Refused, Backing Short', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  // Work orders (escrowed engagements)
  WORK_CREATED: { label: 'Work · Created', color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' },
  WORK_FUNDED: { label: 'Work · Escrow Funded', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  WORK_ASSIGNED: { label: 'Work · Assigned', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  WORK_SUBMITTED: { label: 'Work · Submitted', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  WORK_CHECK_RECORDED: { label: 'Work · Check Recorded', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  WORK_VERIFIED: { label: 'Work · Verified', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  WORK_FINALISED: { label: 'Work · Released on Verification', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  WORK_EXPIRED: { label: 'Work · Deadline Passed, Escrow Returned', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  WORK_ACCEPTED: { label: 'Work · Accepted and Paid', color: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },
  WORK_DISPUTED: { label: 'Work · Disputed', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  WORK_CANCELLED: { label: 'Work · Cancelled', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  WORK_REFUNDED: { label: 'Work · Refunded', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  // Administrative
  LEDGER_TRUNCATED: { label: 'Ledger Truncated', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' }
}

// A block whose type this page has not been taught still has to read as what
// it is. Falling back to the GENESIS style labelled every unknown type
// "Genesis", so a 243-block chain with one real genesis block showed dozens of
// them and the explorer misrepresented its own ledger. Show the type the rail
// actually committed instead, tidied for reading.
function styleFor(type) {
  if (TYPE_STYLES[type]) return TYPE_STYLES[type]
  const label = String(type || 'Unknown')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
  return { label, color: '#334155', bg: '#F8FAFC', border: '#E2E8F0' }
}

function shortHash(h) { return h ? `${h.slice(0, 10)}…${h.slice(-8)}` : '' }

function txnSummary(t) {
  if (!t) return ''
  if (t.kind === 'mint') return `${Number(t.totalTokens || 0).toLocaleString('en-IN')} tokens minted → ${t.to} (${t.msp || ''})`
  if (t.kind === 'transfer') return `${Number(t.tokens || 0).toLocaleString('en-IN')} tokens · ${t.from} → ${t.to}${t.atomic ? ` · ${t.atomic}` : ''}`
  if (t.kind === 'escrow-release') return `₹${Number(t.amountINR || 0).toLocaleString('en-IN')} released to seller · ${Number(t.tokens || 0).toLocaleString('en-IN')} tokens · ${t.seller} ⇄ ${t.buyer}`
  if (t.kind === 'umi-dvp') return `${Number(t.tokens || (t.securitiesLeg && t.securitiesLeg.tokens) || 0).toLocaleString('en-IN')} tokens ⇄ ₹${Number(t.cashINR || (t.cashLeg && t.cashLeg.amountINR) || 0).toLocaleString('en-IN')} in e₹-W · ${t.status}${t.failureReason ? ' · ' + t.failureReason : ''}`
  if (t.kind === 'umi-funding') return `₹${Number(t.amountINR || 0).toLocaleString('en-IN')} funded into ${t.walletId} (wholesale CBDC)`
  if (t.kind === 'umi-isin') return `pilot ISIN ${t.isin} assigned to ${prettifyAssetId(t.assetId)} (${t.assetId})`
  if (t.kind === 'umi-servicing') return `₹${Number(t.distributedINR || 0).toLocaleString('en-IN')} servicing paid into ${t.holders} CBDC wallet(s)`
  if (t.kind === 'private-data-write') return `${t.collection} · hash-only proof, value never written to this chain`
  if (t.basketId && t.delivered) return `${t.units} unit(s) issued to ${t.holder} against ${t.delivered.length} delivered holding(s)`
  if (t.basketId && t.returned) return `${t.units} unit(s) redeemed by ${t.holder}; backing returned`
  if (t.basketId && t.components) return `basket ${t.basketId} defined over ${t.components.length} assets · custodian ${t.custodian || ''}`
  if (t.basketId && t.considerationINR != null) return `${t.units} unit(s) ${t.seller} → ${t.buyer} · ₹${Number(t.considerationINR).toLocaleString('en-IN')} in e₹-W`
  if (t.basketId && t.from && t.to) return `${t.units} unit(s) ${t.from} → ${t.to} (no cash leg)`
  if (t.config) return `channel ${t.channel} · ${(t.orgs || []).length} orgs · ${(t.consensus || '').toLowerCase()}`
  return Object.entries(t).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' · ')
}


function PublicAnchor() {
  const [state, setState] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    fetch('/api/umi/anchors?limit=3')
      .then(r => r.json())
      .then(d => alive && setState(d))
      .catch(() => alive && setState({ error: true }))
    return () => { alive = false }
  }, [])

  if (!state || state.error) return null
  const st = state.status || {}
  const latest = (state.anchors || [])[0]
  const live = st.reachable

  return (
    <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 18, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: '#111827' }}>Anchored on a public blockchain</div>
          <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 2, maxWidth: '72ch', lineHeight: 1.6 }}>
            The head of this ledger is published to Solana as a memo carrying the block height, hash and
            transaction root. Nothing else leaves this process. Anyone can open the explorer and check that the
            block here still hashes to the value published then.
          </div>
        </div>
        <span style={{
          fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
          padding: '4px 10px', borderRadius: 999,
          color: live ? '#047857' : '#92400E', background: live ? '#ECFDF5' : '#FFFBEB',
          border: `1px solid ${live ? '#A7F3D0' : '#FDE68A'}`,
        }}>{live ? st.cluster + ' reachable' : 'cluster unreachable'}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 14 }}>
        {[
          ['Network', 'Solana ' + (st.cluster || '')],
          ['Cluster slot', st.clusterSlot ? '#' + st.clusterSlot : 'unavailable'],
          ['Anchors published', String(st.anchors ?? 0)],
          ['Writing', st.writeEnabled ? 'enabled' : 'off'],
        ].map(([k, v]) => (
          <div key={k} style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 700 }}>{k}</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827', marginTop: 3, wordBreak: 'break-all' }}>{v}</div>
          </div>
        ))}
      </div>

      {latest ? (
        <div style={{ marginTop: 12, fontSize: 12.5, color: '#374151', lineHeight: 1.7 }}>
          Block #{latest.height} published at slot {latest.slot || 'pending'} ·{' '}
          <a href={latest.explorer} target="_blank" rel="noreferrer" style={{ color: '#1D4ED8', fontWeight: 600 }}>
            open the transaction
          </a>
        </div>
      ) : (
        <div style={{ marginTop: 12, fontSize: 12, color: '#92400E', background: '#FFFBEB',
          border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 12px', lineHeight: 1.6 }}>
          {st.writeDisabledBecause || 'No anchor has been published from this instance yet.'} Reads and
          verification against the public cluster work regardless.
        </div>
      )}
    </div>
  )
}

export default function LedgerExplorer() {
  const location = useLocation()
  const [chain, setChain] = useState(null)
  const [verify, setVerify] = useState(null)
  const [busy, setBusy] = useState(false)
  const [labMsg, setLabMsg] = useState(null)
  const [highlightTx, setHighlightTx] = useState(null)
  // One chain. The old Node demo chain was in-memory and reset on every
  // restart, so showing it next to the durable rail only invited the question
  // of which one was real. This view is the Go settlement chain: append-only,
  // Postgres-backed, replayed and re-verified from genesis at every start.
  const [umi, setUmi] = useState(null)
  // How far back the rendered list reaches. The page used to fetch a single
  // 60-block window and stop, so a 165-block chain showed only its newest 60
  // and there was no way to tell that from the screen.
  const [oldest, setOldest] = useState(0)
  const [more, setMore] = useState(false)

  const load = useCallback(async () => {
    try {
      const WINDOW = 60
      let d = await api.getUmiChain(WINDOW)
      if (d && d.error) throw new Error(d.message || d.error)
      // Older rail builds answer a cursor-less request with the OLDEST blocks,
      // so once the chain outgrew this window the page showed genesis-era
      // history forever and a just-settled purchase never appeared. Ask again
      // with an explicit cursor at the tip, which both the old and the fixed
      // rail honour. Harmless on the fixed rail: it already returns the tail.
      const total = Number(d.totalBlocks || 0)
      const got = Number(d.returned || (d.blocks || []).length)
      if (total > got) {
        const tail = await api.getUmiChain(WINDOW, Math.max(0, total - WINDOW))
        if (tail && !tail.error && (tail.blocks || []).length) d = tail
      }
      setUmi(d)
      // the Go rail returns its blocks oldest-first; this view is latest-first
      setChain({
        chainId: d.chainId, height: d.height, blocks: d.totalBlocks,
        blocksList: [...(d.blocks || [])].reverse(), contract: 'aasthi.umi-v1'
      })
      setOldest(Number(d.from || 0))
      setVerify({ ...d.verification, blocks: d.totalBlocks })
      setLabMsg(null)
    } catch (e) {
      setUmi(null); setChain(null); setVerify(null)
      setLabMsg({ kind: 'err', text: 'UMI settlement rail (Go) not reachable: ' + e.message })
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Reload when the rail says a block landed, rather than on a timer. The
  // hook falls back to polling by itself where the stream cannot open, so
  // this page stays current either way — and says which of the two it is.
  const { mode: liveMode, lastBlock } = useLedgerStream({
    onBlock: () => { load() },
    pollFn: async () => {
      await load()
      return null
    },
  })
  useEffect(() => {
    const tx = new URLSearchParams(location.search).get('tx')
    if (tx) setHighlightTx(tx)
  }, [location.search])


  // Walk further back through the chain, appending older blocks to the list.
  const loadOlder = useCallback(async (span = 60) => {
    if (oldest <= 0) return
    setMore(true)
    try {
      const from = Math.max(0, oldest - span)
      const d = await api.getUmiChain(oldest - from, from)
      if (d && !d.error && (d.blocks || []).length) {
        setChain(c => ({ ...c, blocksList: [...(c?.blocksList || []), ...[...d.blocks].reverse()] }))
        setOldest(from)
      }
    } finally { setMore(false) }
  }, [oldest])

  // A "view this transfer on the ledger" link is useless if the block it
  // points at is older than the window we happened to load. When we arrive
  // with a highlight and cannot see it yet, pull the rest of the chain in.
  useEffect(() => {
    if (!highlightTx || !chain || oldest <= 0 || more) return
    const found = (chain.blocksList || []).some(b =>
      (b.txns || []).some(t => Object.values(t).includes(highlightTx)))
    if (!found) loadOlder(oldest)
  }, [highlightTx, chain, oldest, more, loadOlder])

  const runVerify = async () => {
    setBusy(true)
    try {
      await load()
      setLabMsg({ kind: 'ok', text: 'Chain replayed from genesis — linkage, merkle roots and hashes recomputed by the settlement rail.' })
    } finally { setBusy(false) }
  }

  const stats = [
    ['Chain', chain?.chainId || 'aasthichain'],
    ['Height', chain ? `#${chain.height}` : ''],
    ['Blocks', chain?.blocks ?? ''],
    ['Hash algo', 'SHA-512'],
    ['Storage', umi?.durability?.durable ? 'Postgres · append-only' : 'in-memory'],
    ['Settlement', 'Atomic DvP · e₹-W'],
  ]


  return (
    <main className="ax ax-wrap" style={{ maxWidth: 980, paddingTop: 26, paddingBottom: 64 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <p className="ax-eyebrow">Permissioned network</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="ax-display ax-h2">Ledger explorer</h1>
            {/* Say which it is. Claiming "live" on a page that is really
                polling is the kind of small lie that costs trust later. */}
            <Badge tone={liveMode === 'live' ? 'success' : 'pending'}>
              {liveMode === 'live' ? 'Live' : liveMode === 'polling' ? 'Refreshing on a timer' : 'Connecting'}
            </Badge>
            {lastBlock && liveMode === 'live' && (
              <span className="ax-hint">
                <Mono>#{lastBlock.height}</Mono> {String(lastBlock.type || '').replace(/_/g, ' ').toLowerCase()}
              </span>
            )}
          </div>
          <p className="ax-lede" style={{ fontSize: 15.5 }}>
            Every settlement is a block, hash-chained to the one before it. Replay the chain yourself:
            no account, no permission, and nothing here asks you to take our word for it.
          </p>
        </div>
        {verify && (
          <div className="ax-card ax-card--pad-sm" style={{ borderColor: verify.valid ? 'rgba(36,107,74,.3)' : 'rgba(161,61,46,.35)' }}>
            <Badge tone={verify.valid ? 'success' : 'error'}>
              {verify.valid ? 'Chain verified' : `Broken at #${verify.brokenAt}`}
            </Badge>
            <p className="ax-hint" style={{ marginTop: 7 }}>
              <Num>{verify.blocks}</Num> blocks recomputed from genesis
            </p>
          </div>
        )}
      </div>


      {/* Banner is shown only when something needs the reader's attention: a
          sealed (tampered) chain, or a non-durable one. The healthy durable
          case says nothing — the Storage stat already states it. */}
      {umi && (umi.durability?.sealed || !umi.durability?.durable || umi.durability?.lastError) && (
        <div style={{
          marginTop: 12, padding: '12px 16px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.6,
          background: umi.durability?.sealed ? '#FEF2F2' : '#FFFBEB',
          border: `1px solid ${umi.durability?.sealed ? '#FECACA' : '#FDE68A'}`,
          color: umi.durability?.sealed ? '#991B1B' : '#92400E'
        }}>
          {umi.durability?.sealed
            ? <><b>Chain sealed.</b> Stored history failed verification at block #{umi.verification?.brokenAt} ({umi.verification?.reason}). The node refuses to append to tampered history and is serving it read-only.</>
            : !umi.durability?.durable
              ? <><b>In-memory ledger.</b> No <code>DATABASE_URL</code> is configured, so these blocks are lost when the service restarts. Set it to make the chain permanent.</>
              : null}
          {umi.durability?.lastError && <div style={{ marginTop: umi.durability?.sealed || !umi.durability?.durable ? 6 : 0 }}><b>Last persistence error:</b> {umi.durability.lastError}</div>}
        </div>
      )}

      {/* Stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 18 }}>
        {stats.map(([k, v]) => (
          <div key={k} className="ax-card ax-card--pad-sm">
            <div className="ax-metric-label">{k}</div>
            <div className="ax-metric-value" style={{ fontSize: 15, marginTop: 5, wordBreak: 'break-all' }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Public anchor: the one part of this page that is not ours to control.
          The chain above can be replayed, which proves it is consistent with
          itself. Only a record on a public network proves it was not rebuilt
          last night, so the state of that record is shown here plainly,
          including when nothing has been published yet. */}
      <PublicAnchor />

      {/* Integrity lab */}
      <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 18, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#111827' }}>Integrity Lab</div>
            <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 2 }}>Recompute every block from genesis — linkage, merkle roots and hashes. Tampering with stored blocks is detected here and the rail then refuses to append.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={runVerify} disabled={busy} style={{ padding: '9px 14px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Verify chain</button>
          </div>
        </div>
        {labMsg && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all',
            background: labMsg.kind === 'err' ? '#FEF2F2' : labMsg.kind === 'warn' ? '#FFFBEB' : '#F0FDF4',
            border: `1px solid ${labMsg.kind === 'err' ? '#FECACA' : labMsg.kind === 'warn' ? '#FDE68A' : '#BBF7D0'}`,
            color: labMsg.kind === 'err' ? '#991B1B' : labMsg.kind === 'warn' ? '#92400E' : '#065F46'
          }}>
            {verify && !verify.valid && labMsg.kind === 'warn' ? `✗ Chain INVALID at block #${verify.brokenAt} ${verify.reason} · ${verify.note}` : labMsg.text}
          </div>
        )}
      </div>

      {/* Programmable finance + open layer */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 16 }}>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Programmable finance on-chain</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.6 }}>
            Contract <b>aasthi.umi-dvp-v1</b>: delivery-versus-payment as code — the securities leg and the e₹-W cash leg commit inside a single block, or neither moves. A failed settlement is recorded too, as <b>UMI · DvP Failed</b>, with both legs rolled back.
          </div>
          {chain && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {['UMI_DVP_SETTLED', 'UMI_DVP_FAILED', 'UMI_SERVICING_PAID', 'UMI_ISIN_ASSIGNED'].map(t => (
                <span key={t} style={{ fontSize: 10.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999, color: TYPE_STYLES[t].color, background: TYPE_STYLES[t].bg, border: `1px solid ${TYPE_STYLES[t].border}` }}>
                  {(chain.blocksList || []).filter(b => b.type === t).length} × {TYPE_STYLES[t].label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Open by design</div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.6 }}>
            The ledger is a <b>public notice-board, not a private database</b>. Auditors, government stacks, apps or anyone
            can read the same ownership truth at the same moment, with no special access and no personal data on the chain.
            Trust comes from the math, not from taking our word for it.
          </div>
        </div>
      </div>

      {/* Blocks */}
      <div style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Committed blocks <span style={{ color: '#9CA3AF', fontWeight: 500 }}>(latest first)</span></div>
          <div style={{ fontSize: 12, color: '#6B7280' }}>
            showing {(chain?.blocksList || []).length} of {chain?.blocks ?? 0}
            {oldest > 0 ? ` · ${oldest} older block${oldest === 1 ? '' : 's'} not loaded` : ' · whole chain'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(chain?.blocksList || []).map(b => {
            const st = styleFor(b.type)
            const txHit = highlightTx && (b.txns || []).some(t => Object.values(t).includes(highlightTx))
            return (
              <div key={b.height} style={{
                background: txHit ? '#EFF6FF' : 'white', border: `1px solid ${txHit ? '#93C5FD' : '#E5E7EB'}`, borderRadius: 10, padding: '12px 14px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Mono title={`Block height ${b.height}`}><strong>#{b.height}</strong></Mono>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999, color: st.color, background: st.bg, border: `1px solid ${st.border}` }}>{st.label}</span>
                    <span className="ax-hint">{new Date(b.timestamp).toLocaleString('en-IN')}</span>
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Mono title={b.hash}>{shortHash(b.hash)}</Mono>
                    <CopyButton value={b.hash} label="Copy block hash" />
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: '#374151', marginTop: 6 }}>
                  {(b.txns || []).map((t, i) => <div key={i}>{txnSummary(t)}</div>)}
                </div>
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 5, fontFamily: 'monospace' }}>
                  prev: {shortHash(b.prevHash)} · root: {shortHash(b.txnsRoot)}{b.contract ? ` · ${b.contract}` : ''}
                </div>
              </div>
            )
          })}
        </div>
        {oldest > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <button onClick={() => loadOlder(60)} disabled={more}
              style={{ padding: '9px 16px', borderRadius: 9, border: '1px solid #D1D5DB', background: 'white', fontSize: 13, fontWeight: 600, cursor: more ? 'wait' : 'pointer', color: '#111827' }}>
              {more ? 'Loading…' : `Load 60 older blocks`}
            </button>
            <button onClick={() => loadOlder(oldest)} disabled={more}
              style={{ padding: '9px 16px', borderRadius: 9, border: '1px solid #D1D5DB', background: 'white', fontSize: 13, fontWeight: 600, cursor: more ? 'wait' : 'pointer', color: '#374151' }}>
              Load all {oldest} remaining
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
