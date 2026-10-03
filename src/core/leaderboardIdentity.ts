/**
 * The player's leaderboard identity in this browser (plan/2026-10-03-leaderboard-design.md): the secret
 * browser key, the nick and the finishes not sent yet. Stored apart from the save; never throws.
 */
import { validateNick } from '../shared/leaderboard';

export const IDENTITY_KEY = 'driftRally.leaderboard.v1';

const KEY_FORMAT = /^[0-9a-f]{64}$/;
/** Unsent finishes are capped at what one submit_result call accepts. */
export const MAX_PENDING = 100;

export interface Identity {
  /** 64 hex chars, made with the first nick; null before that. */
  key: string | null;
  /** Nick as the server stored it; null: not on the table. */
  nick: string | null;
  /** Finishes not sent yet. */
  pendingRaces: number;
}

export const EMPTY_IDENTITY: Readonly<Identity> = Object.freeze({ key: null, nick: null, pendingRaces: 0 });

/** A new secret browser key: 32 random bytes as lowercase hex. */
export function newBrowserKey(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(32);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored identity; missing, unreadable or corrupt -> empty (invalid fields drop to their defaults). */
export function loadIdentity(storage?: Storage | null): Identity {
  const store = resolveStorage(storage);
  if (store === null) return { ...EMPTY_IDENTITY };
  let parsed: unknown;
  try {
    const raw = store.getItem(IDENTITY_KEY);
    if (raw === null) return { ...EMPTY_IDENTITY };
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_IDENTITY };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_IDENTITY };
  const r = parsed as Record<string, unknown>;
  const key = typeof r.key === 'string' && KEY_FORMAT.test(r.key) ? r.key : null;
  const nickCheck = typeof r.nick === 'string' ? validateNick(r.nick) : null;
  const pending = typeof r.pendingRaces === 'number' && Number.isFinite(r.pendingRaces) ? Math.floor(r.pendingRaces) : 0;
  return {
    key,
    // A nick without the key that owns it cannot be updated: treat the player as not on the table.
    nick: key !== null && nickCheck?.ok ? nickCheck.nick : null,
    pendingRaces: Math.min(MAX_PENDING, Math.max(0, pending)),
  };
}

/** Returns false when storage is unavailable or full. */
export function saveIdentity(identity: Readonly<Identity>, storage?: Storage | null): boolean {
  const store = resolveStorage(storage);
  if (store === null) return false;
  const record: Identity = { key: identity.key, nick: identity.nick, pendingRaces: identity.pendingRaces };
  try {
    store.setItem(IDENTITY_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
