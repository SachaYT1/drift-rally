/** Drift points, chains, multiplier, banking and burning. Pure. See design spec §2.4. */
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
  throw new Error('not implemented');
}

export function canAccrue(
  _args: {
    car: CarState;
    surface: SurfaceKind;
    progress: number;
    frontier: number;
    progressSpeed: number;
  },
  _t: Tuning = TUNING,
): boolean {
  throw new Error('not implemented');
}

export function updateDriftScore(
  _state: DriftScoreState,
  _input: DriftScoreInput,
  _dt: number,
  _t: Tuning = TUNING,
): { state: DriftScoreState; events: GameEvent[] } {
  throw new Error('not implemented');
}
