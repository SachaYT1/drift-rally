/** Bomb blast impulse on the car. Pure. See plan/2026-10-04-bombs-design.md. */
import type { CarState } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { withDerived } from './car';
import { enterRecover } from './recover';

/** Below this speed (m/s) the direction of travel is noise: the body heading stands in for it. */
const MIN_SPEED = 1;
/** Offsets below this (m) count as on the axis: rounding must not pick a side at random. */
const ON_AXIS = 1e-6;

/** -1, 0 or +1, with |v| < ON_AXIS as 0. */
function sideOf(v: number): number {
  return Math.abs(v) < ON_AXIS ? 0 : Math.sign(v);
}

/**
 * The car thrown by a bomb at (bx, bz): velocity * bomb.speedKeep plus bomb.push across the direction of travel,
 * away from the bomb's side of the path (left when the bomb is dead ahead), so the car keeps going forward and
 * never bounces back off a bomb it runs into. The end of the car over the bomb is thrown away from it
 * (yawRate -= yawKick * sign(lat) * sign(lon), with lat/lon the bomb offset in the body frame, + = left /
 * forward). Then recovery as after a heavy hit.
 */
export function applyBlast(car: CarState, bx: number, bz: number, t: Tuning = TUNING): CarState {
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const dx = bx - car.x;
  const dz = bz - car.z;
  // Body frame: forward (fx, fz), left (fz, -fx).
  const lon = dx * fx + dz * fz;
  const lat = dx * fz - dz * fx;
  // Direction of travel u (body forward when nearly standing); left of it is (uz, -ux).
  const speed = Math.hypot(car.vx, car.vz);
  const ux = speed > MIN_SPEED ? car.vx / speed : fx;
  const uz = speed > MIN_SPEED ? car.vz / speed : fz;
  const side = sideOf(dx * uz - dz * ux) > 0 ? -1 : 1;
  const b = t.bomb;
  const thrown: CarState = {
    ...car,
    vx: car.vx * b.speedKeep + side * uz * b.push,
    vz: car.vz * b.speedKeep - side * ux * b.push,
    yawRate: car.yawRate - b.yawKick * sideOf(lat) * sideOf(lon),
  };
  return withDerived(enterRecover(thrown, t), t);
}
