#!/usr/bin/env node
/**
 * Aurum — daily precious-metals price updater.
 *
 * Fetches the USD spot price of gold (XAU) and silver (XAG) per troy ounce,
 * plus USD→CAD and USD→INR exchange rates, for one or more calendar days and
 * merges them into data/prices.json (the only file the web app reads).
 *
 * Source: the open, daily-published "currency-api" dataset
 * (github.com/fawazahmed0/exchange-api), which carries XAU/XAG alongside fiat
 * rates in a single snapshot per day — so metal and FX values always come from
 * the same moment. Three mirrors are tried in order for every day:
 *   1. jsDelivr CDN         (fast, tiny JSON)
 *   2. Cloudflare Pages     (independent mirror)
 *   3. npm registry tarball (last resort; works even on locked-down networks)
 *
 * Usage:
 *   node scripts/update-prices.mjs                 # today + fill any recent gaps
 *   node scripts/update-prices.mjs --backfill 400  # rebuild last 400 days
 *   node scripts/update-prices.mjs --date 2026-01-15
 *
 * Zero dependencies — Node 20+.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = resolve(ROOT, 'data/prices.json');
const PKG = '@fawazahmed0/currency-api';
const MAX_GAP_FILL = 45; // days to look back for missed runs
const CONCURRENCY = 6;

// Plausibility bands. A value outside these is treated as a bad feed, never stored.
const BOUNDS = {
  xau: [500, 25000],  // USD / troy oz
  xag: [5, 1000],     // USD / troy oz
  cad: [0.8, 2.5],    // CAD per USD
  inr: [40, 250],     // INR per USD
};
const MAX_DAILY_MOVE = 0.25; // reject >25% jumps vs. the previous stored day

// ---------- helpers ----------
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const npmVersion = (s) => s.split('-').map(Number).join('.'); // 2026-01-05 -> 2026.1.5
const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
const log = (...a) => console.log('[aurum]', ...a);

async function fetchWithTimeout(url, { timeout = 20000, as = 'json' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'aurum-price-tracker/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(t); }
}

/** Minimal ustar reader: return the contents of one file inside a .tgz buffer. */
function extractFromTgz(tgz, wanted) {
  const tar = gunzipSync(tgz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    if (!name) break;
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const start = off + 512;
    if (full === wanted) return tar.subarray(start, start + size).toString('utf8');
    off = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not found in tarball`);
}

/** Fetch the USD snapshot for a date ('latest' allowed) from the first mirror that answers. */
async function fetchSnapshot(date) {
  const tag = date === 'latest' ? 'latest' : date;
  const mirrors = [
    () => fetchWithTimeout(`https://cdn.jsdelivr.net/npm/${PKG}@${tag}/v1/currencies/usd.min.json`),
    () => fetchWithTimeout(`https://${tag}.currency-api.pages.dev/v1/currencies/usd.min.json`),
    async () => {
      const ver = date === 'latest'
        ? (await fetchWithTimeout(`https://registry.npmjs.org/${PKG.replace('/', '%2f')}`))['dist-tags'].latest
        : npmVersion(date);
      const tgz = await fetchWithTimeout(`https://registry.npmjs.org/${PKG}/-/currency-api-${ver}.tgz`, { as: 'buffer', timeout: 90000 });
      return JSON.parse(extractFromTgz(tgz, 'package/v1/currencies/usd.min.json'));
    },
  ];
  const errors = [];
  for (const m of mirrors) {
    try {
      const j = await m();
      if (j?.usd && j?.date) return j;
      errors.push('malformed payload');
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`all mirrors failed for ${date}: ${errors.join(' | ')}`);
}

function toRow(snap) {
  const r = snap.usd;
  const row = {
    d: snap.date,
    xau: round(1 / r.xau, 2),
    xag: round(1 / r.xag, 4),
    cad: round(r.cad, 5),
    inr: round(r.inr, 4),
  };
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    if (!Number.isFinite(row[k]) || row[k] < lo || row[k] > hi) throw new Error(`${row.d}: ${k}=${row[k]} outside [${lo}, ${hi}]`);
  }
  return row;
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]).catch((e) => ({ error: e.message })); }
  }));
  return out;
}

async function load() {
  try { return JSON.parse(await readFile(DATA_FILE, 'utf8')); }
  catch { return { series: [] }; }
}

function validateMoves(series) {
  const clean = [];
  for (const row of series) {
    const prev = clean[clean.length - 1];
    if (prev) {
      const bad = ['xau', 'xag', 'cad', 'inr'].find((k) => Math.abs(row[k] / prev[k] - 1) > MAX_DAILY_MOVE);
      if (bad) { log(`dropping ${row.d}: ${bad} moved >${MAX_DAILY_MOVE * 100}% vs ${prev.d}`); continue; }
    }
    clean.push(row);
  }
  return clean;
}

// ---------- main ----------
const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

const db = await load();
const byDate = new Map(db.series.map((r) => [r.d, r]));
const today = iso(new Date());
let dates = [];

if (argVal('--backfill')) {
  const n = parseInt(argVal('--backfill'), 10);
  for (let i = n; i >= 1; i--) dates.push(addDays(today, -i));
  dates.push('latest');
} else if (argVal('--date')) {
  dates = [argVal('--date')];
} else {
  const last = db.series.at(-1)?.d;
  const floor = addDays(today, -MAX_GAP_FILL);
  const from = last && addDays(last, 1) > floor ? addDays(last, 1) : floor;
  for (let d = from; d < today; d = addDays(d, 1)) dates.push(d);
  dates.push('latest');
}

log(`fetching ${dates.length} snapshot(s)…`);
let ok = 0, failed = 0;
const results = await pool(dates, CONCURRENCY, async (d) => toRow(await fetchSnapshot(d)));
results.forEach((r, i) => {
  if (r?.error) { failed++; log(`skip ${dates[i]}: ${r.error}`); return; }
  byDate.set(r.d, r); ok++;
});

const series = validateMoves([...byDate.values()].sort((a, b) => a.d.localeCompare(b.d)));
if (!series.length) { console.error('[aurum] no data — aborting without writing'); process.exit(1); }

const out = {
  meta: {
    name: 'Aurum price history',
    source: 'fawazahmed0/exchange-api (daily snapshot, mirrors: jsDelivr · Cloudflare Pages · npm)',
    units: { xau: 'USD per troy ounce', xag: 'USD per troy ounce', cad: 'CAD per USD', inr: 'INR per USD' },
    updatedAt: new Date().toISOString(),
    latest: series.at(-1).d,
    points: series.length,
  },
  series,
};

await mkdir(dirname(DATA_FILE), { recursive: true });
await writeFile(DATA_FILE, JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{') + '\n');
log(`stored ${ok} new/updated, ${failed} skipped → ${series.length} days (latest ${out.meta.latest})`);
if (ok === 0) process.exit(2); // let CI flag a day where every mirror failed
