import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SAVE, SAVE_KEY, loadSave } from '../core/save';
import type { RaceResult, SaveData } from '../shared/types';
import { SMALL_BUFFER, bufferSize, createApp, pixelRatioOf, testFlagsFrom, watchPixelRatio, type App, type AppDeps } from './context';
import { recordRaceResult } from './saveResult';

describe('bufferSize', () => {
  it('uses the canvas size outside small test mode', () => {
    expect(bufferSize(1920, 1080, false)).toEqual({ width: 1920, height: 1080 });
  });

  it('fits the small test buffer while keeping the aspect ratio', () => {
    expect(bufferSize(1280, 720, true)).toEqual({ width: SMALL_BUFFER.width, height: SMALL_BUFFER.height });
    const tall = bufferSize(800, 900, true);
    expect(tall.height).toBe(SMALL_BUFFER.height);
    expect(tall.width / tall.height).toBeCloseTo(800 / 900, 2);
  });

  it('never upscales a canvas smaller than the bound', () => {
    expect(bufferSize(320, 200, true)).toEqual({ width: 320, height: 200 });
  });
});

describe('testFlagsFrom', () => {
  const flags = (q: string) => testFlagsFrom(new URLSearchParams(q));

  it('applies the documented render contract with plain ?test (quality low, small buffer)', () => {
    expect(flags('?test')).toEqual({ test: { enabled: true, small: true }, quality: 'low' });
    expect(flags('?test&small')).toEqual({ test: { enabled: true, small: true }, quality: 'low' });
    expect(flags('?test&quality=bogus')).toEqual({ test: { enabled: true, small: true }, quality: 'low' });
  });

  it('opts out with &full (saved / auto quality) or &quality=<level> (forced, full-size buffer)', () => {
    expect(flags('?test&full')).toEqual({ test: { enabled: true, small: false }, quality: null });
    expect(flags('?test&quality=medium')).toEqual({ test: { enabled: true, small: false }, quality: 'medium' });
    expect(flags('?test&full&quality=high')).toEqual({ test: { enabled: true, small: false }, quality: 'high' });
  });

  it('ignores every test parameter outside test mode', () => {
    expect(flags('')).toEqual({ test: { enabled: false, small: false }, quality: null });
    expect(flags('?quality=low&small')).toEqual({ test: { enabled: false, small: false }, quality: null });
  });
});

describe('pixelRatioOf', () => {
  it('caps devicePixelRatio by quality and pins 1 under the test render contract', () => {
    expect(pixelRatioOf('medium', 2, false)).toBe(1.25);
    expect(pixelRatioOf('high', 1, false)).toBe(1);
    expect(pixelRatioOf('high', 2, true)).toBe(1);
  });
});

describe('watchPixelRatio', () => {
  /** A window whose `(resolution: Ndppx)` queries fire 'change' when the test moves it to another DPR. */
  function fakeWindow(dpr: number) {
    const queries: { media: string; listeners: Set<() => void> }[] = [];
    const win = {
      devicePixelRatio: dpr,
      matchMedia(media: string) {
        const q = { media, listeners: new Set<() => void>() };
        queries.push(q);
        return {
          media,
          addEventListener: (_: string, cb: () => void) => q.listeners.add(cb),
          removeEventListener: (_: string, cb: () => void) => q.listeners.delete(cb),
        } as unknown as MediaQueryList;
      },
      moveTo(next: number) {
        const old = `(resolution: ${win.devicePixelRatio}dppx)`;
        win.devicePixelRatio = next;
        for (const q of queries.filter((x) => x.media === old)) for (const cb of [...q.listeners]) cb();
      },
    };
    return { win, queries };
  }

  it('reports every devicePixelRatio change and re-arms for the new ratio', () => {
    const { win, queries } = fakeWindow(2);
    const onChange = vi.fn();
    const stop = watchPixelRatio(win, onChange);
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 2dppx)']);
    win.moveTo(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(queries.at(-1)?.media).toBe('(resolution: 1dppx)');
    win.moveTo(1.5);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    win.moveTo(2);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(queries.every((q) => q.listeners.size === 0)).toBe(true);
  });
});

describe('save shared between tabs', () => {
  /**
   * One origin's localStorage seen by several tabs, like a browser: every write fires 'storage' at the OTHER
   * tabs only. `deliver: false` holds the events back (they are queued tasks; a tab may act before they run).
   */
  function browserStorage() {
    const map = new Map<string, string>();
    const tabs: EventTarget[] = [];
    const held: { tab: EventTarget; key: string | null }[] = [];
    let deliver = true;
    const notify = (writer: EventTarget, key: string | null): void => {
      for (const tab of tabs) {
        if (tab === writer) continue;
        if (deliver) tab.dispatchEvent(Object.assign(new Event('storage'), { key }));
        else held.push({ tab, key });
      }
    };
    return {
      map,
      tab(): { storage: Storage; events: EventTarget } {
        const events = new EventTarget();
        tabs.push(events);
        const storage = {
          getItem: (k: string) => map.get(k) ?? null,
          setItem(k: string, v: string) {
            map.set(k, v);
            notify(events, k);
          },
          removeItem(k: string) {
            map.delete(k);
            notify(events, k);
          },
          clear() {
            map.clear();
            notify(events, null);
          },
        } as unknown as Storage;
        return { storage, events };
      },
      hold() {
        deliver = false;
      },
      flush() {
        deliver = true;
        for (const { tab, key } of held.splice(0)) tab.dispatchEvent(Object.assign(new Event('storage'), { key }));
      },
      stored(): SaveData {
        return loadSave({ getItem: (k: string) => map.get(k) ?? null } as unknown as Storage);
      },
    };
  }

  /** createApp with inert render / audio stand-ins: only the save plumbing is real. */
  function openTab(storage: Storage | null, events: EventTarget, qualityOverride = false, save = loadSave(storage)): App {
    const scene = { traverse: () => undefined };
    const deps = {
      renderer: { compileAsync: () => Promise.resolve(), getPixelRatio: () => 1, setPixelRatio() {}, setSize() {} },
      canvas: { clientWidth: 0, clientHeight: 0 },
      ui: {},
      track: {},
      garage: { scene, camera: {}, resize() {} },
      race: { scene, camera: {}, env: { setQuality() {} }, setAspect() {} },
      audio: { setMuted() {} },
      input: {},
      test: { enabled: false, small: false },
      save,
      quality: 'medium',
      qualityOverride,
      storage,
      storageEvents: events,
    } as unknown as AppDeps;
    return createApp(deps);
  }

  function race(over: Partial<RaceResult> = {}): RaceResult {
    return {
      totalPoints: 5000, bestChain: 2000, totalTime: 200, lapTimes: [70, 66, 68], bestLap: 66,
      coinsPicked: 20, coinsFromDrift: 5, coinsEarned: 25, ...over,
    };
  }

  beforeEach(() => vi.stubGlobal('window', { devicePixelRatio: 1 }));
  afterEach(() => vi.unstubAllGlobals());

  it('a finish adds to the coins and records another tab saved meanwhile (event not yet delivered)', () => {
    const browser = browserStorage();
    const t1 = browser.tab();
    const t2 = browser.tab();
    const a = openTab(t1.storage, t1.events);
    const b = openTab(t2.storage, t2.events);
    browser.hold();
    recordRaceResult(b, race({ coinsEarned: 40, totalPoints: 9000, bestLap: 64 }));
    const out = recordRaceResult(a, race({ coinsEarned: 25, totalPoints: 5000, bestLap: 66 }));
    expect(browser.stored()).toMatchObject({ coins: 65, bestScore: 9000, bestLapMs: 64_000 });
    expect(a.save).toMatchObject({ coins: 65, bestScore: 9000, bestLapMs: 64_000 });
    // Records are judged against the stored save: tab B's 9000 / 64 s already beat this run.
    expect(out.newBest).toBe(false);
    expect(out.newBestLap).toBe(false);
  });

  it('settings writes patch only their own field of the stored save', () => {
    const browser = browserStorage();
    const t1 = browser.tab();
    const t2 = browser.tab();
    const a = openTab(t1.storage, t1.events);
    const b = openTab(t2.storage, t2.events);
    browser.hold();
    recordRaceResult(b, race({ coinsEarned: 40 }));
    a.setMuted(true);
    expect(browser.stored()).toMatchObject({ coins: 40, bestScore: 5000, muted: true });
    a.setQuality('high');
    expect(browser.stored()).toMatchObject({ coins: 40, bestScore: 5000, muted: true, quality: 'high' });
  });

  it('the ghost bots setting patches only its own field and stays this tab\'s live setting', () => {
    const browser = browserStorage();
    const t1 = browser.tab();
    const t2 = browser.tab();
    const a = openTab(t1.storage, t1.events);
    const b = openTab(t2.storage, t2.events);
    recordRaceResult(b, race({ coinsEarned: 40 }));
    a.setGhosts(false);
    expect(a.save.ghosts).toBe(false);
    expect(browser.stored()).toMatchObject({ coins: 40, bestScore: 5000, ghosts: false });
    // Another tab's toggle does not flip this tab's setting; its own progress still arrives.
    b.setGhosts(true);
    recordRaceResult(b, race({ coinsEarned: 2 }));
    expect(a.save).toMatchObject({ coins: 42, ghosts: false });
  });

  it('a quality override (test mode) is never persisted', () => {
    const browser = browserStorage();
    const t1 = browser.tab();
    const a = openTab(t1.storage, t1.events, true);
    a.setQuality('high');
    expect(browser.map.has(SAVE_KEY)).toBe(false);
  });

  it("another tab's save reaches app.save and onSaveChanged; this tab keeps its live settings", () => {
    const browser = browserStorage();
    const t1 = browser.tab();
    const t2 = browser.tab();
    const a = openTab(t1.storage, t1.events);
    const b = openTab(t2.storage, t2.events);
    const seen: SaveData[] = [];
    const off = a.onSaveChanged((s) => seen.push({ ...s }));
    recordRaceResult(b, race({ coinsEarned: 40 }));
    expect(a.save).toMatchObject({ coins: 40, bestScore: 5000, bestLapMs: 66_000 });
    expect(seen).toEqual([a.save]);
    // Settings are per tab while it runs (its audio / renderer state); progress is shared.
    b.setMuted(true);
    expect(a.save.muted).toBe(false);
    expect(seen.length).toBe(1);
    a.setMuted(true);
    a.setMuted(false);
    expect(browser.stored()).toMatchObject({ coins: 40, muted: false });
    off();
    recordRaceResult(b, race({ coinsEarned: 1 }));
    expect(a.save.coins).toBe(41);
    expect(seen.length).toBe(1);
  });

  it('a save another tab wrote while this one was loading is not missed', () => {
    const browser = browserStorage();
    const t1 = browser.tab();
    const t2 = browser.tab();
    // main.ts reads the save at boot, then loads for seconds before createApp() can listen for 'storage'.
    const bootSnapshot = loadSave(t1.storage);
    const b = openTab(t2.storage, t2.events);
    recordRaceResult(b, race({ coinsEarned: 40, totalPoints: 9000, bestLap: 64 }));
    b.setMuted(true);
    const a = openTab(t1.storage, t1.events, false, bootSnapshot);
    expect(a.save).toMatchObject({ coins: 40, bestScore: 9000, bestLapMs: 64_000 });
    // This tab keeps the settings it booted with (its renderer and audio already use them).
    expect(a.save.muted).toBe(false);
    // Its own next write builds on the stored progress, and later writes still arrive.
    recordRaceResult(a, race({ coinsEarned: 5 }));
    expect(browser.stored().coins).toBe(45);
    recordRaceResult(b, race({ coinsEarned: 1 }));
    expect(a.save.coins).toBe(46);
  });

  it('follows a save cleared in another tab and ignores unrelated keys', () => {
    const browser = browserStorage();
    const t1 = browser.tab();
    const t2 = browser.tab();
    const a = openTab(t1.storage, t1.events);
    recordRaceResult(a, race({ coinsEarned: 12 }));
    const changed = vi.fn();
    a.onSaveChanged(changed);
    t2.storage.setItem('other.key', '1');
    expect(changed).not.toHaveBeenCalled();
    t2.storage.clear();
    expect(a.save).toEqual(DEFAULT_SAVE);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('with a full storage (reads work, writes fail), progress still accumulates in memory', () => {
    const map = new Map<string, string>([[SAVE_KEY, JSON.stringify({ ...DEFAULT_SAVE, coins: 7 })]]);
    const full = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem() {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    } as unknown as Storage;
    const a = openTab(full, new EventTarget());
    recordRaceResult(a, race({ coinsEarned: 10 }));
    recordRaceResult(a, race({ coinsEarned: 5 }));
    expect(a.save.coins).toBe(22);
    // Once writes work again the stored save catches up with this tab.
    full.setItem = (k: string, v: string) => void map.set(k, v);
    a.setMuted(true);
    expect(JSON.parse(map.get(SAVE_KEY) ?? '{}')).toMatchObject({ coins: 22, muted: true });
  });

  it('without storage, progress still accumulates in memory', () => {
    const a = openTab(null, new EventTarget());
    recordRaceResult(a, race({ coinsEarned: 10 }));
    a.setMuted(true);
    recordRaceResult(a, race({ coinsEarned: 5 }));
    expect(a.save).toMatchObject({ coins: 15, bestScore: 5000, muted: true });
  });
});
