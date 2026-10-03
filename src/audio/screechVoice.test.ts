import { describe, expect, it } from 'vitest';
import { createLoopVoices, createNoiseBuffer } from './engine';
import { DEFAULT_SCREECH_PRESET, SCREECH_PRESETS, type ScreechPreset } from './screechPresets';
import { createScreechVoice, grainBuffer, smoothNoiseBuffer, type ScreechVoice } from './screechVoice';
import { FakeBufferSource, FakeCtx, FakeFilter, FakeGain, FakeOsc, FakeParam, loopSources } from './fakeWebAudio';
import { DEG } from '../shared/math';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';

function car(over: Partial<CarState> = {}): CarState {
  return { x: 0, z: 0, heading: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, mode: 'grip', driftDir: 0, driftTime: 0, gripBlend: 1,
    modeTimer: 0, reverseHold: 0, wheelSpin: 0, speed: 0, forwardSpeed: 0, lateralSpeed: 0, slip: 0, rpm: 0, ...over };
}
/** A slide at `speed`, slide angle `deg` (nose left of motion for dir +1). */
function sliding(speed: number, deg: number, over: Partial<CarState> = {}): CarState {
  const slip = deg * DEG;
  return car({ speed, forwardSpeed: speed * Math.cos(slip), lateralSpeed: -speed * Math.sin(slip), slip, ...over });
}
const FAST = TUNING.drift.minSpeed * 3;
const drift = (dir: -1 | 1, deg = 35): CarState => sliding(FAST, dir * deg, { mode: 'drift', driftDir: dir });

interface Rig { ctx: FakeCtx; voice: ScreechVoice; oscs: FakeOsc[]; squeal: FakeGain; chirp: FakeGain; scrub: FakeGain; out: FakeGain }

function rig(p: ScreechPreset = DEFAULT_SCREECH_PRESET): Rig {
  const ctx = new FakeCtx();
  const out = ctx.createGain();
  const a = ctx as unknown as BaseAudioContext;
  const voice = createScreechVoice(a, out as unknown as AudioNode, createNoiseBuffer(a, 0.1), p);
  const oscs = ctx.nodes.filter((n): n is FakeOsc => n instanceof FakeOsc);
  const [squeal, chirp, scrub] = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain && n.outputs.includes(out));
  return { ctx, voice, oscs, squeal, chirp, scrub, out };
}

/** Feeds `cars` at 60 Hz from the rig's clock. */
function feed(r: Rig, cars: CarState[], throttle = 1): void {
  for (const c of cars) {
    r.ctx.currentTime += 1 / 60;
    r.voice.update(c, throttle, c.mode === 'drift', r.ctx.currentTime);
  }
}
const hold = (c: CarState, n: number): CarState[] => Array.from({ length: n }, () => c);
const chirps = (r: Rig): number => r.chirp.gain.calls.filter((c) => c.v > 0).length;

describe('screech voice graph', () => {
  it('two detuned tyre oscillators, jitter into detune, chatter, formant + gentle caps, a low scrub band', () => {
    for (const p of Object.values(SCREECH_PRESETS)) {
      const r = rig(p);
      expect(r.oscs).toHaveLength(2);
      r.oscs.forEach((o, i) => {
        expect(o.type).toBe(p.waves[i]);
        expect(o.detune.value).toBe(p.detuneCents[i]);
        expect(o.started).toBeDefined();
      });
      // Jitter: a looping modulator through a gain of jitterCents into each oscillator's detune.
      const jitters = r.ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain && r.oscs.some((o) => n.outputs.includes(o.detune)));
      expect(jitters.map((g) => g.gain.value)).toEqual([p.jitterCents, p.jitterCents]);
      const filters = r.ctx.nodes.filter((n): n is FakeFilter => n instanceof FakeFilter);
      const formant = filters.find((f) => f.type === 'bandpass' && f.Q.value === p.formantQ);
      expect(formant).toBeDefined();
      const caps = filters.filter((f) => f.type === 'lowpass' && f.frequency.value > 2000);
      expect(caps).toHaveLength(2);
      for (const f of caps) {
        expect(f.frequency.value).toBeLessThanOrEqual(3600);
        expect(f.Q.value).toBeLessThanOrEqual(0.8);
      }
      const scrubBand = filters.find((f) => f.type === 'bandpass' && f !== formant);
      expect(scrubBand?.frequency.value).toBeGreaterThanOrEqual(300);
      expect(scrubBand?.frequency.value).toBeLessThanOrEqual(900);
      // No high shelf, no resonant filter anywhere in the screech.
      for (const f of filters) expect(f.type === 'highshelf' || f.Q.value > 4).toBe(false);
      // Every source started once and loops; the modulator buffers run below 100 Hz.
      for (const s of r.ctx.sources()) expect(s.started).toBe(r.ctx.currentTime);
      const mods = r.ctx.nodes.filter((n): n is FakeBufferSource => n instanceof FakeBufferSource && n.outputs.every((o) => o instanceof FakeGain && o.outputs.every((q) => q instanceof FakeParam)));
      expect(mods).toHaveLength(5); // 2 x jitter, 2 x chatter, grains
      for (const m of mods) expect(m.loop).toBe(true);
    }
  });

  it('updates move params only with setTargetAtTime, create no nodes and stay finite on garbage input', () => {
    const r = rig();
    const n0 = r.ctx.nodes.length;
    feed(r, [car({ speed: 20 }), ...hold(drift(1), 30), ...hold(drift(-1), 30), car({ speed: NaN, slip: NaN, lateralSpeed: NaN, yawRate: Infinity })]);
    r.ctx.currentTime += 1 / 60;
    r.voice.update(car({ speed: Infinity, slip: -Infinity }), NaN, true, r.ctx.currentTime);
    expect(r.ctx.nodes.length).toBe(n0);
    const params = [...r.oscs.map((o) => o.frequency), r.squeal.gain, r.scrub.gain,
      ...r.ctx.nodes.filter((n): n is FakeFilter => n instanceof FakeFilter).map((f) => f.frequency)];
    for (const p of params) {
      for (const c of p.calls) {
        expect(c.m).toBe('target');
        expect(Number.isFinite(c.v)).toBe(true);
      }
    }
  });
});

describe('screech voice levels', () => {
  it('silent when not sliding; a light grip slide is scrub only; a wide drift squeals', () => {
    const r = rig();
    feed(r, hold(car({ speed: FAST }), 5));
    expect([r.squeal.gain.latest(), r.scrub.gain.latest()]).toEqual([0, 0]);
    feed(r, hold(sliding(FAST, 12), 5));
    expect(r.squeal.gain.latest()).toBe(0);
    expect(r.scrub.gain.latest()).toBeGreaterThan(0);
    feed(r, hold(drift(1, 45), 5));
    expect(r.squeal.gain.latest()).toBeCloseTo(DEFAULT_SCREECH_PRESET.squealLevel);
    expect(r.scrub.gain.latest()).toBeGreaterThan(0);
  });

  it('attacks fast and releases slower (no clicks either way)', () => {
    const p = DEFAULT_SCREECH_PRESET;
    const r = rig();
    const spy: number[] = [];
    const orig = r.squeal.gain.setTargetAtTime.bind(r.squeal.gain);
    r.squeal.gain.setTargetAtTime = (v: number, t: number, tau: number) => { spy.push(tau); return orig(v, t, tau); };
    feed(r, [car({ speed: FAST }), drift(1, 45), drift(1, 45), car({ speed: FAST })]);
    expect(spy).toEqual([p.releaseTau, p.attackTau, p.releaseTau, p.releaseTau]);
  });

  it('the squeal pitch follows the slide: higher on a wider, faster slide; the formant tracks it', () => {
    const r = rig();
    feed(r, [drift(1, 20)]);
    const narrow = r.oscs[0].frequency.latest();
    feed(r, [sliding(FAST * 1.5, 45, { mode: 'drift', driftDir: 1 })]);
    const wide = r.oscs[0].frequency.latest();
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBeLessThanOrEqual(1100);
    const formant = r.ctx.nodes.find((n): n is FakeFilter => n instanceof FakeFilter && n.type === 'bandpass' && n.frequency.calls.length > 0);
    expect(formant?.frequency.latest()).toBeCloseTo(wide * DEFAULT_SCREECH_PRESET.formantRatio);
  });
});

describe('screech chirps', () => {
  it('chirp on drift entry and on a flick: a pitch blip on both tyres and a level blip, then back', () => {
    const p = DEFAULT_SCREECH_PRESET;
    const r = rig();
    feed(r, hold(car({ speed: FAST }), 10));
    expect(chirps(r)).toBe(0);
    feed(r, [drift(1, 3)]); // the moment of the kick: slip has not built up yet
    expect(chirps(r)).toBe(1);
    r.oscs.forEach((o, i) => {
      const calls = o.detune.calls;
      expect(calls.map((c) => c.v)).toEqual([p.detuneCents[i] + p.chirpCents, p.detuneCents[i]]);
      expect(calls[1].t - calls[0].t).toBeCloseTo(p.chirpTime);
    });
    expect(r.chirp.gain.latest()).toBe(0); // the blip decays back to nothing
    feed(r, hold(drift(1), 60));
    expect(chirps(r)).toBe(1); // a held drift does not chirp
    feed(r, hold(drift(-1), 30)); // flick
    expect(chirps(r)).toBe(2);
    feed(r, [car({ speed: FAST }), car({ speed: FAST })]); // drift ends: no chirp
    expect(chirps(r)).toBe(2);
  });

  it('a burst of flips stays one chirp; no chirp right after silence', () => {
    const r = rig();
    feed(r, [...hold(drift(1), 30), drift(-1), drift(1), drift(-1)]);
    expect(chirps(r)).toBe(1);
    r.voice.silence(r.ctx.currentTime, true);
    r.ctx.currentTime += 1;
    feed(r, [drift(1), drift(1)]);
    expect(chirps(r)).toBe(1);
  });
});

describe('screech silence', () => {
  it('cut jumps every level to 0 and the detune home; a soft silence glides', () => {
    const r = rig();
    feed(r, [car({ speed: FAST }), drift(1), drift(1)]);
    const now = r.ctx.currentTime;
    r.voice.silence(now, false);
    for (const g of [r.squeal, r.chirp, r.scrub]) expect(g.gain.calls.at(-1)).toMatchObject({ m: 'target', v: 0, t: now });
    r.voice.silence(now + 0.5, true);
    for (const g of [r.squeal, r.chirp, r.scrub]) expect(g.gain.calls.at(-1)).toMatchObject({ m: 'set', v: 0, t: now + 0.5 });
    r.oscs.forEach((o, i) => expect(o.detune.calls.at(-1)).toMatchObject({ m: 'set', v: DEFAULT_SCREECH_PRESET.detuneCents[i] }));
  });
});

describe('screech modulators', () => {
  const ctx = new FakeCtx() as unknown as BaseAudioContext;
  const seam = (d: Float32Array): number => Math.abs(d[0] - d[d.length - 1]);
  const steps = (d: Float32Array): number => Math.max(...d.subarray(1).map((v, i) => Math.abs(v - d[i])));

  it('the jitter / chatter source is band-limited random in [-1, 1], zero mean, seamless loop', () => {
    const d = smoothNoiseBuffer(ctx).getChannelData(0);
    expect(Math.max(...d.map(Math.abs))).toBeCloseTo(1);
    expect(Math.abs(d.reduce((a, b) => a + b, 0) / d.length)).toBeLessThan(1e-6);
    expect(seam(d)).toBeLessThanOrEqual(steps(d) * 1.01);
    expect(steps(d)).toBeLessThan(0.05); // smooth: no sample-to-sample jumps
  });

  it('the grain train is never negative, averages 1 and loops seamlessly', () => {
    const d = grainBuffer(ctx).getChannelData(0);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(0);
    expect(d.reduce((a, b) => a + b, 0) / d.length).toBeCloseTo(1);
    expect(seam(d)).toBeLessThanOrEqual(steps(d) * 1.01);
  });
});

describe('loop voices + screech presets', () => {
  it('createLoopVoices voices the tyres with the given screech preset (default A)', () => {
    const make = (p?: ScreechPreset): FakeOsc[] => {
      const ctx = new FakeCtx();
      const a = ctx as unknown as BaseAudioContext;
      createLoopVoices(a, ctx.createGain() as unknown as AudioNode, createNoiseBuffer(a, 0.1), undefined, p);
      return loopSources(ctx).screech.filter((s): s is FakeOsc => s instanceof FakeOsc);
    };
    expect(make().map((o) => o.type)).toEqual([...SCREECH_PRESETS.A.waves]);
    expect(make(SCREECH_PRESETS.C).map((o) => o.type)).toEqual([...SCREECH_PRESETS.C.waves]);
  });
});

