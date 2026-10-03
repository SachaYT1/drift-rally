/**
 * Wall slide on the Plaza track (see collision.wallSlide.test.ts for the mechanics). Barrier direction
 * contract, W-only nose-ins at the bicycle tyre and the sneaker, and the whole race step (session: broad
 * phase, progress, wrong-way): drive down the start straight, turn into the right barrier at several angles
 * (or kick a drift into it), then hold W with no steer. The car must come free along the track and never
 * raise wrong-way.
 */
import { describe, expect, it } from 'vitest';
import { createCarState, stepCar, withDerived } from './car';
import { resolveCollisions } from './collision';
import { createSession } from '../game/session';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING } from '../shared/tuning';
import { DEG } from '../shared/math';
import { NEUTRAL_INPUT, type CarState, type GameEvent, type InputFrame } from '../shared/types';

const DT = 1 / TUNING.race.physicsHz;
const W: InputFrame = { ...NEUTRAL_INPUT, throttle: 1 };
const track = buildTrack(PLAZA);

describe('wall slide on the Plaza track', () => {
  it('barrier segments run in the driving direction (the slide reads the track direction from them)', () => {
    for (const w of track.walls) {
      if (w.kind !== 'wall') throw new Error('walls must be wall colliders');
      const p = track.project((w.ax + w.bx) / 2, (w.az + w.bz) / 2);
      const tan = track.sampleAt(p.s);
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      expect(((w.bx - w.ax) * tan.tx + (w.bz - w.az) * tan.tz) / len).toBeGreaterThan(0.9);
    }
  });

  /** Car on the track at (s, lateral), `yaw` off the track direction, `v` m/s along its heading. */
  function approach(s: number, lateral: number, yaw: number, v: number): CarState {
    const p = track.poseAt(s, lateral);
    const h = p.heading + yaw;
    return withDerived({ ...createCarState(p.x, p.z, h), vx: v * Math.sin(h), vz: v * Math.cos(h) });
  }

  /**
   * W only into the local colliders. Freed = no contact with obstacle `id` for 0.25 s, at >= 5 m/s, moving
   * forward along the track (> progress.minProgressSpeed-like 2 m/s). Returns the seconds until then (or
   * Infinity) and the longest run moving back along the track faster than progress.wrongWaySpeed.
   */
  function freeFrom(start: CarState, id: string, seconds = 4): { contactAt: number; freed: number; backward: number } {
    let s = start;
    let hint = track.project(s.x, s.z).s;
    let contactAt = Infinity;
    let lastContact = -Infinity;
    let backward = 0;
    let run = 0;
    for (let i = 1; i <= Math.round(seconds / DT); i++) {
      s = stepCar(s, W, 'road', DT);
      const r = resolveCollisions(s, track.collidersNear(s.x, s.z, 6));
      s = r.state;
      if (r.contacts.some((c) => c.colliderId.startsWith(id))) {
        contactAt = Math.min(contactAt, i * DT);
        lastContact = i * DT;
      }
      const p = track.project(s.x, s.z, hint);
      hint = p.s;
      const tan = track.sampleAt(p.s);
      const ds = s.vx * tan.tx + s.vz * tan.tz;
      run = ds < TUNING.progress.wrongWaySpeed ? run + DT : 0;
      backward = Math.max(backward, run);
      if (contactAt < Infinity && i * DT - lastContact >= 0.25 && s.speed >= 5 && ds > 2) {
        return { contactAt, freed: lastContact, backward };
      }
    }
    return { contactAt, freed: Infinity, backward };
  }

  it('a slow nose-in at the bicycle tyre or the sneaker slides off it within ~1 s with W only', () => {
    // Without the slide, 7 of these never come free in 6 s and most others take 3-5.5 s.
    const cases: { label: string; id: string; s: number; lateral: number; yaw: number; limit: number }[] = [];
    // Sneaker (axis s ~1642.6-1647.5 at lateral -5.4, r 1): at its upstream cap, centred, offset and angled.
    for (const lateral of [-5.4, -4.8, -6]) {
      for (const yaw of [0, -15, 15]) {
        const label = `sneaker lat ${lateral} yaw ${yaw}`;
        cases.push({ label, id: 'sneaker', s: 1638, lateral, yaw: yaw * DEG, limit: 1.2 });
      }
    }
    // Bicycle front tyre (axis from s ~575.2 lat -11.05 to s ~578.2 lat -7.5, r 1.3), at 52 deg to the track
    // and crossing the right barrier. Nose-first into the corner it forms with the barrier, the car first lines
    // up with the barrier, then slides off the tyre's end toward the road: up to ~2 s.
    for (const [lateral, yaws] of [
      [-8, [0, -20]],
      [-9, [0, -20, 20]],
      [-10.5, [0, -20, 20]],
    ] as const) {
      for (const yaw of yaws) {
        const limit = lateral === -10.5 && yaw === -20 ? 2 : 1.2;
        const label = `bicycle lat ${lateral} yaw ${yaw}`;
        cases.push({ label, id: 'bicycle', s: 570, lateral, yaw: yaw * DEG, limit });
      }
    }
    for (const k of cases) {
      for (const v of [3, 5]) {
        const r = freeFrom(approach(k.s, k.lateral, k.yaw, v), k.id);
        expect(r.contactAt, `${k.label} v ${v}`).toBeLessThan(2);
        expect(r.freed - r.contactAt, `${k.label} v ${v}`).toBeLessThanOrEqual(k.limit);
        // At 5 m/s plus W the first touch can be a heavy hit, whose bounce may roll back for a step or two.
        expect(r.backward, `${k.label} v ${v}`).toBeLessThan(0.25 * TUNING.progress.wrongWayTime);
      }
    }
  });
});

interface Outcome {
  /** Seconds from the first barrier contact until the car runs free along the track (Infinity if never). */
  freedAfter: number;
  heavyHits: number;
  wrongWay: boolean;
  /** Progress gained in the 4 s after the first contact, m. */
  gained: number;
}

/**
 * Countdown, `run` s of W, then `turn` (steer right, optionally a drift kick) until the first barrier
 * contact (at most 4 s), then W only for 4 s. Freed = no contact for 0.25 s, >= 6 m/s, ds/dt > 3 m/s.
 */
function crash(run: number, turn: { seconds: number; kick: boolean }): Outcome {
  const session = createSession(track, { laps: 3 });
  const events: GameEvent[] = [];
  const step = (input: InputFrame): GameEvent[] => {
    const ev = session.step(input, { respawn: false }, DT);
    events.push(...ev);
    return ev;
  };
  while (session.state().phase === 'countdown') step(NEUTRAL_INPUT);
  for (let i = 0; i < Math.round(run / DT); i++) step(W);

  const steer: InputFrame = { ...W, steer: -1 };
  let contactAt = -1;
  for (let i = 0; i < Math.round(4 / DT) && contactAt < 0; i++) {
    const kick = turn.kick && i === Math.round(turn.seconds / DT);
    const input = i < turn.seconds / DT || turn.kick ? { ...steer, handbrake: kick, handbrakePressed: kick } : W;
    if (step(input).some((e) => e.type === 'hit' || e.type === 'scrape')) contactAt = i;
  }
  expect(contactAt, 'reached the barrier').toBeGreaterThanOrEqual(0);

  const p0 = session.state().progress.p;
  let lastContact = 0;
  let freedAfter = Infinity;
  let heavyHits = events.filter((e) => e.type === 'hit').length;
  for (let i = 1; i <= Math.round(4 / DT); i++) {
    const ev = step(W);
    // Contact events are throttled per collider (collision.cooldown); a hit always reports.
    if (ev.some((e) => e.type === 'hit' || e.type === 'scrape')) lastContact = i * DT;
    heavyHits += ev.filter((e) => e.type === 'hit').length;
    const st = session.state();
    const free = i * DT - lastContact >= Math.max(0.25, TUNING.collision.cooldown + DT);
    if (freedAfter === Infinity && free && st.car.speed >= 6 && st.progress.progressSpeed > 3) freedAfter = lastContact;
  }
  return {
    freedAfter,
    heavyHits,
    wrongWay: events.some((e) => e.type === 'wrongWay' && e.active),
    gained: session.state().progress.p - p0,
  };
}

describe('wall slide in a race (Plaza start straight, right barrier)', () => {
  it('a shallow to steep turn into the barrier, then W only: the car slides free along the track', () => {
    for (const seconds of [0.15, 0.3, 0.5, 0.8]) {
      const o = crash(1.2, { seconds, kick: false });
      const label = `steer right ${seconds} s`;
      expect(o.wrongWay, label).toBe(false);
      expect(o.freedAfter, label).toBeLessThanOrEqual(1.5);
      expect(o.gained, label).toBeGreaterThan(20);
    }
  });

  it('a drift kicked into the barrier (spinning crash), then W only: free toward the track direction', () => {
    for (const [run, seconds] of [
      [1.2, 0],
      [1.6, 0],
      [1.6, 0.2],
      [2.2, 0.1],
    ] as const) {
      const o = crash(run, { seconds, kick: true });
      const label = `W ${run} s, kick after ${seconds} s`;
      expect(o.wrongWay, label).toBe(false);
      expect(o.freedAfter, label).toBeLessThanOrEqual(2.5);
      expect(o.gained, label).toBeGreaterThan(10);
    }
  });
});
