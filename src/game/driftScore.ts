/** Drift points, chains, multiplier, banking and burning. Pure. See design spec §2.4. */
import { isDrifting } from '../physics/car';
import { clamp } from '../shared/math';
import type { CarState, GameEvent, SurfaceKind } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';

export interface DriftScoreState {
  phase: 'idle' | 'active' | 'grace';
  /** Unbanked points of the current chain. */
  chainPoints: number;
  /** Accumulated accruing time in the current chain, s. */
  chainDriftTime: number;
  multiplier: number;
  /** Seconds left before the chain banks (phase 'grace'). */
  graceTimer: number;
  /** Banked points, floored at 0. */
  totalPoints: number;
  bestChain: number;
}

export interface DriftScoreInput {
  /** Result of canAccrue() for this step. */
  accruing: boolean;
  /** Car slip angle, rad. */
  slip: number;
  /** Forward progress speed ds/dt, m/s. */
  progressSpeed: number;
  heavyHit: boolean;
  respawned: boolean;
  /** Number of light props knocked this step. */
  propsKnocked: number;
  /** Race just finished: bank the active chain. */
  finished: boolean;
}

export function createDriftScore(): DriftScoreState {
  return {
    phase: 'idle',
    chainPoints: 0,
    chainDriftTime: 0,
    multiplier: 1,
    graceTimer: 0,
    totalPoints: 0,
    bestChain: 0,
  };
}

/**
 * True when every scoring condition holds: drifting (mode, speed, |slip|), road or curb,
 * fast enough, not replaying ground behind the frontier, and moving forward along the track
 * (rules out donuts and wrong-way driving).
 */
export function canAccrue(
  args: {
    car: CarState;
    surface: SurfaceKind;
    progress: number;
    frontier: number;
    progressSpeed: number;
  },
  t: Tuning = TUNING,
): boolean {
  const { car, surface, progress, frontier, progressSpeed } = args;
  return (
    isDrifting(car, t) &&
    (surface === 'road' || surface === 'curb') &&
    car.speed > t.score.minSpeed &&
    progress >= frontier - t.score.frontierSlack &&
    progressSpeed > t.score.minProgressSpeed
  );
}

/**
 * Advances the drift score by one fixed step. Order: burn, prop penalties, accrual or
 * grace countdown, finish bank. A non-positive (paused) step changes nothing.
 */
export function updateDriftScore(
  state: DriftScoreState,
  input: DriftScoreInput,
  dt: number,
  t: Tuning = TUNING,
): { state: DriftScoreState; events: GameEvent[] } {
  if (!(dt > 0)) return { state: { ...state }, events: [] };

  const sc = t.score;
  const events: GameEvent[] = [];
  let s: DriftScoreState = { ...state };

  // 1. A heavy hit or a respawn burns the unbanked chain.
  if ((input.heavyHit || input.respawned) && s.phase !== 'idle') {
    events.push({ type: 'chainBurned', points: Math.round(s.chainPoints) });
    s = resetChain(s);
  }

  // 2. Knocked light props cost banked points (floored at 0); the chain survives.
  if (input.propsKnocked > 0) {
    const points = sc.propPenalty * input.propsKnocked;
    s.totalPoints = Math.max(0, s.totalPoints - points);
    events.push({ type: 'penalty', points });
  }

  if (input.accruing) {
    // 3. Accrue. The multiplier depends only on accumulated drifting time, so
    //    toggling accrual on and off cannot pump it.
    if (s.phase === 'idle') events.push({ type: 'chainStart' });
    s.phase = 'active';
    s.graceTimer = 0;
    s.chainDriftTime += dt;
    const multiplier = Math.min(sc.multiplierMax, 1 + Math.floor(s.chainDriftTime / sc.multiplierStep));
    if (multiplier > s.multiplier) events.push({ type: 'multiplier', value: multiplier });
    s.multiplier = multiplier;
    s.chainPoints +=
      sc.basePerSec * angleFactor(input.slip, t) * speedFactor(input.progressSpeed, t) * multiplier * dt;
  } else if (s.phase === 'active') {
    // 4a. Accrual just stopped: start the grace period.
    s.phase = 'grace';
    s.graceTimer = sc.graceTime;
  } else if (s.phase === 'grace') {
    // 4b. Grace countdown; expiry banks the chain.
    s.graceTimer -= dt;
    if (s.graceTimer <= 0) s = bankChain(s, events);
  }

  // 5. Finishing the race banks whatever chain is still open.
  if (input.finished && s.phase !== 'idle') s = bankChain(s, events);

  return { state: s, events };
}

/** min(|slip|, cap) / ref: 1 at the reference angle. */
function angleFactor(slip: number, t: Tuning): number {
  return Math.min(Math.abs(slip), t.score.angleCap) / t.score.angleRef;
}

/** Forward progress speed relative to the reference speed, clamped to [0, cap]. */
function speedFactor(progressSpeed: number, t: Tuning): number {
  return clamp(progressSpeed / t.score.speedRef, 0, t.score.speedFactorCap);
}

/** Returns `s` with the chain cleared back to idle; banked totals are kept. */
function resetChain(s: DriftScoreState): DriftScoreState {
  return { ...s, phase: 'idle', chainPoints: 0, chainDriftTime: 0, multiplier: 1, graceTimer: 0 };
}

/** Banks the rounded chain into the total, records the best chain and appends `chainBanked`. */
function bankChain(s: DriftScoreState, events: GameEvent[]): DriftScoreState {
  const points = Math.round(s.chainPoints);
  events.push({ type: 'chainBanked', points });
  return resetChain({
    ...s,
    totalPoints: s.totalPoints + points,
    bestChain: Math.max(s.bestChain, points),
  });
}
