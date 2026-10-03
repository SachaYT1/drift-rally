import { describe, expect, it, vi } from 'vitest';
import type { SaveData } from '../shared/types';
import type { Standing } from '../shared/leaderboard';
import type { ApiResult, LeaderboardApi, SubmitRequest } from '../core/leaderboardApi';
import { DEFAULT_SAVE } from '../core/save';
import { IDENTITY_KEY, loadIdentity, saveIdentity } from '../core/leaderboardIdentity';
import { createLeaderboard } from './leaderboard';

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

const KEY = 'c'.repeat(64);
const RAN: SaveData = { ...DEFAULT_SAVE, bestScore: 1500, bestLapMs: 52000 };

const standing = (nick: string, place = 3, total = 12): Standing => ({ nick, place, total, score: 1500, lapMs: 52000 });
const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const err = <T>(error: 'nick_taken' | 'rate_limited' | 'unknown_player' | 'rejected' | 'unavailable'): ApiResult<T> => ({ ok: false, error });

function fakeApi(over: Partial<LeaderboardApi> = {}) {
  return {
    board: vi.fn<LeaderboardApi['board']>(over.board ?? (async () => ok({ top: [], me: null, total: 0 }))),
    submit: vi.fn<LeaderboardApi['submit']>(over.submit ?? (async (req: SubmitRequest) => ok(standing(req.nick)))),
    rename: vi.fn<LeaderboardApi['rename']>(over.rename ?? (async (_key, nick) => ok(standing(nick)))),
    nickAvailable: vi.fn<LeaderboardApi['nickAvailable']>(over.nickAvailable ?? (async () => ok(true))),
  };
}

function setup(opts: { save?: SaveData; storage?: Storage; api?: ReturnType<typeof fakeApi> } = {}) {
  const storage = opts.storage ?? mem();
  const api = opts.api ?? fakeApi();
  let save = opts.save ?? RAN;
  const lb = createLeaderboard({ api, save: () => save, storage, newKey: () => KEY });
  return { lb, api, storage, setSave: (s: SaveData) => (save = s) };
}

describe('leaderboard service: finishes', () => {
  it('counts a finish without a nick and sends nothing', async () => {
    const { lb, api, storage } = setup();
    expect(await lb.recordFinish()).toEqual({ kind: 'noNick' });
    expect(await lb.recordFinish()).toEqual({ kind: 'noNick' });
    expect(api.submit).not.toHaveBeenCalled();
    expect(loadIdentity(storage).pendingRaces).toBe(2);
  });

  it('sends the save bests with the unsent finishes and clears the counter', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 2 }, storage);
    const { lb, api } = setup({ storage });
    expect(await lb.recordFinish()).toEqual({ kind: 'placed', place: 3, total: 12 });
    expect(api.submit).toHaveBeenCalledWith({ key: KEY, nick: 'Ёжик', score: 1500, lapMs: 52000, races: 3 });
    expect(loadIdentity(storage)).toEqual({ key: KEY, nick: 'Ёжик', pendingRaces: 0 });
  });

  it('keeps the finish for later when the table is unreachable or rate-limits', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 0 }, storage);
    const api = fakeApi({ submit: vi.fn(async () => err<Standing>('unavailable')) });
    const { lb } = setup({ storage, api });
    expect(await lb.recordFinish()).toEqual({ kind: 'offline' });
    api.submit.mockResolvedValueOnce(err('rate_limited'));
    expect(await lb.recordFinish()).toEqual({ kind: 'offline' });
    expect(loadIdentity(storage).pendingRaces).toBe(2);
  });

  it('flush sends what an earlier session kept, and nothing when there is nothing', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 4 }, storage);
    const { lb, api } = setup({ storage });
    await lb.flush();
    expect(api.submit).toHaveBeenCalledWith(expect.objectContaining({ races: 4 }));
    await lb.flush();
    expect(api.submit).toHaveBeenCalledTimes(1);
  });

  it('drops the counter when the table rejects the result', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 1 }, storage);
    const { lb } = setup({ storage, api: fakeApi({ submit: vi.fn(async () => err<Standing>('rejected')) }) });
    expect(await lb.recordFinish()).toEqual({ kind: 'rejected' });
    expect(loadIdentity(storage).pendingRaces).toBe(0);
  });

  it('forgets a nick someone else now holds, keeping the finishes', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 0 }, storage);
    const { lb } = setup({ storage, api: fakeApi({ submit: vi.fn(async () => err<Standing>('nick_taken')) }) });
    expect(await lb.recordFinish()).toEqual({ kind: 'noNick' });
    expect(loadIdentity(storage)).toEqual({ key: KEY, nick: null, pendingRaces: 1 });
    expect(lb.nick()).toBeNull();
  });

  it('runs operations one at a time (a boot flush and a finish never overlap)', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 1 }, storage);
    let inFlight = 0;
    let maxInFlight = 0;
    const api = fakeApi({
      submit: vi.fn(async (req: SubmitRequest) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return ok(standing(req.nick));
      }),
    });
    const { lb } = setup({ storage, api });
    await Promise.all([lb.flush(), lb.recordFinish()]);
    expect(maxInFlight).toBe(1);
    expect(api.submit.mock.calls.map((c) => c[0].races)).toEqual([1, 1]);
  });
});

describe('leaderboard service: nick', () => {
  it('claims a nick: stores the key before sending, sends the bests and all counted finishes', async () => {
    const storage = mem();
    saveIdentity({ key: null, nick: null, pendingRaces: 2 }, storage);
    const api = fakeApi();
    api.submit.mockImplementationOnce(async (req: SubmitRequest) => {
      // The key is already persisted while the request is in flight.
      expect(JSON.parse(storage.getItem(IDENTITY_KEY)!).key).toBe(KEY);
      return ok(standing(req.nick, 1, 1));
    });
    const { lb } = setup({ storage, api });
    expect(await lb.setNick('  Ёжик ')).toEqual({ ok: true, standing: standing('Ёжик', 1, 1) });
    expect(api.submit).toHaveBeenCalledWith({ key: KEY, nick: 'Ёжик', score: 1500, lapMs: 52000, races: 2 });
    expect(loadIdentity(storage)).toEqual({ key: KEY, nick: 'Ёжик', pendingRaces: 0 });
  });

  it('refuses to claim without a finished race, and an invalid nick without asking', async () => {
    const { lb, api } = setup({ save: { ...DEFAULT_SAVE } });
    expect(lb.canJoin()).toBe(false);
    expect(await lb.setNick('Ёжик')).toEqual({ ok: false, error: 'no_result' });
    expect(await lb.setNick('a')).toEqual({ ok: false, error: 'invalid' });
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('reports a taken nick and keeps the key for the next try', async () => {
    const storage = mem();
    const { lb } = setup({ storage, api: fakeApi({ submit: vi.fn(async () => err<Standing>('nick_taken')) }) });
    expect(await lb.setNick('Ёжик')).toEqual({ ok: false, error: 'nick_taken' });
    expect(loadIdentity(storage)).toEqual({ key: KEY, nick: null, pendingRaces: 0 });
  });

  it('renames under the stored key', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 0 }, storage);
    const { lb, api } = setup({ storage });
    expect((await lb.setNick('Ёж')).ok).toBe(true);
    expect(api.rename).toHaveBeenCalledWith(KEY, 'Ёж');
    expect(api.submit).not.toHaveBeenCalled();
    expect(lb.nick()).toBe('Ёж');
  });

  it('joins again when the row behind the key is gone', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 0 }, storage);
    const api = fakeApi({ rename: vi.fn(async () => err<Standing>('unknown_player')) });
    const { lb } = setup({ storage, api });
    expect((await lb.setNick('Ёж')).ok).toBe(true);
    expect(api.submit).toHaveBeenCalledWith(expect.objectContaining({ key: KEY, nick: 'Ёж', races: 1 }));
  });

  it('checks a nick: format locally, own nick as free, others on the table', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 0 }, storage);
    const api = fakeApi({ nickAvailable: vi.fn(async () => ok(false)) });
    const { lb } = setup({ storage, api });
    expect(await lb.checkNick('x')).toBe('invalid');
    expect(await lb.checkNick('ЁЖИК')).toBe('free');
    expect(await lb.checkNick('Петя')).toBe('taken');
    api.nickAvailable.mockResolvedValueOnce(err('unavailable'));
    expect(await lb.checkNick('Петя')).toBe('unknown');
    expect(api.nickAvailable).toHaveBeenCalledTimes(2);
  });

  it('works on memory alone when storage is unavailable', async () => {
    const api = fakeApi();
    const lb = createLeaderboard({ api, save: () => RAN, storage: null, newKey: () => KEY });
    expect((await lb.setNick('Ёжик')).ok).toBe(true);
    expect(await lb.recordFinish()).toEqual({ kind: 'placed', place: 3, total: 12 });
    expect(api.submit).toHaveBeenLastCalledWith(expect.objectContaining({ key: KEY, nick: 'Ёжик', races: 1 }));
  });

  it('board asks with the current nick', async () => {
    const storage = mem();
    saveIdentity({ key: KEY, nick: 'Ёжик', pendingRaces: 0 }, storage);
    const { lb, api } = setup({ storage });
    expect(await lb.board()).toEqual({ ok: true, board: { top: [], me: null, total: 0 } });
    expect(api.board).toHaveBeenCalledWith('Ёжик');
    api.board.mockResolvedValueOnce(err('unavailable'));
    expect(await lb.board()).toEqual({ ok: false });
  });
});
