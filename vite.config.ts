import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // Relative asset URLs: dist/ works from any sub-path (GitHub Pages project sites, itch.io iframes).
  base: './',
  // Shown in the garage corner so players know which build they run.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    // Unit tests only; Playwright owns tests/e2e.
    include: ['src/**/*.test.ts'],
  },
});
