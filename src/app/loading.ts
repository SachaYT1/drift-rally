/**
 * Loading pipeline (design spec §5 "Rendering rules"): fonts + Kenney assets in parallel, both scenes built,
 * compileAsync of BOTH scenes, then one hidden prewarm frame of each (behind the opaque loading screen) with
 * the race effects visible, so the first garage and race frames do not hitch on shader or buffer uploads.
 */
import type * as THREE from 'three';
import type { CarState, QualityLevel } from '../shared/types';
import type { AssetLibrary } from '../core/assets';
import { loadAssets } from '../core/assets';
import { createCarState } from '../physics/car';
import { createPickups } from '../game/pickups';
import { BOTS } from '../game/bots';
import { GHOST_OPACITY, type GhostView } from '../render/ghostCars';
import type { Track } from '../track/build';
import { createGarageScene, type GarageScene } from '../render/garageScene';
import { fontsReady } from '../ui/screens';
import { createRaceScene, type RaceScene } from './raceScene';

/** Share of the progress bar per phase (sums to 1). */
const WEIGHT = { fonts: 0.1, assets: 0.65, build: 0.1, compile: 0.15 } as const;
/** Prewarm drift: speed (m/s), slip (rad), frames and frame time (s): enough for smoke puffs and a skid strip. */
const PREWARM = { speed: 20, slip: 0.6, frames: 4, dt: 0.1 } as const;

export interface LoadedScenes {
  assets: AssetLibrary;
  garage: GarageScene;
  race: RaceScene;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Fonts + assets, then both scenes. `onProgress` receives 0..1. */
export async function loadScenes(
  renderer: THREE.WebGLRenderer,
  track: Track,
  quality: QualityLevel,
  onProgress: (f: number) => void,
): Promise<LoadedScenes> {
  let fonts = 0;
  let assetShare = 0;
  const report = (extra = 0): void => onProgress(fonts * WEIGHT.fonts + assetShare * WEIGHT.assets + extra);
  report();
  const [assets] = await Promise.all([
    loadAssets((f) => {
      assetShare = f;
      report();
    }),
    fontsReady().then(() => {
      fonts = 1;
      report();
    }),
  ]);
  const garage = createGarageScene(renderer);
  const race = createRaceScene(renderer, track, assets, quality, garage.envMap);
  report(WEIGHT.build);
  // Let the progress bar paint before the (blocking) shader work.
  await nextFrame();
  return { assets, garage, race };
}

/** The bots' ghosts in a row ahead of the prewarm car, opaque enough to draw (their programs and labels compile). */
function prewarmGhosts(car: CarState, fx: number, fz: number): GhostView[] {
  return BOTS.map((_, i) => ({
    car: { ...car, x: car.x + fx * (14 + 6 * i), z: car.z + fz * (14 + 6 * i) },
    points: 0,
    opacity: GHOST_OPACITY,
    visible: true,
    snap: false,
  }));
}

/** Compile both scenes, then render one hidden frame of each with the race effects (and ghosts) on screen. */
export async function compileAndPrewarm(
  renderer: THREE.WebGLRenderer,
  scenes: LoadedScenes,
  track: Track,
  onProgress: (f: number) => void,
): Promise<void> {
  const { garage, race } = scenes;
  const base = WEIGHT.fonts + WEIGHT.assets + WEIGHT.build;
  await renderer.compileAsync(garage.scene, garage.camera);
  onProgress(base + WEIGHT.compile / 2);
  await renderer.compileAsync(race.scene, race.camera);
  onProgress(base + WEIGHT.compile);

  const pose = track.spawnPose;
  const fx = Math.sin(pose.heading);
  const fz = Math.cos(pose.heading);
  const car: CarState = {
    ...createCarState(pose.x, pose.z, pose.heading + PREWARM.slip),
    vx: fx * PREWARM.speed,
    vz: fz * PREWARM.speed,
    speed: PREWARM.speed,
    forwardSpeed: PREWARM.speed * Math.cos(PREWARM.slip),
    lateralSpeed: -PREWARM.speed * Math.sin(PREWARM.slip),
    slip: PREWARM.slip,
    mode: 'drift',
    driftDir: 1,
    rpm: 0.8,
  };
  race.onEvent({ type: 'coin', id: -1, x: pose.x + fx * 6, z: pose.z + fz * 6 });
  race.onEvent({ type: 'hit', impactSpeed: 10, x: pose.x + fx * 3, z: pose.z + fz * 3 });
  const pickups = createPickups();
  for (let i = 0; i < PREWARM.frames; i++) {
    const step = i * PREWARM.speed * PREWARM.dt;
    const drawn = { ...car, x: car.x + fx * step, z: car.z + fz * step };
    race.sync(
      { car: drawn, surface: 'road', pickups, simTime: i * PREWARM.dt, snap: i === 0, ghosts: prewarmGhosts(drawn, fx, fz) },
      PREWARM.dt,
    );
  }
  race.render(renderer);
  renderer.render(garage.scene, garage.camera);
  race.reset();
}
