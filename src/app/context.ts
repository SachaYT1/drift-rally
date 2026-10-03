/**
 * The app-wide context shared by the screens: one renderer, both resident scenes, audio, input, the save
 * and the render settings. Created once by main.ts after loading.
 */
import type * as THREE from 'three';
import type { QualityLevel, SaveData } from '../shared/types';
import type { Track } from '../track/build';
import type { GarageScene } from '../render/garageScene';
import type { GameAudio } from '../audio/sfx';
import type { InputController } from '../core/input';
import type { Leaderboard } from './leaderboard';
import { SAVE_KEY, readSave, updateSave } from '../core/save';
import { isQualityLevel, pixelRatioFor } from '../core/quality';
import type { RaceScene } from './raceScene';

export type ScreenName = 'loading' | 'garage' | 'race' | 'results';

export interface TestFlags {
  /** `?test`: the test hook drives the simulation; requestAnimationFrame only renders. */
  enabled: boolean;
  /**
   * The test-mode render contract (plan Task 16, design spec §8): quality low, pixel ratio 1, drawing buffer
   * at most SMALL_BUFFER. On by default with `?test`; `&full` or `&quality=<level>` opt out.
   */
  small: boolean;
}

/** Drawing-buffer bound of the test-mode render contract, CSS px (the canvas still fills the window). */
export const SMALL_BUFFER = { width: 640, height: 360 } as const;

/**
 * Test flags from the URL. Plain `?test` (and `?test&small`) applies the render contract. Full-size opt-outs
 * for screenshots and FPS runs: `?test&full` keeps the saved / auto quality, `?test&quality=<level>` forces a
 * level without persisting it. Outside test mode the URL never changes the quality.
 */
export function testFlagsFrom(params: URLSearchParams): { test: TestFlags; quality: QualityLevel | null } {
  const enabled = params.has('test');
  const urlQuality = params.get('quality');
  const wanted = enabled && isQualityLevel(urlQuality) ? urlQuality : null;
  const small = enabled && !params.has('full') && wanted === null;
  return { test: { enabled, small }, quality: small ? 'low' : wanted };
}

export interface App {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** UI root (#ui): HUD, pause menu and every overlay share it. */
  readonly ui: HTMLElement;
  readonly track: Track;
  readonly garage: GarageScene;
  readonly race: RaceScene;
  readonly audio: GameAudio;
  readonly input: InputController;
  readonly test: TestFlags;
  /** Friends leaderboard; null: off (unit tests). */
  readonly leaderboard: Leaderboard | null;
  /**
   * Progress (coins, records) as stored, kept current across tabs by the 'storage' event; settings (quality,
   * muted, ghosts) are this tab's live state.
   */
  readonly save: SaveData;
  /**
   * Read-modify-write on the save as stored NOW (another tab may have written since this one loaded): `change`
   * gets the stored save (this tab's copy when storage is unreachable); the result is persisted and adopted,
   * except its settings: change those with setQuality / setMuted / setGhosts. Storage failures are ignored.
   */
  updateSave(change: (current: SaveData) => SaveData): SaveData;
  /** Called after app.save's progress changed (this tab's writes and other tabs'); returns the unsubscribe. */
  onSaveChanged(cb: (save: Readonly<SaveData>) => void): () => void;
  readonly quality: QualityLevel;
  /** Apply a quality preset (pixel ratio, shadows) and persist it. */
  setQuality(q: QualityLevel): void;
  /** Mute / unmute and persist it. */
  setMuted(m: boolean): void;
  /** Race the ghost bots from the next race on, and persist it. */
  setGhosts(on: boolean): void;
  screen: ScreenName;
  /** Re-render the active view once (resize while paused or behind an overlay). */
  redraw: (() => void) | null;
  /** Call after every rendered frame: frame hooks (DEV stats) and the FPS counter. */
  frameDone(): void;
  /** Register a per-frame hook; returns the unregister function. */
  onFrame(cb: () => void): () => void;
  /** Frames per second over the last full second (0 until measured). */
  readonly fps: number;
  /** Recompute the pixel ratio, drawing-buffer size and camera aspects (canvas size or devicePixelRatio changed). */
  resize(): void;
}

export interface AppDeps {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  ui: HTMLElement;
  track: Track;
  garage: GarageScene;
  race: RaceScene;
  audio: GameAudio;
  input: InputController;
  test: TestFlags;
  /**
   * The save read at boot: its settings become this tab's live settings; its progress is replaced by the save
   * as stored when createApp() runs (another tab may have finished a race while this one was loading).
   */
  save: SaveData;
  quality: QualityLevel;
  /** Quality is a test override: apply it, never persist it. */
  qualityOverride: boolean;
  /** Where the save is stored (default localStorage; null: nowhere, progress lives in memory only). */
  storage?: Storage | null;
  /** Where other tabs' 'storage' events arrive (default window). */
  storageEvents?: EventTarget;
  /** Friends leaderboard (default: none). */
  leaderboard?: Leaderboard | null;
}

/** Drawing-buffer size for a canvas of w x h CSS px (bounded in small test mode). */
export function bufferSize(w: number, h: number, small: boolean): { width: number; height: number } {
  if (!small) return { width: w, height: h };
  const k = Math.min(1, SMALL_BUFFER.width / w, SMALL_BUFFER.height / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Renderer pixel ratio: the quality cap of devicePixelRatio, always 1 under the test render contract. */
export function pixelRatioOf(quality: QualityLevel, devicePixelRatio: number, small: boolean): number {
  return small ? 1 : pixelRatioFor(quality, devicePixelRatio);
}

/**
 * Calls `onChange` whenever devicePixelRatio changes (window moved to a monitor with another DPR). The
 * ResizeObserver misses that when the canvas keeps its CSS size. Returns the function that stops watching.
 */
export function watchPixelRatio(win: Pick<Window, 'devicePixelRatio' | 'matchMedia'>, onChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  const fire = (): void => {
    arm();
    onChange();
  };
  function arm(): void {
    query?.removeEventListener('change', fire);
    query = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    query.addEventListener('change', fire);
  }
  arm();
  return () => query?.removeEventListener('change', fire);
}

/** Coins and records equal (settings aside). */
function sameProgress(a: Readonly<SaveData>, b: Readonly<SaveData>): boolean {
  return a.coins === b.coins && a.bestScore === b.bestScore && a.bestLapMs === b.bestLapMs;
}

/** Make three re-evaluate the shader program of every material under `root` on its next use. */
function refreshMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m: unknown = (o as THREE.Mesh).material;
    if (Array.isArray(m)) for (const x of m as THREE.Material[]) x.needsUpdate = true;
    else if (m) (m as THREE.Material).needsUpdate = true;
  });
}

export function createApp(d: AppDeps): App {
  let save = d.save;
  let quality = d.quality;
  const hooks = new Set<() => void>();
  const saveListeners = new Set<(save: Readonly<SaveData>) => void>();
  /** The last write failed (storage full or gone): this tab's save is ahead of the stored one. */
  let unwritten = false;
  let fps = 0;
  let frames = 0;
  let windowStart = -1;
  /** devicePixelRatio of the last resize(). */
  let appliedDpr = 0;

  d.audio.setMuted(save.muted);

  /** Adopt a stored save as app.save, keeping this tab's live settings; tell the listeners if progress moved. */
  function adopt(stored: SaveData): void {
    const prev = save;
    save = { ...stored, quality: prev.quality, muted: prev.muted, ghosts: prev.ghosts };
    if (!sameProgress(prev, save)) for (const cb of [...saveListeners]) cb(save);
  }

  /** Write one setting into the stored save (nothing else of it) and into this tab's settings. */
  function patchSetting(patch: Partial<Pick<SaveData, 'quality' | 'muted' | 'ghosts'>>): void {
    save = { ...save, ...patch };
    app.updateSave((current) => ({ ...current, ...patch }));
  }

  // d.save is the boot-time snapshot, read before seconds of loading during which nothing listened for
  // 'storage': adopt the progress stored NOW, then listen from this same task on, so no write is missed.
  const atStart = readSave(d.storage);
  if (atStart) adopt(atStart);

  // Another tab saved (a finished race, a setting) or cleared the storage: follow its progress.
  (d.storageEvents ?? window).addEventListener('storage', (e) => {
    const key = 'key' in e ? e.key : null;
    if (key !== null && key !== SAVE_KEY) return;
    const stored = readSave(d.storage);
    if (stored) adopt(stored);
  });

  const app: App = {
    renderer: d.renderer,
    canvas: d.canvas,
    ui: d.ui,
    track: d.track,
    garage: d.garage,
    race: d.race,
    audio: d.audio,
    input: d.input,
    test: d.test,
    leaderboard: d.leaderboard ?? null,
    get save() {
      return save;
    },
    updateSave(change) {
      const next = updateSave(change, save, d.storage, unwritten);
      unwritten = !next.written;
      adopt(next.save);
      return save;
    },
    onSaveChanged(cb) {
      saveListeners.add(cb);
      return () => saveListeners.delete(cb);
    },
    get quality() {
      return quality;
    },
    setQuality(q) {
      if (q === quality) return;
      quality = q;
      d.race.env.setQuality(q);
      // The shadow toggle changes shader variants. The race sun's castShadow flips with it, but the garage key
      // light's does not, so three would keep sampling a stale shadow map there: flag every material of both
      // scenes for a program refresh and compile the new variants in the background.
      for (const [scene, camera] of [[d.garage.scene, d.garage.camera], [d.race.scene, d.race.camera]] as const) {
        refreshMaterials(scene);
        d.renderer.compileAsync(scene, camera).catch((err: unknown) => console.warn('Shader precompile failed:', err));
      }
      if (!d.qualityOverride) patchSetting({ quality: q });
      app.resize();
    },
    setMuted(m) {
      d.audio.setMuted(m);
      if (m !== save.muted) patchSetting({ muted: m });
    },
    setGhosts(on) {
      if (on !== save.ghosts) patchSetting({ ghosts: on });
    },
    screen: 'loading',
    redraw: null,
    frameDone() {
      // Media-query change events miss some devicePixelRatio changes (DevTools / CDP device emulation): a
      // property read per frame catches those too. watchPixelRatio() covers the paused screens.
      if (window.devicePixelRatio !== appliedDpr) app.resize();
      const now = performance.now();
      if (windowStart < 0) windowStart = now;
      frames++;
      if (now - windowStart >= 1000) {
        fps = (frames * 1000) / (now - windowStart);
        frames = 0;
        windowStart = now;
      }
      for (const cb of hooks) cb();
    },
    onFrame(cb) {
      hooks.add(cb);
      return () => hooks.delete(cb);
    },
    get fps() {
      return fps;
    },
    resize() {
      appliedDpr = window.devicePixelRatio;
      const w = d.canvas.clientWidth;
      const h = d.canvas.clientHeight;
      if (!(w > 0 && h > 0)) return;
      // Re-read devicePixelRatio every time: it changes when the window moves to another monitor.
      const ratio = pixelRatioOf(quality, appliedDpr, d.test.small);
      if (d.renderer.getPixelRatio() !== ratio) d.renderer.setPixelRatio(ratio);
      const size = bufferSize(w, h, d.test.small);
      d.renderer.setSize(size.width, size.height, false);
      d.garage.resize(w, h);
      d.race.setAspect(w / h);
      app.redraw?.();
    },
  };
  return app;
}
