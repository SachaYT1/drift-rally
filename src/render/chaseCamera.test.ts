import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { CarState } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { DEG, wrapAngle } from '../shared/math';
import { createChaseCamera } from './chaseCamera';

const DT = 1 / 60;
const cam = TUNING.camera;

/** Builds a car state with body heading `heading` moving at `speed` along `velHeading`. */
function car(heading: number, speed = 0, velHeading = heading, x = 0, z = 0): CarState {
  const vx = Math.sin(velHeading) * speed;
  const vz = Math.cos(velHeading) * speed;
  return {
    x,
    z,
    heading,
    vx,
    vz,
    yawRate: 0,
    steer: 0,
    mode: 'grip',
    driftDir: 0,
    driftTime: 0,
    gripBlend: 1,
    modeTimer: 0,
    reverseHold: 0,
    wheelSpin: 0,
    speed,
    forwardSpeed: vx * Math.sin(heading) + vz * Math.cos(heading),
    lateralSpeed: vx * Math.cos(heading) - vz * Math.sin(heading),
    slip: speed < 1 ? 0 : wrapAngle(heading - velHeading),
    rpm: 0,
  };
}

function newCamera(): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
}

/** Camera yaw as seen from above: heading of the horizontal camera -> car vector. */
function viewYaw(camera: THREE.PerspectiveCamera, c: CarState): number {
  return Math.atan2(c.x - camera.position.x, c.z - camera.position.z);
}

function horizontalDistance(camera: THREE.PerspectiveCamera, c: CarState): number {
  return Math.hypot(c.x - camera.position.x, c.z - camera.position.z);
}

/** Drives the camera for `seconds` with a car moving at constant velocity. */
function drive(
  chase: ReturnType<typeof createChaseCamera>,
  start: CarState,
  seconds: number,
  onStep?: (c: CarState) => void,
): CarState {
  let c = start;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    c = { ...c, x: c.x + c.vx * DT, z: c.z + c.vz * DT };
    chase.update(c, DT);
    onStep?.(c);
  }
  return c;
}

describe('createChaseCamera', () => {
  it('applies near/far/fov from tuning', () => {
    const camera = newCamera();
    createChaseCamera(camera);
    expect(camera.near).toBe(cam.near);
    expect(camera.far).toBe(cam.far);
    expect(camera.fov).toBeCloseTo(cam.fov, 6);
  });

  it.each([0, 1.2, -2.5, Math.PI, 7.5])('snap at heading %f puts the camera behind and above the car', (h) => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const c = car(h, 0, h, 12, -30);
    chase.snap(c);

    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const toCar = (c.x - camera.position.x) * fx + (c.z - camera.position.z) * fz;
    expect(toCar).toBeGreaterThan(0);
    expect(toCar).toBeCloseTo(cam.distance, 4);
    expect(camera.position.y).toBeCloseTo(cam.height, 6);
    expect(camera.position.y).toBeGreaterThan(cam.lookHeight);

    // The look target is ahead of the car on the same heading, at lookHeight.
    const ahead = (chase.target.x - c.x) * fx + (chase.target.z - c.z) * fz;
    expect(ahead).toBeCloseTo(cam.lookAhead, 4);
    expect(chase.target.y).toBeCloseTo(cam.lookHeight, 6);

    // The camera actually looks at the target.
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const want = chase.target.clone().sub(camera.position).normalize();
    expect(dir.dot(want)).toBeGreaterThan(0.9999);
  });

  it('uses the provided tuning object', () => {
    const t: Tuning = structuredClone(TUNING);
    t.camera.distance = 30;
    t.camera.height = 3;
    const camera = newCamera();
    const chase = createChaseCamera(camera, t);
    const c = car(0.4);
    chase.snap(c);
    expect(horizontalDistance(camera, c)).toBeCloseTo(30, 4);
    expect(camera.position.y).toBeCloseTo(3, 6);

    // Values are read live (the DEV GUI mutates the tuning object in place).
    t.camera.distance = 25;
    chase.snap(c);
    expect(horizontalDistance(camera, c)).toBeCloseTo(25, 4);
  });

  it('first update without snap places the camera immediately', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const c = car(0.7);
    chase.update(c, DT);
    expect(viewYaw(camera, c)).toBeCloseTo(0.7, 4);
    expect(horizontalDistance(camera, c)).toBeCloseTo(cam.distance, 4);
  });

  it('turns toward the velocity heading while drifting at speed', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const body = 0.3;
    const vel = body - 30 * DEG;
    chase.snap(car(body, 25, body));

    const end = drive(chase, car(body, 25, vel), 2);
    const yaw = viewYaw(camera, end);
    expect(Math.abs(wrapAngle(yaw - vel))).toBeLessThan(Math.abs(wrapAngle(yaw - body)));
  });

  it('follows the body heading below headingBlendSpeed', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const body = -1;
    const slow = cam.headingBlendSpeed * 0.8;
    chase.snap(car(body, slow, body));
    const end = drive(chase, car(body, slow, body + 40 * DEG), 3);
    expect(viewYaw(camera, end)).toBeCloseTo(body, 3);
  });

  it('follows the body heading when reversing', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const body = 2;
    // Moving backwards at speed: velocity points opposite to the body.
    const start = car(body, 8, body + Math.PI);
    expect(start.forwardSpeed).toBeLessThan(0);
    chase.snap(start);
    expect(viewYaw(camera, start)).toBeCloseTo(body, 4);
    const end = drive(chase, start, 2);
    expect(viewYaw(camera, end)).toBeCloseTo(body, 3);
  });

  it('caps the yaw rate and turns along the shortest arc across +/-PI', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const from = Math.PI - 0.1;
    const to = -Math.PI + 0.2; // 0.3 rad to the left through the wrap
    chase.snap(car(from));

    let prev = from;
    let maxStep = 0;
    // Look direction (target relative to car) reflects the raw smoothed yaw.
    const targetYaw = (c: CarState): number => Math.atan2(chase.target.x - c.x, chase.target.z - c.z);
    const end = drive(chase, car(to), 3, (c) => {
      const y = targetYaw(c);
      maxStep = Math.max(maxStep, Math.abs(wrapAngle(y - prev)));
      prev = y;
    });
    expect(maxStep).toBeLessThanOrEqual(cam.maxYawRate * DT + 1e-9);
    expect(wrapAngle(targetYaw(end) - to)).toBeCloseTo(0, 3);
    expect(wrapAngle(viewYaw(camera, end) - to)).toBeCloseTo(0, 3);
  });

  it('a large heading change is limited by maxYawRate', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    chase.snap(car(0));
    chase.update(car(Math.PI / 2), DT);
    const yaw = Math.atan2(chase.target.x, chase.target.z);
    expect(yaw).toBeGreaterThan(0);
    expect(yaw).toBeLessThanOrEqual(cam.maxYawRate * DT + 1e-9);
  });

  it('pulls back and widens the FOV with speed', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const vmax = TUNING.car.maxSpeed;
    chase.snap(car(0, 0));
    expect(camera.fov).toBeCloseTo(cam.fov, 6);

    const end = drive(chase, car(0, vmax), 4);
    expect(camera.fov).toBeCloseTo(cam.fov + cam.fovSpeedBoost, 3);
    expect(horizontalDistance(camera, end)).toBeCloseTo(cam.distance + cam.distanceSpeedBoost, 2);
    expect(camera.projectionMatrix.equals(new THREE.PerspectiveCamera(
      camera.fov, camera.aspect, camera.near, camera.far).projectionMatrix)).toBe(true);

    // Speed changes are smoothed: one frame after a sudden stop the FOV barely moves.
    chase.update({ ...end, vx: 0, vz: 0, speed: 0, forwardSpeed: 0 }, DT);
    expect(camera.fov).toBeGreaterThan(cam.fov + cam.fovSpeedBoost * 0.8);
  });

  it('snap applies the speed-dependent distance and FOV immediately', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const c = car(0, TUNING.car.maxSpeed);
    chase.snap(c);
    expect(camera.fov).toBeCloseTo(cam.fov + cam.fovSpeedBoost, 6);
    expect(horizontalDistance(camera, c)).toBeCloseTo(cam.distance + cam.distanceSpeedBoost, 4);
  });

  it('shake displaces the camera, not the target, and decays', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const c = car(0.5);
    chase.snap(c);
    const rest = camera.position.clone();
    const restTarget = chase.target.clone();

    chase.shake(0.5);
    let maxOffset = 0;
    for (let i = 0; i < 12; i++) {
      chase.update(c, DT);
      maxOffset = Math.max(maxOffset, camera.position.distanceTo(rest));
      expect(chase.target.distanceTo(restTarget)).toBeLessThan(1e-9);
    }
    expect(maxOffset).toBeGreaterThan(0.05);
    expect(maxOffset).toBeLessThanOrEqual(0.5 * Math.sqrt(3) + 1e-9);

    for (let i = 0; i < 4 / DT; i++) chase.update(c, DT);
    expect(camera.position.distanceTo(rest)).toBeLessThan(1e-3);
  });

  it('snap cancels an active shake', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const c = car(0);
    chase.snap(c);
    const rest = camera.position.clone();
    chase.shake(2);
    chase.snap(c);
    for (let i = 0; i < 5; i++) {
      chase.update(c, DT);
      expect(camera.position.distanceTo(rest)).toBeLessThan(1e-9);
    }
  });

  it('ignores non-finite cars, zero dt and bad shake amounts', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const c = car(0.2, 20);
    chase.snap(c);
    const pos = camera.position.clone();

    chase.update({ ...c, x: Number.NaN }, DT);
    chase.update({ ...c, heading: Number.POSITIVE_INFINITY }, DT);
    chase.update(c, 0);
    chase.update(c, Number.NaN);
    chase.update(c, -1);
    chase.shake(Number.NaN);
    chase.shake(-3);
    chase.update(c, 0);
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-9);
    expect(Number.isFinite(camera.fov)).toBe(true);
    expect(Number.isFinite(chase.target.x)).toBe(true);
  });

  it('keeps the camera locked behind a car moving straight (no translation lag)', () => {
    const camera = newCamera();
    const chase = createChaseCamera(camera);
    const start = car(1, 30);
    chase.snap(start);
    const end = drive(chase, start, 3);
    const ratio = 30 / TUNING.car.maxSpeed;
    expect(horizontalDistance(camera, end)).toBeCloseTo(cam.distance + cam.distanceSpeedBoost * ratio, 3);
    expect(viewYaw(camera, end)).toBeCloseTo(1, 4);
  });
});
