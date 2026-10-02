#!/usr/bin/env node
/**
 * Publish the production build onto this branch — no GitHub Actions and no gh-pages branch.
 *
 *   pnpm deploy:pages            build and commit the site here
 *   pnpm deploy:pages --dry-run  build the site into a temporary folder; touch nothing here
 *
 * GitHub Pages is "Deploy from a branch" → main → /docs. The site (index.html, 404.html,
 * assets/ and .nojekyll) is written into docs/ next to the markdown notes, which are kept.
 * Asset paths are relative, so the site works at any URL prefix.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const docs = join(root, 'docs');
const KEEP = new Set(['PLAN.md', 'ARCHITECTURE.md', 'PHYSICS.md']);

function builtIndex() {
  const named = join(dist, 'index.html');
  if (existsSync(named)) return named;
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

/**
 * Replace the site in `dir`. The new files are staged next to it first, so a failed copy never
 * leaves a half-deleted site behind.
 */
const copySite = (dir, { preserve }) => {
  const staged = mkdtempSync(join(tmpdir(), 'wave-lab-site-'));
  cpSync(join(dist, 'assets'), join(staged, 'assets'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  });
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
  cpSync(join(staged, 'assets'), join(dir, 'assets'), { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  cpSync(indexHtml, join(dir, 'index.html'));
  cpSync(indexHtml, join(dir, '404.html'));
  writeFileSync(join(dir, '.nojekyll'), '');
};

if (dryRun) {
  // Never touch the committed site on a dry run: lay it out in a scratch folder instead.
  const preview = mkdtempSync(join(tmpdir(), 'wave-lab-pages-'));
  copySite(preview, {});
  console.info(`› Dry run: the site was built into ${preview}; nothing here changed.`);
  process.exit(0);
}

copySite(docs, { preserve: KEEP });

run('git', ['add', '--all', 'docs']);
const changed = out('git', ['status', '--porcelain', '--', 'docs']);
if (!changed) {
  console.info('› Nothing changed since the last deployment.');
} else {
  run('git', ['commit', '-q', '-m', `Deploy ${source} to docs/ on ${branch}`]);
  console.info(`› Committed the site from ${source} into docs/.`);
}
