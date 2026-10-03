import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs: dist/ works from any sub-path (GitHub Pages project sites, itch.io iframes).
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    // Unit tests only; Playwright owns tests/e2e.
    include: ['src/**/*.test.ts'],
  },
});
