/**
 * Applying a finished race to the save (design spec §2.5, §5 Save). Saved on finish only: quitting
 * mid-race forfeits. applyRaceResult is pure: returns a new SaveData, never mutates the input.
 */
import type { RaceResult, SaveData } from '../shared/types';

export interface SaveOutcome {
  save: SaveData;
  /** The score beats the previous best (and is above 0). */
  newBest: boolean;
  /** The best lap of this race beats the saved best lap (or there was none). */
  newBestLap: boolean;
}

/** Non-negative integer, 0 for anything non-finite. */
function wholeNonNegative(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * coins += coinsEarned; bestScore = max(bestScore, round(totalPoints)); bestLapMs = min(bestLapMs,
 * round(bestLap * 1000)) (RaceResult times are seconds, the save keeps milliseconds). Settings fields
 * (quality, muted) are kept.
 */
export function applyRaceResult(save: Readonly<SaveData>, r: Readonly<RaceResult>): SaveOutcome {
  const score = Number.isFinite(r.totalPoints) ? Math.max(0, Math.round(r.totalPoints)) : 0;
  const newBest = score > save.bestScore;
  const lapMs = Number.isFinite(r.bestLap) && r.bestLap > 0 ? Math.round(r.bestLap * 1000) : null;
  const newBestLap = lapMs !== null && lapMs > 0 && (save.bestLapMs === null || lapMs < save.bestLapMs);
  return {
    save: {
      ...save,
      coins: wholeNonNegative(save.coins) + wholeNonNegative(r.coinsEarned),
      bestScore: newBest ? score : save.bestScore,
      bestLapMs: newBestLap ? lapMs : save.bestLapMs,
    },
    newBest,
    newBestLap,
  };
}

/** Where the save lives: a read-modify-write on the save as stored now (App.updateSave). */
export interface SaveStore {
  updateSave(change: (current: SaveData) => SaveData): SaveData;
}

/**
 * Applies a finished race to the save as stored NOW, not to the copy this tab loaded: another tab may have
 * raced (or changed a setting) since. newBest / newBestLap compare against that stored save.
 */
export function recordRaceResult(store: SaveStore, r: Readonly<RaceResult>): SaveOutcome {
  const applied: { outcome: SaveOutcome | null } = { outcome: null };
  store.updateSave((current) => {
    applied.outcome = applyRaceResult(current, r);
    return applied.outcome.save;
  });
  if (applied.outcome === null) throw new Error('updateSave did not apply the race result');
  return applied.outcome;
}

/** Saved best lap (ms) as the session's seed record (seconds), or null. */
export function bestLapSeconds(save: Readonly<SaveData>): number | null {
  return save.bestLapMs !== null && Number.isFinite(save.bestLapMs) && save.bestLapMs > 0 ? save.bestLapMs / 1000 : null;
}
