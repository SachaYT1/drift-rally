/** Coins and light knockable props. Pure. See design spec §2.5. */
import type { CarState, GameEvent } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { wrapAngle } from '../shared/math';
import { carCapsule } from '../physics/car';
import { capsuleOverlapsCircle } from '../physics/collision';
import type { Track } from '../track/build';

/**
 * Broad-phase radius around the car centre, m: farther spots skip the capsule test.
 * Fixed by the plan rather than a gameplay tuning value; widened per spot if live tuning
 * ever makes the capsule reach (capsuleHalf + radius + spot radius) larger.
 */
const NEAR_RADIUS = 8;
/** A knocked prop is launched with the car velocity times this factor (fx only). */
const PROP_LAUNCH_FACTOR = 1.2;
/** Below this speed the slip angle is reported as 0, m/s (CarState.slip contract). */
const SLIP_MIN_SPEED = 1;

type Capsule = ReturnType<typeof carCapsule>;

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
      vx: car.vx * PROP_LAUNCH_FACTOR,
      vz: car.vz * PROP_LAUNCH_FACTOR,
    });
  }

  const knocked = propIds.length;
  return {
    state: {
      coinsTaken: coinIds.length > 0 ? new Set([...state.coinsTaken, ...coinIds]) : state.coinsTaken,
      coinsPicked: state.coinsPicked + coinIds.length,
      propsKnocked: knocked > 0 ? new Set([...state.propsKnocked, ...propIds]) : state.propsKnocked,
    },
    car: knocked > 0 ? scaleVelocity(car, (1 - t.pickups.knockSpeedLoss) ** knocked) : car,
    events,
    knocked,
  };
}

/** New lap: coins and props come back; coinsPicked is kept. */
export function resetLap(state: PickupState): PickupState {
  return { coinsTaken: new Set<number>(), coinsPicked: state.coinsPicked, propsKnocked: new Set<string>() };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Cheap centre-distance precheck, then the exact capsule-vs-circle test. NaN-safe (no overlap). */
function touches(car: CarState, cap: Capsule, x: number, z: number, r: number, t: Tuning): boolean {
  const near = Math.max(NEAR_RADIUS, t.car.capsuleHalf + t.car.radius + r);
  const dx = x - car.x;
  const dz = z - car.z;
  return dx * dx + dz * dz <= near * near && capsuleOverlapsCircle(cap, x, z, r);
}

/** The car with its velocity scaled by `k` and the derived kinematic fields recomputed. */
function scaleVelocity(car: CarState, k: number): CarState {
  const vx = car.vx * k;
  const vz = car.vz * k;
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const speed = Math.hypot(vx, vz);
  return {
    ...car,
    vx,
    vz,
    speed,
    forwardSpeed: vx * fx + vz * fz,
    lateralSpeed: vx * fz - vz * fx,
    slip: speed < SLIP_MIN_SPEED ? 0 : wrapAngle(car.heading - Math.atan2(vx, vz)),
  };
}
