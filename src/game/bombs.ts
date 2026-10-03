/** Bombs on the road: a touch blows one up once per lap, throwing the car. Pure. See plan/2026-10-04-bombs-design.md. */
import type { CarState, GameEvent } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { carCapsule } from '../physics/car';
import { applyBlast } from '../physics/blast';
import type { Track } from '../track/build';
import { touches } from './overlap';

export interface BombState {
  /** Bomb ids blown in the current lap. Replaced (never mutated) on change. */
  blown: ReadonlySet<string>;
}

export function createBombs(): BombState {
  return { blown: new Set<string>() };
}

/** New lap: every bomb is back (the same object when none was blown). */
export function resetBombs(state: BombState): BombState {
  return state.blown.size === 0 ? state : createBombs();
}

/**
 * Blow up every not-yet-blown bomb overlapping the car capsule; each emits 'bomb'. The car takes one blast
 * per step, from the touched bomb nearest its centre. `blasted` tells the session to burn the chain.
 */
export function updateBombs(
  state: BombState,
  track: Track,
  car: CarState,
  t: Tuning = TUNING,
): { state: BombState; car: CarState; events: GameEvent[]; blasted: boolean } {
  const events: GameEvent[] = [];
  if (track.bombs.length === 0) return { state, car, events, blasted: false };
  const cap = carCapsule(car, t);
  const ids: string[] = [];
  let nearest: { x: number; z: number; d: number } | null = null;
  for (const b of track.bombs) {
    if (state.blown.has(b.id) || !touches(car, cap, b.x, b.z, b.r, t)) continue;
    ids.push(b.id);
    events.push({ type: 'bomb', id: b.id, x: b.x, z: b.z });
    const d = Math.hypot(b.x - car.x, b.z - car.z);
    if (!nearest || d < nearest.d) nearest = { x: b.x, z: b.z, d };
  }
  if (!nearest) return { state, car, events, blasted: false };
  return {
    state: { blown: new Set([...state.blown, ...ids]) },
    car: applyBlast(car, nearest.x, nearest.z, t),
    events,
    blasted: true,
  };
}
