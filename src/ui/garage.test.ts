import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveData } from '../shared/types';
import { TUNING } from '../shared/tuning';
import { createGarageUI, type GarageUI } from './garage';
import { enterGarage } from '../app/garageScreen';
import type { App } from '../app/context';
import { click, fakeAnimations, installDom, keydown } from './domTestEnv';

const win = await installDom();
afterAll(() => vi.unstubAllGlobals());

const SAVE: SaveData = { version: 1, coins: 120, bestScore: 4200, bestLapMs: 61_000, quality: 'medium', muted: false, ghosts: true };

const norm = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ');

describe('garage UI (jsdom)', () => {
  let root: HTMLElement;
  let ui: GarageUI;
  let onMute: ReturnType<typeof vi.fn<(m: boolean) => void>>;
  let onGhosts: ReturnType<typeof vi.fn<(on: boolean) => void>>;

  function mount(save: SaveData = SAVE): void {
    onMute = vi.fn<(m: boolean) => void>();
    onGhosts = vi.fn<(on: boolean) => void>();
    ui = createGarageUI(root, { save, trackName: 'Площадь', onStart: () => {}, onMute, onGhosts });
  }

  beforeEach(() => {
    fakeAnimations(win);
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    ui.destroy();
    root.remove();
  });

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };
  const openRules = (): HTMLElement => {
    click(q('[data-open="rules"]'));
    return q('.dr-modal');
  };

  it('shows the game version from package.json in the corner', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    mount();
    expect(q('.dr-version').textContent).toBe(`v${pkg.version}`);
  });

  describe('rules modal', () => {
    const driftNotes = (modal: HTMLElement): string[] =>
      [...modal.querySelectorAll('.dr-keys-note li')].map((li) => norm(li.textContent).trim());
    /** The catch counts from the wheel reaching full lock (de4fbc7), so the copy quotes no time. */
    const CATCH_NOTE = 'Полный контрруль — машина выпрямится и поймает занос';

    it('explains the drift controls of scheme A (design spec §2.3) and what burns the chain', () => {
      mount();
      const modal = openRules();
      expect(driftNotes(modal)).toEqual([
        'В заносе',
        'W держит занос, отпустите газ — выход',
        // Space no longer sustains a drift (handbrake rework, spec §2.3): taps only, holding it bleeds speed.
        'Пробел — войти в занос или подкрутить коротким нажатием; долго держать — машина теряет скорость',
        'AD внутрь — круче, наружу — прямее',
        CATCH_NOTE,
        'S тормоз и выход из заноса',
        'Пробел + обратный руль — перекладка',
      ]);
      const text = norm(modal.textContent);
      expect(text).toContain('Сильный удар, взрыв бомбы или возврат на трассу (R) сжигают цепочку');
      // The arc control lives in the drift list now, not repeated in the scoring rules.
      expect(text).not.toContain('Руль внутрь');
    });

    it.each([0.3, 0.45, 1])('quotes no catch time (TUNING.drift.catchTime = %s): it counts from the wheel at full lock', (seconds) => {
      const saved = TUNING.drift.catchTime;
      TUNING.drift.catchTime = seconds;
      try {
        mount();
        const notes = driftNotes(openRules());
        expect(notes).toContain(CATCH_NOTE);
        expect(notes.join(' ')).not.toMatch(/\d/);
      } finally {
        TUNING.drift.catchTime = saved;
      }
    });

    it('is labelled by its title', () => {
      mount();
      const modal = openRules();
      const id = modal.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      expect(document.getElementById(id!)?.textContent).toBe('Правила');
      click(q('.dr-close'));
      click(q('[data-open="records"]'));
      expect(document.getElementById(q('.dr-modal').getAttribute('aria-labelledby')!)?.textContent).toBe('Рекорды');
    });

    it('keeps Tab and Shift+Tab inside the dialog', () => {
      mount();
      const modal = openRules();
      expect(modal.contains(document.activeElement)).toBe(true);
      for (const shiftKey of [false, true, false]) {
        const e = keydown('Tab', { key: 'Tab', shiftKey });
        expect(e.defaultPrevented).toBe(true);
        expect(modal.contains(document.activeElement)).toBe(true);
      }
      // Focus that somehow got behind the dialog is pulled back in on the next Tab.
      q('.dr-cta').focus();
      keydown('Tab', { key: 'Tab' });
      expect(modal.contains(document.activeElement)).toBe(true);
    });

    it('makes the page behind the dialog inert while it is open', () => {
      mount();
      openRules();
      for (const sel of ['.dr-topbar', '.dr-car', '.dr-track']) expect(q(sel).hasAttribute('inert')).toBe(true);
      keydown('Escape', { key: 'Escape' });
      expect(root.querySelector('.dr-modal')).toBeNull();
      for (const sel of ['.dr-topbar', '.dr-car', '.dr-track']) expect(q(sel).hasAttribute('inert')).toBe(false);
    });
  });

  describe('sound toggle', () => {
    it('reflects save.muted', () => {
      mount({ ...SAVE, muted: true });
      expect(q('.dr-sound').getAttribute('aria-checked')).toBe('false');
      ui.update({ ...SAVE, muted: false });
      expect(q('.dr-sound').getAttribute('aria-checked')).toBe('true');
    });

    it('toggles on a pointer click and gives the focus back to the page', () => {
      mount();
      const btn = q<HTMLButtonElement>('.dr-sound');
      btn.focus(); // mousedown focuses a button before its click
      click(btn);
      expect(onMute).toHaveBeenLastCalledWith(true);
      expect(btn.getAttribute('aria-checked')).toBe('false');
      expect(document.activeElement).not.toBe(btn); // Enter must still start the race
      click(btn);
      expect(onMute).toHaveBeenLastCalledWith(false);
      expect(btn.getAttribute('aria-checked')).toBe('true');
    });

    it('toggles on M, but not on Ctrl+M or a held key', () => {
      mount();
      keydown('KeyM', { key: 'm' });
      expect(onMute).toHaveBeenLastCalledWith(true);
      expect(q('.dr-sound').getAttribute('aria-checked')).toBe('false');
      keydown('KeyM', { key: 'm', repeat: true });
      keydown('KeyM', { key: 'm', ctrlKey: true });
      keydown('KeyM', { key: 'm', metaKey: true });
      expect(onMute).toHaveBeenCalledTimes(1);
      keydown('KeyM', { key: 'm' });
      expect(onMute).toHaveBeenLastCalledWith(false);
    });
  });

  describe('ghost bots switch', () => {
    it('reflects save.ghosts', () => {
      mount({ ...SAVE, ghosts: false });
      const btn = q('.dr-ghosts');
      expect(btn.getAttribute('role')).toBe('switch');
      expect(btn.getAttribute('aria-checked')).toBe('false');
      expect(norm(btn.textContent)).toContain('Призраки');
      ui.update({ ...SAVE, ghosts: true });
      expect(btn.getAttribute('aria-checked')).toBe('true');
    });

    it('toggles on a pointer click and gives the focus back to the page', () => {
      mount();
      const btn = q<HTMLButtonElement>('.dr-ghosts');
      btn.focus();
      click(btn);
      expect(onGhosts).toHaveBeenLastCalledWith(false);
      expect(btn.getAttribute('aria-checked')).toBe('false');
      expect(document.activeElement).not.toBe(btn); // Enter must still start the race
      click(btn);
      expect(onGhosts).toHaveBeenLastCalledWith(true);
      expect(btn.getAttribute('aria-checked')).toBe('true');
      expect(onMute).not.toHaveBeenCalled();
    });
  });
});

describe('enterGarage mute wiring (jsdom)', () => {
  it('routes the garage sound toggle to app.setMuted and the ghost switch to app.setGhosts', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let save: SaveData = { ...SAVE };
    const setMuted = vi.fn((m: boolean) => {
      save = { ...save, muted: m };
    });
    const setGhosts = vi.fn((on: boolean) => {
      save = { ...save, ghosts: on };
    });
    const app = {
      ui: root,
      garage: { scene: {}, camera: {}, update: () => {} },
      renderer: { render: () => {} },
      track: { def: { name: 'Площадь' } },
      input: { setRacing: () => {} },
      audio: { setEngineActive: () => {}, unlock: () => Promise.resolve() },
      get save() {
        return save;
      },
      setMuted,
      setGhosts,
      onSaveChanged: () => () => {},
      screen: 'loading',
      redraw: null,
      frameDone: () => {},
    } as unknown as App;
    const screen = enterGarage(app, { lastShown: null, onStart: () => {} });
    keydown('KeyM', { key: 'm' });
    expect(setMuted).toHaveBeenLastCalledWith(true);
    click(root.querySelector('.dr-sound')!);
    expect(setMuted).toHaveBeenLastCalledWith(false);
    click(root.querySelector('.dr-ghosts')!);
    expect(setGhosts).toHaveBeenLastCalledWith(false);
    screen.destroy();
    root.remove();
  });
});
