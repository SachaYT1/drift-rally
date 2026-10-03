import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudio, MASTER_LEVEL, MAX_VOICES, type GameAudio } from './sfx';
import { LOOP_DUCK } from './engine';
import { DEFAULT_ENGINE_PRESET, enginePitch } from './enginePresets';
import { FakeBufferSource, FakeCtx, FakeGain, FakeNode, FakeOsc, FakeSource, gainsBetween, loopSources, masterOf, pathGain, type Call } from './fakeWebAudio';
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
  { type: 'propKnocked', id: 'c1', kind: 'can', x: 0, z: 0, vx: 1, vz: 1 }, { type: 'bomb', id: 'b1', x: 0, z: 0 },
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

describe('audio graph (fake AudioContext)', () => {
  it('unlock builds master gain -> compressor -> destination once and resumes', async () => {
    const { ctx, audio, made, master, engine, screech } = await started();
    const comp = master.outputs[0] as FakeNode;
    expect(comp.kind).toBe('compressor');
    expect(comp.outputs).toContain(ctx.destination);
    expect(master.gain.value).toBeCloseTo(MASTER_LEVEL);
    expect(ctx.state).toBe('running');
    const nodeCount = ctx.nodes.length;
    expect(engine).toHaveLength(3); // saw, triangle, sub-octave sine
    expect(screech).toHaveLength(3); // two tyre oscillators + the scrub noise
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

  describe('knocked cans and cups', () => {
    const CAN: GameEvent = { type: 'propKnocked', id: 'can-1', kind: 'can', x: 0, z: 0, vx: 1, vz: 1 };
    const CUP: GameEvent = { type: 'propKnocked', id: 'cup-1', kind: 'cup', x: 0, z: 0, vx: 1, vz: 1 };
    const PENALTY: GameEvent = { type: 'penalty', points: 100 };

    /** What `events` (one simulation step) schedule: one-shot oscillator start pitches and the loudest envelope peak. */
    function heard(ctx: FakeCtx, audio: GameAudio, events: GameEvent[]): { pitches: number[]; peak: number } {
      const n0 = ctx.nodes.length;
      for (const e of events) audio.onEvent(e);
      const fresh = ctx.nodes.slice(n0);
      const pitches = fresh.filter((n): n is FakeOsc => n instanceof FakeOsc).map((o) => (o.frequency.calls[0] as Call).v);
      const peak = Math.max(0, ...fresh.filter((n): n is FakeGain => n instanceof FakeGain).flatMap((g) => g.gain.calls.map((c) => c.v)));
      return { pitches, peak };
    }

    it('every knock is heard, also with nothing banked (the session then emits no penalty)', async () => {
      const { ctx, audio } = await started();
      for (const knock of [CAN, CUP]) expect(heard(ctx, audio, [knock]).peak).toBeGreaterThan(0);
      // Paper/plastic cups do not ring like a metal can.
      expect(heard(ctx, audio, [CUP]).pitches).not.toEqual(heard(ctx, audio, [CAN]).pitches);
    });

    it('an actual deduction adds its own subtle cue, never a second knock', async () => {
      const { ctx, audio } = await started();
      const knock = heard(ctx, audio, [CAN]);
      // Session order within one step: propKnocked, then the aggregated penalty.
      const both = heard(ctx, audio, [CAN, PENALTY]);
      expect(both.pitches.slice(0, knock.pitches.length)).toEqual(knock.pitches);
      const cue = both.pitches.slice(knock.pitches.length);
      expect(cue.length).toBeGreaterThan(0);
      for (const hz of cue) expect(knock.pitches).not.toContain(hz);
      const deduction = heard(ctx, audio, [PENALTY]);
      expect(deduction.pitches).toEqual(cue);
      expect(deduction.peak).toBeLessThan(knock.peak);
    });
  });

  it('a bomb booms: a deep thump under a noise burst', async () => {
    const { ctx, audio } = await started();
    const n0 = ctx.nodes.length;
    audio.onEvent({ type: 'bomb', id: 'b1', x: 0, z: 0 });
    const fresh = ctx.nodes.slice(n0);
    const pitches = fresh.filter((n): n is FakeOsc => n instanceof FakeOsc).map((o) => (o.frequency.calls[0] as Call).v);
    expect(pitches.length).toBeGreaterThan(0);
    expect(Math.min(...pitches)).toBeLessThan(150);
    expect(fresh.some((n) => n instanceof FakeBufferSource)).toBe(true);
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
    const idle = enginePitch(DEFAULT_ENGINE_PRESET.gearbox.idleRev);
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
