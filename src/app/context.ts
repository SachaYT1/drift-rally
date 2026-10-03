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
import { writeSave } from '../core/save';
import type { RaceScene } from './raceScene';

export type ScreenName = 'loading' | 'garage' | 'race' | 'results';

export interface TestFlags {
  /** `?test`: the test hook drives the simulation; requestAnimationFrame only renders. */
  enabled: boolean;
  /** `?test&small`: quality low, pixel ratio 1, drawing buffer at most SMALL_BUFFER. */
  small: boolean;
}

/** Drawing-buffer bound in `?test&small` mode, CSS px (the canvas still fills the window). */
export const SMALL_BUFFER = { width: 640, height: 360 } as const;

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
  readonly save: SaveData;
  /** Replace the save and persist it (storage failures are ignored: the game keeps running). */
  setSave(next: SaveData): void;
  readonly quality: QualityLevel;
  /** Apply a quality preset (pixel ratio, shadows) and persist it. */
  setQuality(q: QualityLevel): void;
  /** Mute / unmute and persist it. */
  setMuted(m: boolean): void;
  screen: ScreenName;
  /** Re-render the active view once (resize while paused or behind an overlay). */
  redraw: (() => void) | null;
  /** Call after every rendered frame: frame hooks (DEV stats) and the FPS counter. */
  frameDone(): void;
  /** Register a per-frame hook; returns the unregister function. */
  onFrame(cb: () => void): () => void;
  /** Frames per second over the last full second (0 until measured). */
  readonly fps: number;
  /** Recompute the drawing-buffer size and camera aspects from the canvas size. */
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
  save: SaveData;
  quality: QualityLevel;
  /** Quality is a test override: apply it, never persist it. */
  qualityOverride: boolean;
}

/** Drawing-buffer size for a canvas of w x h CSS px (bounded in small test mode). */
export function bufferSize(w: number, h: number, small: boolean): { width: number; height: number } {
  if (!small) return { width: w, height: h };
  const k = Math.min(1, SMALL_BUFFER.width / w, SMALL_BUFFER.height / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export function createApp(d: AppDeps): App {
  let save = d.save;
  let quality = d.quality;
  const hooks = new Set<() => void>();
  let fps = 0;
  let frames = 0;
  let windowStart = -1;

  d.audio.setMuted(save.muted);

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
    get save() {
      return save;
    },
    setSave(next) {
      save = next;
      writeSave(next);
    },
    get quality() {
      return quality;
    },
    setQuality(q) {
      if (q === quality) return;
      quality = q;
      d.race.env.setQuality(q);
      if (!d.qualityOverride) app.setSave({ ...save, quality: q });
      app.resize();
    },
    setMuted(m) {
      d.audio.setMuted(m);
      if (m !== save.muted) app.setSave({ ...save, muted: m });
    },
    screen: 'loading',
    redraw: null,
    frameDone() {
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
      const w = d.canvas.clientWidth;
      const h = d.canvas.clientHeight;
      if (!(w > 0 && h > 0)) return;
      const size = bufferSize(w, h, d.test.small);
      d.renderer.setSize(size.width, size.height, false);
      d.garage.resize(w, h);
      d.race.setAspect(w / h);
      app.redraw?.();
    },
  };
  return app;
}
