import { describe, expect, it } from 'vitest';
import { createBombs, resetBombs, updateBombs } from './bombs';
import { makeCircleTrack } from './testTracks';
import { createCarState, withDerived } from '../physics/car';
import { TUNING } from '../shared/tuning';
import type { BombSpot } from '../shared/types';

const bomb = (id: string, x: number, z: number): BombSpot => ({ id, x, z, r: TUNING.bomb.radius });
/** Car at (0, z) heading +z at 20 m/s; its capsule axis spans z +/- capsuleHalf. */
const car = (z = 0) => withDerived({ ...createCarState(0, z, 0), vz: 20 });
const track = makeCircleTrack(100, { bombs: [bomb('b1', 0.5, 1.5), bomb('far', 0, 30)] });

describe('bombs', () => {
  it('blows a touched bomb once per lap and throws the car', () => {
    const r1 = updateBombs(createBombs(), track, car());
    expect(r1.events).toEqual([{ type: 'bomb', id: 'b1', x: 0.5, z: 1.5 }]);
    expect(r1.blasted).toBe(true);
    expect(r1.state.blown).toEqual(new Set(['b1']));
    expect(r1.car.mode).toBe('recover');
    expect(r1.car.speed).toBeLessThan(20);
    const r2 = updateBombs(r1.state, track, car());
    expect(r2).toMatchObject({ events: [], blasted: false });
    expect(r2.state).toBe(r1.state);
  });

  it('resetBombs brings every bomb back; an untouched state is kept as is', () => {
    const fresh = resetBombs(updateBombs(createBombs(), track, car()).state);
    expect(fresh.blown.size).toBe(0);
    expect(updateBombs(fresh, track, car()).blasted).toBe(true);
    const idle = createBombs();
    expect(resetBombs(idle)).toBe(idle);
  });

  it('leaves car and state untouched with no bomb in reach', () => {
    const c = car(10);
    const s = createBombs();
    const res = updateBombs(s, track, c);
    expect(res.car).toBe(c);
    expect(res.state).toBe(s);
    expect(res.events).toEqual([]);
  });

  it('two bombs touched at once both blow; the car takes one blast, from the nearer', () => {
    const two = makeCircleTrack(100, { bombs: [bomb('a', 0.6, 1.8), bomb('b', -0.3, -0.4)] });
    const res = updateBombs(createBombs(), two, car());
    expect(res.events.map((e) => (e as { id: string }).id)).toEqual(['a', 'b']);
    expect(res.state.blown).toEqual(new Set(['a', 'b']));
    const onlyB = updateBombs(createBombs(), makeCircleTrack(100, { bombs: [bomb('b', -0.3, -0.4)] }), car());
    expect(res.car).toEqual(onlyB.car);
  });

  it('blows nothing for a non-finite car and never mutates its inputs', () => {
    expect(updateBombs(createBombs(), track, { ...car(), x: Number.NaN })).toMatchObject({ events: [], blasted: false });
    const s = createBombs();
    const c = Object.freeze(car());
    updateBombs(s, track, c);
    expect(s.blown.size).toBe(0);
    expect(c.vz).toBe(20);
  });
});
