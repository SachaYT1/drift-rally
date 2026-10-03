/**
 * Wall slide (player test-drive after scheme A: scrapes applied no torque, so W with the nose into a barrier
 * ground the car along it at 0-5 m/s, and a head-on pin needed reverse-and-W or R). Called by
 * resolveCollisions (collision.ts) after the push-out on a step without a heavy hit. Pure.
 */
import type { CarState, Collider, Contact } from '../shared/types';
import type { Tuning } from '../shared/tuning';
import { clamp, wrapAngle } from '../shared/math';
import { carCapsule } from './car';
import { EPS, closestParamOnSegment } from './collisionGeometry';

type WallCollider = Extract<Collider, { kind: 'wall' }>;

/** One contact of the step with the collider it came from. */
export interface SlideHit {
  contact: Contact;
  collider: Collider;
}

/**
 * |cos| between a non-barrier surface tangent and the track direction (from the nearest barrier segment)
 * below which the track direction cannot tell the two slide directions apart (surface ~square to it).
 */
const SLIDE_TRACK_MIN = 0.2;
/** |smoothed steer| from which the player's steer picks the slide side where nothing else does. */
const SLIDE_STEER_MIN = 0.3;

/**
 * The step's contacts (`hits`, deepest first, no heavy hit among them): the deepest contact the nose points
 * into turns the nose toward that surface's tangent (slideTangent), at collision.slideAlignGain per radian of
 * error within [slideAlignMinRate, slideAlignMaxRate], scaled by slideDriftScale in drift mode, and never past
 * the tangent. Tail and flank contacts (nose not into the obstacle) never turn the car, so it is never steered
 * toward what it touches. A kinematic correction like the push-out: yawRate and velocity are left to the car
 * model (grip turns the velocity after the nose). Returns `s` itself when nothing turns.
 */
export function wallSlide(
  s: CarState,
  hits: readonly SlideHit[],
  colliders: readonly Collider[],
  t: Tuning,
  dt: number,
): CarState {
  const c = t.collision;
  const scale = s.mode === 'drift' ? c.slideDriftScale : 1;
  const maxTurn = c.slideAlignMaxRate * scale * dt;
  const minTurn = Math.min(Math.max(0, c.slideAlignMinRate * scale * dt), maxTurn);
  const gain = c.slideAlignGain * scale * dt;
  if (!(maxTurn > 0) || !(gain > 0)) return s;

  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  // Nose-into contacts, deepest first; a barrier among them decides (it knows the track direction), so a car
  // wedged between a barrier and an obstacle is not turned two ways on alternate steps.
  const into = hits.filter((e) => fx * e.contact.nx + fz * e.contact.nz < -EPS);
  const hit = into.find((e) => e.collider.kind === 'wall') ?? into[0];
  if (!hit) return s;

  const [tx, tz] = slideTangent(s, hit, colliders, t);
  const error = wrapAngle(Math.atan2(tx, tz) - s.heading);
  // Proportional, within [minTurn, maxTurn] per step, never past the tangent.
  const turn = Math.sign(error) * Math.min(Math.abs(error), clamp(Math.abs(error) * gain, minTurn, maxTurn));
  if (turn === 0 || !Number.isFinite(turn)) return s;

  // Pivot about the car-axis point nearest the contact (the nose, for a nose-in): it stays on the surface while
  // the body swings in. Turning about the centre would lift the nose off, and with no contact on the next
  // steps there would be nothing to slide on until W closed the gap again.
  const u = closestParamOnSegment(carCapsule(s, t), hit.contact.x, hit.contact.z);
  const k = t.car.capsuleHalf * (1 - 2 * u);
  const heading = s.heading + turn;
  return {
    ...s,
    heading,
    x: s.x + k * (fx - Math.sin(heading)),
    z: s.z + k * (fz - Math.cos(heading)),
  };
}

/**
 * Unit tangent of the contact surface in the direction the car should slide along it:
 * 1. the direction of travel along the surface, when that is at least collision.slideTravelSpeed;
 * 2. else the track frame of the nearest barrier (trackFrame): its driving direction, so a slow or pinned car
 *    is turned back onto the course, never into the wrong way (on a barrier this always decides); for an
 *    obstacle square to the track, its inward normal, so the car slides toward the road, not into a pocket
 *    between the obstacle and the barrier;
 * 3. else (an obstacle with no barrier in the query) the side the player steers to;
 * 4. else the side the nose already points to;
 * 5. else (dead head-on) away from the side of the car the contact point is on (left on a tie).
 * The tangent is perpendicular to the contact normal, which the nose points into, so the shortest turn to it
 * swings the nose through the head-on direction, never away from the obstacle.
 */
function slideTangent(s: CarState, hit: SlideHit, colliders: readonly Collider[], t: Tuning): [number, number] {
  const { nx, nz } = hit.contact;
  // The + tangent is (nz, -nx); `along(x, z)` is a vector's component along it.
  const along = (x: number, z: number): number => x * nz - z * nx;
  const pick = (sign: number): [number, number] => (sign < 0 ? [-nz, nx] : [nz, -nx]);
  const travel = along(s.vx, s.vz);
  if (Math.abs(travel) >= t.collision.slideTravelSpeed) return pick(travel);

  const frame = trackFrame(hit.collider, colliders, s);
  if (frame) {
    const forward = along(frame.dx, frame.dz);
    if (hit.collider.kind === 'wall' || Math.abs(forward) > SLIDE_TRACK_MIN) return pick(forward);
    return pick(along(frame.nx, frame.nz));
  }

  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  // left = (fz, -fx): tangentLeft > 0 when the + tangent lies to the car's left.
  const tangentLeft = along(fz, -fx);
  if (Math.abs(s.steer) >= SLIDE_STEER_MIN) return pick(Math.sign(s.steer) * tangentLeft);
  const noseAlong = along(fx, fz);
  if (Math.abs(noseAlong) > EPS) return pick(noseAlong);

  // A contact on the left turns the nose right, and vice versa.
  const contactLeft = (hit.contact.x - s.x) * fz - (hit.contact.z - s.z) * fx;
  return pick(contactLeft > 0 ? -tangentLeft : tangentLeft);
}

/**
 * Track frame near the contact: the driving direction (dx, dz) and the inward normal (nx, nz) of a barrier,
 * or null. Barrier walls run in the driving direction (a -> b; track/build.ts emits both sides in lap order,
 * pinned by collision.wallSlide.test.ts): a wall gives its own frame; any other obstacle takes the frame of
 * the nearest wall among `colliders` (the broad-phase query around the car).
 */
function trackFrame(
  collider: Collider,
  colliders: readonly Collider[],
  s: CarState,
): { dx: number; dz: number; nx: number; nz: number } | null {
  let wall: WallCollider | null = collider.kind === 'wall' ? collider : null;
  if (!wall) {
    let best = Infinity;
    for (const c of colliders) {
      if (c.kind !== 'wall') continue;
      const u = closestParamOnSegment(c, s.x, s.z);
      const d = Math.hypot(c.ax + (c.bx - c.ax) * u - s.x, c.az + (c.bz - c.az) * u - s.z);
      if (d < best) {
        best = d;
        wall = c;
      }
    }
  }
  if (!wall) return null;
  const len = Math.hypot(wall.bx - wall.ax, wall.bz - wall.az);
  const nLen = Math.hypot(wall.nx, wall.nz);
  if (!(len > EPS) || !(nLen > EPS)) return null;
  return { dx: (wall.bx - wall.ax) / len, dz: (wall.bz - wall.az) / len, nx: wall.nx / nLen, nz: wall.nz / nLen };
}
