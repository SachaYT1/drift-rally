/**
 * Garage screen: the resident garage scene (turntable) rendered by its own rAF loop plus a fresh garage UI
 * (the UI instance is single-use). «В ЗАЕЗД» / Enter unlock audio inside the user gesture, then hand over to
 * the race screen.
 */
import type { SaveData } from '../shared/types';
import { createGarageUI } from '../ui/garage';
import type { App } from './context';

export interface GarageScreen {
  /** Leave for the race. `gesture`: called from a user gesture (audio may be unlocked). */
  start(gesture: boolean): void;
  destroy(): void;
}

/** Longest frame step the turntable advances, s (tab switches, debugger pauses). */
const MAX_FRAME_DT = 0.1;

export function enterGarage(app: App, opts: { lastShown: SaveData | null; onStart(): void }): GarageScreen {
  const { garage, renderer } = app;
  let destroyed = false;
  let raf = 0;
  let last = -1;
  let time = 0;

  app.screen = 'garage';
  app.input.setRacing(false);
  app.audio.setEngineActive(false);

  // Built with the save shown last time, then updated: coins earned since then pop in the wallet.
  const ui = createGarageUI(app.ui, {
    save: opts.lastShown ?? app.save,
    trackName: app.track.def.name,
    onStart: () => start(true),
  });
  if (opts.lastShown) ui.update(app.save);

  function draw(): void {
    renderer.render(garage.scene, garage.camera);
  }

  function frame(now: number): void {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    const dt = last < 0 ? 0 : Math.min((now - last) / 1000, MAX_FRAME_DT);
    last = now;
    time += dt;
    garage.update(dt, time);
    draw();
    app.frameDone();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(raf);
    ui.destroy();
    if (app.redraw === draw) app.redraw = null;
  }

  function start(gesture: boolean): void {
    if (destroyed) return;
    // resume() must run synchronously inside the click / keydown to count as a user gesture.
    if (gesture) void app.audio.unlock();
    destroy();
    opts.onStart();
  }

  app.redraw = draw;
  raf = requestAnimationFrame(frame);
  return { start, destroy };
}
