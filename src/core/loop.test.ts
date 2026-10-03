import { describe, expect, it } from 'vitest';
import { createFixedLoop } from './loop';

function make() {
  const steps: number[] = []; const alphas: number[] = [];
  const loop = createFixedLoop({ hz: 120, maxStepsPerFrame: 12, maxFrameDt: 0.1, step: (dt) => steps.push(dt), render: (a) => alphas.push(a), raf: () => 0, caf: () => {} });
  return { loop, steps, alphas };
}

describe('fixed loop', () => {
  it('runs 2 steps per 60 Hz frame on average', () => {
    const { loop, steps } = make();
    for (let i = 0; i < 60; i++) loop.advance(1 / 60);
    expect(steps.length).toBeGreaterThanOrEqual(119);
    expect(steps.length).toBeLessThanOrEqual(120);
    expect(steps.every((d) => d === 1 / 120)).toBe(true);
  });
  it('clamps long frames and caps steps', () => {
    const { loop } = make();
    expect(loop.advance(0.5)).toBeLessThanOrEqual(12);
  });
  it('alpha stays in [0, 1)', () => {
    const { loop, alphas } = make();
    for (const d of [1 / 144, 1 / 60, 0.013, 0.021]) loop.advance(d);
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
  });
  it('does not step while paused and does not lurch on resume', () => {
    const { loop, steps } = make();
    loop.pause();
    loop.advance(1 / 60);
    expect(steps).toHaveLength(0);
    loop.resume();
    expect(loop.advance(1 / 60)).toBeLessThanOrEqual(2);
  });
});

describe('fixed loop edge cases', () => {
  function fakeFrames() {
    let pending: FrameRequestCallback | null = null;
    let nextId = 1;
    let ms = 0;
    const cancelled: number[] = [];
    return {
      raf: (cb: FrameRequestCallback) => { pending = cb; return nextId++; },
      get requests() { return nextId - 1; },
      caf: (id: number) => { cancelled.push(id); pending = null; },
      now: () => ms,
      cancelled,
      get scheduled() { return pending !== null; },
      /** Fire the pending rAF callback at clock time t (ms). */
      frame(t: number) { ms = t; const cb = pending; pending = null; cb?.(t); },
    };
  }
  function make(extra: Partial<Parameters<typeof createFixedLoop>[0]> = {}) {
    const steps: number[] = []; const renders: Array<{ alpha: number; frameDt: number }> = [];
    const loop = createFixedLoop({
      hz: 120, maxStepsPerFrame: 12, maxFrameDt: 0.1,
      step: (dt) => steps.push(dt), render: (alpha, frameDt) => renders.push({ alpha, frameDt }),
      raf: () => 0, caf: () => {}, ...extra,
    });
    return { loop, steps, renders };
  }

  it('renders every advanced frame with alpha = leftover / step and the clamped frame dt', () => {
    const { loop, renders } = make();
    expect(loop.advance(1 / 240)).toBe(0);
    expect(renders[0].alpha).toBeCloseTo(0.5, 9);
    loop.advance(0.5);
    expect(renders[1].frameDt).toBe(0.1);
  });
  it('ignores NaN, negative and zero frame times', () => {
    const { loop, steps, renders } = make();
    for (const d of [Number.NaN, -1, 0]) expect(loop.advance(d)).toBe(0);
    expect(steps).toHaveLength(0);
    expect(renders.every((r) => r.alpha === 0 && r.frameDt === 0)).toBe(true);
  });
  it('drops the excess when the step cap is hit (no spiral of death)', () => {
    const { loop, renders } = make({ maxStepsPerFrame: 2 });
    expect(loop.advance(0.1)).toBe(2);
    expect(renders[0].alpha).toBeGreaterThanOrEqual(0);
    expect(renders[0].alpha).toBeLessThan(1);
    expect(loop.advance(0)).toBe(0);
  });
  it('neither steps nor renders while paused; resume discards the leftover fraction', () => {
    const { loop, steps, renders } = make();
    loop.advance(1 / 240);
    loop.pause();
    expect(loop.paused).toBe(true);
    loop.advance(1);
    expect(renders).toHaveLength(1);
    loop.resume();
    expect(loop.paused).toBe(false);
    expect(loop.advance(1 / 240)).toBe(0);
    expect(steps).toHaveLength(0);
  });
  it('is driven by requestAnimationFrame with the injected millisecond clock', () => {
    const f = fakeFrames();
    const { loop, steps } = make({ raf: f.raf, caf: f.caf, now: f.now });
    loop.start();
    loop.start(); // second start is a no-op
    expect(f.requests).toBe(1);
    f.frame(1000);
    expect(steps).toHaveLength(0); // first frame only establishes the timeline
    f.frame(1000 + 1000 / 60);
    expect(steps).toHaveLength(2);
    expect(f.scheduled).toBe(true);
    loop.stop();
    expect(f.cancelled).toHaveLength(1);
    expect(f.scheduled).toBe(false);
  });
  it('start() begins a fresh, unpaused run even if stopped while paused', () => {
    const f = fakeFrames();
    const { loop, steps } = make({ raf: f.raf, caf: f.caf, now: f.now });
    loop.start();
    loop.pause();
    loop.stop();
    loop.start();
    expect(loop.paused).toBe(false);
    f.frame(0);
    f.frame(1000 / 60);
    expect(steps).toHaveLength(2);
  });
  it('does not lurch after a long pause driven by rAF', () => {
    const f = fakeFrames();
    const { loop, steps } = make({ raf: f.raf, caf: f.caf, now: f.now });
    loop.start();
    f.frame(0);
    loop.pause();
    f.frame(5000);
    loop.resume();
    f.frame(60_000);
    expect(steps).toHaveLength(0);
    f.frame(60_000 + 1000 / 60);
    expect(steps).toHaveLength(2);
  });
});

describe('fixed loop control from inside step()', () => {
  const STEP = 1 / 120;
  /** A loop whose step() calls `onStep(loop, stepIndex)` after recording the step. */
  function makeControlled(
    onStep: (loop: ReturnType<typeof createFixedLoop>, index: number) => void,
    frames?: { raf: (cb: FrameRequestCallback) => number; caf: (id: number) => void; now: () => number },
  ) {
    const steps: number[] = []; const renders: number[] = [];
    const loop: ReturnType<typeof createFixedLoop> = createFixedLoop({
      hz: 120, maxStepsPerFrame: 12, maxFrameDt: 0.1,
      step: (dt) => { steps.push(dt); onStep(loop, steps.length); },
      render: (a) => renders.push(a),
      raf: () => 0, caf: () => {}, ...frames,
    });
    return { loop, steps, renders };
  }
  function fakeFrames() {
    let pending: FrameRequestCallback | null = null;
    let nextId = 1;
    let ms = 0;
    return {
      raf: (cb: FrameRequestCallback) => { pending = cb; return nextId++; },
      caf: () => { pending = null; },
      now: () => ms,
      get scheduled() { return pending !== null; },
      frame(t: number) { ms = t; const cb = pending; pending = null; cb?.(t); },
    };
  }

  it('pause() inside step() skips the remaining sub-steps and leftover time but still renders that frame', () => {
    const { loop, steps, renders } = makeControlled((l, i) => { if (i === 1) l.pause(); });
    expect(loop.advance(5.5 * STEP)).toBe(1);
    expect(steps).toHaveLength(1);
    // Rendered once with alpha 0: the 4.5 unrun steps were dropped, not carried as alpha 0.5.
    expect(renders).toEqual([0]);
    expect(loop.paused).toBe(true);
    expect(loop.advance(5 * STEP)).toBe(0);
    expect(renders).toHaveLength(1);
    loop.resume();
    expect(loop.advance(2 * STEP)).toBe(2);
    expect(steps).toHaveLength(3);
    expect(renders).toHaveLength(2);
  });

  it('stop() inside step() skips the remaining sub-steps, renders that frame and schedules no further frame', () => {
    const f = fakeFrames();
    const { loop, steps, renders } = makeControlled((l, i) => { if (i === 2) l.stop(); }, f);
    loop.start();
    f.frame(0);
    expect(renders).toHaveLength(1);
    f.frame(1000 * 5 * STEP);
    expect(steps).toHaveLength(2);
    expect(renders).toEqual([0, 0]);
    expect(f.scheduled).toBe(false);
  });

  it('stop() inside a directly driven advance() also ends that frame and drops its leftover time', () => {
    const { loop, steps, renders } = makeControlled((l, i) => { if (i === 1) l.stop(); });
    expect(loop.advance(4.5 * STEP)).toBe(1);
    expect(renders).toEqual([0]);
    // Had the 3.5 unrun steps been kept, this frame would run 3 more steps.
    expect(loop.advance(STEP / 2)).toBe(0);
    expect(steps).toHaveLength(1);
    expect(renders[1]).toBeCloseTo(0.5, 9);
  });

  it('start() begins unpaused even after a pause() while stopped (finish, blur on results, retry)', () => {
    const f = fakeFrames();
    const { loop, steps, renders } = makeControlled((l, i) => { if (i === 2) l.stop(); }, f);
    loop.start();
    f.frame(0);
    f.frame(1000 * 4 * STEP); // the finish calls stop() inside the 2nd step
    expect(steps).toHaveLength(2);
    loop.pause(); // window blur while the results screen is up
    expect(loop.paused).toBe(true);
    expect(loop.advance(STEP)).toBe(0);
    loop.start(); // retry
    expect(loop.paused).toBe(false);
    const rendered = renders.length;
    f.frame(10_000);
    f.frame(10_000 + 1000 * 2 * STEP);
    expect(steps).toHaveLength(4);
    expect(renders).toHaveLength(rendered + 2);
  });
});
