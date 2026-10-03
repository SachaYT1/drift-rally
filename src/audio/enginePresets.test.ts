import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE_PRESET,
  ENGINE_PRESETS,
  engineCutoff,
  engineDrive,
  engineLevel,
  engineLump,
  enginePitch,
  idleWobbleCents,
  revProgress,
  rumbleLevel,
  throttleLoad,
  type EnginePreset,
} from './enginePresets';
import { engineRev } from './gearbox';
import { TUNING } from '../shared/tuning';

const PRESETS: [string, EnginePreset][] = Object.entries(ENGINE_PRESETS);
const A = ENGINE_PRESETS.A;
const db = (a: number, b: number): number => 20 * Math.log10(a / b);
const steps = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

/** Rev halfway between idle and the redline. */
const midRev = (p: EnginePreset): number => (p.gearbox.idleRev + 1) / 2;

describe('engine presets', () => {
  it('the game ships preset A; every preset has a caption for the sound lab', () => {
    expect(DEFAULT_ENGINE_PRESET).toBe(A);
    for (const [key, p] of PRESETS) {
      expect(p.id).toBe(key);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.caption.length).toBeGreaterThan(10);
    }
  });

  it('pitch: warm car range, linear in rev, never above the cap (<= 220 Hz)', () => {
    for (const [, p] of PRESETS) {
      const g = p.gearbox;
      const idle = enginePitch(g.idleRev, p);
      expect(idle).toBeGreaterThanOrEqual(45);
      expect(idle).toBeLessThanOrEqual(60);
      const topOfGear = enginePitch(g.upshiftRev, p);
      expect(topOfGear).toBeGreaterThanOrEqual(150);
      expect(topOfGear).toBeLessThanOrEqual(200);
      expect(p.pitchCapHz).toBeLessThanOrEqual(220);
      // Every reachable (speed, gear, throttle, flare) and garbage input stays under the cap.
      for (let v = 0; v <= TUNING.car.maxSpeed * 1.2; v += 0.5) {
        for (let gear = 1; gear <= g.gearTops.length; gear++) {
          for (const th of [0, 0.5, 1]) {
            const f = enginePitch(engineRev(v, gear, th, g.driftFlare, g), p);
            expect(f).toBeLessThanOrEqual(p.pitchCapHz);
            expect(f).toBeGreaterThanOrEqual(idle - 1e-9);
          }
        }
      }
      for (const bad of [NaN, Infinity, -Infinity, -1, 5]) {
        const f = enginePitch(bad, p);
        expect(Number.isFinite(f) && f <= p.pitchCapHz && f >= idle - 1e-9).toBe(true);
      }
      let prev = 0;
      for (const r of steps(20)) {
        const f = enginePitch(g.idleRev + (1 - g.idleRev) * r, p);
        expect(f).toBeGreaterThan(prev);
        prev = f;
      }
    }
    expect(enginePitch(A.gearbox.upshiftRev, A)).toBeGreaterThanOrEqual(170);
  });

  it('throttle load is concave: most of the load change happens in the first half of the pedal', () => {
    expect(throttleLoad(0)).toBe(0);
    expect(throttleLoad(1)).toBe(1);
    expect(throttleLoad(0.5)).toBeGreaterThan(0.6);
    expect(throttleLoad(NaN)).toBe(0);
    expect(throttleLoad(7)).toBe(1);
    expect(revProgress(A.gearbox.idleRev, A)).toBe(0);
    expect(revProgress(1, A)).toBe(1);
  });

  it('cutoff: ~250 Hz at idle, <= 1.6 kHz flat out, darker off-throttle, gentle Q', () => {
    for (const [, p] of PRESETS) {
      const g = p.gearbox;
      const idle = engineCutoff(g.idleRev, 0, p);
      expect(idle).toBeGreaterThan(200);
      expect(idle).toBeLessThan(330);
      expect(p.filterQ).toBeLessThanOrEqual(1.2);
      for (const r of steps(10)) {
        const rev = g.idleRev + (1 - g.idleRev) * r;
        expect(engineCutoff(rev, 1, p)).toBeLessThanOrEqual(1600);
        expect(engineCutoff(rev, 0, p)).toBeLessThan(engineCutoff(rev, 1, p));
      }
      expect(engineCutoff(1, 1, p)).toBeGreaterThan(engineCutoff(midRev(p), 1, p));
      expect(engineCutoff(2, 1, p)).toBeLessThanOrEqual(1600);
      expect(Number.isFinite(engineCutoff(NaN, NaN, p))).toBe(true);
      expect(p.tameHz).toBeLessThanOrEqual(2600);
      expect(p.shelfDb).toBeLessThanOrEqual(-6);
    }
  });

  it('level: equal-loudness compensated (flat out <= +2 dB over mid rev / half throttle), coasting clearly quieter', () => {
    for (const [, p] of PRESETS) {
      const g = p.gearbox;
      const full = engineLevel(g.revLimit, 1, p);
      const mid = engineLevel(midRev(p), 0.5, p);
      expect(db(full, mid)).toBeLessThanOrEqual(2);
      // Gain falls with rev at fixed throttle (higher pitch is perceived louder).
      for (const th of [0, 0.5, 1]) {
        let prev = Infinity;
        for (const r of steps(10)) {
          const l = engineLevel(g.idleRev + (1 - g.idleRev) * r, th, p);
          expect(l).toBeLessThanOrEqual(prev);
          prev = l;
        }
      }
      // Coasting (rolling off-throttle above idle) is clearly quieter; idling is quieter than pulling but stays audible.
      for (const r of steps(10).filter((x) => x >= 0.2)) {
        const rev = g.idleRev + (1 - g.idleRev) * r;
        expect(db(engineLevel(rev, 0, p), engineLevel(rev, 1, p))).toBeLessThanOrEqual(-5);
      }
      const idle = engineLevel(g.idleRev, 0, p);
      expect(idle).toBeLessThan(engineLevel(g.idleRev, 1, p));
      expect(idle).toBeGreaterThan(engineLevel(g.idleRev + (1 - g.idleRev) * 0.3, 0, p));
      expect(full).toBeLessThanOrEqual(0.3);
      expect(Number.isFinite(engineLevel(NaN, NaN, p))).toBe(true);
    }
  });

  it('timbre curves: more drive and rumble on throttle, lumpier at idle, idle wobble only at rest', () => {
    for (const [, p] of PRESETS) {
      const g = p.gearbox;
      expect(engineDrive(1, p)).toBeGreaterThan(engineDrive(0, p));
      expect(rumbleLevel(midRev(p), 1, p)).toBeGreaterThan(0);
      expect(rumbleLevel(midRev(p), 0, p)).toBe(0);
      expect(engineLump(g.idleRev, p)).toBeGreaterThan(engineLump(1, p));
      expect(engineLump(g.idleRev, p)).toBeLessThan(1);
      expect(idleWobbleCents(g.idleRev, 0, p)).toBeGreaterThan(0);
      expect(idleWobbleCents(g.idleRev, 0, p)).toBeLessThanOrEqual(40);
      expect(idleWobbleCents(midRev(p), 0, p)).toBe(0);
      expect(idleWobbleCents(g.idleRev, 1, p)).toBeLessThan(idleWobbleCents(g.idleRev, 0, p));
      for (const f of [engineDrive, (x: number, q: EnginePreset) => rumbleLevel(NaN, x, q), engineLump, (x: number, q: EnginePreset) => idleWobbleCents(x, NaN, q)]) {
        expect(Number.isFinite(f(NaN, p))).toBe(true);
      }
    }
  });
});
