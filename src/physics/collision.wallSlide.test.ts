/**
 * Wall slide (player test-drive: after a shallow crash, W with no steer kept the nose pinned into the barrier
 * and the car ground along it at 0-5 m/s; a head-on pin needed reverse-and-W cycles or R). While the car
 * scrapes an obstacle (contact below heavyImpact) with its nose into it, the collision pass turns the nose
 * parallel to the surface in the direction of travel, rate-limited; slow cars at a barrier turn toward the
 * track's driving direction. Drift scrapes are scaled down; heavy hits are untouched.
 */
import { describe, expect, it } from 'vitest';
import { createCarState, isDrifting, stepCar, withDerived } from './car';
import { resolveCollisions } from './collision';
import { TUNING, type Tuning } from '../shared/tuning';
import { DEG, seededRandom, wrapAngle } from '../shared/math';
import { NEUTRAL_INPUT, type CarState, type Collider, type InputFrame } from '../shared/types';

const DT = 1 / TUNING.race.physicsHz;
const W: InputFrame = { ...NEUTRAL_INPUT, throttle: 1 };
const { capsuleHalf, radius } = TUNING.car;
/** Barrier distance from the test lane centre, m. */
const X = 12;

/**
 * A straight barrier on one side of a lane that runs toward +z (the driving direction): side +1 = left
 * (x = +X, faces -x), side -1 = right (x = -X, faces +x). Segments run in the driving direction, as the
 * track builder emits them.
 */
type Wall = Extract<Collider, { kind: 'wall' }>;
const barrier = (side: 1 | -1): Wall => ({
  kind: 'wall',
  id: `wall-${side}`,
  ax: side * X,
  az: -500,
  bx: side * X,
  bz: 3000,
  nx: -side,
  nz: 0,
});

/**
 * Car whose nose is `alpha` (rad) into the barrier on `side`, measured from the driving direction (+z):
 * 90 deg = head-on, > 90 deg = pointing back against the track. The front end just touches the wall.
 * Velocity: `v` m/s along the heading, or along +z when `along` is 'track'.
 */
function nosed(side: 1 | -1, alpha: number, v = 0, along: 'heading' | 'track' = 'heading'): CarState {
  const h = side * alpha;
  const x = side * (X - radius - 0.01 - capsuleHalf * Math.sin(alpha));
  const [vx, vz] = along === 'heading' ? [v * Math.sin(h), v * Math.cos(h)] : [0, v];
  return withDerived({ ...createCarState(x, 0, h), vx, vz });
}

interface Trace {
  states: CarState[];
  heavy: number;
  contacts: number;
}

/** stepCar + resolveCollisions for `seconds`; states[i] is the state after step i + 1. */
function drive(
  start: CarState,
  colliders: readonly Collider[],
  seconds: number,
  input: InputFrame = W,
  t: Tuning = TUNING,
): Trace {
  let s = start;
  const states: CarState[] = [];
  let heavy = 0;
  let contacts = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    s = stepCar(s, input, 'road', DT, t);
    const r = resolveCollisions(s, colliders, t);
    if (r.heavyHit) heavy++;
    if (r.contacts.length > 0) contacts++;
    s = r.state;
    states.push(s);
  }
  return { states, heavy, contacts };
}

const at = (tr: Trace, seconds: number): CarState => tr.states[Math.round(seconds / DT) - 1];
/** Heading error from the driving direction (+z), rad. */
const offTrack = (s: CarState): number => Math.abs(wrapAngle(s.heading));
/** Longest run (s) with the velocity along the track below progress.wrongWaySpeed. */
function longestBackward(tr: Trace): number {
  let run = 0;
  let longest = 0;
  for (const s of tr.states) {
    run = s.vz < TUNING.progress.wrongWaySpeed ? run + DT : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}
/** First time (s) the car moves along the track at > `speed` with the nose within `tol` of it, or Infinity. */
function freedAt(tr: Trace, speed = 4, tol = 10 * DEG): number {
  const i = tr.states.findIndex((s) => s.vz > speed && offTrack(s) < tol);
  return i < 0 ? Infinity : (i + 1) * DT;
}

const withCollision = (patch: Partial<Tuning['collision']>): Tuning => ({
  ...TUNING,
  collision: { ...TUNING.collision, ...patch },
});

describe('wall slide: W only after a scrape', () => {
  it('a shallow-angle scrape turns the nose parallel within 0.6 s and the car accelerates along the wall', () => {
    for (const side of [1, -1] as const) {
      for (const deg of [10, 22, 35]) {
        for (const [v, along] of [
          [8.7, 'heading'],
          [3, 'heading'],
          [8.7, 'track'],
          [0, 'heading'],
        ] as const) {
          const label = `side ${side}, ${deg} deg, ${v} m/s along ${along}`;
          const tr = drive(nosed(side, deg * DEG, v, along), [barrier(side)], 1.2);
          expect(tr.heavy, label).toBe(0);
          expect(tr.contacts, label).toBeGreaterThan(0);
          expect(offTrack(at(tr, 0.6)), label).toBeLessThanOrEqual(3 * DEG);
          // Free of the wall's grip: W accelerates the car at (at least half) engine pace along it.
          const gain = at(tr, 0.9).vz - at(tr, 0.6).vz;
          expect(gain, label).toBeGreaterThan(0.5 * TUNING.car.engineAccel * 0.3 * 0.8);
          expect(at(tr, 1.2).vz, label).toBeGreaterThan(Math.max(v, 4));
        }
      }
    }
  });

  it('a head-on pin is freed toward the track direction within 1.5 s', () => {
    for (const side of [1, -1] as const) {
      for (const offset of [-20, -10, -3, 0, 3, 10, 20]) {
        for (const v of [0, 2]) {
          const label = `side ${side}, ${offset} deg off head-on, ${v} m/s`;
          const tr = drive(nosed(side, (90 + offset) * DEG, v), [barrier(side)], 2);
          expect(tr.heavy, label).toBe(0);
          expect(freedAt(tr), label).toBeLessThanOrEqual(1.5);
          expect(longestBackward(tr), label).toBe(0);
        }
      }
    }
  });

  it('a car pinned pointing back against the track turns around, never along the wrong way', () => {
    for (const side of [1, -1] as const) {
      for (const deg of [120, 150, 170]) {
        const label = `side ${side}, ${deg} deg`;
        const tr = drive(nosed(side, deg * DEG, 0), [barrier(side)], 3);
        expect(freedAt(tr), label).toBeLessThanOrEqual(2.2);
        expect(longestBackward(tr), label).toBeLessThan(TUNING.progress.wrongWayTime);
      }
    }
  });

  it('a fast scrape keeps the direction of travel, also when that is against the barrier direction', () => {
    // Driving back down the lane (-z) at 12 m/s, nose 10 deg into the left barrier: it stays a backward slide.
    const s = withDerived({ ...createCarState(X - radius - 0.01 - capsuleHalf * Math.sin(10 * DEG), 0, Math.PI - 10 * DEG) });
    const start = { ...s, vx: 12 * Math.sin(s.heading), vz: 12 * Math.cos(s.heading) };
    const tr = drive(withDerived(start), [barrier(1)], 0.6);
    expect(tr.heavy).toBe(0);
    expect(Math.abs(wrapAngle(at(tr, 0.6).heading - Math.PI))).toBeLessThanOrEqual(3 * DEG);
  });

  it('a spinning crash into the barrier: the pin that follows the bounce slides free within 1.5 s', () => {
    // Drift kicked toward a barrier 6-14 m away at 22 m/s, then W only from the heavy hit on. Without the slide
    // the car stays pinned nose-first at ~0.2 m/s. The hit and its bounce are unchanged (no contact to slide on).
    for (const side of [1, -1] as const) {
      for (const dist of [6, 10, 14]) {
        const wall: Collider = { ...barrier(side), ax: side * dist, bx: side * dist };
        let s = withDerived({ ...createCarState(0, 0, 0), vz: 22 });
        s = stepCar(s, { ...W, steer: side, handbrake: true, handbrakePressed: true }, 'road', DT);
        let hitAt = -1;
        let pinAt = -1;
        const after: CarState[] = [];
        for (let i = 0; i < Math.round(6 / DT); i++) {
          s = stepCar(s, hitAt < 0 ? { ...W, steer: side } : W, 'road', DT);
          const r = resolveCollisions(s, [wall]);
          s = r.state;
          if (r.heavyHit && hitAt < 0) hitAt = i;
          else if (hitAt >= 0 && pinAt < 0 && r.contacts.length > 0) pinAt = i;
          if (hitAt >= 0) after.push(s);
        }
        const label = `side ${side}, wall ${dist} m`;
        expect(hitAt, label).toBeGreaterThanOrEqual(0);
        expect(pinAt, label).toBeGreaterThan(hitAt);
        const tr: Trace = { states: after, heavy: 1, contacts: 0 };
        const freed = freedAt(tr);
        expect(freed - (pinAt - hitAt) * DT, label).toBeLessThanOrEqual(1.5);
        expect(freed, label).toBeLessThanOrEqual(2.5);
        // The bounce off the hit may roll back for a few steps; never long enough to raise wrong-way.
        expect(longestBackward(tr), label).toBeLessThan(0.25 * TUNING.progress.wrongWayTime);
      }
    }
  });
});

describe('wall slide: limits', () => {
  const c = TUNING.collision;

  it('turns by at most slideAlignMaxRate per step and never past the wall tangent', () => {
    const rand = seededRandom(11);
    let turned = 0;
    for (let i = 0; i < 400; i++) {
      const side = rand() < 0.5 ? 1 : -1;
      const alpha = rand() * 175 * DEG;
      const s = nosed(side, alpha, rand() * 5, rand() < 0.5 ? 'heading' : 'track');
      const pushed = { ...s, x: s.x + side * rand() * 0.3 };
      const r = resolveCollisions(pushed, [barrier(side)]);
      if (r.heavyHit) continue;
      const dh = r.state.heading - pushed.heading;
      expect(Math.abs(dh)).toBeLessThanOrEqual(c.slideAlignMaxRate * DT + 1e-12);
      if (Math.abs(dh) > 1e-9) turned++;
      // Never past parallel: a nose into the wall (side * sin h >= 0) never ends up pointing away from it.
      expect(side * Math.sin(r.state.heading)).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(turned).toBeGreaterThan(100);
  });

  it('never turns the nose toward the wall: a tail or flank contact leaves the heading alone', () => {
    // Nose 20 deg away from the left barrier, rear corner overlapping it.
    const h = -20 * DEG;
    const tail = withDerived({ ...createCarState(X - radius + 0.1 - capsuleHalf * Math.sin(20 * DEG), 0, h), vz: 8 });
    const r = resolveCollisions(tail, [barrier(1)]);
    expect(r.contacts).toHaveLength(1);
    expect(r.state.heading).toBe(h);
    // Parallel flank contact: nothing to align.
    const flank = withDerived({ ...createCarState(X - radius + 0.1, 0, 0), vz: 8 });
    const f = resolveCollisions(flank, [barrier(1)]);
    expect(f.contacts).toHaveLength(1);
    expect(f.state.heading).toBe(0);
  });

  it('a heavy hit is not aligned: heading untouched, the hit response is unchanged', () => {
    const s = nosed(1, 40 * DEG, 20);
    const r = resolveCollisions({ ...s, x: s.x + 0.2 }, [barrier(1)]);
    expect(r.heavyHit).not.toBeNull();
    expect(r.state.heading).toBe(s.heading);
    expect(r.state.mode).toBe('recover');
  });

  it('honours the tuning: slideAlignGain 0 (or slideAlignMaxRate 0) restores the plain scrape', () => {
    const s = nosed(-1, 30 * DEG, 4);
    const pushed = { ...s, x: s.x - 0.1 };
    for (const patch of [{ slideAlignGain: 0 }, { slideAlignMaxRate: 0 }]) {
      const r = resolveCollisions(pushed, [barrier(-1)], withCollision(patch));
      expect(r.contacts).toHaveLength(1);
      expect(r.state.heading).toBe(pushed.heading);
    }
    expect(resolveCollisions(pushed, [barrier(-1)]).state.heading).not.toBe(pushed.heading);
  });
});

describe('wall slide in a drift', () => {
  /** Drifting right at 15 m/s along +z, nose 30 deg right, the right barrier `gap` m beyond the nose. */
  function driftAtWall(gap: number): CarState {
    const h = -30 * DEG;
    const x = -X + radius + gap + capsuleHalf * Math.sin(30 * DEG);
    return withDerived({ ...createCarState(x, 0, h), vz: 15, mode: 'drift', driftDir: -1, gripBlend: 1 });
  }

  it('a drifting car kissing the wall keeps drifting and is barely turned', () => {
    // A 4 m stretch of barrier: the nose overlaps it by 0.1 m and slides past it.
    const kiss: Collider = { ...barrier(-1), az: -2, bz: 2 };
    const input: InputFrame = { ...W, steer: -0.3 };
    const withSlide = drive(driftAtWall(-0.1), [kiss], 1.2, input);
    const without = drive(driftAtWall(-0.1), [kiss], 1.2, input, withCollision({ slideAlignGain: 0 }));
    expect(withSlide.heavy).toBe(0);
    expect(withSlide.contacts).toBeGreaterThan(3);
    for (const tr of [withSlide, without]) {
      expect(tr.states.every((s) => s.mode === 'drift' && s.driftDir === -1)).toBe(true);
      expect(isDrifting(tr.states[tr.states.length - 1])).toBe(true);
    }
    const maxDiff = Math.max(
      ...withSlide.states.map((s, i) => Math.abs(wrapAngle(s.heading - without.states[i].heading))),
    );
    expect(maxDiff).toBeLessThan(4 * DEG);
  });

  it('a drift scrape turns at most slideDriftScale of the grip rate per step', () => {
    const s = driftAtWall(-0.1);
    const r = resolveCollisions(s, [barrier(-1)]);
    expect(r.heavyHit).toBeNull();
    expect(r.state.mode).toBe('drift');
    const dh = Math.abs(r.state.heading - s.heading);
    expect(dh).toBeGreaterThan(0);
    expect(dh).toBeLessThanOrEqual(TUNING.collision.slideDriftScale * TUNING.collision.slideAlignMaxRate * DT + 1e-12);
  });
});

describe('wall slide side choice off the barriers', () => {
  const post = (x: number, z: number, r = 0.5): Collider => ({ kind: 'circle', id: 'post', x, z, r });
  /** Car heading +z with its nose just touching a post dead ahead (no barrier around). */
  const atPost = (steer: number): CarState =>
    withDerived({ ...createCarState(0, -(capsuleHalf + radius + 0.5) + 0.02, 0), steer });

  it('dead head-on into a round obstacle, the player steer picks the side', () => {
    for (const steer of [1, -1]) {
      const r = resolveCollisions(atPost(steer), [post(0, 0)]);
      expect(r.contacts).toHaveLength(1);
      // + heading = nose to the left.
      expect(Math.sign(r.state.heading)).toBe(steer);
    }
  });

  it('a slow car spun against an obstacle next to a barrier turns toward the track direction', () => {
    // Post 4 m inside the left barrier; the car points back down the lane, 40 deg toward the barrier side.
    for (const side of [1, -1] as const) {
      const px = side * (X - 4);
      const h = side * (180 - 40) * DEG;
      const reach = capsuleHalf + radius + 0.5 - 0.02;
      const start = withDerived(createCarState(px - Math.sin(h) * reach, -Math.cos(h) * reach, h));
      const tr = drive(start, [post(px, 0), barrier(side)], 2.5);
      expect(longestBackward(tr), `side ${side}`).toBe(0);
      expect(at(tr, 2.5).vz, `side ${side}`).toBeGreaterThan(2);
    }
  });
});

describe('wall slide determinism', () => {
  it('is a pure function of the state (no hidden memory)', () => {
    const s = nosed(1, 70 * DEG, 1);
    const a = resolveCollisions({ ...s, x: s.x + 0.05 }, [barrier(1)]);
    const b = resolveCollisions({ ...s, x: s.x + 0.05 }, [barrier(1)]);
    expect(a).toEqual(b);
    expect(a.state.heading).not.toBe(s.heading);
  });
});
