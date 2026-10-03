/**
 * The friends leaderboard service the screens use (plan/2026-10-03-leaderboard-design.md). Counts finishes,
 * sends the save's bests under the player's nick, keeps what could not be sent for a later launch, and claims
 * or changes the nick. Never throws; operations run one at a time so a boot flush and a finish never race.
 */
import type { SaveData } from '../shared/types';
import {
  sameNick,
  validateNick,
  type BoardLoad,
  type LeaderboardPort,
  type NickResult,
  type NickStatus,
  type Placement,
  type Standing,
} from '../shared/leaderboard';
import type { LeaderboardApi } from '../core/leaderboardApi';
import { MAX_PENDING, loadIdentity, newBrowserKey, saveIdentity, type Identity } from '../core/leaderboardIdentity';

export interface Leaderboard extends LeaderboardPort {
  /** A race finished and the save already holds its records: count it, send the bests when there is a nick. */
  recordFinish(): Promise<Placement>;
  /** Send finishes an earlier session could not (boot). */
  flush(): Promise<void>;
}

export interface LeaderboardDeps {
  api: LeaderboardApi;
  /** The save as it is now (bests to send, whether there is anything to send). */
  save(): Readonly<SaveData>;
  /** Where the identity lives (default localStorage; null: memory only). */
  storage?: Storage | null;
  /** Browser key generator (tests). */
  newKey?: () => string;
}

/** A finished race exists: a lap time, or points. */
function hasResult(save: Readonly<SaveData>): boolean {
  return save.bestLapMs !== null || save.bestScore > 0;
}

export function createLeaderboard(d: LeaderboardDeps): Leaderboard {
  const makeKey = d.newKey ?? (() => newBrowserKey());
  /** In-memory copy for when storage is unavailable; storage wins when readable (other tabs write it too). */
  let memory: Identity = loadIdentity(d.storage);
  let queue: Promise<unknown> = Promise.resolve();

  function load(): Identity {
    if (d.storage === null) return { ...memory };
    const stored = loadIdentity(d.storage);
    // Unreadable storage reads as empty: keep the copy this tab has.
    return stored.key === null && memory.key !== null ? { ...memory } : stored;
  }

  function store(next: Identity): Identity {
    memory = { ...next };
    saveIdentity(next, d.storage);
    return next;
  }

  /** Run after every earlier operation settled. */
  function serial<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op, op);
    queue = run.catch(() => undefined);
    return run;
  }

  /** Took `sent` finishes off the counter and adopted the server's nick. */
  function settle(sent: number, standing: Standing): void {
    const now = load();
    store({ ...now, nick: standing.nick, pendingRaces: Math.max(0, now.pendingRaces - sent) });
  }

  /** Send the save's bests with the pending finishes under the stored key and nick. */
  async function sendPending(id: Identity & { key: string; nick: string }): Promise<Placement> {
    const save = d.save();
    const races = Math.min(MAX_PENDING, Math.max(1, id.pendingRaces));
    const r = await d.api.submit({ key: id.key, nick: id.nick, score: save.bestScore, lapMs: save.bestLapMs, races });
    if (r.ok) {
      settle(id.pendingRaces, r.value);
      return { kind: 'placed', place: r.value.place, total: r.value.total };
    }
    switch (r.error) {
      case 'nick_taken':
        // Someone holds this nick now (our row was removed): the player picks a new one; finishes stay counted.
        store({ ...load(), nick: null });
        return { kind: 'noNick' };
      case 'rejected':
      case 'unknown_player':
        // Retrying the same bests cannot succeed.
        store({ ...load(), pendingRaces: 0 });
        return { kind: 'rejected' };
      default:
        return { kind: 'offline' };
    }
  }

  function withNick(id: Identity): (Identity & { key: string; nick: string }) | null {
    return id.key !== null && id.nick !== null ? { ...id, key: id.key, nick: id.nick } : null;
  }

  async function claim(nick: string): Promise<NickResult> {
    const save = d.save();
    if (!hasResult(save)) return { ok: false, error: 'no_result' };
    // Persist the key before sending: if the reply is lost, a retry must come from the same owner.
    const id = store({ ...load(), key: load().key ?? makeKey() });
    const races = Math.min(MAX_PENDING, Math.max(1, id.pendingRaces));
    const r = await d.api.submit({ key: id.key!, nick, score: save.bestScore, lapMs: save.bestLapMs, races });
    if (r.ok) {
      settle(id.pendingRaces, r.value);
      return { ok: true, standing: r.value };
    }
    return { ok: false, error: nickError(r.error) };
  }

  return {
    nick: () => load().nick,

    canJoin: () => hasResult(d.save()),

    recordFinish() {
      return serial(async (): Promise<Placement> => {
        const id = store({ ...load(), pendingRaces: Math.min(MAX_PENDING, load().pendingRaces + 1) });
        const owned = withNick(id);
        return owned ? sendPending(owned) : { kind: 'noNick' };
      });
    },

    flush() {
      return serial(async () => {
        const owned = withNick(load());
        if (owned && owned.pendingRaces > 0) await sendPending(owned);
      });
    },

    async board(): Promise<BoardLoad> {
      const r = await d.api.board(load().nick);
      return r.ok ? { ok: true, board: r.value } : { ok: false };
    },

    async checkNick(raw): Promise<NickStatus> {
      const v = validateNick(raw);
      if (!v.ok) return 'invalid';
      const own = load().nick;
      if (own !== null && sameNick(own, v.nick)) return 'free';
      const r = await d.api.nickAvailable(v.nick);
      if (!r.ok) return 'unknown';
      return r.value ? 'free' : 'taken';
    },

    setNick(raw) {
      return serial(async (): Promise<NickResult> => {
        const v = validateNick(raw);
        if (!v.ok) return { ok: false, error: 'invalid' };
        const owned = withNick(load());
        if (!owned) return claim(v.nick);
        const r = await d.api.rename(owned.key, v.nick);
        if (r.ok) {
          store({ ...load(), nick: r.value.nick });
          return { ok: true, standing: r.value };
        }
        // Our row is gone (cleared by hand): join again under the same key.
        if (r.error === 'unknown_player') return claim(v.nick);
        return { ok: false, error: nickError(r.error) };
      });
    },
  };
}

function nickError(e: string): 'nick_taken' | 'rejected' | 'unavailable' {
  if (e === 'nick_taken') return 'nick_taken';
  if (e === 'rejected') return 'rejected';
  return 'unavailable';
}
