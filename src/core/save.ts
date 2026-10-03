/**
 * Versioned localStorage save. Never throws. See design spec §5 (Save).
 *
 * Two records: SAVE_KEY holds coins, records and settings; GARAGE_KEY holds the cars owned and the selected car
 * (plan/2026-10-04-sport-cars.md). Game versions before the car line-up rewrite SAVE_KEY with only the fields
 * they know (read-modify-write), so a tab of an older version left open would strip any car field kept there
 * and lose the cars a newer tab bought; it never touches GARAGE_KEY. bestScoreCar stays in SAVE_KEY next to the
 * score it belongs to: an older tab strips it, which reads as «unknown car», never as a wrong one.
 */
import type { SaveData } from '../shared/types';
import { CAR_IDS, DEFAULT_CAR, isCarId, type CarId } from '../shared/cars';
import { isQualityLevel } from './quality';

export const SAVE_KEY = 'driftRally.save.v1';
/** The garage record: `{ version: 1, ownedCars, selectedCar }`. */
export const GARAGE_KEY = 'driftRally.garage.v1';

export const DEFAULT_SAVE: Readonly<SaveData> = Object.freeze({
  version: 1,
  coins: 0,
  bestScore: 0,
  bestLapMs: null,
  quality: null,
  muted: false,
  ghosts: true,
  ownedCars: Object.freeze([DEFAULT_CAR]) as readonly CarId[],
  selectedCar: DEFAULT_CAR,
  bestScoreCar: null,
});

/**
 * Load the save. `storage` defaults to `localStorage`; pass `null` for "no storage".
 * Missing/unavailable/unreadable storage, corrupt JSON or a different version → defaults.
 * Individually invalid fields fall back to their defaults; valid fields are kept.
 */
export function loadSave(storage?: Storage | null): SaveData {
  return readSave(storage) ?? { ...DEFAULT_SAVE };
}

/**
 * The save as stored right now, or null when storage is unavailable or unreadable (the caller keeps its own
 * copy then). A missing, corrupt or other-version record reads as the defaults, like loadSave().
 */
export function readSave(storage?: Storage | null): SaveData | null {
  const store = resolveStorage(storage);
  if (store === null) return null;
  let raw: string | null;
  let garage: string | null;
  try {
    raw = store.getItem(SAVE_KEY);
    garage = store.getItem(GARAGE_KEY);
  } catch {
    return null;
  }
  return withGarage(parseSave(raw), garage);
}

/**
 * Read-modify-write. Another tab may have saved since this one loaded, so `change` is applied to the save as
 * stored NOW and the result is written back. `fallback` (the caller's in-memory copy) is the base instead
 * when storage is unreachable, or when `fromFallback` says it is ahead of storage (an earlier write failed).
 * Never throws: `written` is false when the write failed and the game keeps running on `save`.
 */
export function updateSave(
  change: (current: SaveData) => SaveData,
  fallback: Readonly<SaveData>,
  storage?: Storage | null,
  fromFallback = false,
): { save: SaveData; written: boolean } {
  const store = resolveStorage(storage);
  const next = change((fromFallback ? null : readSave(store)) ?? { ...fallback });
  return { save: next, written: writeSave(next, store) };
}

/** Returns false when storage is unavailable or full. */
export function writeSave(data: SaveData, storage?: Storage | null): boolean {
  const store = resolveStorage(storage);
  if (store === null) return false;
  // Persist only the known fields, in a fixed shape.
  const record = {
    version: 1,
    coins: data.coins,
    bestScore: data.bestScore,
    bestLapMs: data.bestLapMs,
    quality: data.quality,
    muted: data.muted,
    ghosts: data.ghosts,
    bestScoreCar: data.bestScoreCar,
  };
  const garage = { version: 1, ownedCars: [...data.ownedCars], selectedCar: data.selectedCar };
  try {
    // The garage goes first: should the second write fail, a purchase keeps its car rather than the coins.
    store.setItem(GARAGE_KEY, JSON.stringify(garage));
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

/** A stored record (null: none) as a save; corrupt JSON → defaults. */
function parseSave(raw: string | null): SaveData {
  if (raw === null) return { ...DEFAULT_SAVE };
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SAVE };
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
    ghosts: typeof r.ghosts === 'boolean' ? r.ghosts : DEFAULT_SAVE.ghosts,
    ownedCars: DEFAULT_SAVE.ownedCars,
    selectedCar: DEFAULT_SAVE.selectedCar,
    bestScoreCar: isCarId(r.bestScoreCar) ? r.bestScoreCar : DEFAULT_SAVE.bestScoreCar,
  };
}

/**
 * `save` with the garage stored under GARAGE_KEY; a missing, corrupt or other-version garage reads as the free
 * car only. The selected car must be owned, else it is the free car.
 */
function withGarage(save: SaveData, raw: string | null): SaveData {
  let parsed: unknown = null;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const g = typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).version === 1
    ? (parsed as Record<string, unknown>)
    : {};
  const ownedCars = ownedCarsFrom(g.ownedCars);
  const selectedCar = isCarId(g.selectedCar) && ownedCars.includes(g.selectedCar) ? g.selectedCar : DEFAULT_CAR;
  return { ...save, ownedCars, selectedCar };
}

/** Known car ids of a stored list, in line-up order, always with the free car; unknown or repeated ids drop out. */
function ownedCarsFrom(v: unknown): CarId[] {
  const stored: unknown[] = Array.isArray(v) ? v : [];
  return CAR_IDS.filter((id) => id === DEFAULT_CAR || stored.includes(id));
}

function nonNegative(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
