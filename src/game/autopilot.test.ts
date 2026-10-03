import { describe, expect, it } from 'vitest';
import { AUTOPILOT, createAutopilot, type AutopilotStyle } from './autopilot';
import { createSession, type SessionState } from './session';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING } from '../shared/tuning';
import type { GameEvent, InputFrame } from '../shared/types';

const track = buildTrack(PLAZA);
const DT = 1 / TUNING.race.physicsHz;

interface StepView {
  before: Readonly<SessionState>;
  input: InputFrame;
  after: Readonly<SessionState>;
  events: GameEvent[];
}

/** Races `laps` plaza laps with the default style overridden by `style`, showing every step to `onStep`. */
function raceWith(style: Partial<AutopilotStyle>, laps: number, onStep: (v: StepView) => void): Readonly<SessionState> {
  const sess = createSession(track, { laps });
  const drive = createAutopilot(track, TUNING, { ...AUTOPILOT, ...style });
  for (let i = 0; i < (100 * laps) / DT && sess.state().phase !== 'finished'; i++) {
    const before = sess.state();
    const input = drive(before);
    const events = sess.step(input, { respawn: false }, DT);
    onStep({ before, input, after: sess.state(), events });
  }
  return sess.state();
}

/** A step that kicks a drift from grip. */
const isKick = (v: StepView): boolean => v.before.car.mode === 'grip' && v.after.car.mode === 'drift';

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

  describe('style knobs', () => {
    it('throttleCap caps the throttle of every frame, kicks and drifts included', () => {
      let max = 0;
      let kicks = 0;
      let driftFrames = 0;
      const end = raceWith({ throttleCap: 0.6 }, 1, (v) => {
        max = Math.max(max, v.input.throttle);
        if (v.input.handbrakePressed) kicks++;
        if (v.before.car.mode === 'drift' && v.input.throttle > 0) driftFrames++;
      });
      expect(end.phase).toBe('finished');
      expect(max).toBe(0.6);
      expect(kicks).toBeGreaterThan(0);
      expect(driftFrames).toBeGreaterThan(0);
    });

    it('maxDriftTime leaves every drift shortly after the limit; the default holds them longer', () => {
      const longest = (style: Partial<AutopilotStyle>): number => {
        let max = 0;
        const end = raceWith(style, 1, (v) => (max = Math.max(max, v.after.car.driftTime)));
        expect(end.phase).toBe('finished');
        return max;
      };
      // The exit itself (S, lift or catch with the wheel swinging across) takes well under a second.
      expect(longest({ maxDriftTime: 3 })).toBeLessThan(4);
      expect(longest({})).toBeGreaterThan(5);
    });

    it('linkDrifts 0 kicks only once the last chain has banked; the default links drifts in its grace', () => {
      const kicksInGrace = (style: Partial<AutopilotStyle>): { kicks: number; inGrace: number } => {
        let kicks = 0;
        let inGrace = 0;
        const end = raceWith(style, 1, (v) => {
          if (!isKick(v)) return;
          kicks++;
          if (v.before.score.phase === 'grace') inGrace++;
        });
        expect(end.phase).toBe('finished');
        return { kicks, inGrace };
      };
      const unlinked = kicksInGrace({ linkDrifts: 0 });
      expect(unlinked.kicks).toBeGreaterThan(0);
      expect(unlinked.inGrace).toBe(0);
      expect(kicksInGrace({}).inGrace).toBeGreaterThan(0);
    });

    it('keepChain keeps one chain at the top multiplier across the start straight, where the default banks', () => {
      // Lap 2 from just past the start line to the end of the straight (the first drift corner is at s ~360).
      const onStraight = (st: Readonly<SessionState>): boolean =>
        st.progress.lap === 2 && st.progress.s > track.startS + 10 && st.progress.s < 300;
      const run = (style: Partial<AutopilotStyle>) => {
        const r = { steps: 0, idle: 0, belowTop: 0, starts: 0, banksBeforeFinish: 0, hits: 0, respawns: 0 };
        const end = raceWith(style, 2, (v) => {
          for (const e of v.events) {
            if (e.type === 'chainStart') r.starts++;
            else if (e.type === 'chainBanked' && v.after.phase !== 'finished') r.banksBeforeFinish++;
            else if (e.type === 'hit') r.hits++;
            else if (e.type === 'respawn') r.respawns++;
          }
          if (!onStraight(v.after)) return;
          r.steps++;
          if (v.after.score.phase === 'idle') r.idle++;
          if (v.after.score.multiplier < TUNING.score.multiplierMax) r.belowTop++;
        });
        expect(end.phase).toBe('finished');
        return r;
      };
      // A sliding car swings over slowly: keeping the chain needs the wider bomb clearance the master uses.
      const kept = run({ keepChain: 1, bombClearance: 5 });
      expect(kept.steps).toBeGreaterThan(0);
      expect(kept.idle).toBe(0);
      expect(kept.belowTop).toBe(0);
      expect(kept.starts).toBe(1);
      expect(kept.banksBeforeFinish).toBe(0);
      expect(kept.hits).toBe(0);
      expect(kept.respawns).toBe(0);
      const reference = run({});
      expect(reference.idle).toBeGreaterThan(0);
      expect(reference.banksBeforeFinish).toBeGreaterThan(0);
    });
  });
});
