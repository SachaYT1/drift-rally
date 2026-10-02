/** Car-vs-static collision on the ground plane. Pure. See design spec §2.4 / §3. */
import type { CarState, Collider, CollisionResult } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';

/** Push the car capsule out of every overlapping collider and respond with restitution/friction. */
export function resolveCollisions(
  _state: CarState,
  _colliders: readonly Collider[],
  _t: Tuning = TUNING,
): CollisionResult {
  throw new Error('not implemented');
}

/** Overlap test between a capsule and a circle (used for pickups). */
export function capsuleOverlapsCircle(
  _cap: { ax: number; az: number; bx: number; bz: number; r: number },
  _x: number,
  _z: number,
  _r: number,
): boolean {
  throw new Error('not implemented');
}
