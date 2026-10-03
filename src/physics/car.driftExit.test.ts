/**
 * Drift exits keep the direction of travel (design spec §2.3, control scheme A): on every exit (lift W, brake,
 * catch, the handbrake's low-speed exit) the body swings to the velocity heading instead of the velocity snapping toward the
 * nose. Before this, a lift from a steady 35 deg drift turned the velocity ~40 deg toward the inside of the
 * corner within 0.6 s (the "inward dart"). Also: drift speed balance (no "drift highway" on straights).
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
const last = (t: CarState[]): CarState => t[t.length - 1];

/** Steer (relative to the drift) that targets a 35 deg slip: slipMid..slipWide at 1/3 into the turn. */
const STEADY_STEER = (35 * DEG - D.slipMid) / (D.slipWide - D.slipMid);
/** Throttle that holds ~20 m/s in the steady drift (test driver, not game tuning). */
const holdSpeed = (s: CarState): number => clamp(0.6 + (20 - s.speed) * 0.5, 0.3, 1);

/** A steady ~35 deg drift toward `side` at ~20 m/s: kicked at 21 m/s, held for 1.5 s. */
function steadyDrift(side: 1 | -1): CarState {
  const kick = stepCar(
    withDerived({ ...createCarState(0, 0, 0), vz: 21 }),
    inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }),
    'road',
    DT,
  );
  return last(trace(kick, steps(1.5), (_, s) => inp({ throttle: holdSpeed(s), steer: STEADY_STEER * side })));
}

type Exit = 'lift' | 'brake' | 'catch';

/**
 * The player's exit gesture from a `side` drift. Steer is released on the first grip step (the drift is
 * over); S is held until a 0.2 s reaction after the exit.
 */
function exitInput(kind: Exit, side: 1 | -1) {
  let exitAt = -1;
  return (i: number, s: CarState): InputFrame => {
    if (exitAt < 0 && s.mode !== 'drift') exitAt = i;
    const drifting = exitAt < 0;
    if (kind === 'lift') return inp({ steer: drifting ? STEADY_STEER * side : 0 });
    if (kind === 'brake') return inp({ brake: drifting || i - exitAt < steps(0.2) ? 1 : 0, steer: drifting ? STEADY_STEER * side : 0 });
    return inp({ throttle: 1, steer: drifting ? -side : 0 });
  };
}

/** Exits a steady drift with `kind`; returns the last drift state and 0.8 s of states from the exit on. */
function exitFrom(kind: Exit, side: 1 | -1): { before: CarState; after: CarState[] } {
  const t = trace(steadyDrift(side), steps(2), exitInput(kind, side));
  const exit = t.findIndex((s) => s.mode !== 'drift');
  expect(exit, `${kind} ${side}: the drift ends`).toBeGreaterThan(0);
  return { before: t[exit - 1], after: t.slice(exit, exit + steps(0.8)) };
}

describe('car physics: drift exits keep the direction of travel', () => {
  it('the steady drift fixture slides at ~35 deg and ~20 m/s', () => {
    for (const side of [1, -1] as const) {
      const s = steadyDrift(side);
      expect(s.mode).toBe('drift');
      expect(s.slip * side).toBeGreaterThan(32 * DEG);
      expect(s.slip * side).toBeLessThan(38 * DEG);
      expect(Math.abs(s.speed - 20)).toBeLessThan(1);
    }
  });

  for (const kind of ['lift', 'brake', 'catch'] as const) {
    it(`${kind}: velocity heading turns < 8 deg in 0.6 s and |slip| < 5 deg within 0.5 s, both directions`, () => {
      for (const side of [1, -1] as const) {
        const { before, after } = exitFrom(kind, side);
        expect(after[0].mode).toBe('grip');
        const phi0 = velHeading(before);
        const turn = after.slice(0, steps(0.6)).map((s) => Math.abs(wrapAngle(velHeading(s) - phi0)));
        expect(Math.max(...turn), `${kind} ${side}: velocity heading change`).toBeLessThan(8 * DEG);
        for (const s of after.slice(steps(0.5) - 1)) expect(Math.abs(s.slip), `${kind} ${side}: slip`).toBeLessThan(5 * DEG);
      }
    });

    it(`${kind}: the body swings back without overshoot or a jolt`, () => {
      for (const side of [1, -1] as const) {
        const { before, after } = exitFrom(kind, side);
        let prev = before;
        for (const s of after) {
          // The nose never swings past the travel direction (no tank-slapper).
          expect(s.slip * side, `${kind} ${side}: overshoot`).toBeGreaterThan(-1 * DEG);
          // Continuous: no lateral jolt, and the yaw rate swings over several steps (not in one).
          expect(Math.abs(s.lateralSpeed - prev.lateralSpeed)).toBeLessThan(0.6);
          expect(Math.abs(s.yawRate - prev.yawRate)).toBeLessThan(0.6);
          prev = s;
        }
      }
    });
  }

  it('the exit swing is rate-limited', () => {
    for (const kind of ['lift', 'brake', 'catch'] as const) {
      for (const s of exitFrom(kind, 1).after) expect(Math.abs(s.yawRate)).toBeLessThanOrEqual(D.exitAlignMaxYawRate + 1e-9);
    }
  });

  it('a right exit mirrors a left exit exactly', () => {
    for (const kind of ['lift', 'brake', 'catch'] as const) {
      const l = exitFrom(kind, 1).after;
      const r = exitFrom(kind, -1).after;
      expect(r.length).toBe(l.length);
      for (let i = 0; i < l.length; i += 12) {
        expect(r[i].x).toBeCloseTo(-l[i].x, 9);
        expect(r[i].z).toBeCloseTo(l[i].z, 9);
        expect(r[i].heading).toBeCloseTo(-l[i].heading, 9);
      }
    }
  });

  it('steering after the exit turns the car again as grip returns', () => {
    const t = trace(steadyDrift(1), steps(2), (_, s) => inp({ steer: s.mode === 'drift' ? STEADY_STEER : -1 }));
    const exit = t.findIndex((s) => s.mode !== 'drift');
    const turn = wrapAngle(velHeading(t[exit + steps(1)]) - velHeading(t[exit - 1]));
    expect(turn).toBeLessThan(-15 * DEG);
  });
});

describe('car physics: drift speed balance', () => {
  /** Drift speeds over `seconds` holding W and steer `u` (relative to the drift) from a 22 m/s kick. */
  function driftSpeeds(u: number, seconds: number, side: 1 | -1 = 1): CarState[] {
    const kick = stepCar(
      withDerived({ ...createCarState(0, 0, 0), vz: 22 }),
      inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }),
      'road',
      DT,
    );
    return trace(kick, steps(seconds), () => inp({ throttle: 1, steer: u * side }));
  }

  it('a neutral drift on W settles at a steady speed below the grip top speed (and the drift cap)', () => {
    const t = driftSpeeds(0, 40);
    expect(t.every((s) => s.mode === 'drift')).toBe(true);
    const end = last(t).speed;
    expect(Math.abs(end - t[t.length - 1 - steps(1)].speed)).toBeLessThan(0.1);
    // Drifting never beats driving flat out in grip on a straight: no "drift highway".
    const grip = trace(withDerived({ ...createCarState(0, 0, 0), vz: 20 }), steps(40), () => inp({ throttle: 1 }));
    expect(end).toBeLessThan(last(grip).speed - 0.5);
    expect(end).toBeLessThan(D.maxSpeedFactor * TUNING.car.maxSpeed - 2);
  });

  it('counter-steer short of a catch never drifts faster than a neutral drift settles at', () => {
    // A narrower slip drags a little less, so it may gain speed a touch quicker, but it tops out lower.
    const neutral = last(driftSpeeds(0, 30)).speed;
    for (const u of [-0.1, -0.3, -0.6, -(D.catchSteer - 0.05)]) {
      for (const side of [1, -1] as const) {
        const t = driftSpeeds(u, 30, side);
        expect(t.every((s) => s.mode === 'drift'), `u ${u}`).toBe(true);
        expect(Math.max(...t.map((s) => s.speed)), `u ${u}`).toBeLessThanOrEqual(neutral + 1e-6);
      }
    }
  });

  it('a kick at the drift cap on W bleeds down toward the steady drift speed instead of holding the cap', () => {
    const cap = D.maxSpeedFactor * TUNING.car.maxSpeed;
    const fast = stepCar(
      withDerived({ ...createCarState(0, 0, 0), vz: cap }),
      inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }),
      'road',
      DT,
    );
    const t = trace(fast, steps(4), () => inp({ throttle: 1, steer: -0.6 }));
    expect(t.every((s) => s.mode === 'drift')).toBe(true);
    expect(last(t).speed).toBeLessThan(cap - 2);
  });
});
