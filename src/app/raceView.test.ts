import { describe, expect, it } from 'vitest';
import { HINT_SECONDS, hintVisible, hudViewOf, parkedCar } from './raceView';
import { createSession, type SessionState } from '../game/session';
import { createCarState } from '../physics/car';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING } from '../shared/tuning';

const track = buildTrack(PLAZA);

describe('hudViewOf', () => {
  it('maps the session state onto the HUD fields', () => {
    const st = createSession(track, { bestLap: 61.5 }).state();
    const v = hudViewOf(st);
    expect(v).toEqual({
      lap: 1,
      laps: TUNING.race.laps,
      time: 0,
      bestLap: 61.5,
      coins: 0,
      speed: 0,
      chainPoints: 0,
      multiplier: 1,
      chainPhase: 'idle',
      totalPoints: 0,
      wrongWay: false,
    });
  });
});

describe('hintVisible', () => {
  const base = createSession(track).state();
  const at = (phase: SessionState['phase'], time: number): SessionState => ({ ...base, phase, time });
  it('shows through the countdown and the first seconds of racing only', () => {
    expect(hintVisible(at('countdown', 0))).toBe(true);
    expect(hintVisible(at('racing', HINT_SECONDS - 0.01))).toBe(true);
    expect(hintVisible(at('racing', HINT_SECONDS))).toBe(false);
    expect(hintVisible(at('finished', 1))).toBe(false);
  });
});

describe('parkedCar', () => {
  it('keeps the pose, zeroes motion and leaves drift mode without touching the input', () => {
    const moving = Object.freeze({ ...createCarState(3, 4, 1.2), vx: 10, vz: 5, speed: 11.2, slip: 0.5, mode: 'drift' as const, driftDir: 1 as const });
    const p = parkedCar(moving);
    expect(p).toMatchObject({ x: 3, z: 4, heading: 1.2, vx: 0, vz: 0, speed: 0, slip: 0, mode: 'grip', driftDir: 0 });
    expect(moving.speed).toBe(11.2);
  });
});
