import { describe, expect, it } from 'vitest';
import { createAutopilot } from './autopilot';
import { createSession } from '../game/session';
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
    expect(events.some((e) => e.type === 'chainBanked' && e.points > 0)).toBe(true);
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
