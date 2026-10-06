// Render smoke test.
//
// `vite build` happily bundles a reference to an identifier that does not
// exist — it only fails at runtime, in the user's browser. That is exactly how
// `tabBtn is not defined` reached production on the Ledger Explorer.
//
// This renders every route server-side. Any ReferenceError, bad import or
// crash-on-first-render fails the build instead of the user's page. Effects do
// not run under renderToString, so this catches render-time faults, not data
// fetching — which is the class of bug that produces a blank screen.

import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import Landing from '../src/pages/Landing.jsx'
import Login from '../src/pages/Login.jsx'
import Marketplace from '../src/pages/Marketplace.jsx'
import Wallet from '../src/pages/Wallet.jsx'
import LedgerExplorer from '../src/pages/LedgerExplorer.jsx'
import InvestorDashboard from '../src/pages/InvestorDashboard.jsx'
import Insights from '../src/pages/Insights.jsx'
import UMISettlement from '../src/pages/UMISettlement.jsx'
import Support from '../src/pages/Support.jsx'
import Admin from '../src/pages/Admin.jsx'
import Regulator from '../src/pages/Regulator.jsx'
import PropertyDetail from '../src/pages/PropertyDetail.jsx'
import ToolsIndex from '../src/pages/tools/ToolsIndex.jsx'
import RentalYieldCalculator from '../src/pages/tools/RentalYieldCalculator.jsx'
import FractionalCalculator from '../src/pages/tools/FractionalCalculator.jsx'
import StampDutyCalculator from '../src/pages/tools/StampDutyCalculator.jsx'
import EmiCalculator from '../src/pages/tools/EmiCalculator.jsx'
import RentVsBuyCalculator from '../src/pages/tools/RentVsBuyCalculator.jsx'
import CapitalGainsCalculator from '../src/pages/tools/CapitalGainsCalculator.jsx'
import About from '../src/pages/legal/About.jsx'
import Privacy from '../src/pages/legal/Privacy.jsx'
import Terms from '../src/pages/legal/Terms.jsx'
import LearnIndex from '../src/pages/learn/LearnIndex.jsx'
import Demat2 from '../src/pages/learn/Demat2.jsx'
import AtomicDvP from '../src/pages/learn/AtomicDvP.jsx'
import UMIExplainer from '../src/pages/learn/UMI.jsx'

const user = { identityId: 'investor1', role: 'Investor', name: 'Demo Investor' }

const ROUTES = [
  ['/', <Landing user={user} />],
  ['/login', <Login onLogin={() => {}} />],
  ['/marketplace', <Marketplace user={user} />],
  ['/wallet', <Wallet user={user} />],
  ['/dashboard', <InvestorDashboard user={user} />],
  ['/insights', <Insights />],
  ['/ledger', <LedgerExplorer />],
  ['/umi', <UMISettlement />],
  ['/support', <Support />],
  ['/admin', <Admin user={user} />],
  ['/regulator', <Regulator user={user} />],
  ['/property/PROP-GREEN-VALLEY-PUNE-001', <PropertyDetail user={user} />],
  ['/tools', <ToolsIndex />],
  ['/tools/rental-yield-calculator', <RentalYieldCalculator />],
  ['/tools/fractional-investment-calculator', <FractionalCalculator />],
  ['/tools/stamp-duty-calculator', <StampDutyCalculator />],
  ['/tools/home-loan-emi-calculator', <EmiCalculator />],
  ['/tools/rent-vs-buy-calculator', <RentVsBuyCalculator />],
  ['/tools/capital-gains-tax-calculator', <CapitalGainsCalculator />],
  ['/about', <About />],
  ['/privacy', <Privacy />],
  ['/terms', <Terms />],
  ['/learn', <LearnIndex />],
  ['/learn/what-is-demat-2', <Demat2 />],
  ['/learn/what-is-atomic-dvp', <AtomicDvP />],
  ['/learn/what-is-umi', <UMIExplainer />]
]

// A page that renders nothing is not a passing page. /insights shipped with
// `export default` stuck on the wrong function, so the route rendered an
// unrelated component that returned null — a blank screen that this smoke test
// called "clean". Every route must put something real on the page.
const MIN_HTML = 200

let failed = 0
for (const [path, element] of ROUTES) {
  try {
    const html = renderToString(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>)
    if (html.trim().length < MIN_HTML) {
      failed++
      console.error(`  FAIL ${path} — rendered only ${html.trim().length} chars; the page is effectively blank`)
      continue
    }
    console.log(`  ok   ${path}`)
  } catch (e) {
    failed++
    console.error(`  FAIL ${path} — ${e.message}`)
  }
}

console.log(failed === 0
  ? `\nrender smoke: ${ROUTES.length} routes rendered real content`
  : `\nrender smoke: ${failed}/${ROUTES.length} routes are broken or blank`)
process.exit(failed === 0 ? 0 : 1)
