/**
 * High chase camera (design spec §4).
 *
 * - Yaw target blends from the body heading (slow or reversing) to the velocity heading
 *   (at speed), so the drift angle stays visible. The yaw follows it with exponential
 *   smoothing `1 - exp(-k dt)` and a yaw-rate cap.
 * - The orbit position follows the yaw through a second smoothing stage (`posSmoothing`),
 *   which rounds off the corners of the rate-capped yaw. Translation is locked to the
 *   (interpolated) car position, so there is no speed-dependent lag.
 * - Distance and FOV grow slightly with a smoothed speed ratio.
 * - Shake is a decaying positional jitter; it never moves `target` (shadows, occlusion).
 *
 * All tuning values are read from `t.camera` every frame (the DEV GUI edits them live).
 * No allocations in `update`.
 */
import * as THREE from 'three';
import type { CarState } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { clamp, damp, lerpAngle, wrapAngle } from '../shared/math';

export interface ChaseCamera {
  /** Advance smoothing by `dt` seconds. `car` must be the INTERPOLATED render state. */
  update(car: CarState, dt: number): void;
  /** Place the camera with no smoothing (race start, respawn). Cancels any shake. */
  snap(car: CarState): void;
  /**
   * Start a decaying shake. `amount` = peak camera displacement per axis, metres
   * (a stronger shake replaces a weaker one; shakes do not stack).
   */
  shake(amount: number): void;
  /** Point the camera looks at (for shadows and occlusion). */
  readonly target: THREE.Vector3;
}

/** Shake jitter angular frequencies, rad/s (incommensurate so the pattern does not repeat visibly). */
const SHAKE_FREQ_X = 37;
const SHAKE_FREQ_Y = 43;
const SHAKE_FREQ_Z = 29;
/** Vertical shake is damped relative to horizontal. */
const SHAKE_Y_SCALE = 0.6;
/** Shake amplitude below which it is treated as finished, metres. */
const SHAKE_EPSILON = 1e-4;
/** Minimum FOV change (degrees) worth a projection-matrix rebuild. */
const FOV_EPSILON = 1e-4;
/** Below this speed the velocity direction is meaningless, m/s. */
const MIN_VELOCITY = 1e-3;

function isValidCar(car: CarState): boolean {
  return (
    Number.isFinite(car.x) &&
    Number.isFinite(car.z) &&
    Number.isFinite(car.heading) &&
    Number.isFinite(car.vx) &&
    Number.isFinite(car.vz)
  );
}

export function createChaseCamera(camera: THREE.PerspectiveCamera, t: Tuning = TUNING): ChaseCamera {
  const target = new THREE.Vector3();

  /** Smoothed look yaw (rad, wrapped). */
  let yaw = 0;
  /** Orbit yaw of the camera position; follows `yaw` with posSmoothing. */
  let orbitYaw = 0;
  /** Smoothed speed / maxSpeed in [0, 1]; drives distance and FOV boosts. */
  let speedRatio = 0;
  let shakeAmp = 0;
  let shakeTime = 0;
  let placed = false;

  camera.near = t.camera.near;
  camera.far = t.camera.far;
  camera.fov = t.camera.fov;
  camera.updateProjectionMatrix();

  /** Yaw the camera wants: body heading when slow/reversing, velocity heading at speed. */
  function goalYaw(car: CarState): number {
    const c = t.camera;
    const speed = Math.sqrt(car.vx * car.vx + car.vz * car.vz);
    const forward = car.vx * Math.sin(car.heading) + car.vz * Math.cos(car.heading);
    if (speed < MIN_VELOCITY || forward < 0) return wrapAngle(car.heading);
    const w = THREE.MathUtils.smoothstep(speed, c.headingBlendSpeed, c.headingBlendSpeed * 2);
    if (w <= 0) return wrapAngle(car.heading);
    return wrapAngle(lerpAngle(car.heading, Math.atan2(car.vx, car.vz), w));
  }

  function goalSpeedRatio(car: CarState): number {
    const speed = Math.sqrt(car.vx * car.vx + car.vz * car.vz);
    return clamp(speed / t.car.maxSpeed, 0, 1);
  }

  /** Writes camera position/orientation/FOV and `target` from the current filter state. */
  function place(car: CarState): void {
    const c = t.camera;
    const dist = c.distance + c.distanceSpeedBoost * speedRatio;

    target.set(
      car.x + Math.sin(yaw) * c.lookAhead,
      c.lookHeight,
      car.z + Math.cos(yaw) * c.lookAhead,
    );

    let sx = 0;
    let sy = 0;
    let sz = 0;
    if (shakeAmp > 0) {
      sx = shakeAmp * Math.sin(shakeTime * SHAKE_FREQ_X);
      sy = shakeAmp * SHAKE_Y_SCALE * Math.sin(shakeTime * SHAKE_FREQ_Y + 1.3);
      sz = shakeAmp * Math.sin(shakeTime * SHAKE_FREQ_Z + 2.1);
    }
    camera.position.set(
      car.x - Math.sin(orbitYaw) * dist + sx,
      c.height + sy,
      car.z - Math.cos(orbitYaw) * dist + sz,
    );
    camera.lookAt(target);

    const fov = c.fov + c.fovSpeedBoost * speedRatio;
    if (Math.abs(camera.fov - fov) > FOV_EPSILON) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  function snap(car: CarState): void {
    if (!isValidCar(car)) return;
    yaw = goalYaw(car);
    orbitYaw = yaw;
    speedRatio = goalSpeedRatio(car);
    shakeAmp = 0;
    placed = true;
    place(car);
  }

  function update(car: CarState, dt: number): void {
    if (!isValidCar(car)) return;
    if (!placed) {
      snap(car);
      return;
    }
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const c = t.camera;

    const maxTurn = c.maxYawRate * step;
    const turn = wrapAngle(goalYaw(car) - yaw) * damp(c.yawSmoothing, step);
    yaw = wrapAngle(yaw + clamp(turn, -maxTurn, maxTurn));

    const follow = damp(c.posSmoothing, step);
    orbitYaw = wrapAngle(lerpAngle(orbitYaw, yaw, follow));
    speedRatio += (goalSpeedRatio(car) - speedRatio) * follow;

    if (shakeAmp > 0) {
      shakeTime += step;
      shakeAmp *= Math.exp(-c.shakeDecay * step);
      if (shakeAmp < SHAKE_EPSILON) shakeAmp = 0;
    }

    place(car);
  }

  function shake(amount: number): void {
    if (!Number.isFinite(amount) || amount <= shakeAmp) return;
    shakeAmp = amount;
  }

  return { update, snap, shake, target };
}
