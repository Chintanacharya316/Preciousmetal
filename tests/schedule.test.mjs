// The page's "Next refresh" is computed from REFRESH_SLOTS_UTC in assets/app.js.
// It must always match the workflow's cron schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('page refresh slots match the workflow cron schedule', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/daily-prices.yml'), 'utf8');
  const crons = [...yml.matchAll(/cron:\s*"(\d+) (\d+) \* \* \*"/g)]
    .map(([, m, h]) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`)
    .sort();
  const app = readFileSync(join(ROOT, 'assets/app.js'), 'utf8');
  const slots = JSON.parse(app.match(/REFRESH_SLOTS_UTC = (\[[^\]]*\])/)[1].replace(/'/g, '"')).sort();
  assert.ok(crons.length >= 1, 'workflow has daily cron entries');
  assert.deepEqual(slots, crons);
});
