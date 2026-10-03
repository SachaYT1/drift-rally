import { describe, expect, it } from 'vitest';
import {
  chirpKind,
  chirpLevel,
  DEFAULT_SCREECH_PRESET,
  envelopeTau,
  rearSlideSpeed,
  SCREECH_PRESETS,
  screechIntensity,
  screechMix,
  scrubGrainRate,
  slideAngle,
  squealPitch,
  type ScreechPreset,
} from './screechPresets';
import { DEG } from '../shared/math';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';

const PRESETS: [string, ScreechPreset][] = Object.entries(SCREECH_PRESETS);
const A = SCREECH_PRESETS.A;
const cents = (ratio: number): number => 1200 * Math.log2(ratio);
const pct = (c: number): number => (2 ** (c / 1200) - 1) * 100;

function car(over: Partial<CarState> = {}): CarState {
  return { x: 0, z: 0, heading: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, mode: 'grip', driftDir: 0, driftTime: 0, gripBlend: 1,
    modeTimer: 0, reverseHold: 0, wheelSpin: 0, speed: 0, forwardSpeed: 0, lateralSpeed: 0, slip: 0, rpm: 0, ...over };
}

/** A sideways slide at `speed` and slide angle `slipDeg` (nose left of motion), lateral speed consistent with it. */
function sliding(speed: number, slipDeg: number, over: Partial<CarState> = {}): CarState {
  const slip = slipDeg * DEG;
  return car({ speed, forwardSpeed: speed * Math.cos(slip), lateralSpeed: -speed * Math.sin(slip), slip, ...over });
}

const FAST = TUNING.drift.minSpeed * 3;

describe('screech presets', () => {
  it('the game ships preset A; every preset has a Russian title and caption for the sound lab', () => {
    expect(DEFAULT_SCREECH_PRESET).toBe(A);
    for (const [key, p] of PRESETS) {
      expect(p.id).toBe(key);
      expect(p.title).toMatch(/^[ABC] — [А-ЯЁ]/);
      expect(p.caption.length).toBeGreaterThan(20);
    }
  });

  it('voicing stays in the comfortable, tyre-like ranges the design asks for', () => {
    for (const [, p] of PRESETS) {
      expect(p.waves).toHaveLength(2);
      // Two rear tyres, slightly detuned against each other so they beat.
      const spread = Math.abs(p.detuneCents[0] - p.detuneCents[1]);
      expect(spread).toBeGreaterThanOrEqual(5);
      expect(spread).toBeLessThanOrEqual(20);
      // Stick-slip: fast pitch jitter 1.5-4 % and amplitude chatter 20-40 %.
      expect(pct(p.jitterCents)).toBeGreaterThanOrEqual(1.5);
      expect(pct(p.jitterCents)).toBeLessThanOrEqual(4);
      expect(p.jitterHz).toBeGreaterThanOrEqual(20);
      expect(p.jitterHz).toBeLessThanOrEqual(40);
      expect(p.chatter).toBeGreaterThanOrEqual(0.2);
      expect(p.chatter).toBeLessThanOrEqual(0.4);
      expect(p.chatterHz).toBeGreaterThanOrEqual(30);
      expect(p.chatterHz).toBeLessThanOrEqual(60);
      // Formant-like bandpass, then a gentle lowpass cap: no narrow resonance up high.
      expect(p.formantQ).toBeGreaterThanOrEqual(1.5);
      expect(p.formantQ).toBeLessThanOrEqual(4);
      expect(p.capHz).toBeLessThanOrEqual(3600);
      // Scrub: a LOW grainy band (300-900 Hz), granular AM at 20-50 Hz. Not a broad high hiss.
      expect(p.scrubHz).toBeGreaterThanOrEqual(300);
      expect(p.scrubHz).toBeLessThanOrEqual(900);
      expect(p.scrubCutHz).toBeLessThanOrEqual(1200);
      for (const hz of p.grainHz) {
        expect(hz).toBeGreaterThanOrEqual(20);
        expect(hz).toBeLessThanOrEqual(50);
      }
      expect(p.grain).toBeGreaterThan(0.4);
      expect(p.grain).toBeLessThanOrEqual(0.9);
      // Envelopes: attack 40-80 ms, release 150-250 ms (3 time constants ~ 95 %).
      expect(3 * p.attackTau).toBeGreaterThanOrEqual(0.04);
      expect(3 * p.attackTau).toBeLessThanOrEqual(0.08);
      expect(3 * p.releaseTau).toBeGreaterThanOrEqual(0.15);
      expect(3 * p.releaseTau).toBeLessThanOrEqual(0.25);
      // Chirps: short blips (60-150 ms), a few semitones at most.
      expect(p.chirpTime + 3 * p.chirpTau).toBeGreaterThanOrEqual(0.06);
      expect(p.chirpTime + 3 * p.chirpTau).toBeLessThanOrEqual(0.15);
      expect(p.chirpCents).toBeGreaterThan(0);
      expect(p.chirpCents).toBeLessThanOrEqual(500);
    }
    // B is the squealier one, C the grittier one.
    const B = SCREECH_PRESETS.B, C = SCREECH_PRESETS.C;
    expect(B.squealLevel / B.scrubLevel).toBeGreaterThan(A.squealLevel / A.scrubLevel);
    expect(C.squealLevel / C.scrubLevel).toBeLessThan(A.squealLevel / A.scrubLevel);
    expect(B.squealSlip[0]).toBeLessThan(A.squealSlip[0]);
    expect(C.squealSlip[0]).toBeGreaterThan(A.squealSlip[0]);
    for (const p of [A, B, C]) expect(p.driftSqueal).toBeLessThanOrEqual(0.5);
  });
});

describe('screech intensity (kept semantics)', () => {
  it('follows slip and speed, is loud in a drift, silent otherwise', () => {
    const fast = TUNING.drift.minSpeed * 2;
    expect(screechIntensity(car({ speed: fast }), false)).toBe(0);
    expect(screechIntensity(car({ speed: fast, slip: TUNING.score.minSlip * 0.5 }), false)).toBe(0);
    expect(screechIntensity(car({ speed: 0.5, slip: 40 * DEG }), true)).toBe(0);
    const narrow = screechIntensity(car({ speed: fast, slip: TUNING.drift.slipNarrow }), true);
    const wide = screechIntensity(car({ speed: fast, slip: -TUNING.drift.slipWide }), true);
    expect(narrow).toBeGreaterThan(0.3);
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBeLessThanOrEqual(1);
    const slide = screechIntensity(car({ speed: fast, slip: TUNING.drift.slipWide }), false);
    expect(slide > 0 && slide < wide).toBe(true);
    expect(screechIntensity(car({ speed: NaN, slip: NaN }), true)).toBe(0);
  });

  it('reversing does not screech; a sideways slide does whichever way the car rolls', () => {
    const v = TUNING.car.maxReverseSpeed;
    const back = (slip: number): CarState => car({ speed: v, forwardSpeed: -v, slip });
    expect(screechIntensity(back(Math.PI), false)).toBe(0);
    expect(screechIntensity(back(-Math.PI + 5 * DEG), false)).toBe(0);
    const side = screechIntensity(car({ speed: v, forwardSpeed: v, slip: 40 * DEG }), false);
    expect(side).toBeGreaterThan(0);
    expect(screechIntensity(back(Math.PI - 40 * DEG), false)).toBeCloseTo(side);
    expect(slideAngle(Math.PI)).toBe(0);
    expect(slideAngle(-0.3)).toBeCloseTo(0.3);
    for (const [, p] of PRESETS) {
      expect(squealPitch(back(Math.PI), 1, p)).toBeCloseTo(squealPitch(car({ speed: v }), 1, p));
      expect(screechMix(back(Math.PI), false, p)).toEqual({ squeal: 0, scrub: 0 });
    }
  });
});

describe('squeal vs scrub split', () => {
  it('nothing without a slide; light slides are mostly scrub; big angles are full squeal', () => {
    for (const [, p] of PRESETS) {
      expect(screechMix(car({ speed: FAST }), false, p)).toEqual({ squeal: 0, scrub: 0 });
      // A light grip-mode slide just past the scoring threshold: scrub, (almost) no squeal.
      const light = screechMix(sliding(FAST, TUNING.score.minSlip / DEG + 2), false, p);
      expect(light.scrub).toBeGreaterThan(0);
      expect(light.squeal).toBeLessThan(light.scrub * 0.25);
      // A drift at a narrow, counter-steered angle: the scrub dominates too; a drift keeps a little squeal.
      const narrow = screechMix(sliding(FAST, p.squealSlip[0] / DEG - 1, { mode: 'drift', driftDir: 1 }), true, p);
      expect(narrow.squeal).toBeCloseTo(screechIntensity(sliding(FAST, p.squealSlip[0] / DEG - 1), true) * p.driftSqueal);
      expect(narrow.squeal).toBeLessThan(narrow.scrub);
      expect(narrow.scrub).toBeGreaterThan(0.3);
      // A wide drift at speed: full squeal and full scrub.
      const wide = screechMix(sliding(FAST, 45, { mode: 'drift', driftDir: 1 }), true, p);
      expect(wide.squeal).toBeGreaterThan(0.95);
      expect(wide.scrub).toBeGreaterThan(0.9);
      // Monotonic in angle.
      let prev = -1;
      for (let deg = 0; deg <= 45; deg += 3) {
        const m = screechMix(sliding(FAST, deg, { mode: 'drift', driftDir: 1 }), true, p);
        expect(m.squeal).toBeGreaterThanOrEqual(prev);
        expect(m.squeal).toBeLessThanOrEqual(screechIntensity(sliding(FAST, deg), true) + 1e-12);
        prev = m.squeal;
      }
    }
  });

  it('grip-mode slides are quieter than the same slide in a drift', () => {
    for (const [, p] of PRESETS) {
      const grip = screechMix(sliding(FAST, 35), false, p);
      const drift = screechMix(sliding(FAST, 35, { mode: 'drift', driftDir: 1 }), true, p);
      expect(grip.squeal).toBeLessThan(drift.squeal);
      expect(grip.scrub).toBeLessThan(drift.scrub);
    }
  });

  it('the scrub follows how fast the rear axle slides sideways (incl. the swing of a flick)', () => {
    const b = TUNING.car.wheelBase / 2;
    expect(rearSlideSpeed(car({ lateralSpeed: -10 }))).toBeCloseTo(10);
    // Left drift: the tail swings right while the car yaws left, so the rear slides faster than the centre.
    expect(rearSlideSpeed(car({ lateralSpeed: -10, yawRate: 2 }))).toBeCloseTo(10 + 2 * b);
    expect(rearSlideSpeed(car({ lateralSpeed: NaN, yawRate: Infinity }))).toBe(0);
    for (const [, p] of PRESETS) {
      let prev = -1;
      for (let lat = 0; lat <= 30; lat += 2) {
        const s = screechMix(car({ speed: FAST, slip: 30 * DEG, lateralSpeed: -lat, mode: 'drift', driftDir: 1 }), true, p).scrub;
        expect(s).toBeGreaterThanOrEqual(prev);
        expect(s).toBeLessThanOrEqual(1);
        prev = s;
      }
      // Mid-flick the body slip passes 0 but the tail is still swinging: the tyres keep scrubbing.
      const flick = screechMix(car({ speed: FAST, slip: 0, lateralSpeed: 0, yawRate: -3.5, mode: 'drift', driftDir: -1 }), true, p);
      expect(flick.squeal).toBeGreaterThan(0);
      expect(flick.squeal).toBeLessThan(flick.scrub);
      expect(flick.scrub).toBeGreaterThan(0.2);
      const r0 = scrubGrainRate(car({ speed: FAST, lateralSpeed: -2 }), p);
      const r1 = scrubGrainRate(car({ speed: FAST, lateralSpeed: -20 }), p);
      expect(r1).toBeGreaterThan(r0);
      expect(Number.isFinite(scrubGrainRate(car({ lateralSpeed: NaN }), p))).toBe(true);
    }
  });

  it('non-finite car state never produces NaN', () => {
    for (const [, p] of PRESETS) {
      const bad = car({ speed: NaN, slip: Infinity, lateralSpeed: NaN, yawRate: NaN });
      expect(screechMix(bad, true, p)).toEqual({ squeal: 0, scrub: 0 });
      expect(Number.isFinite(squealPitch(bad, NaN, p))).toBe(true);
      expect(Number.isFinite(chirpLevel(bad, p))).toBe(true);
    }
  });
});

describe('squeal pitch', () => {
  it('650-1100 Hz for every reachable state; rises a little with slip and speed; drops a little off throttle', () => {
    for (const [, p] of PRESETS) {
      for (let v = 0; v <= TUNING.car.maxSpeed * 1.3; v += 2) {
        for (let deg = -90; deg <= 180; deg += 7.5) {
          for (const th of [0, 0.5, 1]) {
            const f = squealPitch(car({ speed: v, slip: deg * DEG }), th, p);
            expect(f).toBeGreaterThanOrEqual(650);
            expect(f).toBeLessThanOrEqual(1100);
          }
        }
      }
      const at = (v: number, deg: number, th = 1): number => squealPitch(sliding(v, deg), th, p);
      expect(at(FAST, 40)).toBeGreaterThan(at(FAST, 20));
      expect(at(FAST * 1.4, 30)).toBeGreaterThan(at(FAST, 30));
      // "A little": a wide slide at speed is at most ~6 semitones over a narrow slow one.
      expect(cents(at(TUNING.car.maxSpeed, 45) / at(TUNING.drift.minSpeed, 15))).toBeLessThan(600);
      // Off the throttle (lift / handbrake: rear tyres locked or undriven) the squeal sits lower.
      const lift = cents(at(FAST, 30, 0) / at(FAST, 30, 1));
      expect(lift).toBeLessThan(-30);
      expect(lift).toBeGreaterThan(-200);
    }
  });
});

describe('chirps', () => {
  it('fire on drift entry and on a flick (drift direction flips), nothing else', () => {
    const drift = (dir: -1 | 1) => ({ drifting: true, driftDir: dir });
    const grip = { drifting: false, driftDir: 0 as const };
    expect(chirpKind(grip, drift(1))).toBe('entry');
    expect(chirpKind(grip, { drifting: true, driftDir: 0 })).toBe('entry');
    expect(chirpKind(drift(1), drift(-1))).toBe('flick');
    expect(chirpKind(drift(-1), drift(1))).toBe('flick');
    expect(chirpKind(drift(1), drift(1))).toBeNull();
    expect(chirpKind(drift(1), grip)).toBeNull();
    expect(chirpKind(grip, grip)).toBeNull();
    // No history (first update after a restart): never a chirp.
    expect(chirpKind(null, drift(1))).toBeNull();
  });

  it('chirp level: scaled by speed, present even at the moment of entry (slip still small)', () => {
    for (const [, p] of PRESETS) {
      const entry = chirpLevel(car({ speed: FAST, slip: 2 * DEG }), p);
      expect(entry).toBeGreaterThan(0.2);
      expect(entry).toBeLessThanOrEqual(1);
      expect(chirpLevel(car({ speed: 0.5 }), p)).toBe(0);
      expect(chirpLevel(sliding(FAST, 45), p)).toBeGreaterThanOrEqual(entry);
    }
  });
});

describe('envelopes', () => {
  it('attack when rising, release when falling: release is the slower one', () => {
    for (const [, p] of PRESETS) {
      expect(envelopeTau(0, 1, p)).toBe(p.attackTau);
      expect(envelopeTau(1, 0.2, p)).toBe(p.releaseTau);
      expect(p.releaseTau).toBeGreaterThan(p.attackTau * 2);
    }
  });
});
