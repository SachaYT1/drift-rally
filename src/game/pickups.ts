/** Coins and light knockable props. Pure. See design spec §2.5. */
import type { CarState, GameEvent } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { carCapsule, withDerived } from '../physics/car';
import type { Track } from '../track/build';
import { touches } from './overlap';

export interface PickupState {
  /** Coin ids taken in the current lap. Replaced (never mutated) on change. */
  coinsTaken: ReadonlySet<number>;
  /** Coins picked over the whole race. */
  coinsPicked: number;
  /** Light prop ids knocked in the current lap. */
  propsKnocked: ReadonlySet<string>;
}

export function createPickups(): PickupState {
  return { coinsTaken: new Set<number>(), coinsPicked: 0, propsKnocked: new Set<string>() };
}

/** Collect coins and knock light props overlapping the car capsule. */
export function updatePickups(
  state: PickupState,
  track: Track,
  car: CarState,
  t: Tuning = TUNING,
): { state: PickupState; car: CarState; events: GameEvent[]; knocked: number } {
  const cap = carCapsule(car, t);
  const events: GameEvent[] = [];

  const coinIds: number[] = [];
  for (const coin of track.coins) {
    if (state.coinsTaken.has(coin.id) || !touches(car, cap, coin.x, coin.z, t.pickups.coinRadius, t)) continue;
    coinIds.push(coin.id);
    events.push({ type: 'coin', id: coin.id, x: coin.x, z: coin.z });
  }

  const propIds: string[] = [];
  for (const prop of track.lightProps) {
    if (state.propsKnocked.has(prop.id) || !touches(car, cap, prop.x, prop.z, prop.r, t)) continue;
    propIds.push(prop.id);
    events.push({
      type: 'propKnocked',
      id: prop.id,
      kind: prop.kind,
      x: prop.x,
      z: prop.z,
      vx: car.vx * t.pickups.propLaunchFactor,
      vz: car.vz * t.pickups.propLaunchFactor,
    });
  }

  const knocked = propIds.length;
  const keep = (1 - t.pickups.knockSpeedLoss) ** knocked;
  return {
    state: {
      coinsTaken: coinIds.length > 0 ? new Set([...state.coinsTaken, ...coinIds]) : state.coinsTaken,
      coinsPicked: state.coinsPicked + coinIds.length,
      propsKnocked: knocked > 0 ? new Set([...state.propsKnocked, ...propIds]) : state.propsKnocked,
    },
    // Velocity scaled per knocked prop, derived fields recomputed.
    car: knocked > 0 ? withDerived({ ...car, vx: car.vx * keep, vz: car.vz * keep }, t) : car,
    events,
    knocked,
  };
}

/** New lap: coins and props come back; coinsPicked is kept. */
export function resetLap(state: PickupState): PickupState {
  return { coinsTaken: new Set<number>(), coinsPicked: state.coinsPicked, propsKnocked: new Set<string>() };
}
