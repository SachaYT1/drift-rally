import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudio, MASTER_LEVEL, MAX_VOICES, type GameAudio } from './sfx';
import { engineFrequency, engineLevel, screechIntensity } from './engine';
import { TUNING } from '../shared/tuning';
import { DEG } from '../shared/math';
import type { CarState, GameEvent, RaceResult } from '../shared/types';

function car(over: Partial<CarState> = {}): CarState {
  return {
    x: 0, z: 0, heading: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, mode: 'grip', driftDir: 0,
    driftTime: 0, gripBlend: 1, modeTimer: 0, reverseHold: 0, wheelSpin: 0,
    speed: 0, forwardSpeed: 0, lateralSpeed: 0, slip: 0, rpm: 0, ...over,
  };
}

const RESULT: RaceResult = {
  totalPoints: 4200, bestChain: 1800, totalTime: 180, lapTimes: [60, 60, 60], bestLap: 60,
  coinsPicked: 20, coinsFromDrift: 4, coinsEarned: 24,
};

const ALL_EVENTS: GameEvent[] = [
  { type: 'countdown', value: 3 }, { type: 'countdown', value: 0 },
  { type: 'coin', id: 1, x: 0, z: 0 },
  { type: 'propKnocked', id: 'c1', kind: 'can', x: 0, z: 0, vx: 1, vz: 1 },
  { type: 'hit', impactSpeed: 12, x: 0, z: 0 }, { type: 'hit', impactSpeed: 1e6, x: 0, z: 0 },
  { type: 'scrape', x: 0, z: 0 },
  { type: 'chainStart' }, { type: 'multiplier', value: 3 },
  { type: 'chainBanked', points: 1240 }, { type: 'chainBurned', points: 300 },
  { type: 'penalty', points: 100 },
  { type: 'lap', lap: 1, lapTime: 61, best: true }, { type: 'lap', lap: 2, lapTime: 62, best: false },
  { type: 'wrongWay', active: true }, { type: 'respawn' },
  { type: 'finish', result: RESULT },
];

function exerciseEverything(a: GameAudio): void {
  a.setMuted(true); a.setMuted(false);
  a.setEngineActive(true);
  a.update(car({ rpm: 0.5, speed: 20, slip: 30 * DEG, mode: 'drift', driftDir: 1 }), 1, true, 1 / 60);
  a.update(car({ x: NaN, rpm: NaN, speed: NaN, slip: NaN }), NaN, false, NaN);
  for (const e of ALL_EVENTS) a.onEvent(e);
  a.suspend(); a.resume();
  a.setEngineActive(false);
}

// ---------------------------------------------------------------------------
// Strict fake Web Audio: throws where real browsers throw, records automation.
// ---------------------------------------------------------------------------

interface Call { m: 'set' | 'linear' | 'exp' | 'target'; v: number; t: number }

function checkArgs(v: number, t: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t)) throw new TypeError('non-finite AudioParam argument');
  if (t < 0) throw new RangeError('negative time');
}

class FakeParam {
  calls: Call[] = [];
  private v: number;
  constructor(v: number) { this.v = v; }
  get value(): number { return this.v; }
  set value(x: number) { checkArgs(x, 0); this.v = x; }
  setValueAtTime(v: number, t: number): this { checkArgs(v, t); this.calls.push({ m: 'set', v, t }); return this; }
  linearRampToValueAtTime(v: number, t: number): this { checkArgs(v, t); this.calls.push({ m: 'linear', v, t }); return this; }
  exponentialRampToValueAtTime(v: number, t: number): this {
    checkArgs(v, t);
    if (v === 0) throw new RangeError('exponential ramp to 0');
    this.calls.push({ m: 'exp', v, t }); return this;
  }
  setTargetAtTime(v: number, t: number, tau: number): this {
    checkArgs(v, t);
    if (!(tau >= 0)) throw new RangeError('bad time constant');
    this.calls.push({ m: 'target', v, t }); return this;
  }
  /** Value the param is heading to (last automation target, else the static value). */
  latest(): number { return this.calls.at(-1)?.v ?? this.v; }
}

class FakeNode {
  outputs: (FakeNode | FakeParam)[] = [];
  constructor(readonly ctx: FakeCtx, readonly kind: string) { ctx.nodes.push(this); }
  connect<T extends FakeNode | FakeParam>(dest: T): T { this.outputs.push(dest); return dest; }
  disconnect(): void { this.outputs = []; }
}
class FakeGain extends FakeNode { gain = new FakeParam(1); }
class FakeFilter extends FakeNode {
  type = 'lowpass'; frequency = new FakeParam(350); Q = new FakeParam(1); gain = new FakeParam(0); detune = new FakeParam(0);
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24); knee = new FakeParam(30); ratio = new FakeParam(12);
  attack = new FakeParam(0.003); release = new FakeParam(0.25);
}
class FakeSource extends FakeNode {
  started: number | undefined; stopped: number | undefined; onended: (() => void) | null = null;
  start(t = 0): void { if (this.started !== undefined) throw new Error('InvalidStateError: start twice'); checkArgs(0, t); this.started = t; }
  stop(t = 0): void { if (this.started === undefined) throw new Error('InvalidStateError: stop before start'); checkArgs(0, t); this.stopped = t; }
}
class FakeOsc extends FakeSource { type = 'sine'; frequency = new FakeParam(440); detune = new FakeParam(0); }
class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(i: number): Float32Array { return this.data[i]; }
}
class FakeBufferSource extends FakeSource { buffer: FakeBuffer | null = null; loop = false; playbackRate = new FakeParam(1); }

class FakeCtx {
  nodes: FakeNode[] = [];
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 1;
  sampleRate = 48000;
  resumeCalls = 0;
  suspendCalls = 0;
  /** When set, node creation throws (simulates a browser-specific Web Audio failure). */
  broken = false;
  destination = new FakeNode(this, 'destination');
  createGain(): FakeGain { return new FakeGain(this, 'gain'); }
  createOscillator(): FakeOsc {
    if (this.broken) throw new Error('NotSupportedError');
    return new FakeOsc(this, 'osc');
  }
  createBiquadFilter(): FakeFilter { return new FakeFilter(this, 'filter'); }
  createDynamicsCompressor(): FakeCompressor { return new FakeCompressor(this, 'compressor'); }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(this, 'bufferSource'); }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer { return new FakeBuffer(ch, len, sr); }
  resume(): Promise<void> { this.resumeCalls++; this.state = 'running'; return Promise.resolve(); }
  suspend(): Promise<void> { this.suspendCalls++; this.state = 'suspended'; return Promise.resolve(); }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
  sources(): FakeSource[] { return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource); }
}

function setup(): { ctx: FakeCtx; audio: GameAudio; made: () => number } {
  const ctx = new FakeCtx();
  let made = 0;
  const audio = createAudio(() => { made++; return ctx as unknown as AudioContext; });
  return { ctx, audio, made: () => made };
}

/** Product of the latest gain targets on every path from `from` to `to` (max over paths). */
function pathGain(from: FakeNode, to: FakeNode): number {
  if (from === to) return 1;
  let best = 0;
  for (const out of from.outputs) {
    if (!(out instanceof FakeNode)) continue;
    const g = pathGain(out, to);
    best = Math.max(best, out instanceof FakeGain ? g * out.gain.latest() : g);
  }
  return best;
}

function masterOf(ctx: FakeCtx): FakeGain {
  const comp = ctx.nodes.find((n) => n instanceof FakeCompressor);
  const master = ctx.nodes.find((n): n is FakeGain => n instanceof FakeGain && n.outputs.includes(comp as FakeNode));
  if (!master) throw new Error('no master gain');
  return master;
}

/** Looping sources: the engine oscillators (started, never stopped) and the screech noise. */
function loopSources(ctx: FakeCtx): { engine: FakeOsc[]; screech: FakeBufferSource[] } {
  const live = ctx.sources().filter((s) => s.started !== undefined && s.stopped === undefined);
  return {
    engine: live.filter((s): s is FakeOsc => s instanceof FakeOsc && s.frequency.value > 20),
    screech: live.filter((s): s is FakeBufferSource => s instanceof FakeBufferSource && s.loop),
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('audio without Web Audio (node)', () => {
  it('every method is a safe no-op when AudioContext is missing', async () => {
    expect(typeof (globalThis as { AudioContext?: unknown }).AudioContext).toBe('undefined');
    const a = createAudio();
    await expect(a.unlock()).resolves.toBeUndefined();
    expect(() => exerciseEverything(a)).not.toThrow();
  });

  it('a throwing AudioContext constructor degrades to a no-op', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('blocked'); } });
    const a = createAudio();
    await expect(a.unlock()).resolves.toBeUndefined();
    expect(() => exerciseEverything(a)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('engine and screech mappings', () => {
  it('engine pitch rises monotonically with rpm and drifting adds wheelspin', () => {
    let prev = 0;
    for (let r = 0; r <= 1.0001; r += 0.1) {
      const f = engineFrequency(r, false);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
    expect(engineFrequency(0, false)).toBeGreaterThan(50);
    expect(engineFrequency(1, false)).toBeLessThan(800);
    expect(engineFrequency(0.5, true)).toBeGreaterThan(engineFrequency(0.5, false));
    expect(engineFrequency(-3, false)).toBe(engineFrequency(0, false));
  });

  it('engine level rises with throttle and stays modest', () => {
    expect(engineLevel(0.5, 1)).toBeGreaterThan(engineLevel(0.5, 0));
    expect(engineLevel(0, 0)).toBeGreaterThan(0);
    expect(engineLevel(1, 1)).toBeLessThanOrEqual(0.3);
  });

  it('screech follows slip and speed, is loud in a drift, silent otherwise', () => {
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
    expect(slide).toBeGreaterThan(0);
    expect(slide).toBeLessThan(wide);
    expect(screechIntensity(car({ speed: NaN, slip: NaN }), true)).toBe(0);
  });
});

describe('audio graph (fake AudioContext)', () => {
  it('unlock builds master gain -> compressor -> destination once and resumes', async () => {
    const { ctx, audio, made } = setup();
    await audio.unlock();
    const master = masterOf(ctx);
    const comp = master.outputs[0] as FakeNode;
    expect(comp.kind).toBe('compressor');
    expect(comp.outputs).toContain(ctx.destination);
    expect(master.gain.value).toBeCloseTo(MASTER_LEVEL);
    expect(ctx.state).toBe('running');
    const nodeCount = ctx.nodes.length;
    const loops = loopSources(ctx);
    expect(loops.engine).toHaveLength(2);
    expect(loops.screech).toHaveLength(1);
    await audio.unlock();
    expect(made()).toBe(1);
    expect(ctx.nodes.length).toBe(nodeCount);
  });

  it('engine/screech start silent; setEngineActive and update glide them with setTargetAtTime', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    const master = masterOf(ctx);
    const { engine, screech } = loopSources(ctx);
    expect(pathGain(engine[0], master)).toBe(0);

    audio.setEngineActive(true);
    audio.update(car({ rpm: 0.1, speed: 4 }), 0, false, 1 / 60);
    expect(pathGain(engine[0], master)).toBeGreaterThan(0);
    expect(pathGain(screech[0], master)).toBe(0);
    const slowF = engine[0].frequency.latest();

    audio.update(car({ rpm: 0.9, speed: 30, slip: 35 * DEG, mode: 'drift', driftDir: 1 }), 1, true, 1 / 60);
    expect(engine[0].frequency.latest()).toBeGreaterThan(slowF);
    expect(pathGain(screech[0], master)).toBeGreaterThan(0);
    for (const o of engine) expect(o.frequency.calls.every((c) => c.m === 'target')).toBe(true);

    audio.setEngineActive(false);
    expect(pathGain(engine[0], master)).toBe(0);
    expect(pathGain(screech[0], master)).toBe(0);
  });

  it('survives non-finite car state without passing NaN to Web Audio', async () => {
    const { audio } = setup();
    await audio.unlock();
    audio.setEngineActive(true);
    expect(() => audio.update(car({ rpm: NaN, speed: Infinity, slip: NaN }), NaN, true, 1 / 60)).not.toThrow();
    expect(() => audio.update(car(), 0, false, NaN)).not.toThrow();
  });

  it('mute is applied before and after unlock', async () => {
    const { ctx, audio } = setup();
    audio.setMuted(true);
    await audio.unlock();
    const master = masterOf(ctx);
    expect(master.gain.latest()).toBe(0);
    audio.setMuted(false);
    expect(master.gain.calls.at(-1)).toMatchObject({ m: 'target', v: MASTER_LEVEL });
    audio.setMuted(true);
    expect(master.gain.calls.at(-1)).toMatchObject({ m: 'target', v: 0 });
  });

  it('every event type schedules click-free one-shots (or nothing) without throwing', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    const before = ctx.nodes.length;
    for (const e of ALL_EVENTS) expect(() => audio.onEvent(e)).not.toThrow();
    const fresh = ctx.nodes.slice(before);
    const shots = fresh.filter((n): n is FakeSource => n instanceof FakeSource);
    expect(shots.length).toBeGreaterThan(10);
    for (const s of shots) {
      expect(s.started).toBeGreaterThanOrEqual(ctx.currentTime);
      expect(s.stopped).toBeGreaterThan(s.started as number);
    }
    for (const g of fresh.filter((n): n is FakeGain => n instanceof FakeGain)) {
      expect(g.gain.calls[0]).toMatchObject({ m: 'set', v: 0 });
      const last = g.gain.calls.at(-1) as Call;
      expect(last.v).toBeLessThanOrEqual(0.001);
    }
  });

  it('sound-less events, the final lap chime and muted events allocate nothing', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    const n0 = ctx.nodes.length;
    audio.onEvent({ type: 'chainStart' });
    audio.onEvent({ type: 'respawn' });
    audio.onEvent({ type: 'wrongWay', active: true });
    audio.onEvent({ type: 'lap', lap: TUNING.race.laps, lapTime: 60, best: true });
    expect(ctx.nodes.length).toBe(n0);
    audio.setMuted(true);
    audio.onEvent({ type: 'coin', id: 1, x: 0, z: 0 });
    audio.onEvent({ type: 'finish', result: RESULT });
    expect(ctx.nodes.length).toBe(n0);
  });

  it('caps simultaneous one-shot voices and frees them on ended', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    const n0 = ctx.sources().length;
    for (let i = 0; i < 200; i++) audio.onEvent({ type: 'coin', id: i, x: 0, z: 0 });
    const shots = ctx.sources().slice(n0);
    expect(shots.length).toBeLessThanOrEqual(MAX_VOICES);
    for (const s of shots) s.onended?.();
    audio.onEvent({ type: 'coin', id: 999, x: 0, z: 0 });
    expect(ctx.sources().length).toBeGreaterThan(n0 + shots.length);
  });

  it('suspend fades the master out, then suspends; resume restores; nothing is scheduled while paused', async () => {
    vi.useFakeTimers();
    const { ctx, audio } = setup();
    await audio.unlock();
    const master = masterOf(ctx);
    audio.setEngineActive(true);
    audio.suspend();
    expect(master.gain.latest()).toBe(0);
    vi.advanceTimersByTime(500);
    expect(ctx.suspendCalls).toBe(1);
    const n0 = ctx.nodes.length;
    const { engine } = loopSources(ctx);
    const calls0 = engine[0].frequency.calls.length;
    audio.update(car({ rpm: 0.8, speed: 25 }), 1, false, 1 / 60);
    audio.onEvent({ type: 'coin', id: 1, x: 0, z: 0 });
    audio.setMuted(false);
    expect(master.gain.latest()).toBe(0);
    expect(ctx.nodes.length).toBe(n0);
    expect(engine[0].frequency.calls.length).toBe(calls0);
    audio.resume();
    expect(ctx.resumeCalls).toBe(2);
    expect(ctx.state).toBe('running');
    expect(master.gain.latest()).toBeCloseTo(MASTER_LEVEL);
  });

  it('a Web Audio error mid-race turns audio off instead of crashing the game loop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, audio } = setup();
    await audio.unlock();
    ctx.broken = true;
    expect(() => audio.onEvent({ type: 'coin', id: 1, x: 0, z: 0 })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('closed');
    const n0 = ctx.nodes.length;
    expect(() => exerciseEverything(audio)).not.toThrow();
    await expect(audio.unlock()).resolves.toBeUndefined();
    expect(ctx.nodes.length).toBe(n0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a failure while building the graph closes the context and stays silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = new FakeCtx();
    ctx.broken = true;
    const audio = createAudio(() => ctx as unknown as AudioContext);
    await expect(audio.unlock()).resolves.toBeUndefined();
    expect(ctx.state).toBe('closed');
    expect(() => exerciseEverything(audio)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a quick suspend -> resume never leaves the context suspended', async () => {
    vi.useFakeTimers();
    const { ctx, audio } = setup();
    await audio.unlock();
    audio.suspend();
    audio.resume();
    vi.advanceTimersByTime(500);
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.state).toBe('running');
  });
});
