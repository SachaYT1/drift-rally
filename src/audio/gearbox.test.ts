import { describe, expect, it } from 'vitest';
import {
  engineRev,
  gearRev,
  initialGearbox,
  selectGear,
  stepGearbox,
  type GearboxConfig,
  type GearboxState,
} from './gearbox';
import { ENGINE_PRESETS } from './enginePresets';
import { TUNING } from '../shared/tuning';

const PRESETS = Object.values(ENGINE_PRESETS);
const A: GearboxConfig = ENGINE_PRESETS.A.gearbox;
const MAX = TUNING.car.maxSpeed;
const DT = 1 / 120;

interface Trace { speed: number; gear: number; rev: number; shift: number; revBefore: number }

/** Drives the gearbox through a speed profile; records the rev the old gear would have had at each step. */
function drive(cfg: GearboxConfig, speeds: number[], throttle: number, drifting = false): Trace[] {
  let s: GearboxState = initialGearbox(cfg);
  return speeds.map((speed) => {
    const revBefore = engineRev(speed, s.gear, throttle, s.flare, cfg);
    const r = stepGearbox(s, { speed, throttle, drifting }, DT, cfg);
    s = r.state;
    return { speed, gear: s.gear, rev: s.rev, shift: r.shift, revBefore };
  });
}

const ramp = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  const n = Math.round(Math.abs(to - from) / step);
  for (let i = 0; i <= n; i++) out.push(from + ((to - from) * i) / n);
  return out;
};

describe('virtual gearbox (audio only)', () => {
  it('starts in first gear at idle', () => {
    for (const p of PRESETS) {
      const s = initialGearbox(p.gearbox);
      expect(s.gear).toBe(1);
      expect(s.rev).toBeCloseTo(p.gearbox.idleRev);
      expect(s.flare).toBe(0);
    }
  });

  it('rev rises monotonically with speed inside every gear', () => {
    for (const p of PRESETS) {
      const g = p.gearbox;
      for (let gear = 1; gear <= g.gearTops.length; gear++) {
        let prev = -Infinity;
        for (let v = 0; v <= MAX; v += 0.25) {
          const r = engineRev(v, gear, 1, 0, g);
          expect(r).toBeGreaterThanOrEqual(prev);
          prev = r;
        }
        expect(gearRev(MAX * 0.5, gear, g)).toBeGreaterThan(gearRev(MAX * 0.25, gear, g));
      }
    }
  });

  it('full-throttle 0 -> max up-shifts through every gear, dropping 30-40 % each time', () => {
    for (const p of PRESETS) {
      const t = drive(p.gearbox, ramp(0, MAX, 0.02), 1);
      const ups = t.filter((x) => x.shift === 1);
      expect(ups).toHaveLength(p.gearbox.gearTops.length - 1);
      expect(t.some((x) => x.shift === -1)).toBe(false);
      for (const u of ups) {
        const drop = 1 - u.rev / u.revBefore;
        expect(drop).toBeGreaterThanOrEqual(0.3);
        expect(drop).toBeLessThanOrEqual(0.4);
        expect(u.revBefore).toBeGreaterThanOrEqual(p.gearbox.upshiftRev - 0.01);
      }
      // Between shifts the rev only climbs: a saw-tooth, not one long glide.
      for (let i = 1; i < t.length; i++) if (t[i].shift === 0) expect(t[i].rev).toBeGreaterThanOrEqual(t[i - 1].rev - 1e-9);
      expect(t.at(-1)?.gear).toBe(p.gearbox.gearTops.length);
    }
  });

  it('the spec shift points sit near 9 / 14 / 21 / 30 m/s for the shipped preset', () => {
    const ups = drive(A, ramp(0, MAX, 0.02), 1).filter((x) => x.shift === 1).map((x) => x.speed);
    const want = [9, 14, 21, 30.5];
    ups.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(0.5));
  });

  it('down-shifts when slowing (rev jumps up) and never hunts around a shift point', () => {
    for (const p of PRESETS) {
      const g = p.gearbox;
      const down = drive(g, [...ramp(0, MAX, 0.02), ...ramp(MAX, 0, 0.02)], 0).slice(Math.round(MAX / 0.02) + 1);
      const downs = down.filter((x) => x.shift === -1);
      expect(downs).toHaveLength(g.gearTops.length - 1);
      for (const d of downs) expect(d.rev).toBeGreaterThan(d.revBefore);
      expect(down.at(-1)?.gear).toBe(1);
      // Speed dithering around each up-shift point: one shift, no flapping.
      for (let gear = 1; gear < g.gearTops.length; gear++) {
        const v = g.upshiftRev * g.gearTops[gear - 1] * MAX;
        const wobble = Array.from({ length: 200 }, (_, i) => v + (i % 2 ? 0.3 : -0.3));
        let s: GearboxState = { ...initialGearbox(g), gear };
        let shifts = 0;
        for (const speed of wobble) {
          const r = stepGearbox(s, { speed, throttle: 1, drifting: false }, DT, g);
          s = r.state;
          shifts += Math.abs(r.shift);
        }
        expect(shifts).toBe(1);
      }
    }
  });

  it('an up-shift holds the rev at the new gear for the clutch time, then follows the speed again', () => {
    for (const p of PRESETS) {
      const g = p.gearbox;
      const vShift = g.upshiftRev * g.gearTops[0] * MAX * 1.001;
      let s: GearboxState = initialGearbox(g);
      s = stepGearbox(s, { speed: vShift * 0.99, throttle: 1, drifting: false }, DT, g).state;
      const r = stepGearbox(s, { speed: vShift, throttle: 1, drifting: false }, DT, g);
      expect(r.shift).toBe(1);
      expect(r.state.clutch).toBeCloseTo(g.shiftTime);
      const held = r.state.rev;
      s = r.state;
      let t = 0;
      let speed = vShift;
      // Speed keeps rising during the shift, the rev does not.
      while (t + DT < g.shiftTime - 1e-9) {
        speed += 0.1;
        s = stepGearbox(s, { speed, throttle: 1, drifting: false }, DT, g).state;
        t += DT;
        expect(s.rev).toBeCloseTo(held, 9);
        expect(s.clutch).toBeGreaterThan(0);
      }
      for (let i = 0; i < 3; i++) s = stepGearbox(s, { speed: (speed += 0.1), throttle: 1, drifting: false }, DT, g).state;
      expect(s.clutch).toBe(0);
      expect(s.rev).toBeCloseTo(engineRev(speed, 2, 1, 0, g), 9);
      expect(s.rev).toBeGreaterThan(held);
    }
  });

  it('a speed jump (respawn) lands in the right gear at once', () => {
    const s = { ...initialGearbox(A), gear: 5 };
    expect(selectGear(0, 5, A)).toBe(1);
    expect(selectGear(MAX, 1, A)).toBe(A.gearTops.length);
    expect(stepGearbox(s, { speed: 0, throttle: 0, drifting: false }, DT, A).state.gear).toBe(1);
  });

  it('first gear slips the clutch: throttle at standstill revs above idle, idle without throttle', () => {
    for (const p of PRESETS) {
      const g = p.gearbox;
      expect(engineRev(0, 1, 0, 0, g)).toBeCloseTo(g.idleRev);
      expect(engineRev(0, 1, 1, 0, g)).toBeCloseTo(g.launchRev);
      expect(engineRev(0, 1, 0.5, 0, g)).toBeGreaterThan(g.idleRev);
      expect(engineRev(0, 1, 0.5, 0, g)).toBeLessThan(g.launchRev);
      // Never below idle in any gear.
      for (let gear = 1; gear <= g.gearTops.length; gear++) expect(engineRev(0.5, gear, 0, 0, g)).toBeGreaterThanOrEqual(g.idleRev);
    }
  });

  it('drifting with throttle flares the rev smoothly by 10-20 %, capped by the limiter', () => {
    for (const p of PRESETS) {
      const g = p.gearbox;
      expect(g.driftFlare).toBeGreaterThanOrEqual(0.1);
      expect(g.driftFlare).toBeLessThanOrEqual(0.2);
      const speed = 0.7 * g.gearTops[2] * MAX;
      let s: GearboxState = { ...initialGearbox(g), gear: 3 };
      const base = engineRev(speed, 3, 1, 0, g);
      s = stepGearbox(s, { speed, throttle: 1, drifting: true }, DT, g).state;
      expect(s.rev).toBeGreaterThan(base);
      expect(s.rev).toBeLessThan(base * (1 + g.driftFlare * 0.5)); // smoothed, not a jump
      for (let i = 0; i < 240; i++) s = stepGearbox(s, { speed, throttle: 1, drifting: true }, DT, g).state;
      expect(s.rev / base).toBeCloseTo(1 + g.driftFlare, 2);
      // No flare without throttle; back down when the drift ends.
      let off = s;
      for (let i = 0; i < 240; i++) off = stepGearbox(off, { speed, throttle: 1, drifting: false }, DT, g).state;
      expect(off.rev).toBeCloseTo(base, 3);
      let lift = s;
      for (let i = 0; i < 240; i++) lift = stepGearbox(lift, { speed, throttle: 0, drifting: true }, DT, g).state;
      expect(lift.flare).toBeLessThan(0.01);
      // Flare near the top of a gear stops at the limiter.
      const top = { ...initialGearbox(g), gear: 2, flare: g.driftFlare };
      expect(engineRev(g.upshiftRev * g.gearTops[1] * MAX * 0.999, 2, 1, g.driftFlare, g)).toBeLessThanOrEqual(g.revLimit);
      expect(stepGearbox(top, { speed: 0.9 * g.gearTops[1] * MAX, throttle: 1, drifting: true }, DT, g).state.rev).toBeLessThanOrEqual(g.revLimit);
    }
  });

  it('non-finite input never escapes', () => {
    const s = stepGearbox(initialGearbox(A), { speed: NaN, throttle: Infinity, drifting: true }, NaN, A).state;
    expect([s.gear, s.rev, s.flare, s.clutch, s.held].every(Number.isFinite)).toBe(true);
    const t = stepGearbox(s, { speed: -Infinity, throttle: NaN, drifting: false }, -1, A).state;
    expect([t.gear, t.rev, t.flare, t.clutch, t.held].every(Number.isFinite)).toBe(true);
    expect(t.gear).toBe(1);
  });
});
