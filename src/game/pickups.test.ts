import { describe, expect, it } from 'vitest';
import { createPickups, resetLap, updatePickups } from './pickups';
import { makeCircleTrack } from './testTracks';
import { createCarState } from '../physics/car';
import { TUNING } from '../shared/tuning';
import { wrapAngle } from '../shared/math';

const track = makeCircleTrack(100, {
  coins: [{ id: 0, x: 0, z: 2.0 + 1.05 }, { id: 1, x: 3.5, z: 0 }],
  lightProps: [{ id: 'can-1', kind: 'can', x: 0, z: -2, r: TUNING.pickups.canRadius, heading: 0 }],
});
const movingCar = () => ({ ...createCarState(0, 0, 0), vz: 20, speed: 20, forwardSpeed: 20 });

describe('pickups', () => {
  it('collects coins within the radius of the capsule, once per lap', () => {
    const r1 = updatePickups(createPickups(), track, movingCar());
    expect(r1.events.filter((e) => e.type === 'coin').map((e) => (e as { id: number }).id)).toEqual([0]);
    expect(r1.state.coinsPicked).toBe(1);
    const r2 = updatePickups(r1.state, track, movingCar());
    expect(r2.events.filter((e) => e.type === 'coin')).toHaveLength(0);
  });

  it('resetLap restores coins and props but keeps the race total', () => {
    const r1 = updatePickups(createPickups(), track, movingCar());
    const reset = resetLap(r1.state);
    expect(reset.coinsTaken.size).toBe(0);
    expect(reset.propsKnocked.size).toBe(0);
    expect(reset.coinsPicked).toBe(1);
    expect(updatePickups(reset, track, movingCar()).events.some((e) => e.type === 'coin')).toBe(true);
  });

  it('knocks a light prop once, launching it and slowing the car slightly', () => {
    const r = updatePickups(createPickups(), track, movingCar());
    const knock = r.events.find((e) => e.type === 'propKnocked');
    expect(knock).toBeDefined();
    expect(r.knocked).toBe(1);
    expect(r.car.speed).toBeCloseTo(20 * (1 - TUNING.pickups.knockSpeedLoss), 6);
    expect(updatePickups(r.state, track, r.car).knocked).toBe(0);
  });
});

describe('pickups edge cases', () => {
  const loss = 1 - TUNING.pickups.knockSpeedLoss;
  const carWithVelocity = (heading: number, vx: number, vz: number) => {
    const speed = Math.hypot(vx, vz);
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    return {
      ...createCarState(0, 0, heading),
      vx,
      vz,
      speed,
      forwardSpeed: vx * fx + vz * fz,
      lateralSpeed: vx * fz - vz * fx,
      slip: wrapAngle(heading - Math.atan2(vx, vz)),
    };
  };

  it('emits coin and prop events at the spot positions; props launch at 1.2x the car velocity', () => {
    const r = updatePickups(createPickups(), track, movingCar());
    expect(r.events).toContainEqual({ type: 'coin', id: 0, x: 0, z: 3.05 });
    const knock = r.events.find((e) => e.type === 'propKnocked');
    expect(knock).toMatchObject({ id: 'can-1', kind: 'can', x: 0, z: -2, vx: 0 });
    expect((knock as { vz: number }).vz).toBeCloseTo(20 * 1.2, 9);
  });

  it('never mutates its inputs and keeps counting coins across laps', () => {
    const start = createPickups();
    const car = Object.freeze(movingCar());
    const r1 = updatePickups(start, track, car);
    expect(start.coinsTaken.size).toBe(0);
    expect(start.propsKnocked.size).toBe(0);
    expect(start.coinsPicked).toBe(0);
    expect(car.speed).toBe(20);
    expect(r1.state).not.toBe(start);

    const reset = resetLap(r1.state);
    expect(r1.state.coinsTaken.has(0)).toBe(true);
    expect(r1.state.propsKnocked.has('can-1')).toBe(true);
    expect(updatePickups(reset, track, car).state.coinsPicked).toBe(2);
  });

  it('slows a sliding car once per knocked prop, keeping its direction and derived fields consistent', () => {
    const r = TUNING.pickups.canRadius;
    const twoCans = makeCircleTrack(100, {
      lightProps: [
        { id: 'can-a', kind: 'can', x: 0.8, z: 1, r, heading: 0 },
        { id: 'can-b', kind: 'cup', x: -0.8, z: -1, r: TUNING.pickups.cupRadius, heading: 0 },
      ],
    });
    const car = carWithVelocity(0.4, 6, 18);
    const res = updatePickups(createPickups(), twoCans, car);
    const k = loss * loss;
    expect(res.knocked).toBe(2);
    expect(res.state.propsKnocked).toEqual(new Set(['can-a', 'can-b']));
    expect(res.car.vx).toBeCloseTo(6 * k, 9);
    expect(res.car.vz).toBeCloseTo(18 * k, 9);
    expect(res.car.speed).toBeCloseTo(car.speed * k, 9);
    expect(res.car.forwardSpeed).toBeCloseTo(car.forwardSpeed * k, 9);
    expect(res.car.lateralSpeed).toBeCloseTo(car.lateralSpeed * k, 9);
    expect(res.car.slip).toBeCloseTo(car.slip, 9);
    expect(res.car.heading).toBe(car.heading);
  });

  it('reports zero slip when a knock drops the car below 1 m/s', () => {
    const car = carWithVelocity(0, 0.25, 0.98);
    expect(car.speed).toBeGreaterThanOrEqual(1);
    expect(car.speed * loss).toBeLessThan(1);
    const res = updatePickups(createPickups(), track, car);
    expect(res.knocked).toBe(1);
    expect(res.car.slip).toBe(0);
  });

  it('a prop can be knocked again after resetLap', () => {
    const first = updatePickups(createPickups(), track, movingCar());
    expect(first.knocked).toBe(1);
    expect(updatePickups(first.state, track, first.car).knocked).toBe(0);
    const again = updatePickups(resetLap(first.state), track, first.car);
    expect(again.knocked).toBe(1);
    expect(again.events.filter((e) => e.type === 'propKnocked').map((e) => (e as { id: string }).id)).toEqual(['can-1']);
    expect(again.state.propsKnocked).toEqual(new Set(['can-1']));
    expect(again.car.speed).toBeCloseTo(first.car.speed * loss, 9);
  });

  it('honours a custom prop launch factor', () => {
    const t = { ...TUNING, pickups: { ...TUNING.pickups, propLaunchFactor: 2 } };
    const knock = updatePickups(createPickups(), track, movingCar(), t).events.find((e) => e.type === 'propKnocked');
    expect((knock as { vz: number }).vz).toBeCloseTo(20 * 2, 9);
  });

  it('leaves the car untouched when nothing is knocked', () => {
    const coinsOnly = makeCircleTrack(100, { coins: [{ id: 7, x: 0, z: 2 }] });
    const car = movingCar();
    const res = updatePickups(createPickups(), coinsOnly, car);
    expect(res.knocked).toBe(0);
    expect(res.car).toBe(car);
    expect(res.state.propsKnocked.size).toBe(0);
  });

  it('never misses an overlap because of the broad-phase radius when tuning grows the reach', () => {
    const bigCoins = { ...TUNING, pickups: { ...TUNING.pickups, coinRadius: 10 } };
    const farCoin = makeCircleTrack(100, { coins: [{ id: 3, x: 9, z: 0 }] });
    const res = updatePickups(createPickups(), farCoin, movingCar(), bigCoins);
    expect(res.state.coinsPicked).toBe(1);
    expect(updatePickups(createPickups(), farCoin, movingCar()).state.coinsPicked).toBe(0);
  });

  it('collects nothing and does not throw for a non-finite car', () => {
    const res = updatePickups(createPickups(), track, { ...movingCar(), x: Number.NaN });
    expect(res.events).toEqual([]);
    expect(res.knocked).toBe(0);
    expect(res.state.coinsPicked).toBe(0);
  });
});
