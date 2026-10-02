/// <reference types="vitest/config" />
import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * GitHub Pages serves the repository root of `main`, so the committed `index.html` is the
 * production build. Local `pnpm dev` rewrites `/` to the source entry `vite.index.html`.
 */
function devUsesSourceIndex(): Plugin {
  return {
    name: 'dev-uses-source-index',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url?.split('?')[0];
        if (path === '/' || path === '/index.html') {
          const query = req.url?.includes('?') ? `?${req.url.split('?')[1]}` : '';
          req.url = `/vite.index.html${query}`;
        }
        next();
      });
    },
    closeBundle() {
      const from = resolve(import.meta.dirname, 'dist/vite.index.html');
      const to = resolve(import.meta.dirname, 'dist/index.html');
      if (existsSync(from)) renameSync(from, to);
    },
  };
}

// Relative asset paths: the build works from any URL path (GitHub Pages, a sub-folder, file servers).
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  plugins: [devUsesSourceIndex(), react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'vite.index.html'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'validation',
          environment: 'node',
          include: ['src/**/*.validation.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
