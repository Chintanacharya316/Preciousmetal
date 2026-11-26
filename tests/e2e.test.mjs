// Round 2 — functional browser tests.  Run: node --test tests/
// Needs Playwright + Chromium (skipped automatically when unavailable).
// Every number the UI shows is checked against an independent re-computation from data/prices.json.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const SKIP = !chromium && 'playwright not installed';

const DATA = JSON.parse(readFileSync(join(ROOT, 'data/prices.json'), 'utf8'));
const S = DATA.series, L = S.at(-1), P = S.at(-2);
const OZ = 31.1034768;
const FX = { USD: () => 1, CAD: (r) => r.cad, INR: (r) => r.inr };
const FINE = { '24k': 0.999, '22k': 0.916, '18k': 0.75, '999': 0.999, '925': 0.925 };
const gold = (r, p, c, g = 10) => (r.xau / OZ) * FINE[p] * g * FX[c](r);
const silver = (r, p, c, g = 1000) => (r.xag / OZ) * FINE[p] * g * FX[c](r);
const pct = (a, b) => (a / b - 1) * 100;
/** "$1,132.21" / "C$1,617.56" / "₹1,04,494" / "−2.57%" → number */
const n = (t) => parseFloat(String(t).replace(/−/g, '-').replace(/[^0-9.\-]/g, ''));
const tol = (c) => (c === 'INR' ? 0.51 : 0.0051);
const near = (actual, expected, t, msg) => assert.ok(Math.abs(actual - expected) <= t, `${msg}: got ${actual}, expected ${expected} ±${t}`);

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
/** Serve the repo from disk at http://aurum.test (no local server needed). Optional per-path overrides. */
async function serve(ctx, overrides = {}) {
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'aurum.test') return route.abort();
    if (overrides[u.pathname]) return route.fulfill(overrides[u.pathname]);
    let f = join(ROOT, decodeURIComponent(u.pathname));
    if (f.endsWith('/')) f += 'index.html';
    if (!f.startsWith(ROOT) || !existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
}

let browser;
async function open({ overrides, viewport = { width: 1366, height: 900 }, scheme = 'dark', storage, now, timezoneId } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId });
  await serve(ctx, overrides);
  if (storage) await ctx.addInitScript((st) => { for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); }, storage);
  const page = await ctx.newPage();
  if (now) await page.clock.setFixedTime(new Date(now));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Ignore the browser's own network logs (blocked web fonts, deliberately failed fetches in tests).
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto('http://aurum.test/');
  await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
  return { ctx, page, errors };
}
const txt = (page, sel) => page.locator(sel).first().innerText();

describe('Aurum UI', { skip: SKIP }, () => {
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  test('boots with no errors and shows the latest fix date', async () => {
    const { ctx, page, errors } = await open();
    const asOf = await txt(page, '#asOf');
    const d = new Date(L.d + 'T12:00:00Z');
    assert.match(asOf, new RegExp(String(d.getUTCDate())));
    assert.match(asOf, new RegExp(String(d.getUTCFullYear())));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('hero prices are correct in every currency and purity', async () => {
    const { ctx, page, errors } = await open();
    for (const c of ['USD', 'CAD', 'INR']) {
      await page.click(`#currencySeg [data-cur="${c}"]`);
      for (const p of ['24k', '22k', '18k']) {
        await page.click(`#cardGold .purity [data-p="${p}"]`);
        near(n(await txt(page, '#cardGold [data-price]')), gold(L, p, c), tol(c), `gold ${p} ${c}`);
        near(n(await page.locator('#cardGold [data-delta] .delta').innerText()), pct(gold(L, p, c), gold(P, p, c)), 0.0051, `gold Δ% ${p} ${c}`);
      }
      for (const p of ['999', '925']) {
        await page.click(`#cardSilver .purity [data-p="${p}"]`);
        near(n(await txt(page, '#cardSilver [data-price]')), silver(L, p, c), tol(c), `silver ${p} ${c}`);
      }
      // Spot / oz footer is the raw spot price in the chosen currency
      near(n(await page.locator('#cardGold .kv dd').nth(2).innerText()), L.xau * FX[c](L), c === 'INR' ? 0.51 : 0.0051, `spot ${c}`);
    }
    assert.equal(await page.locator('#cardGold .purity [aria-pressed="true"]').count(), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('rate sheet: every product × currency matches', async () => {
    const { ctx, page } = await open();
    const rows = page.locator('#ratesTable tbody tr:not(.group)');
    const expected = [
      ...['24k', '22k', '18k'].map((p) => (c) => gold(L, p, c, 10)),
      ...['24k', '22k', '18k'].map((p) => (c) => gold(L, p, c, 1)),
      ...['999', '925'].map((p) => (c) => silver(L, p, c, 1000)),
      ...['999', '925'].map((p) => (c) => silver(L, p, c, 10)),
    ];
    assert.equal(await rows.count(), expected.length);
    for (let i = 0; i < expected.length; i++) {
      const cells = rows.nth(i).locator('td');
      for (const [j, c] of ['USD', 'CAD', 'INR'].entries()) near(n(await cells.nth(j).innerText()), expected[i](c), tol(c), `row ${i} ${c}`);
    }
    const fx = await page.locator('#fxStrip .fx__val').allInnerTexts();
    near(n(fx[0]), L.cad, 0.00006, 'USD/CAD'); near(n(fx[1]), L.inr, 0.0051, 'USD/INR'); near(n(fx[2]), L.inr / L.cad, 0.0051, 'CAD/INR');
    // the active currency column is highlighted
    assert.equal(await page.locator('#ratesTable thead th.is-active').innerText(), 'USD');
    await ctx.close();
  });

  test('chart range stats are correct for every view × range', async () => {
    const { ctx, page, errors } = await open();
    for (const range of [7, 30, 90, 180, 365, 0]) {
      await page.click(`#rangeChips [data-range="${range}"]`);
      const slice = range ? S.slice(-(range + 1)) : S;
      for (const view of ['gold', 'silver', 'ratio', 'compare']) {
        await page.click(`#metalTabs [data-view="${view}"]`);
        const stats = await page.locator('#rangeStats .stat__value').allInnerTexts();
        assert.ok(await page.locator('#chartPlot svg path').count() >= 2, `${view}/${range} draws`);
        if (view === 'compare') {
          near(n(stats[0]), pct(slice.at(-1).xau, slice[0].xau), 0.0051, `gold return ${range}`);
          near(n(stats[1]), pct(slice.at(-1).xag, slice[0].xag), 0.0051, `silver return ${range}`);
          continue;
        }
        const f = view === 'gold' ? (r) => gold(r, '24k', 'USD') : view === 'silver' ? (r) => silver(r, '999', 'USD') : (r) => r.xau / r.xag;
        const v = slice.map(f);
        near(n(stats[0]), pct(v.at(-1), v[0]), 0.0051, `${view}/${range} change`);
        near(n(stats[1]), Math.max(...v), 0.0051, `${view}/${range} high`);
        near(n(stats[2]), Math.min(...v), 0.0051, `${view}/${range} low`);
        near(n(stats[3]), v.reduce((a, b) => a + b) / v.length, 0.0051, `${view}/${range} avg`);
      }
    }
    // compare view gets a legend; single-series views don't
    assert.equal(await page.locator('#chartLegend span').count(), 2);
    await page.click('#metalTabs [data-view="gold"]');
    assert.equal(await page.locator('#chartLegend span').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('tooltip: hover + keyboard navigation report the right day', async () => {
    const { ctx, page } = await open();
    await page.click('#rangeChips [data-range="30"]');
    await page.click('#metalTabs [data-view="gold"]');
    const slice = S.slice(-31);
    const svg = page.locator('#chartPlot svg');
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    assert.equal(await page.locator('#tooltip').isVisible(), true);
    near(n(await page.locator('#tooltip .tooltip__val').innerText()), gold(slice[0], '24k', 'USD'), 0.0051, 'first-day tooltip');
    await page.mouse.move(box.x + box.width - 90, box.y - 60); // leave
    assert.equal(await page.locator('#tooltip').isVisible(), false);
    await svg.focus();
    await page.keyboard.press('End');
    near(n(await page.locator('#tooltip .tooltip__val').innerText()), gold(L, '24k', 'USD'), 0.0051, 'End → latest');
    await page.keyboard.press('ArrowLeft');
    near(n(await page.locator('#tooltip .tooltip__val').innerText()), gold(P, '24k', 'USD'), 0.0051, 'ArrowLeft → previous');
    await page.keyboard.press('Home');
    near(n(await page.locator('#tooltip .tooltip__val').innerText()), gold(slice[0], '24k', 'USD'), 0.0051, 'Home → first');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tooltip').isVisible(), false);
    await ctx.close();
  });

  test('table view mirrors the selected range, newest first', async () => {
    const { ctx, page } = await open();
    await page.click('#rangeChips [data-range="30"]');
    await page.click('#tableToggle');
    assert.equal(await page.locator('#tableToggle').getAttribute('aria-expanded'), 'true');
    const rows = page.locator('#historyTable tbody tr');
    assert.equal(await rows.count(), 31);
    near(n(await rows.first().locator('td').nth(1).innerText()), gold(L, '24k', 'USD'), 0.0051, 'table gold');
    await page.click('#rangeChips [data-range="7"]');
    assert.equal(await rows.count(), 8, 'table follows range');
    await page.click('#tableToggle');
    assert.equal(await page.locator('#historyWrap').isVisible(), false);
    await ctx.close();
  });

  test('holdings calculator: values, edits, units, add/remove, persistence', async () => {
    const { ctx, page, errors } = await open();
    const total = () => page.locator('.portfolio__value').innerText();
    // default: 50 g 22K gold + 1 kg 999 silver
    near(n(await total()), gold(L, '22k', 'USD', 50) + silver(L, '999', 'USD', 1000), 0.0051, 'default portfolio');
    const first = page.locator('#holdings .holding').first();
    await first.locator('input').fill('2');
    await first.locator('select').nth(2).selectOption('tola');
    near(n(await first.locator('.holding__value b').innerText()), gold(L, '22k', 'USD', 2 * 11.6638038), 0.0051, '2 tola 22K');
    await first.locator('input').fill('');
    assert.equal(n(await first.locator('.holding__value b').innerText()), 0, 'empty qty → 0, not NaN');
    await first.locator('input').fill('1');
    await first.locator('select').nth(2).selectOption('ozt');
    await first.locator('select').nth(0).selectOption('silver'); // switching metal resets purity list
    assert.deepEqual(await first.locator('select').nth(1).locator('option').allInnerTexts(), ['999 fine', '925 Sterling']);
    near(n(await first.locator('.holding__value b').innerText()), L.xag * 0.999, 0.0051, '1 ozt silver');
    await page.click('#addHolding');
    assert.equal(await page.locator('#holdings .holding').count(), 3);
    await page.locator('#holdings .holding').nth(1).locator('.remove').click();
    assert.equal(await page.locator('#holdings .holding').count(), 2);
    const expectedNow = L.xag * 0.999 + gold(L, '24k', 'USD', 10);
    near(n(await total()), expectedNow, 0.0051, 'after edits');
    await page.click('#currencySeg [data-cur="INR"]');
    near(n(await total()), expectedNow * L.inr, 0.51, 'portfolio converts to INR');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#holdings .holding').count(), 2, 'holdings persisted');
    near(n(await total()), expectedNow * L.inr, 0.51, 'value persisted (and currency remembered)');
    // remove all → graceful empty state
    await page.locator('#holdings .remove').first().click();
    await page.locator('#holdings .remove').first().click();
    assert.equal(n(await total()), 0);
    assert.match(await page.locator('.portfolio__row').innerText(), /Add a holding/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('theme toggle flips and persists', async () => {
    const { ctx, page } = await open({ scheme: 'light' });
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lightBg = await bg();
    await page.click('#themeBtn');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.notEqual(await bg(), lightBg);
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await ctx.close();
  });

  test('state survives corrupted localStorage', async () => {
    const { ctx, page, errors } = await open({ storage: { 'aurum.state.v1': '{not json', 'aurum.theme': 'dark' } });
    assert.ok(n(await txt(page, '#cardGold [data-price]')) > 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('state with unknown values falls back safely', async () => {
    const bad = JSON.stringify({ cur: 'EUR', view: 'platinum', range: 12345, purity: { gold: '99k', silver: 'x' }, holdings: [{ metal: 'gold', purity: 'zz', qty: 'abc', unit: 'furlong' }] });
    const { ctx, page, errors } = await open({ storage: { 'aurum.state.v1': bad } });
    const body = await page.locator('body').innerText();
    assert.doesNotMatch(body, /NaN|undefined|Infinity/);
    assert.equal(await page.locator('#metalTabs [aria-selected="true"]').count(), 1, 'one tab selected');
    assert.equal(await page.locator('#rangeChips [aria-checked="true"]').count(), 1, 'one range selected');
    assert.equal(await page.locator('#cardGold .purity [aria-pressed="true"]').count(), 1, 'gold purity selected');
    assert.equal(await page.locator('#cardSilver .purity [aria-pressed="true"]').count(), 1, 'silver purity selected');
    assert.equal(await page.locator('#holdings input').inputValue(), '0', 'garbage qty → 0');
    assert.equal(await page.locator('#holdings .holding select').nth(2).inputValue(), 'g', 'unknown unit → grams');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('data unavailable → friendly banner, no crash', async () => {
    for (const body of [{ status: 500, body: 'boom' }, { status: 200, contentType: 'application/json', body: '{"series":[' }, { status: 200, contentType: 'application/json', body: '{"series":[]}' }]) {
      const { ctx, page, errors } = await open({ overrides: { '/data/prices.json': body } });
      assert.equal(await page.locator('#banner').isVisible(), true);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  test('stale data is flagged', async () => {
    const old = { ...DATA, series: S.slice(0, -10) };
    const { ctx, page } = await open({ overrides: { '/data/prices.json': { status: 200, contentType: 'application/json', body: JSON.stringify(old) } } });
    assert.match(await txt(page, '#asOf'), /Last fix/i);
    await ctx.close();
  });

  test('no NaN / undefined / Infinity anywhere, in any state', async () => {
    const { ctx, page } = await open();
    for (const c of ['USD', 'CAD', 'INR']) {
      await page.click(`#currencySeg [data-cur="${c}"]`);
      for (const v of ['gold', 'silver', 'ratio', 'compare']) {
        await page.click(`#metalTabs [data-view="${v}"]`);
        for (const r of [7, 0]) {
          await page.click(`#rangeChips [data-range="${r}"]`);
          const t = await page.locator('body').innerText() + await page.locator('#chartPlot').innerHTML();
          assert.doesNotMatch(t, /NaN|undefined|Infinity/, `${c}/${v}/${r}`);
        }
      }
    }
    await ctx.close();
  });

  test('last / next refresh timestamps follow the schedule', async () => {
    const dayAfter = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const label = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    const cases = [
      // [clock (UTC), expected next refresh day, expected time]
      [`${L.d}T23:30:00Z`, dayAfter(L.d, 1), '10:47 am'],           // today's prices already in → tomorrow's first run
      [`${dayAfter(L.d, 1)}T08:00:00Z`, dayAfter(L.d, 1), '10:47 am'], // new day, before the first run
      [`${dayAfter(L.d, 1)}T11:00:00Z`, dayAfter(L.d, 1), '1:47 pm'],  // first run missed → retry 1
      [`${dayAfter(L.d, 1)}T14:30:00Z`, dayAfter(L.d, 1), '4:47 pm'],  // → retry 2
      [`${dayAfter(L.d, 1)}T17:00:00Z`, dayAfter(L.d, 2), '10:47 am'], // all slots passed → tomorrow
    ];
    for (const [now, day, time] of cases) {
      const { ctx, page, errors } = await open({ now, timezoneId: 'UTC' });
      const next = await page.locator('#nextRefresh').innerText();
      assert.ok(next.includes(label(day)) && next.includes(time) && next.includes('UTC'), `at ${now}: got "${next}", want ${label(day)} ${time}`);
      assert.match(next, /\(in \d+ (minutes?|hours?)\)|\(tomorrow\)/, 'relative time');
      const last = await page.locator('#lastRefresh').innerText();
      const up = new Date(DATA.meta.updatedAt);
      assert.ok(last.includes(up.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' })), `last refresh "${last}"`);
      assert.match(last, /ago|just now|yesterday/);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // Viewer's own time zone is used (India: UTC+5:30 → 10:47 UTC shows as 4:17 pm)
    const { ctx, page } = await open({ now: `${dayAfter(L.d, 1)}T08:00:00Z`, timezoneId: 'Asia/Kolkata' });
    assert.match(await page.locator('#nextRefresh').innerText(), /4:17 pm GMT\+5:30/);
    await ctx.close();
  });

  test('insights agree with the data', async () => {
    const { ctx, page } = await open();
    const year = S.filter((r) => r.d > new Date(Date.parse(L.d) - 365 * 864e5).toISOString().slice(0, 10));
    near(n(await page.locator('.ratio-big').evaluate((e) => e.firstChild.textContent)), L.xau / L.xag, 0.051, 'ratio');
    const ends = await page.locator('.range-meter__ends').first().innerText();
    const g = year.map((r) => gold(r, '24k', 'USD'));
    near(n(ends.split('High')[1]), Math.max(...g), 0.0051, '52w high');
    near(n(ends.split('High')[0]), Math.min(...g), 0.0051, '52w low');
    const lens = await page.locator('.insight').nth(3).locator('.delta').allInnerTexts();
    ['USD', 'CAD', 'INR'].forEach((c, i) => near(n(lens[i]), pct(gold(L, '24k', c), gold(year[0], '24k', c)), 0.0051, `1Y ${c}`));
    await ctx.close();
  });
});
