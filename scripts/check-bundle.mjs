#!/usr/bin/env node
/**
 * Fail the check when the app's entry chunk outgrows its budget. The 3D renderer (three.js and
 * every scenery layer) and the charts (uPlot) load as their own chunks; the entry is what every
 * visit downloads before the first paint, so it must stay small.
 *
 *   node scripts/check-bundle.mjs     (after `pnpm build`)
 */
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Entry budget [bytes]: the size measured when the renderer and charts were split out
 * (464,310 bytes on 2026-11-13) plus 10 %, rounded up to 10 kB.
 */
const ENTRY_BUDGET = 520_000;

const dist = resolve(import.meta.dirname, '..', 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const match = html.match(/<script type="module"[^>]*\ssrc="([^"]+)"/);
if (!match) {
  console.error('check-bundle: no module entry script in dist/index.html');
  process.exit(1);
}
const entry = match[1].replace(/^\.?\//, '');
const size = statSync(join(dist, entry)).size;
const kb = (n) => (n / 1000).toFixed(1);
console.info(`entry ${entry}: ${kb(size)} kB / ${kb(ENTRY_BUDGET)} kB`);
if (size > ENTRY_BUDGET) {
  console.error(
    `check-bundle: the entry chunk is over budget. Load heavy modules with import() instead.`,
  );
  process.exit(1);
}
