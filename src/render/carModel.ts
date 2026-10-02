/**
 * Procedural low-poly car «Искра» (open-top toy buggy from the user's garage reference).
 *
 * Model space: built facing +Z, local +X = LEFT side, origin at ground centre (see bridge.ts).
 * Hierarchy: root -> body (pivot at axle height; roll/pitch) -> merged body parts,
 *            root -> 4 wheel pivots (front ones steer about Y) -> spin group (rolls about X) -> tyre/hub/cap.
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
  /** Wheels steer by car.steer, spin by car.wheelSpin, body rolls with lateral accel, pitches with accel. */
  update(car: CarState, dt: number): void;
  setColor(hex: number): void;
  /** Settle the suspension instantly (call after a respawn / teleport or when reusing the model). */
  reset(): void;
}

export const DEFAULT_CAR_COLOR = 0xf0573a;

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
/** Velocity jump treated as a teleport (respawn), m/s per update. */
const TELEPORT_DV = 20;
/** Suspension spring: natural frequency (rad/s) and damping ratio (slightly under-damped toy bounce). */
const SPRING_OMEGA = 13;
const SPRING_ZETA = 0.5;
const SPRING_SUBSTEP = 1 / 120;

interface Materials {
  paint: THREE.MeshStandardMaterial;
  dark: THREE.MeshLambertMaterial;
  seat: THREE.MeshLambertMaterial;
  metal: THREE.MeshLambertMaterial;
  frame: THREE.MeshLambertMaterial;
  glass: THREE.MeshLambertMaterial;
  headlight: THREE.MeshBasicMaterial;
  taillight: THREE.MeshBasicMaterial;
  tyre: THREE.MeshLambertMaterial;
  hub: THREE.MeshLambertMaterial;
  cap: THREE.MeshLambertMaterial;
}

function createMaterials(color: number): Materials {
  return {
    paint: new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0 }),
    dark: new THREE.MeshLambertMaterial({ color: 0x1c1a1c }),
    seat: new THREE.MeshLambertMaterial({ color: 0x2e2a2c }),
    metal: new THREE.MeshLambertMaterial({ color: 0x4a4b50 }),
    frame: new THREE.MeshLambertMaterial({ color: 0xc4c8cc }),
    glass: new THREE.MeshLambertMaterial({ color: 0x1f3a39 }),
    headlight: new THREE.MeshBasicMaterial({ color: 0xfff6e2 }),
    taillight: new THREE.MeshBasicMaterial({ color: 0xff2b24 }),
    tyre: new THREE.MeshLambertMaterial({ color: 0x1e1e21, flatShading: true }),
    hub: new THREE.MeshLambertMaterial({ color: 0xb4aea6, flatShading: true }),
    cap: new THREE.MeshLambertMaterial({ color: DEFAULT_CAR_COLOR, flatShading: true }),
  };
}

/** Collects transformed part geometries per material and merges them into one mesh each. */
class PartBuilder {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);

  add(mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0): void {
    this.q.setFromEuler(this.e.set(rx, 0, rz));
    this.m.compose(this.p.set(x, y, z), this.q, this.s);
    geo.applyMatrix4(this.m);
    // RoundedBoxGeometry is non-indexed; mergeGeometries needs all parts in the same form.
    const flat = geo.index ? geo.toNonIndexed() : geo;
    if (flat !== geo) geo.dispose();
    const list = this.parts.get(mat) ?? [];
    list.push(flat);
    this.parts.set(mat, list);
  }

  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): void {
    this.add(mat, new THREE.BoxGeometry(w, h, d), x, y, z, rx);
  }

  rounded(mat: THREE.Material, w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0): void {
    this.add(mat, new RoundedBoxGeometry(w, h, d, 3, r), x, y, z, rx);
  }

  build(target: THREE.Object3D): void {
    for (const [mat, geos] of this.parts) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) throw new Error('carModel: failed to merge part geometries');
      target.add(new THREE.Mesh(merged, mat));
    }
    this.parts.clear();
  }
}

/** Body parts in model space (y up from the ground, +Z forward, +X left). */
function buildBody(mats: Materials, target: THREE.Object3D): void {
  const L = TUNING.car.length;
  const b = new PartBuilder();
  // Paint: thick rounded slab, raised hood and rear deck, side rails around the open cockpit.
  b.rounded(mats.paint, 1.72, 0.46, L, 0.15, 0, 0.63, 0);
  b.rounded(mats.paint, 1.62, 0.16, 1.62, 0.07, 0, 0.86, 1.13);
  b.rounded(mats.paint, 1.62, 0.13, 0.86, 0.06, 0, 0.84, -1.52);
  for (const sx of [0.78, -0.78]) b.rounded(mats.paint, 0.16, 0.12, 1.46, 0.05, sx, 0.88, -0.38);
  // Dark: underbody, headrest pad, front grille. Seats: dark grey on the painted cockpit deck.
  b.box(mats.dark, 1.1, 0.24, 3.3, 0, 0.3, 0);
  b.rounded(mats.dark, 1.12, 0.2, 0.24, 0.07, 0, 1.38, -0.98);
  b.box(mats.dark, 0.66, 0.1, 0.04, 0, 0.66, L / 2 + 0.005);
  for (const sx of [0.4, -0.4]) {
    b.rounded(mats.seat, 0.56, 0.12, 0.52, 0.04, sx, 0.92, -0.36);
    b.rounded(mats.seat, 0.56, 0.44, 0.14, 0.05, sx, 1.1, -0.66, -0.18);
  }
  // Metal: roll bar behind the seats.
  for (const sx of [0.58, -0.58]) b.box(mats.metal, 0.07, 0.5, 0.07, sx, 1.1, -0.98);
  b.box(mats.metal, 1.23, 0.07, 0.07, 0, 1.34, -0.98);
  // Windshield: silver frame + dark glass, raked back, standing on the hood's rear edge.
  const wsZ = 0.38;
  const wsTilt = -0.38;
  const wsH = 0.5;
  const cy = 0.9 + (wsH / 2) * Math.cos(wsTilt);
  const cz = wsZ + (wsH / 2) * Math.sin(wsTilt);
  b.box(mats.glass, 1.26, wsH - 0.08, 0.03, 0, cy, cz, wsTilt);
  for (const sx of [0.66, -0.66]) b.box(mats.frame, 0.07, wsH, 0.06, sx, cy, cz, wsTilt);
  const topY = 0.9 + wsH * Math.cos(wsTilt);
  const topZ = wsZ + wsH * Math.sin(wsTilt);
  b.box(mats.frame, 1.39, 0.07, 0.06, 0, topY, topZ, wsTilt);
  b.box(mats.frame, 1.39, 0.06, 0.08, 0, 0.92, wsZ, wsTilt);
  // Lights: white headlights on the nose, red tail lights on the tail (emissive look, no real lights).
  for (const sx of [0.56, -0.56]) {
    b.box(mats.headlight, 0.34, 0.12, 0.04, sx, 0.66, L / 2 + 0.005);
    b.box(mats.taillight, 0.3, 0.1, 0.04, sx, 0.66, -L / 2 - 0.005);
  }
  b.build(target);
}

interface Wheel {
  pivot: THREE.Group;
  spin: THREE.Group;
  front: boolean;
}

interface WheelGeometries {
  tyre: THREE.BufferGeometry;
  hub: THREE.BufferGeometry;
  cap: THREE.BufferGeometry;
}

function createWheelGeometries(): WheelGeometries {
  const r = TUNING.car.wheelRadius;
  const axleX = (g: THREE.BufferGeometry): THREE.BufferGeometry => g.rotateZ(Math.PI / 2);
  return {
    tyre: axleX(new THREE.CylinderGeometry(r, r, WHEEL_WIDTH, 16)),
    hub: axleX(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.03, 16)),
    cap: axleX(new THREE.CylinderGeometry(r * 0.26, r * 0.26, CAP_OUT * 2, 8)),
  };
}

function createWheel(geos: WheelGeometries, mats: Materials, x: number, z: number, front: boolean, name: string): Wheel {
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.set(x, TUNING.car.wheelRadius, z);
  const spin = new THREE.Group();
  spin.name = `${name}.spin`;
  pivot.add(spin);
  const outward = Math.sign(x);
  spin.add(new THREE.Mesh(geos.tyre, mats.tyre));
  const hub = new THREE.Mesh(geos.hub, mats.hub);
  hub.position.x = outward * (WHEEL_WIDTH / 2 + 0.01);
  spin.add(hub);
  const cap = new THREE.Mesh(geos.cap, mats.cap);
  cap.position.x = outward * (WHEEL_WIDTH / 2);
  spin.add(cap);
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

  const geos = createWheelGeometries();
  const wx = TUNING.car.width / 2 - WHEEL_WIDTH / 2 - CAP_OUT;
  const wz = TUNING.car.wheelBase / 2;
  const wheels: Wheel[] = [
    createWheel(geos, mats, wx, wz, true, 'wheelFL'),
    createWheel(geos, mats, -wx, wz, true, 'wheelFR'),
    createWheel(geos, mats, wx, -wz, false, 'wheelRL'),
    createWheel(geos, mats, -wx, -wz, false, 'wheelRR'),
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

  function reset(): void {
    roll.value = roll.vel = pitch.value = pitch.vel = 0;
    accF = accL = 0;
    hasPrev = false;
    body.rotation.set(0, 0, 0);
  }

  function updateSuspension(car: CarState, dt: number): void {
    const dvx = car.vx - prevVx;
    const dvz = car.vz - prevVz;
    const teleported = dvx * dvx + dvz * dvz > TELEPORT_DV * TELEPORT_DV;
    if (hasPrev && !teleported) {
      const ax = dvx / dt;
      const az = dvz / dt;
      const sin = Math.sin(car.heading);
      const cos = Math.cos(car.heading);
      const k = damp(ACCEL_SMOOTHING, dt);
      accF += (clamp(ax * sin + az * cos, -MAX_ACCEL, MAX_ACCEL) - accF) * k;
      accL += (clamp(ax * cos - az * sin, -MAX_ACCEL, MAX_ACCEL) - accL) * k;
    } else if (teleported) {
      reset();
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
    if (!Number.isFinite(car.vx + car.vz + car.heading + car.steer + car.slip + car.wheelSpin)) return;
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
    if (dt > 0) updateSuspension(car, dt);
  }

  return {
    root,
    update,
    reset,
    setColor(hex: number): void {
      mats.paint.color.setHex(hex);
    },
  };
}
