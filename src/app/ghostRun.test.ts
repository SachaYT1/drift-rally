import { describe, expect, it } from 'vitest';
import { GHOST_FADE_TIME, createGhostRun } from './ghostRun';
import { BOTS } from '../game/bots';
import { createCarState } from '../physics/car';
import { GHOST_NEAR_OPACITY, GHOST_OPACITY } from '../render/ghostCars';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING } from '../shared/tuning';

const track = buildTrack(PLAZA);
const DT = 1 / TUNING.race.physicsHz;
const FRAME = 1 / 60;
const spawn = track.spawnPose;
/** A player car far from every bot (opacity at its full value). */
const FAR = createCarState(spawn.x + 500, spawn.z + 500, 0);

function stepFor(run: ReturnType<typeof createGhostRun>, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) run.step(DT);
}

describe('ghost run', () => {
  it('steps every bot with the race', () => {
    const run = createGhostRun(track);
    stepFor(run, TUNING.race.countdown + 4);
    for (const b of run.field.bots) expect(b.session.state().progress.p).toBeGreaterThan(20);
  });

  it('gives one view per bot, reused between frames, interpolated between the last two steps', () => {
    const run = createGhostRun(track);
    stepFor(run, TUNING.race.countdown + 4);
    const a = run.views(0, false, FAR, FRAME);
    const b = run.views(1, false, FAR, FRAME);
    expect(b).toBe(a);
    expect(a).toHaveLength(BOTS.length);
    const st = run.field.bots[0].session.state();
    expect(run.views(1, false, FAR, FRAME)[0].car.x).toBeCloseTo(st.car.x);
    expect(run.views(0, false, FAR, FRAME)[0].car.x).toBeCloseTo(st.prevCar.x);
    expect(a[0].points).toBe(st.score.totalPoints);
    expect(a[0].visible).toBe(true);
    expect(a[0].opacity).toBeCloseTo(GHOST_OPACITY);
  });

  it('fades a ghost that sits on the player car', () => {
    const run = createGhostRun(track);
    // Countdown: every bot waits on the spawn pose, like the player.
    const views = run.views(1, true, createCarState(spawn.x, spawn.z, spawn.heading), FRAME);
    for (const v of views) expect(v.opacity).toBeCloseTo(GHOST_NEAR_OPACITY);
  });

  it('finish() fast-forwards the bots, freezes the ghosts where they were and fades them out', () => {
    const run = createGhostRun(track);
    stepFor(run, TUNING.race.countdown + 10);
    const before = run.views(1, false, FAR, FRAME).map((v) => ({ x: v.car.x, z: v.car.z }));
    run.finish();
    for (const b of run.field.bots) expect(b.session.state().phase).toBe('finished');
    const frozen = run.views(1, false, FAR, FRAME);
    frozen.forEach((v, i) => {
      expect(v.car.x).toBeCloseTo(before[i].x);
      expect(v.car.z).toBeCloseTo(before[i].z);
      expect(v.opacity).toBeLessThan(GHOST_OPACITY);
    });
    for (let t = 0; t < GHOST_FADE_TIME; t += FRAME) run.views(1, false, FAR, FRAME);
    for (const v of run.views(1, false, FAR, FRAME)) expect(v.visible).toBe(false);
    // Bots no longer step after the player's finish.
    const time = run.field.bots[0].session.state().time;
    run.step(DT);
    expect(run.field.bots[0].session.state().time).toBe(time);
  });

  it('fades out a bot that finished on its own while the race goes on', () => {
    const run = createGhostRun(track);
    const [first] = run.field.bots;
    // Drive only until the first bot crosses the line.
    for (let i = 0; i < 400 / DT && first.session.state().phase !== 'finished'; i++) run.step(DT);
    expect(first.session.state().phase).toBe('finished');
    for (let t = 0; t <= GHOST_FADE_TIME + FRAME; t += FRAME) run.views(1, false, FAR, FRAME);
    const v = run.views(1, false, FAR, FRAME);
    expect(v[0].visible).toBe(false);
    expect(v[0].points).toBe(first.session.state().result?.totalPoints);
  });

  it('ranks the player among the bots, live and at the finish', () => {
    const run = createGhostRun(track);
    stepFor(run, TUNING.race.countdown + 30);
    const live = run.standings({ points: 1_000_000, finished: false });
    expect(live).toHaveLength(BOTS.length + 1);
    expect(live[0]).toMatchObject({ id: 'player', points: 1_000_000 });
    run.finish();
    const final = run.finalStandings(0);
    expect(final.at(-1)?.id).toBe('player');
    for (const r of final) expect(r.finished).toBe(true);
  });
});
