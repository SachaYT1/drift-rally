/**
 * Race screen: a sequence of race runs on the one cached race scene. «Заново» / «Ещё раз» destroy the
 * current run and start a fresh session (props, effects and HUD reset; nothing GPU-side is rebuilt);
 * «В гараж» hands control back to main.ts.
 */
import type { App } from './context';
import { startRaceRun, type InputSource, type RaceRun } from './raceRun';

export interface RaceScreen {
  /** The active run (null after destroy). */
  readonly run: RaceRun | null;
  /** Start a fresh run now (retry). */
  restart(): void;
  /** Real-time driver for this and later runs; null = the test hook steps (rAF only renders). */
  setSource(source: InputSource | null): void;
  readonly source: InputSource | null;
  destroy(): void;
}

export function enterRace(app: App, opts: { source: InputSource | null; onGarage(): void }): RaceScreen {
  let source = opts.source;
  let run: RaceRun | null = null;
  let destroyed = false;

  function begin(): void {
    run?.destroy();
    app.screen = 'race';
    run = startRaceRun(
      app,
      {
        onRestart: () => {
          if (!destroyed) begin();
        },
        onGarage: () => {
          if (destroyed) return;
          destroy();
          opts.onGarage();
        },
        onResults: () => {
          app.screen = 'results';
        },
      },
      source,
    );
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    run?.destroy();
    run = null;
  }

  begin();

  return {
    get run() {
      return run;
    },
    restart() {
      if (!destroyed) begin();
    },
    setSource(next) {
      source = next;
      run?.setSource(next);
    },
    get source() {
      return source;
    },
    destroy,
  };
}
