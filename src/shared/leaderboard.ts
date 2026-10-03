/** Friends leaderboard types shared by the client, the service and the UI (plan/2026-10-03-leaderboard-design.md). */

export const NICK_MIN = 2;
export const NICK_MAX = 16;
/** Same rule as the database check (leaderboard_private.check_nick). */
const NICK_CHARS = /^[A-Za-zА-Яа-яЁё0-9_-]+$/;

export type NickCheck = { ok: true; nick: string } | { ok: false; reason: 'length' | 'chars' };

/** The nick as typed, trimmed and checked against the table's rule. */
export function validateNick(raw: string): NickCheck {
  const nick = raw.trim();
  // Length in characters (code points), like the database's regex.
  const length = [...nick].length;
  if (length < NICK_MIN || length > NICK_MAX) return { ok: false, reason: 'length' };
  if (!NICK_CHARS.test(nick)) return { ok: false, reason: 'chars' };
  return { ok: true, nick };
}

/** Same nick on the table (nicks are unique regardless of case). */
export function sameNick(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export interface BoardRow {
  place: number;
  nick: string;
  score: number;
  /** null: no finished lap. */
  lapMs: number | null;
}

export interface Board {
  /** Best first, at most BOARD_SIZE rows. */
  top: BoardRow[];
  /** The player's row when they have a nick on the table (also when it is in `top`). */
  me: BoardRow | null;
  /** Players on the table. */
  total: number;
}

/** The player's row after a write, with the table size. */
export interface Standing extends BoardRow {
  total: number;
}

/**
 * What a finish did to the table: placed (sent, here is the place); offline (kept, sent on a later launch);
 * rejected (the table refused the result); noNick (the player is not on the table yet).
 */
export type Placement =
  | { kind: 'placed'; place: number; total: number }
  | { kind: 'offline' }
  | { kind: 'rejected' }
  | { kind: 'noNick' };

/** A nick typed by the player: free, taken, not a valid nick, or unknown (no answer from the table). */
export type NickStatus = 'free' | 'taken' | 'invalid' | 'unknown';

/**
 * Claiming or changing a nick. no_result: nothing to put on the table yet (no finished race); busy: the table
 * asked to wait (rate limit).
 */
export type NickResult =
  | { ok: true; standing: Standing }
  | { ok: false; error: 'nick_taken' | 'invalid' | 'unavailable' | 'rejected' | 'no_result' | 'busy' };

/** The table's limits (submit_result): bests outside them are refused. */
export const SCORE_MAX = 200_000;
export const LAP_MS_MIN = 30_000;
export const LAP_MS_MAX = 3_600_000;

/** What the garage's friends table loads. */
export type BoardLoad = { ok: true; board: Board } | { ok: false };

/** The leaderboard as the screens see it (implemented by src/app/leaderboard.ts). */
export interface LeaderboardPort {
  /** Current nick, null when the player is not on the table. */
  nick(): string | null;
  /** The player has a result to put on the table (a finished race). */
  canJoin(): boolean;
  board(): Promise<BoardLoad>;
  checkNick(raw: string): Promise<NickStatus>;
  /** Claim a nick (first time: also sends the bests) or change it. */
  setNick(raw: string): Promise<NickResult>;
}
