/** Buying a car in the garage and racing it (plan/2026-10-04-sport-cars.md), on the production build. */
import { expect, test } from '@playwright/test';
import type { GameTestState } from '../../src/app/testHook';

const SAVE_KEY = 'driftRally.save.v1';
/** TUNING.race.physicsHz. */
const HZ = 120;

test('buy «Квадро» in the garage and race it', async ({ page }, info) => {
  await page.addInitScript(
    ([key]) => {
      if (localStorage.getItem(key) !== null) return;
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1, coins: 500, bestScore: 0, bestLapMs: null, quality: null, muted: true,
          ownedCars: ['iskra'], selectedCar: 'iskra', bestScoreCar: null,
        }),
      );
    },
    [SAVE_KEY],
  );
  await page.goto('./?test');
  await expect(page.locator('.dr-cta')).toContainText('В ЗАЕЗД', { useInnerText: true, timeout: 120_000 });

  await test.step('browse to «Квадро» and buy it', async () => {
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dr-car__name')).toHaveText('Квадро');
    await expect(page.locator('.dr-cta')).toContainText('Купить');
    await page.locator('.dr-cta').click();
    await page.locator('[data-confirm-buy]').click();
    await expect(page.locator('.dr-cta')).toContainText('В ЗАЕЗД', { useInnerText: true });
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), SAVE_KEY);
    expect(saved).toMatchObject({ coins: 200, ownedCars: ['iskra', 'quadro'], selectedCar: 'quadro' });
  });

  await test.step('race it', async () => {
    await page.evaluate(() => window.__game!.startRace());
    expect(await page.evaluate(() => window.__game!.state().car)).toBe('quadro');
    await page.evaluate((n) => window.__game!.autopilot(n), 8 * HZ);
    const st: GameTestState = await page.evaluate(() => window.__game!.state());
    expect(st.phase).toBe('racing');
    expect(st.speed).toBeGreaterThan(5);
    const path = info.outputPath('quadro-race.png');
    await page.screenshot({ path });
    await info.attach('quadro-race', { path, contentType: 'image/png' });
  });
});
