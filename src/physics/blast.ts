/** Bomb blast impulse on the car. Pure. See plan/2026-10-04-bombs-design.md. */
import type { CarState } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { withDerived } from './car';
import { enterRecover } from './recover';

/** Closer than this (m) the bomb counts as under the car centre: the push goes sideways. */
const MIN_DIST = 1e-3;

/**
 * The car thrown by a bomb at (bx, bz): velocity * bomb.speedKeep + bomb.push away from the bomb centre;
 * the end of the car over the bomb is thrown away from it (yawRate -= yawKick * sign(lat) * sign(lon), with
 * lat/lon the bomb offset in the body frame, + = left / forward); then recovery as after a heavy hit.
 */
export function applyBlast(car: CarState, bx: number, bz: number, t: Tuning = TUNING): CarState {
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const dx = bx - car.x;
  const dz = bz - car.z;
  // Body frame: forward (fx, fz), left (fz, -fx).
  const lon = dx * fx + dz * fz;
  const lat = dx * fz - dz * fx;
  const dist = Math.hypot(dx, dz);
  // Away from the bomb; with the bomb under the centre, sideways away from its side (left when centred).
  const side = lat > 0 ? -1 : 1;
  const nx = dist > MIN_DIST ? -dx / dist : side * fz;
  const nz = dist > MIN_DIST ? -dz / dist : -side * fx;
  const b = t.bomb;
  const thrown: CarState = {
    ...car,
    vx: car.vx * b.speedKeep + nx * b.push,
    vz: car.vz * b.speedKeep + nz * b.push,
    yawRate: car.yawRate - b.yawKick * Math.sign(lat) * Math.sign(lon),
  };
  return withDerived(enterRecover(thrown, t), t);
}
