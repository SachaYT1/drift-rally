import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCarModel } from './carModel';
import { CAR_BODIES } from './carBodies';
import { createCarState } from '../physics/car';
import { TUNING } from '../shared/tuning';

const WHEELS = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'];

describe('car models', () => {
  for (const [id, body] of Object.entries(CAR_BODIES)) {
    it(`${id}: stays within the shared footprint, on the ground`, () => {
      const car = createCarModel(body);
      car.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(car.root);
      expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
      expect(box.max.y).toBeLessThan(1.6);
      expect(Math.max(-box.min.x, box.max.x)).toBeLessThanOrEqual(TUNING.car.width / 2 + 0.06);
      expect(Math.max(-box.min.z, box.max.z)).toBeLessThanOrEqual(TUNING.car.length / 2 + 0.1);
    });

    it(`${id}: has four wheel pivots at the wheelbase that the front ones steer`, () => {
      const car = createCarModel(body);
      const pivots = WHEELS.map((name) => car.root.getObjectByName(name));
      for (const p of pivots) expect(p).toBeDefined();
      expect(pivots.map((p) => Math.sign(p!.position.z))).toEqual([1, 1, -1, -1]);
      for (const p of pivots) expect(Math.abs(p!.position.z)).toBeCloseTo(TUNING.car.wheelBase / 2);
      const state = { ...createCarState(0, 0, 0), steer: 1, forwardSpeed: 5, speed: 5 };
      car.update(state, 0);
      expect(pivots[0]!.rotation.y).toBeGreaterThan(0.1);
      expect(pivots[2]!.rotation.y).toBe(0);
    });
  }
});

describe('car model hop', () => {
  it('a hop lifts the whole car and lands it back on the ground; reset() cancels it', () => {
    const m = createCarModel();
    const car = createCarState(0, 0, 0);
    m.hop();
    const ys: number[] = [];
    for (let i = 0; i < 60; i++) {
      m.root.position.y = 0; // applyPose() runs before every update
      m.update(car, 1 / 60);
      ys.push(m.root.position.y);
    }
    expect(Math.max(...ys)).toBeGreaterThan(0.3);
    expect(Math.max(...ys)).toBeLessThan(0.8);
    expect(ys.at(-1)).toBe(0);
    m.hop();
    m.update(car, 1 / 60);
    m.reset();
    m.root.position.y = 0;
    m.update(car, 1 / 60);
    expect(m.root.position.y).toBe(0);
  });

  it('a paused update (dt 0) holds the hop', () => {
    const m = createCarModel();
    const car = createCarState(0, 0, 0);
    m.hop();
    m.update(car, 1 / 60);
    const y = m.root.position.y;
    expect(y).toBeGreaterThan(0);
    m.root.position.y = 0;
    m.update(car, 0);
    expect(m.root.position.y).toBe(y);
  });
});
