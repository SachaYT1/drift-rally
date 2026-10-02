import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudio, MASTER_LEVEL, MAX_VOICES, type GameAudio } from './sfx';
import { engineFrequency, engineLevel, LOOP_DUCK, screechFrequency, screechIntensity } from './engine';
import { TUNING } from '../shared/tuning';
import { DEG } from '../shared/math';
import type { CarState, GameEvent, RaceResult } from '../shared/types';

function car(over: Partial<CarState> = {}): CarState {
  return { x: 0, z: 0, heading: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, mode: 'grip', driftDir: 0, driftTime: 0, gripBlend: 1,
    modeTimer: 0, reverseHold: 0, wheelSpin: 0, speed: 0, forwardSpeed: 0, lateralSpeed: 0, slip: 0, rpm: 0, ...over };
}
const DRIFT = car({ rpm: 0.9, speed: 30, slip: 35 * DEG, mode: 'drift', driftDir: 1 });
const COIN: GameEvent = { type: 'coin', id: 1, x: 0, z: 0 };

const RESULT: RaceResult = { totalPoints: 4200, bestChain: 1800, totalTime: 180, lapTimes: [60, 60, 60], bestLap: 60,
  coinsPicked: 20, coinsFromDrift: 4, coinsEarned: 24 };

const ALL_EVENTS: GameEvent[] = [
  { type: 'countdown', value: 3 }, { type: 'countdown', value: 0 }, COIN,
  { type: 'propKnocked', id: 'c1', kind: 'can', x: 0, z: 0, vx: 1, vz: 1 },
  { type: 'hit', impactSpeed: 12, x: 0, z: 0 }, { type: 'hit', impactSpeed: 1e6, x: 0, z: 0 }, { type: 'scrape', x: 0, z: 0 },
  { type: 'chainStart' }, { type: 'multiplier', value: 3 }, { type: 'chainBanked', points: 1240 },
  { type: 'chainBurned', points: 300 }, { type: 'penalty', points: 100 },
  { type: 'lap', lap: 1, lapTime: 61, best: true }, { type: 'lap', lap: 2, lapTime: 62, best: false },
  { type: 'wrongWay', active: true }, { type: 'respawn' }, { type: 'finish', result: RESULT },
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

// --- Strict fake Web Audio: throws where real browsers throw, records automation. ---

interface Call { m: 'set' | 'linear' | 'exp' | 'target'; v: number; t: number }

function checkArgs(v: number, t: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t)) throw new TypeError('non-finite AudioParam argument');
  if (t < 0) throw new RangeError('negative time');
}

class FakeParam {
  calls: Call[] = [];
  constructor(private v: number) {}
  get value(): number { return this.v; }
  set value(x: number) { checkArgs(x, 0); this.v = x; }
  private push(m: Call['m'], v: number, t: number): this { checkArgs(v, t); this.calls.push({ m, v, t }); return this; }
  setValueAtTime(v: number, t: number): this { return this.push('set', v, t); }
  linearRampToValueAtTime(v: number, t: number): this { return this.push('linear', v, t); }
  exponentialRampToValueAtTime(v: number, t: number): this { if (v === 0) throw new RangeError('exp ramp to 0'); return this.push('exp', v, t); }
  setTargetAtTime(v: number, t: number, tau: number): this { if (!(tau >= 0)) throw new RangeError('bad tau'); return this.push('target', v, t); }
  cancelScheduledValues(t: number): this { checkArgs(0, t); this.calls = this.calls.filter((c) => c.t < t); return this; }
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
class FakeFilter extends FakeNode { type = 'lowpass'; frequency = new FakeParam(350); Q = new FakeParam(1); gain = new FakeParam(0); detune = new FakeParam(0); }
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24); knee = new FakeParam(30); ratio = new FakeParam(12); attack = new FakeParam(0.003); release = new FakeParam(0.25);
}
class FakeSource extends FakeNode {
  started: number | undefined; stopped: number | undefined; onended: (() => void) | null = null;
  start(t = 0): void { if (this.started !== undefined) throw new Error('InvalidStateError: start twice'); checkArgs(0, t); this.started = t; }
  stop(t = 0): void { if (this.started === undefined) throw new Error('InvalidStateError: stop before start'); checkArgs(0, t); this.stopped = t; }
}
class FakeOsc extends FakeSource { type = 'sine'; frequency = new FakeParam(440); detune = new FakeParam(0); }
class FakeBuffer {
  private readonly data: Float32Array;
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) { this.data = new Float32Array(length); }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(): Float32Array { return this.data; }
}
class FakeBufferSource extends FakeSource { buffer: FakeBuffer | null = null; loop = false; playbackRate = new FakeParam(1); }

class FakeCtx {
  nodes: FakeNode[] = [];
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 1; sampleRate = 48000; resumeCalls = 0; suspendCalls = 0;
  broken = false; // when set, oscillator creation throws (a browser-specific Web Audio failure)
  destination = new FakeNode(this, 'destination');
  createGain(): FakeGain { return new FakeGain(this, 'gain'); }
  createOscillator(): FakeOsc { if (this.broken) throw new Error('NotSupportedError'); return new FakeOsc(this, 'osc'); }
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

type Started = ReturnType<typeof setup> & ReturnType<typeof loopSources> & { master: FakeGain };

/** Unlocked audio over a fake context, with the master gain and the loop sources resolved. */
async function started(): Promise<Started> {
  const s = setup();
  await s.audio.unlock();
  return { ...s, master: masterOf(s.ctx), ...loopSources(s.ctx) };
}

/** Product of the latest gain targets on every path from `from` to `to` (max over paths). */
function pathGain(from: FakeNode, to: FakeNode): number {
  if (from === to) return 1;
  const nodes = from.outputs.filter((o): o is FakeNode => o instanceof FakeNode);
  return Math.max(0, ...nodes.map((o) => pathGain(o, to) * (o instanceof FakeGain ? o.gain.latest() : 1)));
}

/** Gain nodes on some path from `from` to `to` (excluding `to`). */
function gainsBetween(from: FakeNode, to: FakeNode): FakeGain[] {
  const found: FakeGain[] = [];
  const reaches = (n: FakeNode): boolean => {
    // map (not some): every branch is walked so every gain on any path is collected.
    const hit = n === to || n.outputs.filter((o): o is FakeNode => o instanceof FakeNode).map(reaches).includes(true);
    if (hit && n !== to && n instanceof FakeGain && !found.includes(n)) found.push(n);
    return hit;
  };
  return reaches(from) ? found : [];
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
  return { engine: live.filter((s): s is FakeOsc => s instanceof FakeOsc && s.frequency.value > 20),
    screech: live.filter((s): s is FakeBufferSource => s instanceof FakeBufferSource && s.loop) };
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
    const f = Array.from({ length: 11 }, (_, i) => engineFrequency(i / 10, false));
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
    expect(f[0] > 50 && f[10] < 800).toBe(true);
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
    expect(screechFrequency(back(Math.PI))).toBeCloseTo(screechFrequency(car({ speed: v })));
  });
});

describe('audio graph (fake AudioContext)', () => {
  it('unlock builds master gain -> compressor -> destination once and resumes', async () => {
    const { ctx, audio, made, master, engine, screech } = await started();
    const comp = master.outputs[0] as FakeNode;
    expect(comp.kind).toBe('compressor');
    expect(comp.outputs).toContain(ctx.destination);
    expect(master.gain.value).toBeCloseTo(MASTER_LEVEL);
    expect(ctx.state).toBe('running');
    const nodeCount = ctx.nodes.length;
    expect(engine).toHaveLength(2);
    expect(screech).toHaveLength(1);
    await audio.unlock();
    expect(made()).toBe(1);
    expect(ctx.nodes.length).toBe(nodeCount);
  });

  it('engine/screech start silent; setEngineActive and update glide them with setTargetAtTime', async () => {
    const { audio, master, engine, screech } = await started();
    expect(pathGain(engine[0], master)).toBe(0);
    audio.setEngineActive(true);
    audio.update(car({ rpm: 0.1, speed: 4 }), 0, false, 1 / 60);
    expect(pathGain(engine[0], master)).toBeGreaterThan(0);
    expect(pathGain(screech[0], master)).toBe(0);
    const slowF = engine[0].frequency.latest();
    audio.update(DRIFT, 1, true, 1 / 60);
    expect(engine[0].frequency.latest()).toBeGreaterThan(slowF);
    expect(pathGain(screech[0], master)).toBeGreaterThan(0);
    for (const o of engine) expect(o.frequency.calls.every((c) => c.m === 'target')).toBe(true);
    audio.setEngineActive(false);
    expect(pathGain(engine[0], master) + pathGain(screech[0], master)).toBe(0);
  });

  it('survives non-finite car state without passing NaN to Web Audio', async () => {
    const { audio } = await started();
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
    const { ctx, audio } = await started();
    const before = ctx.nodes.length;
    for (const e of ALL_EVENTS) expect(() => audio.onEvent(e)).not.toThrow();
    const fresh = ctx.nodes.slice(before);
    const shots = fresh.filter((n): n is FakeSource => n instanceof FakeSource);
    expect(shots.length).toBeGreaterThan(10);
    for (const s of shots) expect((s.started as number) >= ctx.currentTime && (s.stopped as number) > (s.started as number)).toBe(true);
    for (const g of fresh.filter((n): n is FakeGain => n instanceof FakeGain)) {
      expect(g.gain.calls[0]).toMatchObject({ m: 'set', v: 0 });
      expect((g.gain.calls.at(-1) as Call).v).toBeLessThanOrEqual(0.001);
    }
  });

  it('sound-less events, the final lap chime and muted events allocate nothing', async () => {
    const { ctx, audio } = await started();
    const n0 = ctx.nodes.length;
    const silent: GameEvent[] = [{ type: 'chainStart' }, { type: 'respawn' }, { type: 'wrongWay', active: true },
      { type: 'multiplier', value: 3 }, { type: 'lap', lap: TUNING.race.laps, lapTime: 60, best: true }];
    for (const e of silent) audio.onEvent(e);
    expect(ctx.nodes.length).toBe(n0);
    audio.setMuted(true);
    audio.onEvent(COIN);
    audio.onEvent({ type: 'finish', result: RESULT });
    expect(ctx.nodes.length).toBe(n0);
  });

  it('caps simultaneous one-shot voices and frees them on ended', async () => {
    const { ctx, audio } = await started();
    const n0 = ctx.sources().length;
    for (let i = 0; i < 200; i++) audio.onEvent({ type: 'coin', id: i, x: 0, z: 0 });
    const shots = ctx.sources().slice(n0);
    expect(shots.length).toBeLessThanOrEqual(MAX_VOICES);
    for (const s of shots) s.onended?.();
    audio.onEvent({ type: 'coin', id: 999, x: 0, z: 0 });
    expect(ctx.sources().length).toBeGreaterThan(n0 + shots.length);
  });

  it('suspend fades out then suspends; nothing is scheduled while paused; resume (even a quick one) restores', async () => {
    vi.useFakeTimers();
    const { ctx, audio, master, engine } = await started();
    audio.setEngineActive(true);
    audio.suspend();
    expect(master.gain.latest()).toBe(0);
    vi.advanceTimersByTime(500);
    expect(ctx.suspendCalls).toBe(1);
    const n0 = ctx.nodes.length;
    const calls0 = engine[0].frequency.calls.length;
    audio.update(car({ rpm: 0.8, speed: 25 }), 1, false, 1 / 60);
    audio.onEvent(COIN);
    audio.setMuted(false);
    expect([master.gain.latest(), ctx.nodes.length, engine[0].frequency.calls.length]).toEqual([0, n0, calls0]);
    audio.resume();
    expect([ctx.resumeCalls, ctx.state, master.gain.latest()]).toEqual([2, 'running', MASTER_LEVEL]);
    // A quick suspend -> resume never leaves the context suspended.
    audio.suspend(); audio.resume();
    vi.advanceTimersByTime(500);
    expect([ctx.suspendCalls, ctx.state]).toEqual([1, 'running']);
  });

  it('turning the engine off while paused cuts the loops instead of gliding on a frozen clock', async () => {
    vi.useFakeTimers();
    const { ctx, audio, master, engine, screech } = await started();
    audio.setEngineActive(true);
    audio.update(DRIFT, 1, true, 1 / 60);
    audio.suspend(); vi.advanceTimersByTime(500); // paused mid-drift, context suspended
    audio.setEngineActive(false);
    for (const src of [engine[0], screech[0]]) {
      const zeroed = gainsBetween(src, master).filter((g) => g.gain.latest() === 0);
      expect(zeroed.length).toBeGreaterThan(0);
      for (const g of zeroed) expect(g.gain.calls.at(-1)).toMatchObject({ m: 'set', v: 0, t: ctx.currentTime });
    }
    await audio.unlock();
    expect(pathGain(engine[0], master) + pathGain(screech[0], master)).toBe(0);
  });

  it('re-enabling after silence restarts the engine at idle; a quick re-enable glides on', async () => {
    const { ctx, audio, engine: [osc] } = await started();
    const idle = engineFrequency(0, false);
    audio.setEngineActive(true);
    audio.update(car({ rpm: 0.9, speed: 30 }), 1, false, 1 / 60);
    const high = osc.frequency.latest();
    expect(high).toBeGreaterThan(idle * 2);
    audio.setEngineActive(false);
    ctx.currentTime += 0.05; // still fading out: no pitch jump
    audio.setEngineActive(true);
    expect(osc.frequency.latest()).toBe(high);
    audio.setEngineActive(false);
    ctx.currentTime += 1; // silent now: restart at idle
    audio.setEngineActive(true);
    expect(osc.frequency.calls.at(-1)).toMatchObject({ m: 'set', v: idle, t: ctx.currentTime });
  });

  it('reward cues duck the running loops and always recover; back-to-back cues hold one dip', async () => {
    const { ctx, audio, master, engine: [osc] } = await started();
    const ducker = (): FakeGain | undefined => gainsBetween(osc, master).find((g) => g.gain.calls.some((c) => c.v === LOOP_DUCK.level));
    audio.onEvent(COIN);
    audio.setEngineActive(true);
    audio.onEvent({ type: 'hit', impactSpeed: 12, x: 0, z: 0 });
    expect(ducker()).toBeUndefined();
    audio.onEvent(COIN);
    ctx.currentTime += 0.05;
    audio.onEvent({ type: 'chainBanked', points: 900 });
    const calls = (ducker() as FakeGain).gain.calls;
    // Two dips, the coin's pending release dropped, one final release back to 1 after the last cue.
    expect(calls.map((c) => c.v)).toEqual([LOOP_DUCK.level, LOOP_DUCK.level, 1]);
    expect(calls.at(-1)).toMatchObject({ m: 'target', v: 1 });
    expect((calls.at(-1) as Call).t).toBeGreaterThan(ctx.currentTime);
  });

  it('a Web Audio error mid-race turns audio off instead of crashing the game loop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, audio } = await started();
    ctx.broken = true;
    expect(() => audio.onEvent(COIN)).not.toThrow();
    expect([warn.mock.calls.length, ctx.state]).toEqual([1, 'closed']);
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
});
