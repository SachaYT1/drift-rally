/**
 * Garage screen: the resident garage scene (turntable) rendered by its own rAF loop plus a fresh garage UI
 * (the UI instance is single-use). «В ЗАЕЗД» / Enter unlock audio inside the user gesture, then hand over to
 * the race screen.
 */
import type { SaveData } from '../shared/types';
import type { CarId } from '../shared/cars';
import { createGarageUI } from '../ui/garage';
import type { App } from './context';
import { purchaseCar, selectCar } from './carShop';

export interface GarageScreen {
  /**
   * Leave for a race in the car on the podium (the selected car when that one is not owned, e.g. the test
   * preview). `gesture`: called from a user gesture (audio may be unlocked).
   */
  start(gesture: boolean): void;
  destroy(): void;
}

/** Longest frame step the turntable advances, s (tab switches, debugger pauses). */
const MAX_FRAME_DT = 0.1;

export function enterGarage(
  app: App,
  opts: {
    lastShown: SaveData | null;
    /** Race `car` (owned; also saved as the selected car). */
    onStart(car: CarId): void;
    /** Test preview (`?test&car=<id>`): open on this car without changing the save. */
    previewCar?: CarId | null;
  },
): GarageScreen {
  const { garage, renderer } = app;
  let destroyed = false;
  let raf = 0;
  let last = -1;
  let time = 0;

  app.screen = 'garage';
  app.input.setRacing(false);
  app.audio.setEngineActive(false);

  const initialCar = opts.previewCar ?? app.save.selectedCar;
  garage.setCar(initialCar);
  /** The car on the podium (and on the card). */
  let shown: CarId = initialCar;

  /** The podium follows the browsed car; an owned one becomes the car of the next race. */
  function browse(id: CarId): void {
    shown = id;
    garage.setCar(id);
    if (app.save.ownedCars.includes(id) && app.save.selectedCar !== id) app.updateSave((s) => selectCar(s, id));
  }

  // Built with the save shown last time, then updated: coins earned since then pop in the wallet. A purchase
  // writes through app.updateSave; onSaveChanged below brings the new save (card, wallet) back to the UI.
  const ui = createGarageUI(app.ui, {
    save: opts.lastShown ?? app.save,
    trackName: app.track.def.name,
    onStart: (car) => start(true, car),
    onMute: (m) => app.setMuted(m),
    onGhosts: (on) => app.setGhosts(on),
    leaderboard: app.leaderboard,
    initialCar,
    onBrowse: browse,
    onBuy: (id) => purchaseCar(app, id).ok,
  });
  if (opts.lastShown) ui.update(app.save);
  // Coins or records saved by another tab while this garage is up.
  const offSave = app.onSaveChanged((save) => ui.update(save));

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
    offSave();
    ui.destroy();
    if (app.redraw === draw) app.redraw = null;
  }

  function start(gesture: boolean, car: CarId = shown): void {
    if (destroyed) return;
    // resume() must run synchronously inside the click / keydown to count as a user gesture.
    if (gesture) void app.audio.unlock();
    // The car on the podium races, even if another tab selected another one meanwhile.
    const racing = app.save.ownedCars.includes(car) ? car : app.save.selectedCar;
    if (app.save.selectedCar !== racing) app.updateSave((s) => selectCar(s, racing));
    destroy();
    opts.onStart(racing);
  }

  app.redraw = draw;
  raf = requestAnimationFrame(frame);
  return { start, destroy };
}
