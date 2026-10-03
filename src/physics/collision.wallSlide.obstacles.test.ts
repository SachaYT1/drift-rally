/**
 * Wall slide at small heavy obstacles (play-test 2): turning the nose to the obstacle's own surface tangent
 * sent a W-only car off a bench leg or the sneaker's cap 24-85 deg off the track, across the road and into a
 * second heavy hit on a barrier. At an obstacle the nose may only deflect a bounded angle toward the free
 * side (from the track direction where a barrier gives it, else from head-on), and the car is carried along
 * the obstacle's surface toward that side (a nose pressed in at that angle would only crawl), so it slides
 * around the obstacle and leaves it along the track.
 *
 * W only, no steer: the Plaza's curves still bring the car to a barrier 2-4 s later even when it leaves along
 * the track (a W-only car started along the track there, without obstacles, touches one after 1.9-3.9 s), so
 * the checks are the exit heading and no heavy hit soon after coming free, not "no barrier ever".
 */
import { describe, expect, it } from 'vitest';
import { createCarState, stepCar, withDerived } from './car';
import { resolveCollisions } from './collision';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING, type Tuning } from '../shared/tuning';
import { DEG, seededRandom, wrapAngle } from '../shared/math';
import { NEUTRAL_INPUT, type CarState, type Collider, type InputFrame } from '../shared/types';

const DT = 1 / TUNING.race.physicsHz;
const W: InputFrame = { ...NEUTRAL_INPUT, throttle: 1 };
const track = buildTrack(PLAZA);
/** The session's broad-phase reach around the car (capsule + radius + 4 m margin). */
const REACH = TUNING.car.capsuleHalf + TUNING.car.radius + 4;

const trackHeading = (s: number): number => {
  const q = track.sampleAt(s);
  return Math.atan2(q.tx, q.tz);
};

/** Car on the track at (s, lateral), heading along the track, `v` m/s forward. */
function along(s: number, lateral: number, v: number): CarState {
  const p = track.poseAt(s, lateral);
  const h = p.heading;
  return withDerived({ ...createCarState(p.x, p.z, h), vx: v * Math.sin(h), vz: v * Math.cos(h) });
}

interface Exit {
  /** First contact with the obstacle, s from the start (Infinity: never touched). */
  contactAt: number;
  /** Seconds from the first to the last obstacle contact once free (Infinity: never free). */
  freed: number;
  /** Heading off the track direction at the last contact, deg, once free (NaN: never free). */
  exitDeg: number;
  /** Seconds from coming free to the first heavy hit on another collider (Infinity: none in the run). */
  secondHeavyAfterFree: number;
  /** Longest run moving back along the track faster than progress.wrongWaySpeed, s. */
  backward: number;
}

/**
 * W only for 4 s on the Plaza, colliders from the broad phase. Free = no contact with obstacle `id` for 0.25 s,
 * at >= 5 m/s, moving forward along the track faster than 2 m/s.
 */
function exitFrom(start: CarState, id: string): Exit {
  let s = start;
  let hint = track.project(s.x, s.z).s;
  let contactAt = Infinity;
  let lastContact = -Infinity;
  let lastS = hint;
  let free = Infinity;
  let exitDeg = NaN;
  let secondAt = Infinity;
  let backward = 0;
  let run = 0;
  for (let i = 1; i <= Math.round(4 / DT); i++) {
    const time = i * DT;
    s = stepCar(s, W, track.surfaceAt(track.project(s.x, s.z, hint).lateral), DT);
    const r = resolveCollisions(s, track.collidersNear(s.x, s.z, REACH));
    s = r.state;
    const p = track.project(s.x, s.z, hint);
    hint = p.s;
    if (r.contacts.some((c) => c.colliderId.startsWith(id))) {
      contactAt = Math.min(contactAt, time);
      lastContact = time;
      lastS = p.s;
    }
    const other = r.heavyHit && !r.heavyHit.colliderId.startsWith(id);
    if (other && contactAt < Infinity) secondAt = Math.min(secondAt, time);
    const tan = track.sampleAt(p.s);
    const ds = s.vx * tan.tx + s.vz * tan.tz;
    run = ds < TUNING.progress.wrongWaySpeed ? run + DT : 0;
    backward = Math.max(backward, run);
    if (contactAt < Infinity && free === Infinity && time - lastContact >= 0.25 && s.speed >= 5 && ds > 2) {
      free = lastContact;
      exitDeg = wrapAngle(s.heading - trackHeading(lastS)) / DEG;
    }
  }
  return {
    contactAt,
    freed: free - contactAt,
    exitDeg,
    secondHeavyAfterFree: secondAt - free,
    backward,
  };
}

/**
 * Bench legs (circles r 0.45 at s ~776.5, lateral +/-5.5), the sneaker's upstream cap (capsule r 1, s ~1643,
 * lateral -5.5), the bicycle tyre's road-side end.
 */
const CASES: { label: string; id: string; s: number; lateral: number }[] = [
  ...[-0.6, -0.3, 0, 0.3, 0.6].flatMap((d) => [
    { label: `bench right leg, lateral ${(-5.5 + d).toFixed(1)}`, id: 'bench', s: 770, lateral: -5.5 + d },
    { label: `bench left leg, lateral ${(5.5 + d).toFixed(1)}`, id: 'bench', s: 770, lateral: 5.5 + d },
    { label: `sneaker cap, lateral ${(-5.5 + d).toFixed(1)}`, id: 'sneaker', s: 1636, lateral: -5.5 + d },
  ]),
  ...[0, 0.4, 0.8].map((d) => {
    const lateral = -5.6 + d;
    return { label: `bicycle tyre end, lateral ${lateral.toFixed(1)}`, id: 'bicycle', s: 560, lateral };
  }),
];

describe('wall slide at small heavy obstacles (Plaza), W only', () => {
  it('comes free within 1.5 s, heading within 30 deg of the track, with no heavy hit within 1.5 s after', () => {
    // Before: exits up to 76 deg off the track, and 15 of these runs took a heavy barrier hit < 1.5 s after
    // coming free. Without any slide: 9 never came free in 4 s and 19 took longer than 1.5 s. A glancing
    // first touch that is a heavy hit leaves no scrape to slide on: its yaw kick alone exits up to ~29 deg off.
    let touched = 0;
    for (const k of CASES) {
      for (const v of [2, 5, 8, 12]) {
        const e = exitFrom(along(k.s, k.lateral, v), k.id);
        if (e.contactAt === Infinity) continue;
        touched++;
        const label = `${k.label}, ${v} m/s`;
        expect(e.freed, label).toBeLessThanOrEqual(1.5);
        expect(Math.abs(e.exitDeg), label).toBeLessThanOrEqual(30);
        expect(e.secondHeavyAfterFree, label).toBeGreaterThanOrEqual(1.5);
        expect(e.backward, label).toBeLessThan(0.25 * TUNING.progress.wrongWayTime);
      }
    }
    expect(touched).toBeGreaterThanOrEqual(50);
  });

  it('a dead head-on pin on the sneaker cap (old physics: stuck) comes free toward the track direction', () => {
    for (const v of [0.5, 2, 5]) {
      const e = exitFrom(along(1638, -5.5, v), 'sneaker');
      expect(e.contactAt, `${v} m/s`).toBeLessThan(1.5);
      expect(e.freed, `${v} m/s`).toBeLessThanOrEqual(1.5);
      expect(Math.abs(e.exitDeg), `${v} m/s`).toBeLessThanOrEqual(25);
    }
  });

  it('with no barrier in reach, a car pinned on a post slides round it in 1.5 s, nose turned a bounded angle', () => {
    // A lone post far from any barrier, the car pressed against it or 0.5 m short of it, W only. The nose turns
    // at most collision.slideObstacleAngle; the car is clear of the post (its tail past it) <= 1.5 s after the
    // first contact. Without the slide a dead head-on car stays pinned; with the deflection alone it crawls
    // around the post for 2.3-2.7 s.
    const post: Collider = { kind: 'circle', id: 'post', x: 0, z: 10, r: 0.45 };
    const reach = 0.45 + TUNING.car.radius + TUNING.car.capsuleHalf;
    for (const [v, gap] of [
      [0, -0.01],
      [1, 0.5],
      [3, 0.5],
    ]) {
      for (const dx of [0, 0.15, -0.3]) {
        let s = withDerived({ ...createCarState(dx, 10 - reach - gap, 0), vz: v });
        let maxTurn = 0;
        let contactAt = Infinity;
        let passedAt = Infinity;
        for (let i = 1; i <= Math.round(4 / DT) && passedAt === Infinity; i++) {
          s = stepCar(s, W, 'road', DT);
          const r = resolveCollisions(s, [post]);
          s = r.state;
          if (r.contacts.length > 0) contactAt = Math.min(contactAt, i * DT);
          maxTurn = Math.max(maxTurn, Math.abs(wrapAngle(s.heading)));
          if (s.z > 10 + reach) passedAt = i * DT;
        }
        const label = `${v} m/s, offset ${dx}`;
        expect(passedAt - contactAt, label).toBeLessThanOrEqual(1.5);
        expect(maxTurn, label).toBeLessThanOrEqual(TUNING.collision.slideObstacleAngle + 1e-9);
      }
    }
  });
});

describe('wall slide at small heavy obstacles: the carry along the surface', () => {
  const c = TUNING.collision;
  const withCollision = (patch: Partial<Tuning['collision']>): Tuning => ({
    ...TUNING,
    collision: { ...c, ...patch },
  });
  const post: Collider = { kind: 'circle', id: 'post', x: 0, z: 0, r: 0.45 };
  const wall: Collider = { kind: 'wall', id: 'wall', ax: -500, az: 0, bx: 500, bz: 0, nx: 0, nz: -1 };
  const { capsuleHalf, radius } = TUNING.car;
  /** Car heading `yaw` off +z at `v` m/s, its front end `pen` m into the post (axis `offset` m to its side). */
  function pressed(yaw: number, offset: number, pen: number, v: number, mode: CarState['mode'] = 'grip'): CarState {
    const reach = capsuleHalf + radius + 0.45 - pen;
    const x = offset - Math.sin(yaw) * reach;
    const z = -Math.cos(yaw) * reach;
    return withDerived({ ...createCarState(x, z, yaw), vx: v * Math.sin(yaw), vz: v * Math.cos(yaw), mode });
  }
  /** The same car `pen` m into the wall z = 0 (seen from z < 0). */
  function intoWall(yaw: number, pen: number, v: number): CarState {
    const z = -(capsuleHalf * Math.cos(yaw) + radius) + pen;
    return withDerived({ ...createCarState(0, z, yaw), vx: v * Math.sin(yaw), vz: v * Math.cos(yaw) });
  }

  it('moves the car <= slideObstacleSpeed * dt per step past the deflection alone (drift: x slideDriftScale)', () => {
    const rand = seededRandom(7);
    let carried = 0;
    for (let i = 0; i < 400; i++) {
      const mode = rand() < 0.3 ? 'drift' : 'grip';
      const s = pressed((rand() - 0.5) * 60 * DEG, (rand() - 0.5) * 0.8, rand() * 0.08, rand() * 5, mode);
      const a = resolveCollisions(s, [post]);
      const b = resolveCollisions(s, [post], withCollision({ slideObstacleSpeed: 0 }));
      if (a.heavyHit) continue;
      expect(a.state.heading).toBe(b.state.heading);
      const d = Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z);
      const scale = mode === 'drift' ? c.slideDriftScale : 1;
      expect(d).toBeLessThanOrEqual(c.slideObstacleSpeed * scale * DT + 1e-9);
      if (d > 1e-9) carried++;
    }
    expect(carried).toBeGreaterThan(100);
  });

  it('never carries a car along a barrier (the nose turns parallel to it instead)', () => {
    const rand = seededRandom(5);
    let turned = 0;
    for (let i = 0; i < 200; i++) {
      const s = intoWall((rand() - 0.5) * 120 * DEG, 0.01 + rand() * 0.08, rand() * 5);
      const r = resolveCollisions(s, [wall]);
      expect(r.contacts).toHaveLength(1);
      expect(r).toEqual(resolveCollisions(s, [wall], withCollision({ slideObstacleSpeed: 0 })));
      if (r.state.heading !== s.heading) turned++;
    }
    expect(turned).toBeGreaterThan(100);
  });
});
