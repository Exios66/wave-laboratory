#!/usr/bin/env node
/**
 * Publish the production build to the `gh-pages` branch — no GitHub Actions involved.
 *
 *   pnpm deploy:pages            build, verify and push
 *   pnpm deploy:pages --dry-run  build and prepare the branch, but do not push
 *
 * GitHub Pages then serves the branch directly (Settings → Pages → "Deploy from a branch" →
 * gh-pages / root). The build uses relative asset paths, so it works at any URL path.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BRANCH = 'gh-pages';
const dryRun = process.argv.includes('--dry-run');
const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

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

console.info('› Building…');
run('pnpm', ['run', 'build']);
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build produced no index.html');

// Pages runs Jekyll by default, which drops files starting with "_"; .nojekyll disables it.
writeFileSync(join(dist, '.nojekyll'), '');
// Unknown paths fall back to the app (it uses #hash state, so no server routing is needed).
cpSync(join(dist, 'index.html'), join(dist, '404.html'));

const work = mkdtempSync(join(tmpdir(), 'wave-lab-pages-'));
try {
  const remoteHas = out('git', ['ls-remote', '--heads', 'origin', BRANCH]) !== '';
  if (remoteHas) {
    run('git', ['fetch', 'origin', `${BRANCH}:refs/remotes/origin/${BRANCH}`]);
    run('git', ['worktree', 'add', '--force', '-B', BRANCH, work, `origin/${BRANCH}`]);
  } else {
    run('git', ['worktree', 'add', '--force', '--detach', work]);
    run('git', ['checkout', '--orphan', BRANCH], { cwd: work });
  }
  for (const entry of readdirSync(work)) {
    if (entry !== '.git') rmSync(join(work, entry), { recursive: true, force: true });
  }
  cpSync(dist, work, { recursive: true });
  run('git', ['add', '--all'], { cwd: work });
  const changed = out('git', ['status', '--porcelain'], { cwd: work });
  if (!changed) {
    console.info('› Nothing changed since the last deployment.');
  } else {
    run('git', ['commit', '-q', '-m', `Deploy ${source}`], { cwd: work });
    if (dryRun) console.info(`› Dry run: ${BRANCH} prepared locally, not pushed.`);
    else {
      run('git', ['push', 'origin', `${BRANCH}:${BRANCH}`], { cwd: work });
      console.info(`› Deployed ${source} to ${BRANCH}.`);
    }
  }
} finally {
  run('git', ['worktree', 'remove', '--force', work]);
}
