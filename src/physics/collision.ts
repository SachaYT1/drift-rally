/** Car-vs-static collision on the ground plane. Pure. See design spec §2.4 / §3. */
import type { CarState, Collider, CollisionResult, Contact } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { clamp } from '../shared/math';
import { carCapsule, withDerived } from './car';

type Capsule = { ax: number; az: number; bx: number; bz: number; r: number };
type Segment = { ax: number; az: number; bx: number; bz: number };
type WallCollider = Extract<Collider, { kind: 'wall' }>;

/** One overlap: push the car by `pen` along the unit normal (nx, nz); (x, z) is the contact point. */
interface Overlap {
  pen: number;
  nx: number;
  nz: number;
  x: number;
  z: number;
}

/** Geometric tolerance; also the minimum penetration that counts as an overlap. */
const EPS = 1e-9;

/**
 * Push the car capsule out of every overlapping collider and respond with restitution/friction.
 * Up to `collision.iterations` passes; each pass resolves the current overlaps deepest first.
 */
export function resolveCollisions(
  state: CarState,
  colliders: readonly Collider[],
  t: Tuning = TUNING,
): CollisionResult {
  let s = state;
  let cap = carCapsule(s, t);
  const recorded = new Map<string, { contact: Contact; depth: number }>();

  for (let pass = 0; pass < t.collision.iterations; pass++) {
    const found: { collider: Collider; pen: number }[] = [];
    for (const collider of colliders) {
      const o = overlapOf(cap, collider);
      if (o) found.push({ collider, pen: o.pen });
    }
    if (found.length === 0) break;
    found.sort((p, q) => q.pen - p.pen);

    for (const { collider } of found) {
      // Re-evaluate: pushes from deeper overlaps earlier in this pass may have resolved this one.
      const o = overlapOf(cap, collider);
      if (!o) continue;
      const r = respond(s, o, collider.id, t);
      s = r.state;
      cap = carCapsule(s, t);
      record(recorded, r.contact, o.pen);
    }
  }

  if (recorded.size === 0) return { state: { ...state }, contacts: [], heavyHit: null };

  const contacts = [...recorded.values()].sort((p, q) => q.depth - p.depth).map((e) => e.contact);
  let heavyHit: Contact | null = null;
  for (const c of contacts) {
    if (c.impactSpeed >= t.collision.heavyImpact && (!heavyHit || c.impactSpeed > heavyHit.impactSpeed)) heavyHit = c;
  }
  return { state: withDerived(s, t), contacts, heavyHit };
}

/** Overlap test between a capsule and a circle (used for pickups). Touching is not an overlap. */
export function capsuleOverlapsCircle(
  cap: { ax: number; az: number; bx: number; bz: number; r: number },
  x: number,
  z: number,
  r: number,
): boolean {
  const t = closestParamOnSegment(cap, x, z);
  const dx = cap.ax + (cap.bx - cap.ax) * t - x;
  const dz = cap.az + (cap.bz - cap.az) * t - z;
  return Math.hypot(dx, dz) < cap.r + r;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Separate the car along the normal, then reflect the approaching normal velocity. */
function respond(s: CarState, o: Overlap, colliderId: string, t: Tuning): { state: CarState; contact: Contact } {
  const x = s.x + o.nx * o.pen;
  const z = s.z + o.nz * o.pen;
  const vn = s.vx * o.nx + s.vz * o.nz;
  const impactSpeed = vn < 0 ? -vn : 0;
  const contact: Contact = { colliderId, impactSpeed, x: o.x, z: o.z, nx: o.nx, nz: o.nz };
  if (!(vn < 0)) return { state: { ...s, x, z }, contact };

  const heavy = impactSpeed >= t.collision.heavyImpact;
  const friction = heavy ? t.collision.hitFriction : t.collision.scrapeFriction;
  // Tangential part keeps `friction`; normal part flips to restitution * impact (v -= (1 + e) vn n).
  const vtx = s.vx - vn * o.nx;
  const vtz = s.vz - vn * o.nz;
  const vnOut = t.collision.restitution * impactSpeed;
  const vx = vtx * friction + o.nx * vnOut;
  const vz = vtz * friction + o.nz * vnOut;
  if (!heavy) return { state: { ...s, x, z, vx, vz }, contact };

  // Lever arm sign: torque of the push n applied at the contact point (+ = yaw left).
  const lever = (o.nx * (o.z - z) - o.nz * (o.x - x)) / (t.car.capsuleHalf + t.car.radius);
  const state: CarState = {
    ...s,
    x,
    z,
    vx,
    vz,
    yawRate: s.yawRate + t.collision.yawImpulse * impactSpeed * clamp(lever, -1, 1),
    mode: 'recover',
    modeTimer: t.drift.recoverTime,
    driftDir: 0,
    // Leaving a drift through a hit resets the same fields as a normal drift exit (car.ts
    // exitDrift): the drift clock restarts and lateral grip blends back in (no jolt).
    ...(s.mode === 'drift' ? { driftTime: 0, gripBlend: 0 } : {}),
  };
  return { state, contact };
}

/** Keep one contact per collider id: the one with the highest impact speed; track the max depth. */
function record(recorded: Map<string, { contact: Contact; depth: number }>, contact: Contact, pen: number): void {
  const prev = recorded.get(contact.colliderId);
  if (!prev) {
    recorded.set(contact.colliderId, { contact, depth: pen });
    return;
  }
  recorded.set(contact.colliderId, {
    contact: contact.impactSpeed > prev.contact.impactSpeed ? contact : prev.contact,
    depth: Math.max(prev.depth, pen),
  });
}

// ---------------------------------------------------------------------------
// Overlap tests (all NaN-safe: a non-finite comparison yields "no overlap")
// ---------------------------------------------------------------------------

function overlapOf(cap: Capsule, c: Collider): Overlap | null {
  switch (c.kind) {
    case 'circle':
      return overlapRounded(cap, { ax: c.x, az: c.z, bx: c.x, bz: c.z }, c.r);
    case 'capsule':
      return overlapRounded(cap, c, c.r);
    case 'wall':
      return overlapWall(cap, c);
  }
}

/** Car capsule vs a rounded segment (a circle is a zero-length segment). */
function overlapRounded(cap: Capsule, seg: Segment, r: number): Overlap | null {
  const [sc, so] = closestParamsSegSeg(cap, seg);
  const cx = cap.ax + (cap.bx - cap.ax) * sc;
  const cz = cap.az + (cap.bz - cap.az) * sc;
  const ox = seg.ax + (seg.bx - seg.ax) * so;
  const oz = seg.az + (seg.bz - seg.az) * so;
  const dist = Math.hypot(cx - ox, cz - oz);
  const pen = cap.r + r - dist;
  if (!(pen > EPS)) return null;
  const [nx, nz] = dist > EPS ? [(cx - ox) / dist, (cz - oz) / dist] : fallbackNormal(cap, seg, ox, oz);
  return { pen, nx, nz, x: ox + nx * r, z: oz + nz * r };
}

/**
 * Normal for segments that touch or cross (zero distance): perpendicular to the obstacle
 * segment (or to the car axis for a circle), oriented toward the car centre.
 */
function fallbackNormal(cap: Capsule, seg: Segment, ox: number, oz: number): [number, number] {
  let ux = seg.bx - seg.ax;
  let uz = seg.bz - seg.az;
  if (ux * ux + uz * uz <= EPS) {
    ux = cap.bx - cap.ax;
    uz = cap.bz - cap.az;
  }
  const len = Math.hypot(ux, uz);
  if (len <= EPS) return [1, 0];
  const nx = -uz / len;
  const nz = ux / len;
  const towardCar = ((cap.ax + cap.bx) / 2 - ox) * nx + ((cap.az + cap.bz) / 2 - oz) * nz;
  return towardCar < 0 ? [-nx, -nz] : [nx, nz];
}

/**
 * One-sided wall: penetration = r - (minimum signed distance of the capsule segment to the
 * wall line), counting only the part of the segment whose projection lies within the wall
 * extent widened by r. The push is always +n (toward the track), even from behind the wall.
 * The contact point is the deepest car-axis point projected onto the wall line.
 */
function overlapWall(cap: Capsule, w: WallCollider): Overlap | null {
  const wx = w.bx - w.ax;
  const wz = w.bz - w.az;
  const len2 = wx * wx + wz * wz;
  const nLen = Math.hypot(w.nx, w.nz);
  if (!(len2 > EPS) || !(nLen > EPS)) return null;
  const nx = w.nx / nLen;
  const nz = w.nz / nLen;

  // Projection parameter on the wall and signed distance are both linear along the car segment.
  const tA = ((cap.ax - w.ax) * wx + (cap.az - w.az) * wz) / len2;
  const tB = ((cap.bx - w.ax) * wx + (cap.bz - w.az) * wz) / len2;
  const dA = (cap.ax - w.ax) * nx + (cap.az - w.az) * nz;
  const dB = (cap.bx - w.ax) * nx + (cap.bz - w.az) * nz;
  const margin = cap.r / Math.sqrt(len2);
  const range = clipLinear(tA, tB, -margin, 1 + margin);
  if (!range) return null;

  // The minimum of a linear function sits at an end of the range. A car parallel to the wall
  // touches along its whole flat side: act at the car centre (no yaw kick).
  const [s0, s1] = range;
  const d0 = dA + (dB - dA) * s0;
  const d1 = dA + (dB - dA) * s1;
  const s = Math.abs(d0 - d1) <= EPS ? 0.5 : d0 < d1 ? s0 : s1;
  const pen = cap.r - Math.min(d0, d1);
  if (!(pen > EPS)) return null;
  // Contact: that car point projected onto the wall LINE, deliberately not clamped to the segment.
  // Within the widened extent it lies on the neighbouring segment of the barrier polyline, so every
  // collinear segment reports the same point and the yaw lever does not depend on collider order.
  const tw = tA + (tB - tA) * s;
  return { pen, nx, nz, x: w.ax + wx * tw, z: w.az + wz * tw };
}

/** Sub-range of s in [0, 1] where v(s) = v0 + (v1 - v0) s stays within [lo, hi], or null. */
function clipLinear(v0: number, v1: number, lo: number, hi: number): [number, number] | null {
  const dv = v1 - v0;
  if (Math.abs(dv) <= EPS) return v0 >= lo && v0 <= hi ? [0, 1] : null;
  const a = (lo - v0) / dv;
  const b = (hi - v0) / dv;
  const s0 = Math.max(0, Math.min(a, b));
  const s1 = Math.min(1, Math.max(a, b));
  return s0 <= s1 ? [s0, s1] : null;
}

// ---------------------------------------------------------------------------
// Closest points
// ---------------------------------------------------------------------------

/** Parameter in [0, 1] of the point on segment ab closest to (px, pz). */
function closestParamOnSegment(seg: Segment, px: number, pz: number): number {
  const dx = seg.bx - seg.ax;
  const dz = seg.bz - seg.az;
  const len2 = dx * dx + dz * dz;
  if (len2 <= EPS) return 0;
  return clamp(((px - seg.ax) * dx + (pz - seg.az) * dz) / len2, 0, 1);
}

/**
 * Parameters (s on p, t on q) of the closest points between two segments (Ericson,
 * Real-Time Collision Detection §5.1.9). Parallel segments use the middle of their overlap,
 * so a broadside contact has a centred contact point (no spurious yaw kick).
 */
function closestParamsSegSeg(p: Segment, q: Segment): [number, number] {
  const d1x = p.bx - p.ax;
  const d1z = p.bz - p.az;
  const d2x = q.bx - q.ax;
  const d2z = q.bz - q.az;
  const rx = p.ax - q.ax;
  const rz = p.az - q.az;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  if (a <= EPS && e <= EPS) return [0, 0];
  if (a <= EPS) return [0, clamp(f / e, 0, 1)];
  const c = d1x * rx + d1z * rz;
  if (e <= EPS) return [clamp(-c / a, 0, 1), 0];

  const b = d1x * d2x + d1z * d2z;
  const denom = a * e - b * b;
  let s0: number;
  if (denom > EPS * a * e) {
    s0 = clamp((b * f - c * e) / denom, 0, 1);
  } else {
    // Parallel: q's endpoints project onto p at -c/a and (b - c)/a; take the middle of the overlap.
    const lo = clamp(Math.min(-c / a, (b - c) / a), 0, 1);
    const hi = clamp(Math.max(-c / a, (b - c) / a), 0, 1);
    s0 = (lo + hi) / 2;
  }
  const t = (b * s0 + f) / e;
  if (t < 0) return [clamp(-c / a, 0, 1), 0];
  if (t > 1) return [clamp((b - c) / a, 0, 1), 1];
  return [s0, t];
}
