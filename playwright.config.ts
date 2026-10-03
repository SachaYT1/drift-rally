import { defineConfig, type Project } from '@playwright/test';

/**
 * E2E smoke test (design spec §8): builds the production bundle, serves it with `vite preview` and drives one
 * race through the `?test` hook.
 *
 * Renderer projects (both always defined; pick with --project, see the npm scripts):
 *  - gpu: new headless Chromium on the real GPU (ANGLE on Metal on macOS). `npm run e2e`.
 *  - software: SwiftShader, for machines and CI runners without a usable GPU (slower). `npm run e2e:software`.
 * `npm run e2e:all` (plain `playwright test`) runs both.
 */
const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}/`;

/** ANGLE backend that reaches the real GPU on this OS. */
function hardwareAngle(): string {
  if (process.platform === 'darwin') return 'metal';
  if (process.platform === 'win32') return 'd3d11';
  return 'vulkan';
}

const projects: Project[] = [
  {
    name: 'gpu',
    use: {
      channel: 'chromium',
      launchOptions: { args: [`--use-angle=${hardwareAngle()}`, '--enable-gpu', '--ignore-gpu-blocklist'] },
    },
  },
  {
    name: 'software',
    use: {
      launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
    },
  },
];

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  // One GPU, one game: run serially so frame timing and shader compiles do not compete.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Loading compiles every shader; SwiftShader needs far longer than a GPU for that.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects,
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Always test a fresh build: a preview already running on the port fails fast instead of serving stale files.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
