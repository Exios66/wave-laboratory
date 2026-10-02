#!/usr/bin/env node
/**
 * Publish the production build onto this branch — no GitHub Actions and no gh-pages branch.
 *
 *   pnpm deploy:pages            build and commit the site here
 *   pnpm deploy:pages --dry-run  build the site files but do not commit
 *
 * GitHub Pages is "Deploy from a branch" → main → / (root). The same files are copied
 * into docs/ next to the markdown notes.
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

function builtIndex() {
  const named = join(dist, 'index.html');
  if (existsSync(named)) return named;
  const alt = join(dist, 'vite.index.html');
  if (existsSync(alt)) return alt;
  throw new Error('Build produced no index.html');
}

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
const indexHtml = builtIndex();

const copySite = (dir, { preserve }) => {
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (preserve?.has(entry)) continue;
      if (
        entry === 'assets' ||
        entry === 'index.html' ||
        entry === '404.html' ||
        entry === '.nojekyll'
      ) {
        rmSync(join(dir, entry), { recursive: true, force: true });
      }
    }
  }
  cpSync(join(dist, 'assets'), join(dir, 'assets'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  });
  cpSync(indexHtml, join(dir, 'index.html'));
  cpSync(indexHtml, join(dir, '404.html'));
  writeFileSync(join(dir, '.nojekyll'), '');
};

// Pages is configured as main / (root). docs/ gets the same build.
copySite(root, {});
copySite(docs, { preserve: KEEP });

if (dryRun) {
  console.info('› Dry run: docs/ updated, not committed.');
  process.exit(0);
}

run('git', ['add', '--all', 'docs', 'index.html', '404.html', '.nojekyll', 'assets']);
const changed = out('git', [
  'status',
  '--porcelain',
  '--',
  'docs',
  'index.html',
  '404.html',
  '.nojekyll',
  'assets',
]);
if (!changed) {
  console.info('› Nothing changed since the last deployment.');
} else {
  run('git', ['commit', '-q', '-m', `Deploy ${source} to docs/ on ${branch}`]);
  console.info(`› Committed the site from ${source} into docs/.`);
}
