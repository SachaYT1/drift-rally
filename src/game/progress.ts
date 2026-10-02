/** Unwrapped progress, frontier, laps, wrong-way and respawn markers. Pure. See design spec §2.6. */
import type { GameEvent, Pose } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { clamp, damp, isFiniteNumber, loopDelta, wrapLength } from '../shared/math';
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
  /**
   * Next projection must be a global search instead of the +/- window search around `s`.
   * Cleared by every update; respawn leaves it false because the respawn pose is known exactly.
   */
  needsGlobalSearch: boolean;
}

export function createProgress(track: Track, _laps: number, t: Tuning = TUNING): ProgressState {
  const proj = track.project(track.spawnPose.x, track.spawnPose.z);
  return {
    s: proj.s,
    lateral: proj.lateral,
    p: t.progress.spawnOffset,
    frontier: t.progress.spawnOffset,
    lap: 1,
    lapsCompleted: 0,
    lapStartTime: 0,
    lapTimes: [],
    progressSpeed: 0,
    wrongWay: false,
    wrongWayTimer: 0,
    graceTimer: 0,
    finished: false,
    needsGlobalSearch: false,
  };
}

/** Wrong-way flag and timers after one step. */
interface WrongWayStep {
  wrongWay: boolean;
  wrongWayTimer: number;
  graceTimer: number;
}

/**
 * Grace suppresses wrong-way; otherwise it is raised after progressSpeed stays below
 * `wrongWaySpeed` for more than `wrongWayTime`, and cleared once progressSpeed >= 0.
 */
function stepWrongWay(state: ProgressState, progressSpeed: number, dt: number, t: Tuning): WrongWayStep {
  const pt = t.progress;
  if (state.graceTimer > 0) {
    return { wrongWay: false, wrongWayTimer: 0, graceTimer: Math.max(0, state.graceTimer - dt) };
  }
  if (progressSpeed < pt.wrongWaySpeed) {
    const wrongWayTimer = state.wrongWayTimer + dt;
    return { wrongWay: state.wrongWay || wrongWayTimer > pt.wrongWayTime, wrongWayTimer, graceTimer: 0 };
  }
  return { wrongWay: state.wrongWay && progressSpeed < 0, wrongWayTimer: 0, graceTimer: 0 };
}

export function updateProgress(
  state: ProgressState,
  track: Track,
  car: { x: number; z: number; speed: number },
  time: number,
  dt: number,
  laps: number,
  t: Tuning = TUNING,
): { state: ProgressState; events: GameEvent[]; lapCompleted: boolean } {
  // A non-finite car (the session respawns it next step) must never poison p / frontier.
  if (!isFiniteNumber(car.x) || !isFiniteNumber(car.z) || !isFiniteNumber(car.speed)) {
    return { state, events: [], lapCompleted: false };
  }
  const L = track.length;
  const proj = state.needsGlobalSearch
    ? track.project(car.x, car.z)
    : track.project(car.x, car.z, state.s, t.progress.window);
  if (!isFiniteNumber(proj.s)) return { state, events: [], lapCompleted: false };

  // Per-step cap against teleport-like projection jumps (spec §2.6).
  const maxDs = Math.abs(car.speed) * dt * t.progress.dsSpeedFactor + t.progress.dsSlack;
  const ds = clamp(loopDelta(state.s, proj.s, L), -maxDs, maxDs);
  const p = state.p + ds;
  const frontier = Math.max(state.frontier, p);
  const progressSpeed =
    dt > 0
      ? state.progressSpeed + (ds / dt - state.progressSpeed) * damp(t.progress.speedSmoothing, dt)
      : state.progressSpeed;

  // Laps: lap k is complete once frontier >= k·L; nothing is counted past the final lap.
  const events: GameEvent[] = [];
  let lapsCompleted = state.lapsCompleted;
  let lapStartTime = state.lapStartTime;
  let lapTimes = state.lapTimes;
  while (lapsCompleted < laps && frontier >= (lapsCompleted + 1) * L) {
    const lapTime = time - lapStartTime;
    const best = lapTimes.every((prev) => lapTime < prev);
    lapTimes = [...lapTimes, lapTime];
    lapsCompleted += 1;
    lapStartTime = time;
    events.push({ type: 'lap', lap: lapsCompleted, lapTime, best });
  }
  const finished = state.finished || lapsCompleted >= laps;

  const ww = stepWrongWay(state, progressSpeed, dt, t);
  if (ww.wrongWay !== state.wrongWay) events.push({ type: 'wrongWay', active: ww.wrongWay });

  return {
    state: {
      s: proj.s,
      lateral: proj.lateral,
      p,
      frontier,
      lap: Math.max(1, Math.min(lapsCompleted + 1, laps)),
      lapsCompleted,
      lapStartTime,
      lapTimes,
      progressSpeed,
      wrongWay: ww.wrongWay,
      wrongWayTimer: ww.wrongWayTimer,
      graceTimer: ww.graceTimer,
      finished,
      needsGlobalSearch: false,
    },
    events,
    lapCompleted: lapsCompleted > state.lapsCompleted,
  };
}

/**
 * Unwrapped progress of the last respawn marker <= frontier. Markers sit every
 * `respawnSpacing` m from the start line within each lap, i.e. exactly on
 * `track.respawnMarkers` (startS + k·spacing, k·spacing < L) in every lap.
 */
function lastMarker(frontier: number, length: number, spacing: number): number {
  let lapIndex = Math.floor(frontier / length);
  // Guard against frontier / length rounding up to the next integer.
  if (lapIndex * length > frontier) lapIndex -= 1;
  const lapBase = lapIndex * length;
  return lapBase + Math.floor((frontier - lapBase) / spacing) * spacing;
}

/** Respawn pose at the last marker <= frontier, plus the state to continue with. */
export function respawn(
  state: ProgressState,
  track: Track,
  t: Tuning = TUNING,
): { pose: Pose; state: ProgressState } {
  const marker = lastMarker(state.frontier, track.length, t.progress.respawnSpacing);
  const s = wrapLength(track.startS + marker, track.length);
  return {
    pose: track.poseAt(s, 0),
    state: {
      ...state,
      s,
      lateral: 0,
      p: marker,
      // The car restarts at rest; the frontier and lap bookkeeping are kept.
      progressSpeed: 0,
      wrongWayTimer: 0,
      graceTimer: t.progress.graceTime,
      // The pose is known exactly, so the next projection can use the local window.
      needsGlobalSearch: false,
    },
  };
}

/** Grace period after a heavy hit (suppresses wrong-way). */
export function startGrace(state: ProgressState, t: Tuning = TUNING): ProgressState {
  return { ...state, graceTimer: t.progress.graceTime };
}
