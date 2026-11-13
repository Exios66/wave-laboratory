#!/usr/bin/env node
/**
 * Fail the check when a scenery model outgrows its download budget, or ships without a credit.
 * The models are fetched lazily, but every one of them is downloaded by anyone who sails near
 * an island or a buoy, so each must stay small; all are CC0 and listed in CREDITS.md.
 *
 *   node scripts/check-models.mjs [modelsDir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Budget [KB] per model; anything not listed gets DEFAULT_KB. */
const BUDGET_KB = { 'tall-ship': 1200 };
const DEFAULT_KB = 300;

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'public', 'models'));
const credits = readFileSync(join(dir, 'CREDITS.md'), 'utf8');
let failed = false;
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.glb'))
  .sort()) {
  const name = file.slice(0, -4);
  const kb = statSync(join(dir, file)).size / 1024;
  const budget = BUDGET_KB[name] ?? DEFAULT_KB;
  const credited = credits.includes(`\`${file}\``);
  const ok = kb <= budget && credited;
  console.info(
    `${ok ? 'ok  ' : 'FAIL'} ${file}: ${kb.toFixed(0)} / ${budget} KB${credited ? '' : ', no CREDITS.md row'}`,
  );
  if (!ok) failed = true;
}
if (failed) {
  console.error(
    'check-models: a model is over budget or uncredited (see scripts/fetch-models.mjs).',
  );
  process.exit(1);
}
