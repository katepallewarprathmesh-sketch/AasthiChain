import React, { useEffect, useState, useCallback } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch, umiPost, explainRail } from '../lib/umiFetch.js'
import { colour } from '../lib/tokens.js'

/**
 * Agents: what is running, what it may do, and how to stop it.
 *
 * THE RULE THIS SCREEN FOLLOWS
 * Everything here is the rail's record of the agent, never the agent's
 * account of itself. The harness in agent/ keeps a local run log, and that
 * log is the agent marking its own homework: a compromised or buggy agent
 * writes a flattering one. So this page reads the register, the mandate book
 * and the spend recorded against each grant, which an agent cannot edit.
 *
 * If the two ever disagree, the rail is right and the agent is the story.
 *
 * WHY THE STOP BUTTON IS THE POINT OF THE PAGE
 * Until recently a principal could not revoke their own agent: revocation
 * needed a supervisor or a completed custodian ceremony, so the party with
 * the most exposure and the fastest reason to act was the one party who
 * could not pull the handle. That was a declared gap and it stopped being
 * theoretical the moment a real agent ran. The register now recognises a
 * principal by a salted digest without being able to say who they are, so
 * the button below works for the person it should always have worked for.
 */

const paise = (n) => {
  const v = Number(n || 0) / 100
  return 'Rs ' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const toneFor = (status) => {
  if (status === 'ACTIVE') return 'live'
  if (status === 'REVOKED') return 'bad'
  return 'sim'
}

export default function Agents({ user }) {
  const [agents, setAgents] = useState([])
  const [mandates, setMandates] = useState([])
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState('')
  const [grantsVisible, setGrantsVisible] = useState(true)
  const [msg, setMsg] = useState(null)

  const load = useCallback(async () => {
    const [a, m] = await Promise.all([
      umiFetch('/agents?limit=50'),
      umiFetch('/mandates?limit=100'),
    ])
    if (a.ok) setAgents((a.data && a.data.agents) || [])
    else setErr(explainRail(a.data))
    // The register is public; the grants are not. A signed-out visitor sees
    // which agents exist and gets told plainly that the authorities are
    // withheld, rather than being shown an agent with no mandates beside it
    // and left to conclude it can do nothing.
    if (m.ok) { setMandates((m.data && m.data.mandates) || []); setGrantsVisible(true) }
    else setGrantsVisible(false)
  }, [])

  useEffect(() => { load() }, [load])

  const stop = async (agentId) => {
    setBusy(agentId); setMsg(null)
    const r = await umiPost(`/agents/${encodeURIComponent(agentId)}/revoke`, {})
    setBusy('')
    if (r.ok) {
      setMsg(`${agentId} may no longer act. Every mandate it holds is inert from the next request.`)
      load()
    } else {
      setMsg(explainRail(r.data))
    }
  }

  const grantsFor = (agentId) => mandates.filter(m => m.agent === agentId)
  const active = agents.filter(a => a.status === 'ACTIVE').length

  return (
    <PageShell
      eyebrow="Automated actors"
      title="Agents, and how to stop one"
      lede={
        'Every automated actor on this rail holds a pseudonymous passport and acts under a mandate ' +
        'its principal granted: a short list of actions, a rupee ceiling and an expiry. Everything below ' +
        'is the rail\u2019s record of what each agent did, not the agent\u2019s own account of itself.'
      }
      badge={<Tag tone={active ? 'live' : 'neutral'}>{active} active</Tag>}
    >
      {err && <Card><p style={{ margin: 0, fontSize: 13, color: colour.bad }}>{err}</p></Card>}
      {msg && <Card><p style={{ margin: 0, fontSize: 13, color: colour.ink }}>{msg}</p></Card>}

      <Card title="How to run one" sub="Nothing starts an agent automatically, and no deployment runs one.">
        <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.7, color: '#374151' }}>
          A working harness ships in the repository. It registers a passport, takes a mandate from a named
          principal, and then releases conditional settlements whose credential has been issued and not
          revoked. It talks to this rail over the ordinary HTTP surface with no privileges any other caller
          lacks, which is the only way its limits prove anything. Python, standard library only, so
          there is nothing to install before running it.
        </p>
        <pre className="pg-mono" style={{
          margin: 0, fontSize: 12, lineHeight: 1.7, color: '#374151', background: '#F9FAFB',
          border: '1px solid ' + colour.line, borderRadius: 8, padding: '10px 12px', overflowX: 'auto',
        }}>{`python3 agent/run.py setup --principal investor1 --limit 5000
python3 agent/run.py watch --every 15
python3 agent/run.py stop`}</pre>
      </Card>

      {agents.length === 0 && (
        <Card>
          <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>
            No agent is registered on this rail.
          </p>
        </Card>
      )}

      {agents.map(a => {
        const grants = grantsFor(a.agentId)
        const spent = grants.reduce((n, m) => n + Number(m.spentPaise || 0), 0)
        const limit = grants.reduce((n, m) => n + Number(m.limitPaise || 0), 0)
        const uses = grants.reduce((n, m) => n + Number(m.uses || 0), 0)
        const mine = grants.some(m => user && m.principal === user.identityId)

        return (
          <Card
            key={a.agentId}
            title={trimStop(a.purpose)}
            sub={a.agentId}
            right={<Tag tone={toneFor(a.status)}>{a.status}</Tag>}
          >
            <div style={{
              display: grantsVisible ? 'grid' : 'none',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))',
              gap: 10, marginBottom: 12,
            }}>
              <Figure label="Spent under mandate" value={paise(spent)} />
              <Figure label="Ceiling" value={paise(limit)} />
              <Figure label="Headroom" value={paise(limit - spent)} />
              <Figure label="Acts recorded" value={String(uses)} />
            </div>

            {!grantsVisible ? (
              <p style={{ margin: 0, fontSize: 12.5, color: '#6B7280', lineHeight: 1.6 }}>
                Sign in to see what this agent was authorised to do. A mandate names a participant&rsquo;s own
                arrangement, so the rail will not show it to an unnamed caller.
              </p>
            ) : grants.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12.5, color: '#6B7280', lineHeight: 1.6 }}>
                No mandate names this agent, so it can do nothing. A passport is an identity, not an authority.
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {grants.map(m => (
                  <div key={m.mandateId} style={{
                    border: '1px solid ' + colour.line, borderRadius: 9, padding: '9px 11px',
                  }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
                      <span className="pg-mono" style={{ fontSize: 11.5, color: '#6B7280', overflowWrap: 'anywhere' }}>{m.mandateId}</span>
                      <Tag tone={m.revoked ? 'bad' : 'live'}>{m.revoked ? 'revoked' : 'in force'}</Tag>
                    </div>
                    <div style={{ fontSize: 12.5, color: '#374151', marginTop: 5, lineHeight: 1.6 }}>
                      {m.principal} granted {(m.actions || []).join(', ')} up to {paise(m.limitPaise)}
                      {m.assets && m.assets.length ? ` on ${m.assets.join(', ')}` : ', on any asset'}, expiring {when(m.expiresAt)}.
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                className="pg-btn"
                disabled={a.status === 'REVOKED' || busy === a.agentId || !grantsVisible}
                onClick={() => stop(a.agentId)}
              >
                {busy === a.agentId ? 'Stopping' : 'Stop this agent'}
              </button>
              <span style={{ fontSize: 11.5, color: '#6B7280', lineHeight: 1.6, minWidth: 'min(100%, 260px)', flex: 1 }}>
                {a.status === 'REVOKED'
                  ? 'Already stopped. What it did before remains attributable; revocation is about the future.'
                  : !grantsVisible
                    ? 'Sign in to stop an agent. The rail will only accept this from its principal or a supervisor.'
                    : mine
                    ? 'You granted a mandate to this agent, so you can stop it. One act makes every grant it holds inert.'
                    : 'Only this agent\u2019s principal or a supervisor can stop it.'}
              </span>
            </div>
          </Card>
        )
      })}

      <Card title="What this layer does not do" sub="Stated here rather than discovered later.">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.75, color: '#6B7280' }}>
          <li>The pseudonym is re-identifiable. A threshold of named custodians can open it, and every approval is written to the chain.</li>
          <li>The custody is not distributed: the shares are real arithmetic but one process holds all of them.</li>
          <li>Revoking an agent stops it acting. It reverses nothing the agent already did, and nothing here can.</li>
          <li>An agent with no mandate still has a passport. The register is an identity, never a permission.</li>
        </ul>
      </Card>
    </PageShell>
  )
}

// An ISO timestamp is the right thing on the wire and the wrong thing in a
// sentence somebody reads. The date is what matters for an expiry.
function when(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso || 'an unstated date')
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// A purpose is free text typed at setup and it lands in a heading here, so
// it should not drag somebody's full stop into the title.
function trimStop(text) {
  const t = String(text || 'An agent').trim()
  return t.endsWith('.') ? t.slice(0, -1) : t
}

function Figure({ label, value }) {
  return (
    <div style={{ border: '1px solid ' + colour.line, borderRadius: 9, padding: '8px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 650, color: colour.ink, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  )
}
