/**
 * Smooth drift entry (design spec §2.3, player test-drive 2026-10-03). The rules teach «держите руль и нажмите
 * пробел»: a kick with the into-steer held. It used to bend the path at once to curvInto x handbrakeCurvBoost
 * (r ~16 m, ~85 deg/s at 24 m/s), so a 0.2 s kick on the fountain sweeper (r 55-200 m) added ~14 deg of inward
 * heading error and the drift hooked into the inner runoff. Now the kick swings the BODY into the slide at
 * once while the path curvature blends from the one the car had in grip to the drift target over
 * drift.entryBlendTime (smoothstep).
 */
import { describe, expect, it } from 'vitest';
import { createCarState, stepCar, withDerived } from './car';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type CarState, type InputFrame } from '../shared/types';
import { DEG, clamp, wrapAngle } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const D = TUNING.drift;
const inp = (p: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...p });
const steps = (seconds: number): number => Math.round(seconds / DT);
const velHeading = (s: CarState): number => Math.atan2(s.vx, s.vz);
const last = (t: CarState[]): CarState => t[t.length - 1];

/** Runs `n` steps feeding input(i, previous state); returns every resulting state. */
function trace(start: CarState, n: number, input: (i: number, s: CarState) => InputFrame): CarState[] {
  const out: CarState[] = [];
  let s = start;
  for (let i = 0; i < n; i++) {
    s = stepCar(s, input(i, s), 'road', DT);
    out.push(s);
  }
  return out;
}

/** Path curvature of the step a -> b relative to `side` (+ = into a `side` turn), 1/m. */
const curvature = (a: CarState, b: CarState, side: 1 | -1): number =>
  (wrapAngle(velHeading(b) - velHeading(a)) / (a.speed * DT)) * side;

/** Throttle that holds ~v m/s (test driver, not game tuning). */
const hold = (v: number) => (s: CarState): number => clamp(0.5 + (v - s.speed) * 0.5, 0, 1);

/** Grip car settled for 2 s on a steady `side` arc with the wheel at `steer` (relative), at ~v m/s. */
function onArc(side: 1 | -1, steer: number, v = 24): CarState {
  const start = withDerived({ ...createCarState(0, 0, 0), vz: v });
  return last(trace(start, steps(2), (_, s) => inp({ throttle: hold(v)(s), steer: steer * side })));
}

/** A grip car at 24 m/s on a ~100 m left arc (the fountain sweeper is r 55-200 m). */
const ARC_STEER = 0.12;

describe('car physics: smooth drift entry', () => {
  it('the arc fixture is a grip car at ~24 m/s on a ~100 m arc', () => {
    const s = onArc(1, ARC_STEER);
    const next = stepCar(s, inp({ throttle: hold(24)(s), steer: ARC_STEER }), 'road', DT);
    expect(s.mode).toBe('grip');
    expect(Math.abs(s.speed - 24)).toBeLessThan(0.5);
    expect(1 / curvature(s, next, 1)).toBeGreaterThan(70);
    expect(1 / curvature(s, next, 1)).toBeLessThan(130);
  });

  it('a kick starts the drift on the path the car was on in grip, not at the drift curvature', () => {
    for (const side of [1, -1] as const) {
      const s = onArc(side, ARC_STEER);
      const grip = curvature(s, stepCar(s, inp({ throttle: hold(24)(s), steer: ARC_STEER * side }), 'road', DT), side);
      const kick = stepCar(s, inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }), 'road', DT);
      expect(kick.mode).toBe('drift');
      expect(Math.abs(curvature(s, kick, side) - grip)).toBeLessThan(0.1 * grip);
    }
  });

  it('the path curvature blends to the drift target over entryBlendTime as a smoothstep, without a jump', () => {
    // Wheel already at full into-steer and Space held throughout, so the drift target stays fixed.
    const target = D.curvInto * D.handbrakeCurvBoost;
    for (const side of [1, -1] as const) {
      const start = { ...withDerived({ ...createCarState(0, 0, 0), vz: 24 }), steer: side };
      const t = trace(start, steps(D.entryBlendTime + 0.3), (i) =>
        inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: i === 0 }),
      );
      expect(t.every((s) => s.mode === 'drift' && s.driftDir === side)).toBe(true);
      const k = [curvature(start, t[0], side), ...t.slice(1).map((s, i) => curvature(t[i], s, side))];
      // Straight before the kick: the first step barely curves.
      expect(k[0]).toBeLessThan(0.01 * target);
      // Half way: the smoothstep midpoint.
      expect(k[steps(D.entryBlendTime / 2) - 1] / target).toBeCloseTo(0.5, 1);
      // From entryBlendTime on: exactly the drift target.
      for (const x of k.slice(steps(D.entryBlendTime))) expect(x).toBeCloseTo(target, 9);
      // Smooth: never decreasing, and no step larger than the smoothstep's peak slope (1.5 / entryBlendTime).
      for (let i = 1; i < k.length; i++) {
        expect(k[i]).toBeGreaterThanOrEqual(k[i - 1] - 1e-12);
        expect(k[i] - k[i - 1]).toBeLessThanOrEqual((1.5 * target * DT) / D.entryBlendTime + 1e-9);
      }
    }
  });

  it('a 0.2 s kick with the into-steer held (as the rules teach) adds little inward heading error', () => {
    // On the ~100 m arc at 24 m/s: the into-key goes down, Space 0.1 s later for 0.2 s, the key stays held.
    // Compared with the same car staying in grip on the arc. Was ~14 deg at the end of the Space tap.
    for (const side of [1, -1] as const) {
      const s = onArc(side, ARC_STEER);
      const space = steps(0.1);
      const kicked = trace(s, steps(0.4), (i) =>
        inp({ throttle: 1, steer: side, handbrake: i >= space && i < space + steps(0.2), handbrakePressed: i === space }),
      );
      const grip = trace(s, steps(0.4), (_, g) => inp({ throttle: hold(24)(g), steer: ARC_STEER * side }));
      const error = (i: number): number => wrapAngle(velHeading(kicked[i]) - velHeading(grip[i])) * side;
      expect(kicked[space].mode).toBe('drift');
      const tapEnd = space + steps(0.2) - 1;
      expect(error(tapEnd)).toBeLessThan(4 * DEG);
      // The body did swing into the slide: the kick reads as a drift at once.
      expect(kicked[tapEnd].slip * side).toBeGreaterThan(25 * DEG);
    }
  });

  it('a re-kick while the body swings back after an exit starts from the path, not from the body yaw', () => {
    // A lift exit: the nose swings back toward the velocity (~1.9 rad/s peak), the path barely turns. A kick
    // that started from the body yaw rate would bend the path ~0.06 1/m the wrong way.
    const kick = stepCar(onArc(1, ARC_STEER), inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    const settled = last(trace(kick, steps(1), () => inp({ throttle: 1, steer: 0 })));
    const lift = trace(settled, steps(0.6), () => inp());
    const swing = lift.findIndex((s) => s.mode === 'grip' && Math.abs(s.yawRate) > 1.5);
    expect(swing).toBeGreaterThan(0);
    const s = lift[swing];
    const path = Math.abs(curvature(lift[swing - 1], s, 1));
    const rekick = stepCar(s, inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    expect(rekick.mode).toBe('drift');
    expect(Math.abs(curvature(s, rekick, 1))).toBeLessThan(path + 0.005);
  });
});
