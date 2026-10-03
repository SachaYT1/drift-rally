/** Geometry shared by the collision modules (collision.ts, collisionSlide.ts). Pure. */
import { clamp } from '../shared/math';

export type Segment = { ax: number; az: number; bx: number; bz: number };

/** Geometric tolerance; also the minimum penetration that counts as an overlap. */
export const EPS = 1e-9;

/** Parameter in [0, 1] of the point on segment ab closest to (px, pz). */
export function closestParamOnSegment(seg: Segment, px: number, pz: number): number {
  const dx = seg.bx - seg.ax;
  const dz = seg.bz - seg.az;
  const len2 = dx * dx + dz * dz;
  if (len2 <= EPS) return 0;
  return clamp(((px - seg.ax) * dx + (pz - seg.az) * dz) / len2, 0, 1);
}
