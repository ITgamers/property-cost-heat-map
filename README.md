# Property Cost Heat Map — San Antonio

### ▶ **[Open the map](https://itgamers.github.io/property-cost-heat-map/)**

An interactive map of what it actually costs to own a home across the San
Antonio metro, shaded by **school district × city × county** — the real unit of
property-tax geography in Texas.

Adjust home value, down payment, loan term and type, interest rate, exemptions,
HOA dues and special-district levies, and every zone recomputes instantly.

Nothing to install. The hosted version keeps its own data current — see
[Keeping data current](#keeping-data-current).

## Running it locally

Only needed if you want to modify it; the hosted link above is the same app.

```bash
# 1. Build the data (needs network; takes ~2 minutes)
python -m pip install requests openpyxl shapely
python data/build_data.py

# 2. Open it
#    Either double-click web/index.html, or serve it:
cd web && python -m http.server 8765
```

Then browse to <http://localhost:8765>. Opening the file directly also works —
the build writes the data as both `.geojson`/`.json` and `.js` twins, and the
page loads the `.js` versions via `<script>` so `file://` CORS never bites.

Verify the math at any time:

```bash
node data/test_engine.js     # 24 assertions against hand-computed figures
```

## Why school district, not county

Asked for a "tax map of San Antonio," the obvious thing to draw is county or
city borders. In Texas that map is actively misleading, because your bill is the
sum of *overlapping* districts and the largest one ignores city and county lines:

| Taxing unit | Bexar rate (per $100) | Share |
|---|---|---|
| School district | 0.9572 (Alamo Heights) → 1.2575 (Harlandale) | **~50%** |
| City of San Antonio | 0.54159 | ~22% |
| Bexar County | 0.299999 | ~12% |
| University Health | 0.276235 | ~11% |
| Alamo Colleges | 0.14915 | ~6% |
| San Antonio River Authority | 0.0183 | ~1% |

Two identical $400,000 homes, both "in San Antonio, Bexar County," differ by
roughly **$1,600/year** on school district alone. Shading by city would hide
exactly the variation you're trying to see.

Across the seven-county metro the combined rate runs **1.1501%** (Fredericksburg
ISD, unincorporated Kendall County) to **2.6434%** (Poteet ISD, City of Poteet).

## Four map modes

- **Total monthly** — full PITI + HOA + special districts, the number that hits
  your account.
- **Effective tax rate** — tax as a percentage of appraised value *after*
  exemptions. Independent of price, so it's the cleanest jurisdiction comparison.
- **Affordability** — enter a monthly budget, see the home price it buys in each
  zone. At $3,200/month the metro spread is about **$413,000 → $463,000**.
- **Cash to close** — the one-time cash the closing table actually needs.

## Cash to close

The asking price is not what it costs to buy the house. This models the
one-time cash separately from the monthly figure — blending a one-off cost into
a recurring one is how these tools mislead.

Itemized with Texas norms, each editable: loan origination, lender's title
policy, appraisal, survey (effectively required in Texas), escrow/settlement,
recording, HOA transfer, and an optional buyer's-agent line. Plus the prepaid
escrow the lender collects, computed from **that zone's** actual tax and
insurance, minus the seller's tax proration and any builder credit.

On a $340,000 home at 20% down, expect roughly **$12,000 beyond the down
payment** — about 3.5% of the price.

### The closing-month result

Texas taxes are assessed 1 January, paid in arrears, and due the following
31 January, which pulls two effects in opposite directions:

- The lender must hold the full year's tax by the due date, so a later close
  leaves fewer monthly payments to get there and demands a bigger deposit.
- The seller owes tax for the part of the year they owned the home, and since
  nothing has been paid yet, that arrives as a credit to you.

They cancel **exactly**. The lender needs `(month + 2)/12` of the annual tax and
the seller owes `(month − 0.5)/12`, so the net is a constant 2.5 months whenever
you close. A January close and a November close on the same house both land at
$79,939 — while the gross escrow line moves from $1,452 to $6,290.

Worth knowing when you read a closing disclosure and the escrow line looks
alarming. Not a reason to pick a month.

### On buyer-agent fees

Since August 2024 buyer-agent compensation is negotiated per deal and no longer
advertised in the MLS. Sellers still commonly cover it, typically 1.5–2.5% as a
concession, so the field starts at **0%** — raise it to test paying your own.
On new construction the builder usually covers it, often conditioned on
registering your agent on the first visit.

Note that cash to close varies far less across zones than monthly cost does —
roughly $900 on a $340,000 home, since the down payment and fixed fees dominate
and only the escrow portion is local. Where you buy matters enormously for the
monthly payment and barely at all for the cash you bring.

Click any zone for a full breakdown; pin up to three to compare side by side.

**Seeing the map underneath.** The **Heat map** button (or the `H` key) toggles
the shading off so the roads and street names read clearly; the slider beside it
sets partial opacity, which is usually the more useful setting — around 25% you
can read streets and still see the gradient. With shading off the zone colours
move onto their outlines, so boundaries stay visible and zones stay clickable.

## What the engine models

**Property tax, per taxing unit.** Not one blended rate against one taxable
value — each unit applies its own rate to its own taxable value, because
exemptions differ per unit. This matters the moment a homestead is involved:

- School districts: flat **$140,000** homestead exemption (raised from $100,000
  by Proposition 13, effective 2026-01-01), plus **$60,000** more at 65+ or
  disabled.
- County / city / hospital / college: percentage exemption instead, up to 20%.
  Bexar County and the City of San Antonio each grant the full 20%.
- The 10% homestead appraisal cap, applied in the multi-year projection.

**Financing.** 15- or 30-year term; conventional, FHA or VA. The three differ in
ways that surprise buyers, so they're modelled separately:

- Conventional PMI terminates automatically at 78% LTV (the app tells you which
  month).
- FHA finances the 1.75% upfront MIP into the balance, and annual MIP is
  **permanent** above 90% LTV.
- VA has no monthly mortgage insurance at any down payment; the funding fee is
  tiered and financed. See below.

**Insurance.** Texas averages ~$4,350/year at $300,000 dwelling coverage — often
a bigger swing than the tax difference between two neighborhoods, and inflating
faster. See the honesty note below.

**VA loans and veteran exemptions.** San Antonio is a military town, and the VA
path diverges from conventional in two ways large enough to change which house
is the right one.

*The funding fee is tiered, not flat* — by down payment and by whether VA
entitlement has been used before:

| Down payment | First use | Subsequent use |
|---|---|---|
| Under 5% | 2.15% | 3.30% |
| 5–9.99% | 1.50% | 1.50% |
| 10% or more | 1.25% | 1.25% |

It is **waived entirely** for veterans receiving VA disability compensation at
any rating, Purple Heart recipients on active duty, and eligible surviving
spouses — a large share of VA borrowers. Tick *Funding fee exempt* and a
zero-down VA borrower finances exactly the purchase price. Sellers may also
contribute up to 4% of value in concessions on a VA loan.

*Texas exempts disabled veterans from property tax.* Under Tax Code 11.22, a
flat amount comes off the taxable value at **every** taxing unit:

| VA rating | Exemption |
|---|---|
| 10–29% | $5,000 |
| 30–49% | $7,500 |
| 50–69% | $10,000 |
| 70–99% | $12,000 |
| **100% or Individual Unemployability** | **Total — no property tax at all** |

That last row is Tax Code 11.131, and it is not a discount. A 100%-rated
veteran's residence homestead is exempt from property tax entirely — county,
city, school district, hospital, college, and any MUD. On a $400,000 home in San
Antonio ISD that removes **$7,116 a year**, dropping the payment from $3,062 to
$2,469/month, and no tax escrow is collected at closing either.

For a qualifying veteran this changes what the map is *for*: property tax stops
being a reason to prefer one area over another, and insurance, price and schools
decide it instead. It applies only to the residence homestead, so the app says
so if the homestead box is unticked.

**Ten-year projection.** Year one flatters Texas. Appraisals compound against the
homestead cap and insurance climbs faster than wages, so the app projects both.
A $400,000 home in Schertz runs $2,931/month in year one and $3,524 by year ten.

**Special districts.** MUDs, PIDs, WCIDs and ESDs are the biggest hidden cost in
Texas new construction. Redbird Ranch WCID #2 and #3 levy **1.00 per $100** — an
extra **$4,000/year** on a $400,000 home, on top of everything on the map. Every
such district in the metro is in the sidebar dropdown, pulled live from the
Comptroller file.

## Data sources

All fetched at build time and baked into static files. Nothing is fetched at
page load, so the map is fast, works offline, and never trips over government
CORS policies.

| Data | Source | Cadence |
|---|---|---|
| Tax rates & levies | [Texas Comptroller](https://comptroller.texas.gov/taxes/property-tax/rates/) — county, city, school, special district XLSX | Annual, certified ~Oct |
| Boundaries | [Census TIGERweb](https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_restmapservice.html) — school districts, incorporated places, counties | Annual |
| Mortgage rate | [FRED `MORTGAGE30US`](https://fred.stlouisfed.org/series/MORTGAGE30US) — Freddie Mac PMMS | Weekly (Thursdays) |
| Insurance | Modelled — see below | — |

## Keeping data current

There are two controls, and it matters which one you reach for:

| Control | Where | What it does |
|---|---|---|
| **Refresh data** workflow | Repo → **Actions** tab | Fetches from the Comptroller, Census and FRED — the only thing that pulls new figures from the outside world |
| **Update data** button | On the map | Copies whatever that workflow last committed |

**Day to day, the button is all you need.** No code, no Python, no terminal. It
pulls the newest published dataset and swaps it in live — the map, the rate
stack, the mortgage rate and the special-district list all refresh in place. The
result is cached, so it survives a reload. If the network is down the button says
so and the bundled data keeps working.

**The button cannot reach the original sources** (see the CORS table below), so
it can only ever be as current as the repo. If the scheduled workflow has
stopped, the button would otherwise report "up to date" while serving stale
figures — so past 45 days it says *"Repo has nothing newer… the scheduled
refresh may have stopped"* instead, and the header banner links straight to the
workflow's **Run workflow** button.

The page also checks quietly on load and only speaks up if something newer
exists. If the data it is showing is more than 45 days old, the header says so
outright — stale tax rates otherwise look exactly like fresh ones.

### What updates by itself, and what doesn't

| Input | How it refreshes | Cadence |
|---|---|---|
| Mortgage rate | Automatic (FRED) | Weekly |
| Tax rates & levies | Automatic (Comptroller) | Annual, ~October |
| **Tax year rollover** | **Automatic** — the build probes for the newest published year | Annual |
| Taxing-unit & district lists | Automatic (Comptroller) | Annual |
| Boundaries | Automatic (Census) | Annual |
| Insurance baseline | **By hand** — in-app panel, or [`assumptions.json`](data/assumptions.json) | Check yearly |
| Exemption amounts | **By hand** — in-app panel, or [`assumptions.json`](data/assumptions.json) | After each legislative session |
| Loan product spreads | **By hand** — in-app panel, or [`assumptions.json`](data/assumptions.json) | Rarely |

### The Assumptions panel

The three hand-maintained items are the ones no public feed publishes, and both
ways of changing them are open to you:

- **In the app** — the **Assumptions** section at the bottom of the sidebar.
  Every figure is editable in place: school homestead exemption, the 65+/disabled
  addition, the local flat exemption, the appraisal cap, the insurance baseline
  and its dwelling basis, and the 15-year/FHA/VA rate spreads. Fields start at
  the published values, an **edited** badge appears once anything differs, and
  **Reset to published defaults** puts it all back. Changes save in your browser
  only — nothing is uploaded, and other people see the published numbers.

  Use this to test a scenario ("what if the exemption goes to $200,000?") or to
  correct a figure that has moved before the repo catches up.

- **In the repo** — [`data/assumptions.json`](data/assumptions.json), editable
  straight from github.com. This is the one that changes the numbers *for
  everyone* and survives a cache clear. Commit it and the next deploy carries it.

Texas legislates in odd-numbered years, so January of an odd year is the natural
time to review the exemption block.

Overrides are layered on top of whatever data is current, so they survive a data
update; unedited fields follow the new published values.

### Why it can't fetch the original sources directly

A browser is blocked from reading a response unless the server opts in with an
`Access-Control-Allow-Origin` header. Measured:

| Source | Sends CORS header? |
|---|---|
| FRED (mortgage rate) | ❌ none |
| Texas Comptroller (tax rates) | ❌ none |
| Census TIGERweb | ✅ reflects origin |
| `raw.githubusercontent.com` | ✅ `*` |

So the two sources that matter most are unreachable from a page, and no amount
of client-side code changes that. Instead, the
[`Refresh data`](.github/workflows/update-data.yml) GitHub Action re-runs the
ETL on a schedule — Thursdays, right after Freddie Mac publishes the weekly PMMS
survey — runs the engine tests, and commits the output. The button reads that
committed data, which GitHub serves with `Access-Control-Allow-Origin: *` and is
therefore readable from any origin, including a page opened straight off the
filesystem.

You can also trigger a refresh by hand from the repo's **Actions** tab
(*Refresh data → Run workflow*), which is the no-terminal way to force one.

> GitHub serves raw files through a CDN with a 5-minute cache, so immediately
> after a refresh commit the button may still report "up to date" for a few
> minutes. It resolves on its own.

### ⚠ If you leave the repo alone for months

**GitHub disables scheduled workflows after 60 days of repository inactivity.**
It emails the repo owner when this happens, but the practical effect is that the
Thursday refresh stops and the data quietly freezes — which is exactly the
failure mode a tax map should never have.

Two safeguards:

- The app shows a **"Data is N months old"** banner past 45 days, so a stopped
  schedule is visible in the product rather than only in your inbox.
- Re-enabling takes one click: repo → **Actions** → *Refresh data* →
  **Enable workflow**, then **Run workflow** to catch up immediately.

Any push to the repo also resets the 60-day clock.

If you fork this, point the button at your own copy:

```bash
python data/build_data.py --refresh --repo your-user/your-fork
```

### Or rebuild locally

```bash
python data/build_data.py --refresh
```

Tax rates are certified in September/October, so an annual rebuild is enough for
those; the mortgage rate moves weekly.

## Honesty about the insurance number

**There is no free per-ZIP homeowners insurance API.** The good data
(Quadrant/Insure.com, ~20M quotes) is proprietary. Rather than fake precision,
the app scales the published Texas average by dwelling coverage and a county
risk factor, labels it an estimate everywhere it appears, and lets you type in a
real quote to override it. Treat it as a placeholder until you have a quote —
in Texas it's too large a number to leave modelled.

## Architecture

```
data/
  build_data.py      ETL — fetch, parse, intersect, emit
  test_engine.js     24 assertions against hand-computed figures
  raw/               cached downloads (gitignorable)
web/
  index.html
  css/app.css        design tokens, light + dark
  js/engine.js       jurisdiction-agnostic rules engine — all the math
  js/app.js          map, controls, detail rendering
  data/              generated: zones.geojson/.js, market.json/.js
  vendor/            Leaflet 1.9.4, vendored (no CDN dependency)
```

`engine.js` contains no Texas-specific constants. Exemption rules live in
`market.json` keyed by state (`exemptions.TX`), and rate stacks live per zone.

## Going national

Texas is the hardest case in the country — many overlapping units, no income
tax, high rates, MUD complexity. If the engine handles Bexar, most states are
simpler. Two things are needed to widen it:

1. **Scope.** `STUDY_COUNTIES` and `BBOX` in `build_data.py` are the only things
   pinning this to San Antonio. Add counties to widen within Texas.
2. **A rule set per state.** Add a sibling to `exemptions.TX` in `market.json`.
   California needs acquisition-value basis (Prop 13); mill-rate states need a
   rate-unit conversion. Neither requires touching `engine.js`.

The rate-source layer is the part that doesn't generalize for free: the Texas
Comptroller's statewide XLSX has no equivalent in most states, where rates live
with individual counties. Census ACS table **B25103** (median real estate taxes
paid) is the usual fallback for national coverage at lower resolution.

## Limitations

- **Zone-level, not parcel-level.** Exact figures need the appraisal district's
  record for a specific parcel. Expect to be within a few percent, not exact.
- **MUD/PID/ESD boundaries aren't published** in these sources, so they're an
  opt-in toggle rather than a map layer. Always ask before you offer.
- **Local optional exemption percentages** are only verified for Bexar County and
  the City of San Antonio (both 20%). The slider lets you check others.
- **No flood zone, school ratings, or commute layers** yet — see below.
- Estimates only. Confirm with the appraisal district and a lender.

## Natural next steps

- FEMA National Flood Hazard Layer overlay (San Antonio has real flash-flood
  exposure along Salado and Leon Creek).
- TEA school ratings against the ISD rate — you're paying for the district, so
  showing where the money buys results is the natural companion view.
- Address search via the Census geocoder (needs a tiny proxy; it doesn't do CORS).
- Median home price per zone from ACS/Zillow ZHVI, so the map can default to a
  realistic price per area instead of one global number.
- Rent-vs-buy break-even.
