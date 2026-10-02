/** Versioned localStorage save. Never throws. See design spec §5 (Save). */
import type { SaveData } from '../shared/types';

export const SAVE_KEY = 'driftRally.save.v1';

export const DEFAULT_SAVE: Readonly<SaveData> = Object.freeze({
  version: 1,
  coins: 0,
  bestScore: 0,
  bestLapMs: null,
  quality: null,
  muted: false,
});

export function loadSave(_storage?: Storage | null): SaveData {
  throw new Error('not implemented');
}

/** Returns false when storage is unavailable or full. */
export function writeSave(_data: SaveData, _storage?: Storage | null): boolean {
  throw new Error('not implemented');
}
