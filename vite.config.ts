/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cspMetaTag } from './src/core/csp.ts';

// Relative asset paths: the build works from any URL path (GitHub Pages, a sub-folder, file servers).
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  plugins: [
    react(),
    {
      // Build only: the dev server injects inline scripts for hot reload.
      name: 'csp-meta',
      apply: 'build',
      transformIndexHtml: (html) =>
        html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    ${cspMetaTag()}`),
    },
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
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
