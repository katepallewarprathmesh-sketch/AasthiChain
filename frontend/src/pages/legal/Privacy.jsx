import React from 'react'
import { Link } from 'react-router-dom'
import LegalShell, { H2, P, UL, SimulationNotice } from './LegalShell'
import { C, card } from '../tools/ToolShell'

export default function Privacy() {
  return (
    <LegalShell
      title="Privacy"
      subtitle="What this site collects, what it does not, and why. Short version: no third-party trackers, no advertising, and your IP address is never stored."
    >
      <div style={{ ...card, background: '#F0F7F2', borderColor: '#BFE0CC', marginTop: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0F5B30', margin: '0 0 8px' }}>In one paragraph</h2>
        <p style={{ fontSize: 14.5, color: '#14492C', lineHeight: 1.7, margin: 0 }}>
          There is no Google Analytics, no Meta pixel, no advertising network and no
          third-party script of any kind. Page views are counted by first-party code on
          this site. Your IP address is never written down — not stored, not hashed, not
          truncated. If your browser sends Do Not Track or Global Privacy Control, nothing
          is recorded at all.
        </p>
      </div>

      <H2>What is collected</H2>
      <P>
        When you view a page, the site records the path you visited, where you arrived
        from, and a visitor identifier, so that totals like “how many people read the
        ledger explainer this week” can be produced.
      </P>
      <UL>
        <li><strong>Page path</strong> — for example <code>/tools/rental-yield-calculator</code>.</li>
        <li><strong>Referrer</strong> — reduced to its source, such as “google” or “github”, never the full URL.</li>
        <li><strong>A visitor id</strong> — a random value generated in your browser and kept in <code>sessionStorage</code>, so it disappears when you close the tab.</li>
      </UL>
      <P>
        Before that visitor id is stored on the server it is hashed together with a secret
        and the calendar date. Because the date is part of the hash, the value changes
        every midnight: the same person on two different days cannot be recognised as the
        same person. Events are aggregated into daily counters as they arrive, so the
        database holds counts, not a log of individual visits.
      </P>

      <H2>What is never collected</H2>
      <UL>
        <li><strong>Your IP address.</strong> Never stored in any form.</li>
        <li><strong>Cross-site tracking.</strong> No third-party cookies, pixels or scripts.</li>
        <li><strong>A profile of you.</strong> Nothing is sold, shared or used for advertising.</li>
        <li><strong>Real financial data.</strong> There is none to collect — see below.</li>
      </UL>

      <H2>Do Not Track and Global Privacy Control</H2>
      <P>
        Both are honoured. If your browser sends either signal, the tracking code exits
        before sending anything. This is not a preference buried in a settings page; it is
        a condition at the top of the function.
      </P>

      <H2>If you sign in</H2>
      <P>
        Signing in is optional — you can browse the marketplace, read every property page
        and use the calculators without an account. If you do sign in, a session token and
        your chosen demo role are kept in your browser's local storage so you stay signed
        in between visits. Clearing your browser data removes them. Authentication may be
        handled by <a href="https://clerk.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: C.navy }}>Clerk</a>,
        a third-party identity provider, in which case their privacy policy also applies
        to the credentials you give them.
      </P>

      <H2>Demo accounts are shared and public</H2>
      <P>
        The demo identities (Investor 1, Property Owner, Registrar and so on) are shared
        by everyone using the site. Anything you do with them — a purchase, a transfer, a
        settlement — is visible to every other visitor and is written to a ledger that is
        designed never to be erased. Do not type anything into this site that you would
        not publish.
      </P>

      <H2>The calculators</H2>
      <P>
        The <Link to="/tools" style={{ color: C.navy, fontWeight: 600 }}>free calculators</Link>{' '}
        run entirely in your browser. The figures you enter are never transmitted anywhere
        and never leave your device.
      </P>

      <H2>Cookies</H2>
      <P>
        No advertising or analytics cookies are set. If you sign in, a session value is
        stored in your browser so the site can remember you. That is all.
      </P>

      <H2>Your choices</H2>
      <UL>
        <li>Enable Do Not Track or Global Privacy Control to be excluded from counting entirely.</li>
        <li>Clear your browser storage to remove the session id and any sign-in state.</li>
        <li>Browse without signing in — nothing requires an account except making a simulated investment.</li>
      </UL>

      <H2>Contact</H2>
      <P>
        Questions about this policy, or a request to remove something, can be raised as an
        issue on{' '}
        <a href="https://github.com/katepallewarprathmesh-sketch/AasthiChain" target="_blank" rel="noopener noreferrer" style={{ color: C.navy, fontWeight: 600 }}>
          the project's GitHub repository
        </a>. The analytics code is in that repository and can be read and verified rather
        than taken on trust.
      </P>

      <SimulationNotice />
    </LegalShell>
  )
}
