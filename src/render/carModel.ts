/**
 * Procedural low-poly car rig: one body from render/bodies/* (built with carParts.ts) on four animated wheels.
 *
 * Model space: built facing +Z, local +X = LEFT side, origin at ground centre (see bridge.ts).
 * Hierarchy: root -> body (pivot at axle height; roll/pitch) -> merged body parts,
 *            root -> 4 wheel pivots (front ones steer about Y) -> spin group (rolls about X) -> wheel mesh.
 * Parts are merged per material: 3 body meshes + 4 wheel meshes (7 draw calls).
 */
import * as THREE from 'three';
import type { CarState } from '../shared/types';
import { TUNING } from '../shared/tuning';
import { TAU, clamp, damp } from '../shared/math';
import { CAP_OUT, PartBuilder, WHEEL_WIDTH, createMaterials, createWheelGeometry, type CarBody } from './carParts';
import { ISKRA } from './bodies/iskra';

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

/** Default paint reflection strength for setEnvMap(). */
export const DEFAULT_ENV_INTENSITY = 0.35;

// ---- Visual-only constants (not gameplay tuning) ----
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

interface Wheel {
  pivot: THREE.Group;
  spin: THREE.Group;
  front: boolean;
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

/** A car model of `carBody`, painted `color` (default: the body's own paint). */
export function createCarModel(carBody: CarBody = ISKRA, color: number = carBody.paint): CarModel {
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
  const parts = new PartBuilder();
  carBody.build(parts, mats);
  parts.build(bodyContent);

  // Left (+X) and right wheels share one geometry per side.
  const leftGeo = createWheelGeometry(mats.wheel, 1, carBody.wheel);
  const rightGeo = createWheelGeometry(mats.wheel, -1, carBody.wheel);
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
