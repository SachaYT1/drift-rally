/** Unwrapped progress, frontier, laps, wrong-way and respawn markers. Pure. See design spec §2.6. */
import type { GameEvent, Pose } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import type { Track } from '../track/build';

export interface ProgressState {
  /** Last projected arc length (wrapped). */
  s: number;
  lateral: number;
  /** Unwrapped progress measured from the start line, m. */
  p: number;
  /** max(p) so far. */
  frontier: number;
  /** 1-based lap currently being driven (display; capped at laps). */
  lap: number;
  lapsCompleted: number;
  /** Race time (s) at which the current lap started. */
  lapStartTime: number;
  /** Completed lap times, s. */
  lapTimes: number[];
  /** Smoothed ds/dt, m/s. */
  progressSpeed: number;
  wrongWay: boolean;
  wrongWayTimer: number;
  /** Seconds left during which wrong-way is suppressed. */
  graceTimer: number;
  finished: boolean;
  /** Next projection must be a global search (after respawn). */
  needsGlobalSearch: boolean;
}

export function createProgress(_track: Track, _laps: number, _t: Tuning = TUNING): ProgressState {
  throw new Error('not implemented');
}

export function updateProgress(
  _state: ProgressState,
  _track: Track,
  _car: { x: number; z: number; speed: number },
  _time: number,
  _dt: number,
  _laps: number,
  _t: Tuning = TUNING,
): { state: ProgressState; events: GameEvent[]; lapCompleted: boolean } {
  throw new Error('not implemented');
}

/** Respawn pose at the last marker <= frontier, plus the state to continue with. */
export function respawn(
  _state: ProgressState,
  _track: Track,
  _t: Tuning = TUNING,
): { pose: Pose; state: ProgressState } {
  throw new Error('not implemented');
}

/** Grace period after a heavy hit (suppresses wrong-way). */
export function startGrace(_state: ProgressState, _t: Tuning = TUNING): ProgressState {
  throw new Error('not implemented');
}
