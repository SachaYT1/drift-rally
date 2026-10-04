/**
 * Garage scene (design spec §6, user's garage reference): dark octagonal room with coral accent strips,
 * the car slowly turning on a round podium with a glowing golden rim; warm key light, a neutral podium fill
 * and red rim lights. The RoomEnvironment PMREM is applied to the car paint only (spec §5).
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarModel } from './carModel';
import { createCarRack } from './carRack';
import type { CarId } from '../shared/cars';

export interface GarageScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Car slowly rotates on the podium. `time` in seconds drives the rotation (deterministic). */
  update(dt: number, time: number): void;
  resize(width: number, height: number): void;
  /** The car on the podium. */
  readonly car: CarModel;
  /** Show this car of the line-up on the podium. */
  setCar(id: CarId): void;
  /**
   * RoomEnvironment PMREM used for the paint reflections (applied with `car.setEnvMap`). Owned by the
   * garage and never disposed. The race scene should reuse it via `raceCar.setEnvMap(garage.envMap)`, NOT
   * `raceScene.environment`: in three r186 `scene.environment` also lights every Lambert surface (spec §5:
   * the PMREM is for the car paint only).
   */
  readonly envMap: THREE.Texture;
}

const BACKGROUND = 0x0c0909;
const CORAL = 0xf0573a;
const GOLD = 0xf3b23c;
const ROOM_RADIUS = 17;
const ROOM_HEIGHT = 9;
const ROOM_SIDES = 8;
/** Distance from the room centre to the middle of each wall's inner face. */
export const GARAGE_ROOM_APOTHEM = ROOM_RADIUS * Math.cos(Math.PI / ROOM_SIDES);
const PODIUM_RADIUS = 3.6;
const PODIUM_TOP = 0.58;
/** Outermost podium radius (the base). */
export const GARAGE_PODIUM_OUTER_RADIUS = PODIUM_RADIUS + 0.4;
/** Turntable speed, rad/s, and the starting yaw that shows the car's front 3/4 like the reference. */
const SPIN_RATE = 0.22;
const START_YAW = 1.0;
/**
 * Camera framing: look-at point, pitch (rad), preferred distance and vertical FOV (deg). On narrow
 * screens the camera first pulls back, then (once it would leave the room) widens its FOV instead.
 */
const LOOK_AT = new THREE.Vector3(0, 1.45, 0);
const CAMERA_PITCH = 0.26;
const CAMERA_DISTANCE = 12;
const BASE_FOV = 36;
const MAX_FOV = 75;
/** Keep the camera this far (horizontally) in front of the wall behind it (its trims stick out 0.35 m). */
const WALL_CLEARANCE = 1.2;
const MAX_CAMERA_DISTANCE = (GARAGE_ROOM_APOTHEM - WALL_CLEARANCE) / Math.cos(CAMERA_PITCH);
/** Half-width (m) that must stay visible around the podium centre. */
const FIT_HALF_WIDTH = PODIUM_RADIUS + 1.6;

function lambert(color: number, flat = false): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: flat });
}

/** Box geometry translated/rotated in place (for merging). */
function boxAt(w: number, h: number, d: number, x: number, y: number, z: number, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz !== 0) g.rotateZ(rz);
  return g.translate(x, y, z);
}

function mergedMesh(geos: THREE.BufferGeometry[], mat: THREE.Material): THREE.Mesh {
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('garageScene: failed to merge geometries');
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false;
  return mesh;
}

const SLAT_WIDTH = 4.2;
/** Slat block centre along the back wall (+x = right as seen from the camera). */
const SLAT_X = 3.3;

/** Walls (flat panels), pilasters, slatted back wall, coral light strips, floor seams. */
function buildRoom(): THREE.Group {
  const room = new THREE.Group();
  const apothem = GARAGE_ROOM_APOTHEM;
  const wallWidth = 2 * ROOM_RADIUS * Math.sin(Math.PI / ROOM_SIDES);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(ROOM_RADIUS + 1, ROOM_SIDES), lambert(0x241b1a));
  floor.rotation.set(-Math.PI / 2, 0, Math.PI / ROOM_SIDES);
  floor.receiveShadow = true;
  room.add(floor);
  // Dark ceiling: only seen when narrow viewports widen the camera FOV (see garageCameraFraming).
  const ceiling = new THREE.Mesh(new THREE.CircleGeometry(ROOM_RADIUS + 1, ROOM_SIDES), lambert(0x1a1313));
  ceiling.rotation.set(Math.PI / 2, 0, Math.PI / ROOM_SIDES);
  ceiling.position.y = ROOM_HEIGHT;
  room.add(ceiling);

  // Floor seams: large square tiles.
  const seams: number[] = [];
  for (let v = -15; v <= 15; v += 3.75) {
    seams.push(v, 0.005, -16, v, 0.005, 16, -16, 0.005, v, 16, 0.005, v);
  }
  const seamGeo = new THREE.BufferGeometry();
  seamGeo.setAttribute('position', new THREE.Float32BufferAttribute(seams, 3));
  room.add(new THREE.LineSegments(seamGeo, new THREE.LineBasicMaterial({ color: 0x3a2d2a })));

  // One instance of every per-wall part is built in wall-local space (x along the wall, z toward the
  // centre), then copied around the octagon.
  const walls: THREE.BufferGeometry[] = [];
  const trims: THREE.BufferGeometry[] = [];
  const strips: THREE.BufferGeometry[] = [];
  const stripY = 2.3;
  const rise = 1.6;
  for (let i = 0; i < ROOM_SIDES; i++) {
    const angle = (i / ROOM_SIDES) * Math.PI * 2;
    const local: { walls: THREE.BufferGeometry[]; trims: THREE.BufferGeometry[]; strips: THREE.BufferGeometry[] } = {
      walls: [boxAt(wallWidth + 0.4, ROOM_HEIGHT, 0.3, 0, ROOM_HEIGHT / 2, -0.15)],
      trims: [
        boxAt(0.7, ROOM_HEIGHT, 0.5, -wallWidth / 2, ROOM_HEIGHT / 2, 0.1),
        boxAt(wallWidth, 0.18, 0.35, 0, 5.6, 0.1),
        boxAt(wallWidth, 0.4, 0.2, 0, 0.2, 0.05),
      ],
      // Coral strip: low run, diagonal ramp, high run (reads as the reference's angled light bars).
      strips: [
        boxAt(wallWidth * 0.42, 0.14, 0.08, -wallWidth * 0.29, stripY, 0.2),
        boxAt(Math.hypot(wallWidth * 0.16, rise), 0.14, 0.08, 0, stripY + rise / 2, 0.2, Math.atan2(rise, wallWidth * 0.16)),
        boxAt(wallWidth * 0.42, 0.14, 0.08, wallWidth * 0.29, stripY + rise, 0.2),
      ],
    };
    if (i === 0) {
      // Back wall (z = -apothem, behind the car as seen from the camera on +Z): a block of horizontal
      // slats right of the strip's ramp and below its high run, lit by the red glow.
      for (let s = 0; s < 6; s++) local.trims.push(boxAt(SLAT_WIDTH, 0.2, 0.3, SLAT_X, 0.8 + s * 0.46, 0.2));
    }
    const m = new THREE.Matrix4()
      .makeRotationY(angle)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -apothem));
    for (const g of local.walls) walls.push(g.applyMatrix4(m));
    for (const g of local.trims) trims.push(g.applyMatrix4(m));
    for (const g of local.strips) strips.push(g.applyMatrix4(m));
  }
  room.add(mergedMesh(walls, lambert(0x302423, true)));
  room.add(mergedMesh(trims, lambert(0x4d3934, true)));
  room.add(mergedMesh(strips, new THREE.MeshBasicMaterial({ color: CORAL })));

  room.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  });
  return room;
}

/** Static podium body (base, band with tick marks, golden rings). The rotating top is separate. */
function buildPodiumBase(goldMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(PODIUM_RADIUS + 0.3, PODIUM_RADIUS + 0.4, 0.2, 72), lambert(0x120e0d));
  base.position.y = 0.1;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(PODIUM_RADIUS + 0.06, PODIUM_RADIUS + 0.12, 0.34, 72), lambert(0x1d1716));
  band.position.y = 0.2 + 0.17;
  base.receiveShadow = band.receiveShadow = true;
  g.add(base, band);

  const lowRing = new THREE.Mesh(new THREE.TorusGeometry(PODIUM_RADIUS + 0.33, 0.035, 6, 120), goldMat);
  lowRing.rotation.x = Math.PI / 2;
  lowRing.position.y = 0.2;
  const topRing = new THREE.Mesh(new THREE.TorusGeometry(PODIUM_RADIUS + 0.04, 0.07, 8, 144), goldMat);
  topRing.rotation.x = Math.PI / 2;
  topRing.position.y = PODIUM_TOP - 0.03;
  g.add(lowRing, topRing);

  const ticks: THREE.BufferGeometry[] = [];
  const tickCount = 72;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * Math.PI * 2;
    const t = boxAt(0.05, 0.12, 0.03, 0, 0, 0);
    t.rotateY(a);
    const r = PODIUM_RADIUS + 0.11;
    ticks.push(t.translate(Math.sin(a) * r, 0.37, Math.cos(a) * r));
  }
  g.add(mergedMesh(ticks, goldMat));
  g.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  });
  return g;
}

function buildLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0x5a4646, 0x0a0606, 0.6));

  // Warm key light from the front-top, casting the car's shadow onto the podium.
  const key = new THREE.SpotLight(0xfff0e0, 260, 0, 0.42, 0.75, 2);
  key.position.set(3, 10, 6.5);
  key.target.position.set(0, PODIUM_TOP, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 6;
  key.shadow.camera.far = 20;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);

  // Coral rim lights behind the car (left/right), and a red glow on the back wall.
  const rimL = new THREE.PointLight(0xff5236, 28, 14, 2);
  rimL.position.set(5, 2.6, -4);
  const rimR = new THREE.PointLight(0xff3a26, 22, 14, 2);
  rimR.position.set(-5.5, 2.2, -3);
  const glow = new THREE.PointLight(0xff3018, 220, 22, 2);
  glow.position.set(1.5, 3.4, -11);
  // Neutral soft fill from the camera side, confined to the podium: keeps the hubs and the podium top
  // readable while the room stays dark (no IBL on Lambert surfaces).
  const fill = new THREE.SpotLight(0xfff4ea, 300, 0, 0.42, 0.7, 2);
  fill.position.set(-2, 7, 12);
  fill.target.position.set(0, 0.6, 0);
  scene.add(rimL, rimR, glow, fill, fill.target);
}

export interface GarageFraming {
  /** Vertical field of view, degrees. */
  fov: number;
  /** Camera distance from the look-at point along the pitched view axis, m. */
  distance: number;
}

/**
 * Camera framing for a viewport aspect (width / height). Keeps FIT_HALF_WIDTH visible around the podium:
 * first by pulling back (up to MAX_CAMERA_DISTANCE, so the camera stays inside the room), then by widening
 * the vertical FOV (capped at MAX_FOV).
 */
export function garageCameraFraming(aspect: number): GarageFraming {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const fitDistance = FIT_HALF_WIDTH / (Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2) * a);
  const distance = THREE.MathUtils.clamp(fitDistance, CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
  if (fitDistance <= distance) return { fov: BASE_FOV, distance };
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(FIT_HALF_WIDTH / (distance * a)));
  return { fov: Math.min(fov, MAX_FOV), distance };
}

/** Apply garageCameraFraming(aspect) to `camera`: aspect, FOV, position on the +Z side, look-at. */
export function applyGarageFraming(camera: THREE.PerspectiveCamera, aspect: number): void {
  const { fov, distance } = garageCameraFraming(aspect);
  camera.aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  camera.fov = fov;
  camera.updateProjectionMatrix();
  camera.position.set(
    LOOK_AT.x,
    LOOK_AT.y + Math.sin(CAMERA_PITCH) * distance,
    LOOK_AT.z + Math.cos(CAMERA_PITCH) * distance,
  );
  camera.lookAt(LOOK_AT);
}

function createEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const texture = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  return texture;
}

export function createGarageScene(renderer: THREE.WebGLRenderer): GarageScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.Fog(BACKGROUND, 18, 44);
  // The PMREM goes on the car paint only (car.setEnvMap below), never on scene.environment.
  const envMap = createEnvMap(renderer);

  const camera = new THREE.PerspectiveCamera(BASE_FOV, 16 / 9, 0.5, 120);

  const goldMat = new THREE.MeshBasicMaterial({ color: GOLD });
  scene.add(buildRoom(), buildPodiumBase(goldMat));
  buildLights(scene);

  // Turntable: podium top + car rotate together.
  const turntable = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(PODIUM_RADIUS, PODIUM_RADIUS, 0.08, 72), lambert(0x6c5f57));
  top.position.y = PODIUM_TOP - 0.04;
  top.receiveShadow = true;
  const inner = new THREE.Mesh(new THREE.TorusGeometry(PODIUM_RADIUS - 0.35, 0.025, 4, 120), lambert(0x857669));
  inner.rotation.x = Math.PI / 2;
  inner.position.y = PODIUM_TOP;
  turntable.add(top, inner);
  const rack = createCarRack(turntable, (car) => {
    car.setEnvMap(envMap);
    car.root.position.y = PODIUM_TOP;
  });
  turntable.rotation.y = START_YAW;
  scene.add(turntable);

  function resize(width: number, height: number): void {
    applyGarageFraming(camera, width > 0 && height > 0 ? width / height : 16 / 9);
  }
  resize(16, 9);

  return {
    scene,
    camera,
    get car() {
      return rack.current;
    },
    setCar(id: CarId): void {
      rack.show(id);
    },
    envMap,
    update(_dt: number, time: number): void {
      turntable.rotation.y = START_YAW + time * SPIN_RATE;
    },
    resize,
  };
}
