/* Aurum — gold & silver price tracker.  Zero-dependency, vanilla JS. */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  const OZ_G = 31.1034768; // grams per troy ounce
  const CUR = {
    USD: { sym: '$', loc: 'en-US', fx: () => 1, name: 'US dollar' },
    CAD: { sym: 'C$', loc: 'en-CA', fx: (r) => r.cad, name: 'Canadian dollar' },
    INR: { sym: '₹', loc: 'en-IN', fx: (r) => r.inr, name: 'Indian rupee' },
  };
  const CURS = Object.keys(CUR);
  const PURITY = {
    gold: [
      { id: '24k', label: '24K', fine: 0.999, spec: '999 fine' },
      { id: '22k', label: '22K', fine: 0.916, spec: '916 fine' },
      { id: '18k', label: '18K', fine: 0.750, spec: '750 fine' },
    ],
    silver: [
      { id: '999', label: '999', fine: 0.999, spec: 'Fine silver' },
      { id: '925', label: '925', fine: 0.925, spec: 'Sterling' },
    ],
  };
  const METAL = {
    gold: { name: 'Gold', sym: 'Au', key: 'xau', unitG: 10, unit: '10 g', color: 'var(--series-gold)' },
    silver: { name: 'Silver', sym: 'Ag', key: 'xag', unitG: 1000, unit: 'kg', color: 'var(--series-silver)' },
  };
  const UNITS = [
    { id: 'g', label: 'grams', g: 1 },
    { id: '10g', label: '× 10 g', g: 10 },
    { id: 'kg', label: 'kg', g: 1000 },
    { id: 'tola', label: 'tola', g: 11.6638038 },
    { id: 'ozt', label: 'troy oz', g: OZ_G },
  ];
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------------
  // State (persisted per device — a convenience, never required)
  // ------------------------------------------------------------------
  const STORE_KEY = 'aurum.state.v1';
  const defaults = {
    cur: 'USD', view: 'gold', range: 90,
    purity: { gold: '24k', silver: '999' },
    holdings: [
      { id: uid(), metal: 'gold', purity: '22k', qty: 50, unit: 'g' },
      { id: uid(), metal: 'silver', purity: '999', qty: 1, unit: 'kg' },
    ],
  };
  const state = Object.assign({}, defaults, load());
  state.purity = Object.assign({}, defaults.purity, state.purity);
  // Sanitise anything read back from storage (older versions, manual edits, corruption).
  if (!CUR[state.cur]) state.cur = 'USD';
  if (!['gold', 'silver', 'ratio', 'compare'].includes(state.view)) state.view = 'gold';
  if (![7, 30, 90, 180, 365, 0].includes(state.range)) state.range = 90;
  for (const m of ['gold', 'silver']) if (!PURITY[m].some((p) => p.id === state.purity[m])) state.purity[m] = PURITY[m][0].id;
  state.holdings = (Array.isArray(state.holdings) ? state.holdings : [])
    .filter((x) => x && METAL[x.metal])
    .map((x) => ({
      id: typeof x.id === 'string' ? x.id : uid(),
      metal: x.metal,
      purity: PURITY[x.metal].some((p) => p.id === x.purity) ? x.purity : PURITY[x.metal][0].id,
      qty: Number.isFinite(+x.qty) && +x.qty >= 0 ? +x.qty : 0,
      unit: UNITS.some((u) => u.id === x.unit) ? x.unit : 'g',
    }));

  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode */ } }
  function uid() { return Math.random().toString(36).slice(2, 9); }

  let DATA = null;   // full series, ascending
  let LAST = null;   // latest row
  let PREV = null;   // previous row

  // ------------------------------------------------------------------
  // Pricing maths
  // ------------------------------------------------------------------
  const fine = (metal, id) => (PURITY[metal].find((p) => p.id === id) || PURITY[metal][0]).fine;
  const purityOf = (metal, id) => PURITY[metal].find((p) => p.id === id) || PURITY[metal][0];
  /** Price per gram of the alloy (fine content × spot) in a currency. */
  const perGram = (row, metal, cur, f = 1) => (row[METAL[metal].key] / OZ_G) * f * CUR[cur].fx(row);
  /** Headline price: gold per 10 g, silver per kg. */
  const headline = (row, metal, cur, f) => perGram(row, metal, cur, f) * METAL[metal].unitG;
  const ratio = (row) => row.xau / row.xag;
  const pct = (a, b) => (b ? (a / b - 1) * 100 : 0);

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------
  const nfCache = new Map();
  function nf(loc, dp) {
    const k = loc + dp;
    if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat(loc, { minimumFractionDigits: dp, maximumFractionDigits: dp }));
    return nfCache.get(k);
  }
  const autoDp = (v, cur) => (cur === 'INR' ? (Math.abs(v) < 100 ? 2 : 0) : (Math.abs(v) >= 100000 ? 0 : 2));
  function money(v, cur, dp = autoDp(v, cur)) { const c = CUR[cur]; return (v < 0 ? '−' : '') + c.sym + nf(c.loc, dp).format(Math.abs(v)); }
  function signedMoney(v, cur) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + CUR[cur].sym + nf(CUR[cur].loc, autoDp(v, cur)).format(Math.abs(v)); }
  function signedPct(v, dp = 2) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + nf('en-US', dp).format(Math.abs(v)) + '%'; }
  const num = (v, dp = 2) => nf('en-US', dp).format(v);
  const dParse = (s) => new Date(s + 'T12:00:00Z');
  const fmtDate = (s, o = { day: 'numeric', month: 'short', year: 'numeric' }) => dParse(s).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
  const dir = (v) => (Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down');

  // ------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    if (tag === 'button') el.type = 'button';
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  function s(tag, attrs = {}) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    return el;
  }
  const arrow = (d) => {
    const svg = s('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' });
    svg.append(s('path', { d: d === 'up' ? 'M6 2 10.5 8.5h-9Z' : d === 'down' ? 'M6 10 1.5 3.5h9Z' : 'M2 6h8', fill: d === 'flat' ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': d === 'flat' ? 2 : 0 }));
    return svg;
  };
  function deltaChip(p) {
    const d = dir(p);
    return h('span', { class: `delta delta--${d}`, 'aria-label': `${d === 'up' ? 'Up' : d === 'down' ? 'Down' : 'Unchanged'} ${num(Math.abs(p))} percent` }, arrow(d), signedPct(p));
  }

  /** Animate a number into an element (count-up), honouring reduced motion. */
  function tweenNumber(el, to, render) {
    const from = parseFloat(el.dataset.v);
    el.dataset.v = to;
    if (REDUCED || !Number.isFinite(from) || from === to) { render(to); return; }
    const t0 = performance.now(), dur = 650;
    cancelAnimationFrame(el._raf);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      render(from + (to - from) * e);
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------
  // Header controls
  // ------------------------------------------------------------------
  function syncCurrencySeg() {
    const seg = $('#currencySeg');
    seg.querySelectorAll('button').forEach((b, i) => {
      const on = b.dataset.cur === state.cur;
      b.setAttribute('aria-checked', on);
      b.tabIndex = on ? 0 : -1;
      if (on) $('.seg__thumb', seg).style.transform = `translateX(${i * 100}%)`;
    });
  }
  $('#currencySeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cur]'); if (!b) return;
    state.cur = b.dataset.cur; save(); syncCurrencySeg(); renderAll();
  });
  $('#currencySeg').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = (CURS.indexOf(state.cur) + (e.key === 'ArrowRight' ? 1 : CURS.length - 1)) % CURS.length;
    state.cur = CURS[i]; save(); syncCurrencySeg(); renderAll();
    $(`#currencySeg [data-cur="${state.cur}"]`).focus();
  });

  $('#themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('aurum.theme', next); } catch { /* ignore */ }
    const meta = document.querySelectorAll('meta[name="theme-color"]');
    meta.forEach((m) => m.setAttribute('content', next === 'dark' ? '#0E0D0B' : '#F6F2EA'));
  });

  // ------------------------------------------------------------------
  // Hero metal cards
  // ------------------------------------------------------------------
  function renderMetalCard(metal) {
    const card = $(metal === 'gold' ? '#cardGold' : '#cardSilver');
    const cur = state.cur, M = METAL[metal], P = purityOf(metal, state.purity[metal]);
    const now = headline(LAST, metal, cur, P.fine);
    const prev = headline(PREV, metal, cur, P.fine);
    const chg = now - prev, chgPct = pct(now, prev);
    const d30 = DATA[Math.max(0, DATA.length - 31)];
    const chg30 = pct(now, headline(d30, metal, cur, P.fine));

    // Build once, then update in place so the count-up animation has a stable node.
    if (!card.dataset.built) {
      card.dataset.built = '1';
      card.append(
        h('div', { class: 'metal__top' },
          h('div', { class: 'metal__id' },
            h('div', { class: 'coin', 'aria-hidden': 'true', text: M.sym }),
            h('div', {}, h('div', { class: 'metal__name', text: M.name }), h('div', { class: 'metal__spec', 'data-spec': '' }))),
          h('div', { class: 'purity', role: 'group', 'aria-label': `${M.name} purity` },
            PURITY[metal].map((p) => h('button', { 'data-p': p.id, text: p.label, onclick: () => { state.purity[metal] = p.id; save(); renderAll(); } })))),
        h('div', { class: 'metal__price' },
          h('span', { class: 'price-big', 'data-price': '' }),
          h('span', { class: 'price-unit', text: `/ ${M.unit}` })),
        h('div', { class: 'metal__delta', 'data-delta': '' }),
        h('div', { class: 'metal__spark', 'data-spark': '' }),
        h('dl', { class: 'metal__foot', 'data-foot': '' }),
      );
    }
    card.querySelectorAll('.purity button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.p === P.id));
    $('[data-spec]', card).textContent = metal === 'gold' ? `${P.label} · ${P.spec.replace(' fine', '')} · per ${M.unit}` : `${P.spec} · per ${M.unit}`;

    const priceEl = $('[data-price]', card);
    if (priceEl.dataset.cur !== cur) { delete priceEl.dataset.v; priceEl.dataset.cur = cur; }
    tweenNumber(priceEl, now, (v) => {
      const str = money(v, cur).replace(CUR[cur].sym, '');
      const [int, dec] = str.split('.');
      priceEl.replaceChildren(h('span', { class: 'cur', text: CUR[cur].sym }), int, dec ? h('span', { class: 'dec', text: '.' + dec }) : '');
    });
    priceEl.setAttribute('aria-label', `${M.name} ${P.label} ${money(now, cur)} per ${M.unit}`);

    $('[data-delta]', card).replaceChildren(
      deltaChip(chgPct),
      h('span', { text: `${signedMoney(chg, cur)} since ${fmtDate(PREV.d, { day: 'numeric', month: 'short' })}` }));

    sparkline($('[data-spark]', card), DATA.slice(-30).map((r) => headline(r, metal, cur, P.fine)), metal);

    const g = perGram(LAST, metal, cur, P.fine);
    const spotOz = LAST[M.key] * CUR[cur].fx(LAST);
    $('[data-foot]', card).replaceChildren(
      kv(metal === 'gold' ? 'Per gram' : 'Per 10 g', money(metal === 'gold' ? g : g * 10, cur)),
      kv('30 days', signedPct(chg30)),
      kv('Spot / oz', money(spotOz, cur)));
  }
  const metal_label = (metal, p) => (metal === 'gold' ? `${p.label} (${p.spec.replace(' fine', '')})` : `${p.label} ${p.spec.replace('Fine silver', 'fine')}`);
  const kv = (k, v) => h('div', { class: 'kv' }, h('dt', { text: k }), h('dd', { text: v }));

  function sparkline(host, vals, metal) {
    const W = 300, H = 64, pad = 4;
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const pts = vals.map((v, i) => [pad + (i / (vals.length - 1)) * (W - pad * 2), pad + (1 - (v - min) / span) * (H - pad * 2)]);
    const line = smoothPath(pts);
    const id = `sg-${metal}`;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const defs = s('defs');
    const lg = s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
    lg.append(s('stop', { offset: 0, style: 'stop-color:var(--accent);stop-opacity:.28' }), s('stop', { offset: 1, style: 'stop-color:var(--accent);stop-opacity:0' }));
    defs.append(lg); svg.append(defs);
    svg.append(s('path', { d: `${line} L${pts.at(-1)[0]},${H} L${pts[0][0]},${H} Z`, fill: `url(#${id})` }));
    svg.append(s('path', { d: line, fill: 'none', style: 'stroke:var(--accent)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    host.replaceChildren(svg);
    // End-point dot as HTML so it stays round under preserveAspectRatio="none".
    const [ex, ey] = pts.at(-1);
    host.style.position = 'relative';
    host.append(h('span', { style: `position:absolute;left:calc(${(ex / W) * 100}% - 4px);top:calc(${(ey / H) * 100}% - 4px);width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--surface),0 0 12px var(--accent)` }));
  }

  /** Monotone cubic interpolation (Fritsch–Carlson): smooth but never overshoots a data point. */
  function smoothPath(p) {
    const n = p.length;
    if (n < 3) return p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(2) + ',' + q[1].toFixed(2)).join('');
    const dx = [], dy = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; dy[i] = p[i + 1][1] - p[i][1]; m[i] = dy[i] / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
    let d = `M${p[0][0].toFixed(2)},${p[0][1].toFixed(2)}`;
    for (let i = 0; i < n - 1; i++) {
      const c = dx[i] / 3;
      d += `C${(p[i][0] + c).toFixed(2)},${(p[i][1] + t[i] * c).toFixed(2)} ${(p[i + 1][0] - c).toFixed(2)},${(p[i + 1][1] - t[i + 1] * c).toFixed(2)} ${p[i + 1][0].toFixed(2)},${p[i + 1][1].toFixed(2)}`;
    }
    return d;
  }

  // ------------------------------------------------------------------
  // Rate sheet
  // ------------------------------------------------------------------
  function renderRates() {
    const t = $('#ratesTable');
    const head = h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: 'Product' }),
      CURS.map((c) => h('th', { scope: 'col', class: c === state.cur ? 'is-active' : null, text: c })),
      h('th', { scope: 'col', text: `1D (${state.cur})` })));
    const rows = [];
    const group = (label) => rows.push(h('tr', { class: 'group' }, h('td', { colspan: CURS.length + 2, text: label })));
    const item = (metal, pid, unitG, unitLabel) => {
      const P = purityOf(metal, pid);
      const val = (row, c) => perGram(row, metal, c, P.fine) * unitG;
      const ch = pct(val(LAST, state.cur), val(PREV, state.cur));
      rows.push(h('tr', {},
        h('th', { scope: 'row' }, h('span', { class: 'row-label' }, h('span', { class: `swatch swatch--${metal}`, 'aria-hidden': 'true' }), `${METAL[metal].name} ${P.label}`, h('small', { text: `${P.spec} · ${unitLabel}` }))),
        CURS.map((c) => h('td', { class: c === state.cur ? 'is-active' : null, text: money(val(LAST, c), c) })),
        h('td', {}, deltaChip(ch))));
    };
    group('Gold · per 10 grams');
    PURITY.gold.forEach((p) => item('gold', p.id, 10, '10 g'));
    group('Gold · per gram');
    PURITY.gold.forEach((p) => item('gold', p.id, 1, '1 g'));
    group('Silver · per kilogram');
    PURITY.silver.forEach((p) => item('silver', p.id, 1000, '1 kg'));
    group('Silver · per 10 grams');
    PURITY.silver.forEach((p) => item('silver', p.id, 10, '10 g'));
    t.replaceChildren(h('caption', { class: 'sr-only', style: 'position:absolute;left:-9999px', text: `Gold and silver rates on ${fmtDate(LAST.d)}` }), head, h('tbody', {}, rows));
    // Row headers styled like cells
    t.querySelectorAll('tbody th').forEach((th) => { th.style.textAlign = 'left'; th.style.fontWeight = '500'; th.style.padding = ''; });

    $('#fxStrip').replaceChildren(
      fxItem('USD / CAD', num(LAST.cad, 4)),
      fxItem('USD / INR', num(LAST.inr, 2)),
      fxItem('CAD / INR', num(LAST.inr / LAST.cad, 2)));
  }
  const fxItem = (pair, v) => h('div', { class: 'fx__item' }, h('span', { class: 'fx__pair', text: pair }), h('span', { class: 'fx__val', text: v }));

  // ------------------------------------------------------------------
  // Chart section
  // ------------------------------------------------------------------
  function rangeSlice() { return state.range ? DATA.slice(-(state.range + 1)) : DATA; }

  function chartModel() {
    const rows = rangeSlice(), cur = state.cur;
    const gf = fine('gold', state.purity.gold), sf = fine('silver', state.purity.silver);
    const gP = purityOf('gold', state.purity.gold), sP = purityOf('silver', state.purity.silver);
    switch (state.view) {
      case 'silver': return {
        rows, sub: `Silver ${sP.label} · ${cur} per kilogram · daily close`,
        series: [{ name: `Silver ${sP.label}`, short: 'Ag', color: METAL.silver.color, vals: rows.map((r) => headline(r, 'silver', cur, sf)) }],
        fmt: (v) => money(v, cur), axis: (v) => money(v, cur, cur === 'INR' || v >= 1000 ? 0 : 2),
      };
      case 'ratio': return {
        rows, sub: 'Ounces of silver one ounce of gold buys · currency-neutral',
        series: [{ name: 'Gold/Silver ratio', short: 'Ratio', color: 'var(--series-gold)', vals: rows.map(ratio) }],
        fmt: (v) => num(v, 2), axis: (v) => num(v, 0),
      };
      case 'compare': {
        const g0 = headline(rows[0], 'gold', cur, 1), s0 = headline(rows[0], 'silver', cur, 1);
        return {
          rows, indexed: true, sub: `Performance indexed to 100 at ${fmtDate(rows[0].d)} · in ${cur}`,
          series: [
            { name: 'Gold', short: 'Au', color: METAL.gold.color, vals: rows.map((r) => (headline(r, 'gold', cur, 1) / g0) * 100) },
            { name: 'Silver', short: 'Ag', color: METAL.silver.color, vals: rows.map((r) => (headline(r, 'silver', cur, 1) / s0) * 100) },
          ],
          fmt: (v) => num(v, 1), axis: (v) => num(v, 0),
        };
      }
      default: return {
        rows, sub: `Gold ${gP.label} · ${cur} per 10 grams · daily close`,
        series: [{ name: `Gold ${gP.label}`, short: 'Au', color: METAL.gold.color, vals: rows.map((r) => headline(r, 'gold', cur, gf)) }],
        fmt: (v) => money(v, cur), axis: (v) => money(v, cur, cur === 'INR' || v >= 1000 ? 0 : 2),
      };
    }
  }

  function renderChartSection(animate = true) {
    const model = chartModel();
    $('#chartSub').textContent = model.sub;
    $('#metalTabs').querySelectorAll('button').forEach((b) => { const on = b.dataset.view === state.view; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    $('#rangeChips').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', +b.dataset.range === state.range));

    // Legend only for >1 series (single series is named by the subtitle).
    const legend = $('#chartLegend');
    legend.replaceChildren(...(model.series.length > 1 ? model.series.map((sr) => h('span', {}, h('i', { style: `background:${sr.color}` }), sr.name)) : []));

    renderRangeStats(model);
    drawChart($('#chartPlot'), model, animate);
    if (!$('#historyWrap').hidden) renderHistoryTable();
  }

  function renderRangeStats(model) {
    const box = $('#rangeStats'), rows = model.rows;
    const stat = (label, value, sub, cls) => h('div', { class: 'stat' }, h('div', { class: 'stat__label', text: label }), h('div', { class: `stat__value ${cls || ''}`, text: value }), h('div', { class: 'stat__sub', text: sub || ' ' }));
    const spanFmt = rows[0].d.slice(0, 4) !== rows.at(-1).d.slice(0, 4) ? { day: 'numeric', month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' };
    const span = `${fmtDate(rows[0].d, spanFmt)} – ${fmtDate(rows.at(-1).d, spanFmt)}`;
    if (model.indexed) {
      const [g, sv] = model.series.map((sr) => sr.vals.at(-1) - 100);
      const r0 = ratio(rows[0]), r1 = ratio(rows.at(-1));
      box.replaceChildren(
        stat('Gold return', signedPct(g), span, dir(g)),
        stat('Silver return', signedPct(sv), span, dir(sv)),
        stat('Leader', g >= sv ? 'Gold' : 'Silver', `by ${num(Math.abs(g - sv), 2)} pts`),
        stat('Ratio shift', `${num(r0, 1)} → ${num(r1, 1)}`, signedPct(pct(r1, r0))));
      return;
    }
    const v = model.series[0].vals;
    let hi = 0, lo = 0;
    v.forEach((x, i) => { if (x > v[hi]) hi = i; if (x < v[lo]) lo = i; });
    const chg = v.at(-1) - v[0], avg = v.reduce((a, b) => a + b, 0) / v.length;
    const isRatio = state.view === 'ratio';
    box.replaceChildren(
      stat('Change', signedPct(pct(v.at(-1), v[0])), isRatio ? `${chg >= 0 ? '+' : '−'}${num(Math.abs(chg), 2)} pts` : signedMoney(chg, state.cur), dir(chg)),
      stat('High', model.fmt(v[hi]), fmtDate(rows[hi].d)),
      stat('Low', model.fmt(v[lo]), fmtDate(rows[lo].d)),
      stat('Average', model.fmt(avg), span));
  }

  // --- the chart itself -------------------------------------------------
  let chartState = null;
  function drawChart(host, model, animate) {
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    const narrow = W < 520;
    const M = { t: 16, r: narrow ? 62 : 82, b: 28, l: 2 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const rows = model.rows, n = rows.length;
    const all = model.series.flatMap((sr) => sr.vals);
    let min = Math.min(...all), max = Math.max(...all);
    const padV = (max - min) * 0.14 || max * 0.01 || 1;
    min -= padV; max += padV;
    const ticks = niceTicks(min, max, narrow ? 4 : 5);
    const x = (i) => M.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => M.t + (1 - (v - min) / (max - min)) * ih;

    const svg = s('svg', { role: 'img', tabindex: 0, 'aria-label': `${model.sub}. ${model.series.map((sr) => `${sr.name}: ${model.fmt(sr.vals[0])} to ${model.fmt(sr.vals.at(-1))}`).join('; ')}. Use arrow keys to inspect days.` });
    const defs = s('defs');
    svg.append(defs);

    // Grid + y-axis (right)
    const grid = s('g', { class: 'grid' }), axis = s('g', { class: 'axis' });
    ticks.forEach((tv) => {
      const yy = Math.round(y(tv)) + 0.5;
      if (yy < M.t - 2 || yy > M.t + ih + 2) return;
      grid.append(s('line', { x1: M.l, x2: M.l + iw, y1: yy, y2: yy }));
      const tx = s('text', { x: M.l + iw + 10, y: yy + 4 }); tx.textContent = model.axis(tv); axis.append(tx);
    });
    if (model.indexed && 100 > min && 100 < max) {
      const yy = Math.round(y(100)) + 0.5;
      grid.append(s('line', { x1: M.l, x2: M.l + iw, y1: yy, y2: yy, style: 'stroke:var(--line-strong)' }));
    }
    // X ticks
    const xt = narrow ? 3 : 5;
    for (let k = 0; k < xt; k++) {
      const i = Math.round((k / (xt - 1)) * (n - 1));
      const long = n > 200;
      const tx = s('text', { x: x(i), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === xt - 1 ? 'end' : 'middle' });
      tx.textContent = fmtDate(rows[i].d, long ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });
      axis.append(tx);
    }
    svg.append(grid, axis);

    // Series
    const lines = [];
    model.series.forEach((sr, si) => {
      const pts = sr.vals.map((v, i) => [x(i), y(v)]);
      const d = smoothPath(pts);
      const gid = `ag${si}`;
      const lg = s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      lg.append(s('stop', { offset: 0, style: `stop-color:${sr.color};stop-opacity:${model.series.length > 1 ? 0.08 : 0.16}` }), s('stop', { offset: 1, style: `stop-color:${sr.color};stop-opacity:0` }));
      defs.append(lg);
      const area = s('path', { d: `${d} L${pts.at(-1)[0]},${M.t + ih} L${pts[0][0]},${M.t + ih} Z`, fill: `url(#${gid})` });
      const line = s('path', { d, fill: 'none', style: `stroke:${sr.color}`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      svg.append(area, line);
      lines.push({ line, area, pts });
    });

    // End markers + value pills (direct labels)
    const pillFmt = model.indexed || state.view === 'ratio' ? model.fmt : model.axis;
    const pills = model.series.map((sr, si) => ({ sr, si, y: lines[si].pts.at(-1)[1], text: (model.series.length > 1 ? sr.short + ' ' : '') + pillFmt(sr.vals.at(-1)) }));
    pills.sort((a, b) => a.y - b.y);
    for (let i = 1; i < pills.length; i++) if (pills[i].y - pills[i - 1].y < 22) pills[i].y = pills[i - 1].y + 22;
    pills.forEach((p) => {
      const [ex, ey] = lines[p.si].pts.at(-1);
      svg.append(s('circle', { cx: ex, cy: ey, r: 4.5, style: `fill:${p.sr.color};stroke:var(--surface)`, 'stroke-width': 2 }));
      const g = s('g', { class: 'last-pill' });
      const txt = s('text', { x: M.l + iw + 14, y: p.y + 4 }); txt.textContent = p.text;
      const w = Math.max(40, p.text.length * 6.9 + 14);
      g.append(s('rect', { x: M.l + iw + 6, y: p.y - 10, width: Math.min(w, M.r - 4), height: 20, rx: 6 }), txt);
      g.append(s('rect', { x: M.l + iw + 6, y: p.y - 10, width: 3, height: 20, rx: 1.5, style: `fill:${p.sr.color}` }));
      svg.append(g);
    });

    // Hover layer
    const hover = s('g', { style: 'opacity:0;pointer-events:none' });
    const vline = s('line', { class: 'crosshair', y1: M.t, y2: M.t + ih });
    hover.append(vline);
    const dots = model.series.map((sr) => { const c = s('circle', { r: 5, style: `fill:${sr.color};stroke:var(--surface)`, 'stroke-width': 2 }); hover.append(c); return c; });
    svg.append(hover);
    const hit = s('rect', { x: M.l, y: 0, width: iw, height: H, fill: 'transparent', style: 'cursor:crosshair' });
    svg.append(hit);

    host.replaceChildren(svg);

    const tip = $('#tooltip');
    const chartBox = $('#chart');
    let idx = n - 1;
    function show(i) {
      idx = Math.max(0, Math.min(n - 1, i));
      const xx = x(idx);
      vline.setAttribute('x1', xx); vline.setAttribute('x2', xx);
      dots.forEach((c, si) => { c.setAttribute('cx', xx); c.setAttribute('cy', lines[si].pts[idx][1]); });
      hover.style.opacity = 1;
      tip.replaceChildren(
        h('div', { class: 'tooltip__date', text: fmtDate(rows[idx].d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) }),
        ...model.series.map((sr) => h('div', { class: 'tooltip__row' },
          h('span', { class: 'tooltip__val', text: model.fmt(sr.vals[idx]) }),
          h('span', { class: 'tooltip__name' }, h('i', { style: `background:${sr.color}` }), sr.name))),
        idx > 0 && !model.indexed ? h('div', { class: 'tooltip__row', style: 'margin-top:8px' }, h('span', { class: 'tooltip__name', text: 'vs prior day' }), deltaChip(pct(model.series[0].vals[idx], model.series[0].vals[idx - 1]))) : null);
      tip.hidden = false;
      const hostRect = host.getBoundingClientRect(), boxRect = chartBox.getBoundingClientRect();
      const tw = tip.offsetWidth;
      let left = hostRect.left - boxRect.left + xx + 16;
      if (left + tw > boxRect.width) left = hostRect.left - boxRect.left + xx - tw - 16;
      tip.style.transform = `translate(${Math.max(0, left)}px, ${hostRect.top - boxRect.top + 8}px)`;
    }
    function hide() { hover.style.opacity = 0; tip.hidden = true; }
    const idxAt = (clientX) => { const r = svg.getBoundingClientRect(); return Math.round(((clientX - r.left - M.l) / iw) * (n - 1)); };
    hit.addEventListener('pointermove', (e) => show(idxAt(e.clientX)));
    hit.addEventListener('pointerdown', (e) => show(idxAt(e.clientX)));
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(idx));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const map = { ArrowLeft: -1, ArrowRight: 1, PageUp: -7, PageDown: 7 };
      if (e.key in map) { e.preventDefault(); show(idx + map[e.key]); }
      else if (e.key === 'Home') { e.preventDefault(); show(0); }
      else if (e.key === 'End') { e.preventDefault(); show(n - 1); }
      else if (e.key === 'Escape') hide();
    });

    // Draw-in animation
    if (animate && !REDUCED) {
      lines.forEach(({ line, area }) => {
        const len = line.getTotalLength();
        line.style.strokeDasharray = `${len} ${len}`;
        line.style.strokeDashoffset = len;
        area.style.opacity = 0;
        line.getBoundingClientRect();
        line.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)';
        area.style.transition = 'opacity .9s ease .35s';
        requestAnimationFrame(() => { line.style.strokeDashoffset = 0; area.style.opacity = 1; });
        line.addEventListener('transitionend', () => { line.style.strokeDasharray = ''; }, { once: true });
      });
    }
    chartState = { model };
  }

  function niceTicks(min, max, count) {
    const span = max - min, raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }

  // History table (accessible alternative to the chart)
  function renderHistoryTable() {
    const cur = state.cur, gP = purityOf('gold', state.purity.gold), sP = purityOf('silver', state.purity.silver);
    const rows = rangeSlice().slice().reverse();
    $('#historyTable').replaceChildren(
      h('thead', {}, h('tr', {}, ['Date', `Gold ${gP.label} / 10 g`, `Silver ${sP.label} / kg`, 'Au/Ag ratio', 'USD/CAD', 'USD/INR'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { text: fmtDate(r.d) }),
        h('td', { text: money(headline(r, 'gold', cur, gP.fine), cur) }),
        h('td', { text: money(headline(r, 'silver', cur, sP.fine), cur) }),
        h('td', { text: num(ratio(r), 2) }),
        h('td', { text: num(r.cad, 4) }),
        h('td', { text: num(r.inr, 2) })))));
  }
  $('#tableToggle').addEventListener('click', (e) => {
    const wrap = $('#historyWrap'), open = wrap.hidden;
    wrap.hidden = !open; e.currentTarget.setAttribute('aria-expanded', open);
    e.currentTarget.textContent = open ? 'Hide table' : 'View as table';
    if (open) renderHistoryTable();
  });

  $('#metalTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (!b) return; state.view = b.dataset.view; save(); renderChartSection(); });
  $('#metalTabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const views = [...$('#metalTabs').querySelectorAll('button')].map((b) => b.dataset.view);
    const i = (views.indexOf(state.view) + (e.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length;
    state.view = views[i]; save(); renderChartSection(); $(`#metalTabs [data-view="${state.view}"]`).focus();
  });
  $('#rangeChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-range]'); if (!b) return; state.range = +b.dataset.range; save(); renderChartSection(); });

  let rz;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (DATA) { drawChart($('#chartPlot'), chartModel(), false); } }); }).observe($('#chartPlot'));

  // ------------------------------------------------------------------
  // Insights
  // ------------------------------------------------------------------
  function renderInsights() {
    const cur = state.cur;
    const year = DATA.filter((r) => r.d > shiftDate(LAST.d, -365));
    const items = [];
    ['gold', 'silver'].forEach((metal) => {
      const P = purityOf(metal, state.purity[metal]);
      const vals = year.map((r) => headline(r, metal, cur, P.fine));
      let hi = 0, lo = 0; vals.forEach((v, i) => { if (v > vals[hi]) hi = i; if (v < vals[lo]) lo = i; });
      const now = vals.at(-1), posPct = ((now - vals[lo]) / (vals[hi] - vals[lo] || 1)) * 100;
      const offHigh = pct(now, vals[hi]);
      items.push(h('div', { class: 'insight', style: `--accent:${METAL[metal].color}` },
        h('div', { class: 'insight__head' },
          h('span', { class: 'insight__title' }, h('span', { class: `swatch swatch--${metal}`, 'aria-hidden': 'true' }), `${METAL[metal].name} · 52-week range`),
          h('span', { class: 'insight__value', text: `${num(posPct, 0)}% of range` })),
        h('div', { class: 'range-meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(posPct), 'aria-label': `${METAL[metal].name} position in 52-week range` },
          h('div', { class: 'range-meter__fill', style: `width:${posPct}%` }),
          h('div', { class: 'range-meter__dot', style: `left:${posPct}%` })),
        h('div', { class: 'range-meter__ends' }, h('span', { text: `Low ${money(vals[lo], cur)}` }), h('span', { text: `High ${money(vals[hi], cur)}` })),
        h('p', { text: Math.abs(offHigh) < 0.05
          ? `${METAL[metal].name} ${P.label} is at its 52-week high today.`
          : `${METAL[metal].name} ${P.label} is ${num(Math.abs(offHigh), 1)}% below its 52-week high, set on ${fmtDate(year[hi].d)}, and ${num(pct(now, vals[lo]), 1)}% above the low of ${fmtDate(year[lo].d)}.` })));
    });

    const rs = year.map(ratio), rNow = rs.at(-1), rAvg = rs.reduce((a, b) => a + b, 0) / rs.length;
    items.push(h('div', { class: 'insight' },
      h('div', { class: 'insight__head' }, h('span', { class: 'insight__title', text: 'Gold / silver ratio' }), deltaChip(pct(rNow, ratio(PREV)))),
      h('div', { class: 'ratio-big' }, num(rNow, 1), h('small', { text: `1Y avg ${num(rAvg, 1)}` })),
      h('p', { text: `One ounce of gold buys ${num(rNow, 1)} ounces of silver — ${rNow >= rAvg ? 'above' : 'below'} its one-year average, so silver is ${rNow >= rAvg ? 'cheaper' : 'dearer'} relative to gold than usual.` })));

    // Currency lens: the same metal, three home currencies.
    const y0 = year[0];
    items.push(h('div', { class: 'insight' },
      h('div', { class: 'insight__head' }, h('span', { class: 'insight__title', text: 'Currency lens · 1-year gold return' })),
      h('div', { style: 'display:grid;gap:8px' }, CURS.map((c) => {
        const r = pct(headline(LAST, 'gold', c, 1), headline(y0, 'gold', c, 1));
        return h('div', { style: 'display:flex;justify-content:space-between;align-items:center;font-variant-numeric:tabular-nums' },
          h('span', { style: `color:var(--ink-2);font-weight:${c === cur ? 700 : 500}`, text: `${c} · ${CUR[c].name}` }), deltaChip(r));
      })),
      h('p', { text: `Exchange-rate moves change what gold earns at home: the gap between the USD and INR figures is the rupee’s own move against the dollar.` })));
    $('#insights').replaceChildren(...items);
  }
  const shiftDate = (d, n) => { const t = dParse(d); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  // ------------------------------------------------------------------
  // Holdings calculator
  // ------------------------------------------------------------------
  const holdingValue = (hd, row, cur) => perGram(row, hd.metal, cur, fine(hd.metal, hd.purity)) * (+hd.qty || 0) * (UNITS.find((u) => u.id === hd.unit) || UNITS[0]).g;

  function renderHoldings() {
    const box = $('#holdings');
    box.replaceChildren(...state.holdings.map(holdingRow));
    updatePortfolio();
  }

  function holdingRow(hd) {
    const valueEl = h('b'), subEl = h('span');
    const purity = h('select', { 'aria-label': 'Purity', onchange: (e) => { hd.purity = e.target.value; commit(); } });
    const fillPurity = () => purity.replaceChildren(...PURITY[hd.metal].map((p) => h('option', { value: p.id, selected: p.id === hd.purity, text: metal_label(hd.metal, p) })));
    fillPurity();
    const row = h('div', { class: 'holding' },
      h('div', { class: 'field' }, h('select', { 'aria-label': 'Metal', onchange: (e) => { hd.metal = e.target.value; hd.purity = PURITY[hd.metal][0].id; fillPurity(); commit(); } },
        Object.entries(METAL).map(([k, m]) => h('option', { value: k, selected: k === hd.metal, text: m.name })))),
      h('div', { class: 'field' }, purity),
      h('div', { class: 'field field--weight' },
        h('input', { type: 'number', inputmode: 'decimal', min: 0, step: 'any', value: hd.qty, 'aria-label': 'Weight', oninput: (e) => { hd.qty = e.target.value === '' ? 0 : Math.max(0, +e.target.value); commit(); } }),
        h('select', { 'aria-label': 'Unit', onchange: (e) => { hd.unit = e.target.value; commit(); } }, UNITS.map((u) => h('option', { value: u.id, selected: u.id === hd.unit, text: u.label })))),
      h('button', { class: 'remove', 'aria-label': 'Remove holding', title: 'Remove', onclick: () => { state.holdings = state.holdings.filter((x) => x !== hd); save(); renderHoldings(); } },
        (() => { const sv = s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }); sv.append(s('path', { d: 'M6 6l12 12M18 6 6 18' })); return sv; })()),
      h('div', { class: 'holding__value' }, valueEl, subEl));
    const update = () => {
      const v = holdingValue(hd, LAST, state.cur);
      valueEl.textContent = money(v, state.cur);
      const grams = (+hd.qty || 0) * (UNITS.find((u) => u.id === hd.unit) || UNITS[0]).g;
      subEl.textContent = `${num(grams, grams < 100 ? 2 : 0)} g · ${num(grams * fine(hd.metal, hd.purity), grams < 100 ? 2 : 0)} g fine ${hd.metal}`;
    };
    function commit() { save(); update(); updatePortfolio(); }
    row._update = update;
    update();
    return row;
  }

  function updatePortfolio() {
    const cur = state.cur, H = state.holdings;
    const total = (row, c) => H.reduce((a, hd) => a + holdingValue(hd, row, c), 0);
    const now = total(LAST, cur), prev = total(PREV, cur);
    const fineG = (m) => H.filter((x) => x.metal === m).reduce((a, hd) => a + (+hd.qty || 0) * (UNITS.find((u) => u.id === hd.unit) || UNITS[0]).g * fine(hd.metal, hd.purity), 0);
    const valEl = h('div', { class: 'portfolio__value' });
    $('#portfolioTotal').replaceChildren(
      h('div', { class: 'portfolio__label', text: `Portfolio value · ${CUR[cur].name}` }),
      valEl,
      h('div', { class: 'portfolio__row' },
        H.length ? deltaChip(pct(now, prev)) : null,
        H.length ? h('span', { text: `${signedMoney(now - prev, cur)} today` }) : h('span', { text: 'Add a holding to see its value.' }),
        ...CURS.filter((c) => c !== cur).map((c) => h('span', {}, h('b', { text: money(total(LAST, c), c) }))),
        h('span', { text: `${num(fineG('gold'), 2)} g fine gold · ${num(fineG('silver'), 0)} g fine silver` })));
    valEl.textContent = money(now, cur);
  }

  $('#addHolding').addEventListener('click', () => {
    state.holdings.push({ id: uid(), metal: 'gold', purity: '24k', qty: 10, unit: 'g' });
    save(); renderHoldings();
    const inputs = $('#holdings').querySelectorAll('input'); inputs[inputs.length - 1]?.focus();
  });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function renderAll() {
    renderMetalCard('gold');
    renderMetalCard('silver');
    renderRates();
    renderChartSection(false);
    renderInsights();
    // Holding rows stay mounted (keeps focus); just refresh their numbers.
    $('#holdings').querySelectorAll('.holding').forEach((r) => r._update?.());
    updatePortfolio();
  }

  // ------------------------------------------------------------------
  // Refresh schedule — must match the cron entries in .github/workflows/daily-prices.yml
  // (tests/schedule.test.mjs enforces this).
  // ------------------------------------------------------------------
  const REFRESH_SLOTS_UTC = ['10:47', '13:47', '16:47'];

  /** Next run expected to bring new prices: today's next slot, or tomorrow's first once today's prices are in. */
  function nextRefresh(now, latestDay) {
    const today = now.toISOString().slice(0, 10);
    const slots = (day) => REFRESH_SLOTS_UTC.map((t) => new Date(`${day}T${t}:00Z`));
    const tomorrowFirst = slots(shiftDate(today, 1))[0];
    if (latestDay >= today) return tomorrowFirst;
    return slots(today).find((d) => d > now) || tomorrowFirst;
  }

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  function relative(date, now) {
    const mins = Math.round((date - now) / 6e4);
    if (Math.abs(mins) < 1) return 'just now';
    if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
    const hrs = Math.round(mins / 60);
    if (Math.abs(hrs) < 36) return rtf.format(hrs, 'hour');
    return rtf.format(Math.round(hrs / 24), 'day');
  }
  const fmtStamp = (d) => d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });

  let refreshTimer;
  function renderRefresh(meta) {
    const draw = () => {
      const now = new Date();
      const last = meta?.updatedAt ? new Date(meta.updatedAt) : null;
      const lastEl = $('#lastRefresh'), nextEl = $('#nextRefresh');
      if (last && !Number.isNaN(+last)) {
        lastEl.replaceChildren(fmtStamp(last), h('span', { class: 'rel', text: `(${relative(last, now)})` }));
        lastEl.title = last.toISOString();
      } else lastEl.textContent = fmtDate(LAST.d);
      const next = nextRefresh(now, LAST.d);
      nextEl.replaceChildren(fmtStamp(next), h('span', { class: 'rel', text: `(${relative(next, now)})` }));
      nextEl.title = `${next.toISOString()} — scheduled; GitHub may start runs a little late`;
    };
    draw();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(draw, 60e3);
  }

  function setAsOf(meta) {
    renderRefresh(meta);
    const ageDays = Math.round((Date.now() - dParse(LAST.d).getTime()) / 864e5);
    const stale = ageDays > 2;
    $('#asOf').textContent = `${stale ? 'Last fix' : 'Daily fix'} · ${fmtDate(LAST.d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`;
    if (stale) { $('.live-dot').style.background = 'var(--down)'; $('.live-dot').style.animation = 'none'; }
    $('#sourceNote').textContent = `Prices derive from the international spot price (USD per troy ounce) and daily FX reference rates, refreshed every day (scheduled ${REFRESH_SLOTS_UTC[0]} UTC, with retries at ${REFRESH_SLOTS_UTC.slice(1).join(' and ')} UTC). ${meta?.points ? `${meta.points.toLocaleString()} daily records since ${fmtDate(DATA[0].d)}.` : ''} Last updated ${meta?.updatedAt ? new Date(meta.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : fmtDate(LAST.d)}.`;
  }

  async function getData() {
    if (window.AURUM_DATA) return window.AURUM_DATA;
    const res = await fetch(`data/prices.json?d=${new Date().toISOString().slice(0, 10)}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function boot() {
    syncCurrencySeg();
    try {
      const json = await getData();
      DATA = (json.series || []).filter((r) => r && r.d && r.xau > 0 && r.xag > 0 && r.cad > 0 && r.inr > 0);
      if (DATA.length < 2) throw new Error('not enough data');
      LAST = DATA.at(-1); PREV = DATA.at(-2);
      setAsOf(json.meta);
      renderMetalCard('gold');
      renderMetalCard('silver');
      renderRates();
      renderChartSection(true);
      renderInsights();
      renderHoldings();
    } catch (err) {
      const b = $('#banner');
      b.hidden = false;
      b.textContent = `Couldn’t load price data (${err.message}). Please check your connection and refresh.`;
      $('#asOf').textContent = 'Offline';
    }
    $('#app').setAttribute('aria-busy', 'false');
    document.body.classList.add('is-ready');
  }

  boot();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !window.AURUM_DATA) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
