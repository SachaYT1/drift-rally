import { describe, expect, it } from 'vitest';
import { carCapsule, createCarState, isDrifting, stepCar } from './car';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type CarState, type InputFrame, type SurfaceKind } from '../shared/types';
import { DEG, seededRandom } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const inp = (p: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...p });

function run(
  start: CarState,
  seconds: number,
  input: (t: number, s: CarState) => InputFrame,
  surface: SurfaceKind = 'road',
): { s: CarState; trace: CarState[] } {
  let s = start;
  const trace: CarState[] = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    s = stepCar(s, input(i * DT, s), surface, DT);
    trace.push(s);
  }
  return { s, trace };
}

/** Car heading 0 (+z) cruising at v m/s, in grip mode. */
function cruising(v: number): CarState {
  const c = createCarState(0, 0, 0);
  return stepCar({ ...c, vz: v }, inp({ throttle: 0 }), 'road', 1e-6);
}

/** A left drift established for 0.6 s at ~22 m/s. */
function establishedLeftDrift(): CarState {
  let s = cruising(22);
  s = stepCar(s, inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
  return run(s, 0.6, () => inp({ throttle: 1, steer: 0.3 })).s;
}

describe('car physics', () => {
  it('starts at rest in grip mode with finite fields', () => {
    const c = createCarState(1, 2, 0.5);
    expect(c.mode).toBe('grip');
    expect(c.speed).toBe(0);
    expect(c).toMatchObject({ flickArm: 0, catchTimer: 0, exitAlign: 0 });
    for (const v of Object.values(c)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('accelerates with throttle and never exceeds maxSpeed', () => {
    const { s: s3 } = run(createCarState(0, 0, 0), 3, () => inp({ throttle: 1 }));
    expect(s3.speed).toBeGreaterThan(15);
    const { trace } = run(createCarState(0, 0, 0), 25, () => inp({ throttle: 1 }));
    for (const s of trace) expect(s.speed).toBeLessThanOrEqual(TUNING.car.maxSpeed + 1e-6);
    expect(trace[trace.length - 1].speed).toBeGreaterThan(0.7 * TUNING.car.maxSpeed);
  });

  it('never gains speed without throttle', () => {
    const { trace } = run(cruising(20), 3, () => inp());
    for (let i = 1; i < trace.length; i++) expect(trace[i].speed).toBeLessThanOrEqual(trace[i - 1].speed + 1e-9);
  });

  it('brakes to a stop, then reverses after the delay, capped', () => {
    const { s, trace } = run(cruising(10), 4, () => inp({ brake: 1 }));
    expect(trace.some((x) => Math.abs(x.forwardSpeed) < 0.5)).toBe(true);
    expect(s.forwardSpeed).toBeLessThan(0);
    expect(s.forwardSpeed).toBeGreaterThanOrEqual(-TUNING.car.maxReverseSpeed - 1e-6);
  });

  it('steering left (+1) turns left: heading increases, car moves toward +x', () => {
    const { s } = run(cruising(10), 1, () => inp({ throttle: 0.3, steer: 1 }));
    expect(s.heading).toBeGreaterThan(0.2);
    expect(s.x).toBeGreaterThan(0);
  });

  it('grip cornering respects the lateral acceleration cap', () => {
    const { trace } = run(cruising(30), 2, () => inp({ throttle: 1, steer: 1 }));
    for (const s of trace.slice(60)) {
      expect(s.mode).toBe('grip');
      expect(Math.abs(s.yawRate * s.speed)).toBeLessThanOrEqual(TUNING.car.maxLatAccelGrip * 1.15);
    }
  });

  it('Space + steer at speed enters a drift within 0.3 s', () => {
    let s = stepCar(cruising(20), inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    s = run(s, 0.3, () => inp({ throttle: 1, steer: 1 })).s;
    expect(s.mode).toBe('drift');
    expect(s.driftDir).toBe(1);
    expect(isDrifting(s)).toBe(true);
    expect(s.slip).toBeGreaterThan(TUNING.score.minSlip);
  });

  it('does not kick a drift below minSpeed or when reversing', () => {
    const slow = stepCar(cruising(TUNING.drift.minSpeed - 3), inp({ steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    expect(slow.mode).toBe('grip');
    const back = stepCar({ ...cruising(0), vz: -6 }, inp({ steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    expect(back.mode).toBe('grip');
  });

  it('a held drift never spins out', () => {
    const { trace } = run(establishedLeftDrift(), 4, () => inp({ throttle: 1, steer: 1 }));
    for (const s of trace) {
      expect(s.mode).toBe('drift');
      expect(Math.abs(s.slip)).toBeLessThanOrEqual(TUNING.drift.slipMax + 2 * DEG);
      expect(s.speed).toBeGreaterThan(10);
    }
  });

  it('steering into the drift tightens the path, counter-steer widens it', () => {
    const base = establishedLeftDrift();
    const turn = (steer: number) => {
      const { s } = run(base, 1, () => inp({ throttle: 1, steer }));
      const a0 = Math.atan2(base.vx, base.vz);
      const a1 = Math.atan2(s.vx, s.vz);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return d;
    };
    const into = turn(1), neutral = turn(0), counter = turn(-0.5);
    expect(into).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(counter);
    expect(counter).toBeGreaterThan(0);
  });

  it('releasing throttle and handbrake exits smoothly to grip', () => {
    const { trace } = run(establishedLeftDrift(), 2, () => inp());
    const exitIdx = trace.findIndex((s) => s.mode === 'grip');
    expect(exitIdx).toBeGreaterThan(-1);
    expect(exitIdx * DT).toBeLessThanOrEqual(TUNING.drift.exitDelay + 0.05);
    for (let i = 1; i < trace.length; i++) {
      expect(Math.abs(trace[i].lateralSpeed - trace[i - 1].lateralSpeed)).toBeLessThan(0.6);
    }
    expect(Math.abs(trace[trace.length - 1].slip)).toBeLessThan(5 * DEG);
  });

  it('flick: strong counter-steer + Space flips the drift without leaving drift mode', () => {
    let s = stepCar(establishedLeftDrift(), inp({ throttle: 1, steer: -1, handbrake: true, handbrakePressed: true }), 'road', DT);
    const { s: end, trace } = run(s, 0.6, () => inp({ throttle: 1, steer: -1 }));
    s = end;
    expect(trace.every((x) => x.mode === 'drift')).toBe(true);
    expect(s.driftDir).toBe(-1);
    expect(s.slip).toBeLessThan(0);
  });

  it('recover mode returns to grip after recoverTime', () => {
    const start = { ...cruising(10), mode: 'recover' as const, modeTimer: TUNING.drift.recoverTime };
    const { s } = run(start, TUNING.drift.recoverTime + 0.05, () => inp({ throttle: 1 }));
    expect(s.mode).toBe('grip');
  });

  it('runoff limits top speed', () => {
    const { s } = run(createCarState(0, 0, 0), 15, () => inp({ throttle: 1 }), 'runoff');
    expect(s.speed).toBeLessThanOrEqual(TUNING.surface.runoff.maxSpeed + 0.5);
  });

  it('is deterministic and finite under random inputs', () => {
    const script = (seed: number) => {
      const rnd = seededRandom(seed);
      const frames: InputFrame[] = [];
      for (let i = 0; i < 20 * 120; i++) {
        const space = rnd() < 0.02;
        frames.push(inp({ throttle: rnd() < 0.7 ? 1 : 0, brake: rnd() < 0.1 ? 1 : 0, steer: Math.round(rnd() * 2 - 1), handbrake: space, handbrakePressed: space }));
      }
      return frames;
    };
    const frames = script(42);
    const a = run(createCarState(0, 0, 0), 20, (t) => frames[Math.round(t / DT)]).s;
    const b = run(createCarState(0, 0, 0), 20, (t) => frames[Math.round(t / DT)]).s;
    expect(a).toEqual(b);
    for (const v of Object.values(a)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('carCapsule follows heading', () => {
    const c = carCapsule(createCarState(0, 0, 0));
    expect(c.az).toBeCloseTo(TUNING.car.capsuleHalf);
    expect(c.bz).toBeCloseTo(-TUNING.car.capsuleHalf);
    expect(c.r).toBe(TUNING.car.radius);
  });
});

describe('car physics: edge cases', () => {
  const allFinite = (s: CarState) =>
    Object.values(s).every((v) => typeof v !== 'number' || Number.isFinite(v));

  it('never mutates the input state or input frame', () => {
    const s = Object.freeze(establishedLeftDrift());
    const before = { ...s };
    const frame = Object.freeze(inp({ throttle: 1, steer: -1, handbrake: true, handbrakePressed: true }));
    const next = stepCar(s, frame, 'road', DT);
    expect(next).not.toBe(s);
    expect(s).toEqual(before);
  });

  it('a non-finite result falls back to the previous pose with zero velocity', () => {
    const prev = cruising(10);
    const s = stepCar(prev, inp({ throttle: Number.NaN }), 'road', DT);
    expect(allFinite(s)).toBe(true);
    expect(s.x).toBe(prev.x);
    expect(s.z).toBe(prev.z);
    expect(s.speed).toBe(0);
    expect(s.yawRate).toBe(0);
  });

  it('holding Space (no fresh press) while steering at speed also kicks a drift', () => {
    const s = stepCar(cruising(20), inp({ throttle: 1, steer: -1, handbrake: true }), 'road', DT);
    expect(s.mode).toBe('drift');
    expect(s.driftDir).toBe(-1);
  });

  it('Space without enough steer does not kick a drift', () => {
    const steer = TUNING.drift.kickSteerThreshold / 2;
    const s = stepCar(cruising(20), inp({ throttle: 1, steer, handbrake: true, handbrakePressed: true }), 'road', DT);
    expect(s.mode).toBe('grip');
  });

  it('holding Space without throttle keeps the drift alive past exitDelay', () => {
    const { trace } = run(establishedLeftDrift(), TUNING.drift.exitDelay * 2, () => inp({ handbrake: true, steer: 0.3 }));
    expect(trace.every((x) => x.mode === 'drift')).toBe(true);
  });

  it('a drift on the handbrake alone bleeds speed and ends below the minimum speed', () => {
    const { s, trace } = run(establishedLeftDrift(), 5, () => inp({ handbrake: true, steer: 1 }));
    for (let i = 1; i < trace.length; i++) expect(trace[i].speed).toBeLessThanOrEqual(trace[i - 1].speed + 1e-9);
    expect(s.mode).toBe('grip');
    expect(s.driftDir).toBe(0);
    expect(s.speed).toBeLessThan(TUNING.drift.minSpeed);
  });

  it('a right drift mirrors a left drift exactly', () => {
    const drive = (side: 1 | -1) => {
      let s = stepCar(cruising(22), inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }), 'road', DT);
      s = run(s, 1.5, (t) => inp({ throttle: 1, steer: side * (t < 0.7 ? 1 : -0.4) })).s;
      return s;
    };
    const left = drive(1);
    const right = drive(-1);
    expect(left.driftDir).toBe(1);
    expect(right.driftDir).toBe(-1);
    expect(right.x).toBeCloseTo(-left.x, 9);
    expect(right.z).toBeCloseTo(left.z, 9);
    expect(right.heading).toBeCloseTo(-left.heading, 9);
    expect(right.slip).toBeCloseTo(-left.slip, 9);
    expect(right.speed).toBeCloseTo(left.speed, 9);
  });

  it('a fast drift running onto runoff bleeds speed down to the cap without a jolt', () => {
    const cap = TUNING.drift.maxSpeedFactor * TUNING.surface.runoff.maxSpeed;
    let start = stepCar(cruising(TUNING.car.maxSpeed * 0.9), inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    start = run(start, 0.5, () => inp({ throttle: 1, steer: 0.3 })).s;
    expect(start.speed).toBeGreaterThan(cap + 5);
    const { trace } = run(start, 1.5, () => inp({ throttle: 1, steer: 1 }), 'runoff');
    let prev = start.speed;
    for (const s of trace) {
      expect(s.mode).toBe('drift');
      expect(prev - s.speed).toBeLessThan(0.5);
      if (prev > cap) expect(s.speed).toBeLessThanOrEqual(prev + 1e-9);
      prev = s.speed;
    }
    for (const s of trace.slice(Math.round(1 / DT))) expect(s.speed).toBeLessThanOrEqual(cap + 1e-9);
  });

  it('feathering the throttle keeps the drift alive (exit timer resets)', () => {
    const period = Math.round((TUNING.drift.exitDelay * 0.8) / DT) + 1;
    const throttleAt = (t: number) => (Math.round(t / DT) % period === period - 1 ? 1 : 0);
    const { trace } = run(establishedLeftDrift(), 2, (t) => inp({ steer: 0.3, throttle: throttleAt(t) }));
    expect(trace.every((x) => x.mode === 'drift')).toBe(true);
  });

  it('held Space with a counter-steer that is already across does not flick without a fresh press', () => {
    // Changed by the final review (flick-fails-space-first): Space held while the steer CROSSES over to
    // the opposite side now flicks (car.driftControls.test.ts). A counter-steer held before Space, with
    // the wheel already past -flickSteer, still needs a fresh press.
    // Held shorter than drift.catchTime: a longer full counter-steer would catch the slide.
    const across = run(establishedLeftDrift(), TUNING.drift.catchTime * 0.85, () => inp({ throttle: 1, steer: -1 })).s;
    expect(across.mode).toBe('drift');
    expect(across.steer).toBeLessThanOrEqual(-TUNING.drift.flickSteer);
    const { trace } = run(across, 0.3, () => inp({ throttle: 1, steer: -1, handbrake: true }));
    expect(trace.every((x) => x.mode === 'drift' && x.driftDir === 1)).toBe(true);
  });

  it('Space with zero steer never kicks, even with kickSteerThreshold 0', () => {
    const t0 = { ...TUNING, drift: { ...TUNING.drift, kickSteerThreshold: 0 } };
    const kick = inp({ throttle: 1, handbrake: true, handbrakePressed: true });
    const s = stepCar(cruising(20), kick, 'road', DT, t0);
    expect(s.mode).toBe('grip');
    expect(s.driftDir).toBe(0);
    expect(stepCar(cruising(20), { ...kick, steer: -0.05 }, 'road', DT, t0).driftDir).toBe(-1);
  });

  it('a flick never turns driftDir 0 into a direction', () => {
    const t0 = { ...TUNING, drift: { ...TUNING.drift, flickSteer: 0 } };
    const odd: CarState = { ...establishedLeftDrift(), driftDir: 0 };
    const s = stepCar(odd, inp({ throttle: 1, handbrake: true, handbrakePressed: true }), 'road', DT, t0);
    expect(s.driftDir).toBe(0);
  });

  it('throttle while rolling backwards brakes to a stop without overshooting', () => {
    const v0 = 5;
    const { trace } = run({ ...cruising(0), vz: -v0 }, 1, () => inp({ throttle: 1 }));
    const fs = trace.map((x) => x.forwardSpeed);
    for (let i = 1; i < fs.length; i++) expect(fs[i]).toBeGreaterThanOrEqual(fs[i - 1]);
    const stop = fs.findIndex((v) => v >= 0);
    expect(stop).toBeGreaterThan(0);
    // Changed by the final review (dead-throttle-after-crash): the step that reaches 0 drives forward for
    // the rest of the step, so it carries at most one step of engine acceleration (was: exactly 0).
    expect(fs[stop]).toBeLessThanOrEqual(TUNING.car.engineAccel * DT + 1e-9);
    expect(stop * DT).toBeLessThanOrEqual(v0 / TUNING.car.brakeDecel + 0.05);
    expect(fs[fs.length - 1]).toBeGreaterThan(0);
  });

  it('curb drives exactly like road; outside limits top speed', () => {
    const script = (t: number) => inp({ throttle: 1, steer: 1, handbrake: t < DT, handbrakePressed: t < DT });
    expect(run(cruising(20), 2, script, 'curb').s).toEqual(run(cruising(20), 2, script, 'road').s);
    const { trace } = run(createCarState(0, 0, 0), 10, () => inp({ throttle: 1 }), 'outside');
    for (const s of trace) expect(s.speed).toBeLessThanOrEqual(TUNING.surface.outside.maxSpeed + 0.5);
  });

  it('brake at standstill does not reverse before reverseDelay', () => {
    const { s } = run(createCarState(0, 0, 0), TUNING.car.reverseDelay * 0.8, () => inp({ brake: 1 }));
    expect(s.forwardSpeed).toBe(0);
    expect(s.reverseHold).toBeGreaterThan(0);
    const released = stepCar(s, inp(), 'road', DT);
    expect(released.reverseHold).toBe(0);
  });

  it('isDrifting is false in grip mode and for tiny slip angles', () => {
    const s = cruising(20);
    expect(isDrifting(s)).toBe(false);
    expect(isDrifting({ ...s, mode: 'drift', driftDir: 1, slip: TUNING.score.minSlip / 2 })).toBe(false);
    expect(isDrifting({ ...s, mode: 'drift', driftDir: 1, slip: TUNING.score.minSlip })).toBe(true);
  });

  it('carCapsule rotates with heading (+pi/2 faces +x)', () => {
    const c = carCapsule(createCarState(5, -3, Math.PI / 2));
    expect(c.ax).toBeCloseTo(5 + TUNING.car.capsuleHalf);
    expect(c.az).toBeCloseTo(-3);
    expect(c.bx).toBeCloseTo(5 - TUNING.car.capsuleHalf);
    expect(c.bz).toBeCloseTo(-3);
  });
});

describe('car physics: recovery after a heavy hit', () => {
  /** Recover state as collision.ts leaves it, with the given heading and velocity. */
  const recovering = (heading: number, vx: number, vz: number, gripBlend = 1): CarState => ({
    ...createCarState(0, 0, heading),
    vx,
    vz,
    gripBlend,
    mode: 'recover',
    modeTimer: TUNING.drift.recoverTime,
  });

  it('eases the body toward the velocity heading while sliding forward', () => {
    const a = 60 * DEG;
    const secs = TUNING.drift.recoverTime * 0.75;
    for (const gripBlend of [1, 0]) {
      const start = recovering(0, 12 * Math.sin(a), 12 * Math.cos(a), gripBlend);
      const rec = run(start, secs, () => inp()).s;
      const grip = run({ ...start, mode: 'grip', modeTimer: 0 }, secs, () => inp()).s;
      expect(rec.mode).toBe('recover');
      expect(rec.heading).toBeGreaterThan(10 * DEG);
      expect(Math.abs(grip.heading)).toBeLessThan(1e-9);
      expect(Math.abs(rec.slip)).toBeLessThan(Math.abs(grip.slip));
      expect(Math.abs(rec.slip)).toBeLessThan(a / 5);
    }
  });

  it('a backward bounce off a head-on hit does not spin the body', () => {
    const bounce = TUNING.collision.restitution * 20;
    for (const h0 of [0, 0.02, -0.02]) {
      for (const throttle of [0, 1]) {
        const { s, trace } = run(recovering(h0, 0, -bounce), TUNING.drift.recoverTime + 0.1, () => inp({ throttle }));
        expect(s.mode).toBe('grip');
        for (const x of trace) expect(Math.abs(x.heading - h0)).toBeLessThan(5 * DEG);
      }
    }
  });

  it('driftTime is 0 outside drift mode', () => {
    const s = stepCar({ ...recovering(0, 0, 10), driftTime: 1.5 }, inp(), 'road', DT);
    expect(s.driftTime).toBe(0);
  });
});
