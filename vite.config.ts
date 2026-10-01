/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Relative asset paths: the build works from any URL path (GitHub Pages, a sub-folder, file servers).
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      // The GPU test harness page is built alongside the app for the Playwright specs.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        gpuTest: fileURLToPath(new URL('./gpu-test.html', import.meta.url)),
      },
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
