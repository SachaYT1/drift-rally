/**
 * Applying a finished race to the save (design spec §2.5, §5 Save). Saved on finish only: quitting
 * mid-race forfeits. Pure: returns a new SaveData, never mutates the input.
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

/** Saved best lap (ms) as the session's seed record (seconds), or null. */
export function bestLapSeconds(save: Readonly<SaveData>): number | null {
  return save.bestLapMs !== null && Number.isFinite(save.bestLapMs) && save.bestLapMs > 0 ? save.bestLapMs / 1000 : null;
}
