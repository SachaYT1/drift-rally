import { describe, expect, it } from 'vitest';
import { createLoopVoices, createNoiseBuffer, type LoopVoices } from './engine';
import { DEFAULT_ENGINE_PRESET, ENGINE_PRESETS, enginePitch, type EnginePreset } from './enginePresets';
import { downstream, FakeCtx, FakeFilter, FakeGain, FakeShaper, loopSources, type FakeOsc } from './fakeWebAudio';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';

function car(over: Partial<CarState> = {}): CarState {
  return { x: 0, z: 0, heading: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, mode: 'grip', driftDir: 0, driftTime: 0, gripBlend: 1,
    modeTimer: 0, reverseHold: 0, wheelSpin: 0, speed: 0, forwardSpeed: 0, lateralSpeed: 0, slip: 0, rpm: 0, ...over };
}

interface Rig { ctx: FakeCtx; loops: LoopVoices; saw: FakeOsc; out: FakeGain; filters: FakeFilter[]; gains: FakeGain[] }

function rig(preset?: EnginePreset): Rig {
  const ctx = new FakeCtx();
  const out = ctx.createGain();
  const a = ctx as unknown as BaseAudioContext;
  const loops = createLoopVoices(a, out as unknown as AudioNode, createNoiseBuffer(a, 0.1), preset);
  const saw = loopSources(ctx).engine[0];
  const below = downstream(saw);
  return { ctx, loops, saw, out, filters: below.filter((n): n is FakeFilter => n instanceof FakeFilter),
    gains: below.filter((n): n is FakeGain => n instanceof FakeGain) };
}

/** Full throttle 0 -> 38 m/s at 60 Hz updates; returns the pitch target after every update. */
function accelerate(r: Rig, drifting = false): number[] {
  r.loops.setActive(true, r.ctx.currentTime);
  const pitches: number[] = [];
  for (let i = 0; i <= 600; i++) {
    r.ctx.currentTime += 1 / 60;
    r.loops.update(car({ speed: (i / 600) * 38, mode: drifting ? 'drift' : 'grip' }), 1, drifting, r.ctx.currentTime);
    pitches.push(r.saw.frequency.latest());
  }
  return pitches;
}

describe('engine loop voice (fake AudioContext)', () => {
  it('the factory takes a preset; the game default is preset A', () => {
    expect(rig().saw.frequency.value).toBeCloseTo(enginePitch(DEFAULT_ENGINE_PRESET.gearbox.idleRev, DEFAULT_ENGINE_PRESET));
    for (const p of Object.values(ENGINE_PRESETS)) {
      expect(rig(p).saw.frequency.value).toBeCloseTo(enginePitch(p.gearbox.idleRev, p));
    }
  });

  it('a 0 -> max run steps through the gears: rising saw-tooth pitch, never above the cap', () => {
    for (const p of Object.values(ENGINE_PRESETS)) {
      const r = rig(p);
      const f = accelerate(r);
      const drops = f.filter((v, i) => i > 0 && v < f[i - 1] * 0.75);
      expect(drops).toHaveLength(p.gearbox.gearTops.length - 1);
      expect(Math.max(...f)).toBeLessThanOrEqual(p.pitchCapHz);
      expect(Math.max(...f)).toBeLessThanOrEqual(220);
      // Each up-shift dips the level briefly and always comes back to full.
      const dipGain = r.gains.find((g) => g.gain.calls.some((c) => c.v === p.shiftDip));
      expect(dipGain).toBeDefined();
      const dipCalls = (dipGain as FakeGain).gain.calls;
      expect(dipCalls.filter((c) => c.v === p.shiftDip)).toHaveLength(p.gearbox.gearTops.length - 1);
      expect(dipCalls.at(-1)?.v).toBe(1);
    }
  });

  it('every engine param moves with setTargetAtTime (no clicks) and stays finite', () => {
    const r = rig();
    accelerate(r);
    r.loops.update(car({ speed: NaN, slip: NaN }), NaN, true, r.ctx.currentTime + 0.1);
    const params = [r.saw.frequency, ...r.filters.map((f) => f.frequency), ...r.gains.map((g) => g.gain)];
    for (const p of params) {
      for (const c of p.calls) {
        expect(c.m).toBe('target');
        expect(Number.isFinite(c.v)).toBe(true);
      }
    }
  });

  it('gentle filters only: Q <= 1.2, cutoffs <= 1.6 kHz flat out, a fixed top cut, a soft shaper', () => {
    for (const p of Object.values(ENGINE_PRESETS)) {
      const r = rig(p);
      accelerate(r, true);
      const engineFilters = r.filters.filter((f) => f.type !== 'bandpass' || f.Q.value < 3); // screech excluded
      for (const f of engineFilters) expect(f.Q.value).toBeLessThanOrEqual(1.2);
      const lowpasses = engineFilters.filter((f) => f.type === 'lowpass');
      expect(lowpasses.length).toBeGreaterThanOrEqual(2);
      // The moving (pitch-tracking) cutoff stays <= 1.6 kHz; the fixed extra lowpass sits a bit above it.
      const moving = lowpasses.filter((f) => f.frequency.calls.length > 0);
      expect(moving).toHaveLength(1);
      expect(Math.max(...moving[0].frequency.calls.map((c) => c.v))).toBeLessThanOrEqual(1600);
      for (const f of lowpasses) expect(f.frequency.value).toBeLessThanOrEqual(2600);
      const shelf = engineFilters.find((f) => f.type === 'highshelf');
      expect(shelf?.gain.value).toBeLessThanOrEqual(-6);
      const shaper = r.ctx.nodes.find((n): n is FakeShaper => n instanceof FakeShaper);
      expect(shaper?.curve?.length).toBeGreaterThan(256);
      expect(shaper?.oversample).not.toBe('none');
    }
  });

  it('drifting on throttle flares the pitch; coasting is quieter and darker than pulling', () => {
    const p = DEFAULT_ENGINE_PRESET;
    const speed = 0.7 * p.gearbox.gearTops[2] * TUNING.car.maxSpeed;
    const hold = (throttle: number, drifting: boolean): Rig => {
      const r = rig(p);
      r.loops.setActive(true, r.ctx.currentTime);
      for (let i = 0; i < 120; i++) {
        r.ctx.currentTime += 1 / 60;
        r.loops.update(car({ speed, mode: drifting ? 'drift' : 'grip' }), throttle, drifting, r.ctx.currentTime);
      }
      return r;
    };
    const grip = hold(1, false);
    const drift = hold(1, true);
    const coast = hold(0, false);
    const ratio = drift.saw.frequency.latest() / grip.saw.frequency.latest();
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(1.21);
    const cutoff = (r: Rig): number => Math.min(...r.filters.filter((f) => f.type === 'lowpass').map((f) => f.frequency.latest()));
    expect(cutoff(coast)).toBeLessThan(cutoff(grip));
    // Same gear and pitch, so the gain nodes line up one-to-one; the level gain is the one that differs most.
    const ratios = grip.gains.map((g, i) => coast.gains[i].gain.latest() / Math.max(1e-9, g.gain.latest()));
    expect(Math.min(...ratios)).toBeLessThan(0.56); // at least -5 dB
    expect(coast.saw.frequency.latest()).toBeCloseTo(grip.saw.frequency.latest());
  });

  it('re-enabling after silence restarts in first gear at idle', () => {
    const r = rig();
    accelerate(r);
    r.loops.setActive(false, r.ctx.currentTime);
    r.ctx.currentTime += 1;
    r.loops.setActive(true, r.ctx.currentTime);
    const idle = enginePitch(DEFAULT_ENGINE_PRESET.gearbox.idleRev);
    expect(r.saw.frequency.calls.at(-1)).toMatchObject({ m: 'set', v: idle, t: r.ctx.currentTime });
    r.ctx.currentTime += 1 / 60;
    r.loops.update(car({ speed: 0 }), 0, false, r.ctx.currentTime);
    expect(r.saw.frequency.latest()).toBeCloseTo(idle);
  });
});
