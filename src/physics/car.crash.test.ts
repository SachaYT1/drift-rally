/**
 * Throttle response right after a crash (final review: dead-throttle-after-crash). A drift into a barrier
 * left the body ~90 deg to its velocity with a tiny negative forward speed; throttle then "braked toward 0"
 * every step and the car sat at 0 km/h with W held for ~2.5 s.
 */
import { describe, expect, it } from 'vitest';
import { createCarState, stepCar, withDerived } from './car';
import { resolveCollisions } from './collision';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type CarState, type Collider, type InputFrame } from '../shared/types';
import { DEG } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const inp = (p: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...p });
const W = inp({ throttle: 1 });

/**
 * Kicks a drift toward `side` at 22 m/s (steer `hold` into it) at a wall `dist` m to that side, then holds
 * W (no steer) from the heavy hit on. Returns seconds from the hit until forwardSpeed > 2 m/s.
 */
function recoveryAfterWallHit(dist: number, hold: number, side: 1 | -1): { hit: boolean; seconds: number } {
  const wall: Collider = { kind: 'wall', id: 'w', ax: side * dist, az: -500, bx: side * dist, bz: 500, nx: -side, nz: 0 };
  let s = withDerived({ ...createCarState(0, 0, 0), vz: 22 });
  s = stepCar(s, inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }), 'road', DT);
  let hitStep = -1;
  for (let i = 0; i < Math.round(6 / DT); i++) {
    s = stepCar(s, hitStep < 0 ? inp({ throttle: 1, steer: hold * side }) : W, 'road', DT);
    const r = resolveCollisions(s, [wall]);
    s = r.state;
    if (r.heavyHit && hitStep < 0) hitStep = i;
    if (hitStep >= 0 && s.forwardSpeed > 2) return { hit: true, seconds: (i - hitStep) * DT };
  }
  return { hit: hitStep >= 0, seconds: Infinity };
}

/** Grip-mode car at heading 0 with velocity (vx, vz). */
const moving = (vx: number, vz: number, mode: CarState['mode'] = 'grip'): CarState => ({
  ...withDerived({ ...createCarState(0, 0, 0), vx, vz }),
  mode,
  modeTimer: mode === 'recover' ? TUNING.drift.recoverTime : 0,
});

describe('car physics: throttle after a crash', () => {
  it('W drives the car forward within 0.6 s of a drift into a wall', () => {
    for (const side of [1, -1] as const) {
      for (const dist of [6, 10, 12, 14]) {
        for (const hold of [1, 0.3, 0]) {
          const r = recoveryAfterWallHit(dist, hold, side);
          expect(r.hit, `side ${side} dist ${dist} hold ${hold}`).toBe(true);
          expect(r.seconds, `side ${side} dist ${dist} hold ${hold}`).toBeLessThanOrEqual(0.6);
        }
      }
    }
  });

  it('throttle moves a sideways car forward even from a rounding-level negative forward speed', () => {
    for (const vf of [-1e-12, -1e-9, 0]) {
      const s = stepCar(moving(6, vf), W, 'road', DT);
      expect(s.forwardSpeed).toBeGreaterThan(0.5 * TUNING.car.engineAccel * DT);
    }
  });

  it('throttle that stops a backward roll mid-step drives forward for the rest of the step', () => {
    const back = 0.25 * TUNING.car.brakeDecel * DT;
    const s = stepCar(moving(0, -back), W, 'road', DT);
    expect(s.forwardSpeed).toBeGreaterThan(0.5 * TUNING.car.engineAccel * DT);
    expect(s.forwardSpeed).toBeLessThanOrEqual(TUNING.car.engineAccel * DT);
  });

  it('recovery eases a sideways (~90 deg) slide toward the velocity heading', () => {
    for (const angle of [90 * DEG, 95 * DEG, -90 * DEG]) {
      const start = moving(12 * Math.sin(angle), 12 * Math.cos(angle), 'recover');
      let s = start;
      for (let i = 0; i < Math.round((TUNING.drift.recoverTime * 0.75) / DT); i++) s = stepCar(s, inp(), 'road', DT);
      expect(s.mode).toBe('recover');
      expect(Math.sign(s.heading)).toBe(Math.sign(angle));
      expect(Math.abs(s.heading)).toBeGreaterThan(30 * DEG);
      expect(Math.abs(s.slip)).toBeLessThan(Math.abs(start.slip) - 30 * DEG);
    }
  });

  it('recovery leaves a car moving backwards alone (beyond recoverMaxAngle)', () => {
    const angle = TUNING.drift.recoverMaxAngle + 20 * DEG;
    let s = moving(12 * Math.sin(angle), 12 * Math.cos(angle), 'recover');
    for (let i = 0; i < Math.round(TUNING.drift.recoverTime / DT); i++) s = stepCar(s, inp(), 'road', DT);
    expect(Math.abs(s.heading)).toBeLessThan(1e-9);
  });
});
