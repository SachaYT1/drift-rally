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
  it('keeps speedKeep of the velocity and pushes away from the bomb', () => {
    const r = applyBlast(car(), 0, 1); // under the nose: pushed back
    expect(r.vx).toBeCloseTo(0, 9);
    expect(r.vz).toBeCloseTo(20 * B.speedKeep - B.push, 9);
    expect(r.speed).toBeCloseTo(Math.abs(20 * B.speedKeep - B.push), 9);
    const side = applyBlast(car(), 0.5, 0); // on the left: pushed right
    expect(side.vx).toBeCloseTo(-B.push, 9);
    expect(side.vz).toBeCloseTo(20 * B.speedKeep, 9);
  });

  it('throws the end of the car over the bomb away from it', () => {
    expect(applyBlast(car(), 0.5, 1).yawRate).toBeCloseTo(-B.yawKick, 9); // front left: nose right
    expect(applyBlast(car(), 0.5, -1).yawRate).toBeCloseTo(B.yawKick, 9); // rear left: nose left
    expect(applyBlast(car(), -0.5, 1).yawRate).toBeCloseTo(B.yawKick, 9); // front right: nose left
    expect(applyBlast(car(), 0, 1).yawRate).toBeCloseTo(0, 9); // on the axis
    expect(applyBlast(car(), 0.5, 0).yawRate).toBeCloseTo(0, 9); // beside the centre
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

  it('on top of the car centre pushes sideways away from the bomb side, left when exactly centred', () => {
    const exact = applyBlast(car(), 0, 0);
    expect(exact.vx).toBeCloseTo(B.push, 9);
    const nearLeft = applyBlast(car(), 1e-4, 0);
    expect(nearLeft.vx).toBeCloseTo(-B.push, 9);
    for (const r of [exact, nearLeft])
      for (const v of Object.values(r)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('honours a custom tuning and never mutates the input car', () => {
    const t = { ...TUNING, bomb: { ...B, speedKeep: 0, push: 3 } };
    const c = Object.freeze(car());
    const r = applyBlast(c, 0, 1, t);
    expect(r.vz).toBeCloseTo(-3, 9);
    expect(c.vz).toBe(20);
    expect(c.mode).toBe('drift');
  });
});
