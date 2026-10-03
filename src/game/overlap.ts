/** Car-capsule-vs-circle trigger test shared by pickups and bombs. Pure. */
import type { CarState } from '../shared/types';
import type { Tuning } from '../shared/tuning';
import type { carCapsule } from '../physics/car';
import { capsuleOverlapsCircle } from '../physics/collision';

export type Capsule = ReturnType<typeof carCapsule>;

/**
 * Cheap centre-distance precheck (pickups.nearRadius, widened when the capsule reach is larger),
 * then the exact capsule-vs-circle test. NaN-safe (no overlap).
 */
export function touches(car: CarState, cap: Capsule, x: number, z: number, r: number, t: Tuning): boolean {
  const near = Math.max(t.pickups.nearRadius, t.car.capsuleHalf + t.car.radius + r);
  const dx = x - car.x;
  const dz = z - car.z;
  return dx * dx + dz * dz <= near * near && capsuleOverlapsCircle(cap, x, z, r);
}
