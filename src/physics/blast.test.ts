import { describe, expect, it } from 'vitest';
import { applyBlast } from './blast';
import { createCarState, withDerived } from './car';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';

const B = TUNING.bomb;
/** Car at the origin heading +z (forward (0, 1), left (1, 0)) at 20 m/s, drifting. */
const car = (over: Partial<CarState> = {}): CarState =>
  withDerived({ ...createCarState(0, 0, 0), vz: 20, mode: 'drift', driftDir: 1, driftTime: 2, gripBlend: 0.4, ...over });

describe('applyBlast', () => {
  it('keeps speedKeep of the velocity and throws the car sideways, away from the bomb side', () => {
    const left = applyBlast(car(), 0.5, 1); // under the front left: thrown right
    expect(left.vx).toBeCloseTo(-B.push, 9);
    expect(left.vz).toBeCloseTo(20 * B.speedKeep, 9);
    const right = applyBlast(car(), -0.5, -1); // under the rear right: thrown left
    expect(right.vx).toBeCloseTo(B.push, 9);
    expect(right.vz).toBeCloseTo(20 * B.speedKeep, 9);
  });

  it('loses about half the speed and never throws the car backwards, head-on included', () => {
    for (const speed of [8, 20, 35]) {
      for (const [bx, bz] of [[0, 1.8], [0.6, 1.7], [-1.2, 1.2]]) {
        const before = car({ vz: speed });
        const r = applyBlast(before, bx, bz);
        expect(r.vz).toBeCloseTo(speed * B.speedKeep, 9); // the push is across the path only
        expect(r.forwardSpeed).toBeGreaterThan(0);
        if (speed >= 20) {
          expect(r.speed / speed).toBeGreaterThan(0.35);
          expect(r.speed / speed).toBeLessThan(0.65);
        }
      }
    }
  });

  it('pushes across the direction of travel, not the body, in a drift', () => {
    // Body yawed 30 deg left of the velocity (+z); bomb on the left of the path.
    const drifting = car({ heading: (30 * Math.PI) / 180 });
    const r = applyBlast(drifting, 0.8, 1.5);
    expect(r.vx).toBeCloseTo(-B.push, 9);
    expect(r.vz).toBeCloseTo(20 * B.speedKeep, 9);
  });

  it('throws the end of the car over the bomb away from it', () => {
    expect(applyBlast(car(), 0.5, 1).yawRate).toBeCloseTo(-B.yawKick, 9); // front left: nose right
    expect(applyBlast(car(), 0.5, -1).yawRate).toBeCloseTo(B.yawKick, 9); // rear left: nose left
    expect(applyBlast(car(), -0.5, 1).yawRate).toBeCloseTo(B.yawKick, 9); // front right: nose left
    expect(applyBlast(car(), 0, 1).yawRate).toBeCloseTo(0, 9); // on the axis
    expect(applyBlast(car(), 0.5, 0).yawRate).toBeCloseTo(0, 9); // beside the centre
  });

  it('is the same seen from any heading (body-frame maths)', () => {
    // A scenario in the body frame: speed along forward, bomb at (lon, lat); + lat = left.
    const at = (h: number, lon: number, lat: number) => ({
      x: lon * Math.sin(h) + lat * Math.cos(h),
      z: lon * Math.cos(h) - lat * Math.sin(h),
    });
    for (const [lon, lat] of [[1.2, 0.7], [-1, -0.4], [1.5, 0], [0, 0]]) {
      const b0 = at(0, lon, lat);
      const ref = applyBlast(car(), b0.x, b0.z);
      for (const h of [0.7, 2.4, -2, Math.PI / 2]) {
        const v = at(h, 20, 0);
        const b = at(h, lon, lat);
        const r = applyBlast(car({ heading: h, vx: v.x, vz: v.z }), b.x, b.z);
        expect(r.forwardSpeed).toBeCloseTo(ref.forwardSpeed, 9);
        expect(r.lateralSpeed).toBeCloseTo(ref.lateralSpeed, 9);
        expect(r.yawRate).toBeCloseTo(ref.yawRate, 9);
      }
    }
  });

  it('enters recovery and leaves the drift like a heavy hit', () => {
    expect(applyBlast(car(), 0.5, 1)).toMatchObject({
      mode: 'recover',
      modeTimer: TUNING.drift.recoverTime,
      driftDir: 0,
      driftTime: 0,
      gripBlend: 0,
    });
    const grip = applyBlast(car({ mode: 'grip', driftDir: 0, driftTime: 0, gripBlend: 1 }), 0.5, 1);
    expect(grip).toMatchObject({ mode: 'recover', gripBlend: 1 });
  });

  it('a bomb dead ahead throws the car left; a standing car is thrown off its body axis', () => {
    expect(applyBlast(car(), 0, 1.5).vx).toBeCloseTo(B.push, 9);
    const standing = applyBlast(car({ vz: 0 }), 0.4, 0.5); // bomb on the left of the body
    expect(standing.vx).toBeCloseTo(-B.push, 9);
    expect(standing.vz).toBeCloseTo(0, 9);
    for (const r of [standing, applyBlast(car({ vz: 0 }), 0, 0)])
      for (const v of Object.values(r)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('honours a custom tuning and never mutates the input car', () => {
    const t = { ...TUNING, bomb: { ...B, speedKeep: 0, push: 3 } };
    const c = Object.freeze(car());
    const r = applyBlast(c, 0.5, 1, t);
    expect(r.vx).toBeCloseTo(-3, 9);
    expect(r.vz).toBeCloseTo(0, 9);
    expect(c.vz).toBe(20);
    expect(c.mode).toBe('drift');
  });
});
