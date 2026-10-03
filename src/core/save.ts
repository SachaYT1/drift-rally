/** Versioned localStorage save. Never throws. See design spec §5 (Save). */
import type { SaveData } from '../shared/types';
import { isQualityLevel } from './quality';

export const SAVE_KEY = 'driftRally.save.v1';

export const DEFAULT_SAVE: Readonly<SaveData> = Object.freeze({
  version: 1,
  coins: 0,
  bestScore: 0,
  bestLapMs: null,
  quality: null,
  muted: false,
});

/**
 * Load the save. `storage` defaults to `localStorage`; pass `null` for "no storage".
 * Missing/unavailable storage, corrupt JSON or a different version → defaults.
 * Individually invalid fields fall back to their defaults; valid fields are kept.
 */
export function loadSave(storage?: Storage | null): SaveData {
  const store = resolveStorage(storage);
  if (store === null) return { ...DEFAULT_SAVE };
  try {
    const raw = store.getItem(SAVE_KEY);
    return raw === null ? { ...DEFAULT_SAVE } : sanitize(JSON.parse(raw));
  } catch {
    // Corrupt JSON or storage access denied (e.g. SecurityError): fall back to defaults.
    return { ...DEFAULT_SAVE };
  }
}

/** Returns false when storage is unavailable or full. */
export function writeSave(data: SaveData, storage?: Storage | null): boolean {
  const store = resolveStorage(storage);
  if (store === null) return false;
  // Persist only the known fields, in a fixed shape.
  const record: SaveData = {
    version: 1,
    coins: data.coins,
    bestScore: data.bestScore,
    bestLapMs: data.bestLapMs,
    quality: data.quality,
    muted: data.muted,
  };
  try {
    store.setItem(SAVE_KEY, JSON.stringify(record));
    return true;
  } catch {
    // Quota exceeded, storage disabled or access denied.
    return false;
  }
}

/** `undefined` → the browser's localStorage (if reachable); `null` → no storage. */
function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    // Accessing localStorage itself throws when storage is blocked (sandboxed iframes, privacy modes).
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function sanitize(parsed: unknown): SaveData {
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SAVE };
  const r = parsed as Record<string, unknown>;
  if (r.version !== DEFAULT_SAVE.version) return { ...DEFAULT_SAVE };
  const coins = nonNegative(r.coins);
  const bestScore = nonNegative(r.bestScore);
  const bestLapMs = positive(r.bestLapMs);
  return {
    version: 1,
    coins: coins === null ? DEFAULT_SAVE.coins : Math.floor(coins),
    bestScore: bestScore ?? DEFAULT_SAVE.bestScore,
    bestLapMs: bestLapMs ?? DEFAULT_SAVE.bestLapMs,
    quality: isQualityLevel(r.quality) ? r.quality : DEFAULT_SAVE.quality,
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SAVE.muted,
  };
}

function nonNegative(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
