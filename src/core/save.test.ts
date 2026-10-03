import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SAVE, SAVE_KEY, loadSave, readSave, updateSave, writeSave } from './save';

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  key() { return null; }
  get length() { return this.map.size; }
}
const mem = () => new MemStorage() as unknown as Storage;

describe('save', () => {
  it('returns defaults without storage', () => expect(loadSave(null)).toEqual(DEFAULT_SAVE));
  it('returns defaults on corrupt JSON', () => {
    const s = mem(); s.setItem(SAVE_KEY, '{oops');
    expect(loadSave(s)).toEqual(DEFAULT_SAVE);
  });
  it('returns defaults on wrong version', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ version: 9, coins: 5 }));
    expect(loadSave(s)).toEqual(DEFAULT_SAVE);
  });
  it('sanitises bad fields and keeps good ones', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ version: 1, coins: -5, bestScore: 1200, bestLapMs: 'x', quality: 'ultra', muted: true }));
    expect(loadSave(s)).toEqual({ ...DEFAULT_SAVE, bestScore: 1200, muted: true });
  });
  it('round-trips', () => {
    const s = mem();
    const data = { ...DEFAULT_SAVE, coins: 42, bestScore: 9000, bestLapMs: 61234, quality: 'high' as const };
    expect(writeSave(data, s)).toBe(true);
    expect(loadSave(s)).toEqual(data);
  });
  it('write returns false when storage throws', () => {
    const bad = { setItem() { throw new Error('quota'); } } as unknown as Storage;
    expect(writeSave({ ...DEFAULT_SAVE }, bad)).toBe(false);
  });
});

describe('save edge cases', () => {
  const data = { ...DEFAULT_SAVE, coins: 7, bestScore: 3100, bestLapMs: 58000, quality: 'low' as const, muted: true };

  it('returns a fresh mutable object, not the frozen defaults', () => {
    const loaded = loadSave(null);
    expect(loaded).not.toBe(DEFAULT_SAVE);
    expect(Object.isFrozen(loaded)).toBe(false);
  });
  it('returns defaults when reading storage throws', () => {
    const bad = { getItem() { throw new Error('SecurityError'); } } as unknown as Storage;
    expect(loadSave(bad)).toEqual(DEFAULT_SAVE);
  });
  it('returns defaults for valid JSON that is not a save object', () => {
    for (const raw of ['null', '42', '"text"', '[1, 2]']) {
      const s = mem(); s.setItem(SAVE_KEY, raw);
      expect(loadSave(s)).toEqual(DEFAULT_SAVE);
    }
  });
  it('rejects a zero lap time, prototype-named quality and floors fractional coins', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ version: 1, coins: 12.7, bestLapMs: 0, quality: 'toString', muted: 'yes' }));
    expect(loadSave(s)).toEqual({ ...DEFAULT_SAVE, coins: 12 });
  });
  it('writes only the known fields', () => {
    const s = mem();
    const withExtra = { ...data, debug: { huge: true } };
    expect(writeSave(withExtra, s)).toBe(true);
    expect(Object.keys(JSON.parse(s.getItem(SAVE_KEY) ?? '{}')).sort()).toEqual(
      ['bestLapMs', 'bestScore', 'bestScoreCar', 'coins', 'ghosts', 'muted', 'ownedCars', 'quality', 'selectedCar', 'version'],
    );
  });
  it('write returns false without storage', () => expect(writeSave(data, null)).toBe(false));
  it('ghost bots default to on, also for saves written before the setting existed', () => {
    expect(DEFAULT_SAVE.ghosts).toBe(true);
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ version: 1, coins: 3, bestScore: 10, bestLapMs: null, quality: null, muted: false }));
    expect(loadSave(s)).toEqual({ ...DEFAULT_SAVE, coins: 3, bestScore: 10, ghosts: true });
  });
  it('keeps ghost bots off and drops a non-boolean setting', () => {
    const s = mem();
    expect(writeSave({ ...data, ghosts: false }, s)).toBe(true);
    expect(loadSave(s).ghosts).toBe(false);
    s.setItem(SAVE_KEY, JSON.stringify({ version: 1, ghosts: 'no' }));
    expect(loadSave(s).ghosts).toBe(true);
  });

  describe('default storage (localStorage)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(globalThis, 'localStorage');
    });
    it('uses localStorage when no storage is passed', () => {
      vi.stubGlobal('localStorage', mem());
      expect(writeSave(data)).toBe(true);
      expect(loadSave()).toEqual(data);
    });
    it('never throws when localStorage is missing or blocked', () => {
      expect(loadSave()).toEqual(DEFAULT_SAVE);
      expect(writeSave(data)).toBe(false);
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() { throw new Error('SecurityError: access denied'); },
      });
      expect(loadSave()).toEqual(DEFAULT_SAVE);
      expect(writeSave(data)).toBe(false);
    });
  });
});

describe('readSave', () => {
  it('reads the stored save, defaults for a missing or corrupt record', () => {
    const s = mem();
    expect(readSave(s)).toEqual(DEFAULT_SAVE);
    s.setItem(SAVE_KEY, '{oops');
    expect(readSave(s)).toEqual(DEFAULT_SAVE);
    writeSave({ ...DEFAULT_SAVE, coins: 9 }, s);
    expect(readSave(s)).toEqual({ ...DEFAULT_SAVE, coins: 9 });
  });
  it('returns null when storage is unavailable or unreadable', () => {
    expect(readSave(null)).toBeNull();
    const bad = { getItem() { throw new Error('SecurityError'); } } as unknown as Storage;
    expect(readSave(bad)).toBeNull();
  });
});

describe('updateSave (read-modify-write)', () => {
  it('applies the change to the save stored NOW, not to a stale copy, and persists it', () => {
    const s = mem();
    const stale = { ...DEFAULT_SAVE, coins: 10 };
    writeSave({ ...DEFAULT_SAVE, coins: 50, bestScore: 900 }, s); // another tab wrote since `stale` was loaded
    const next = updateSave((cur) => ({ ...cur, coins: cur.coins + 5 }), stale, s).save;
    expect(next).toEqual({ ...DEFAULT_SAVE, coins: 55, bestScore: 900 });
    expect(loadSave(s)).toEqual(next);
  });
  it('never mutates the in-memory fallback', () => {
    const s = mem();
    writeSave({ ...DEFAULT_SAVE, coins: 3 }, s);
    const fallback = { ...DEFAULT_SAVE };
    updateSave((cur) => ({ ...cur, muted: true }), fallback, s);
    expect(fallback).toEqual(DEFAULT_SAVE);
  });
  it('reports whether the result was written', () => {
    const s = mem();
    expect(updateSave((cur) => cur, DEFAULT_SAVE, s).written).toBe(true);
    const full = { getItem: () => null, setItem() { throw new Error('quota'); } } as unknown as Storage;
    expect(updateSave((cur) => cur, DEFAULT_SAVE, full).written).toBe(false);
    expect(updateSave((cur) => cur, DEFAULT_SAVE, null).written).toBe(false);
  });
  it('builds on the fallback when asked to (it is ahead of the stored save after a failed write)', () => {
    const s = mem();
    writeSave({ ...DEFAULT_SAVE, coins: 5 }, s);
    const ahead = { ...DEFAULT_SAVE, coins: 9 };
    expect(updateSave((cur) => ({ ...cur, coins: cur.coins + 1 }), ahead, s, true).save.coins).toBe(10);
    expect(loadSave(s).coins).toBe(10);
  });
  it('falls back to the in-memory save when storage is unreachable', () => {
    const fallback = { ...DEFAULT_SAVE, coins: 40, bestScore: 700 };
    expect(updateSave((cur) => ({ ...cur, coins: cur.coins + 2 }), fallback, null).save).toEqual({ ...fallback, coins: 42 });
    const blocked = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
    } as unknown as Storage;
    expect(updateSave((cur) => ({ ...cur, coins: cur.coins + 2 }), fallback, blocked).save).toEqual({ ...fallback, coins: 42 });
  });
});

describe('save: cars', () => {
  const base = { version: 1, coins: 50, bestScore: 10, bestLapMs: null, quality: null, muted: false };

  it('reads a save from before the line-up as «Искра» only', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify(base));
    expect(loadSave(s)).toEqual({ ...DEFAULT_SAVE, coins: 50, bestScore: 10 });
    expect(loadSave(s)).toMatchObject({ ownedCars: ['iskra'], selectedCar: 'iskra', bestScoreCar: null });
  });

  it('keeps known owned cars in line-up order, always with «Искра»', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ ...base, ownedCars: ['scarab', 'bmw', 'quadro', 'quadro'] }));
    expect(loadSave(s).ownedCars).toEqual(['iskra', 'quadro', 'scarab']);
  });

  it('selects «Искра» when the stored car is unknown or not owned', () => {
    for (const selectedCar of ['ronin', 'bmw', 7]) {
      const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ ...base, ownedCars: ['quadro'], selectedCar }));
      expect(loadSave(s).selectedCar).toBe('iskra');
    }
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ ...base, ownedCars: ['quadro'], selectedCar: 'quadro' }));
    expect(loadSave(s).selectedCar).toBe('quadro');
  });

  it('keeps a known record car and drops an unknown one', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ ...base, bestScoreCar: 'ronin' }));
    expect(loadSave(s).bestScoreCar).toBe('ronin');
    s.setItem(SAVE_KEY, JSON.stringify({ ...base, bestScoreCar: 'bmw' }));
    expect(loadSave(s).bestScoreCar).toBeNull();
  });

  it('round-trips the car fields', () => {
    const s = mem();
    const data = { ...DEFAULT_SAVE, coins: 3, ownedCars: ['iskra', 'ronin'] as const, selectedCar: 'ronin' as const, bestScoreCar: 'iskra' as const };
    expect(writeSave(data, s)).toBe(true);
    expect(loadSave(s)).toEqual(data);
  });
});
