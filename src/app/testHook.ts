/**
 * `?test` automation hook (plan Task 16/17): window.__game drives races deterministically. In test mode the
 * rAF loop never steps the simulation on its own (it only renders) unless realtime() hands it a driver.
 * Plain `?test` also applies the render contract (quality low, pixel ratio 1, buffer <= 640x360);
 * `&full` / `&quality=<level>` keep the window-sized buffer (see testFlagsFrom in context.ts).
 */
import { NEUTRAL_INPUT, type DriveMode, type InputFrame } from '../shared/types';
import { TUNING } from '../shared/tuning';
import type { RacePhase } from '../game/session';
import type { App, ScreenName } from './context';
import type { RaceScreen } from './raceScreen';
import type { InputSource } from './raceRun';
import { createAutopilot } from './autopilot';

export interface GameTestState {
  screen: ScreenName;
  phase: RacePhase | null;
  lap: number;
  /** m/s */
  speed: number;
  /** Banked points. */
  points: number;
  /** Unbanked points of the active chain. */
  chain: number;
  coins: number;
  /** Unwrapped progress and its maximum, m. */
  p: number;
  frontier: number;
  /** Arc length and lateral offset on the centreline, m. */
  s: number;
  lateral: number;
  mode: DriveMode | null;
  /** Race time, s. */
  time: number;
  paused: boolean;
  fps?: number;
}

export type RealtimeDriver = 'keyboard' | 'autopilot' | null;

export interface GameTestHook {
  /** From the garage (or results): start a race; resolves once its first frame is rendered. */
  startRace(): Promise<void>;
  /** `n` fixed steps; `input` overrides the keyboard (missing fields neutral). No-op while paused/finished. */
  step(n: number, input?: Partial<InputFrame>): void;
  /** `n` fixed steps driven by the autopilot. */
  autopilot(n: number): void;
  state(): GameTestState;
  /** Drive with the autopilot until the race finishes, then show the results screen. */
  finish(): void;
  /** Let requestAnimationFrame step the simulation in real time with this driver (null: the hook steps). */
  realtime(driver: RealtimeDriver): void;
  /** Renderer resource counters and the last frame's draw stats. */
  info(): { geometries: number; textures: number; programs: number; calls: number; triangles: number };
}

/** What main.ts exposes to the hook. */
export interface HookTarget {
  /** Null until loading finished. */
  app(): App | null;
  ready: Promise<void>;
  /** Leave the garage (no user gesture: audio stays locked) or restart from the race/results screen. */
  startRace(): void;
  race(): RaceScreen | null;
}

declare global {
  interface Window {
    __game?: GameTestHook;
  }
}

/** Upper bound for finish(), simulated seconds. */
const FINISH_LIMIT_S = 900;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function installTestHook(target: HookTarget): GameTestHook {
  let autopilot: InputSource | null = null;

  function app(): App {
    const a = target.app();
    if (!a) throw new Error('__game: still loading (await startRace() first)');
    return a;
  }

  function drive(): InputSource {
    autopilot ??= createAutopilot(app().track);
    return autopilot;
  }

  function run() {
    const r = target.race()?.run;
    if (!r) throw new Error(`__game: no race running (screen: ${target.app()?.screen ?? 'loading'})`);
    return r;
  }

  function sourceFor(driver: RealtimeDriver): InputSource | null {
    if (driver === 'autopilot') return drive();
    if (driver === 'keyboard') {
      const input = app().input;
      return () => input.sample();
    }
    return null;
  }

  const hook: GameTestHook = {
    async startRace() {
      await target.ready;
      target.startRace();
      await nextFrame();
      await nextFrame();
    },
    step(n, input) {
      const src: InputSource = input ? () => ({ ...NEUTRAL_INPUT, ...input }) : (sourceFor('keyboard') as InputSource);
      run().stepNow(n, src);
    },
    autopilot(n) {
      run().stepNow(n, drive());
    },
    state() {
      const a = target.app();
      const r = target.race()?.run ?? null;
      const st = r?.session.state() ?? null;
      return {
        screen: a?.screen ?? 'loading',
        phase: st?.phase ?? null,
        lap: st?.progress.lap ?? 0,
        speed: st?.car.speed ?? 0,
        points: st?.score.totalPoints ?? 0,
        chain: st?.score.chainPoints ?? 0,
        coins: st?.pickups.coinsPicked ?? 0,
        p: st?.progress.p ?? 0,
        frontier: st?.progress.frontier ?? 0,
        s: st?.progress.s ?? 0,
        lateral: st?.progress.lateral ?? 0,
        mode: st?.car.mode ?? null,
        time: st?.time ?? 0,
        paused: r?.paused ?? false,
        fps: a?.fps,
      };
    },
    finish() {
      const r = run();
      const steps = Math.ceil(FINISH_LIMIT_S * TUNING.race.physicsHz);
      r.stepNow(steps, drive());
      if (!r.finished) throw new Error('__game.finish(): the race did not finish (paused or stuck)');
      r.showResultsNow();
    },
    realtime(driver) {
      const screen = target.race();
      if (!screen) throw new Error('__game.realtime(): no race screen');
      screen.setSource(sourceFor(driver));
    },
    info() {
      const r = app().renderer;
      return {
        geometries: r.info.memory.geometries,
        textures: r.info.memory.textures,
        programs: r.info.programs?.length ?? 0,
        calls: r.info.render.calls,
        triangles: r.info.render.triangles,
      };
    },
  };
  window.__game = hook;
  return hook;
}
