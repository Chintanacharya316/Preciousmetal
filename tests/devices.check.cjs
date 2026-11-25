// Round 3 — devices, accessibility, robustness.
// Run: npm install && PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 npm run test:devices
// Needs Playwright + Chromium available on the machine.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const results = [];
// Expected values come from the data file, so this suite keeps working as prices update daily.
const LAST = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/prices.json'), 'utf8')).series.at(-1);
const EXP_DATE = new Date(LAST.d + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const EXP_PRICE = '$' + ((LAST.xau / 31.1034768) * 0.999 * 10).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function serve(ctx) {
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['aurum.test', 'localhost'].includes(u.hostname)) return route.abort();
    let f = path.join(ROOT, decodeURIComponent(u.pathname));
    if (f.endsWith('/')) f += 'index.html';
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
}
async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: 'dark', serviceWorkers: 'block', ...opts });
  await serve(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto('http://aurum.test/');
  await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch();

  // 1. Responsive matrix: no horizontal overflow, nothing escaping the viewport, in both themes
  for (const w of [320, 360, 390, 768, 1024, 1440, 1920]) {
    for (const scheme of ['dark', 'light']) {
      const { ctx, page, errors } = await open(browser, { viewport: { width: w, height: 900 }, colorScheme: scheme });
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const bad = [];
        document.querySelectorAll('body *').forEach((el) => {
          if (el.closest('.table-scroll, .tabs, .chips, svg, .tooltip, .backdrop')) return; // intentionally scrollable / decorative
          const b = el.getBoundingClientRect();
          if (b.width && (b.right > vw + 1 || b.left < -1)) bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
        });
        return { sw: document.documentElement.scrollWidth, vw, bad: [...new Set(bad)].slice(0, 6) };
      });
      check(`layout ${w}px ${scheme}: no horizontal scroll`, r.sw <= r.vw, `scrollWidth ${r.sw} vs ${r.vw}`);
      check(`layout ${w}px ${scheme}: no element escapes viewport`, r.bad.length === 0, r.bad.join(', '));
      // Text must not overflow its box inside cards (clipped numbers)
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.stat__value, .kv dd, .price-big, .portfolio__value, .fx__val, .holding__value b')]
        .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className + ':' + e.textContent));
      check(`layout ${w}px ${scheme}: no clipped figures`, clipped.length === 0, clipped.join(' | '));
      check(`layout ${w}px ${scheme}: no errors`, errors.length === 0, errors.join(' | '));
      if ([320, 768].includes(w)) await page.screenshot({ path: `${OUT}/r3-${w}-${scheme}.png`, fullPage: true });
      await ctx.close();
    }
  }

  // 2. Accessibility (axe-core, WCAG 2.1 AA) in both themes, plus interactive states
  for (const scheme of ['dark', 'light']) {
    const { ctx, page } = await open(browser, { colorScheme: scheme, reducedMotion: 'reduce' });
    await page.click('#tableToggle');
    await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(async () => {
      const r = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] });
      return r.violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' ; ')}`);
    });
    check(`axe ${scheme}: zero WCAG AA violations`, res.length === 0, '\n      ' + res.join('\n      '));
    await ctx.close();
  }

  // 3. Keyboard: every control reachable by Tab, focus is visible
  {
    const { ctx, page } = await open(browser, { reducedMotion: 'reduce' });
    const seen = new Set();
    let invisibleFocus = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const a = document.activeElement; if (!a || a === document.body) return null;
        const cs = getComputedStyle(a);
        const id = a.id || a.dataset.cur || a.dataset.view || a.dataset.range || a.dataset.p || a.getAttribute('aria-label') || a.tagName;
        return { id, visible: cs.outlineStyle !== 'none' || cs.boxShadow !== 'none' };
      });
      if (!info) continue;
      seen.add(info.id);
      if (!info.visible) invisibleFocus.push(info.id);
    }
    const must = ['USD', 'themeBtn', '24k', '999', 'gold', '90', 'tableToggle', 'Weight', 'addHolding'];
    const missing = must.filter((m) => ![...seen].some((s) => s === m));
    check('keyboard: all key controls reachable via Tab', missing.length === 0, `missing: ${missing.join(', ')}`);
    check('keyboard: focus ring visible on every stop', invisibleFocus.length === 0, [...new Set(invisibleFocus)].join(', '));
    // Arrow keys on radio-groups
    await page.focus('#currencySeg [data-cur="USD"]');
    await page.keyboard.press('ArrowRight');
    check('keyboard: arrows move currency', (await page.locator('#currencySeg [aria-checked="true"]').innerText()) === 'CAD');
    await page.focus('#metalTabs [data-view="gold"]');
    await page.keyboard.press('ArrowRight');
    check('keyboard: arrows move chart tab', (await page.locator('#metalTabs [aria-selected="true"]').innerText()) === 'Silver');
    await ctx.close();
  }

  // 4. With motion ON, the count-up animation lands exactly on the true value
  {
    const { ctx, page } = await open(browser, { reducedMotion: 'no-preference' });
    const before = await page.locator('#cardGold [data-price]').innerText();
    await page.click('#currencySeg [data-cur="INR"]');
    await page.waitForTimeout(150);
    const mid = await page.locator('#cardGold [data-price]').innerText();
    await page.waitForTimeout(900);
    await page.click('#currencySeg [data-cur="USD"]');
    await page.waitForTimeout(1000);
    check('motion: count-up returns to the exact value', (await page.locator('#cardGold [data-price]').innerText()) === before, `${before}`);
    check('motion: INR shown with ₹ during tween', mid.startsWith('₹'), mid);
    // rapid switching must not leave a stale number
    for (const c of ['CAD', 'INR', 'USD', 'CAD', 'INR', 'CAD']) await page.click(`#currencySeg [data-cur="${c}"]`);
    await page.waitForTimeout(1000);
    const final = await page.locator('#cardGold [data-price]').innerText();
    const ref = await page.locator('#ratesTable tbody tr:not(.group) td').nth(1).innerText(); // gold 24K /10g CAD
    check('motion: rapid currency switching settles on the right value', final === ref, `${final} vs ${ref}`);
    await ctx.close();
  }

  // 5. Live resize desktop → phone → desktop
  {
    const { ctx, page, errors } = await open(browser, { reducedMotion: 'reduce' });
    for (const w of [1366, 700, 390, 1100]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(250); }
    const svgW = await page.evaluate(() => document.querySelector('#chartPlot svg').getBoundingClientRect().width);
    const plotW = await page.evaluate(() => document.querySelector('#chartPlot').clientWidth);
    check('resize: chart redraws to container width', Math.abs(svgW - plotW) < 2, `${svgW} vs ${plotW}`);
    check('resize: no errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 6. Time zones & browser locales must not shift the date or break numbers
  for (const [timezoneId, locale] of [['Pacific/Kiritimati', 'de-DE'], ['America/Los_Angeles', 'en-US'], ['Asia/Kolkata', 'hi-IN'], ['Pacific/Pago_Pago', 'fr-CA']]) {
    const { ctx, page, errors } = await open(browser, { timezoneId, locale, reducedMotion: 'reduce' });
    const asOf = await page.locator('#asOf').innerText();
    const price = await page.locator('#cardGold [data-price]').innerText();
    check(`tz ${timezoneId}/${locale}: date stays ${EXP_DATE}`, asOf.toLowerCase().includes(EXP_DATE.toLowerCase()), asOf);
    check(`tz ${timezoneId}/${locale}: price format stable`, price.replace(/\s/g, '') === EXP_PRICE, price);
    check(`tz ${timezoneId}/${locale}: no errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 7. Windows High Contrast / forced colours renders
  {
    const { ctx, page, errors } = await open(browser, { forcedColors: 'active', reducedMotion: 'reduce' });
    await page.screenshot({ path: `${OUT}/r3-forced-colors.png` });
    check('forced-colors: renders without errors', errors.length === 0);
    await ctx.close();
  }

  // 8. Service worker (needs a secure origin → routed http://localhost, no real server)
  {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    await serve(ctx);
    const page = await ctx.newPage();
    const URL0 = 'http://localhost:65111/';
    await page.goto(URL0);
    let swOk = false, why = '';
    try {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload(); await page.waitForTimeout(1000); // second load fetches prices.json through the SW
      const r = await page.evaluate(async () => ({ data: !!(await caches.match('data/prices.json')), js: !!(await caches.match('assets/app.js')), keys: await caches.keys() }));
      swOk = r.data && r.js; why = JSON.stringify(r);
    } catch (e) { why = e.message.split('\n')[0]; }
    check('pwa: service worker installs and caches shell + data', swOk, why);
    // A new deploy must reach users who already have the SW installed (no stale-forever cache).
    await ctx.route('**/assets/styles.css', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(ROOT, 'assets/styles.css'), 'utf8') + '\n/* deploy-2 */' }));
    await page.reload(); await page.waitForTimeout(500);
    const fresh = await page.evaluate(() => fetch('assets/styles.css').then((r) => r.text()).then((t) => t.includes('deploy-2')));
    check('pwa: updated files reach installed users on next visit', fresh);
    await ctx.unroute('**/*');
    await ctx.setOffline(true);
    try {
      await page.reload({ timeout: 8000 });
      await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false', null, { timeout: 8000 });
      const price = await page.locator('#cardGold [data-price]').innerText();
      check('pwa: works offline with last known prices', price.replace(/\s/g, '') === EXP_PRICE && await page.locator('#banner').isHidden(), price);
    } catch (e) { check('pwa: works offline with last known prices', false, e.message.split('\n')[0]); }
    await ctx.close();
  }

  // 9. Page weight
  {
    const ctx = await browser.newContext(); await serve(ctx);
    const page = await ctx.newPage();
    let bytes = 0; page.on('response', async (r) => { try { bytes += (await r.body()).length; } catch {} });
    const t0 = Date.now();
    await page.goto('http://aurum.test/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.classList.contains('is-ready'));
    const ms = Date.now() - t0;
    check('perf: total transfer < 250 KB (excl. web fonts)', bytes < 250e3, `${Math.round(bytes / 1024)} KB`);
    check('perf: interactive < 1.5 s', ms < 1500, `${ms} ms`);
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nROUND 3: ${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
})();
