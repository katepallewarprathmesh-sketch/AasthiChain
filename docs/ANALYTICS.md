# Analytics: what is measured, and what cannot be

This deployment measures its own audience with first-party code only. There is
no Google Analytics, no Plausible, no pixel and no third-party script of any
kind. The browser posts a small beacon to `/api/track` and that is the whole
data path.

Everything below is readable on the private dashboard at `/admin/insights`,
which needs the operator key or a signed-in regulator session.

## What you can see

**Who is on the site right now.** A count of browsers that have loaded a page
in the last five minutes, and which pages they are on. It refreshes with the
dashboard.

**Lifetime totals.** Pageviews since measurement began, the first day
recorded, the number of days with any activity, the busiest day, and the full
per-day series. Top pages and referrers are ranked over the whole period, not
just the recent window.

**The last fortnight**, separately, as a chart. This is the older view and it
stays because a trend is easier to read over two weeks than over months.

**Every account that has signed in.** For each one: the account key from the
identity provider, email, the identity and role they acted as, when they were
first seen, when they were last seen, how many distinct days they have been
active, and how many authenticated requests they have made.

## What you cannot see, and why

These are not gaps waiting to be filled. They are consequences of decisions
already made and published on the privacy page, and closing any of them would
make that page untrue.

**Anonymous visitors cannot be named.** No IP address is stored: not in full,
not truncated, not hashed. No cookie is set. The visitor identifier lives in
`sessionStorage`, dies when the tab closes, and is hashed with a server secret
plus the calendar date before it is written. Yesterday's token and today's
token for the same person do not match.

**There is no per-visit history.** Events are aggregated as they arrive into
day, path and referrer counters. No event log exists, so a page-by-page
journey for one person cannot be produced, by anyone, including whoever runs
the server.

**"Unique visitors" is not a count of people.** It is the count of distinct
daily tokens. One person visiting on ten days counts ten times. The dashboard
labels this `visitor-days` in the lifetime view for exactly that reason. There
is no transformation that recovers a true person count from this data, because
the information was never collected.

**Visitors who opt out are absent entirely.** Do Not Track and Global Privacy
Control are honoured in the browser, so those visits are never sent.

**The account register begins the day it was deployed.** Sign-ins completed
before that were never written to this database. They are not lost in the
sense of being deleted; they were never recorded. The identity provider holds
the authoritative account list and its own sign-in log, and that console is
the place to audit anything earlier.

## If you need more than this

Two things would materially change the picture, and both are decisions rather
than tasks:

1. **A per-visit event log with stable visitor ids.** This makes funnels,
   return-visit analysis and per-person journeys possible. It also means
   building a record that can be subpoenaed, leaked or joined against other
   data, and the privacy page would have to be rewritten to say so.
2. **Storing IP addresses**, which adds rough geography and bot filtering. In
   India the IP of an identified person is personal data under the DPDP Act,
   so this brings notice, purpose limitation and retention obligations with
   it.

Neither is implemented. Neither should be switched on quietly.

## Where the code is

| Concern | File |
| --- | --- |
| Browser beacon, opt-out | `frontend/src/lib/track.js` |
| Collection, aggregation, presence, account register | `frontend/api/lib/traffic.mjs` |
| Dashboard report assembly | `frontend/api/index.js`, `frontend/api/lib/insights.mjs` |
| Dashboard UI | `frontend/src/pages/Insights.jsx` |
| Checks | `tests/audience.test.mjs` |

Storage is Postgres when `DATABASE_URL` is set, otherwise a temp file that
resets on a cold start. The dashboard states which mode is live, so a
deployment is never quietly losing counts.
