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

  it('handbrakeDecel sets the drift deceleration while Space is held, on top of the drift drag (no engine drive)', () => {
    const s = atSpeed(leftDrift(), 25);
    const space = inp({ throttle: 1, steer: 0.3, handbrake: true });
    const drag = TUNING.drift.dragBase + TUNING.drift.dragSlip * Math.abs(Math.sin(s.slip));
    for (const decel of [TUNING.drift.handbrakeDecel, 2 * TUNING.drift.handbrakeDecel]) {
      const next = stepCar(s, space, 'road', DT, withDrift({ handbrakeDecel: decel }));
      expect(next.mode).toBe('drift');
      expect(s.speed - next.speed).toBeCloseTo((drag + decel) * DT, 9);
    }
  });

  it('handbrakeGripDecel sets the deceleration while Space is held in grip (no engine drive)', () => {
    const cruise = moving(0, 20);
    const space = inp({ throttle: 1, handbrake: true });
    const v = cruise.speed;
    const drag = TUNING.car.rollingResistance + TUNING.car.airDrag * v * v;
    for (const decel of [TUNING.drift.handbrakeGripDecel, 2 * TUNING.drift.handbrakeGripDecel]) {
      const next = stepCar(cruise, space, 'road', DT, withDrift({ handbrakeGripDecel: decel }));
      expect(next.mode).toBe('grip');
      expect(v - next.speed).toBeCloseTo((drag + decel) * DT, 9);
    }
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

  /**
   * Path curvature (1/m) of each step of a kick from a straight line, wheel held into the turn (it counts as
   * neutral: it only picks the side), Space held for `space` seconds.
   */
  const kickCurvatures = (t: Tuning, space: number, seconds = 1.5): number[] => {
    let s: CarState = { ...moving(0, 22), steer: 1 };
    const out: number[] = [];
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      const next = stepCar(s, inp({ throttle: 1, steer: 1, handbrake: i * DT < space, handbrakePressed: i === 0 }), 'road', DT, t);
      out.push((Math.atan2(next.vx, next.vz) - Math.atan2(s.vx, s.vz)) / (s.speed * DT));
      s = next;
    }
    return out;
  };

  it('entryBlendTime sets how long a kick takes to bend the path to the drift target', () => {
    // The line hold off (entryHoldTime 0) and Space held: the target is curvNeutral x handbrakeCurvBoost.
    const target = TUNING.drift.curvNeutral * TUNING.drift.handbrakeCurvBoost;
    const at = (t: Tuning, seconds: number): number =>
      kickCurvatures({ ...t, drift: { ...t.drift, entryHoldTime: 0 } }, Infinity)[Math.round(seconds / DT) - 1] / target;
    const T = TUNING.drift.entryBlendTime;
    expect(at(withDrift({ entryBlendTime: 0 }), DT)).toBeCloseTo(1, 9);
    expect(at(TUNING, DT)).toBeLessThan(0.01);
    expect(at(TUNING, T)).toBeCloseTo(1, 9);
    expect(at(withDrift({ entryBlendTime: 2 * T }), T)).toBeCloseTo(0.5, 2);
  });

  it('entryHoldTime sets how long a kick holds the line before the neutral drift arc', () => {
    // From a straight line: the neutral arc eases from 0 to curvNeutral (Space tapped on the first step only).
    const at = (t: Tuning, seconds: number): number =>
      kickCurvatures(t, DT)[Math.round(seconds / DT) - 1] / TUNING.drift.curvNeutral;
    const T = TUNING.drift.entryHoldTime;
    const blended = TUNING.drift.entryBlendTime + 0.05;
    expect(at(withDrift({ entryHoldTime: 0 }), blended)).toBeCloseTo(1, 9);
    expect(at(TUNING, blended)).toBeLessThan(0.5);
    expect(at(TUNING, T)).toBeCloseTo(1, 9);
    expect(at(withDrift({ entryHoldTime: 2 * T }), T)).toBeCloseTo(0.5, 2);
  });

  it('flickBlendTime sets how long a flick takes to bend the path to the new side', () => {
    /** Path curvature (1/m, + = left) `seconds` into a flick out of a settled left drift, the new key held. */
    const at = (t: Tuning, seconds: number): number => {
      let s = last(run(leftDrift(), TUNING.drift.entryHoldTime, () => inp({ throttle: 1 }), t));
      let k = 0;
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        const next = stepCar(s, inp({ throttle: 1, steer: -1, handbrake: i === 0, handbrakePressed: i === 0 }), 'road', DT, t);
        k = (Math.atan2(next.vx, next.vz) - Math.atan2(s.vx, s.vz)) / (s.speed * DT);
        s = next;
      }
      expect(s.driftDir).toBe(-1);
      return k;
    };
    const T = TUNING.drift.flickBlendTime;
    const n = TUNING.drift.curvNeutral;
    expect(at(withDrift({ flickBlendTime: 0 }), 2 * DT)).toBeCloseTo(-n, 9);
    expect(at(TUNING, DT)).toBeGreaterThan(0.9 * n);
    expect(at(TUNING, T + DT)).toBeCloseTo(-n, 9);
    expect(at(withDrift({ flickBlendTime: 2 * T }), T + DT)).toBeCloseTo(0, 2);
  });

  it('curvCounter sets the path curvature at full counter-steer', () => {
    /** Velocity-heading change over 0.5 s of full counter-steer (the catch disabled), after the wheel is across. */
    const turn = (t: Tuning): number => {
      const across = last(run(leftDrift(), 0.4, () => inp({ throttle: 1, steer: -1 }), t));
      const after = last(run(across, 0.5, () => inp({ throttle: 1, steer: -1 }), t));
      return Math.atan2(after.vx, after.vz) - Math.atan2(across.vx, across.vz);
    };
    const noCatch = { catchTime: Infinity };
    expect(Math.abs(turn(withDrift({ ...noCatch, curvCounter: 0 })))).toBeLessThan(1e-9);
    expect(turn(withDrift(noCatch))).toBeLessThan(-1 * DEG);
    expect(turn(withDrift({ ...noCatch, curvCounter: 2 * TUNING.drift.curvCounter }))).toBeCloseTo(2 * turn(withDrift(noCatch)), 2);
  });

  it('catchSteer sets how much counter-steer catches the slide', () => {
    const counter = () => inp({ throttle: 1, steer: -0.7 });
    expect(run(leftDrift(), 1, counter).every((s) => s.mode === 'drift')).toBe(true);
    expect(run(leftDrift(), 1, counter, withDrift({ catchSteer: 0.6 })).some((s) => s.mode === 'grip')).toBe(true);
  });

  it('catchTime sets how long the full counter-steer must be held (from the wheel reaching it)', () => {
    /** Seconds from the wheel reaching full counter-steer to the catch. */
    const holdFor = (t: Tuning) => {
      const states = run(leftDrift(), 2, () => inp({ throttle: 1, steer: -1 }), t);
      const full = states.findIndex((s) => s.steer <= -t.drift.catchSteer);
      return (states.findIndex((s) => s.mode === 'grip') - full + 1) * DT;
    };
    const c = TUNING.drift.catchTime;
    expect(holdFor(TUNING)).toBeCloseTo(c, 1);
    expect(holdFor(withDrift({ catchTime: 2 * c }))).toBeCloseTo(2 * c, 1);
  });

  /** Velocity-heading change 0.6 s after a lift exit (steer released), and the states after the exit. */
  function liftExit(t: Tuning): { turn: number; after: CarState[] } {
    const trace = run(leftDrift(), 1.5, () => inp(), t);
    const exit = trace.findIndex((s) => s.mode === 'grip');
    const a = trace[exit - 1];
    const b = trace[exit + Math.round(0.6 / DT)];
    return { turn: Math.abs(Math.atan2(b.vx, b.vz) - Math.atan2(a.vx, a.vz)), after: trace.slice(exit) };
  }

  it('exitAlignTime sets how long a drift exit keeps the path while the body swings back', () => {
    expect(liftExit(TUNING).turn).toBeLessThan(8 * DEG);
    expect(liftExit(withDrift({ exitAlignTime: 0 })).turn).toBeGreaterThan(20 * DEG);
  });

  it('exitAlignResponse sets how fast the body swings back after a drift', () => {
    const slipAt = (k: number) => Math.abs(liftExit(withDrift({ exitAlignResponse: k })).after[Math.round(0.15 / DT)].slip);
    const k = TUNING.drift.exitAlignResponse;
    expect(slipAt(2 * k)).toBeLessThan(slipAt(k) - 3 * DEG);
    expect(slipAt(k / 2)).toBeGreaterThan(slipAt(k) + 3 * DEG);
  });

  it('exitAlignMaxYawRate caps the yaw rate of the swing', () => {
    const cap = 1;
    const after = liftExit(withDrift({ exitAlignMaxYawRate: cap })).after.slice(0, Math.round(TUNING.drift.exitAlignTime / DT));
    expect(Math.max(...after.map((s) => Math.abs(s.yawRate)))).toBeCloseTo(cap, 6);
  });

  /** Drift speed after `seconds` on W with relative steer `u`, kicked at 22 m/s. */
  function driftSpeed(u: number, seconds: number, t: Tuning): number {
    const kick = stepCar(moving(0, 22), inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT, t);
    return last(run(kick, seconds, () => inp({ throttle: 1, steer: u }), t)).speed;
  }

  it('driftTopSpeed sets where drift thrust fades out', () => {
    const top = TUNING.drift.driftTopSpeed;
    expect(driftSpeed(0, 20, withDrift({ driftTopSpeed: top - 8 }))).toBeLessThan(driftSpeed(0, 20, TUNING) - 3);
  });

  it('topStraight sets the drift top speed on a straight (counter-steered) path', () => {
    expect(driftSpeed(-0.8, 8, withDrift({ topStraight: 1 }))).toBeGreaterThan(driftSpeed(-0.8, 8, TUNING) + 2);
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
