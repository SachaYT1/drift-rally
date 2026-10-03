/**
 * Procedural low-poly car «Искра» (open-top toy buggy from the user's garage reference).
 *
 * Model space: built facing +Z, local +X = LEFT side, origin at ground centre (see bridge.ts).
 * Hierarchy: root -> body (pivot at axle height; roll/pitch) -> merged body parts,
 *            root -> 4 wheel pivots (front ones steer about Y) -> spin group (rolls about X) -> wheel mesh.
 * Parts are merged per material: 3 body meshes + 4 wheel meshes (7 draw calls).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarState } from '../shared/types';
import { TUNING } from '../shared/tuning';
import { TAU, clamp, damp } from '../shared/math';

export interface CarModel {
  /** Built facing +Z, origin at ground centre. Pose it with bridge.applyPose(). */
  root: THREE.Group;
  /**
   * Front wheels: in 'grip' mode they steer by car.steer (softened with speed); in 'drift' mode they
   * counter-steer toward the velocity (-slip * COUNTER_STEER_GAIN + a DRIFT_STEER_SHARE of car.steer), which
   * is what makes a drift read as a drift. Wheels spin by car.wheelSpin; the body rolls with lateral accel
   * and pitches with accel (from the velocity change between calls, capped so hard hits give a short jolt).
   * dt <= 0 snaps the front wheels to the state and leaves the suspension untouched.
   */
  update(car: CarState, dt: number): void;
  /**
   * Visual hop of the whole car (bomb blast): the root rises and falls back over ~0.45 s. Rendering only;
   * update() writes root.position.y while airborne (call it after bridge.applyPose(), which zeroes y).
   */
  hop(): void;
  setColor(hex: number): void;
  /**
   * Reflections for the paint only (the only MeshStandardMaterial). Do not use `scene.environment` for
   * this: in three r186 it also adds image-based diffuse light to every Lambert/Phong surface.
   */
  setEnvMap(tex: THREE.Texture | null, intensity?: number): void;
  /**
   * Settle the model instantly: level body, straight front wheels. Call on respawn / teleport (the
   * session's `teleported` flag) or when reusing the model; update() never resets on its own.
   */
  reset(): void;
}

export const DEFAULT_CAR_COLOR = 0xf0573a;
/** Default paint reflection strength for setEnvMap(). */
export const DEFAULT_ENV_INTENSITY = 0.35;

// ---- Visual-only constants (not gameplay tuning) ----
const WHEEL_WIDTH = 0.35;
/** Hub disc + cap protrude this far beyond the tyre's outer face; the car width includes them. */
const CAP_OUT = 0.045;
/** Front wheel angle in grip mode is divided by (1 + |vf| * STEER_SPEED_SOFTEN / steerSpeedRef). */
const STEER_SPEED_SOFTEN = 0.5;
/** While drifting the front wheels counter-steer toward the velocity: angle = -slip * gain + steer share. */
const COUNTER_STEER_GAIN = 0.8;
const DRIFT_STEER_SHARE = 0.25;
const WHEEL_STEER_RATE = 18;
/** Body tilt per m/s^2 of acceleration, rad, and caps. */
const ROLL_PER_ACCEL = 0.0075;
const PITCH_PER_ACCEL = 0.0035;
const MAX_ROLL = 0.12;
const MAX_PITCH = 0.07;
const MAX_ACCEL = 30;
const ACCEL_SMOOTHING = 14;
/** Velocity change beyond MAX_ACCEL * dt (hits) kicks the tilt springs: rad/s per m/s, and its cap. */
const IMPACT_GAIN = 0.05;
const MAX_IMPACT_RATE = 1.2;
/** Longest frame the suspension integrates (s); longer gaps (tab switch, debugger) are truncated. */
const MAX_UPDATE_DT = 0.1;
/** Suspension spring: natural frequency (rad/s) and damping ratio (slightly under-damped toy bounce). */
const SPRING_OMEGA = 13;
const SPRING_ZETA = 0.5;
const SPRING_SUBSTEP = 1 / 120;
/** Bomb hop: take-off speed (m/s) and gravity (m/s^2): ~0.48 m high, ~0.44 s in the air. */
const HOP_SPEED = 4.4;
const HOP_GRAVITY = 20;

/** Part colours (sRGB hex; converted to linear vertex colours via Color.setHex). */
const COLORS = {
  dark: 0x1c1a1c,
  seat: 0x2e2a2c,
  metal: 0x4a4b50,
  frame: 0xc4c8cc,
  glass: 0x1f3a39,
  headlight: 0xfff6e2,
  taillight: 0xff2b24,
  tyre: 0x1e1e21,
  hub: 0xb4aea6,
  cap: DEFAULT_CAR_COLOR,
} as const;

interface Materials {
  paint: THREE.MeshStandardMaterial;
  /** Every other body part: one vertex-coloured Lambert mesh (one draw call). */
  trim: THREE.MeshLambertMaterial;
  /** Head/tail lights: unlit so they read as emissive (no real lights). */
  lamps: THREE.MeshBasicMaterial;
  /** Tyre + hub + cap, flat-shaded so the low-poly facets show the wheel spin. */
  wheel: THREE.MeshLambertMaterial;
}

function createMaterials(color: number): Materials {
  return {
    paint: new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0 }),
    trim: new THREE.MeshLambertMaterial({ vertexColors: true }),
    lamps: new THREE.MeshBasicMaterial({ vertexColors: true }),
    wheel: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  };
}

/** Collects transformed part geometries per material and merges them into one geometry each. */
class PartBuilder {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly c = new THREE.Color();

  /** `color` fills a vertex-colour attribute (for vertexColors materials); null for plain materials. */
  add(mat: THREE.Material, geo: THREE.BufferGeometry, color: number | null, x: number, y: number, z: number, rx = 0, rz = 0): void {
    this.q.setFromEuler(this.e.set(rx, 0, rz));
    this.m.compose(this.p.set(x, y, z), this.q, this.s);
    geo.applyMatrix4(this.m);
    // RoundedBoxGeometry is non-indexed; mergeGeometries needs all parts in the same form.
    const flat = geo.index ? geo.toNonIndexed() : geo;
    if (flat !== geo) geo.dispose();
    if (color !== null) {
      this.c.setHex(color);
      const n = flat.getAttribute('position').count;
      const rgb = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        rgb[i * 3] = this.c.r;
        rgb[i * 3 + 1] = this.c.g;
        rgb[i * 3 + 2] = this.c.b;
      }
      flat.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    }
    const list = this.parts.get(mat) ?? [];
    list.push(flat);
    this.parts.set(mat, list);
  }

  box(mat: THREE.Material, color: number | null, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): void {
    this.add(mat, new THREE.BoxGeometry(w, h, d), color, x, y, z, rx);
  }

  rounded(
    mat: THREE.Material, color: number | null,
    w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0,
  ): void {
    this.add(mat, new RoundedBoxGeometry(w, h, d, 3, r), color, x, y, z, rx);
  }

  /** Merge (and forget) everything collected for `mat`. */
  merged(mat: THREE.Material): THREE.BufferGeometry {
    const geos = this.parts.get(mat) ?? [];
    this.parts.delete(mat);
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) throw new Error('carModel: failed to merge part geometries');
    return merged;
  }

  /** One mesh per material. */
  build(target: THREE.Object3D): void {
    for (const mat of [...this.parts.keys()]) target.add(new THREE.Mesh(this.merged(mat), mat));
  }
}

/** Body parts in model space (y up from the ground, +Z forward, +X left). */
function buildBody(mats: Materials, target: THREE.Object3D): void {
  const L = TUNING.car.length;
  const { paint, trim, lamps } = mats;
  const b = new PartBuilder();
  // Paint: thick rounded slab, raised hood and rear deck, side rails around the open cockpit.
  b.rounded(paint, null, 1.72, 0.46, L, 0.15, 0, 0.63, 0);
  b.rounded(paint, null, 1.62, 0.16, 1.62, 0.07, 0, 0.86, 1.13);
  b.rounded(paint, null, 1.62, 0.13, 0.86, 0.06, 0, 0.84, -1.52);
  for (const sx of [0.78, -0.78]) b.rounded(paint, null, 0.16, 0.12, 1.46, 0.05, sx, 0.88, -0.38);
  // Underbody, headrest pad, front grille; seats sit on the painted cockpit deck.
  b.box(trim, COLORS.dark, 1.1, 0.24, 3.3, 0, 0.3, 0);
  b.rounded(trim, COLORS.dark, 1.12, 0.2, 0.24, 0.07, 0, 1.38, -0.98);
  b.box(trim, COLORS.dark, 0.66, 0.1, 0.04, 0, 0.66, L / 2 + 0.005);
  for (const sx of [0.4, -0.4]) {
    b.rounded(trim, COLORS.seat, 0.56, 0.12, 0.52, 0.04, sx, 0.92, -0.36);
    b.rounded(trim, COLORS.seat, 0.56, 0.44, 0.14, 0.05, sx, 1.1, -0.66, -0.18);
  }
  // Roll bar behind the seats.
  for (const sx of [0.58, -0.58]) b.box(trim, COLORS.metal, 0.07, 0.5, 0.07, sx, 1.1, -0.98);
  b.box(trim, COLORS.metal, 1.23, 0.07, 0.07, 0, 1.34, -0.98);
  // Windshield: silver frame + dark glass, raked back, standing on the hood's rear edge.
  const wsZ = 0.38;
  const wsTilt = -0.38;
  const wsH = 0.5;
  const cy = 0.9 + (wsH / 2) * Math.cos(wsTilt);
  const cz = wsZ + (wsH / 2) * Math.sin(wsTilt);
  b.box(trim, COLORS.glass, 1.26, wsH - 0.08, 0.03, 0, cy, cz, wsTilt);
  for (const sx of [0.66, -0.66]) b.box(trim, COLORS.frame, 0.07, wsH, 0.06, sx, cy, cz, wsTilt);
  const topY = 0.9 + wsH * Math.cos(wsTilt);
  const topZ = wsZ + wsH * Math.sin(wsTilt);
  b.box(trim, COLORS.frame, 1.39, 0.07, 0.06, 0, topY, topZ, wsTilt);
  b.box(trim, COLORS.frame, 1.39, 0.06, 0.08, 0, 0.92, wsZ, wsTilt);
  // White headlights on the nose, red tail lights on the tail.
  for (const sx of [0.56, -0.56]) {
    b.box(lamps, COLORS.headlight, 0.34, 0.12, 0.04, sx, 0.66, L / 2 + 0.005);
    b.box(lamps, COLORS.taillight, 0.3, 0.1, 0.04, sx, 0.66, -L / 2 - 0.005);
  }
  b.build(target);
}

interface Wheel {
  pivot: THREE.Group;
  spin: THREE.Group;
  front: boolean;
}

/** Tyre + hub disc + cap as one geometry, axle along X; hub and cap on the `outward` (+1/-1) face. */
function createWheelGeometry(mat: THREE.Material, outward: number): THREE.BufferGeometry {
  const r = TUNING.car.wheelRadius;
  const axle = Math.PI / 2;
  const b = new PartBuilder();
  b.add(mat, new THREE.CylinderGeometry(r, r, WHEEL_WIDTH, 16), COLORS.tyre, 0, 0, 0, 0, axle);
  b.add(mat, new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.03, 16), COLORS.hub, outward * (WHEEL_WIDTH / 2 + 0.01), 0, 0, 0, axle);
  b.add(mat, new THREE.CylinderGeometry(r * 0.26, r * 0.26, CAP_OUT * 2, 8), COLORS.cap, outward * (WHEEL_WIDTH / 2), 0, 0, 0, axle);
  return b.merged(mat);
}

function createWheel(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, z: number, front: boolean, name: string): Wheel {
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.set(x, TUNING.car.wheelRadius, z);
  const spin = new THREE.Group();
  spin.name = `${name}.spin`;
  pivot.add(spin);
  spin.add(new THREE.Mesh(geo, mat));
  return { pivot, spin, front };
}

/** Second-order spring state for one tilt axis. */
interface Spring {
  value: number;
  vel: number;
}

function stepSpring(s: Spring, target: number, dt: number): void {
  let left = dt;
  while (left > 1e-6) {
    const h = Math.min(SPRING_SUBSTEP, left);
    s.vel += (SPRING_OMEGA * SPRING_OMEGA * (target - s.value) - 2 * SPRING_ZETA * SPRING_OMEGA * s.vel) * h;
    s.value += s.vel * h;
    left -= h;
  }
}

export function createCarModel(color: number = DEFAULT_CAR_COLOR): CarModel {
  const mats = createMaterials(color);
  const root = new THREE.Group();
  root.name = 'car';

  const r = TUNING.car.wheelRadius;
  const body = new THREE.Group();
  body.name = 'body';
  body.position.y = r;
  root.add(body);
  const bodyContent = new THREE.Group();
  bodyContent.position.y = -r;
  body.add(bodyContent);
  buildBody(mats, bodyContent);

  // Left (+X) and right wheels share one geometry per side.
  const leftGeo = createWheelGeometry(mats.wheel, 1);
  const rightGeo = createWheelGeometry(mats.wheel, -1);
  const wx = TUNING.car.width / 2 - WHEEL_WIDTH / 2 - CAP_OUT;
  const wz = TUNING.car.wheelBase / 2;
  const wheels: Wheel[] = [
    createWheel(leftGeo, mats.wheel, wx, wz, true, 'wheelFL'),
    createWheel(rightGeo, mats.wheel, -wx, wz, true, 'wheelFR'),
    createWheel(leftGeo, mats.wheel, wx, -wz, false, 'wheelRL'),
    createWheel(rightGeo, mats.wheel, -wx, -wz, false, 'wheelRR'),
  ];
  for (const w of wheels) root.add(w.pivot);

  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = false;
    }
  });

  // Mutable animation state (scalars only: update() must not allocate).
  const roll: Spring = { value: 0, vel: 0 };
  const pitch: Spring = { value: 0, vel: 0 };
  let steerAngle = 0;
  let accF = 0;
  let accL = 0;
  let prevVx = 0;
  let prevVz = 0;
  let hasPrev = false;
  let hopY = 0;
  let hopVel = 0;

  function reset(): void {
    roll.value = roll.vel = pitch.value = pitch.vel = 0;
    hopY = hopVel = 0;
    accF = accL = 0;
    hasPrev = false;
    steerAngle = 0;
    body.rotation.set(0, 0, 0);
    for (const w of wheels) w.pivot.rotation.y = 0;
  }

  function updateSuspension(car: CarState, dt: number): void {
    if (hasPrev) {
      const sin = Math.sin(car.heading);
      const cos = Math.cos(car.heading);
      const dvx = car.vx - prevVx;
      const dvz = car.vz - prevVz;
      const dvF = dvx * sin + dvz * cos;
      const dvL = dvx * cos - dvz * sin;
      // Accelerations above MAX_ACCEL (hits, unreported teleports) are capped; the excess velocity change
      // kicks the springs directly (capped too), so a hard hit reads as a short jolt, never a snap.
      const cap = MAX_ACCEL * dt;
      const capF = clamp(dvF, -cap, cap);
      const capL = clamp(dvL, -cap, cap);
      const k = damp(ACCEL_SMOOTHING, dt);
      accF += (capF / dt - accF) * k;
      accL += (capL / dt - accL) * k;
      pitch.vel += clamp((capF - dvF) * IMPACT_GAIN, -MAX_IMPACT_RATE, MAX_IMPACT_RATE);
      roll.vel += clamp((dvL - capL) * IMPACT_GAIN, -MAX_IMPACT_RATE, MAX_IMPACT_RATE);
    }
    prevVx = car.vx;
    prevVz = car.vz;
    hasPrev = true;
    // Accelerating left lifts the left (+X) side: +rotation.z. Accelerating forward lifts the nose: -rotation.x.
    stepSpring(roll, clamp(accL * ROLL_PER_ACCEL, -MAX_ROLL, MAX_ROLL), dt);
    stepSpring(pitch, clamp(-accF * PITCH_PER_ACCEL, -MAX_PITCH, MAX_PITCH), dt);
    body.rotation.set(clamp(pitch.value, -2 * MAX_PITCH, 2 * MAX_PITCH), 0, clamp(roll.value, -2 * MAX_ROLL, 2 * MAX_ROLL));
  }

  function update(car: CarState, dt: number): void {
    const inputs = car.vx + car.vz + car.heading + car.steer + car.slip + car.wheelSpin + car.forwardSpeed;
    if (!Number.isFinite(inputs) || Number.isNaN(dt)) return;
    const maxAngle = TUNING.car.maxSteerAngle;
    const target =
      car.mode === 'drift'
        ? clamp(-car.slip * COUNTER_STEER_GAIN + car.steer * maxAngle * DRIFT_STEER_SHARE, -maxAngle, maxAngle)
        : (car.steer * maxAngle) / (1 + (Math.abs(car.forwardSpeed) * STEER_SPEED_SOFTEN) / TUNING.car.steerSpeedRef);
    steerAngle = dt > 0 ? steerAngle + (target - steerAngle) * damp(WHEEL_STEER_RATE, dt) : target;
    const spin = car.wheelSpin % TAU;
    for (const w of wheels) {
      if (w.front) w.pivot.rotation.y = steerAngle;
      w.spin.rotation.x = spin;
    }
    if (dt > 0) updateSuspension(car, Math.min(dt, MAX_UPDATE_DT));
    if (dt > 0 && (hopY > 0 || hopVel > 0)) updateHop(Math.min(dt, MAX_UPDATE_DT));
    else if (hopY > 0) root.position.y = hopY; // paused mid-air: hold the height
  }

  function updateHop(dt: number): void {
    hopVel -= HOP_GRAVITY * dt;
    hopY += hopVel * dt;
    if (hopY <= 0) hopY = hopVel = 0;
    root.position.y = hopY;
  }

  return {
    root,
    update,
    reset,
    hop(): void {
      hopVel = Math.max(hopVel, HOP_SPEED);
    },
    setColor(hex: number): void {
      mats.paint.color.setHex(hex);
    },
    setEnvMap(tex: THREE.Texture | null, intensity: number = DEFAULT_ENV_INTENSITY): void {
      const paint = mats.paint;
      if (paint.envMap !== tex) {
        paint.envMap = tex;
        paint.needsUpdate = true; // the shader program depends on the env map's presence
      }
      paint.envMapIntensity = intensity;
    },
  };
}
