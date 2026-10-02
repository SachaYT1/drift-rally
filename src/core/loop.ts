/**
 * Fixed-timestep loop ("fix your timestep" accumulator), design spec §5 (Frame).
 *
 * Each frame: clamp the frame time, run whole simulation steps of 1/hz (at most
 * maxStepsPerFrame, excess time is dropped), then render with the interpolation factor
 * alpha = leftover / stepDt in [0, 1). While paused nothing runs: simulation time is frozen
 * and the canvas keeps its last frame (the app re-renders explicitly when needed, e.g. on resize).
 * pause() or stop() called from inside step() ends the current frame at once: the remaining
 * sub-steps are dropped and that frame is not rendered.
 * Pure: no three.js, no DOM access unless the default rAF/clock are used.
 */

export interface FixedLoop {
  /**
   * requestAnimationFrame-driven. Begins a fresh run (clock and accumulator reset); no-op when
   * already running. The run starts unpaused, except that a pause() requested while the loop was
   * not running survives start() (until resume()).
   */
  start(): void;
  /** Cancels the pending frame. From inside step() it also ends the current advance(). */
  stop(): void;
  /** Freezes simulation time. From inside step() it also ends the current advance(). */
  pause(): void;
  /** Resets last-time and accumulator (no lurch); also clears a pause requested before start(). */
  resume(): void;
  readonly paused: boolean;
  /** Run the accumulator for one frame of length frameDt (used by rAF and by tests/test-hook). */
  advance(frameDt: number): number; // returns number of steps run
}

export interface FixedLoopOptions {
  hz: number;
  maxStepsPerFrame: number;
  /** Seconds; longer frames (hitches, background tabs) are clamped to this. */
  maxFrameDt: number;
  step(dt: number): void;
  render(alpha: number, frameDt: number): void;
  /** Millisecond clock, defaults to performance.now. */
  now?: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
}

/**
 * Seconds. Frame times derived from a millisecond clock (e.g. 1000 / 60 ms) land a few
 * 1e-17 s short of whole steps; without this tolerance a 60 Hz frame would run 1 step and
 * carry an almost-full step instead of running 2.
 */
const TIME_EPSILON = 1e-9;

export function createFixedLoop(opts: FixedLoopOptions): FixedLoop {
  const stepDt = 1 / opts.hz;
  const now = opts.now ?? (() => performance.now());
  const raf = opts.raf ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const caf = opts.caf ?? ((id: number) => cancelAnimationFrame(id));

  let accumulator = 0;
  let paused = false;
  /** pause() was requested while not running: the next start() keeps the loop paused. */
  let pauseBeforeStart = false;
  let running = false;
  /** Bumped by start() and stop(), so an advance() in progress notices a stop from inside step(). */
  let generation = 0;
  let rafId: number | null = null;
  /** Clock value (ms) of the previous rAF tick; null = next tick starts a fresh timeline. */
  let lastTime: number | null = null;

  function advance(frameDt: number): number {
    if (paused) return 0;
    // NaN, negative or zero frame times advance nothing; long frames are clamped.
    const dt = frameDt > 0 ? Math.min(frameDt, opts.maxFrameDt) : 0;
    accumulator += dt;
    const gen = generation;
    let steps = 0;
    while (accumulator >= stepDt - TIME_EPSILON && steps < opts.maxStepsPerFrame) {
      opts.step(stepDt);
      accumulator = Math.max(0, accumulator - stepDt);
      steps++;
      if (paused || gen !== generation) {
        // pause() / stop() from inside step(): drop the rest of this frame, render nothing.
        accumulator = 0;
        return steps;
      }
    }
    // Step cap hit: drop the whole steps we could not run (avoids the spiral of death).
    if (accumulator >= stepDt) accumulator %= stepDt;
    opts.render(accumulator / stepDt, dt);
    return steps;
  }

  function tick(): void {
    if (!running) return;
    // Schedule first so an exception in step/render does not kill the loop.
    rafId = raf(tick);
    const t = now();
    const frameDt = lastTime === null ? 0 : (t - lastTime) / 1000;
    lastTime = t;
    advance(frameDt);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      paused = pauseBeforeStart;
      pauseBeforeStart = false;
      generation++;
      accumulator = 0;
      lastTime = null;
      rafId = raf(tick);
    },
    stop(): void {
      running = false;
      generation++;
      lastTime = null;
      if (rafId !== null) caf(rafId);
      rafId = null;
    },
    pause(): void {
      paused = true;
      if (!running) pauseBeforeStart = true;
    },
    resume(): void {
      paused = false;
      pauseBeforeStart = false;
      accumulator = 0;
      lastTime = null;
    },
    get paused(): boolean {
      return paused;
    },
    advance,
  };
}
