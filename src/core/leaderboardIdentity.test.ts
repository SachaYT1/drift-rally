import { describe, expect, it } from 'vitest';
import { validateNick } from '../shared/leaderboard';
import { EMPTY_IDENTITY, IDENTITY_KEY, loadIdentity, newBrowserKey, saveIdentity } from './leaderboardIdentity';

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
const KEY = 'ab'.repeat(32);

describe('validateNick', () => {
  it('accepts Russian and Latin letters, digits, _ and - (2-16 chars), trimmed', () => {
    expect(validateNick('  Ёжик_-9 ')).toEqual({ ok: true, nick: 'Ёжик_-9' });
    expect(validateNick('ab')).toEqual({ ok: true, nick: 'ab' });
    expect(validateNick('Щ'.repeat(16))).toEqual({ ok: true, nick: 'Щ'.repeat(16) });
  });
  it('rejects a wrong length', () => {
    expect(validateNick('a')).toEqual({ ok: false, reason: 'length' });
    expect(validateNick('x'.repeat(17))).toEqual({ ok: false, reason: 'length' });
    expect(validateNick('   ')).toEqual({ ok: false, reason: 'length' });
  });
  it('rejects other characters', () => {
    for (const bad of ['a b', 'a<b>', 'ник!', 'naïve', 'a😀', 'a.b']) expect(validateNick(bad)).toEqual({ ok: false, reason: 'chars' });
  });
});

describe('browser key', () => {
  it('is 64 lowercase hex chars from 32 random bytes', () => {
    expect(newBrowserKey((n) => new Uint8Array(n).fill(0xab))).toBe(KEY);
    expect(newBrowserKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(newBrowserKey()).not.toBe(newBrowserKey());
  });
});

describe('identity storage', () => {
  it('is empty without storage, record or with corrupt JSON', () => {
    expect(loadIdentity(null)).toEqual(EMPTY_IDENTITY);
    expect(loadIdentity(mem())).toEqual(EMPTY_IDENTITY);
    const s = mem();
    s.setItem(IDENTITY_KEY, '{oops');
    expect(loadIdentity(s)).toEqual(EMPTY_IDENTITY);
  });

  it('round-trips', () => {
    const s = mem();
    expect(saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 3 }, s)).toBe(true);
    expect(loadIdentity(s)).toEqual({ key: KEY, nick: 'Ёжик', pendingRaces: 3 });
  });

  it('sanitises fields: bad key, a nick without its key, pending out of range', () => {
    const s = mem();
    s.setItem(IDENTITY_KEY, JSON.stringify({ key: 'XYZ', nick: 'Ёжик', pendingRaces: -4 }));
    expect(loadIdentity(s)).toEqual({ key: null, nick: null, pendingRaces: 0 });
    s.setItem(IDENTITY_KEY, JSON.stringify({ key: KEY, nick: 'a b', pendingRaces: 1e9 }));
    expect(loadIdentity(s)).toEqual({ key: KEY, nick: null, pendingRaces: 100 });
  });

  it('save returns false when storage throws', () => {
    const bad = { setItem() { throw new Error('quota'); } } as unknown as Storage;
    expect(saveIdentity({ ...EMPTY_IDENTITY }, bad)).toBe(false);
  });
});
