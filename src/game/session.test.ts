import { describe, expect, it } from 'vitest';
import { createSession, type Session } from './session';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { createFixedLoop } from '../core/loop';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type GameEvent, type InputFrame } from '../shared/types';
import { clamp, wrapAngle } from '../shared/math';
import { makeCircleTrack } from './testTracks';
import { DT, FULL_THROTTLE, autopilotFor, runFor } from './testSession';

const track = buildTrack(PLAZA);

/** The drift-aware autopilot (src/game/autopilot.ts) driving the plaza session. */
const autopilot = autopilotFor(track);

/**
 * Turns the car around and drives it against the track: steers toward the reversed tangent, pulled back
 * toward the centreline (facing against the track, +lateral lies on the car's right).
 */
function wrongWayDriver(sess: Session): InputFrame {
  const st = sess.state();
  const tangent = sess.track.sampleAt(st.progress.s);
  const target = Math.atan2(-tangent.tx, -tangent.tz) + clamp(st.progress.lateral * 0.05, -0.4, 0.4);
  const err = wrapAngle(target - st.car.heading);
  // Creep through the U-turn (tight radius), then drive on.
  const throttle = Math.abs(err) > 0.5 && st.car.speed > 4 ? 0 : 0.5;
  return { ...NEUTRAL_INPUT, throttle, steer: clamp(err * 2, -1, 1) };
}

/** Steps the autopilot until the race finishes (or maxSeconds); returns every event. */
function race(sess: Session, maxSeconds = 400) {
  const events: GameEvent[] = [];
  for (let i = 0; i < maxSeconds / DT && sess.state().phase !== 'finished'; i++) {
    events.push(...sess.step(autopilot(sess), { respawn: false }, DT));
  }
  return events;
}

describe('session', () => {
  it('runs with the given tuning (default TUNING) and reports it', () => {
    expect(createSession(track).tuning).toBe(TUNING);
    const tuning = { ...TUNING, car: { ...TUNING.car, maxSpeed: 38 } };
    expect(createSession(track, { tuning }).tuning).toBe(tuning);
  });

  it('counts down 3-2-1-0 once each and holds the car still', () => {
    const sess = createSession(track);
    const ev = runFor(sess, TUNING.race.countdown + 0.05, () => ({ ...NEUTRAL_INPUT, throttle: 1 }));
    expect(ev.filter((e) => e.type === 'countdown').map((e) => (e as { value: number }).value)).toEqual([3, 2, 1, 0]);
    expect(sess.state().phase).toBe('racing');
    expect(sess.state().car.speed).toBeLessThan(1);
  });

  it('the autopilot finishes 3 laps with points, coins and no NaN', () => {
    const sess = createSession(track);
    let finish: GameEvent | undefined;
    for (let i = 0; i < 400 * 120 && !finish; i++) {
      const ev = sess.step(autopilot(sess), { respawn: false }, DT);
      finish = ev.find((e) => e.type === 'finish');
      const c = sess.state().car;
      expect(Number.isFinite(c.x) && Number.isFinite(c.z)).toBe(true);
    }
    expect(finish).toBeDefined();
    const r = sess.state().result!;
    expect(r.lapTimes).toHaveLength(3);
    expect(r.totalPoints).toBeGreaterThan(0);
    expect(r.coinsEarned).toBe(r.coinsPicked + Math.floor(r.totalPoints / TUNING.score.pointsPerCoin));
    expect(sess.step(autopilot(sess), { respawn: false }, DT)).toEqual([]);
  });

  it('respawn teleports to a marker and flags the step', () => {
    const sess = createSession(track);
    runFor(sess, TUNING.race.countdown + 6, autopilot);
    const ev = sess.step(NEUTRAL_INPUT, { respawn: true }, DT);
    expect(ev.some((e) => e.type === 'respawn')).toBe(true);
    expect(sess.state().teleported).toBe(true);
    expect(sess.state().car.speed).toBeLessThan(0.5);
  });

  it('is deterministic: two sessions fed the same autopilot end in identical states', () => {
    const run = () => { const s = createSession(track); for (let i = 0; i < 1500; i++) s.step(autopilot(s), { respawn: false }, DT); return s.state(); };
    const a = run(), b = run();
    expect(a.car).toEqual(b.car);
    expect(a.score).toEqual(b.score);
    expect(a.progress).toEqual(b.progress);
  });

  it('the fixed loop runs the same number of steps for 60 Hz and 144 Hz frame schedules', () => {
    const count = (frame: number) => {
      let k = 0;
      const loop = createFixedLoop({ hz: 120, maxStepsPerFrame: 12, maxFrameDt: 0.1, raf: () => 0, caf: () => {}, render: () => {}, step: () => { k++; } });
      for (let t = 0; t < 10 - 1e-9; t += frame) loop.advance(frame);
      return k;
    };
    expect(Math.abs(count(1 / 60) - count(1 / 144))).toBeLessThanOrEqual(1);
  });
});

describe('session: countdown and teleports', () => {
  it('ignores driving input and respawn during the countdown', () => {
    const sess = createSession(track);
    const start = sess.state().car;
    const wild: InputFrame = { throttle: 1, brake: 1, steer: -1, handbrake: true, handbrakePressed: true };
    for (let i = 0; i < Math.round(TUNING.race.countdown / DT) - 1; i++) {
      const ev = sess.step(wild, { respawn: true }, DT);
      expect(ev.every((e) => e.type === 'countdown')).toBe(true);
      const st = sess.state();
      expect(st.phase).toBe('countdown');
      expect(st.car).toEqual(start);
      expect(st.prevCar).toEqual(start);
      expect(st.time).toBe(0);
    }
  });

  it('a non-positive or NaN dt changes nothing', () => {
    const sess = createSession(track);
    runFor(sess, TUNING.race.countdown + 1, () => FULL_THROTTLE);
    const before = sess.state();
    for (const dt of [0, -DT, Number.NaN]) expect(sess.step(FULL_THROTTLE, { respawn: true }, dt)).toEqual([]);
    expect(sess.state()).toBe(before);
  });

  it('teleported holds through the countdown, clears on the first racing step and is set only by respawns', () => {
    const sess = createSession(track);
    expect(sess.state().teleported).toBe(true);
    const flags: boolean[] = [];
    let goStep = -1;
    const steps = Math.round((TUNING.race.countdown + 3) / DT);
    for (let i = 0; i < steps; i++) {
      const ev = sess.step(autopilot(sess), { respawn: i === steps - 10 }, DT);
      if (ev.some((e) => e.type === 'countdown' && e.value === 0)) goStep = i;
      flags.push(sess.state().teleported);
    }
    // A loop that runs its fixed steps before rendering still sees the start snap on any countdown frame.
    expect(goStep).toBeGreaterThan(0);
    expect(flags.slice(0, goStep + 1).every(Boolean)).toBe(true);
    expect(flags.slice(goStep + 1).flatMap((f, i) => (f ? [goStep + 1 + i] : []))).toEqual([steps - 10]);
  });

  it('respawn interpolates from the marker pose and clears an active wrong-way in the same step', () => {
    const sess = createSession(makeCircleTrack());
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    // Turn around and drive against the track until wrong-way is raised (reversing never raises it).
    const ev = runFor(sess, TUNING.progress.wrongWayTime + 5, wrongWayDriver);
    expect(ev).toContainEqual({ type: 'wrongWay', active: true });
    expect(sess.state().progress.wrongWay).toBe(true);

    const out = sess.step(NEUTRAL_INPUT, { respawn: true }, DT);
    expect(out[0]).toEqual({ type: 'respawn' });
    expect(out).toContainEqual({ type: 'wrongWay', active: false });
    const st = sess.state();
    // Frontier is still below the first spacing, so the respawn marker is the first one.
    const marker = sess.track.poseAt(sess.track.respawnMarkers[0], 0);
    expect(st.prevCar.speed).toBe(0);
    expect(Math.hypot(st.prevCar.x - marker.x, st.prevCar.z - marker.z)).toBeLessThan(1e-6);
    expect(st.progress.wrongWay).toBe(false);
  });

  it('reversing along the track never shows wrong-way', () => {
    const sess = createSession(makeCircleTrack());
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    const ev = runFor(sess, TUNING.car.reverseDelay + TUNING.progress.wrongWayTime + 2, () => ({ ...NEUTRAL_INPUT, brake: 1 }));
    const st = sess.state();
    expect(st.progress.progressSpeed).toBeLessThan(TUNING.progress.wrongWaySpeed);
    expect(st.progress.p).toBeLessThan(TUNING.progress.spawnOffset - 5);
    expect(ev.filter((e) => e.type === 'wrongWay')).toEqual([]);
    expect(st.progress.wrongWay).toBe(false);
  });

  it('auto-respawns once when the car leaves the track beyond barrier + margin', () => {
    // The circle test track has no walls, so driving straight runs off the outside of the curve.
    const sess = createSession(makeCircleTrack());
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    const limit = sess.track.barrier + TUNING.progress.outOfBoundsMargin;
    let respawnAt = -1;
    let lastLateral = 0;
    for (let i = 0; i < 20 / DT && respawnAt < 0; i++) {
      lastLateral = sess.state().progress.lateral;
      if (sess.step(FULL_THROTTLE, { respawn: false }, DT).some((e) => e.type === 'respawn')) respawnAt = i;
    }
    expect(respawnAt).toBeGreaterThan(0);
    expect(Math.abs(lastLateral)).toBeGreaterThan(limit);
    expect(sess.state().teleported).toBe(true);
    expect(Math.abs(sess.state().progress.lateral)).toBeLessThan(0.5);
    expect(sess.state().car.speed).toBeLessThan(0.5);
    // Back on the centreline: no respawn loop.
    expect(runFor(sess, 1, () => NEUTRAL_INPUT).filter((e) => e.type === 'respawn')).toHaveLength(0);
  });
});

describe('session: laps and result', () => {
  // The finish bank, burns and prop penalties are covered deterministically in session.drift.test.ts.
  it('reports consistent result maths and freezes after the finish', () => {
    const sess = createSession(track, { laps: 1 });
    const events = race(sess);
    const st = sess.state();
    expect(st.phase).toBe('finished');
    const r = st.result!;
    expect(events.filter((e) => e.type === 'finish')).toEqual([{ type: 'finish', result: r }]);
    expect(events.at(-1)?.type).toBe('finish');
    expect(r.lapTimes).toHaveLength(1);
    expect(r.totalTime).toBe(st.time);
    expect(r.lapTimes.reduce((a, b) => a + b, 0)).toBeCloseTo(r.totalTime, 6);
    expect(r.bestLap).toBe(Math.min(...r.lapTimes));
    expect(r.totalPoints).toBe(st.score.totalPoints);
    expect(r.bestChain).toBe(st.score.bestChain);
    expect(r.coinsPicked).toBe(st.pickups.coinsPicked);
    expect(r.coinsFromDrift).toBe(Math.floor(r.totalPoints / TUNING.score.pointsPerCoin));
    expect(r.coinsEarned).toBe(r.coinsPicked + r.coinsFromDrift);
    expect(r.totalPoints).toBeGreaterThan(0);
    // The result owns its lap times: sorting them cannot reach into the frozen progress state.
    expect(r.lapTimes).not.toBe(st.progress.lapTimes);
    expect(r.lapTimes).toEqual(st.progress.lapTimes);

    expect(sess.step(FULL_THROTTLE, { respawn: true }, DT)).toEqual([]);
    expect(sess.state()).toBe(st);
  });

  it('sanitises the lap count: floors it, keeps at least 1, defaults when not finite', () => {
    const laps = (n: number) => createSession(track, { laps: n }).state().laps;
    expect(laps(2.7)).toBe(2);
    expect(laps(0)).toBe(1);
    expect(laps(-3)).toBe(1);
    expect(laps(Number.NaN)).toBe(TUNING.race.laps);
    expect(laps(Infinity)).toBe(TUNING.race.laps);
    expect(createSession(track).state().laps).toBe(TUNING.race.laps);
  });

  it('flags a lap as best only when it beats earlier laps and the seeded record', () => {
    const lapEvents = (bestLap: number | null) => {
      const sess = createSession(track, { laps: 2, bestLap });
      const laps = race(sess).filter((e) => e.type === 'lap');
      return { laps, st: sess.state() };
    };
    const unbeatable = lapEvents(1);
    expect(unbeatable.laps.map((e) => e.type === 'lap' && e.best)).toEqual([false, false]);
    expect(unbeatable.st.bestLap).toBe(1);
    expect(unbeatable.st.result!.bestLap).toBe(Math.min(...unbeatable.st.result!.lapTimes));

    for (const bad of [Number.NaN, Infinity, 0, -5]) expect(createSession(track, { bestLap: bad }).state().bestLap).toBeNull();

    const fresh = lapEvents(null);
    const times = fresh.st.result!.lapTimes;
    expect(fresh.laps.map((e) => e.type === 'lap' && e.best)).toEqual([false, times[1] < times[0]]);
    expect(fresh.st.bestLap).toBe(Math.min(...times));
    // Lap pickups reset: coins taken this lap were cleared at the line.
    expect(fresh.st.pickups.coinsPicked).toBeGreaterThan(fresh.st.pickups.coinsTaken.size);
  });

  it('plaza keeps coins, light props and bombs out of reach of the car on the lap step', () => {
    // Pickups run before the lap reset within a step, so an item still touching the car when the lap
    // completes would be collected (or penalised) again on the next step. On the lap step the car
    // centre is within one step's progress cap of the start line (the cross-section at startS).
    const a = track.poseAt(track.startS, -track.barrier);
    const b = track.poseAt(track.startS, track.barrier);
    const [abx, abz] = [b.x - a.x, b.z - a.z];
    const toLine = (x: number, z: number) => {
      const u = clamp(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz), 0, 1);
      return Math.hypot(x - a.x - u * abx, z - a.z - u * abz);
    };
    const P = TUNING.progress;
    const reach = TUNING.car.capsuleHalf + TUNING.car.radius + TUNING.car.maxSpeed * DT * P.dsSpeedFactor + P.dsSlack;
    const gaps = [
      ...track.coins.map((c) => toLine(c.x, c.z) - TUNING.pickups.coinRadius),
      ...track.lightProps.map((p) => toLine(p.x, p.z) - p.r),
      ...track.bombs.map((b) => toLine(b.x, b.z) - b.r),
    ];
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.min(...gaps)).toBeGreaterThan(reach);
  });
});
