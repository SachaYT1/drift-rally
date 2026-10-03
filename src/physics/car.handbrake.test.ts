/**
 * The handbrake bleeds speed and cannot sustain a drift (design spec §2.3, player test-drive 2026-10-03: "you can
 * just hold Space and drift forever"). Space held locks the rear wheels: a tighter arc and a little more angle,
 * but no engine drive and a strong deceleration, so holding it ends the drift through the low-speed exit; only
 * throttle sustains a drift. Short taps (the kick, a tighten tap, a flick) stay cheap.
 */
import { describe, expect, it } from 'vitest';
import { createCarState, stepCar, withDerived } from './car';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type CarState, type InputFrame } from '../shared/types';
import { wrapAngle } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const D = TUNING.drift;
const inp = (p: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...p });
const steps = (seconds: number): number => Math.round(seconds / DT);
const velHeading = (s: CarState): number => Math.atan2(s.vx, s.vz);
const last = (t: CarState[]): CarState => t[t.length - 1];
/** The drift ends below this speed (the low-speed exit). */
const EXIT_SPEED = D.minSpeed * D.holdSpeedFactor;

/** Runs `n` steps feeding input(i); returns every resulting state. */
function trace(start: CarState, n: number, input: (i: number) => InputFrame): CarState[] {
  const out: CarState[] = [];
  let s = start;
  for (let i = 0; i < n; i++) {
    s = stepCar(s, input(i), 'road', DT);
    out.push(s);
  }
  return out;
}

/** Grip car at heading 0 cruising at `v` m/s. */
const cruising = (v: number): CarState => withDerived({ ...createCarState(0, 0, 0), vz: v });

/** A `side` drift (+1 = left) established on W with steer 0.3 into it, then set to `speed` m/s (pose kept). */
function drift(side: 1 | -1, speed = 25): CarState {
  const kick = stepCar(cruising(22), inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }), 'road', DT);
  const s = last(trace(kick, steps(0.6), () => inp({ throttle: 1, steer: 0.3 * side })));
  const k = speed / s.speed;
  return withDerived({ ...s, vx: s.vx * k, vz: s.vz * k });
}

/** Velocity-heading change per metre travelled over a trace, relative to `side` (+ = into the drift), 1/m. */
function pathCurvature(start: CarState, t: CarState[], side: 1 | -1): number {
  let metres = 0;
  let prev = start;
  for (const s of t) {
    metres += prev.speed * DT;
    prev = s;
  }
  return (wrapAngle(velHeading(last(t)) - velHeading(start)) / metres) * side;
}

describe('car physics: Space held in a drift bleeds speed', () => {
  it('cuts the engine drive: with Space held, W makes no difference to the speed', () => {
    for (const side of [1, -1] as const) {
      const s = drift(side);
      const onW = stepCar(s, inp({ throttle: 1, steer: 0.3 * side, handbrake: true }), 'road', DT);
      const offW = stepCar(s, inp({ throttle: 0, steer: 0.3 * side, handbrake: true }), 'road', DT);
      const free = stepCar(s, inp({ throttle: 1, steer: 0.3 * side }), 'road', DT);
      expect(onW.mode).toBe('drift');
      expect(onW.speed).toBeCloseTo(offW.speed, 12);
      expect(free.speed - onW.speed).toBeGreaterThan(D.handbrakeDecel * DT);
    }
  });

  it('holding W + Space from 25 m/s ends the drift through the low-speed exit in 1.5-2 s, whatever the steer', () => {
    for (const side of [1, -1] as const) {
      // Counter-steer short of flickSteer: Space held while the steer crosses past it flicks instead.
      for (const u of [-0.5, 0, 0.3, 1]) {
        const label = `side ${side}, steer ${u}`;
        const start = drift(side);
        const hold = () => inp({ throttle: 1, steer: u * side, handbrake: true });
        const t = trace(start, steps(2.5), hold);
        const exit = t.findIndex((s) => s.mode !== 'drift');
        expect(exit, label).toBeGreaterThan(0);
        expect(exit * DT, label).toBeGreaterThanOrEqual(1.5);
        expect(exit * DT, label).toBeLessThanOrEqual(2);
        // The low-speed exit: no lift timer (W held) and no catch (Space held) ended it.
        expect(t[exit - 1].speed, label).toBeLessThan(EXIT_SPEED);
        expect(t.slice(0, exit).every((s) => s.mode === 'drift' && s.driftDir === side), label).toBe(true);
        let prev = start;
        for (const s of t) {
          expect(s.speed, label).toBeLessThanOrEqual(prev.speed);
          prev = s;
        }
        // Still on W + Space + steer: no re-kick below the drift speed, the handbrake keeps slowing the car.
        expect(t.slice(exit).every((s) => s.mode === 'grip'), label).toBe(true);
        expect(last(t).speed, label).toBeLessThan(t[exit].speed - 1);
      }
    }
  });

  it('only throttle sustains a drift: Space held without W ends it exitDelay after the lift', () => {
    for (const side of [1, -1] as const) {
      for (const liftAt of [0, steps(0.2)]) {
        // W + Space until liftAt, then Space alone.
        const t = trace(drift(side), steps(1), (i) => inp({ throttle: i < liftAt ? 1 : 0, steer: 0.3 * side, handbrake: true }));
        const exit = t.findIndex((s) => s.mode !== 'drift');
        const label = `side ${side}, lift at ${liftAt}`;
        expect(exit, label).toBeGreaterThan(-1);
        expect((exit + 1 - liftAt) * DT, label).toBeGreaterThanOrEqual(D.exitDelay - 1e-9);
        expect((exit + 1 - liftAt) * DT, label).toBeLessThanOrEqual(D.exitDelay + DT + 1e-9);
        expect(t[exit - 1].speed, label).toBeGreaterThan(D.minSpeed);
        // The held Space does not kick the next drift at once (that loop would sustain the slide without W).
        expect(t.slice(exit).every((s) => s.mode === 'grip'), label).toBe(true);
      }
    }
  });

  it('a fresh Space press without W still kicks a short handbrake turn that ends exitDelay later', () => {
    const t = trace(cruising(20), steps(1), (i) => inp({ steer: 1, handbrake: true, handbrakePressed: i === 0 }));
    expect(t[0].mode).toBe('drift');
    // The lift timer starts on the step after the kick.
    const exit = t.findIndex((s) => s.mode !== 'drift');
    expect(exit * DT).toBeGreaterThanOrEqual(D.exitDelay - 1e-9);
    expect(exit * DT).toBeLessThanOrEqual(D.exitDelay + DT + 1e-9);
    expect(t.slice(exit).every((s) => s.mode === 'grip')).toBe(true);
  });
});

describe('car physics: short Space taps stay cheap', () => {
  it('a 0.2 s tighten tap on W costs a little speed, tightens the line and keeps the drift', () => {
    for (const side of [1, -1] as const) {
      const start = drift(side);
      const tap = steps(0.2);
      const steer = 0.3 * side;
      const tapped = trace(start, steps(2), (i) => inp({ throttle: 1, steer, handbrake: i < tap, handbrakePressed: i === 0 }));
      const free = trace(start, steps(2), () => inp({ throttle: 1, steer }));
      expect(tapped.every((s) => s.mode === 'drift' && s.driftDir === side)).toBe(true);
      const lost = free[tap - 1].speed - tapped[tap - 1].speed;
      expect(lost).toBeGreaterThan(0);
      // A little: under 3 m/s (~11 km/h) from 25 m/s.
      expect(lost).toBeLessThan(3);
      // Tighter: more heading change per metre during the tap.
      const k = (t: CarState[]) => pathCurvature(start, t.slice(0, tap), side);
      expect(k(tapped)).toBeGreaterThan(k(free) * 1.1);
      // W wins the speed back afterwards: the drift accelerates again once Space is up.
      expect(last(tapped).speed).toBeGreaterThan(tapped[tap - 1].speed);
    }
  });

  it('a kick tap (0.15 s) starts a drift that W then holds', () => {
    for (const side of [1, -1] as const) {
      const tap = steps(0.15);
      const t = trace(cruising(22), steps(3), (i) => inp({ throttle: 1, steer: side, handbrake: i < tap, handbrakePressed: i === 0 }));
      expect(t.every((s) => s.mode === 'drift' && s.driftDir === side)).toBe(true);
      expect(last(t).speed).toBeGreaterThan(18);
    }
  });

  it('a slalom of tapped flicks on W keeps the drift alive and the speed up', () => {
    // Space tapped 0.15 s with the opposite key every 0.8 s, five times: the chain stays alive.
    for (const side of [1, -1] as const) {
      const period = steps(0.8);
      const tap = steps(0.15);
      const dirAt = (i: number): number => (Math.floor(i / period) % 2 === 0 ? -side : side);
      const t = trace(drift(side, 22), period * 5, (i) =>
        inp({ throttle: 1, steer: dirAt(i), handbrake: i % period < tap, handbrakePressed: i % period === 0 }),
      );
      expect(t.every((s) => s.mode === 'drift')).toBe(true);
      expect(last(t).driftDir).toBe(-side);
      expect(Math.min(...t.map((s) => s.speed))).toBeGreaterThan(15);
    }
  });
});

describe('car physics: Space held in grip', () => {
  it('cuts the engine and brakes lightly below the drift speed (no free slide, no re-kick loop)', () => {
    const start = cruising(D.minSpeed - 1);
    const t = trace(start, steps(1), () => inp({ throttle: 1, steer: 1, handbrake: true }));
    let prev = start;
    for (const s of t) {
      expect(s.mode).toBe('grip');
      expect(s.speed).toBeLessThan(prev.speed);
      prev = s;
    }
    // Space up: W drives again.
    const go = trace(last(t), steps(0.5), () => inp({ throttle: 1, steer: 1 }));
    expect(last(go).speed).toBeGreaterThan(last(t).speed);
  });

  it('Space held on a straight at speed (no steer, so no kick) cuts the engine and slows the car', () => {
    const t = trace(cruising(20), steps(1), () => inp({ throttle: 1, handbrake: true }));
    expect(t.every((s) => s.mode === 'grip')).toBe(true);
    const lost = 20 - last(t).speed;
    expect(lost).toBeGreaterThan(D.handbrakeGripDecel * 0.9);
    // Light braking: well short of the foot brake.
    expect(lost).toBeLessThan(TUNING.car.brakeDecel / 2);
  });
});
