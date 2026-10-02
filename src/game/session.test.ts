import { describe, expect, it } from 'vitest';
import { createSession, type Session } from './session';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { createFixedLoop } from '../core/loop';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type Collider, type GameEvent, type InputFrame } from '../shared/types';
import { clamp, loopDelta, wrapAngle } from '../shared/math';
import { makeCircleTrack } from './testTracks';

const DT = 1 / TUNING.race.physicsHz;
const track = buildTrack(PLAZA);

// ---------------------------------------------------------------------------
// Autopilot (test scaffolding). The plan's plain pure-pursuit version steered by BODY heading while
// drifting (offset by the slip angle, so it read as counter-steer and ran wide) and never released the
// throttle (drifts carried onto straights): every chain burned on a barrier. This version is drift-aware.
// ---------------------------------------------------------------------------

/** Autopilot constants (test-only driving style, not game tuning). */
const AP = {
  /** |curvature| ahead that triggers a drift kick / a flick into the opposite direction, 1/m. */
  kickCurv: 1 / 60,
  flickCurv: 1 / 60,
  /** Exit the drift when the required curvature is below this fraction of curvCounter. */
  exitFrac: 0.5,
  /** Grip-mode speed limit uses this fraction of car.maxLatAccelGrip. */
  latShare: 0.85,
  /** Pursuit look-ahead = lookBase + lookSpeed * speed, m; corner scan window = cornerSpeed * speed, m. */
  lookBase: 10,
  lookSpeed: 0.4,
  cornerSpeed: 0.8,
  /** Keep this far (m) from the road-side edge of heavy obstacles within avoidRange m along the track. */
  clearance: 6,
  avoidRange: 25,
};

/** Heavy obstacles as (s, lateral of the edge nearest the centreline), via the public Track API. */
const OBSTACLE_EDGES = track.heavyColliders.flatMap((c: Collider) => {
  if (c.kind === 'wall') return [];
  const points = c.kind === 'circle' ? [[c.x, c.z]] : [[c.ax, c.az], [c.bx, c.bz]];
  return points.map(([x, z]) => {
    const p = track.project(x, z);
    return { s: p.s, edge: p.lateral > 0 ? p.lateral - c.r : p.lateral + c.r };
  });
});

/** Racing-line lateral at s: steer clear of obstacles that intrude on the road (e.g. the sneaker). */
function lineAt(s: number): number {
  let lo = -Infinity;
  let hi = Infinity;
  for (const e of OBSTACLE_EDGES) {
    if (Math.abs(loopDelta(e.s, s, track.length)) > AP.avoidRange) continue;
    if (e.edge < 0) lo = Math.max(lo, e.edge + AP.clearance);
    else hi = Math.min(hi, e.edge - AP.clearance);
  }
  if (lo > hi) return Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : 0;
  return clamp(0, lo, hi);
}

/** Signed centreline curvature with the largest magnitude on [s0, s1]. */
function peakCurvature(s0: number, s1: number): number {
  let best = 0;
  for (let s = s0; s <= s1; s += 2) {
    const k = track.sampleAt(s).curvature;
    if (Math.abs(k) > Math.abs(best)) best = k;
  }
  return best;
}

/**
 * Drift-aware pure pursuit. Grip: steer by body heading (inverse bicycle model), brake for the grip
 * lateral limit, kick a drift into tight corners. Drift: pursue with the VELOCITY heading and map the
 * required path curvature onto the drift steer range (counter .. neutral .. into); flick when the next
 * corner turns the other way; release the throttle to exit when the drift cannot run straight enough.
 */
function autopilot(sess: Session): InputFrame {
  const D = TUNING.drift;
  const C = TUNING.car;
  const st = sess.state();
  const c = st.car;
  const s = st.progress.s;
  const v = c.speed;
  const drifting = c.mode === 'drift';
  const ref = drifting && v > 1 ? Math.atan2(c.vx, c.vz) : c.heading;
  const ts = s + AP.lookBase + v * AP.lookSpeed;
  const target = track.poseAt(ts, lineAt(ts));
  const dx = target.x - c.x;
  const dz = target.z - c.z;
  const kappa = (2 * Math.sin(wrapAngle(Math.atan2(dx, dz) - ref))) / Math.max(1, Math.hypot(dx, dz));
  const corner = peakCurvature(s + 3, s + 3 + v * AP.cornerSpeed);

  if (drifting) {
    const dir = c.driftDir;
    const u = kappa * dir;
    if (u < -D.curvCounter && corner * dir < -AP.flickCurv) {
      return { ...NEUTRAL_INPUT, throttle: 1, steer: -dir, handbrake: true, handbrakePressed: true };
    }
    const rel =
      u >= D.curvNeutral
        ? clamp((u - D.curvNeutral) / (D.curvInto - D.curvNeutral), 0, 1)
        : -clamp((D.curvNeutral - u) / (D.curvNeutral - D.curvCounter), 0, 1);
    const exit = u < D.curvCounter * AP.exitFrac && corner * dir < AP.kickCurv;
    return { ...NEUTRAL_INPUT, throttle: exit ? 0 : 1, steer: rel * dir };
  }

  if (c.mode === 'grip' && Math.abs(corner) > AP.kickCurv && v > D.minSpeed + 4 && kappa * corner > 0) {
    return { ...NEUTRAL_INPUT, throttle: 1, steer: Math.sign(corner), handbrake: true, handbrakePressed: true };
  }
  const steer = clamp((Math.atan(kappa * C.wheelBase) * (1 + v / C.steerSpeedRef)) / C.maxSteerAngle, -1, 1);
  const vmax = Math.sqrt((AP.latShare * C.maxLatAccelGrip) / Math.max(Math.abs(corner), 1e-3));
  const brake = v > vmax + 2 ? 1 : 0;
  return { ...NEUTRAL_INPUT, throttle: brake ? 0 : 1, brake, steer };
}

function runFor(sess: Session, seconds: number, input: (s: Session) => InputFrame) {
  const events: GameEvent[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) events.push(...sess.step(input(sess), { respawn: false }, DT));
  return events;
}

/** Steps until the race finishes (or maxSeconds); returns every event. */
function race(sess: Session, maxSeconds = 400) {
  const events: GameEvent[] = [];
  for (let i = 0; i < maxSeconds / DT && sess.state().phase !== 'finished'; i++) {
    events.push(...sess.step(autopilot(sess), { respawn: false }, DT));
  }
  return events;
}

const FULL_THROTTLE: InputFrame = { ...NEUTRAL_INPUT, throttle: 1 };

describe('session', () => {
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
    // Reverse along the track until wrong-way is raised.
    const ev = runFor(sess, TUNING.car.reverseDelay + TUNING.progress.wrongWayTime + 2, () => ({ ...NEUTRAL_INPUT, brake: 1 }));
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

describe('session: collisions', () => {
  /** Circle track with circle obstacles `ahead` m straight ahead of the spawn, at the given side offsets. */
  function wallAhead(ahead: number, offsets: number[], r: number) {
    const spawn = makeCircleTrack().spawnPose;
    const fx = Math.sin(spawn.heading);
    const fz = Math.cos(spawn.heading);
    const walls: Collider[] = offsets.map((o, k) => ({
      kind: 'circle',
      id: `post-${k}`,
      x: spawn.x + fx * ahead + fz * o,
      z: spawn.z + fz * ahead - fx * o,
      r,
    }));
    return createSession(makeCircleTrack(100, { walls }));
  }

  it('a heavy hit emits exactly one hit, starts grace, then respects the per-collider cooldown', () => {
    const sess = wallAhead(35, [0], 2);
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    const contacts: { t: number; e: GameEvent }[] = [];
    for (let i = 0; i < 6 / DT; i++) {
      for (const e of sess.step(FULL_THROTTLE, { respawn: false }, DT)) {
        if (e.type === 'hit' || e.type === 'scrape') contacts.push({ t: sess.state().time, e });
      }
      if (contacts.length === 1 && contacts[0].t === sess.state().time) {
        const st = sess.state();
        expect(st.hitCooldowns['post-0']).toBe(TUNING.collision.cooldown);
        expect(st.progress.graceTimer).toBeGreaterThan(TUNING.progress.graceTime - 2 * DT);
        expect(st.car.mode).toBe('recover');
      }
    }
    expect(contacts.length).toBeGreaterThan(1);
    const first = contacts[0].e;
    expect(first.type).toBe('hit');
    expect(first.type === 'hit' && first.impactSpeed).toBeGreaterThanOrEqual(TUNING.collision.heavyImpact);
    for (let k = 1; k < contacts.length; k++) {
      expect(contacts[k].t - contacts[k - 1].t).toBeGreaterThanOrEqual(TUNING.collision.cooldown - 1e-9);
    }
  });

  it('a crash into two colliders at once reports a single event and cools both down', () => {
    const sess = wallAhead(35, [-1.2, 1.2], 1);
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    for (let i = 0; i < 6 / DT; i++) {
      const ev = sess.step(FULL_THROTTLE, { respawn: false }, DT).filter((e) => e.type === 'hit' || e.type === 'scrape');
      if (ev.length === 0) continue;
      expect(ev).toHaveLength(1);
      expect(ev[0].type).toBe('hit');
      expect(Object.keys(sess.state().hitCooldowns).sort()).toEqual(['post-0', 'post-1']);
      return;
    }
    throw new Error('the car never reached the posts');
  });

  it('a heavy hit always emits a hit, even on a collider that is still cooling down', () => {
    // A long cooldown makes the second ram land inside it; scrapes stay throttled, heavy hits do not.
    const tuning = { ...TUNING, collision: { ...TUNING.collision, cooldown: 10 } };
    const spawn = makeCircleTrack().spawnPose;
    const post: Collider = {
      kind: 'circle',
      id: 'post',
      x: spawn.x + Math.sin(spawn.heading) * 35,
      z: spawn.z + Math.cos(spawn.heading) * 35,
      r: 2,
    };
    const sess = createSession(makeCircleTrack(100, { walls: [post] }), { tuning });
    runFor(sess, TUNING.race.countdown + 0.05, () => NEUTRAL_INPUT);
    // Ram the post, reverse away, ram it again.
    let firstHitAt = -1;
    const hits: { cooling: number; graceRestarted: boolean }[] = [];
    let heavySteps = 0;
    for (let i = 0; i < 12 / DT && hits.length < 2; i++) {
      const prev = sess.state();
      const backing = firstHitAt >= 0 && prev.time - firstHitAt < 2.5;
      const ev = sess.step(backing ? { ...NEUTRAL_INPUT, brake: 1 } : FULL_THROTTLE, { respawn: false }, DT);
      const st = sess.state();
      const graceRestarted = st.progress.graceTimer > prev.progress.graceTimer;
      if (graceRestarted) heavySteps++;
      if (!ev.some((e) => e.type === 'hit')) continue;
      if (firstHitAt < 0) firstHitAt = st.time;
      hits.push({ cooling: prev.hitCooldowns.post ?? 0, graceRestarted });
      expect(st.hitCooldowns.post).toBe(tuning.collision.cooldown);
    }
    expect(hits).toHaveLength(2);
    expect(hits[1].cooling).toBeGreaterThan(1);
    expect(hits.every((h) => h.graceRestarted)).toBe(true);
    // Every heavy contact (grace restart) came with its hit event.
    expect(heavySteps).toBe(2);
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
    expect(fresh.laps.map((e) => e.type === 'lap' && e.best)).toEqual([true, times[1] < times[0]]);
    expect(fresh.st.bestLap).toBe(Math.min(...times));
    // Lap pickups reset: coins taken this lap were cleared at the line.
    expect(fresh.st.pickups.coinsPicked).toBeGreaterThan(fresh.st.pickups.coinsTaken.size);
  });
});
