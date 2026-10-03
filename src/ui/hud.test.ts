import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHud, type Hud, type HudView } from './hud';
import { TUNING } from '../shared/tuning';
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

  describe('start hint', () => {
    const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

    it('names the race keys, then the drift exits of scheme A on a row of their own (design spec §2.3)', () => {
      const items = [...q('.dr-hint').children];
      expect(items.map(text)).toEqual([
        'WASD газ и руль',
        'Пробел дрифт',
        'R на трассу',
        'Esc пауза',
        'В заносе: S — выход, контрруль или сброс газа — выровняться',
      ]);
      const exits = items.at(-1)!;
      expect(exits.classList.contains('dr-hint__exits')).toBe(true);
      expect([...exits.querySelectorAll('.dr-key')].map(text)).toEqual(['S']);
    });

    it('shows and hides on demand', () => {
      const hint = q('.dr-hint');
      expect(hint.classList.contains('is-on')).toBe(false);
      hud.showHint(true);
      expect(hint.classList.contains('is-on')).toBe(true);
      hud.showHint(false);
      expect(hint.classList.contains('is-on')).toBe(false);
    });
  });

  describe('ghost standings', () => {
    const VIEW: HudView = {
      lap: 1, laps: 3, time: 12, bestLap: null, coins: 0, speed: 20, chainPoints: 0, multiplier: 1,
      chainPhase: 'idle', totalPoints: 900, wrongWay: false,
    };

    it('stays hidden without standings (ghosts off)', () => {
      hud.update(VIEW);
      expect(q('.dr-standings').hidden).toBe(true);
      hud.update({ ...VIEW, standings: null });
      expect(q('.dr-standings').hidden).toBe(true);
    });

    it('shows the rows it gets', () => {
      hud.update({
        ...VIEW,
        standings: [
          { id: 'master', name: 'Мастер', color: 0xb070ff, points: 1500, finished: false },
          { id: 'player', name: 'Ты', color: null, points: 900, finished: false },
        ],
      });
      expect(q('.dr-standings').hidden).toBe(false);
      expect(root.querySelectorAll('.dr-standings li')).toHaveLength(2);
      expect(q('.dr-standings li.is-player .dr-standings__name').textContent).toBe('Ты');
    });
  });
});

describe('HUD speed bar (jsdom)', () => {
  const VIEW: HudView = {
    lap: 1, laps: 3, time: 0, bestLap: null, coins: 0, speed: 0,
    chainPoints: 0, multiplier: 1, chainPhase: 'idle', totalPoints: 0, wrongWay: false,
  };
  const bar = (root: HTMLElement): string => root.querySelector<HTMLElement>('.dr-hud-speed__bar i')!.style.transform;

  it('fills to the car top speed it was given, else to TUNING.car.maxSpeed', () => {
    const root = document.createElement('div');
    const own = createHud(root, { onPause: () => {}, maxSpeed: 50 });
    own.update({ ...VIEW, speed: 25 });
    expect(bar(root)).toBe('scaleX(0.500)');
    own.destroy();
    const plain = createHud(root, { onPause: () => {} });
    plain.update({ ...VIEW, speed: 20 });
    expect(bar(root)).toBe(`scaleX(${(20 / TUNING.car.maxSpeed).toFixed(3)})`);
    plain.destroy();
  });
});
