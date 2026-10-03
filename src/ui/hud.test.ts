import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHud, type Hud } from './hud';
import { MINUS } from './format';
import { fakeAnimations, installDom, type FakeAnimation } from './domTestEnv';

const win = await installDom();
afterAll(() => vi.unstubAllGlobals());

describe('HUD (jsdom)', () => {
  let animations: FakeAnimation[] = [];
  let root: HTMLElement;
  let hud: Hud;

  beforeEach(() => {
    animations = fakeAnimations(win);
    root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, { onPause: () => {} });
  });

  afterEach(() => {
    hud.destroy();
    root.remove();
  });

  /** Let `ms` of animation time pass for every running animation (the next frames have been drawn). */
  function advance(ms: number): void {
    for (const a of animations) {
      if (a.playState !== 'running') continue;
      a.pending = false;
      a.currentTime = (a.currentTime ?? 0) + ms;
    }
  }
  const animsOn = (el: Element): FakeAnimation[] => animations.filter((a) => a.target === el);
  const lastOn = (el: Element): FakeAnimation => {
    const a = animsOn(el).at(-1);
    if (!a) throw new Error('no animation on element');
    return a;
  };
  const finalOpacity = (a: FakeAnimation): unknown => a.frames.at(-1)?.opacity;
  const q = (sel: string): HTMLElement => {
    const el = root.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };

  describe('countdown', () => {
    it('animates the digit, never the box whose transform centres it', () => {
      const box = q('.dr-countdown');
      const digit = q('[data-ref="count"]');
      for (const v of [3, 2, 1, 0]) hud.setCountdown(v);
      hud.setCountdown(null);
      // Any transform on the box would replace its translate(-50%, -50%) centring.
      for (const a of animsOn(box)) for (const f of a.frames) expect(f.transform).toBeUndefined();
      const scaled = animsOn(digit).filter((a) => a.frames.some((f) => typeof f.transform === 'string'));
      expect(scaled.length).toBe(4);
      expect(digit.textContent).toBe('Старт!');
    });
  });

  describe('bank / burn flashes vs a new chain', () => {
    it('fades a visible bank flash out quickly when a new chain starts', () => {
      const bank = q('[data-ref="bank"]');
      hud.onEvent({ type: 'chainBanked', points: 197 });
      const rise = lastOn(bank);
      expect(bank.textContent).toBe('+197');
      advance(300);
      hud.onEvent({ type: 'chainStart' });
      expect(rise.playState).toBe('idle');
      const fade = lastOn(bank);
      expect(fade).not.toBe(rise);
      expect(finalOpacity(fade)).toBe(0);
      expect(Number(fade.options.duration)).toBeLessThanOrEqual(200);
    });

    it('fades a visible burn flash out quickly when a new chain starts', () => {
      const burn = q('[data-ref="burn"]');
      hud.onEvent({ type: 'chainBurned', points: 420 });
      const drop = lastOn(burn);
      advance(500);
      hud.onEvent({ type: 'chainStart' });
      expect(drop.playState).toBe('idle');
      expect(finalOpacity(lastOn(burn))).toBe(0);
      expect(Number(lastOn(burn).options.duration)).toBeLessThanOrEqual(200);
      expect(burn.classList.contains('is-below')).toBe(false);
    });

    it('keeps a burn from the same frame visible, but moved below the new chain card', () => {
      const burn = q('[data-ref="burn"]');
      hud.onEvent({ type: 'chainBurned', points: 420 });
      const drop = lastOn(burn);
      hud.onEvent({ type: 'chainStart' }); // same step: the car kept drifting through a glancing heavy hit
      expect(drop.playState).toBe('running');
      expect(burn.classList.contains('is-below')).toBe(true);
      // The next ordinary burn plays in its usual place again.
      advance(2000);
      hud.onEvent({ type: 'chainBurned', points: 10 });
      expect(burn.classList.contains('is-below')).toBe(false);
    });

    it('leaves flashes that already ended alone', () => {
      const bank = q('[data-ref="bank"]');
      hud.onEvent({ type: 'chainBanked', points: 50 });
      lastOn(bank).playState = 'finished';
      const before = animations.length;
      hud.onEvent({ type: 'chainStart' });
      expect(animations.length).toBe(before);
    });
  });

  describe('penalty flash', () => {
    it('shows exactly the deducted points', () => {
      const pen = q('[data-ref="penalty"]');
      hud.onEvent({ type: 'penalty', points: 60 });
      expect(pen.textContent).toBe(`${MINUS}60`);
      expect(animsOn(pen).length).toBe(1);
    });

    it('shows nothing when no points were deducted', () => {
      const pen = q('[data-ref="penalty"]');
      hud.onEvent({ type: 'penalty', points: 0 });
      hud.onEvent({ type: 'penalty', points: -5 });
      expect(pen.textContent).toBe('');
      expect(animsOn(pen).length).toBe(0);
    });
  });
});
