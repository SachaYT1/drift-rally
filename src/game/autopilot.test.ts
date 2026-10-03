import { describe, expect, it } from 'vitest';
import { createAutopilot } from './autopilot';
import { createSession } from './session';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING } from '../shared/tuning';
import type { GameEvent } from '../shared/types';

const track = buildTrack(PLAZA);
const DT = 1 / TUNING.race.physicsHz;

describe('autopilot', () => {
  it('finishes a plaza lap with drift points, coins and no respawn', () => {
    const sess = createSession(track, { laps: 1 });
    const drive = createAutopilot(track);
    const events: GameEvent[] = [];
    for (let i = 0; i < 200 / DT && sess.state().phase !== 'finished'; i++) {
      events.push(...sess.step(drive(sess.state()), { respawn: false }, DT));
    }
    const st = sess.state();
    expect(st.phase).toBe('finished');
    expect(st.result!.totalPoints).toBeGreaterThan(0);
    expect(st.result!.coinsPicked).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'respawn')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'bomb')).toHaveLength(0);
    expect(events.some((e) => e.type === 'chainBanked' && e.points > 0)).toBe(true);
  });

  it('drives 3 plaza laps cleanly: at most one heavy hit or burned chain, > 15000 points, laps under 60 s', () => {
    const sess = createSession(track);
    const drive = createAutopilot(track);
    const events: GameEvent[] = [];
    for (let i = 0; i < 300 / DT && sess.state().phase !== 'finished'; i++) {
      events.push(...sess.step(drive(sess.state()), { respawn: false }, DT));
    }
    const r = sess.state().result!;
    expect(r).not.toBeNull();
    expect(events.filter((e) => e.type === 'hit').length).toBeLessThanOrEqual(1);
    expect(events.filter((e) => e.type === 'chainBurned').length).toBeLessThanOrEqual(1);
    expect(events.filter((e) => e.type === 'respawn')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'bomb')).toHaveLength(0);
    expect(r.totalPoints).toBeGreaterThan(15000);
    expect(r.lapTimes).toHaveLength(3);
    for (const lap of r.lapTimes) expect(lap).toBeLessThan(60);
  });

  it('completes the catches it starts: full counter-steer on W is held until the drift ends', () => {
    // Full counter-steer bends the drift path slightly outward (drift.curvCounter < 0). Without a commit the
    // pursuit swung back into a partial-counter hold a few steps into every catch (335 of 338 abandoned),
    // so the car slid on in drift down the straights.
    const sess = createSession(track);
    const drive = createAutopilot(track);
    const D = TUNING.drift;
    let started = 0;
    let caught = 0;
    let abandoned = 0;
    let catching = false;
    for (let i = 0; i < 300 / DT && sess.state().phase !== 'finished'; i++) {
      const before = sess.state().car;
      const input = drive(sess.state());
      sess.step(input, { respawn: false }, DT);
      const after = sess.state().car;
      const dir = before.driftDir;
      const across =
        before.mode === 'drift' && !input.handbrake && before.steer * dir <= -D.catchSteer && input.steer * dir <= -D.catchSteer;
      if (across && !catching) started++;
      catching ||= across;
      if (!catching) continue;
      if (after.mode !== 'drift') caught++;
      else if (after.driftDir !== dir || !across) abandoned++;
      else continue;
      catching = false;
    }
    expect(started).toBeGreaterThan(0);
    expect(abandoned).toBe(0);
    expect(caught).toBe(started);
  });

  it('is deterministic and returns well-formed inputs', () => {
    const run = () => {
      const sess = createSession(track);
      const drive = createAutopilot(track);
      for (let i = 0; i < 1500; i++) {
        const input = drive(sess.state());
        expect(Math.abs(input.steer)).toBeLessThanOrEqual(1);
        expect(input.throttle === 0 || input.throttle === 1).toBe(true);
        sess.step(input, { respawn: false }, DT);
      }
      return sess.state();
    };
    const a = run();
    const b = run();
    expect(a.car).toEqual(b.car);
    expect(a.progress.frontier).toBeGreaterThan(100);
  });
});
