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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const npmVersion = (s) => s.split('-').map(Number).join('.'); // 2026-01-05 -> 2026.1.5
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
export function extractFromTgz(tgz, wanted) {
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
export async function fetchSnapshot(date) {
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

export function toRow(snap) {
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

/** Missing file → start fresh. Unreadable/corrupt file → refuse, so history is never overwritten. */
async function load(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { series: [] }; throw e; }
  const json = JSON.parse(text);
  if (!Array.isArray(json.series)) throw new Error(`${file}: missing "series" array`);
  return json;
}

/**
 * Drop bad prints without ever freezing the feed.
 * A day that jumps more than MAX_DAILY_MOVE versus the last accepted day is kept only if the
 * following day confirms the new level (a genuine re-pricing). An isolated spike that reverts —
 * or a newest day whose jump is not yet confirmed — is dropped; the next run refetches it.
 */
export function validateMoves(series, limit = MAX_DAILY_MOVE, onDrop = () => {}) {
  const KEYS = ['xau', 'xag', 'cad', 'inr'];
  const maxMove = (a, b) => Math.max(...KEYS.map((k) => Math.abs(b[k] / a[k] - 1)));
  const clean = [];
  series.forEach((row, i) => {
    const prev = clean[clean.length - 1];
    if (!prev || maxMove(prev, row) <= limit) { clean.push(row); return; }
    const next = series[i + 1];
    if (next && maxMove(row, next) <= limit) { clean.push(row); return; }
    onDrop(row, prev);
  });
  return clean;
}

/** Which dates to fetch for a run. */
export function planDates({ series = [], today, backfill, date, maxGap = MAX_GAP_FILL }) {
  if (backfill) {
    const out = [];
    for (let i = backfill; i >= 1; i--) out.push(addDays(today, -i));
    return [...out, 'latest'];
  }
  if (date) return [date];
  const out = [];
  const last = series.at(-1)?.d;
  const floor = addDays(today, -maxGap);
  const from = last && addDays(last, 1) > floor ? addDays(last, 1) : floor;
  for (let d = from; d < today; d = addDays(d, 1)) out.push(d);
  return [...out, 'latest'];
}

export function mergeSeries(existing, rows, onDrop) {
  const byDate = new Map(existing.map((r) => [r.d, r]));
  rows.forEach((r) => byDate.set(r.d, r));
  return validateMoves([...byDate.values()].sort((a, b) => a.d.localeCompare(b.d)), MAX_DAILY_MOVE, onDrop);
}

export function serialize(series, now = new Date()) {
  const out = {
    meta: {
      name: 'Aurum price history',
      source: 'fawazahmed0/exchange-api (daily snapshot, mirrors: jsDelivr · Cloudflare Pages · npm)',
      units: { xau: 'USD per troy ounce', xag: 'USD per troy ounce', cad: 'CAD per USD', inr: 'INR per USD' },
      updatedAt: now.toISOString(),
      latest: series.at(-1).d,
      points: series.length,
    },
    series,
  };
  return JSON.stringify(out).replace(/\},\{/g, '},\n{') + '\n';
}

// ---------- main ----------
export async function main(argv = process.argv.slice(2), { dataFile = DATA_FILE, now = new Date() } = {}) {
  const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const db = await load(dataFile);
  const dates = planDates({ series: db.series, today: iso(now), backfill: argVal('--backfill') && parseInt(argVal('--backfill'), 10), date: argVal('--date') });

  log(`fetching ${dates.length} snapshot(s)…`);
  const rows = [];
  let failed = 0;
  const results = await pool(dates, CONCURRENCY, async (d) => toRow(await fetchSnapshot(d)));
  results.forEach((r, i) => { if (r?.error) { failed++; log(`skip ${dates[i]}: ${r.error}`); } else rows.push(r); });

  if (!rows.length) {
    console.error('[aurum] every snapshot failed — leaving data file untouched');
    return 2;
  }
  const series = mergeSeries(db.series, rows, (row, prev) => log(`dropping ${row.d}: unconfirmed move >${MAX_DAILY_MOVE * 100}% vs ${prev.d}`));
  if (!series.length) { console.error('[aurum] no valid data — aborting without writing'); return 1; }
  // Nothing new (e.g. the backup run after a successful one): leave the file — and meta.updatedAt,
  // which the page shows as "Last refresh" — untouched, so there is no empty commit.
  if (JSON.stringify(series) === JSON.stringify(db.series)) {
    log(`no new or changed prices (latest still ${series.at(-1).d}) — data file left untouched`);
    return 0;
  }

  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, serialize(series, now));
  log(`fetched ${rows.length}, skipped ${failed} → ${series.length} days stored (latest ${series.at(-1).d})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
