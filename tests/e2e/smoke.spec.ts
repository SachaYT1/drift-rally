/**
 * Smoke test of the production build (design spec §8, plan Task 17): garage -> race -> scripted drive ->
 * results through the `?test` hook (src/app/testHook.ts). Plain `?test` applies the render contract
 * (quality low, pixel ratio 1, drawing buffer <= 640x360) and the simulation only advances when the hook
 * steps it, so every run is deterministic. Screenshots are artifacts only (no visual comparison).
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { GameTestState } from '../../src/app/testHook';

/** Fixed steps per simulated second (TUNING.race.physicsHz). */
const HZ = 120;
/** TUNING.race.countdown (3 s) in steps. */
const COUNTDOWN_STEPS = 3 * HZ;
/** Closed-loop autopilot stretch; reaches about 270 m (the open-loop drive stalls at a barrier near 54 m). */
const OPENING_STEPS = 10 * HZ;
/** Drift-heavy stretch: autopilot chunks (it kicks drifts into the tight corners) until a chain banks. */
const DRIFT_CHUNK = HZ / 4;
const DRIFT_MAX_STEPS = 60 * HZ;

/** Console noise that is not an app failure. */
const ALLOWED_CONSOLE = [
  // three's compileAsync() notes that the GPU lacks KHR_parallel_shader_compile and compiles synchronously.
  /KHR_parallel_shader_compile/,
  // Chromium's GL driver note (SwiftShader) when page.screenshot() reads back the WebGL canvas.
  /GPU stall due to ReadPixels/,
];

interface GlInfo {
  webgl2: boolean;
  lost: boolean;
  width: number;
  height: number;
  /** Unmasked GL renderer string (shows whether the project really runs on the GPU or on SwiftShader). */
  renderer: string;
}

function gameState(page: Page): Promise<GameTestState> {
  return page.evaluate(() => window.__game!.state());
}

/** Wait until requestAnimationFrame has rendered `n` more frames (the hook only steps, rAF draws). */
function frames(page: Page, n = 2): Promise<void> {
  return page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = (): void => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('garage -> race -> autopilot drive -> results', async ({ page }, info) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    const type = m.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = m.text();
    if (!ALLOWED_CONSOLE.some((re) => re.test(text))) problems.push(`[console.${type}] ${text}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

  await page.goto('./?test');

  await test.step('garage on a WebGL2 canvas', async () => {
    // Loading compiles and prewarms both scenes before the garage appears.
    await expect(page.locator('.dr-cta')).toContainText('В ЗАЕЗД', { useInnerText: true, timeout: 120_000 });
    await page.waitForFunction(() => window.__previewReady === true);
    const gl = await page.evaluate((): GlInfo | null => {
      const canvas = document.querySelector<HTMLCanvasElement>('#game');
      // Returns the renderer's existing context; null if the canvas holds a WebGL1 context or none.
      const ctx = canvas?.getContext('webgl2');
      if (!ctx) return null;
      const debug = ctx.getExtension('WEBGL_debug_renderer_info');
      return {
        webgl2: ctx instanceof WebGL2RenderingContext,
        lost: ctx.isContextLost(),
        width: ctx.drawingBufferWidth,
        height: ctx.drawingBufferHeight,
        renderer: String(ctx.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : ctx.RENDERER)),
      };
    });
    expect(gl, 'WebGL2 context on #game').not.toBeNull();
    info.annotations.push({ type: 'gl', description: gl!.renderer });
    expect(gl).toMatchObject({ webgl2: true, lost: false });
    // The ?test render contract bounds the drawing buffer.
    expect(gl!.width).toBeLessThanOrEqual(640);
    expect(gl!.height).toBeLessThanOrEqual(360);
    expect((await gameState(page)).screen).toBe('garage');
    await shot(page, info, '1-garage');
  });

  await test.step('race starts after the countdown', async () => {
    await page.evaluate(() => window.__game!.startRace());
    const start = await gameState(page);
    expect(start).toMatchObject({ screen: 'race', phase: 'countdown', paused: false, lap: 1 });
    await expect(page.locator('.dr-hud-lap')).toBeVisible();

    await page.evaluate((n) => window.__game!.step(n), COUNTDOWN_STEPS);
    const go = await gameState(page);
    expect(go.phase).toBe('racing');
    expect(go.paused).toBe(false);
  });

  await test.step('autopilot makes progress', async () => {
    await page.evaluate((n) => window.__game!.autopilot(n), OPENING_STEPS);
    const st = await gameState(page);
    expect(st.phase).toBe('racing');
    expect(st.p, `progress after ${OPENING_STEPS} autopilot steps`).toBeGreaterThan(50);
    expect(Number.isFinite(st.speed) && st.speed > 0).toBe(true);
    await frames(page);
    await shot(page, info, '2-race');
  });

  await test.step('drifting banks points', async () => {
    const run = await page.evaluate(
      ({ chunk, max }) => {
        const g = window.__game!;
        let steps = 0;
        let driftChunks = 0;
        while (steps < max && g.state().points <= 0 && g.state().phase === 'racing') {
          g.autopilot(chunk);
          steps += chunk;
          if (g.state().mode === 'drift') driftChunks += 1;
        }
        return { steps, driftChunks, state: g.state() };
      },
      { chunk: DRIFT_CHUNK, max: DRIFT_MAX_STEPS },
    );
    info.annotations.push({ type: 'drift', description: JSON.stringify(run) });
    expect(run.driftChunks, 'the autopilot drifted').toBeGreaterThan(0);
    expect(run.state.points, 'banked drift points').toBeGreaterThan(0);
    // Ghost bots are on by default: three bots race along, ranked with the player in the HUD.
    expect(run.state.bots.map((b) => b.id)).toEqual(['rookie', 'pro', 'master']);
    expect(run.state.bots.some((b) => b.points > 0), 'the bots score too').toBe(true);
    await expect(page.locator('.dr-standings')).toBeVisible();
    await expect(page.locator('.dr-standings li')).toHaveCount(4);
    await frames(page);
    await shot(page, info, '3-drift');
  });

  await test.step('finish shows the results', async () => {
    await page.evaluate(() => window.__game!.finish());
    const end = await gameState(page);
    expect(end).toMatchObject({ screen: 'results', phase: 'finished' });
    expect(end.points).toBeGreaterThan(0);

    const results = page.locator('.dr-results');
    await expect(results).toBeVisible();
    await expect(results.locator('#dr-results-title')).toContainText('Финиш');
    // First run in a fresh profile: always a record, and the save holds it.
    await expect(results.locator('.dr-badge')).toContainText('Новый рекорд!');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('driftRally.save.v1') ?? 'null'));
    expect(saved).toMatchObject({ version: 1, bestScore: Math.round(end.points) });
    info.annotations.push({ type: 'result', description: JSON.stringify({ state: end, save: saved }) });
    // Every bot was raced to its finish for the «you vs bots» block.
    expect(end.bots.every((b) => b.finished && b.points > 0)).toBe(true);
    const versus = results.locator('.dr-versus');
    await expect(versus).toContainText('Ты против ботов');
    await expect(versus).toContainText(/Место: \d из 4/);
    await expect(versus.locator('li')).toHaveCount(4);
    await expect(versus.locator('li.is-player')).toContainText('Ты');
    await frames(page, 90); // the score count-up runs for about 1.1 s
    await shot(page, info, '4-results');
  });

  expect(problems, 'console errors / warnings / page errors').toEqual([]);
});

test('the garage switch turns the ghost bots off for the next race', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    const type = m.type();
    if ((type === 'error' || type === 'warning') && !ALLOWED_CONSOLE.some((re) => re.test(m.text()))) problems.push(`[console.${type}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.goto('./?test');
  const ghosts = page.locator('.dr-ghosts');
  await expect(ghosts).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
  await ghosts.click();
  await expect(ghosts).toHaveAttribute('aria-checked', 'false');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('driftRally.save.v1') ?? 'null'));
  expect(saved).toMatchObject({ ghosts: false });

  await page.evaluate(() => window.__game!.startRace());
  await page.evaluate((n) => window.__game!.step(n), COUNTDOWN_STEPS);
  await page.evaluate((n) => window.__game!.autopilot(n), OPENING_STEPS);
  expect((await gameState(page)).bots).toEqual([]);
  await expect(page.locator('.dr-standings')).toBeHidden();

  await page.evaluate(() => window.__game!.finish());
  await expect(page.locator('.dr-results')).toBeVisible();
  await expect(page.locator('.dr-versus')).toHaveCount(0);
  expect(problems, 'console errors / warnings / page errors').toEqual([]);
});
