# AasthiChain growth plan

Applying Kartik Labhshetwar's [organic growth playbook](https://kartiklabhshetwar.com/blog/organic-growth-playbook)
(Screenshot Studio: 5–7k → 28.8k monthly visitors, no ads) to AasthiChain.

The playbook has four parts: nail the basics, do keyword research, get indexed
on Bing so chatbots can cite you, and ship free tools in your niche.

**Status: part 1 and part 3's prerequisites are built and shipped (`ca44eb8`).
Parts 2 and 4 are plans in this document — they need content, not code.**

---

## The finding that matters most

> **Only 4 of 12 pages are indexable, and the marketplace is not one of them.**

`/marketplace`, `/dashboard`, `/wallet`, `/property/:id`, `/admin` and
`/regulator` all sit behind `effectiveUser ? … : <Navigate to="/login" />`.
A crawler is redirected to the login page, so none of that content exists as
far as search is concerned. The sitemap can honestly list only `/`, `/ledger`,
`/umi` and `/support`.

This is the single biggest growth constraint in the product. Every property
page is a natural landing page for a real search — *"fractional investment
Koregaon Park Pune"*, *"commercial property investment ₹500"* — and right now
they are all invisible.

**Recommendation: make `/marketplace` and `/property/:id` publicly readable,
and require login only to invest.** Nine properties become nine indexable
pages immediately, each with its own keyword surface. The data is demo data;
there is nothing confidential to protect. This is a product decision, so I
have not made it unilaterally — but nothing else in this document matters as
much.

---

## Part 1 — The basics ✅ shipped

| Checklist item | Before | Now |
|---|---|---|
| Unique title per page | ✗ all 12 shared one | ✅ `src/lib/seo.js` |
| Meta description per page | ✗ | ✅ per route |
| Canonical URL | ✗ | ✅ per route |
| Sitemap | ✗ | ✅ generated at build |
| `robots.txt` | ✗ | ✅ + AI crawlers allowed |
| `noindex` on private pages | ✗ | ✅ dashboard, wallet, admin, regulator, insights, login |
| Open Graph / Twitter card | ✗ | ✅ |
| Structured data | ✗ | ✅ `WebApplication` JSON-LD |
| `llms.txt` | ✗ | ✅ |
| One H1 per page | partial | ⚠️ audit pending |
| Image alt text | partial | ⚠️ audit pending |
| Trust pages (about/privacy/terms) | ✗ | ❌ **to do** |

Two notes on implementation choices:

- **No `react-helmet`.** A ~50-line module does the job with no dependency,
  no version risk and no extra bytes in the bundle.
- **`noindex` instead of `Disallow`.** A page blocked in `robots.txt` can
  still be indexed from an external link, because the crawler is never
  allowed in to read the `noindex` tag. Let it crawl, then tell it not to
  index. The playbook calls this out and it is a common mistake.

### Remaining in part 1

1. **Trust pages** — About, Privacy, Terms. The playbook notes people *and AI
   agents* check these before trusting a site. For a finance-adjacent product
   they also carry the "this is a simulation, no real money" disclaimer.
2. **H1 and alt-text audit** across the four public pages.
3. **PageSpeed Insights** on mobile once deployed.
4. **Google Search Console + Bing Webmaster Tools** — verify the domain,
   submit the sitemap. Needs your account; cannot be automated from here.

---

## Part 2 — Keyword research 📋 planned

AasthiChain sits on two keyword families that behave very differently.

**A. Investor intent** — high volume, high competition, dominated by
Strata, hBits, PropertyShare and Assetmonk. Hard to win, and the product is a
demo rather than a real investment, so this traffic would arrive expecting
something AasthiChain does not offer.

- fractional ownership real estate india · invest in commercial property
  with small amount · tokenised real estate india · REIT vs fractional
  ownership · SM REIT

**B. Builder / fintech-curious intent** — lower volume, far less
competition, and a much better fit for what this actually is. Almost nobody
has written clear explanatory content on these, and they are exactly the
questions people now ask chatbots.

- **what is demat 2.0** · **RBI unified market interface explained** ·
  **atomic DvP settlement** · **e₹-W wholesale CBDC** · delivery versus
  payment blockchain · tokenised bonds india · SEBI sandbox tokenisation ·
  how does settlement risk work

**Strategy: win family B, borrow family A.** Rank for the explanatory terms,
where a working demo is a genuinely unique asset — nobody else explaining
Demat 2.0 has a button that *runs* an atomic DvP and shows both legs roll
back on failure. Let family A arrive through the property pages once they are
public.

Next step: run family B through Ahrefs' free keyword generator or
[OpenSEO](https://github.com/every-app/open-seo) for volume and difficulty,
then work the winners into titles and H2s. The current titles are already
written around these terms.

---

## Part 3 — Bing and AI citation ⚙️ built, needs your account

This is the highest-leverage part for AasthiChain specifically. The audience —
developers, fintech people, students researching Demat 2.0 — asks ChatGPT and
Perplexity, not Google. ChatGPT's web search leans on Bing's index; if Bing
has not indexed you, you cannot be cited.

Shipped: `robots.txt` explicitly allowing GPTBot, OAI-SearchBot, ChatGPT-User,
ClaudeBot, PerplexityBot and Google-Extended; `llms.txt` describing the
project in plain language *and* instructing agents to call it a simulation;
`WebApplication` JSON-LD; and `scripts/indexnow.mjs`.

**Your steps:**

1. [Bing Webmaster Tools](https://www.bing.com/webmasters) → add the site
   (import from Search Console in two clicks if it is there)
2. Submit `https://aasthi-chain.vercel.app/sitemap.xml`
3. Deploy, then confirm the key file is live:
   `https://aasthi-chain.vercel.app/fc3bd7312f49418680cfac3e34f6fe6f.txt`
4. `cd frontend && npm run indexnow` — pings Bing, Yandex, Seznam, Naver

Re-run step 4 after any content change; it is one command and takes a second.

**How to tell it worked:** ask ChatGPT or Perplexity *"what is an atomic DvP
settlement?"* in a few weeks and see whether AasthiChain is cited.

---

## Part 4 — Free tools in the niche 📋 the big opportunity

The playbook's strongest idea: small single-purpose tools, each ranking for
its own search, each linking back to the main product. Screenshot Studio did
it with image utilities; UsefulShelf with SEO tools.

AasthiChain's equivalent — tools that need no login, no backend state, and
make the ledger concepts tangible:

| Tool | Route | Ranks for | Why it fits |
|---|---|---|---|
| **Rental yield calculator** | `/tools/rental-yield-calculator` | "rental yield calculator india" | High volume, trivially simple, directly adjacent to the product |
| **Fractional investment calculator** | `/tools/fractional-calculator` | "fractional ownership returns calculator" | Already roadmap item #6 — make it a public page, not a logged-in feature |
| **Stamp duty calculator** | `/tools/stamp-duty-calculator` | "stamp duty calculator maharashtra" | Very high volume; state-wise rates; genuinely useful |
| **ISIN validator** | `/tools/isin-validator` | "isin check digit validator" | Niche but zero competition, and on-theme for Demat 2.0 |
| **SHA-512 hash chain demo** | `/tools/hash-chain-demo` | "how does a blockchain hash chain work" | Shows the real ledger primitive; links straight to `/ledger` |
| **DvP settlement simulator** | `/tools/dvp-simulator` | "delivery versus payment explained" | The `/umi` page, repackaged as an explainer anyone can run |

Plus **explainer articles** — the thing that actually gets cited by chatbots:
*What is Demat 2.0?*, *RBI's UMI explained*, *What is atomic DvP?*,
*Fractional ownership vs REITs vs SM REITs*. Each ends with a link to the
live demo of exactly what it describes. That combination — a clear
explanation next to a working demonstration — is something none of the
competing pages have.

Then: list on directories (UsefulShelf, Product Hunt, Awesome lists for
fintech/blockchain), and submit the repo where developers look.

---

## Suggested order

1. **Make the marketplace public** — unlocks 9+ indexable pages (product decision)
2. **Trust pages** — About, Privacy, Terms
3. **Search Console + Bing + IndexNow** — your accounts, ~20 minutes
4. **Rental yield + fractional calculators** — highest volume, lowest effort
5. **Two explainer articles** — *What is Demat 2.0*, *What is atomic DvP*
6. **Measure** — `/insights` already tracks traffic, sources and search hits

The first three cost almost nothing and gate everything else.

---

## Honest caveats

- The playbook's results come from tools with broad consumer appeal.
  AasthiChain is a demonstration of financial market infrastructure — a
  smaller audience, and visitors cannot "convert" into anything, because no
  real investment exists. Measure it as portfolio reach and credibility, not
  signups.
- Do not optimise `/marketplace` for *"invest in real estate"* intent and then
  show a simulation. That is the one way this backfires. Lead with the
  explanatory angle, where the demo is the honest, genuinely best answer.
- SEO compounds slowly. Expect three to six months, not three to six days.
