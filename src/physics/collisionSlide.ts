/**
 * Wall slide (player test-drive after scheme A: scrapes applied no torque, so W with the nose into a barrier
 * ground the car along it at 0-5 m/s, and a head-on pin needed reverse-and-W or R). Called by
 * resolveCollisions (collision.ts) after the push-out on a step without a heavy hit. Pure.
 */
import type { CarState, Collider, Contact } from '../shared/types';
import type { Tuning } from '../shared/tuning';
import { clamp } from '../shared/math';
import { carCapsule } from './car';
import { EPS, closestParamOnSegment } from './collisionGeometry';

type WallCollider = Extract<Collider, { kind: 'wall' }>;

/** One contact of the step with the collider it came from. */
export interface SlideHit {
  contact: Contact;
  collider: Collider;
}

/**
 * Where the slide turns the nose: the unit surface tangent (tx, tz) on the side the car should slide to, and
 * the nose angle to reach, measured from head-on (-contact normal) toward that tangent, in (0, pi/2].
 */
interface Aim {
  tx: number;
  tz: number;
  angle: number;
}

/** |smoothed steer| from which the player's steer picks the slide side where nothing else does. */
const SLIDE_STEER_MIN = 0.3;
/**
 * |sin| of the track direction's angle from head-on below which an obstacle counts as dead square to the track
 * (~5 deg): the slide then deflects toward the road. Any wider angle picks the side the track direction is on,
 * which keeps the aim at least slideObstacleAngle past head-on (the other side could aim right at head-on).
 */
const SLIDE_SQUARE_SIN = 0.09;

/**
 * The step's contacts (`hits`, deepest first, no heavy hit among them): the deepest contact the nose points
 * into turns the nose away from head-on toward the aim of slideAim, at collision.slideAlignGain per radian of
 * error within [slideAlignMinRate, slideAlignMaxRate], scaled by slideDriftScale in drift mode, and never past
 * the aim. The nose only ever turns further from head-on (never back into the obstacle). Where the aim stops
 * short of parallel to the surface (a heavy obstacle), the car is also carried along the surface toward the
 * aim side (collision.slideObstacleSpeed). Tail and flank contacts (nose not into the obstacle) never turn or
 * carry the car. A kinematic correction like the push-out: yawRate and velocity are left to the car model
 * (grip turns the velocity after the nose). Returns `s` itself when nothing moves.
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

  const { nx, nz } = hit.contact;
  const aim = slideAim(s, hit, colliders, t);
  // Nose angle from head-on toward the aim tangent; the turn toward the tangent is + heading when the tangent
  // lies to the left of head-on (left of (x, z) is (z, -x)).
  const headOn = -(fx * nx + fz * nz);
  const nose = Math.atan2(fx * aim.tx + fz * aim.tz, headOn);
  const error = aim.angle - nose;
  const rawTurn =
    error > EPS ? Math.sign(aim.tz * nx - aim.tx * nz) * Math.min(error, clamp(error * gain, minTurn, maxTurn)) : 0;
  const turn = Number.isFinite(rawTurn) ? rawTurn : 0;
  // Short of parallel (a heavy obstacle's bounded aim), a nose pressed in would only crawl (the tyres' grip
  // fights the sideways slip): carry the car along the surface toward the aim side, topping its own speed along
  // it up to slideObstacleSpeed; full while the nose is within 60 deg of head-on, fading out at parallel.
  const bounded = hit.collider.kind !== 'wall' && aim.angle < Math.PI / 2;
  const top = bounded ? Math.max(0, c.slideObstacleSpeed * scale) : 0;
  const rawShift = clamp(top - (s.vx * aim.tx + s.vz * aim.tz), 0, top) * clamp(2 * headOn, 0, 1) * dt;
  const shift = Number.isFinite(rawShift) ? rawShift : 0;
  if (turn === 0 && !(shift > 0)) return s;

  // Pivot about the car-axis point nearest the contact (the nose, for a nose-in): it stays on the surface while
  // the body swings in. Turning about the centre would lift the nose off, and with no contact on the next
  // steps there would be nothing to slide on until W closed the gap again.
  const u = closestParamOnSegment(carCapsule(s, t), hit.contact.x, hit.contact.z);
  const k = t.car.capsuleHalf * (1 - 2 * u);
  const heading = s.heading + turn;
  return {
    ...s,
    heading,
    x: s.x + k * (fx - Math.sin(heading)) + aim.tx * shift,
    z: s.z + k * (fz - Math.cos(heading)) + aim.tz * shift,
  };
}

/**
 * Slide aim for the contact `hit` (see Aim). At a barrier the nose turns parallel to it (angle pi/2), along:
 * 1. the direction of travel along the barrier, when that is at least collision.slideTravelSpeed;
 * 2. else the barrier's driving direction (trackFrame), so a slow or pinned car is turned back onto the course,
 *    never into the wrong way;
 * 3. else (no frame) the player's steer, the side the nose already points to, away from the contact side.
 * At a heavy obstacle the obstacle's own surface says nothing about the course (a bench leg's or the sneaker
 * cap's tangent is up to 90 deg off it), so the nose only deflects collision.slideObstacleAngle (beta) and
 * wallSlide carries the car around the obstacle instead:
 * - with a barrier among `colliders` (the broad-phase query around the car) and the track direction ahead of
 *   head-on: to beta past the track direction, toward the side the player steers to, else the side the track
 *   direction lies on (toward the road when the obstacle sits dead square to it: the barrier's inward normal).
 *   Sliding that way keeps the track direction on that side, and the car leaves the obstacle along the track;
 * - with the track direction behind head-on (the car faces back into the obstacle): parallel to the surface,
 *   toward the side the track direction lies on (else toward the road), so the nose comes round toward the
 *   course; wallSlide does not carry the car here (sliding around the obstacle would swing the track
 *   direction to the other side and flip the choice);
 * - with no barrier in reach: to beta past head-on, toward the side picked by travel along the surface
 *   (>= slideTravelSpeed), the steer, the side the nose points to, and away from the contact side.
 * The aim angle is measured from head-on, so the turn swings the nose away from the obstacle (through head-on
 * at most), never into it.
 */
function slideAim(s: CarState, hit: SlideHit, colliders: readonly Collider[], t: Tuning): Aim {
  const { nx, nz } = hit.contact;
  // The + tangent is (nz, -nx); `along(x, z)` is a vector's component along it, `ahead(x, z)` along head-on.
  const along = (x: number, z: number): number => x * nz - z * nx;
  const ahead = (x: number, z: number): number => -(x * nx + z * nz);
  const aimAt = (sign: number, angle: number): Aim =>
    sign < 0 ? { tx: -nz, tz: nx, angle } : { tx: nz, tz: -nx, angle };
  const c = t.collision;
  const travel = along(s.vx, s.vz);
  const frame = trackFrame(hit.collider, colliders, s);

  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  // left = (fz, -fx): tangentLeft > 0 when the + tangent lies to the car's left.
  const tangentLeft = along(fz, -fx);
  const steer = Math.abs(s.steer) >= SLIDE_STEER_MIN ? Math.sign(s.steer) * tangentLeft : 0;
  const noseAlong = along(fx, fz);
  const nose = Math.abs(noseAlong) > EPS ? noseAlong : 0;
  // A contact on the left turns the nose right, and vice versa.
  const contactLeft = (hit.contact.x - s.x) * fz - (hit.contact.z - s.z) * fx;
  const away = contactLeft > 0 ? -tangentLeft : tangentLeft;
  const travelSide = Math.abs(travel) >= c.slideTravelSpeed ? travel : 0;

  if (hit.collider.kind === 'wall') {
    const forward = frame ? along(frame.dx, frame.dz) : 0;
    return aimAt(travelSide || forward || steer || nose || away, Math.PI / 2);
  }
  const beta = clamp(c.slideObstacleAngle, 0, Math.PI / 2);
  if (!frame) return aimAt(travelSide || steer || nose || away, beta);

  const forward = along(frame.dx, frame.dz);
  const inward = along(frame.nx, frame.nz);
  const trackAhead = ahead(frame.dx, frame.dz);
  const trackSide = (Math.abs(forward) > SLIDE_SQUARE_SIN ? forward : inward) || away;
  if (trackAhead < 0) return aimAt(trackSide, Math.PI / 2);
  const side = steer || trackSide;
  // The track direction's angle from head-on toward the chosen side (negative when it lies on the other one).
  const track = Math.atan2(Math.sign(side) * forward, trackAhead);
  return aimAt(side, clamp(track + beta, 0, Math.PI / 2));
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
