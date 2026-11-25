# Aurum — Gold & Silver Price Tracker

A premium, installable web app (PWA) that tracks the price of **gold and silver in USD, CAD and INR**, refreshed automatically **once a day**.

- **Gold** per 10 g in **24K / 22K / 18K** (999 / 916 / 750 fineness)
- **Silver** per kg in **999 fine / 925 sterling**
- Rate sheet covering every purity and unit in all three currencies, plus the USD/CAD, USD/INR and CAD/INR rates
- Interactive history chart (1W → All) for Gold, Silver, the Gold/Silver ratio, and an indexed Gold-vs-Silver comparison, with a crosshair tooltip, keyboard navigation and a table view
- Market insight: position in the 52-week range, the gold/silver ratio against its 1-year average, and the 1-year gold return in each currency
- Holdings calculator (grams, ×10 g, kg, tola, troy oz), saved privately in the browser
- Dark and light themes, responsive down to phone width, works offline (last known prices)

No framework, no build step, no API keys: it's plain HTML, CSS and JS.

## How the daily refresh works

```
GitHub Actions (02:17 UTC daily)
   └─ node scripts/update-prices.mjs
        ├─ fetch today's snapshot: XAU, XAG, CAD, INR (all per 1 USD)
        ├─ fill any days missed since the last run (up to 45)
        ├─ sanity checks: plausibility bands + reject >25% daily jumps
        └─ write data/prices.json  → commit → deploy to GitHub Pages
```

**Data source:** the open daily [exchange-api](https://github.com/fawazahmed0/exchange-api) dataset, which publishes gold (XAU), silver (XAG) and fiat rates in a single daily snapshot, so metal and FX values always line up. The script tries three mirrors in turn: jsDelivr, then Cloudflare Pages, then the npm registry.

**Conversions:** `price per gram = (USD per troy oz ÷ 31.1034768) × fineness × FX`. Gold is shown per 10 g and silver per kg.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

To refresh the data by hand (Node 20+):

```bash
node scripts/update-prices.mjs
```

```bash
node scripts/update-prices.mjs --backfill 400
```

## Testing

There are three suites:

| Suite | Command | What it covers |
|---|---|---|
| Data pipeline (39 tests) | `npm test` | Price conversion, plausibility bands, tarball extraction, spike filtering, gap filling, mirror fallback, total outage (file left untouched), corrupt-history protection, idempotency, integrity of the committed data |
| Browser features (14 tests) | `npm test`, when Playwright is installed | Every figure on screen compared with an independent calculation: hero cards, the rate sheet across products and currencies, chart stats for every view and range, tooltip and keyboard, table view, holdings calculator, saved settings, theme, error and stale-data states |
| Devices and accessibility (85 checks) | `npm install`, then `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 npm run test:devices` | Widths from 320 to 1920 px in both themes, axe-core accessibility audit, keyboard reachability and focus rings, animations, live resizing, time zones and browser languages, high-contrast mode, offline mode and update delivery, page weight |

The daily workflow runs `npm test` before it commits or deploys, so bad price data never goes live. The browser suite skips itself in CI because Playwright isn't installed there.

## Deploy (one-time setup)

1. Merge this branch into `main`. GitHub only runs scheduled workflows on the default branch.
2. In **Settings → Pages**, set **Source = GitHub Actions**.
3. Open **Actions → "Daily prices & deploy" → Run workflow** once. After that it runs by itself every day.

## Files

| Path | Purpose |
|---|---|
| `index.html` | App shell |
| `assets/styles.css` | Design system (tokens, light/dark themes) |
| `assets/app.js` | Rendering, chart, calculator |
| `data/prices.json` | Daily price history (written by the updater) |
| `scripts/update-prices.mjs` | Daily fetcher, zero dependencies |
| `.github/workflows/daily-prices.yml` | Daily schedule, commit and Pages deploy |
| `manifest.webmanifest`, `sw.js` | Install-to-home-screen and offline support |

## Disclaimer

The values are indicative spot equivalents. Retail and jeweller prices include taxes (GST, import duty), dealer premiums and making charges, so they will be higher than shown here.
