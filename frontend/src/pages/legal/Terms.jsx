import React from 'react'
import { Link } from 'react-router-dom'
import LegalShell, { H2, P, UL } from './LegalShell'
import { C } from '../tools/ToolShell'

export default function Terms() {
  return (
    <LegalShell
      title="Terms of Use"
      subtitle="The conditions for using this site. The most important one: nothing here is real, and nothing here is investment advice."
    >

      <H2>1. What this site is</H2>
      <P>
        AasthiChain is an open-source demonstration of settlement technology: how a
        tokenised property interest could be transferred against a digital rupee payment
        so that both sides move together or neither does. It exists to show how the
        mechanism works and to be read as source code.
      </P>

      <H2>2. Nothing here is an investment</H2>
      <UL>
        <li>No real property is listed, owned, sold or transferred.</li>
        <li>No real money is accepted. Every rupee figure is simulated.</li>
        <li>No securities are issued, and no tokens have any value, inside or outside this site.</li>
        <li>Nothing on this site is an offer, a solicitation, a prospectus or investment advice.</li>
        <li>The site is not registered with, authorised by, or connected to the Reserve Bank of India, SEBI, any depository, stock exchange, bank, or the NPCI.</li>
      </UL>
      <P>
        Where the interface refers to UPI, e₹-W, wholesale CBDC, Demat 2.0 or the Unified
        Market Interface, it is reproducing the <em>pattern</em> of those systems for
        demonstration. No connection to any of them exists.
      </P>

      <H2>3. Accuracy of the calculators</H2>
      <P>
        The <Link to="/tools" style={{ color: C.navy, fontWeight: 600 }}>calculators</Link>{' '}
        are provided for education and rough estimation. They apply standard formulas to
        the assumptions you enter, and the output is only as good as those assumptions.
        Yields, appreciation rates, taxes, fees and costs vary by property, city and over
        time. Do not make a financial decision based on these figures alone; speak to a
        qualified financial or tax adviser.
      </P>

      <H2>4. Demo accounts</H2>
      <P>
        Demo identities are shared by all visitors. Anything you do with them is public
        and may be visible, changed or built upon by anyone else. Data may be reset
        without notice. Ledger blocks, by design, are not erased. Do not enter personal,
        confidential or sensitive information anywhere on this site.
      </P>

      <H2>5. Acceptable use</H2>
      <UL>
        <li>Do not attempt to disrupt, overload or break into the service or its infrastructure.</li>
        <li>Do not present the site, its screens or its output as a real financial product or as evidence of real ownership.</li>
        <li>Do not use it to mislead anyone into believing they are investing money.</li>
      </UL>
      <P>
        Studying it, running it, forking it and writing about it are all encouraged.
      </P>

      <H2>6. Availability</H2>
      <P>
        This is a personal project running on free hosting tiers. It may be slow, offline,
        reset or withdrawn at any time, without notice. There is no uptime commitment and
        no support obligation.
      </P>

      <H2>7. Open source and licence</H2>
      <P>
        The source is published on{' '}
        <a href="https://github.com/katepallewarprathmesh-sketch/AasthiChain" target="_blank" rel="noopener noreferrer" style={{ color: C.navy, fontWeight: 600 }}>
          GitHub
        </a>{' '}
        and is governed by the licence in that repository. These terms cover your use of
        the hosted site; the licence covers your use of the code.
      </P>

      <H2>8. No warranty and no liability</H2>
      <P>
        The site is provided “as is”, without warranty of any kind, express or implied,
        including fitness for a particular purpose and accuracy. To the fullest extent
        permitted by law, the author is not liable for any loss or damage arising from
        your use of the site or reliance on anything it displays — including any decision
        taken on the basis of a calculator result.
      </P>

      <H2>9. Changes</H2>
      <P>
        These terms may be updated as the project changes. The revision date is shown at
        the top of this page, and the full history of changes is visible in the
        repository's commit log.
      </P>

      <H2>10. Governing law</H2>
      <P>
        These terms are governed by the laws of India, and the courts of Maharashtra have
        jurisdiction over any dispute arising from them.
      </P>

      <H2>Contact</H2>
      <P>
        Raise an issue on{' '}
        <a href="https://github.com/katepallewarprathmesh-sketch/AasthiChain/issues" target="_blank" rel="noopener noreferrer" style={{ color: C.navy, fontWeight: 600 }}>
          GitHub
        </a>.
      </P>
    </LegalShell>
  )
}
