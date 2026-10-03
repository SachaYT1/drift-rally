import { describe, expect, it } from 'vitest';
import { capsuleOverlapsCircle, resolveCollisions } from './collision';
import { carCapsule, createCarState } from './car';
import { TUNING } from '../shared/tuning';
import { DEG, TAU, seededRandom } from '../shared/math';
import type { CarState, Collider } from '../shared/types';

function car(x: number, z: number, heading: number, vx = 0, vz = 0): CarState {
  const c = createCarState(x, z, heading);
  const speed = Math.hypot(vx, vz);
  return { ...c, vx, vz, speed, forwardSpeed: vx * Math.sin(heading) + vz * Math.cos(heading) };
}
const circle = (x: number, z: number, r: number, id = 'c'): Collider => ({ kind: 'circle', id, x, z, r });
const wallX = (z: number): Collider => ({ kind: 'wall', id: 'w', ax: -50, az: z, bx: 50, bz: z, nx: 0, nz: 1 });

function segPointDist(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

describe('collision', () => {
  it('pushes the car out of a circle along the contact normal', () => {
    const r = resolveCollisions(car(0, 0, 0), [circle(1.5, 0, 1)]);
    const cap = carCapsule(r.state);
    expect(segPointDist(cap.ax, cap.az, cap.bx, cap.bz, 1.5, 0)).toBeGreaterThanOrEqual(1 + TUNING.car.radius - 1e-6);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].nx).toBeLessThan(0);
  });

  it('reflects approaching velocity with restitution and flags a heavy hit', () => {
    const r = resolveCollisions(car(0, 0, 0, 10, 0), [circle(1.5, 0, 1)]);
    expect(r.state.vx).toBeLessThan(0);
    expect(r.state.vx).toBeGreaterThanOrEqual(-TUNING.collision.restitution * 10 - 1e-6);
    expect(r.heavyHit).not.toBeNull();
    expect(r.heavyHit!.impactSpeed).toBeCloseTo(10, 5);
    expect(r.state.mode).toBe('recover');
  });

  it('does not reflect a car already moving away', () => {
    const r = resolveCollisions(car(0, 0, 0, -5, 0), [circle(1.5, 0, 1)]);
    expect(r.state.vx).toBeCloseTo(-5, 6);
    expect(r.heavyHit).toBeNull();
  });

  it('a slow contact is a scrape: no heavy hit, tangential speed mostly kept', () => {
    const r = resolveCollisions(car(0, 0, Math.PI / 2, 3, 20), [circle(1.5, 0, 1)]);
    expect(r.heavyHit).toBeNull();
    expect(r.contacts[0].impactSpeed).toBeLessThan(TUNING.collision.heavyImpact);
    expect(r.state.vz).toBeGreaterThan(20 * 0.97);
  });

  it('one-sided wall pushes toward the track even from behind', () => {
    const inFront = resolveCollisions(car(0, 0.5, Math.PI / 2), [wallX(0)]);
    expect(inFront.state.z).toBeGreaterThanOrEqual(TUNING.car.radius - 1e-6);
    const behind = resolveCollisions(car(0, -0.5, Math.PI / 2), [wallX(0)]);
    expect(behind.state.z).toBeGreaterThanOrEqual(TUNING.car.radius - 1e-6);
  });

  it('collides with capsule colliders', () => {
    const cap: Collider = { kind: 'capsule', id: 'k', ax: 1.2, az: -3, bx: 1.2, bz: 3, r: 0.5 };
    const r = resolveCollisions(car(0, 0, 0), [cap]);
    expect(r.state.x).toBeLessThanOrEqual(1.2 - 0.5 - TUNING.car.radius + 1e-6);
  });

  it('front-right hit yaws the car left (positive yaw rate)', () => {
    // circle overlaps the front-right corner (right of heading 0 is -x)
    const r = resolveCollisions(car(0, 0, 0, 0, 12), [circle(-1.0, 1.9, 0.5)]);
    expect(r.heavyHit).not.toBeNull();
    expect(r.state.yawRate).toBeGreaterThan(0);
  });

  it('reports at most one contact per collider, deepest first', () => {
    const r = resolveCollisions(car(0, 0, 0), [circle(1.6, 0, 1, 'a'), circle(-1.2, 0, 1, 'b'), circle(1.6, 0.2, 1, 'a')]);
    const ids = r.contacts.map((c) => c.colliderId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('capsuleOverlapsCircle', () => {
    const cap = carCapsule(createCarState(0, 0, 0));
    expect(capsuleOverlapsCircle(cap, 0, 2.3, 0.5)).toBe(true);
    expect(capsuleOverlapsCircle(cap, 3, 0, 0.5)).toBe(false);
  });
});

describe('collision edge cases', () => {
  const post = (x: number, z: number, r: number): Collider => circle(x, z, r, 'post');

  it('leaves a free car untouched and never mutates its inputs', () => {
    const c = Object.freeze(car(0, 0, 0, 5, 5));
    const before = { ...c };
    const free = resolveCollisions(c, Object.freeze([Object.freeze(circle(5, 0, 1)), Object.freeze(wallX(-5))]));
    expect(free.contacts).toEqual([]);
    expect(free.heavyHit).toBeNull();
    expect(free.state).toEqual(before);
    expect(free.state).not.toBe(c);

    const moving = Object.freeze(car(0, 0, 0, 10, 0));
    const movingBefore = { ...moving };
    const hit = resolveCollisions(moving, Object.freeze([Object.freeze(circle(1.5, 0, 1))]));
    expect(hit.contacts).toHaveLength(1);
    expect(moving).toEqual(movingBefore);
  });

  it('recomputes derived fields after the response', () => {
    const { state: s } = resolveCollisions(car(0, 0, 0, 10, 0), [circle(1.5, 0, 1)]);
    expect(s.speed).toBeCloseTo(Math.hypot(s.vx, s.vz), 9);
    expect(s.forwardSpeed).toBeCloseTo(s.vz, 9);
    expect(s.lateralSpeed).toBeCloseTo(s.vx, 9);
    expect(s.slip).toBeCloseTo(Math.PI / 2, 9);
  });

  it('a heavy hit ends a drift like a normal drift exit: recovery timer, grip blends back in', () => {
    const drifting: CarState = { ...car(0, 0, 0, 10, 0), mode: 'drift', driftDir: 1, driftTime: 1.2, gripBlend: 1 };
    const r = resolveCollisions(drifting, [circle(1.5, 0, 1)]);
    expect(r.state.mode).toBe('recover');
    expect(r.state.modeTimer).toBe(TUNING.drift.recoverTime);
    expect(r.state.driftDir).toBe(0);
    expect(r.state.driftTime).toBe(0);
    expect(r.state.gripBlend).toBe(0);
  });

  it('a heavy hit in grip mode leaves the grip blend alone', () => {
    const blending: CarState = { ...car(0, 0, 0, 10, 0), gripBlend: 0.5 };
    const r = resolveCollisions(blending, [circle(1.5, 0, 1)]);
    expect(r.state.mode).toBe('recover');
    expect(r.state.gripBlend).toBe(0.5);
  });

  it('a scrape keeps the drift going', () => {
    const drifting: CarState = { ...car(0, 0, Math.PI / 2, 3, 20), mode: 'drift', driftDir: 1 };
    const r = resolveCollisions(drifting, [circle(1.5, 0, 1)]);
    expect(r.contacts).toHaveLength(1);
    expect(r.state.mode).toBe('drift');
    expect(r.state.driftDir).toBe(1);
  });

  it('a broadside hit on a wall or a parallel capsule gives no yaw kick', () => {
    const side = car(0, 0.9, Math.PI / 2, 0, -10);
    const wall = resolveCollisions(side, [wallX(0)]);
    expect(wall.heavyHit).not.toBeNull();
    expect(wall.state.yawRate).toBeCloseTo(0, 9);
    const bar: Collider = { kind: 'capsule', id: 'bar', ax: -3, az: -0.4, bx: 3, bz: -0.4, r: 0.3 };
    const capsule = resolveCollisions({ ...side, z: 0.8 }, [bar]);
    expect(capsule.heavyHit).not.toBeNull();
    expect(capsule.state.yawRate).toBeCloseTo(0, 9);
  });

  it('a wall only acts within its extent widened by the car radius', () => {
    const shortWall: Collider = { kind: 'wall', id: 'w', ax: -5, az: 0, bx: 5, bz: 0, nx: 0, nz: 1 };
    // Capsule spans x in [6.95, 9.05]: 1.95 m past the wall end, more than the radius.
    expect(resolveCollisions(car(8, 0.5, Math.PI / 2), [shortWall]).contacts).toEqual([]);
    // Capsule spans x in [5.45, 7.55]: 0.45 m past the end, within the radius.
    const near = resolveCollisions(car(6.5, 0.5, Math.PI / 2), [shortWall]);
    expect(near.contacts).toHaveLength(1);
    expect(near.state.z).toBeGreaterThanOrEqual(TUNING.car.radius - 1e-6);
  });

  it('pushes a car deep behind a wall all the way back to the track side', () => {
    const r = resolveCollisions(car(0, -4, 0), [wallX(0)]);
    const cap = carCapsule(r.state);
    expect(Math.min(cap.az, cap.bz)).toBeGreaterThanOrEqual(TUNING.car.radius - 1e-6);
  });

  it('separates a car whose axis crosses a capsule collider', () => {
    const bar: Collider = { kind: 'capsule', id: 'bar', ax: -3, az: 0, bx: 3, bz: 0, r: 0.3 };
    const r = resolveCollisions(car(0, 0, 0), [bar]);
    const cap = carCapsule(r.state);
    expect(r.state.x).toBeCloseTo(0, 9);
    expect(Math.sign(cap.az)).toBe(Math.sign(cap.bz));
    expect(Math.min(Math.abs(cap.az), Math.abs(cap.bz))).toBeGreaterThanOrEqual(0.3 + TUNING.car.radius - 1e-6);
  });

  it('frees a car wedged between a wall and a post and orders contacts deepest first', () => {
    // Post overlap 0.5 m, wall overlap 0.45 m.
    const r = resolveCollisions(car(0, 0.5, Math.PI / 2), [wallX(0), post(2, 0.5, 0.5)]);
    expect(r.contacts.map((c) => c.colliderId)).toEqual(['post', 'w']);
    expect(r.state.z).toBeGreaterThanOrEqual(TUNING.car.radius - 1e-6);
    expect(capsuleOverlapsCircle(carCapsule(r.state), 2, 0.5, 0.5)).toBe(false);
  });

  it('heavyHit is the strongest heavy contact', () => {
    const r = resolveCollisions(car(0, 0, 0, 12, -8), [wallX(-1.5), post(1.5, 0, 1)]);
    expect(r.contacts).toHaveLength(2);
    expect(r.contacts.every((c) => c.impactSpeed >= TUNING.collision.heavyImpact)).toBe(true);
    expect(r.heavyHit!.impactSpeed).toBe(Math.max(...r.contacts.map((c) => c.impactSpeed)));
    expect(r.heavyHit!.colliderId).toBe('post');
  });

  it('a non-finite car state produces no contacts', () => {
    const bar: Collider = { kind: 'capsule', id: 'bar', ax: -3, az: 0, bx: 3, bz: 0, r: 0.3 };
    const r = resolveCollisions({ ...car(0, 0, 0), x: Number.NaN }, [circle(1.5, 0, 1), wallX(0), bar]);
    expect(r.contacts).toEqual([]);
    expect(r.heavyHit).toBeNull();
  });

  it('capsuleOverlapsCircle handles a zero-length capsule', () => {
    const dot = { ax: 0, az: 0, bx: 0, bz: 0, r: 1 };
    expect(capsuleOverlapsCircle(dot, 1.5, 0, 0.6)).toBe(true);
    expect(capsuleOverlapsCircle(dot, 1.7, 0, 0.6)).toBe(false);
  });
});

describe('collision response details', () => {
  const { heavyImpact, hitFriction, scrapeFriction, restitution, yawImpulse } = TUNING.collision;
  const { capsuleHalf, radius } = TUNING.car;

  it('an impact exactly at heavyImpact is a heavy hit; just below is a scrape', () => {
    const at = resolveCollisions(car(0, 0, 0, heavyImpact, 0), [circle(1.5, 0, 1)]);
    expect(at.contacts[0].impactSpeed).toBe(heavyImpact);
    expect(at.heavyHit).not.toBeNull();
    expect(at.state.mode).toBe('recover');
    const below = resolveCollisions(car(0, 0, 0, heavyImpact * 0.999, 0), [circle(1.5, 0, 1)]);
    expect(below.heavyHit).toBeNull();
    expect(below.state.mode).toBe('grip');
  });

  it('a heavy hit keeps hitFriction of the tangential velocity, a scrape keeps scrapeFriction', () => {
    // Heading +x: the front end meets the circle head-on, the +z velocity is tangential.
    const hit = resolveCollisions(car(0, 0, Math.PI / 2, 10, 20), [circle(1.5, 0, 1)]);
    expect(hit.heavyHit).not.toBeNull();
    expect(hit.state.vz).toBeCloseTo(20 * hitFriction, 6);
    expect(hit.state.vx).toBeCloseTo(-restitution * 10, 6);
    const scrape = resolveCollisions(car(0, 0, Math.PI / 2, 3, 20), [circle(1.5, 0, 1)]);
    expect(scrape.heavyHit).toBeNull();
    expect(scrape.state.vz).toBeCloseTo(20 * scrapeFriction, 6);
    expect(scrape.state.vx).toBeCloseTo(-restitution * 3, 6);
  });

  it('the yaw impulse scales with impact speed and the lever arm of the contact', () => {
    // 20 m/s, 20 degrees into a wall: only the front end touches, at lateral lever sin(h) * capsuleHalf.
    const h = Math.PI / 2 + 20 * DEG;
    const r = resolveCollisions(car(0, 1.2, h, 20 * Math.sin(h), 20 * Math.cos(h)), [wallX(0)]);
    const impact = 20 * Math.sin(20 * DEG);
    expect(r.heavyHit!.impactSpeed).toBeCloseTo(impact, 9);
    const tau = -(Math.sin(h) * capsuleHalf) / (capsuleHalf + radius);
    expect(r.state.yawRate).toBeCloseTo(yawImpulse * impact * tau, 9);
  });

  it('the yaw impulse never exceeds yawImpulse * impact', () => {
    const rand = seededRandom(7);
    let kicked = 0;
    for (let i = 0; i < 300; i++) {
      const dir = rand() * TAU;
      const speed = heavyImpact + rand() * 30;
      const c = car(0, 0, rand() * TAU, speed * Math.sin(dir), speed * Math.cos(dir));
      const r = resolveCollisions(c, [circle((rand() * 2 - 1) * 2.5, (rand() * 2 - 1) * 2.5, 0.2 + rand())]);
      if (!r.heavyHit) continue;
      expect(Math.abs(r.state.yawRate)).toBeLessThanOrEqual(yawImpulse * r.heavyHit.impactSpeed + 1e-9);
      if (Math.abs(r.state.yawRate) > 0.1) kicked++;
    }
    expect(kicked).toBeGreaterThan(10);
  });
});

describe('collision with a polyline wall', () => {
  // Two collinear 4 m segments meeting at x = 0, like consecutive barrier segments.
  const segA: Collider = { kind: 'wall', id: 'a', ax: -4, az: 0, bx: 0, bz: 0, nx: 0, nz: 1 };
  const segB: Collider = { kind: 'wall', id: 'b', ax: 0, az: 0, bx: 4, bz: 0, nx: 0, nz: 1 };
  const orders: Collider[][] = [
    [segA, segB],
    [segB, segA],
  ];

  it('a nose-first hit just past a joint gives no yaw kick in either collider order', () => {
    // Front end 0.5 m past the end of segment a (inside its extent widened by the car radius).
    const c = car(0.5, 1.9, Math.PI, 0, -15);
    for (const walls of orders) {
      const r = resolveCollisions(c, walls);
      expect(r.contacts).toHaveLength(1);
      expect(r.heavyHit).not.toBeNull();
      expect(r.heavyHit!.x).toBeCloseTo(0.5, 9);
      expect(r.state.yawRate).toBeCloseTo(0, 9);
    }
  });

  it('a glancing hit across a joint matches the continuous-wall response in either order', () => {
    const h = Math.PI / 2 + 20 * DEG;
    // Front end 0.5 m past the joint, rear end on segment a.
    const c = car(0.5 - Math.sin(h) * TUNING.car.capsuleHalf, 1.2, h, 20 * Math.sin(h), 20 * Math.cos(h));
    const single = resolveCollisions(c, [wallX(0)]);
    expect(single.heavyHit).not.toBeNull();
    for (const walls of orders) {
      const r = resolveCollisions(c, walls);
      expect(r.state.yawRate).toBeCloseTo(single.state.yawRate, 9);
      expect(r.state.vx).toBeCloseTo(single.state.vx, 9);
      expect(r.state.vz).toBeCloseTo(single.state.vz, 9);
      expect(r.state.z).toBeCloseTo(single.state.z, 9);
      expect(r.heavyHit!.x).toBeCloseTo(single.heavyHit!.x, 9);
    }
  });

  it('a broadside hit across a joint gives no yaw kick in either order', () => {
    for (const x of [-1.5, -0.5, 0.5, 1.5]) {
      const c = car(x, 0.9, Math.PI / 2, 0, -10);
      for (const walls of orders) {
        const r = resolveCollisions(c, walls);
        expect(r.heavyHit).not.toBeNull();
        expect(r.state.yawRate).toBeCloseTo(0, 9);
        expect(r.state.z).toBeGreaterThanOrEqual(TUNING.car.radius - 1e-6);
      }
    }
  });
});

describe('collision with a custom tuning argument', () => {
  const withCollision = (patch: Partial<typeof TUNING.collision>) => ({
    ...TUNING,
    collision: { ...TUNING.collision, ...patch },
  });

  it('honours restitution and heavyImpact', () => {
    const bouncy = resolveCollisions(car(0, 0, 0, 10, 0), [circle(1.5, 0, 1)], withCollision({ restitution: 0.6 }));
    expect(bouncy.heavyHit).not.toBeNull();
    expect(bouncy.state.vx).toBeCloseTo(-0.6 * 10, 9);
    expect(bouncy.state.speed).toBeCloseTo(6, 9);
    const tough = resolveCollisions(car(0, 0, 0, 10, 0), [circle(1.5, 0, 1)], withCollision({ heavyImpact: 20 }));
    expect(tough.contacts[0].impactSpeed).toBeCloseTo(10, 9);
    expect(tough.heavyHit).toBeNull();
    expect(tough.state.mode).toBe('grip');
  });

  it('honours the iteration count', () => {
    // Pushing out of the post drives the car back into the wall, so each extra pass leaves less overlap.
    const post = { x: 1.6, z: 1.6, r: 0.6 };
    const colliders = [wallX(0), circle(post.x, post.z, post.r, 'post')];
    const residual = (s: CarState): number => {
      const cap = carCapsule(s);
      const wallPen = TUNING.car.radius - Math.min(cap.az, cap.bz);
      const postPen = post.r + TUNING.car.radius - segPointDist(cap.ax, cap.az, cap.bx, cap.bz, post.x, post.z);
      return Math.max(0, wallPen) + Math.max(0, postPen);
    };
    const start = car(0, 0.5, Math.PI / 2);
    const onePass = resolveCollisions(start, colliders, withCollision({ iterations: 1 }));
    const fullPasses = resolveCollisions(start, colliders);
    expect(TUNING.collision.iterations).toBeGreaterThan(1);
    expect(onePass.contacts.map((c) => c.colliderId).sort()).toEqual(['post', 'w']);
    expect(residual(onePass.state)).toBeGreaterThan(residual(fullPasses.state) + 0.1);
    const none = resolveCollisions(start, colliders, withCollision({ iterations: 0 }));
    expect(none.contacts).toEqual([]);
    expect(none.state).toEqual(start);
  });
});
