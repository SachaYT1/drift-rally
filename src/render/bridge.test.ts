import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPose } from './bridge';
import { DEFAULT_ENV_INTENSITY, createCarModel, type CarModel } from './carModel';
import {
  GARAGE_PODIUM_OUTER_RADIUS, GARAGE_ROOM_APOTHEM, applyGarageFraming, garageCameraFraming,
} from './garageScene';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';

const EPS = 1e-9;

function worldForward(obj: THREE.Object3D): THREE.Vector3 {
  obj.updateMatrixWorld(true);
  return obj.getWorldDirection(new THREE.Vector3());
}

/** World-space direction of the object's local +X axis (the car's left side). */
function worldLocalX(obj: THREE.Object3D): THREE.Vector3 {
  obj.updateMatrixWorld(true);
  const origin = obj.localToWorld(new THREE.Vector3(0, 0, 0));
  return obj.localToWorld(new THREE.Vector3(1, 0, 0)).sub(origin);
}

describe('applyPose', () => {
  it.each([0, 0.3, -0.3, 1.2, Math.PI / 2, Math.PI, -2.5, 7])(
    'heading %f faces (sin h, 0, cos h)',
    (h) => {
      const obj = new THREE.Object3D();
      applyPose(obj, 0, 0, h);
      const d = worldForward(obj);
      expect(d.x).toBeCloseTo(Math.sin(h), 9);
      expect(d.y).toBeCloseTo(0, 9);
      expect(d.z).toBeCloseTo(Math.cos(h), 9);
    },
  );

  it('positive heading turns toward +x (left of a car facing +z)', () => {
    const obj = new THREE.Object3D();
    applyPose(obj, 0, 0, 0.3);
    const d = worldForward(obj);
    expect(d.x).toBeGreaterThan(0.2);
    expect(d.z).toBeGreaterThan(0.9);
  });

  it('local +x is the simulation left vector (cos h, -sin h)', () => {
    const obj = new THREE.Object3D();
    const h = 0.8;
    applyPose(obj, 0, 0, h);
    const left = worldLocalX(obj);
    expect(left.x).toBeCloseTo(Math.cos(h), 9);
    expect(left.y).toBeCloseTo(0, 9);
    expect(left.z).toBeCloseTo(-Math.sin(h), 9);
  });

  it('sets the ground position; y defaults to 0', () => {
    const obj = new THREE.Object3D();
    obj.position.set(5, 3, 5);
    applyPose(obj, 12.5, -40, 0.1);
    expect(obj.position.x).toBe(12.5);
    expect(obj.position.y).toBe(0);
    expect(obj.position.z).toBe(-40);
  });

  it('uses an explicit y when given', () => {
    const obj = new THREE.Object3D();
    applyPose(obj, 1, 2, 0, 0.75);
    expect(obj.position.y).toBe(0.75);
  });

  it('clears leftover pitch/roll so the pose stays on the ground plane', () => {
    const obj = new THREE.Object3D();
    obj.rotation.set(0.4, 0, -0.2);
    applyPose(obj, 0, 0, 1);
    expect(Math.abs(obj.rotation.x)).toBeLessThan(EPS);
    expect(Math.abs(obj.rotation.z)).toBeLessThan(EPS);
    expect(obj.rotation.y).toBe(1);
  });

  it('places a child offset forward of the root along the heading', () => {
    const root = new THREE.Group();
    const nose = new THREE.Object3D();
    nose.position.set(0, 0, 2); // 2 m ahead in model space (+Z = forward)
    root.add(nose);
    const h = -0.6;
    applyPose(root, 10, 20, h);
    root.updateMatrixWorld(true);
    const p = nose.getWorldPosition(new THREE.Vector3());
    expect(p.x).toBeCloseTo(10 + 2 * Math.sin(h), 9);
    expect(p.z).toBeCloseTo(20 + 2 * Math.cos(h), 9);
  });
});

// ---------------------------------------------------------------------------
// Car model conventions (the model must agree with the bridge: +Z forward, +X left).
// ---------------------------------------------------------------------------

function carState(p: Partial<CarState> = {}): CarState {
  return {
    x: 0, z: 0, heading: 0, vx: 0, vz: 0, yawRate: 0, steer: 0,
    mode: 'grip', driftDir: 0, driftTime: 0, gripBlend: 1, modeTimer: 0, reverseHold: 0, wheelSpin: 0,
    speed: 0, forwardSpeed: 0, lateralSpeed: 0, slip: 0, rpm: 0,
    ...p,
  };
}

function named(model: CarModel, name: string): THREE.Object3D {
  const o = model.root.getObjectByName(name);
  if (!o) throw new Error(`missing ${name}`);
  return o;
}

function run(model: CarModel, state: (i: number) => CarState, frames: number, dt = 1 / 60): void {
  for (let i = 0; i < frames; i++) model.update(state(i), dt);
}

describe('car model', () => {
  it('is built facing +Z with its origin at ground centre and the documented size', () => {
    const model = createCarModel();
    const box = new THREE.Box3().setFromObject(model.root);
    expect(Math.abs(box.min.y)).toBeLessThan(0.02); // low-poly tyre facets
    expect(box.max.z - box.min.z).toBeGreaterThan(TUNING.car.length * 0.97);
    expect(box.max.z - box.min.z).toBeLessThan(TUNING.car.length * 1.05);
    expect(box.max.x - box.min.x).toBeGreaterThan(TUNING.car.width * 0.95);
    expect(box.max.x - box.min.x).toBeLessThan(TUNING.car.width * 1.05);
    expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(0.1);
    expect(Math.abs(box.max.x + box.min.x)).toBeLessThan(0.05);
    expect(named(model, 'wheelFL').position.z).toBeGreaterThan(0);
    expect(named(model, 'wheelFL').position.x).toBeGreaterThan(0);
  });

  it('steers the front wheels left (toward +X) with positive steer, rear wheels stay straight', () => {
    const model = createCarModel();
    run(model, () => carState({ steer: 1, vz: 5, speed: 5, forwardSpeed: 5 }), 30);
    model.root.updateMatrixWorld(true);
    const fl = named(model, 'wheelFL').getWorldDirection(new THREE.Vector3());
    const fr = named(model, 'wheelFR').getWorldDirection(new THREE.Vector3());
    const rl = named(model, 'wheelRL').getWorldDirection(new THREE.Vector3());
    expect(fl.x).toBeGreaterThan(0.2);
    expect(fr.x).toBeGreaterThan(0.2);
    expect(Math.abs(rl.x)).toBeLessThan(1e-9);
  });

  it('counter-steers toward the velocity while drifting', () => {
    const model = createCarModel();
    // Left drift: nose 0.5 rad left of the motion, player steering into the drift.
    const slip = 0.5;
    const v = 20;
    const s = carState({
      mode: 'drift', driftDir: 1, steer: 0.8, slip, heading: slip,
      vx: 0, vz: v, speed: v, forwardSpeed: v * Math.cos(slip), lateralSpeed: -v * Math.sin(slip),
    });
    run(model, () => s, 30);
    expect(named(model, 'wheelFL').rotation.y).toBeLessThan(-0.1);
  });

  it('rolls the wheels by wheelSpin', () => {
    const model = createCarModel();
    model.update(carState({ wheelSpin: 1.3 }), 1 / 60);
    expect(named(model, 'wheelRR.spin').rotation.x).toBeCloseTo(1.3, 9);
  });

  it('rolls the body outward (left side up) when accelerating to the left', () => {
    const model = createCarModel();
    run(model, (i) => carState({ vx: i * 0.2, vz: 15 }), 20); // 12 m/s^2 toward +X = left
    expect(named(model, 'body').rotation.z).toBeGreaterThan(0.02);
  });

  it('lifts the nose under forward acceleration and dives under braking', () => {
    const accel = createCarModel();
    run(accel, (i) => carState({ vz: 5 + i * 0.15 }), 20);
    expect(named(accel, 'body').rotation.x).toBeLessThan(-0.01);
    const brake = createCarModel();
    run(brake, (i) => carState({ vz: 25 - i * 0.3 }), 20);
    expect(named(brake, 'body').rotation.x).toBeGreaterThan(0.01);
  });

  it('turns a hard hit into a capped jolt instead of snapping the body level', () => {
    const model = createCarModel();
    run(model, (i) => carState({ vx: i * 0.2, vz: 30 }), 40); // steady left accel: body rolled
    const body = named(model, 'body');
    const rollBefore = body.rotation.z;
    expect(rollBefore).toBeGreaterThan(0.05);
    let maxPitch = 0;
    model.update(carState({ vx: 7.8, vz: 9 }), 1 / 60); // barrier: 30 -> 9 m/s in one frame
    expect(body.rotation.z).toBeGreaterThan(rollBefore * 0.8); // no snap to level
    for (let i = 0; i < 60; i++) {
      model.update(carState({ vx: 7.8, vz: 9 }), 1 / 60);
      maxPitch = Math.max(maxPitch, body.rotation.x);
    }
    expect(maxPitch).toBeGreaterThan(0.025); // visible nose dive under the hit
    expect(maxPitch).toBeLessThan(0.15); // capped (2 * MAX_PITCH clamp in the model)
  });

  it('ignores non-finite input (forwardSpeed included); reset() levels the body and straightens the wheels', () => {
    const model = createCarModel();
    run(model, (i) => carState({ vx: i * 0.2, vz: 15, steer: 1, forwardSpeed: 15 }), 30);
    model.update(carState({ vz: Number.NaN }), 1 / 60);
    model.update(carState({ steer: 1, forwardSpeed: Number.NaN }), 1 / 60);
    model.update(carState({ steer: 1 }), Number.NaN);
    model.update(carState({ steer: 1, vz: 15, forwardSpeed: 15 }), Number.POSITIVE_INFINITY);
    const body = named(model, 'body');
    const fl = named(model, 'wheelFL');
    expect(Number.isFinite(body.rotation.x) && Number.isFinite(body.rotation.z)).toBe(true);
    expect(Number.isFinite(fl.rotation.y)).toBe(true);
    expect(fl.rotation.y).toBeGreaterThan(0.1);
    model.reset();
    expect(body.rotation.x).toBe(0);
    expect(body.rotation.z).toBe(0);
    expect(fl.rotation.y).toBe(0);
    model.update(carState({ steer: 0.5, vz: 5, forwardSpeed: 5 }), 1 / 60);
    expect(Number.isFinite(fl.rotation.y)).toBe(true);
    expect(fl.rotation.y).toBeGreaterThan(0);
  });

  it('stays cheap: body merged per material, one mesh per wheel', () => {
    const model = createCarModel();
    let meshes = 0;
    model.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        meshes++;
        expect(o.castShadow).toBe(true);
      }
    });
    expect(meshes).toBeLessThanOrEqual(7);
  });

  it('setColor changes the paint', () => {
    const model = createCarModel();
    model.setColor(0x3366ff);
    const paints: number[] = [];
    model.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
        paints.push(o.material.color.getHex());
      }
    });
    expect(paints).toEqual([0x3366ff]);
  });

  it('setEnvMap puts reflections on the paint only', () => {
    const model = createCarModel();
    const tex = new THREE.Texture();
    model.setEnvMap(tex);
    model.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mat = o.material as THREE.Material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        expect(mat.envMap).toBe(tex);
        expect(mat.envMapIntensity).toBe(DEFAULT_ENV_INTENSITY);
      } else {
        expect('envMap' in mat ? mat.envMap : null).toBeNull();
      }
    });
    model.setEnvMap(null, 0.6);
    model.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
        expect(o.material.envMap).toBeNull();
        expect(o.material.envMapIntensity).toBe(0.6);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Garage camera framing (pure maths; the scene itself needs a WebGL renderer).
// ---------------------------------------------------------------------------

describe('garage camera framing', () => {
  const aspects = [0.5, 0.6, 0.75, 0.889, 1, 1.25, 4 / 3, 1.6, 16 / 9, 2, 2.4, 3];

  it.each(aspects)('aspect %f keeps the camera inside the room', (aspect) => {
    const cam = new THREE.PerspectiveCamera();
    applyGarageFraming(cam, aspect);
    expect(Math.hypot(cam.position.x, cam.position.z)).toBeLessThan(GARAGE_ROOM_APOTHEM - 0.5);
    expect(cam.position.y).toBeGreaterThan(1);
  });

  it.each(aspects)('aspect %f shows the whole podium', (aspect) => {
    const cam = new THREE.PerspectiveCamera();
    applyGarageFraming(cam, aspect);
    cam.updateMatrixWorld(true);
    const r = GARAGE_PODIUM_OUTER_RADIUS;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (const y of [0, 0.6]) {
        const p = new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r).project(cam);
        expect(Math.abs(p.x)).toBeLessThan(1);
        expect(Math.abs(p.y)).toBeLessThan(1);
      }
    }
  });

  it('uses the base FOV on wide screens and widens it (capped) only on narrow ones', () => {
    const wide = garageCameraFraming(16 / 9);
    expect(garageCameraFraming(21 / 9).fov).toBe(wide.fov);
    expect(garageCameraFraming(4 / 3).fov).toBe(wide.fov);
    const half = garageCameraFraming(960 / 1080);
    expect(half.fov).toBeGreaterThan(wide.fov);
    expect(garageCameraFraming(0.2).fov).toBeLessThanOrEqual(75);
    expect(garageCameraFraming(Number.NaN)).toEqual(wide);
    expect(garageCameraFraming(0)).toEqual(wide);
  });
});
