/** One race: countdown -> racing -> finished. Orchestrates the pure modules. See design spec §2, §5. */
import type { CarState, GameEvent, InputFrame, RaceResult, SurfaceKind } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import type { Track } from '../track/build';
import type { DriftScoreState } from './driftScore';
import type { PickupState } from './pickups';
import type { ProgressState } from './progress';

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface SessionState {
  phase: RacePhase;
  /** Seconds left in the countdown (phase 'countdown'). */
  countdownLeft: number;
  /** Race time since GO, s (simulation time). */
  time: number;
  laps: number;
  car: CarState;
  /** Car state before the latest step (for render interpolation). */
  prevCar: CarState;
  /** True for the step right after a teleport (respawn/start): renderers must snap. */
  teleported: boolean;
  surface: SurfaceKind;
  progress: ProgressState;
  score: DriftScoreState;
  pickups: PickupState;
  /** Per-collider seconds until it may emit another hit/scrape event. */
  hitCooldowns: Readonly<Record<string, number>>;
  bestLap: number | null;
  result: RaceResult | null;
}

export interface Session {
  readonly track: Track;
  state(): Readonly<SessionState>;
  /** Advance one fixed step. `respawn` is an edge action. */
  step(input: InputFrame, actions: { respawn: boolean }, dt: number): GameEvent[];
}

export function createSession(
  _track: Track,
  _opts: { laps?: number; bestLap?: number | null; tuning?: Tuning } = {},
): Session {
  void TUNING;
  throw new Error('not implemented');
}
