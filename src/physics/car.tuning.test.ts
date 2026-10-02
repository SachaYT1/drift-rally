/**
 * The car model reads every tunable from the `t` it is given (never the global TUNING), so the DEV
 * GUI and tests can patch any key. One check per key that moved into tuning.ts.
 */
import { describe, expect, it } from 'vitest';
import { createCarState, stepCar, withDerived } from './car';
import { TUNING, type Tuning } from '../shared/tuning';
import { NEUTRAL_INPUT, type CarState, type InputFrame, type SurfaceKind } from '../shared/types';
import { DEG, damp } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const inp = (p: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...p });

function withCar(patch: Partial<Tuning['car']>): Tuning {
  return { ...TUNING, car: { ...TUNING.car, ...patch } };
}
function withDrift(patch: Partial<Tuning['drift']>): Tuning {
  return { ...TUNING, drift: { ...TUNING.drift, ...patch } };
}

function run(
  start: CarState,
  seconds: number,
  input: () => InputFrame,
  t: Tuning = TUNING,
  surface: SurfaceKind = 'road',
): CarState[] {
  let s = start;
  const trace: CarState[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    s = stepCar(s, input(), surface, DT, t);
    trace.push(s);
  }
  return trace;
}
const last = (trace: CarState[]): CarState => trace[trace.length - 1];

/** Heading 0 (+z), moving with velocity (vx, vz), derived fields consistent. */
const moving = (vx: number, vz: number, heading = 0): CarState => withDerived({ ...createCarState(0, 0, heading), vx, vz });

/** A left drift established for 0.6 s at ~22 m/s (default tuning). */
function leftDrift(): CarState {
  const s = stepCar(moving(0, 22), inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
  return last(run(s, 0.6, () => inp({ throttle: 1, steer: 0.3 })));
}

/** The same drift with its velocity scaled to `speed`, direction and pose kept. */
function atSpeed(s: CarState, speed: number): CarState {
  const k = speed / Math.hypot(s.vx, s.vz);
  return withDerived({ ...s, vx: s.vx * k, vz: s.vz * k });
}

describe('car tuning: car.*', () => {
  it('slipMinSpeed sets the speed below which slip reads 0', () => {
    const a = 40 * DEG;
    const slow = moving(3 * Math.sin(a), 3 * Math.cos(a));
    expect(slow.slip).toBeCloseTo(-a, 9);
    expect(withDerived(slow, withCar({ slipMinSpeed: 5 })).slip).toBe(0);
    expect(stepCar(slow, inp(), 'road', DT, withCar({ slipMinSpeed: 5 })).slip).toBe(0);
    expect(stepCar(slow, inp(), 'road', DT).slip).not.toBe(0);
  });

  it('a slipMinSpeed of 0 (or below) never reports slip for a car at rest', () => {
    for (const slipMinSpeed of [0, -1]) {
      const t = withCar({ slipMinSpeed });
      const rest = createCarState(0, 0, 1.2);
      expect(withDerived(rest, t).slip).toBe(0);
      expect(stepCar(rest, inp(), 'road', DT, t).slip).toBe(0);
      // The non-finite fallback stops the car and must not report the heading as slip either.
      expect(stepCar(moving(3, 4, 1.2), inp({ throttle: Number.NaN }), 'road', DT, t).slip).toBe(0);
      // Moving cars still report slip down to tiny speeds.
      expect(withDerived(moving(0.3, 0.4, 1.2), t).slip).not.toBe(0);
    }
  });

  it('rpmSpeedShare blends speed and throttle into rpm', () => {
    const cruise = moving(0, 20);
    const at = (share: number) => stepCar(cruise, inp({ throttle: 0.5 }), 'road', DT, withCar({ rpmSpeedShare: share }));
    expect(at(0).rpm).toBe(0.5);
    const full = at(1);
    expect(full.rpm).toBeCloseTo(full.forwardSpeed / TUNING.car.maxSpeed, 12);
    const share = TUNING.car.rpmSpeedShare;
    const def = stepCar(cruise, inp({ throttle: 0.5 }), 'road', DT);
    expect(def.rpm).toBeCloseTo((def.forwardSpeed / TUNING.car.maxSpeed) * share + 0.5 * (1 - share), 12);
  });
});

describe('car tuning: drift.*', () => {
  it('holdSpeedFactor sets the speed at which a drift ends', () => {
    const slow = atSpeed(leftDrift(), TUNING.drift.minSpeed * 0.9);
    const hold = inp({ throttle: 1, steer: 0.3 });
    expect(stepCar(slow, hold, 'road', DT).mode).toBe('drift');
    expect(stepCar(slow, hold, 'road', DT, withDrift({ holdSpeedFactor: 1 })).mode).toBe('grip');
  });

  it('throttleMin sets how much throttle counts as held for the exit timer', () => {
    const feather = () => inp({ throttle: 0.3, steer: 0.3 });
    const secs = TUNING.drift.exitDelay * 2;
    expect(run(leftDrift(), secs, feather).every((s) => s.mode === 'drift')).toBe(true);
    const trace = run(leftDrift(), secs, feather, withDrift({ throttleMin: 0.5 }));
    const exitIdx = trace.findIndex((s) => s.mode === 'grip');
    expect(exitIdx).toBeGreaterThan(-1);
    // Exits once the summed step times reach exitDelay (within one step of float accumulation).
    expect((exitIdx + 1) * DT).toBeGreaterThanOrEqual(TUNING.drift.exitDelay - 1e-9);
    expect((exitIdx + 1) * DT).toBeLessThanOrEqual(TUNING.drift.exitDelay + DT + 1e-9);
  });

  it('handbrakeExtraSlip widens the drift angle while Space is held', () => {
    const slipWith = (extra: number) =>
      last(run(leftDrift(), 1, () => inp({ throttle: 1, handbrake: true }), withDrift({ handbrakeExtraSlip: extra }))).slip;
    const none = slipWith(0);
    const def = slipWith(TUNING.drift.handbrakeExtraSlip);
    const wide = slipWith(15 * DEG);
    expect(def).toBeGreaterThan(none + 2 * DEG);
    expect(wide).toBeGreaterThan(def + 5 * DEG);
  });

  it('overspeedDecel sets the bleed above the drift cap, independent of car.brakeDecel', () => {
    let fast = stepCar(moving(0, TUNING.car.maxSpeed * 0.9), inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    fast = last(run(fast, 0.5, () => inp({ throttle: 1, steer: 0.3 })));
    expect(fast.speed).toBeGreaterThan(TUNING.drift.maxSpeedFactor * TUNING.surface.runoff.maxSpeed + 5);
    const onRunoff = (t: Tuning) => stepCar(fast, inp({ throttle: 1, steer: 1 }), 'runoff', DT, t);
    for (const decel of [TUNING.drift.overspeedDecel, 2 * TUNING.drift.overspeedDecel]) {
      expect(fast.speed - onRunoff(withDrift({ overspeedDecel: decel })).speed).toBeCloseTo(decel * DT, 9);
    }
    const script = () => inp({ throttle: 1, steer: 1 });
    const hardBrakes = withCar({ brakeDecel: 4 * TUNING.car.brakeDecel });
    expect(run(fast, 1, script, hardBrakes, 'runoff')).toEqual(run(fast, 1, script, TUNING, 'runoff'));
  });

  /** Recover state as collision.ts leaves it: heading 0, sliding forward at 60 deg. */
  const recovering = (speed: number): CarState => ({
    ...moving(speed * Math.sin(60 * DEG), speed * Math.cos(60 * DEG)),
    mode: 'recover',
    modeTimer: TUNING.drift.recoverTime,
  });

  it('recoverMinSpeed sets the speed above which recovery eases the body', () => {
    const slow = recovering(TUNING.drift.recoverMinSpeed - 0.5);
    expect(stepCar(slow, inp(), 'road', DT).heading).toBe(0);
    const eased = stepCar(slow, inp(), 'road', DT, withDrift({ recoverMinSpeed: TUNING.drift.recoverMinSpeed - 1 }));
    expect(eased.heading).toBeGreaterThan(0);
  });

  it('recoverYawGain scales the recovery yaw rate', () => {
    const start = recovering(12);
    const yaw = (gain: number) => stepCar(start, inp(), 'road', DT, withDrift({ recoverYawGain: gain })).yawRate;
    expect(yaw(0)).toBe(0);
    const g = TUNING.drift.recoverYawGain;
    const expected = 60 * DEG * g * damp(TUNING.car.yawResponse, DT);
    expect(yaw(g)).toBeCloseTo(expected, 9);
    expect(yaw(2 * g)).toBeCloseTo(2 * expected, 9);
  });
});
