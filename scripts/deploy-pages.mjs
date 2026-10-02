#!/usr/bin/env node
/**
 * Publish the production build into docs/ on this branch — no GitHub Actions, no gh-pages branch.
 *
 *   pnpm deploy:pages            build and commit docs/ here
 *   pnpm deploy:pages --dry-run  build docs/ but do not commit
 *
 * GitHub Pages serves it when the source is main and the folder is /docs
 * (Settings → Pages → Deploy from a branch → main → /docs).
 * The markdown notes in docs/ are kept beside the built site.
 * Asset paths are relative, so the site works at any URL prefix.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const docs = join(root, 'docs');
const KEEP = new Set(['PLAN.md', 'ARCHITECTURE.md', 'PHYSICS.md']);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts }).trim();

const dirty = out('git', ['status', '--porcelain']);
if (dirty && !dryRun) {
  console.error('Refusing to deploy with uncommitted changes (the commit hash is recorded).');
  process.exit(1);
}
const source = out('git', ['rev-parse', '--short', 'HEAD']);
const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);

console.info('› Building…');
run('pnpm', ['run', 'build']);
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build produced no index.html');

for (const entry of readdirSync(docs)) {
  if (!KEEP.has(entry)) rmSync(join(docs, entry), { recursive: true, force: true });
}
cpSync(dist, docs, {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});
writeFileSync(join(docs, '.nojekyll'), '');
cpSync(join(docs, 'index.html'), join(docs, '404.html'));

if (dryRun) {
  console.info('› Dry run: docs/ updated, not committed.');
  process.exit(0);
}

run('git', ['add', '--all', 'docs']);
const changed = out('git', ['status', '--porcelain', '--', 'docs']);
if (!changed) {
  console.info('› Nothing changed since the last deployment.');
} else {
  run('git', ['commit', '-q', '-m', `Deploy ${source} to docs/ on ${branch}`]);
  console.info(`› Committed the site from ${source} into docs/.`);
}
