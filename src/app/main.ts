/**
 * Bootstrap and screen flow (design spec §5, §7): mobile check -> renderer (no-WebGL screen on failure) ->
 * context-loss screen -> save and quality -> loading (fonts, assets, both scenes compiled and prewarmed) ->
 * one ResizeObserver for the renderer and both cameras -> garage <-> race.
 */
import type * as THREE from 'three';
import type { QualityLevel, SaveData } from '../shared/types';
import { loadSave } from '../core/save';
import { detectQuality } from '../core/quality';
import { createInput } from '../core/input';
import { createAudio } from '../audio/sfx';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { applyRendererQuality, createRenderer } from '../render/environment';
import { isProbablyMobile, showFatal, showLoading } from '../ui/screens';
import { createApp, testFlagsFrom, watchPixelRatio, type App } from './context';
import { compileAndPrewarm, loadScenes } from './loading';
import { enterGarage, type GarageScreen } from './garageScreen';
import { enterRace, type RaceScreen } from './raceScreen';
import { installTestHook } from './testHook';

declare global {
  interface Window {
    /** Set once the garage is on screen (dev screenshot tooling waits for it). */
    __previewReady?: boolean;
  }
}

/** Loading screen fade-out, ms (styles.css .dr-screen transition) plus a frame of margin. */
const LOADING_FADE_MS = 420;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

/** GPU name for auto quality; Chrome masks gl.RENDERER, Firefox deprecates the debug extension. */
function rendererName(renderer: THREE.WebGLRenderer): string | null {
  const gl = renderer.getContext();
  const basic: unknown = gl.getParameter(gl.RENDERER);
  if (typeof basic === 'string' && !/^webkit webgl$/i.test(basic)) return basic;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name: unknown = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : basic;
  return typeof name === 'string' ? name : null;
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // `?test`: render contract (low, pixel ratio 1, <= 640x360) unless `&full` / `&quality=` opt out.
  const { test, quality: forced } = testFlagsFrom(params);
  const canvas = byId<HTMLCanvasElement>('game');
  const ui = byId('ui');

  let app: App | null = null;
  let garageScreen: GarageScreen | null = null;
  let raceScreen: RaceScreen | null = null;
  let lastShownSave: SaveData | null = null;
  let halted = false;
  let markReady = (): void => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  function goGarage(): void {
    if (!app || halted) return;
    raceScreen = null;
    garageScreen = enterGarage(app, { lastShown: lastShownSave, onStart: goRace });
    lastShownSave = app.save;
  }

  function goRace(): void {
    if (!app || halted) return;
    const input = app.input;
    garageScreen = null;
    // Test mode: the hook steps the simulation; rAF only renders until __game.realtime() says otherwise.
    raceScreen = enterRace(app, { source: test.enabled ? null : () => input.sample(), onGarage: goGarage });
  }

  if (test.enabled) {
    installTestHook({
      app: () => app,
      ready,
      race: () => raceScreen,
      startRace() {
        if (garageScreen) garageScreen.start(false);
        else raceScreen?.restart();
      },
    });
  } else if (isProbablyMobile()) {
    showFatal(ui, 'mobile');
    return;
  }

  const save = loadSave();
  let quality: QualityLevel = forced ?? save.quality ?? 'medium';
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = createRenderer(canvas, quality);
  } catch (err) {
    console.warn('WebGL unavailable:', err);
    showFatal(ui, 'noWebGL');
    return;
  }
  if (!forced && save.quality === null) {
    quality = detectQuality(rendererName(renderer));
    applyRendererQuality(renderer, quality);
  }

  const audio = createAudio();
  const input = createInput(window);
  canvas.addEventListener('webglcontextlost', () => {
    halted = true;
    raceScreen?.destroy();
    garageScreen?.destroy();
    raceScreen = null;
    garageScreen = null;
    audio.suspend();
    input.setRacing(false);
    showFatal(ui, 'contextLost');
  });

  const loading = showLoading(ui);
  const track = buildTrack(PLAZA);
  const scenes = await loadScenes(renderer, track, quality, (f) => loading.setProgress(f));
  app = createApp({
    renderer,
    canvas,
    ui,
    track,
    garage: scenes.garage,
    race: scenes.race,
    audio,
    input,
    test,
    save,
    quality,
    qualityOverride: forced !== null,
  });
  const appRef = app;
  appRef.resize();
  new ResizeObserver(() => appRef.resize()).observe(canvas);
  watchPixelRatio(window, () => appRef.resize());
  await compileAndPrewarm(renderer, scenes, track, (f) => loading.setProgress(f));
  if (halted) return;

  if (import.meta.env.DEV && (!test.enabled || params.has('debug'))) {
    import('./debugGui')
      .then((m) => m.installDebugGui(appRef))
      .catch((err: unknown) => console.warn('Debug GUI unavailable:', err));
  }

  loading.setProgress(1);
  loading.hide();
  goGarage();
  markReady();
  window.setTimeout(() => (window.__previewReady = true), LOADING_FADE_MS);
}

boot().catch((err: unknown) => {
  console.error('Drift Rally failed to start:', err);
});
