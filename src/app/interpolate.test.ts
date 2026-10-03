import { describe, expect, it } from 'vitest';
import { SNAP_DISTANCE, interpolateCar } from './interpolate';
import { createCarState } from '../physics/car';
import { TAU, wrapAngle } from '../shared/math';
import type { CarState } from '../shared/types';

function car(x: number, z: number, heading: number, extra: Partial<CarState> = {}): CarState {
  return { ...createCarState(x, z, heading), ...extra };
}

describe('interpolateCar', () => {
  it('lerps the position and takes every non-pose field from the newer state', () => {
    const prev = car(0, 0, 0, { vx: 1, mode: 'grip', wheelSpin: 1 });
    const curr = car(1, 2, 0.2, { vx: 5, mode: 'drift', wheelSpin: 3, slip: 0.4 });
    const r = interpolateCar(prev, curr, 0.25, false);
    expect(r.x).toBeCloseTo(0.25, 12);
    expect(r.z).toBeCloseTo(0.5, 12);
    expect(r.heading).toBeCloseTo(0.05, 12);
    expect(r.vx).toBe(5);
    expect(r.mode).toBe('drift');
    expect(r.wheelSpin).toBe(3);
    expect(r.slip).toBe(0.4);
  });

  it('alpha 0 and 1 hit the endpoints', () => {
    const prev = car(1, 1, 0.1);
    const curr = car(2, 3, 0.3);
    expect(interpolateCar(prev, curr, 0, false)).toMatchObject({ x: 1, z: 1, heading: 0.1 });
    expect(interpolateCar(prev, curr, 1, false)).toMatchObject({ x: 2, z: 3 });
    expect(interpolateCar(prev, curr, 1, false).heading).toBeCloseTo(0.3, 12);
  });

  it('blends unwrapped headings along the shortest arc', () => {
    // 10 full turns accumulated: prev just below +pi, curr just past it (stored unwrapped).
    const base = 10 * TAU;
    const prev = car(0, 0, base + Math.PI - 0.1);
    const curr = car(0, 0.1, base + Math.PI + 0.1);
    const mid = interpolateCar(prev, curr, 0.5, false).heading;
    expect(wrapAngle(mid - (base + Math.PI))).toBeCloseTo(0, 12);

    // Same physical angles, but curr stored a full turn lower: still the 0.2 rad arc, not 2pi - 0.2.
    const curr2 = car(0, 0.1, base + Math.PI + 0.1 - TAU);
    const mid2 = interpolateCar(prev, curr2, 0.5, false).heading;
    expect(Math.abs(mid2 - prev.heading)).toBeCloseTo(0.1, 12);
  });

  it('snaps to the newer state on a flagged teleport', () => {
    const prev = car(0, 0, 0);
    const curr = car(1, 0, 1);
    const r = interpolateCar(prev, curr, 0.5, true);
    expect(r).toMatchObject({ x: 1, z: 0, heading: 1 });
  });

  it('snaps on an unflagged jump longer than SNAP_DISTANCE', () => {
    const prev = car(0, 0, 0);
    const far = car(SNAP_DISTANCE + 0.01, 0, 0.5);
    expect(interpolateCar(prev, far, 0.5, false)).toMatchObject({ x: far.x, heading: 0.5 });
    const near = car(SNAP_DISTANCE - 0.01, 0, 0.5);
    expect(interpolateCar(prev, near, 0.5, false).x).toBeCloseTo(near.x / 2, 12);
  });

  it('snaps on non-finite input instead of producing NaN', () => {
    const curr = car(1, 1, 1);
    expect(interpolateCar(car(Number.NaN, 0, 0), curr, 0.5, false)).toMatchObject({ x: 1, z: 1, heading: 1 });
    expect(interpolateCar(car(0, 0, Number.NaN), curr, 0.5, false)).toMatchObject({ x: 1, z: 1, heading: 1 });
    expect(interpolateCar(car(0.5, 0.5, 0), curr, Number.NaN, false)).toMatchObject({ x: 1, z: 1, heading: 1 });
  });

  it('clamps alpha above 1 and writes into (and returns) the reused output object', () => {
    const out = car(9, 9, 9);
    const r = interpolateCar(car(0, 0, 0), car(1, 0, 0), 3, false, out);
    expect(r).toBe(out);
    expect(r.x).toBe(1);
  });

  it('never mutates its inputs', () => {
    const prev = Object.freeze(car(0, 0, 0));
    const curr = Object.freeze(car(1, 1, 1));
    expect(() => interpolateCar(prev, curr, 0.5, false)).not.toThrow();
  });
});
