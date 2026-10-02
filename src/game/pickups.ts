/** Coins and light knockable props. Pure. See design spec §2.5. */
import type { CarState, GameEvent } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import type { Track } from '../track/build';

export interface PickupState {
  /** Coin ids taken in the current lap. Replaced (never mutated) on change. */
  coinsTaken: ReadonlySet<number>;
  /** Coins picked over the whole race. */
  coinsPicked: number;
  /** Light prop ids knocked in the current lap. */
  propsKnocked: ReadonlySet<string>;
}

export function createPickups(): PickupState {
  throw new Error('not implemented');
}

/** Collect coins and knock light props overlapping the car capsule. */
export function updatePickups(
  _state: PickupState,
  _track: Track,
  _car: CarState,
  _t: Tuning = TUNING,
): { state: PickupState; car: CarState; events: GameEvent[]; knocked: number } {
  throw new Error('not implemented');
}

/** New lap: coins and props come back; coinsPicked is kept. */
export function resetLap(_state: PickupState): PickupState {
  throw new Error('not implemented');
}
