import { describe, expect, it } from 'vitest';
import { CAR_IDS, CARS, DEFAULT_CAR, isCarId, tuningFor } from './cars';
import { TUNING } from './tuning';
import { DEG } from './math';

describe('car catalogue', () => {
  it('lists every car once under its own id, the free starter first', () => {
    expect(new Set(CAR_IDS).size).toBe(CAR_IDS.length);
    expect(Object.keys(CARS).sort()).toEqual([...CAR_IDS].sort());
    for (const id of CAR_IDS) expect(CARS[id].id).toBe(id);
    expect(CAR_IDS[0]).toBe(DEFAULT_CAR);
    expect(CARS[DEFAULT_CAR].price).toBe(0);
  });

  it('prices rise along the line-up', () => {
    for (let i = 1; i < CAR_IDS.length; i++) expect(CARS[CAR_IDS[i]].price).toBeGreaterThan(CARS[CAR_IDS[i - 1]].price);
  });

  it('only overrides values that exist in TUNING', () => {
    for (const id of CAR_IDS) {
      const { car = {}, drift = {} } = CARS[id].tuning;
      for (const key of Object.keys(car)) expect(TUNING.car).toHaveProperty(key);
      for (const key of Object.keys(drift)) expect(TUNING.drift).toHaveProperty(key);
    }
  });

  it('keeps the drift arcs the track was laid out for', () => {
    for (const id of CAR_IDS) {
      const d = tuningFor(id).drift;
      expect([d.curvInto, d.curvNeutral, d.curvCounter]).toEqual([
        TUNING.drift.curvInto,
        TUNING.drift.curvNeutral,
        TUNING.drift.curvCounter,
      ]);
    }
  });

  it('keeps slip angles ordered and within the scoring cap', () => {
    for (const id of CAR_IDS) {
      const d = tuningFor(id).drift;
      expect(d.slipNarrow).toBeLessThan(d.slipMid);
      expect(d.slipMid).toBeLessThan(d.slipWide);
      expect(d.slipWide).toBeLessThanOrEqual(d.slipMax);
      expect(d.slipMax).toBeLessThanOrEqual(TUNING.score.angleCap);
    }
  });

  it('keeps card stats within 0..100', () => {
    for (const id of CAR_IDS) {
      for (const v of Object.values(CARS[id].stats)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('recognises car ids only', () => {
    expect(isCarId('ronin')).toBe(true);
    for (const v of ['RONIN', 'bmw', '', null, 3, undefined, 'toString']) expect(isCarId(v)).toBe(false);
  });
});

describe('tuningFor', () => {
  it('returns the base itself for a car without overrides (live DEV GUI edits keep working)', () => {
    expect(tuningFor('iskra')).toBe(TUNING);
  });

  it('lays a car over car and drift, shares every other section and leaves the base alone', () => {
    const maxSpeed = TUNING.car.maxSpeed;
    const t = tuningFor('ronin');
    expect(t.car.maxSpeed).toBe(43);
    expect(t.car.length).toBe(TUNING.car.length);
    expect(t.drift.slipMid).toBeCloseTo(39 * DEG);
    expect(t.drift.curvNeutral).toBe(TUNING.drift.curvNeutral);
    expect(t.score).toBe(TUNING.score);
    expect(TUNING.car.maxSpeed).toBe(maxSpeed);
  });

  it('uses the given base', () => {
    const base = { ...TUNING, car: { ...TUNING.car, rollingResistance: 1.5 } };
    expect(tuningFor('scarab', base).car.rollingResistance).toBe(1.5);
    expect(tuningFor('scarab', base).car.engineAccel).toBe(13);
  });
});
