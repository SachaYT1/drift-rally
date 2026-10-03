/**
 * One race on the cached race scene: session, fixed loop, event routing, render interpolation, HUD, audio,
 * pause / resume and the finish (save once, then results). Retry and "back to garage" are decided by the
 * caller (raceScreen.ts), which destroys this run and starts another.
 *
 * Frame (design spec §5): N fixed steps (input sampled per step; the ghost bots step with the player) ->
 * interpolate the car and the ghosts between the last two steps -> car model, camera, shadows, occlusion,
 * effects, props, ghosts -> HUD (<= 30 Hz) -> render.
 * In test-hook mode (`source` null) requestAnimationFrame only renders; stepNow() advances the simulation
 * and syncs the visuals after every fixed step, so effects stay continuous and deterministic.
 */
import type { InputFrame, RaceResult } from '../shared/types';
import type { Placement } from '../shared/leaderboard';
import { TUNING, type Tuning } from '../shared/tuning';
import { tuningFor, type CarId } from '../shared/cars';
import { createSession, type Session, type SessionState } from '../game/session';
import { createFixedLoop } from '../core/loop';
import { createHud } from '../ui/hud';
import { createPauseMenu } from '../ui/pause';
import { showResults } from '../ui/results';
import { isTextField } from '../ui/screens';
import type { App } from './context';
import { interpolateCar } from './interpolate';
import { hintVisible, hudViewOf, parkedCar } from './raceView';
import { inputOnPause, inputOnResume, type PauseCause } from './pauseInput';
import type { RaceFrame } from './raceScene';
import { bestLapSeconds, recordRaceResult, type SaveOutcome } from './saveResult';
import { createGhostRun, type GhostRun } from './ghostRun';
import { livePoints } from '../game/bots';

/** Driving input for one fixed step. */
export type InputSource = (st: Readonly<SessionState>) => InputFrame;

export interface RaceRunHooks {
  /** «Заново» (pause) or «Ещё раз» (results). */
  onRestart(): void;
  /** «В гараж» (pause or results). */
  onGarage(): void;
  /** The results screen is up. */
  onResults(): void;
}

export interface RaceRun {
  readonly session: Session;
  /** The ghost bots of this run; null: switched off in the garage. */
  readonly ghosts: GhostRun | null;
  /** The car of this run. */
  readonly car: CarId;
  /** The physics of this run: TUNING with the car's overrides (the session's own tuning). */
  readonly tuning: Tuning;
  readonly paused: boolean;
  /** The session reported its finish (results may still be pending). */
  readonly finished: boolean;
  /** Test hook: run up to `n` fixed steps now with `source`; stops early when paused or finished. */
  stepNow(n: number, source: InputSource): void;
  /** Driver of the rAF loop; null = render only (the test hook steps). */
  setSource(source: InputSource | null): void;
  /** Pause as the player would (Esc): keys held stay held for the resume. */
  pause(): void;
  resume(): void;
  /** Show the results right away instead of after the finish delay (no-op before the finish). */
  showResultsNow(): void;
  destroy(): void;
}

/** Real time between the finish and the results screen, ms (the «Финиш!» toast plays meanwhile). */
const RESULTS_DELAY_MS = 1400;
/** HUD refresh interval, s (design spec §5: <= 30 Hz). */
const HUD_INTERVAL = 1 / 30;
const STEP_DT = 1 / TUNING.race.physicsHz;

/** One race in `car` (the garage hands over the car on its podium, not whatever the save selects by then). */
export function startRaceRun(app: App, hooks: RaceRunHooks, initialSource: InputSource | null, car: CarId): RaceRun {
  const { race, audio, input, ui } = app;
  const tuning = tuningFor(car);
  const session = createSession(app.track, { bestLap: bestLapSeconds(app.save), tuning });
  // The garage switch is read once per run: toggling it applies from the next race.
  const ghosts = app.save.ghosts ? createGhostRun(app.track) : null;
  let source = initialSource;
  /** Simulation seconds since the run began (countdown included); drives the coin animation. */
  let simClock = 0;
  /** A step since the last visual sync was a teleport: snap the car model and the camera. */
  let snapPending = true;
  let throttle = 0;
  let paused = false;
  let finished = false;
  let resultsShown = false;
  let destroyed = false;
  let hudLive = true;
  let hudAccum = Infinity;
  let hintShown: boolean | null = null;
  let resultsTimer = 0;
  let outcome: { result: RaceResult; save: SaveOutcome } | null = null;
  /** This finish on the friends table (null: no leaderboard, or not finished). */
  let placement: Promise<Placement> | null = null;
  let resultsUi: { destroy(): void } | null = null;
  const renderCar = { ...session.state().car };
  const parked = { ...renderCar };
  // Reused every frame / HUD tick: the render loop allocates nothing per frame.
  const frame: RaceFrame = {
    car: renderCar,
    effectsCar: renderCar,
    surface: 'road',
    pickups: session.state().pickups,
    bombs: session.state().bombs,
    simTime: 0,
    snap: true,
  };
  const hudView = hudViewOf(session.state());

  race.setCar(car);
  race.reset();
  const hud = createHud(ui, { onPause: () => pause('player') });
  const pauseMenu = createPauseMenu(ui, {
    onResume: () => resume(),
    onRestart: () => hooks.onRestart(),
    onGarage: () => hooks.onGarage(),
    onQuality: (q) => app.setQuality(q),
    onMute: (m) => app.setMuted(m),
    quality: app.quality,
    muted: app.save.muted,
  });

  function draw(): void {
    race.render(app.renderer);
  }

  /** One fixed simulation step and the routing of its events. */
  function simStep(dt: number, src: InputSource): void {
    const frame = src(session.state());
    const actions = input.consumeActions();
    const events = session.step(frame, { respawn: actions.respawn }, dt);
    throttle = frame.throttle;
    if (!finished) simClock += dt;
    if (session.state().teleported) snapPending = true;
    for (const e of events) {
      hud.onEvent(e);
      audio.onEvent(e);
      race.onEvent(e);
      if (e.type === 'finish') onFinish(e.result);
    }
    // After the player's events (the finish saves first): the bots never come between the player and the save.
    ghosts?.step(dt);
  }

  /**
   * Visual state for `car` (interpolated or the latest step). After the finish the session freezes the car
   * mid-motion: camera and model keep that pose, but the tyre effects see it parked so smoke stops.
   */
  function syncVisuals(car: SessionState['car'], st: Readonly<SessionState>, dt: number, alpha: number): void {
    frame.car = car;
    frame.effectsCar = finished ? parkedCar(car, parked) : car;
    frame.surface = st.surface;
    frame.pickups = st.pickups;
    frame.bombs = st.bombs;
    frame.simTime = simClock;
    frame.snap = snapPending;
    frame.ghosts = ghosts ? ghosts.views(alpha, car, dt) : null;
    race.sync(frame, dt);
    snapPending = false;
    audio.update(car, throttle, car.mode === 'drift', dt);
  }

  function hudTick(st: Readonly<SessionState>, dt: number, force = false): void {
    if (!hudLive) return;
    hudAccum += dt;
    if (force || hudAccum >= HUD_INTERVAL) {
      hudAccum = 0;
      const view = hudViewOf(st, hudView);
      view.standings = ghosts ? ghosts.standings({ points: livePoints(st.score), finished: st.phase === 'finished' }) : null;
      hud.update(view);
    }
    const hint = hintVisible(st);
    if (hint !== hintShown) {
      hintShown = hint;
      hud.showHint(hint);
    }
  }

  const loop = createFixedLoop({
    hz: TUNING.race.physicsHz,
    maxStepsPerFrame: TUNING.race.maxStepsPerFrame,
    maxFrameDt: TUNING.race.maxFrameDt,
    step(dt) {
      if (source) simStep(dt, source);
    },
    render(alpha, frameDt) {
      const st = session.state();
      if (source) syncVisuals(interpolateCar(st.prevCar, st.car, alpha, snapPending, renderCar), st, frameDt, alpha);
      hudTick(st, frameDt);
      draw();
      app.frameDone();
    },
  });

  function onFinish(result: RaceResult): void {
    if (finished) return;
    finished = true;
    // Saved once, at the finish; quitting earlier forfeits (design spec §2.5). Applied to the save as stored
    // now: another tab may have raced since this one loaded, and its coins and records must survive.
    outcome = { result, save: recordRaceResult(app, result, car) };
    // Sent while the «Финиш!» toast plays; the results screen shows the place when it arrives.
    placement = app.leaderboard?.recordFinish() ?? null;
    // Every bot's final points for the HUD and the results; the ghosts fade out where they are.
    ghosts?.finish();
    audio.setEngineActive(false);
    hudTick(session.state(), 0, true);
    resultsTimer = window.setTimeout(showResultsNow, RESULTS_DELAY_MS);
  }

  function showResultsNow(): void {
    if (!outcome || resultsShown || destroyed) return;
    window.clearTimeout(resultsTimer);
    resultsShown = true;
    loop.stop();
    input.setRacing(false);
    hudLive = false;
    hud.destroy();
    // The ghosts may not have faded yet (results shown at once by the test hook, or a hidden tab froze the fade).
    race.hideGhosts();
    draw();
    resultsUi = showResults(
      ui,
      outcome.result,
      {
        newBest: outcome.save.newBest,
        bestScore: app.save.bestScore,
        shareUrl: location.href.split(/[?#]/)[0],
        leaderboard: app.leaderboard && placement ? { placement, port: app.leaderboard } : null,
        versus: ghosts ? ghosts.finalStandings(outcome.result.totalPoints) : null,
      },
      { onRetry: () => hooks.onRestart(), onGarage: () => hooks.onGarage() },
    );
    hooks.onResults();
  }

  /** Keyboard focus to the canvas, so Space/Enter can never activate a leftover focused button. */
  function focusGame(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== app.canvas) active.blur();
    app.canvas.focus({ preventScroll: true });
  }

  function pause(cause: PauseCause): void {
    if (destroyed) return;
    // Focus lost while already paused (or after the finish): keyups may still go missing.
    if (cause === 'focusLost') input.reset();
    if (paused || finished) return;
    paused = true;
    loop.pause();
    audio.suspend();
    // Menu buttons must work with Space/Enter while paused; held keys survive a player pause only.
    inputOnPause(input, cause);
    hudTick(session.state(), 0, true);
    pauseMenu.show();
  }

  function resume(): void {
    if (!paused || destroyed) return;
    paused = false;
    pauseMenu.hide();
    // Drop presses made while paused (Esc, R, Space); keys still held (W through Esc / Esc) keep acting.
    inputOnResume(input);
    focusGame();
    audio.resume();
    loop.resume();
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Escape') {
      if (finished) return;
      if (paused) resume();
      else pause('player');
    } else if (e.code === 'KeyM' && !isTextField(e.target)) {
      app.setMuted(!app.save.muted);
      pauseMenu.sync({ muted: app.save.muted });
    }
  };
  const onBlur = (): void => pause('focusLost');
  const onVisibility = (): void => {
    if (document.hidden) pause('focusLost');
  };

  window.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  input.setRacing(true);
  focusGame();
  audio.resume();
  audio.setEngineActive(true);
  const redraw = (): void => {
    if (!destroyed) draw();
  };
  app.redraw = redraw;
  loop.start();

  return {
    session,
    ghosts,
    car,
    get tuning() {
      return session.tuning;
    },
    get paused() {
      return paused;
    },
    get finished() {
      return finished;
    },
    stepNow(n, src) {
      for (let i = 0; i < n && !paused && !finished && !destroyed; i++) {
        simStep(STEP_DT, src);
        const st = session.state();
        syncVisuals(st.car, st, STEP_DT, 1);
      }
    },
    setSource(next) {
      source = next;
    },
    pause: () => pause('player'),
    resume,
    showResultsNow,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loop.stop();
      window.clearTimeout(resultsTimer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      if (hudLive) hud.destroy();
      hudLive = false;
      pauseMenu.destroy();
      resultsUi?.destroy();
      input.setRacing(false);
      input.reset();
      audio.setEngineActive(false);
      if (app.redraw === redraw) app.redraw = null;
    },
  };
}
