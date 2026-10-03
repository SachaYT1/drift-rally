import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SAVE, SAVE_KEY, loadSave, writeSave } from './save';

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
      ['bestLapMs', 'bestScore', 'coins', 'muted', 'quality', 'version'],
    );
  });
  it('write returns false without storage', () => expect(writeSave(data, null)).toBe(false));

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
