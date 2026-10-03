/**
 * Friends leaderboard REST client (plan/2026-10-03-leaderboard-design.md): plain fetch to the Supabase Data
 * API, no SDK. Never throws: every call resolves to `{ ok: true, value }` or `{ ok: false, error }`.
 */
import { sameNick, type Board, type BoardRow, type Standing } from '../shared/leaderboard';

/** Supabase project of the leaderboard. */
export const LEADERBOARD_URL = 'https://brezucvcujjioibrmerd.supabase.co';
/** Publishable key: public by design, the database access rules protect the data. */
export const LEADERBOARD_KEY = 'sb_publishable_nPLnacmuG3FvEV2BA7anww_mmR1e-Zn';
/** Rows shown in the table. */
export const BOARD_SIZE = 20;

const TIMEOUT_MS = 8000;

/**
 * nick_taken / rate_limited / unknown_player: the server's answers the game reacts to; rejected: any other
 * refusal (bad nick, out-of-range result); unavailable: no network, timeout, a paused project or a 5xx.
 */
export type ApiError = 'nick_taken' | 'rate_limited' | 'unknown_player' | 'rejected' | 'unavailable';

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface SubmitRequest {
  key: string;
  nick: string;
  score: number;
  lapMs: number | null;
  /** Finishes not sent yet (>= 1). */
  races: number;
}

export interface LeaderboardApi {
  /** Top rows, the table size and (with `nick`) the player's own row. */
  board(nick: string | null): Promise<ApiResult<Board>>;
  submit(req: SubmitRequest): Promise<ApiResult<Standing>>;
  rename(key: string, nick: string): Promise<ApiResult<Standing>>;
  /** True when nobody holds the nick (case-insensitive). */
  nickAvailable(nick: string): Promise<ApiResult<boolean>>;
}

export interface LeaderboardApiOptions {
  url?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const KNOWN_ERRORS: readonly ApiError[] = ['nick_taken', 'rate_limited', 'unknown_player'];
const ROW_COLUMNS = 'place,nick,best_score,best_lap_ms';

type Json = unknown;

function fail<T>(error: ApiError): ApiResult<T> {
  return { ok: false, error };
}

function isRecord(v: Json): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** A view / RPC row as a BoardRow, or null when malformed. */
function parseRow(v: Json): BoardRow | null {
  if (!isRecord(v) || typeof v.nick !== 'string') return null;
  const place = finiteInt(v.place);
  const score = finiteInt(v.best_score);
  const lap = v.best_lap_ms === null ? null : finiteInt(v.best_lap_ms);
  if (place === null || score === null || (v.best_lap_ms !== null && lap === null)) return null;
  return { place, nick: v.nick, score, lapMs: lap };
}

function parseStanding(v: Json): Standing | null {
  const row = parseRow(v);
  const total = isRecord(v) ? finiteInt(v.total) : null;
  return row && total !== null ? { ...row, total } : null;
}

/** "0-19/42" or "*\/0" -> 42 / 0; null when absent or unreadable. */
function totalFromRange(header: string | null): number | null {
  const m = header?.match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

export function createLeaderboardApi(opts: LeaderboardApiOptions = {}): LeaderboardApi {
  const base = `${opts.url ?? LEADERBOARD_URL}/rest/v1`;
  const apiKey = opts.apiKey ?? LEADERBOARD_KEY;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  // Resolved per call: tests and e2e may swap globalThis.fetch after the client was made.
  const doFetch = (input: string, init: RequestInit): Promise<Response> => (opts.fetch ?? fetch)(input, init);

  /** One request: the parsed JSON body and the response, or the error it maps to. */
  async function request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ ok: true; body: Json; res: Response } | { ok: false; error: ApiError }> {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
    try {
      const res = await doFetch(`${base}${path}`, {
        method: init.method,
        headers: {
          apikey: apiKey,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ctrl?.signal,
      });
      let body: Json = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.ok) return { ok: true, body, res };
      const message = isRecord(body) && typeof body.message === 'string' ? body.message : '';
      const known = KNOWN_ERRORS.find((e) => e === message);
      if (known) return { ok: false, error: known };
      // A refusal of this request (bad input) vs the service being down / paused / misconfigured.
      return { ok: false, error: res.status === 400 ? 'rejected' : 'unavailable' };
    } catch {
      return { ok: false, error: 'unavailable' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function rpcStanding(fn: string, args: Record<string, unknown>): Promise<ApiResult<Standing>> {
    const r = await request(`/rpc/${fn}`, { method: 'POST', body: args });
    if (!r.ok) return fail(r.error);
    const standing = parseStanding(r.body);
    return standing ? { ok: true, value: standing } : fail('unavailable');
  }

  return {
    async board(nick) {
      const top = await request(
        `/leaderboard_ranked?select=${ROW_COLUMNS}&order=place.asc,nick.asc&limit=${BOARD_SIZE}`,
        { method: 'GET', headers: { Prefer: 'count=exact' } },
      );
      if (!top.ok) return fail(top.error);
      if (!Array.isArray(top.body)) return fail('unavailable');
      const rows = top.body.map(parseRow).filter((r): r is BoardRow => r !== null);
      const total = totalFromRange(top.res.headers.get('Content-Range')) ?? rows.length;
      let me = nick === null ? null : (rows.find((r) => sameNick(r.nick, nick)) ?? null);
      if (nick !== null && me === null) {
        const mine = await request(`/leaderboard_ranked?select=${ROW_COLUMNS}&nick=eq.${encodeURIComponent(nick)}`, {
          method: 'GET',
        });
        // The top already loaded: show it even if the player's own row did not.
        if (mine.ok && Array.isArray(mine.body)) me = parseRow(mine.body[0]);
      }
      return { ok: true, value: { top: rows, me, total } };
    },

    submit(req) {
      return rpcStanding('submit_result', {
        p_key: req.key,
        p_nick: req.nick,
        p_score: req.score,
        p_lap_ms: req.lapMs,
        p_races: req.races,
      });
    },

    rename(key, nick) {
      return rpcStanding('rename_player', { p_key: key, p_nick: nick });
    },

    async nickAvailable(nick) {
      const r = await request('/rpc/nick_available', { method: 'POST', body: { p_nick: nick } });
      if (!r.ok) return fail(r.error);
      return typeof r.body === 'boolean' ? { ok: true, value: r.body } : fail('unavailable');
    },
  };
}
