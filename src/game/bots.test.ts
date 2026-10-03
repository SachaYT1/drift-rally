import { describe, expect, it } from 'vitest';
import { BOTS, BOT_TIME_CAP, PLAYER_NAME, createBotDriver, createBotField, livePoints, standings, type BotDef, type BotRun } from './bots';
import { createSession, type Session } from './session';
import { createAutopilot } from './autopilot';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING } from '../shared/tuning';
import { DT } from './testSession';
import type { GameEvent } from '../shared/types';

const track = buildTrack(PLAZA);

/** A stand-in bot run: only the session state that standings() reads matters. */
function fakeRun(def: BotDef, totalPoints: number, finalPoints: number | null, chainPoints = 0): BotRun {
  const state = {
    phase: finalPoints === null ? 'racing' : 'finished',
    score: { totalPoints, chainPoints },
    result: finalPoints === null ? null : { totalPoints: finalPoints },
  };
  return { def, session: { track, state: () => state, step: () => [] } as unknown as Session };
}

describe('bot roster', () => {
  it('has the three levels with unique ids, Russian names and distinct colours', () => {
    expect(BOTS.map((b) => b.id)).toEqual(['rookie', 'pro', 'master']);
    expect(BOTS.map((b) => b.name)).toEqual(['Новичок', 'Профи', 'Мастер']);
    expect(new Set(BOTS.map((b) => b.color)).size).toBe(3);
  });
});

/** One bot's whole race with its own style; the field drops events, so this loop counts them. */
function raceBot(def: BotDef) {
  const sess = createSession(track);
  const drive = createBotDriver(track, def);
  const events: GameEvent[] = [];
  for (let i = 0; i < 400 / DT && sess.state().phase !== 'finished'; i++) {
    events.push(...sess.step(drive(sess.state()), { respawn: false }, DT));
  }
  const count = (type: GameEvent['type']) => events.filter((e) => e.type === type).length;
  return { st: sess.state(), hits: count('hit'), respawns: count('respawn') };
}

describe('bot levels (calibration, spec §2.1 / §3.5)', () => {
  const RANGES: Record<string, [number, number]> = {
    rookie: [20_000, 30_000],
    pro: [45_000, 55_000],
    master: [85_000, Infinity],
  };
  const runs = BOTS.map((def) => ({ def, ...raceBot(def) }));

  for (const r of runs) {
    it(`${r.def.name} finishes all laps cleanly within its score range`, () => {
      const [lo, hi] = RANGES[r.def.id];
      expect(r.st.phase).toBe('finished');
      expect(r.st.result?.lapTimes).toHaveLength(TUNING.race.laps);
      expect(r.respawns).toBe(0);
      expect(r.hits).toBeLessThanOrEqual(2);
      expect(r.st.result!.totalPoints).toBeGreaterThanOrEqual(lo);
      expect(r.st.result!.totalPoints).toBeLessThanOrEqual(hi);
    });
  }

  it('ranks the levels rookie < pro < master', () => {
    const points = runs.map((r) => r.st.result!.totalPoints);
    expect(points[0]).toBeLessThan(points[1]);
    expect(points[1]).toBeLessThan(points[2]);
  });
});

describe('bot field', () => {
  it('starts every bot in the countdown at the spawn pose', () => {
    const field = createBotField(track);
    expect(field.bots).toHaveLength(BOTS.length);
    for (const b of field.bots) {
      const st = b.session.state();
      expect(st.phase).toBe('countdown');
      expect(st.car.x).toBe(track.spawnPose.x);
      expect(st.car.z).toBe(track.spawnPose.z);
    }
  });

  it('steps every bot through the countdown and onto the track', () => {
    const field = createBotField(track);
    for (let i = 0; i < (TUNING.race.countdown + 5) / DT; i++) field.step(DT);
    for (const b of field.bots) {
      const st = b.session.state();
      expect(st.phase).toBe('racing');
      expect(st.progress.p).toBeGreaterThan(30);
    }
  });

  it('fastForward() finishes every bot from mid-race', () => {
    const field = createBotField(track);
    for (let i = 0; i < 20 / DT; i++) field.step(DT);
    field.fastForward();
    for (const b of field.bots) {
      const st = b.session.state();
      expect(st.phase).toBe('finished');
      expect(st.result?.lapTimes).toHaveLength(TUNING.race.laps);
    }
  });

  it('fastForward() stops a bot at the race-time cap', () => {
    const field = createBotField(track);
    field.fastForward(10);
    for (const b of field.bots) {
      const st = b.session.state();
      expect(st.phase).toBe('racing');
      expect(st.time).toBeGreaterThanOrEqual(10);
      expect(st.time).toBeLessThan(10 + 2 * DT);
    }
    expect(BOT_TIME_CAP).toBe(600);
  });

  it('never touches the player: the player session ends the same with or without a field', () => {
    const run = (withBots: boolean) => {
      const player = createSession(track);
      const drive = createAutopilot(track);
      const field = withBots ? createBotField(track) : null;
      for (let i = 0; i < 400 / DT && player.state().phase !== 'finished'; i++) {
        player.step(drive(player.state()), { respawn: false }, DT);
        field?.step(DT);
      }
      return player.state();
    };
    expect(run(true)).toEqual(run(false));
  });

  it('drives each bot with its own style', () => {
    // kickCurv far above any corner: this driver never kicks a drift, the default one does within 30 s.
    const drifts = (style: BotDef['style']) => {
      const drive = createBotDriver(track, { id: 'rookie', name: 'x', color: 0, style });
      const sess = createSession(track);
      let drift = false;
      for (let i = 0; i < (TUNING.race.countdown + 30) / DT; i++) {
        sess.step(drive(sess.state()), { respawn: false }, DT);
        drift ||= sess.state().car.mode === 'drift';
      }
      return drift;
    };
    expect(drifts({})).toBe(true);
    expect(drifts({ kickCurv: 10 })).toBe(false);
  });
});

describe('standings', () => {
  const [rookie, pro, master] = BOTS;

  it('sorts by points, the player row named «Ты» without a colour', () => {
    const rows = standings({ points: 500, finished: false }, [fakeRun(rookie, 100, null), fakeRun(master, 900, null)], false);
    expect(rows.map((r) => r.id)).toEqual(['master', 'player', 'rookie']);
    expect(rows[1]).toEqual({ id: 'player', name: PLAYER_NAME, color: null, points: 500, finished: false });
    expect(rows[0]).toMatchObject({ name: master.name, color: master.color, points: 900, finished: false });
  });

  it('ranks the player above a bot on a tie and keeps tied bots in roster order', () => {
    const rows = standings(
      { points: 300, finished: false },
      [fakeRun(master, 300, null), fakeRun(rookie, 300, null), fakeRun(pro, 300, null)],
      false,
    );
    expect(rows.map((r) => r.id)).toEqual(['player', 'rookie', 'pro', 'master']);
  });

  it('flags finished bots and uses their result in the final standings', () => {
    const bots = [fakeRun(rookie, 200, 200), fakeRun(pro, 700, null)];
    const live = standings({ points: 400, finished: false }, bots, false);
    expect(live.find((r) => r.id === 'rookie')?.finished).toBe(true);
    expect(live.find((r) => r.id === 'pro')?.finished).toBe(false);
    const done = standings({ points: 400, finished: true }, [fakeRun(rookie, 150, 250), fakeRun(pro, 700, null)], true);
    expect(done.map((r) => [r.id, r.points])).toEqual([
      ['pro', 700],
      ['player', 400],
      ['rookie', 250],
    ]);
  });

  it('counts the running chain in the live points, not in the final ones', () => {
    expect(livePoints({ totalPoints: 100, chainPoints: 40 } as Parameters<typeof livePoints>[0])).toBe(140);
    const live = standings({ points: 120, finished: false }, [fakeRun(master, 100, null, 40)], false);
    expect(live.map((r) => [r.id, r.points])).toEqual([
      ['master', 140],
      ['player', 120],
    ]);
  });

  it('rounds points like the HUD and ranks by the shown numbers', () => {
    const rows = standings({ points: 10.4, finished: false }, [fakeRun(rookie, 10.6, null), fakeRun(pro, 9.6, null)], false);
    expect(rows.map((r) => [r.id, r.points])).toEqual([
      ['rookie', 11],
      ['player', 10],
      ['pro', 10],
    ]);
  });
});
