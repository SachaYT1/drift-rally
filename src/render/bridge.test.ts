import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPose } from './bridge';
import { createCarModel, type CarModel } from './carModel';
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

  it('ignores teleports and non-finite input, and reset() levels the body', () => {
    const model = createCarModel();
    run(model, (i) => carState({ vx: i * 0.2, vz: 30 }), 10);
    model.update(carState({ vz: 0 }), 1 / 60); // respawn: speed 30 -> 0 in one frame
    model.update(carState({ vz: Number.NaN }), 1 / 60);
    const body = named(model, 'body');
    expect(Number.isFinite(body.rotation.x) && Number.isFinite(body.rotation.z)).toBe(true);
    expect(Math.abs(body.rotation.x)).toBeLessThan(0.01);
    model.reset();
    expect(body.rotation.z).toBe(0);
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
});
