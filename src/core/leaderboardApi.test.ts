import { describe, expect, it, vi } from 'vitest';
import { BOARD_SIZE, createLeaderboardApi } from './leaderboardApi';

const URL_BASE = 'https://example.supabase.co';
const KEY = 'sb_publishable_test';

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A fake fetch answering each call with the next queued response (or throwing it when it is an Error). */
function fakeFetch(...answers: (Response | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const api = (f: typeof fetch, timeoutMs?: number) => createLeaderboardApi({ url: URL_BASE, apiKey: KEY, fetch: f, timeoutMs });

const ROW = (place: number, nick: string, score: number, lap: number | null) => ({
  place,
  nick,
  best_score: score,
  best_lap_ms: lap,
});

describe('leaderboard api: board', () => {
  it('reads the top with the total from Content-Range and finds the player in it', async () => {
    const { fetch, calls } = fakeFetch(
      json([ROW(1, 'Ёжик', 1500, 52000), ROW(2, 'Петя', 900, null)], 200, { 'Content-Range': '0-1/2' }),
    );
    const r = await api(fetch).board('ёжик');
    expect(r).toEqual({
      ok: true,
      value: {
        top: [
          { place: 1, nick: 'Ёжик', score: 1500, lapMs: 52000 },
          { place: 2, nick: 'Петя', score: 900, lapMs: null },
        ],
        me: { place: 1, nick: 'Ёжик', score: 1500, lapMs: 52000 },
        total: 2,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${URL_BASE}/rest/v1/leaderboard_ranked?select=place,nick,best_score,best_lap_ms&order=place.asc,nick.asc&limit=${BOARD_SIZE}`,
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.apikey).toBe(KEY);
    expect(headers.Prefer).toBe('count=exact');
    expect(calls[0].init.method).toBe('GET');
  });

  it('fetches the player row separately when they rank below the top', async () => {
    const { fetch, calls } = fakeFetch(
      json([ROW(1, 'A1', 3000, 50000)], 200, { 'Content-Range': '0-0/42' }),
      json([ROW(37, 'Вася', 120, 70000)]),
    );
    const r = await api(fetch).board('Вася');
    expect(r.ok && r.value.me).toEqual({ place: 37, nick: 'Вася', score: 120, lapMs: 70000 });
    expect(r.ok && r.value.total).toBe(42);
    expect(calls[1].url).toBe(
      `${URL_BASE}/rest/v1/leaderboard_ranked?select=place,nick,best_score,best_lap_ms&nick=eq.${encodeURIComponent('Вася')}`,
    );
  });

  it('keeps the loaded top when the player row request fails', async () => {
    const { fetch } = fakeFetch(json([ROW(1, 'A1', 3000, 50000)], 200, { 'Content-Range': '0-0/5' }), new TypeError('offline'));
    const r = await api(fetch).board('Вася');
    expect(r.ok && r.value.me).toBeNull();
    expect(r.ok && r.value.top).toHaveLength(1);
  });

  it('counts the rows when Content-Range is missing and drops malformed rows', async () => {
    const { fetch } = fakeFetch(json([ROW(1, 'A1', 3000, 50000), { nick: 5 }, ROW(2, 'B2', 10, null)]));
    const r = await api(fetch).board(null);
    expect(r.ok && r.value.top.map((x) => x.nick)).toEqual(['A1', 'B2']);
    expect(r.ok && r.value.total).toBe(2);
  });

  it('maps an empty table', async () => {
    const { fetch } = fakeFetch(json([], 200, { 'Content-Range': '*/0' }));
    expect(await api(fetch).board(null)).toEqual({ ok: true, value: { top: [], me: null, total: 0 } });
  });

  it('is unavailable without network, on a 5xx or a non-array body', async () => {
    expect(await api(fakeFetch(new TypeError('Failed to fetch')).fetch).board(null)).toEqual({ ok: false, error: 'unavailable' });
    expect(await api(fakeFetch(json({ message: 'down' }, 503)).fetch).board(null)).toEqual({ ok: false, error: 'unavailable' });
    expect(await api(fakeFetch(json({ x: 1 })).fetch).board(null)).toEqual({ ok: false, error: 'unavailable' });
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const pending = api(hanging as unknown as typeof fetch, 1000).board(null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual({ ok: false, error: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('leaderboard api: writes', () => {
  const standing = { nick: 'Ёжик', place: 3, total: 12, best_score: 1500, best_lap_ms: 52000 };

  it('submits through the RPC and returns the standing', async () => {
    const { fetch, calls } = fakeFetch(json(standing));
    const r = await api(fetch).submit({ key: 'k'.repeat(64), nick: 'Ёжик', score: 1500, lapMs: 52000, races: 2 });
    expect(r).toEqual({ ok: true, value: { nick: 'Ёжик', place: 3, total: 12, score: 1500, lapMs: 52000 } });
    expect(calls[0].url).toBe(`${URL_BASE}/rest/v1/rpc/submit_result`);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      p_key: 'k'.repeat(64),
      p_nick: 'Ёжик',
      p_score: 1500,
      p_lap_ms: 52000,
      p_races: 2,
    });
  });

  it('renames through the RPC', async () => {
    const { fetch, calls } = fakeFetch(json({ ...standing, nick: 'Ёж' }));
    const r = await api(fetch).rename('k'.repeat(64), 'Ёж');
    expect(r.ok && r.value.nick).toBe('Ёж');
    expect(calls[0].url).toBe(`${URL_BASE}/rest/v1/rpc/rename_player`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ p_key: 'k'.repeat(64), p_nick: 'Ёж' });
  });

  it('maps the server refusals', async () => {
    const refusal = (message: string, status = 400) => json({ code: 'P0001', message, details: null, hint: null }, status);
    const submit = (f: typeof fetch) => api(f).submit({ key: 'k', nick: 'Nick', score: 1, lapMs: null, races: 1 });
    expect(await submit(fakeFetch(refusal('nick_taken')).fetch)).toEqual({ ok: false, error: 'nick_taken' });
    expect(await submit(fakeFetch(refusal('rate_limited')).fetch)).toEqual({ ok: false, error: 'rate_limited' });
    expect(await submit(fakeFetch(refusal('unknown_player')).fetch)).toEqual({ ok: false, error: 'unknown_player' });
    expect(await submit(fakeFetch(refusal('bad_score')).fetch)).toEqual({ ok: false, error: 'rejected' });
    expect(await submit(fakeFetch(refusal('permission denied', 401)).fetch)).toEqual({ ok: false, error: 'unavailable' });
    expect(await submit(fakeFetch(json(null)).fetch)).toEqual({ ok: false, error: 'unavailable' });
  });

  it('asks whether a nick is free', async () => {
    const { fetch, calls } = fakeFetch(json(false), json(true));
    expect(await api(fetch).nickAvailable('Ёжик')).toEqual({ ok: true, value: false });
    expect(await api(fetch).nickAvailable('Новый')).toEqual({ ok: true, value: true });
    expect(calls[0].url).toBe(`${URL_BASE}/rest/v1/rpc/nick_available`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ p_nick: 'Ёжик' });
  });
});
