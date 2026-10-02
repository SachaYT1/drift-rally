import { describe, expect, it } from 'vitest';
import { createProgress, respawn, startGrace, updateProgress, type ProgressState } from './progress';
import { makeCircleTrack } from './testTracks';
import { TUNING } from '../shared/tuning';
import type { GameEvent } from '../shared/types';

const DT = 1 / 120;
const track = makeCircleTrack(100);
const L = track.length;

/** Drive along the centreline at `speed` (negative = backwards) for `seconds`. */
function drive(state: ProgressState, startS: number, speed: number, seconds: number, t0 = 0, laps = 3) {
  let s = state, along = startS, time = t0;
  const events: GameEvent[] = [];
  let lapsDone = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    along += speed * DT;
    time += DT;
    const pose = track.poseAt(along, 0);
    const r = updateProgress(s, track, { x: pose.x, z: pose.z, speed: Math.abs(speed) }, time, DT, laps);
    s = r.state;
    events.push(...r.events);
    if (r.lapCompleted) lapsDone++;
  }
  return { s, along, time, events, lapsDone };
}

describe('progress', () => {
  it('starts at the spawn offset on lap 1', () => {
    const p = createProgress(track, 3);
    expect(p.p).toBeCloseTo(TUNING.progress.spawnOffset, 1);
    expect(p.frontier).toBe(p.p);
    expect(p.lap).toBe(1);
    expect(p.finished).toBe(false);
  });

  it('completes a lap with the right lap time, continuous across the s wrap', () => {
    const start = createProgress(track, 3);
    const r = drive(start, TUNING.progress.spawnOffset, 20, (L + 10) / 20);
    expect(r.lapsDone).toBe(1);
    expect(r.s.lap).toBe(2);
    expect(r.s.lapTimes[0]).toBeCloseTo((L - TUNING.progress.spawnOffset) / 20, 1);
    expect(r.events.filter((e) => e.type === 'lap')).toHaveLength(1);
  });

  it('finishes after the configured laps exactly once and caps the lap display', () => {
    const r = drive(createProgress(track, 3), TUNING.progress.spawnOffset, 30, (3 * L + 50) / 30);
    expect(r.s.finished).toBe(true);
    expect(r.s.lap).toBe(3);
    expect(r.lapsDone).toBe(3);
  });

  it('driving backwards lowers p, keeps the frontier, and raises wrong-way after the delay', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 3);
    const back = drive(fwd.s, fwd.along, -6, TUNING.progress.wrongWayTime + 0.6, fwd.time);
    expect(back.s.p).toBeLessThan(fwd.s.p);
    expect(back.s.frontier).toBeCloseTo(fwd.s.frontier, 6);
    expect(back.s.wrongWay).toBe(true);
    expect(back.events.filter((e) => e.type === 'wrongWay' && e.active)).toHaveLength(1);
    const again = drive(back.s, back.along, 10, 1, back.time);
    expect(again.s.wrongWay).toBe(false);
  });

  it('grace suppresses wrong-way', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 3);
    const back = drive(startGrace(fwd.s), fwd.along, -6, TUNING.progress.graceTime - 0.1, fwd.time);
    expect(back.s.wrongWay).toBe(false);
  });

  it('clamps teleport-like jumps', () => {
    const s0 = createProgress(track, 3);
    const jump = track.poseAt(TUNING.progress.spawnOffset + 40, 0);
    const r = updateProgress(s0, track, { x: jump.x, z: jump.z, speed: 10 }, DT, DT, 3);
    expect(r.state.p - s0.p).toBeLessThanOrEqual(10 * DT * 1.5 + 0.5 + 1e-6);
  });

  it('respawns at the last marker at or below the frontier', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 177 / 20);
    const { pose, state } = respawn(fwd.s, track);
    expect(state.p).toBeCloseTo(150, 6);
    const expected = track.poseAt(150, 0);
    expect(pose.x).toBeCloseTo(expected.x, 6);
    expect(pose.heading).toBeCloseTo(expected.heading, 6);
    expect(state.frontier).toBeCloseTo(fwd.s.frontier, 6);
  });
});

describe('progress edge cases', () => {
  const lapNumbers = (events: GameEvent[]) => events.flatMap((e) => (e.type === 'lap' ? [e.lap] : []));

  it('does not raise wrong-way before the delay has elapsed', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 3);
    const back = drive(fwd.s, fwd.along, -6, TUNING.progress.wrongWayTime, fwd.time);
    expect(back.s.wrongWay).toBe(false);
    expect(back.events.filter((e) => e.type === 'wrongWay')).toHaveLength(0);
  });

  it('sets finished on the step that completes the final lap and honours the laps argument', () => {
    let st = createProgress(track, 2);
    let along = TUNING.progress.spawnOffset;
    let time = 0;
    let finishing: ReturnType<typeof updateProgress> | null = null;
    while (!st.finished && time < 100) {
      along += 30 * DT;
      time += DT;
      const pose = track.poseAt(along, 0);
      const r = updateProgress(st, track, { x: pose.x, z: pose.z, speed: 30 }, time, DT, 2);
      if (r.state.finished) finishing = r;
      st = r.state;
    }
    expect(finishing).not.toBeNull();
    expect(finishing?.lapCompleted).toBe(true);
    expect(lapNumbers(finishing?.events ?? [])).toEqual([2]);
    expect(st.frontier).toBeGreaterThanOrEqual(2 * L);
    expect(st.lap).toBe(2);
    expect(st.lapTimes).toHaveLength(2);
  });

  it('stops counting laps after the final lap', () => {
    const r = drive(createProgress(track, 3), 3, 30, (4 * L + 50) / 30);
    expect(r.s.lapsCompleted).toBe(3);
    expect(r.s.lapTimes).toHaveLength(3);
    expect(lapNumbers(r.events)).toEqual([1, 2, 3]);
  });

  it('flags a lap as best only when it beats every previous lap', () => {
    const lap1 = drive(createProgress(track, 3), 3, 20, (L + 2) / 20);
    const lap2 = drive(lap1.s, lap1.along, 40, L / 40, lap1.time);
    const lap3 = drive(lap2.s, lap2.along, 20, L / 20, lap2.time);
    const best = [...lap1.events, ...lap2.events, ...lap3.events].flatMap((e) => (e.type === 'lap' ? [e.best] : []));
    expect(best).toEqual([true, true, false]);
  });

  it('respawns onto a real track marker in later laps', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, (L + 77) / 20);
    expect(fwd.s.lapsCompleted).toBe(1);
    const { pose, state } = respawn(fwd.s, track);
    expect(state.p).toBeCloseTo(L + 50, 6);
    expect(state.p).toBeLessThanOrEqual(fwd.s.frontier);
    expect(track.respawnMarkers.some((m) => Math.abs(m - state.s) < 1e-6)).toBe(true);
    const expected = track.poseAt(50, 0);
    expect(pose.x).toBeCloseTo(expected.x, 6);
    expect(pose.z).toBeCloseTo(expected.z, 6);
    expect(state.lapsCompleted).toBe(1);
  });

  it('measures progress and markers from the start line, not from s = 0', () => {
    const shifted = { ...track, startS: 20, spawnPose: track.poseAt(20 + TUNING.progress.spawnOffset, 0) };
    const s0 = createProgress(shifted, 3);
    expect(s0.s).toBeCloseTo(20 + TUNING.progress.spawnOffset, 6);
    expect(s0.p).toBe(TUNING.progress.spawnOffset);
    const atStart = respawn(s0, shifted);
    expect(atStart.state.p).toBe(0);
    expect(atStart.state.s).toBeCloseTo(20, 6);
    const later = respawn({ ...s0, frontier: L + 60 }, shifted);
    expect(later.state.p).toBeCloseTo(L + 50, 6);
    expect(later.state.s).toBeCloseTo(70, 6);
    expect(later.pose.heading).toBeCloseTo(track.poseAt(70, 0).heading, 6);
  });

  it('driving forward again clears wrong-way with exactly one inactive event', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 3);
    const back = drive(fwd.s, fwd.along, -6, TUNING.progress.wrongWayTime + 0.6, fwd.time);
    expect(back.s.wrongWay).toBe(true);
    const again = drive(back.s, back.along, 10, TUNING.progress.wrongWayTime, back.time);
    expect(again.s.wrongWay).toBe(false);
    expect(again.events.filter((e) => e.type === 'wrongWay')).toEqual([{ type: 'wrongWay', active: false }]);
  });

  it('honours a custom tuning for the per-step progress cap and the speed smoothing', () => {
    const t = { ...TUNING, progress: { ...TUNING.progress, dsSpeedFactor: 1, dsSlack: 0.1, speedSmoothing: 1e6 } };
    const s0 = createProgress(track, 3);
    const jump = track.poseAt(TUNING.progress.spawnOffset + 40, 0);
    const r = updateProgress(s0, track, { x: jump.x, z: jump.z, speed: 10 }, DT, DT, 3, t);
    expect(r.state.p - s0.p).toBeCloseTo(10 * DT + 0.1, 9);
    // Smoothing this fast makes progressSpeed the raw ds/dt of the step.
    expect(r.state.progressSpeed).toBeCloseTo((10 * DT + 0.1) / DT, 6);
  });

  it('respawn starts a grace period and the next update clears wrong-way with one event', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 3);
    const back = drive(fwd.s, fwd.along, -6, TUNING.progress.wrongWayTime + 0.6, fwd.time);
    expect(back.s.wrongWay).toBe(true);
    const r = respawn(back.s, track);
    expect(r.state.graceTimer).toBe(TUNING.progress.graceTime);
    expect(r.state.progressSpeed).toBe(0);
    expect(r.state.needsGlobalSearch).toBe(false);
    const next = updateProgress(r.state, track, { x: r.pose.x, z: r.pose.z, speed: 0 }, back.time + DT, DT, 3);
    expect(next.state.wrongWay).toBe(false);
    expect(next.events).toEqual([{ type: 'wrongWay', active: false }]);
    expect(next.state.p).toBeCloseTo(r.state.p, 6);
  });

  it('ignores non-finite car input without poisoning progress', () => {
    const s0 = createProgress(track, 3);
    const r = updateProgress(s0, track, { x: Number.NaN, z: 0, speed: 10 }, DT, DT, 3);
    expect(r.state).toEqual(s0);
    expect(r.events).toEqual([]);
    const pose = track.poseAt(TUNING.progress.spawnOffset + 20, 0);
    const r2 = updateProgress(s0, track, { x: pose.x, z: pose.z, speed: Number.POSITIVE_INFINITY }, DT, DT, 3);
    expect(r2.state.p).toBe(s0.p);
    expect(Number.isFinite(r2.state.frontier)).toBe(true);
  });

  it('projects within the local window, or globally when flagged', () => {
    const calls: [number | undefined, number | undefined][] = [];
    const spy: typeof track = {
      ...track,
      project: (x, z, hintS, window) => {
        calls.push([hintS, window]);
        return track.project(x, z);
      },
    };
    const s0 = createProgress(spy, 3);
    const pose = spy.poseAt(TUNING.progress.spawnOffset + 0.1, 0);
    const a = updateProgress(s0, spy, { x: pose.x, z: pose.z, speed: 10 }, DT, DT, 3);
    expect(calls.at(-1)).toEqual([s0.s, TUNING.progress.window]);
    const b = updateProgress({ ...a.state, needsGlobalSearch: true }, spy, { x: pose.x, z: pose.z, speed: 10 }, 2 * DT, DT, 3);
    expect(calls.at(-1)).toEqual([undefined, undefined]);
    expect(b.state.needsGlobalSearch).toBe(false);
  });

  it('never mutates its input state', () => {
    const near = drive(createProgress(track, 3), 3, 20, (L - 3.5) / 20);
    const frozen: ProgressState = Object.freeze({ ...near.s, lapTimes: Object.freeze([...near.s.lapTimes]) as number[] });
    const pose = track.poseAt(near.along + 0.7, 0);
    const r = updateProgress(frozen, track, { x: pose.x, z: pose.z, speed: 20 }, near.time + DT, DT, 3);
    expect(r.lapCompleted).toBe(true);
    expect(frozen.lapTimes).toHaveLength(0);
    expect(r.state.lapTimes).toHaveLength(1);
    expect(() => respawn(frozen, track)).not.toThrow();
    expect(startGrace(frozen).graceTimer).toBe(TUNING.progress.graceTime);
    expect(frozen.graceTimer).toBe(0);
  });
});

describe('circle test track', () => {
  it('round-trips poseAt / project with +lateral on the left of the heading', () => {
    const cases: [number, number][] = [[0, 0], [37, 3], [300, -6], [L - 1, 9]];
    for (const [s, lat] of cases) {
      const pose = track.poseAt(s, lat);
      const pr = track.project(pose.x, pose.z);
      expect(pr.s).toBeCloseTo(s, 6);
      expect(pr.lateral).toBeCloseTo(lat, 6);
      const c = track.poseAt(s, 0);
      // left = (cos h, -sin h), see shared/types.ts
      const left = (pose.x - c.x) * Math.cos(c.heading) - (pose.z - c.z) * Math.sin(c.heading);
      expect(left).toBeCloseTo(lat, 6);
      expect(pose.heading).toBeCloseTo(c.heading, 9);
    }
  });

  it('spawns spawnOffset after the start line and places markers every respawnSpacing', () => {
    expect(track.project(track.spawnPose.x, track.spawnPose.z).s).toBeCloseTo(TUNING.progress.spawnOffset, 6);
    expect(track.respawnMarkers.length).toBe(Math.ceil(L / TUNING.progress.respawnSpacing));
    expect(track.respawnMarkers[1] - track.respawnMarkers[0]).toBe(TUNING.progress.respawnSpacing);
    expect(track.surfaceAt(0)).toBe('road');
    expect(track.surfaceAt(-(track.barrier + 0.1))).toBe('outside');
  });
});
