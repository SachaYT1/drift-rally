/**
 * The race scene, built once during loading and reused by every race (retries never rebuild or dispose
 * anything): lighting environment, track surface, static world, props, bombs, effects, the car, the ghost cars
 * of the bots and the chase camera with the occlusion fader. sync() applies one render state; onEvent() routes
 * session events to the scene-side consumers (effects, props, camera shake, the car's bomb hop).
 */
import * as THREE from 'three';
import type { CarState, GameEvent, QualityLevel, SurfaceKind } from '../shared/types';
import { TUNING } from '../shared/tuning';
import type { Track } from '../track/build';
import type { AssetLibrary } from '../core/assets';
import { createPickups, type PickupState } from '../game/pickups';
import type { BombState } from '../game/bombs';
import { createCarState } from '../physics/car';
import { createRaceEnvironment, type RaceEnvironment } from '../render/environment';
import { createTrackMesh } from '../render/trackMesh';
import { createWorld } from '../render/world';
import { createOcclusionFader, type OcclusionFader } from '../render/occlusion';
import { createPropsLayer, type PropsLayer } from '../render/props';
import { createBombsLayer } from '../render/bombs';
import { createFx, type Fx } from '../render/fx';
import { createChaseCamera, type ChaseCamera } from '../render/chaseCamera';
import type { CarModel } from '../render/carModel';
import { createCarRack } from '../render/carRack';
import type { CarId } from '../shared/cars';
import { createGhostLayer, type GhostView } from '../render/ghostCars';
import { BOTS } from '../game/bots';
import { applyPose } from '../render/bridge';
import { separateInstancedShadowCasters } from '../render/shadowCasters';

/** Paint reflection strength of the race car (integration notes). */
const RACE_ENV_INTENSITY = 0.6;
/** Height of the point the occlusion test aims at (car body centre), m. */
const CAR_CENTRE_Y = 0.6;

/** One render state of the race. */
export interface RaceFrame {
  /** Car to draw (interpolated render state). */
  car: CarState;
  /** Car as seen by the tyre effects (e.g. parked after the finish); defaults to `car`. */
  effectsCar?: CarState;
  surface: SurfaceKind;
  pickups: PickupState;
  /** Bombs blown this lap; absent (or null) shows every bomb. */
  bombs?: BombState | null;
  /** Simulation clock for the coin animation, s (freezes while paused). */
  simTime: number;
  /** Teleport (race start, respawn): place camera and car model without smoothing. */
  snap: boolean;
  /** The bots' ghosts, in roster order; null / absent: no ghosts (switched off). */
  ghosts?: readonly GhostView[] | null;
}

export interface RaceScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly env: RaceEnvironment;
  /** The visible car. */
  readonly car: CarModel;
  readonly chase: ChaseCamera;
  readonly fx: Fx;
  readonly props: PropsLayer;
  readonly fader: OcclusionFader;
  /** Race this car of the line-up (call before reset()). */
  setCar(id: CarId): void;
  /** Start state for a new race: effects cleared, props restored, faders opaque, car at the spawn pose. */
  reset(): void;
  /** Apply one render state; `dt` = seconds since the previous sync (frame or fixed step). */
  sync(f: RaceFrame, dt: number): void;
  /** Effects, props, camera shake and the car's bomb hop for one session event. */
  onEvent(e: GameEvent): void;
  /** Hide the bots' ghosts until the next sync with ghosts (a still frame behind the results). */
  hideGhosts(): void;
  setAspect(aspect: number): void;
  render(renderer: THREE.WebGLRenderer): void;
}

export function createRaceScene(
  renderer: THREE.WebGLRenderer,
  track: Track,
  assets: AssetLibrary,
  quality: QualityLevel,
  envMap: THREE.Texture,
): RaceScene {
  const env = createRaceEnvironment(renderer, quality);
  const { scene } = env;
  const world = createWorld(track, assets);
  scene.add(createTrackMesh(track), world.group);
  const props = createPropsLayer(track, assets);
  scene.add(props.group);
  const bombs = createBombsLayer(track);
  scene.add(bombs.group);
  const fx = createFx(scene);
  // Paint reflections from the garage PMREM; never scene.environment (it would light every Lambert surface).
  const rack = createCarRack(scene, (model) => model.setEnvMap(envMap, RACE_ENV_INTENSITY));
  const ghosts = createGhostLayer();
  ghosts.setRoster(BOTS);
  scene.add(ghosts.group);
  // Coins and props are instanced shadow casters: keep three's shared shadow depth program from flipping.
  separateInstancedShadowCasters(scene);

  const camera = new THREE.PerspectiveCamera(TUNING.camera.fov, 16 / 9, TUNING.camera.near, TUNING.camera.far);
  const chase = createChaseCamera(camera);
  const fader = createOcclusionFader(world.occluders);
  const carCentre = new THREE.Vector3();
  const spawn = track.spawnPose;

  function sync(f: RaceFrame, dt: number): void {
    const car = rack.current;
    const c = f.car;
    if (f.snap) car.reset();
    applyPose(car.root, c.x, c.z, c.heading);
    car.update(c, f.snap ? 0 : dt);
    if (f.snap) chase.snap(c);
    else chase.update(c, dt);
    // Shadow box ahead of the car along the camera yaw (car -> look-at point), not around the look-at point.
    env.updateShadows(c.x, c.z, chase.target.x - c.x, chase.target.z - c.z);
    carCentre.set(c.x, CAR_CENTRE_Y, c.z);
    fader.update(camera, carCentre, dt);
    fx.update(f.effectsCar ?? c, f.surface, dt);
    props.update(f.pickups, f.simTime, dt);
    bombs.update(f.bombs ?? null, f.simTime);
    if (f.ghosts) ghosts.update(f.ghosts, dt, camera.position);
    else ghosts.hide();
  }

  function reset(): void {
    fx.reset();
    props.resetLap();
    fader.reset();
    sync({ car: createCarState(spawn.x, spawn.z, spawn.heading), surface: 'road', pickups: createPickups(), simTime: 0, snap: true }, 0);
  }

  function onEvent(e: GameEvent): void {
    fx.onEvent(e);
    props.onEvent(e);
    if (e.type === 'lap') props.resetLap();
    else if (e.type === 'hit') chase.shake(TUNING.camera.shakePerImpact * e.impactSpeed);
    else if (e.type === 'bomb') {
      chase.shake(TUNING.camera.shakePerImpact * TUNING.bomb.shakeImpact);
      rack.current.hop();
    }
  }

  reset();

  return {
    scene,
    camera,
    env,
    get car() {
      return rack.current;
    },
    setCar(id: CarId): void {
      rack.show(id);
    },
    chase,
    fx,
    props,
    fader,
    reset,
    sync,
    onEvent,
    hideGhosts: () => ghosts.hide(),
    setAspect(aspect: number): void {
      if (!(aspect > 0) || camera.aspect === aspect) return;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
    render(r: THREE.WebGLRenderer): void {
      r.render(scene, camera);
    },
  };
}
