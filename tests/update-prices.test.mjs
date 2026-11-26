// Round 1 — data pipeline tests.  Run: node --test tests/
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import {
  iso, addDays, npmVersion, toRow, extractFromTgz, validateMoves, planDates, mergeSeries, serialize, main,
} from '../scripts/update-prices.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const snap = (date, { xau = 3500, xag = 40, cad = 1.4, inr = 92 } = {}) => ({ date, usd: { xau: 1 / xau, xag: 1 / xag, cad, inr } });
const row = (d, o = {}) => ({ d, xau: 3500, xag: 40, cad: 1.4, inr: 92, ...o });

describe('date helpers', () => {
  test('npmVersion strips leading zeros', () => {
    assert.equal(npmVersion('2026-01-05'), '2026.1.5');
    assert.equal(npmVersion('2025-12-31'), '2025.12.31');
  });
  test('addDays crosses month, year and leap boundaries', () => {
    assert.equal(addDays('2025-12-31', 1), '2026-01-01');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2026-11-25', -365), '2025-11-25');
  });
  test('iso is UTC', () => assert.equal(iso(new Date('2026-11-25T23:59:59-08:00')), '2026-11-26'));
});

describe('toRow', () => {
  test('inverts per-USD metal rates into USD/oz and rounds', () => {
    const r = toRow({ date: '2026-11-25', usd: { xau: 0.0002836801, xag: 0.024834312, cad: 1.42867319, inr: 92.29189267 } });
    assert.deepEqual(r, { d: '2026-11-25', xau: 3525.1, xag: 40.2669, cad: 1.42867, inr: 92.2919 });
  });
  for (const [k, v] of [['xau', 100], ['xau', 50000], ['xag', 2], ['cad', 5], ['inr', 10]]) {
    test(`rejects implausible ${k}=${v}`, () => assert.throws(() => toRow(snap('2026-01-01', { [k]: v })), /outside/));
  }
  test('rejects missing / non-numeric fields', () => {
    assert.throws(() => toRow({ date: '2026-01-01', usd: { xau: 0.0003, xag: 0.025, cad: 1.4 } }), /inr/);
    assert.throws(() => toRow({ date: '2026-01-01', usd: { xau: 'x', xag: 0.025, cad: 1.4, inr: 92 } }), /xau/);
  });
});

describe('extractFromTgz', () => {
  test('reads a file from a gzipped tar (system tar)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurum-tar-'));
    mkdirSync(join(dir, 'package/v1/currencies'), { recursive: true });
    writeFileSync(join(dir, 'package/v1/currencies/eur.min.json'), '{"x":1}');
    writeFileSync(join(dir, 'package/v1/currencies/usd.min.json'), JSON.stringify(snap('2026-11-25')));
    execFileSync('tar', ['-czf', join(dir, 't.tgz'), '-C', dir, 'package']);
    const buf = await readFile(join(dir, 't.tgz'));
    const out = JSON.parse(extractFromTgz(buf, 'package/v1/currencies/usd.min.json'));
    assert.equal(out.date, '2026-11-25');
    assert.throws(() => extractFromTgz(buf, 'package/nope.json'), /not found/);
    await rm(dir, { recursive: true });
  });
  const real = '/tmp/claude-0/-home-user-CricketClubmgmtplatform/f3ba5e7d-caec-505a-9e96-655259378283/scratchpad/dl/t.tgz';
  test('reads the real published npm tarball', { skip: !existsSync(real) && 'tarball not cached' }, async () => {
    const out = JSON.parse(extractFromTgz(await readFile(real), 'package/v1/currencies/usd.min.json'));
    assert.equal(out.date, '2026-11-25');
    assert.ok(out.usd.xau > 0 && out.usd.inr > 0);
  });
});

describe('validateMoves', () => {
  test('keeps ordinary moves', () => {
    const s = [row('2026-01-01'), row('2026-01-02', { xag: 49 }), row('2026-01-03', { xag: 45 })];
    assert.equal(validateMoves(s).length, 3);
  });
  test('drops an isolated spike that reverts', () => {
    const s = [row('2026-01-01'), row('2026-01-02', { xau: 9000 }), row('2026-01-03')];
    assert.deepEqual(validateMoves(s).map((r) => r.d), ['2026-01-01', '2026-01-03']);
  });
  test('keeps a genuine re-pricing confirmed by the next day (never freezes the feed)', () => {
    const s = [row('2026-01-01'), row('2026-01-02', { xag: 28 }), row('2026-01-03', { xag: 27.5 }), row('2026-01-04', { xag: 27 })];
    assert.equal(validateMoves(s).length, 4);
  });
  test('holds back an unconfirmed jump on the newest day', () => {
    const s = [row('2026-01-01'), row('2026-01-02', { inr: 150 })];
    assert.deepEqual(validateMoves(s).map((r) => r.d), ['2026-01-01']);
  });
  test('accepts the real 23.2% silver day from Jan 2026', () => {
    const s = [row('2026-01-30', { xag: 100 }), row('2026-01-31', { xag: 76.8 })];
    assert.equal(validateMoves(s).length, 2);
  });
});

describe('planDates', () => {
  const today = '2026-11-25';
  test('backfill N → N past days + latest', () => {
    const d = planDates({ today, backfill: 3 });
    assert.deepEqual(d, ['2026-11-22', '2026-11-23', '2026-11-24', 'latest']);
  });
  test('up-to-date history → only latest', () => assert.deepEqual(planDates({ today, series: [row('2026-11-25')] }), ['latest']));
  test('fills the gap since the last stored day', () => {
    assert.deepEqual(planDates({ today, series: [row('2026-11-21')] }), ['2026-11-22', '2026-11-23', '2026-11-24', 'latest']);
  });
  test('gap fill is capped', () => {
    const d = planDates({ today, series: [row('2020-01-01')], maxGap: 5 });
    assert.equal(d.length, 6);
    assert.equal(d[0], '2026-11-20');
  });
  test('empty history → capped window', () => assert.equal(planDates({ today, maxGap: 45 }).length, 46));
  test('--date', () => assert.deepEqual(planDates({ today, date: '2026-01-15' }), ['2026-01-15']));
});

describe('mergeSeries + serialize', () => {
  test('dedupes by date, newest fetch wins, sorted ascending', () => {
    const out = mergeSeries([row('2026-01-02'), row('2026-01-01')], [row('2026-01-02', { xau: 3510 }), row('2026-01-03')]);
    assert.deepEqual(out.map((r) => r.d), ['2026-01-01', '2026-01-02', '2026-01-03']);
    assert.equal(out[1].xau, 3510);
  });
  test('serialize is valid JSON with consistent meta, one row per line', () => {
    const s = [row('2026-01-01'), row('2026-01-02')];
    const text = serialize(s, new Date('2026-01-02T02:17:00Z'));
    const j = JSON.parse(text);
    assert.equal(j.meta.latest, '2026-01-02');
    assert.equal(j.meta.points, 2);
    assert.equal(j.meta.updatedAt, '2026-01-02T02:17:00.000Z');
    assert.equal(text.trim().split('\n').length, 2);
  });
});

describe('main() end-to-end with a mocked network', () => {
  let dir, file, realFetch, calls;
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, arrayBuffer: async () => new ArrayBuffer(0) });
  const fail = (status = 503) => ({ ok: false, status });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aurum-main-'));
    file = join(dir, 'prices.json');
    realFetch = globalThis.fetch; calls = [];
  });
  afterEach(async () => { globalThis.fetch = realFetch; await rm(dir, { recursive: true }); });
  const now = new Date('2026-11-25T02:17:00Z');

  test('daily run fills gaps and writes the file', async () => {
    await writeFile(file, serialize([row('2026-11-22')]));
    globalThis.fetch = async (url) => {
      calls.push(url);
      const tag = url.match(/currency-api@([\w-]+)/)?.[1];
      return json(snap(tag === 'latest' ? '2026-11-25' : tag, { xau: 3520 }));
    };
    assert.equal(await main([], { dataFile: file, now }), 0);
    const j = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(j.series.map((r) => r.d), ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']);
    assert.ok(calls.every((u) => u.startsWith('https://cdn.jsdelivr.net/')), 'primary mirror used when healthy');
  });

  test('falls back to the second mirror when the CDN fails or returns garbage', async () => {
    await writeFile(file, serialize([row('2026-11-24')]));
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (url.includes('jsdelivr')) return json({ nonsense: true });
      return json(snap('2026-11-25'));
    };
    assert.equal(await main([], { dataFile: file, now }), 0);
    assert.ok(calls.some((u) => u.includes('currency-api.pages.dev')));
    assert.equal(JSON.parse(await readFile(file, 'utf8')).meta.latest, '2026-11-25');
  });

  test('total outage → exit 2 and the file is left byte-for-byte untouched', async () => {
    const before = serialize([row('2026-11-24')], new Date('2026-11-24T02:17:00Z'));
    await writeFile(file, before);
    globalThis.fetch = async () => fail();
    assert.equal(await main([], { dataFile: file, now }), 2);
    assert.equal(await readFile(file, 'utf8'), before);
  });

  test('network exceptions (DNS/timeout) are survivable', async () => {
    await writeFile(file, serialize([row('2026-11-24')]));
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    assert.equal(await main([], { dataFile: file, now }), 2);
  });

  test('a corrupt history file is never overwritten', async () => {
    await writeFile(file, '{"series": [ {"d": "2026-11-2');
    globalThis.fetch = async () => json(snap('2026-11-25'));
    await assert.rejects(main([], { dataFile: file, now }));
    assert.equal(await readFile(file, 'utf8'), '{"series": [ {"d": "2026-11-2');
  });

  test('missing history file starts fresh', async () => {
    globalThis.fetch = async (url) => json(snap(url.match(/currency-api@([\w-]+)/)[1].replace('latest', '2026-11-25')));
    assert.equal(await main([], { dataFile: file, now }), 0);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).series.length, 46);
  });

  test('bad feed values are skipped, good days still stored', async () => {
    await writeFile(file, serialize([row('2026-11-23')]));
    globalThis.fetch = async (url) => {
      const tag = url.match(/currency-api@([\w-]+)/)?.[1];
      if (tag === '2026-11-24') return json(snap('2026-11-24', { xau: 1 })); // out of bounds
      return json(snap(tag === 'latest' ? '2026-11-25' : tag));
    };
    assert.equal(await main([], { dataFile: file, now }), 0);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).series.map((r) => r.d), ['2026-11-23', '2026-11-25']);
  });

  test('no new prices → file untouched byte-for-byte (no empty commit, "Last refresh" keeps its time)', async () => {
    const before = serialize([row('2026-11-24'), row('2026-11-25')], new Date('2026-11-25T10:48:00Z'));
    await writeFile(file, before);
    globalThis.fetch = async () => json(snap('2026-11-25'));
    assert.equal(await main([], { dataFile: file, now }), 0);
    assert.equal(await readFile(file, 'utf8'), before);
  });

  test('re-running on the same day is idempotent', async () => {
    await writeFile(file, serialize([row('2026-11-24')]));
    globalThis.fetch = async () => json(snap('2026-11-25'));
    await main([], { dataFile: file, now });
    const a = JSON.parse(await readFile(file, 'utf8')).series;
    await main([], { dataFile: file, now });
    const b = JSON.parse(await readFile(file, 'utf8')).series;
    assert.deepEqual(a, b);
  });
});

describe('committed data/prices.json integrity', async () => {
  const j = JSON.parse(await readFile(join(ROOT, 'data/prices.json'), 'utf8'));
  const s = j.series;
  test('has a year+ of history', () => assert.ok(s.length >= 365, `only ${s.length} rows`));
  test('sorted, unique, ISO dates', () => {
    s.forEach((r, i) => {
      assert.match(r.d, /^\d{4}-\d{2}-\d{2}$/);
      if (i) assert.ok(r.d > s[i - 1].d, `${r.d} not after ${s[i - 1].d}`);
    });
  });
  test('every value is inside plausibility bands', () => {
    for (const r of s) {
      assert.ok(r.xau > 500 && r.xau < 25000, r.d);
      assert.ok(r.xag > 5 && r.xag < 1000, r.d);
      assert.ok(r.cad > 0.8 && r.cad < 2.5, r.d);
      assert.ok(r.inr > 40 && r.inr < 250, r.d);
    }
  });
  test('passes the spike filter unchanged', () => assert.equal(validateMoves(s).length, s.length));
  test('meta agrees with series', () => {
    assert.equal(j.meta.points, s.length);
    assert.equal(j.meta.latest, s.at(-1).d);
  });
  test('gold/silver ratio stays in a sane historical band', () => {
    for (const r of s) assert.ok(r.xau / r.xag > 30 && r.xau / r.xag < 130, r.d);
  });
});
