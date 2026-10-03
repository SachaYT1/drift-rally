/**
 * Smooth drift entry (design spec §2.3, player test-drives 2026-10-03). The rules teach «держите руль и нажмите
 * пробел»: a kick with the into-steer held. It used to bend the path at once to curvInto x handbrakeCurvBoost
 * (r ~16 m, ~85 deg/s at 24 m/s), so a 0.2 s kick on the fountain sweeper (r 55-200 m) added ~14 deg of inward
 * heading error and the drift hooked into the inner runoff. Now:
 * - the kick swings the BODY into the slide at once while the path curvature blends from the one the car had in
 *   grip to the drift target over drift.entryBlendTime (smoothstep);
 * - the kick holds the line: the neutral drift arc eases from the grip path to curvNeutral over
 *   drift.entryHoldTime, so a kick on a wide sweeper does not tuck in before the player can react;
 * - the steer held through the kick only picks the side: it counts as neutral until it is let go, so keeping the
 *   key down «as the rules teach» does not tighten the drift; a fresh press does, and letting go of it stops
 *   the tightening at once (the smoothed wheel used to keep tightening for ~0.17 s);
 * - a flick bends the path from the one the car is on over drift.flickBlendTime, and its steer counts as
 *   neutral in the new direction the same way.
 */
import { describe, expect, it } from 'vitest';
import { createCarState, stepCar, withDerived } from './car';
import { TUNING, type Tuning } from '../shared/tuning';
import { NEUTRAL_INPUT, type CarState, type InputFrame } from '../shared/types';
import { DEG, clamp, lerp, wrapAngle } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const D = TUNING.drift;
const inp = (p: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...p });
const steps = (seconds: number): number => Math.round(seconds / DT);
const velHeading = (s: CarState): number => Math.atan2(s.vx, s.vz);
const last = (t: CarState[]): CarState => t[t.length - 1];
const withDrift = (patch: Partial<Tuning['drift']>): Tuning => ({ ...TUNING, drift: { ...TUNING.drift, ...patch } });

/** Runs `n` steps feeding input(i, previous state); returns every resulting state. */
function trace(start: CarState, n: number, input: (i: number, s: CarState) => InputFrame, t: Tuning = TUNING): CarState[] {
  const out: CarState[] = [];
  let s = start;
  for (let i = 0; i < n; i++) {
    s = stepCar(s, input(i, s), 'road', DT, t);
    out.push(s);
  }
  return out;
}

/** Path curvature of the step a -> b relative to `side` (+ = into a `side` turn), 1/m. */
const curvature = (a: CarState, b: CarState, side: 1 | -1): number =>
  (wrapAngle(velHeading(b) - velHeading(a)) / (a.speed * DT)) * side;

/** Path curvature of every step of trace `t` that started from `start`, relative to `side`. */
const curvatures = (start: CarState, t: CarState[], side: 1 | -1): number[] =>
  t.map((s, i) => curvature(i === 0 ? start : t[i - 1], s, side));

/** Throttle that holds ~v m/s (test driver, not game tuning). */
const hold = (v: number) => (s: CarState): number => clamp(0.5 + (v - s.speed) * 0.5, 0, 1);

/** Grip car settled for 2 s on a steady `side` arc with the wheel at `steer` (relative), at ~v m/s. */
function onArc(side: 1 | -1, steer: number, v = 24): CarState {
  const start = withDerived({ ...createCarState(0, 0, 0), vz: v });
  return last(trace(start, steps(2), (_, s) => inp({ throttle: hold(v)(s), steer: steer * side })));
}

/** A grip car at 24 m/s on a ~100 m left arc (the fountain sweeper is r 55-200 m). */
const ARC_STEER = 0.12;

/**
 * A kick as the rules teach on the ~100 m arc: the into-key goes down with Space (held `space` s), on W. The key
 * stays down `into` s, is up until `repress` s (if given), then down again. Returns the per-step inputs.
 */
function kickScript(side: 1 | -1, o: { space?: number; into: number; repress?: number }) {
  return (i: number): InputFrame => {
    const t = i * DT;
    const down = t < o.into || (o.repress !== undefined && t >= o.repress);
    return inp({ throttle: 1, steer: down ? side : 0, handbrake: t < (o.space ?? 0.2), handbrakePressed: i === 0 });
  };
}

/** A neutral `side` drift kicked off the ~100 m arc and held past entryHoldTime: key and Space let go at 0.2 s. */
function settledDrift(side: 1 | -1): CarState {
  const t = trace(onArc(side, ARC_STEER), steps(D.entryHoldTime + 0.5), kickScript(side, { into: 0.2 }));
  expect(t.every((s) => s.mode === 'drift' && s.driftDir === side)).toBe(true);
  return last(t);
}

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
    // A kick from a straight line with the line hold off (entryHoldTime 0), so the target is fixed: the key held
    // through the kick counts as neutral, and Space stays held (handbrakeCurvBoost).
    const t0 = withDrift({ entryHoldTime: 0 });
    const target = D.curvNeutral * D.handbrakeCurvBoost;
    for (const side of [1, -1] as const) {
      const start = { ...withDerived({ ...createCarState(0, 0, 0), vz: 24 }), steer: side };
      const t = trace(start, steps(D.entryBlendTime + 0.3), (i) =>
        inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: i === 0 }), t0);
      expect(t.every((s) => s.mode === 'drift' && s.driftDir === side)).toBe(true);
      const k = curvatures(start, t, side);
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

  it('a kick holds the line: the neutral arc eases from the grip path to curvNeutral over entryHoldTime', () => {
    for (const side of [1, -1] as const) {
      const s = onArc(side, ARC_STEER);
      const grip = curvature(s, stepCar(s, inp({ throttle: hold(24)(s), steer: ARC_STEER * side }), 'road', DT), side);
      // Key held through the kick (neutral), Space tapped on the first step only.
      const t = trace(s, steps(D.entryHoldTime + 0.3), kickScript(side, { space: DT, into: Infinity }));
      expect(t.every((x) => x.mode === 'drift' && x.driftDir === side)).toBe(true);
      const k = curvatures(s, t, side);
      expect(Math.abs(k[0] - grip)).toBeLessThan(0.1 * grip);
      // Half way: the smoothstep midpoint between the grip path and the neutral arc.
      expect(k[steps(D.entryHoldTime / 2) - 1]).toBeCloseTo(lerp(grip, D.curvNeutral, 0.5), 3);
      // From entryHoldTime on: the neutral arc.
      for (const x of k.slice(steps(D.entryHoldTime))) expect(x).toBeCloseTo(D.curvNeutral, 9);
      // Eased: never decreasing after the Space tap (it tightens its own step), no step larger than the
      // smoothstep's peak slope.
      for (let i = 2; i < k.length; i++) {
        expect(k[i]).toBeGreaterThanOrEqual(k[i - 1] - 1e-12);
        expect(k[i] - k[i - 1]).toBeLessThanOrEqual((1.01 * 1.5 * (D.curvNeutral - grip) * DT) / D.entryHoldTime);
      }
    }
  });

  it('a kick never holds a line curving away from its side: off a path turning the other way it starts straight', () => {
    // Browser play-test: a re-kick right after a catch (the exit phase was turning the path outward) held that
    // outward line for entryHoldTime and the drift ran 6 m wide.
    const ease = (x: number): number => clamp(x, 0, 1) ** 2 * (3 - 2 * clamp(x, 0, 1));
    for (const side of [1, -1] as const) {
      const s = onArc(-side as 1 | -1, ARC_STEER);
      const t = trace(s, steps(D.entryHoldTime + 0.3), kickScript(side, { into: 0.2 }));
      expect(t.every((x) => x.mode === 'drift' && x.driftDir === side)).toBe(true);
      const k = curvatures(s, t, side);
      expect(k[0]).toBeLessThan(0);
      const blended = steps(D.entryBlendTime);
      expect(k[blended - 1]).toBeCloseTo(lerp(0, D.curvNeutral, ease(D.entryBlendTime / D.entryHoldTime)), 6);
      for (const x of k.slice(blended)) expect(x).toBeGreaterThanOrEqual(0);
    }
  });

  it('holding the line costs no speed: the drift on W runs as fast as one that took the neutral arc at once', () => {
    // The drift top speed drops on a straighter path only for counter-steer (no "drift highway"), not while
    // the kick holds the line on its own.
    for (const side of [1, -1] as const) {
      const s = onArc(side, ARC_STEER);
      const hold = last(trace(s, steps(D.entryHoldTime), kickScript(side, { into: 0.2 })));
      const none = last(trace(s, steps(D.entryHoldTime), kickScript(side, { into: 0.2 }), withDrift({ entryHoldTime: 0 })));
      expect(hold.mode).toBe('drift');
      expect(Math.abs(hold.speed - none.speed)).toBeLessThan(0.05);
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

  it('keeping the into-key down 0.5 s after the Space tap still adds at most ~6 deg of inward heading by +0.6 s', () => {
    // Play-test 2: a player lets go only once they SEE the car tuck in (key held ~0.2-0.5 s after Space). The
    // path used to reach r 20 within ~0.35 s with the key down: 15-18 deg inward by +0.55 s on the fountain.
    for (const side of [1, -1] as const) {
      const s = onArc(side, ARC_STEER);
      const kicked = trace(s, steps(0.6), kickScript(side, { into: 0.5 }));
      const grip = trace(s, steps(0.6), (_, g) => inp({ throttle: hold(24)(g), steer: ARC_STEER * side }));
      expect(kicked.every((x) => x.mode === 'drift')).toBe(true);
      expect(wrapAngle(velHeading(last(kicked)) - velHeading(last(grip))) * side).toBeLessThanOrEqual(6 * DEG);
    }
  });

  it('the steer held through the kick counts as neutral: holding it or letting go drifts the same path', () => {
    for (const side of [1, -1] as const) {
      const s = onArc(side, ARC_STEER);
      const held = trace(s, steps(3), kickScript(side, { into: Infinity }));
      const letGo = trace(s, steps(3), kickScript(side, { into: 0.2 }));
      expect([...held, ...letGo].every((x) => x.mode === 'drift' && x.driftDir === side)).toBe(true);
      const kHeld = curvatures(s, held, side);
      const kLetGo = curvatures(s, letGo, side);
      for (let i = 0; i < kHeld.length; i++) expect(kHeld[i]).toBeCloseTo(kLetGo[i], 9);
      // However long the key stays down, the drift settles on the neutral arc, not the into arc.
      expect(kHeld[kHeld.length - 1]).toBeCloseTo(D.curvNeutral, 9);
    }
  });

  it('a fresh into press after the kick tightens the drift to curvInto', () => {
    for (const side of [1, -1] as const) {
      const s = onArc(side, ARC_STEER);
      const repress = 0.4;
      const t = trace(s, steps(D.entryHoldTime + 0.5), kickScript(side, { into: 0.2, repress }));
      const held = trace(s, steps(D.entryHoldTime + 0.5), kickScript(side, { into: Infinity }));
      expect([...t, ...held].every((x) => x.mode === 'drift' && x.driftDir === side)).toBe(true);
      const k = curvatures(s, t, side);
      const kHeld = curvatures(s, held, side);
      // Tighter than the held-through kick as soon as the wheel turns in again, and the into arc once settled.
      expect(k[steps(repress + 0.2)]).toBeGreaterThan(kHeld[steps(repress + 0.2)] + 0.005);
      expect(k[k.length - 1]).toBeCloseTo(D.curvInto, 9);
    }
  });

  it('letting go of a fresh into press stops the tightening at once, while the wheel is still turned in', () => {
    for (const side of [1, -1] as const) {
      const pressed = trace(settledDrift(side), steps(0.5), () => inp({ throttle: 1, steer: side }));
      const into = last(pressed);
      expect(curvature(pressed[pressed.length - 2], into, side)).toBeCloseTo(D.curvInto, 9);
      const released = stepCar(into, inp({ throttle: 1 }), 'road', DT);
      expect(released.steer * side).toBeGreaterThan(0.9);
      expect(curvature(into, released, side)).toBeCloseTo(D.curvNeutral, 9);
    }
  });

  it('a kick never starts the path tighter than curvInto x handbrakeCurvBoost (e.g. after a wall-slide pivot)', () => {
    // Play-test 2: grip integration after a wall-slide pivot left a path curvature of 0.5 1/m (r 2 m) at 8.8 m/s.
    const cap = D.curvInto * D.handbrakeCurvBoost;
    for (const side of [1, -1] as const) {
      for (const pathCurv of [0.5, -0.5]) {
        const s = { ...withDerived({ ...createCarState(0, 0, 0), vz: D.minSpeed + 1 }), pathCurv };
        const kick = stepCar(s, inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }), 'road', DT);
        expect(kick.mode).toBe('drift');
        expect(Math.abs(curvature(s, kick, side))).toBeLessThanOrEqual(cap + 1e-9);
      }
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

describe('car physics: smooth flick', () => {
  /** A flick out of a settled `side` drift: the opposite key with a Space tap, the key then held. */
  const flick = (side: 1 | -1, seconds: number) => {
    const s = settledDrift(side);
    const t = trace(s, steps(seconds), (i) => inp({ throttle: 1, steer: -side, handbrake: i === 0, handbrakePressed: i === 0 }));
    expect(t.every((x) => x.mode === 'drift' && x.driftDir === -side)).toBe(true);
    return { s, t, k: curvatures(s, t, side) };
  };

  it('a flick bends the path from the one the car is on over flickBlendTime instead of jumping to the new side', () => {
    for (const side of [1, -1] as const) {
      const { k } = flick(side, D.flickBlendTime + 0.1);
      // Relative to the OLD side: starts on the old neutral arc, ends curving the other way.
      expect(k[0]).toBeGreaterThan(0.9 * D.curvNeutral);
      expect(k[k.length - 1]).toBeLessThan(-0.9 * D.curvNeutral);
      // No jump: every step moves the path by a small share of the whole swing, always toward the new side.
      const swing = k[0] - k[k.length - 1];
      for (let i = 1; i < k.length; i++) {
        expect(k[i]).toBeLessThanOrEqual(k[i - 1] + 1e-12);
        expect(k[i - 1] - k[i]).toBeLessThan(0.1 * swing);
      }
    }
  });

  it('the steer held through a flick counts as neutral in the new direction until it is let go', () => {
    for (const side of [1, -1] as const) {
      const { k } = flick(side, D.flickBlendTime + 1.5);
      expect(-k[k.length - 1]).toBeCloseTo(D.curvNeutral, 9);
    }
  });
});
