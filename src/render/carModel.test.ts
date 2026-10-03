import { describe, expect, it } from 'vitest';
import { createCarModel } from './carModel';
import { createCarState } from '../physics/car';

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
