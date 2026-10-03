/**
 * Drift controls from the final review: flick timing (Space slightly before the opposite steer, or held
 * while the steer crosses over), braking out of a drift with S, full counter-steer widening the line (a slight
 * outward path curvature), and catching the slide by holding full counter-steer (design spec §2.3).
 */
import { describe, expect, it } from 'vitest';
import { createCarState, isDrifting, stepCar, withDerived } from './car';
import { TUNING, type Tuning } from '../shared/tuning';
import { NEUTRAL_INPUT, type CarState, type InputFrame } from '../shared/types';
import { wrapAngle } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const D = TUNING.drift;
const inp = (p: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...p });
/** Whole fixed steps in `seconds`. */
const steps = (seconds: number): number => Math.round(seconds / DT);

/** Runs `n` steps feeding input(i) at step i; returns every resulting state. */
function trace(start: CarState, n: number, input: (i: number) => InputFrame, t: Tuning = TUNING): CarState[] {
  const out: CarState[] = [];
  let s = start;
  for (let i = 0; i < n; i++) {
    s = stepCar(s, input(i), 'road', DT, t);
    out.push(s);
  }
  return out;
}
const last = (t: CarState[]): CarState => t[t.length - 1];

/** Grip car at heading 0 cruising at `v` m/s. */
const cruising = (v: number): CarState => withDerived({ ...createCarState(0, 0, 0), vz: v });

/** A drift toward `side` (+1 = left) established for 0.6 s at ~22 m/s; Space released, steer 0.3 into it. */
function drift(side: 1 | -1): CarState {
  const kick = stepCar(cruising(22), inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }), 'road', DT);
  return last(trace(kick, steps(0.6), () => inp({ throttle: 1, steer: 0.3 * side })));
}

/**
 * A flick gesture in a `side` drift, as step indices: Space held on [spaceDown, spaceUp) and pressed on
 * spaceDown (unless `noPress`: Space was already held), steer swapped to full opposite from steerAt on.
 * Throttle held throughout.
 */
function gesture(side: 1 | -1, g: { spaceDown: number; spaceUp: number; steerAt: number; noPress?: boolean }) {
  return (i: number): InputFrame =>
    inp({
      throttle: 1,
      steer: i >= g.steerAt ? -side : 0.3 * side,
      handbrake: i >= g.spaceDown && i < g.spaceUp,
      handbrakePressed: !g.noPress && i === g.spaceDown,
    });
}

/** Index of the first state whose driftDir differs from `dir`, or -1. */
const flipIndex = (t: CarState[], dir: number): number => t.findIndex((s) => s.driftDir !== dir);

describe('car physics: flick timing', () => {
  it('Space pressed 60 ms before the opposite steer flicks, whether tapped or held', () => {
    for (const side of [1, -1] as const) {
      for (const spaceUp of [steps(0.03), steps(0.5)]) {
        const steerAt = steps(0.06);
        const t = trace(drift(side), steps(0.5), gesture(side, { spaceDown: 0, spaceUp, steerAt }));
        expect(flipIndex(t, side)).toBe(steerAt);
        expect(t.every((s) => s.mode === 'drift')).toBe(true);
        expect(last(t).driftDir).toBe(-side);
      }
    }
  });

  it('the opposite steer before the Space press still flicks on the press', () => {
    for (const side of [1, -1] as const) {
      const spaceDown = steps(0.04);
      const t = trace(drift(side), steps(0.3), gesture(side, { spaceDown, spaceUp: steps(0.1), steerAt: 0 }));
      expect(flipIndex(t, side)).toBe(spaceDown);
      expect(last(t).driftDir).toBe(-side);
    }
  });

  it('a Space tap older than flickWindow does not flick', () => {
    const steerAt = steps(D.flickWindow + 0.03);
    const t = trace(drift(1), steps(0.5), gesture(1, { spaceDown: 0, spaceUp: steps(0.03), steerAt }));
    // The full counter-steer then catches the slide (catchTime later) instead: never a flipped drift.
    expect(t.every((s) => s.driftDir !== -1)).toBe(true);
    expect(t.slice(0, steerAt + steps(D.catchTime) - 1).every((s) => s.mode === 'drift' && s.driftDir === 1)).toBe(true);
  });

  it('holding Space while the steer crosses over to the opposite side flicks', () => {
    for (const side of [1, -1] as const) {
      const steerAt = steps(0.3);
      const t = trace(drift(side), steps(0.6), gesture(side, { spaceDown: 0, spaceUp: steps(1), steerAt, noPress: true }));
      expect(flipIndex(t, side)).toBe(steerAt);
      expect(last(t).driftDir).toBe(-side);
    }
  });

  it('one Space press flicks once: swapping back inside the window does not flick again', () => {
    // Shorter than 0.08 s + catchTime: the swapped-back steer is a full counter-steer to the new drift.
    const t = trace(drift(1), steps(0.08 + D.catchTime * 0.9), (i) =>
      inp({ throttle: 1, steer: i < steps(0.03) ? 0.3 : i < steps(0.08) ? -1 : 1, handbrake: i < 2, handbrakePressed: i === 0 }),
    );
    expect(flipIndex(t, 1)).toBe(steps(0.03));
    expect(t.slice(steps(0.03)).every((s) => s.mode === 'drift' && s.driftDir === -1)).toBe(true);
  });

  it('the Space press that kicks a drift does not also arm a flick', () => {
    const t = trace(cruising(20), steps(0.3), (i) =>
      inp({ throttle: 1, steer: i < steps(0.05) ? 1 : -1, handbrake: i < 2, handbrakePressed: i === 0 }),
    );
    expect(t[0].mode).toBe('drift');
    expect(t.every((s) => s.mode === 'drift' && s.driftDir === 1)).toBe(true);
  });
});

describe('car physics: braking out of a drift', () => {
  it('S scrubs drift speed at brakeFactor times car.brakeDecel', () => {
    const s = drift(1);
    const free = stepCar(s, inp({ throttle: 1, steer: 0.3 }), 'road', DT);
    const braked = stepCar(s, inp({ throttle: 1, steer: 0.3, brake: 1 }), 'road', DT);
    expect(braked.mode).toBe('drift');
    expect(free.speed - braked.speed).toBeCloseTo(D.brakeFactor * TUNING.car.brakeDecel * DT, 9);
  });

  it('holding S ends the drift after brakeExitTime (even with W and Space held), grip blends in smoothly', () => {
    for (const hold of [inp({ brake: 1, steer: 0.3 }), inp({ brake: 1, throttle: 1, handbrake: true, steer: 1 })]) {
      const start = drift(1);
      const t = trace(start, steps(0.5), () => hold);
      const exitIdx = t.findIndex((s) => s.mode === 'grip');
      expect(exitIdx).toBeGreaterThan(-1);
      expect((exitIdx + 1) * DT).toBeGreaterThanOrEqual(D.brakeExitTime - 1e-9);
      expect((exitIdx + 1) * DT).toBeLessThanOrEqual(D.brakeExitTime + DT + 1e-9);
      expect(t[exitIdx].gripBlend).toBeLessThan(0.1);
      // Still braking with Space and steer held: no re-kick, and no lateral jolt.
      expect(t.slice(exitIdx).every((s) => s.mode === 'grip')).toBe(true);
      let prev = start;
      for (const s of t) {
        expect(Math.abs(s.lateralSpeed - prev.lateralSpeed)).toBeLessThan(0.6);
        expect(s.speed).toBeLessThan(prev.speed);
        prev = s;
      }
    }
  });

  it('a short S tap keeps the drift', () => {
    const tap = steps(D.brakeExitTime * 0.6);
    const t = trace(drift(1), steps(0.6), (i) => inp({ throttle: 1, steer: 0.3, brake: i < tap ? 1 : 0 }));
    expect(t.every((s) => s.mode === 'drift' && s.driftDir === 1)).toBe(true);
  });

  it('Space does not kick a drift while S is held', () => {
    const s = stepCar(cruising(20), inp({ brake: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    expect(s.mode).toBe('grip');
    expect(s.driftDir).toBe(0);
  });
});

describe('car physics: drift path control', () => {
  /** The catch disabled: full counter-steer can be held for as long as these path checks need. */
  const NO_CATCH: Tuning = { ...TUNING, drift: { ...D, catchTime: Infinity } };

  /** Velocity-heading change over `seconds` after `settle` s of holding `steer` (relative) in a `side` drift. */
  function pathTurn(side: 1 | -1, steer: number, settle: number, seconds: number): { turn: number; t: CarState[] } {
    const t = trace(drift(side), steps(settle + seconds), () => inp({ throttle: 1, steer: steer * side }), NO_CATCH);
    const a = t[steps(settle) - 1];
    const b = last(t);
    return { turn: wrapAngle(Math.atan2(b.vx, b.vz) - Math.atan2(a.vx, a.vz)) * side, t: t.slice(steps(settle)) };
  }

  it('full counter-steer widens the line: the path bends slightly outward while the car keeps sliding (until it catches)', () => {
    // A line that is too tight can be opened up again (player test-drive: at zero curvature it never could).
    for (const side of [1, -1] as const) {
      const { turn, t } = pathTurn(side, -1, 0.6, 1);
      expect(turn).toBeLessThan(-2 * (Math.PI / 180));
      expect(turn).toBeGreaterThan(-15 * (Math.PI / 180));
      for (const s of t) {
        expect(s.mode).toBe('drift');
        expect(s.driftDir).toBe(side);
        expect(isDrifting(s)).toBe(true);
        expect(Math.sign(s.slip)).toBe(side);
      }
    }
  });

  it('path curvature orders into > neutral > 0 > full counter', () => {
    const into = pathTurn(1, 1, 0.6, 1).turn;
    const neutral = pathTurn(1, 0, 0.6, 1).turn;
    const counter = pathTurn(1, -1, 0.6, 1).turn;
    expect(into).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(0);
    expect(counter).toBeLessThan(0);
  });

  it('Space held tightens the arc (handbrakeCurvBoost)', () => {
    for (const u of [0, 1]) {
      const free = trace(drift(1), steps(1), () => inp({ throttle: 1, steer: u }));
      const space = trace(drift(1), steps(1), () => inp({ throttle: 1, steer: u, handbrake: true }));
      const turn = (t: CarState[]) => wrapAngle(Math.atan2(last(t).vx, last(t).vz) - Math.atan2(t[0].vx, t[0].vz));
      expect(turn(space), `u ${u}`).toBeGreaterThan(turn(free) * 1.1);
    }
  });
});

describe('car physics: catching the slide', () => {
  /** Step index at which a `side` drift ends while `input(i)` is fed, or -1. */
  const exitIndex = (side: 1 | -1, seconds: number, input: (i: number) => InputFrame): number =>
    trace(drift(side), steps(seconds), input).findIndex((s) => s.mode !== 'drift');

  /** First index whose WHEEL (smoothed steer) is at full counter-steer in a `side` drift, or -1. */
  const wheelFullCounter = (t: CarState[], side: 1 | -1): number => t.findIndex((s) => s.steer * side <= -D.catchSteer);

  it('the wheel held at full counter-steer for catchTime ends the drift (W held), both directions', () => {
    for (const side of [1, -1] as const) {
      const t = trace(drift(side), steps(1.5), () => inp({ throttle: 1, steer: -side }));
      const full = wheelFullCounter(t, side);
      const exit = t.findIndex((s) => s.mode !== 'drift');
      expect(full).toBeGreaterThan(0);
      expect((exit - full + 1) * DT).toBeGreaterThanOrEqual(D.catchTime - 1e-9);
      expect((exit - full + 1) * DT).toBeLessThanOrEqual(D.catchTime + DT + 1e-9);
      expect(t[exit]).toMatchObject({ mode: 'grip', driftDir: 0, driftTime: 0 });
      // Caught for good: W and the counter-steer still held, but no new drift without Space.
      expect(t.slice(exit).every((s) => s.mode === 'grip')).toBe(true);
    }
  });

  it('a keyboard counter-steer widens the path before it catches, from into-steer too (spec §2.3)', () => {
    // Digital keys: the wheel needs time to swing across, and the path curvature follows the wheel. The
    // catch waits for the wheel, so the car first slides with the path bending slightly outward.
    for (const side of [1, -1] as const) {
      for (const pre of [0, 1]) {
        const kick = stepCar(cruising(22), inp({ throttle: 1, steer: side, handbrake: true, handbrakePressed: true }), 'road', DT);
        const settled = last(trace(kick, steps(0.6), () => inp({ throttle: 1, steer: pre * side })));
        const t = trace(settled, steps(1.5), () => inp({ throttle: 1, steer: -side }));
        const exit = t.findIndex((s) => s.mode !== 'drift');
        const full = wheelFullCounter(t, side);
        expect(full, `pre ${pre}`).toBeGreaterThan(0);
        expect(exit, `pre ${pre}`).toBeGreaterThan(full);
        // The last catchTime before the catch: the path turns outward (never into the drift), a few degrees at
        // most, still sliding.
        const a = t[exit - steps(D.catchTime) + 1];
        const b = t[exit - 1];
        const turn = wrapAngle(Math.atan2(b.vx, b.vz) - Math.atan2(a.vx, a.vz)) * side;
        expect(turn, `pre ${pre}`).toBeLessThan(0);
        expect(turn, `pre ${pre}`).toBeGreaterThan(-5 * (Math.PI / 180));
        expect(Math.abs(b.slip), `pre ${pre}`).toBeGreaterThan(TUNING.score.minSlip);
      }
    }
  });

  it('a counter-steer tap, then Space with the key still held, flicks: no catch and no re-kick', () => {
    // A player straightening the line with a counter tap decides to flick: the counter key is already down
    // (0.25 s), Space follows a reaction later. The car must stay in drift and flip on the press.
    for (const side of [1, -1] as const) {
      const spaceAt = steps(0.25 + 0.12);
      const t = trace(drift(side), steps(0.8), (i) =>
        inp({ throttle: 1, steer: -side, handbrake: i >= spaceAt && i < spaceAt + steps(0.1), handbrakePressed: i === spaceAt }),
      );
      expect(t.every((s) => s.mode === 'drift')).toBe(true);
      expect(flipIndex(t, side)).toBe(spaceAt);
      expect(last(t).driftDir).toBe(-side);
    }
  });

  it('counter-steer short of catchSteer keeps drifting', () => {
    for (const side of [1, -1] as const) {
      for (const u of [0.3, 0.6, D.catchSteer - 0.02]) {
        expect(exitIndex(side, 2, () => inp({ throttle: 1, steer: -u * side })), `u ${u}`).toBe(-1);
      }
    }
  });

  it('tapping full counter-steer shorter than catchTime keeps drifting (the hold restarts)', () => {
    const on = steps(D.catchTime * 0.8);
    const period = on + steps(0.05);
    expect(exitIndex(1, 2, (i) => inp({ throttle: 1, steer: i % period < on ? -1 : 0.3 }))).toBe(-1);
  });

  it('Space held keeps the slide: a held counter-steer does not catch', () => {
    // The counter-steer is already across before Space goes down, so there is no flick either.
    const across = trace(drift(1), steps(D.catchTime * 0.85), () => inp({ throttle: 1, steer: -1 }));
    expect(last(across).mode).toBe('drift');
    const t = trace(last(across), steps(1), () => inp({ throttle: 1, steer: -1, handbrake: true }));
    expect(t.every((s) => s.mode === 'drift' && s.driftDir === 1)).toBe(true);
  });

  it('a flick restarts the catch hold in the new direction', () => {
    // Counter-steer just short of a catch, then flick: the same key is now INTO the new drift.
    const t = trace(drift(1), steps(1), (i) =>
      inp({ throttle: 1, steer: -1, handbrake: i === steps(D.catchTime * 0.8), handbrakePressed: i === steps(D.catchTime * 0.8) }),
    );
    expect(t.every((s) => s.mode === 'drift')).toBe(true);
    expect(last(t).driftDir).toBe(-1);
    expect(last(t).catchTimer).toBe(0);
  });
});
