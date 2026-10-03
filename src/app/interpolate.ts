/**
 * Render interpolation of the car between two fixed simulation steps (design spec §5 "Frame").
 * Only the pose is blended (position: lerp, heading: shortest arc); every other field (velocity, mode,
 * slip, wheel spin, ...) comes from the newer state. A teleport (respawn, race start) or a jump longer
 * than SNAP_DISTANCE renders the newer state as is, so the car never smears across the map. Pure.
 */
import type { CarState } from '../shared/types';
import { lerp, lerpAngle } from '../shared/math';

/**
 * Metres. One fixed step moves the car at most maxSpeed / physicsHz (~0.33 m); anything this far is a
 * teleport even if the session's flag was missed.
 */
export const SNAP_DISTANCE = 6;

/**
 * Car pose at `alpha` in [0, 1] between `prev` (alpha 0) and `curr` (alpha 1). With `snap`, a jump
 * longer than SNAP_DISTANCE, a non-finite alpha or a non-finite `prev` pose, returns `curr`'s pose.
 * Writes into `out` (reused every frame, no allocation) and returns it.
 */
export function interpolateCar(
  prev: Readonly<CarState>,
  curr: Readonly<CarState>,
  alpha: number,
  snap: boolean,
  out: CarState = { ...curr },
): CarState {
  Object.assign(out, curr);
  if (snap || !(alpha >= 0)) return out;
  const t = Math.min(alpha, 1);
  const dx = curr.x - prev.x;
  const dz = curr.z - prev.z;
  // NaN-safe: a non-finite previous pose fails the comparison and snaps.
  if (!(dx * dx + dz * dz <= SNAP_DISTANCE * SNAP_DISTANCE) || !Number.isFinite(prev.heading)) return out;
  out.x = lerp(prev.x, curr.x, t);
  out.z = lerp(prev.z, curr.z, t);
  // Headings are unwrapped (they accumulate turns): blend along the shortest arc.
  out.heading = lerpAngle(prev.heading, curr.heading, t);
  return out;
}
