/**
 * Session -> drift score wiring (spec §2.4): the finish banks the open chain, a respawn or a heavy hit
 * burns it, a knocked light prop costs banked points, and a 0-point chain is still reported.
 * Every scenario runs on the walless circle test track with a closed-loop driver that holds the
 * centreline, and is located by conditions (chain state, surface), never by fixed race times, so
 * drift tuning passes do not move the scenarios off the road or out of the chain.
 */
import { describe, expect, it } from 'vitest';
import { createSession, type Session, type SessionState } from './session';
import { makeCircleTrack } from './testTracks';
import { DT } from './testSession';
import { TUNING, type Tuning } from '../shared/tuning';
import { clamp, wrapAngle } from '../shared/math';
import { NEUTRAL_INPUT, type Collider, type GameEvent, type InputFrame, type LightPropSpot } from '../shared/types';

const D = TUNING.drift;
/**
 * Test circle radius: its curvature sits midway in the drift's counter..neutral path-curvature range,
 * so the driver can both widen and tighten the line while sliding at a clear slip angle.
 */
const RADIUS = 2 / (D.curvCounter + D.curvNeutral);

/** Closed-loop line driver (test-only driving style, not game tuning). */
const LINE = {
  /** Path-curvature feedback per m of lateral offset (1/m^2) and per rad of heading error (1/m). */
  latGain: 0.004,
  headGain: 0.09,
  /** Kick a drift above this speed; hold driftSpeed while drifting, m/s. */
  kickSpeed: 2 * D.minSpeed,
  driftSpeed: 22,
  /** Grip-mode corner speed uses this share of car.maxLatAccelGrip. */
  gripShare: 0.7,
};

/** Wanted path curvature (left > 0, 1/m): the track's, plus feedback toward the centreline. */
function lineCurvature(sess: Session): number {
  const st = sess.state();
  const c = st.car;
  const tangent = sess.track.sampleAt(st.progress.s);
  const motion = c.speed > 1 ? Math.atan2(c.vx, c.vz) : c.heading;
  const headingError = wrapAngle(motion - Math.atan2(tangent.tx, tangent.tz));
  return tangent.curvature - LINE.latGain * st.progress.lateral - LINE.headGain * headingError;
}

/**
 * `drift`: kick a drift once fast enough, then map the wanted curvature onto the drift steer range
 * (counter .. neutral .. into) at a steady speed. Otherwise release the throttle (the drift exits)
 * and follow the line in grip (inverse bicycle model) at a safe corner speed.
 */
function lineInput(sess: Session, drift: boolean): InputFrame {
  const C = TUNING.car;
  const c = sess.state().car;
  const k = lineCurvature(sess);
  if (c.mode === 'drift') {
    const u = k * c.driftDir;
    const rel =
      u >= D.curvNeutral
        ? clamp((u - D.curvNeutral) / (D.curvInto - D.curvNeutral), 0, 1)
        : -clamp((D.curvNeutral - u) / (D.curvNeutral - D.curvCounter), 0, 1);
    const throttle = drift ? clamp(0.5 + (LINE.driftSpeed - c.speed) * 0.5, 0.3, 1) : 0;
    return { ...NEUTRAL_INPUT, throttle, steer: rel * c.driftDir };
  }
  if (drift && c.mode === 'grip' && c.speed > LINE.kickSpeed) {
    return { ...NEUTRAL_INPUT, throttle: 1, steer: 1, handbrake: true, handbrakePressed: true };
  }
  const steer = clamp((Math.atan(k * C.wheelBase) * (1 + Math.abs(c.forwardSpeed) / C.steerSpeedRef)) / C.maxSteerAngle, -1, 1);
  const cornerSpeed = Math.sqrt((LINE.gripShare * C.maxLatAccelGrip) * RADIUS);
  const target = drift ? Infinity : Math.min(cornerSpeed, LINE.driftSpeed);
  if (c.speed > target + 1) return { ...NEUTRAL_INPUT, brake: 1, steer };
  return { ...NEUTRAL_INPUT, throttle: c.speed < target ? 1 : 0.3, steer };
}

interface Step {
  prev: SessionState;
  st: SessionState;
  events: GameEvent[];
}

/** One-lap race on the circle track (optionally with obstacles), past the countdown. */
function driftSession(extras: { walls?: Collider[]; lightProps?: LightPropSpot[] } = {}, tuning?: Tuning): Session {
  const sess = createSession(makeCircleTrack(RADIUS, extras), { laps: 1, tuning });
  while (sess.state().phase === 'countdown') sess.step(NEUTRAL_INPUT, { respawn: false }, DT);
  return sess;
}

/** Drives `lineInput` until `until(step)` holds or the race ends; returns that step or null. */
function driveUntil(sess: Session, drift: boolean, until: (s: Step) => boolean, maxSeconds = 60): Step | null {
  for (let i = 0; i < maxSeconds / DT && sess.state().phase !== 'finished'; i++) {
    const prev = sess.state();
    const events = sess.step(lineInput(sess, drift), { respawn: false }, DT);
    const step = { prev, st: sess.state(), events };
    if (until(step)) return step;
  }
  return null;
}

/** On the road, a second of accrual into the current chain: a spot where the chain is surely open. */
const midChain = (s: Step) => s.st.score.phase === 'active' && s.st.score.chainDriftTime > 1 && s.st.surface === 'road';

/** Drift a first chain past 2 x propPenalty, let it bank in grip, then drift a second chain until `until`. */
function secondChain(sess: Session, until: (s: Step) => boolean): Step | null {
  const first = driveUntil(sess, true, (s) => s.st.score.chainPoints > 2 * TUNING.score.propPenalty);
  const banked = first && driveUntil(sess, false, (s) => s.events.some((e) => e.type === 'chainBanked'));
  return banked && driveUntil(sess, true, until);
}

const types = (events: GameEvent[]) => events.map((e) => e.type);
const has = (type: GameEvent['type']) => (s: Step) => s.events.some((e) => e.type === type);

describe('session: drift score wiring', () => {
  it('the finish banks the open chain before the finish event', () => {
    const fin = driveUntil(driftSession(), true, has('finish'))!;
    expect(fin).not.toBeNull();
    // The driver holds one chain from the kick across the line: nothing but the finish can bank it.
    expect(fin.prev.score.phase).toBe('active');
    expect(types(fin.events).filter((t) => t !== 'multiplier')).toEqual(['lap', 'chainBanked', 'finish']);
    const banked = fin.events.find((e) => e.type === 'chainBanked') as { type: 'chainBanked'; points: number };
    // The finish step still accrues before it banks, so the bank is at least the chain going in.
    expect(banked.points).toBeGreaterThan(0);
    expect(banked.points).toBeGreaterThanOrEqual(Math.round(fin.prev.score.chainPoints));
    const r = fin.st.result!;
    expect(r.totalPoints).toBe(fin.prev.score.totalPoints + banked.points);
    expect(r.bestChain).toBeGreaterThanOrEqual(banked.points);
    expect(fin.st.score.phase).toBe('idle');
  });

  it('passes a 0-point chainBanked through: consumers decide what to show', () => {
    // A vanishing base rate rounds every chain to 0 points.
    const tuning = { ...TUNING, score: { ...TUNING.score, basePerSec: 1e-6 } };
    const fin = driveUntil(driftSession({}, tuning), true, has('finish'))!;
    expect(fin).not.toBeNull();
    expect(fin.prev.score.phase).toBe('active');
    expect(fin.events).toContainEqual({ type: 'chainBanked', points: 0 });
  });

  it('a respawn in the middle of a drift burns the chain and keeps the banked total', () => {
    const sess = driftSession();
    expect(driveUntil(sess, true, midChain)).not.toBeNull();
    const before = sess.state();
    const ev = sess.step(lineInput(sess, true), { respawn: true }, DT);
    expect(ev[0]).toEqual({ type: 'respawn' });
    expect(ev).toContainEqual({ type: 'chainBurned', points: Math.round(before.score.chainPoints) });
    expect(types(ev)).not.toContain('chainBanked');
    const st = sess.state();
    expect(st.score.phase).toBe('idle');
    expect(st.score.chainPoints).toBe(0);
    expect(st.score.totalPoints).toBe(before.score.totalPoints);
  });

  it('a heavy hit in the middle of a drift emits hit, then burns the chain', () => {
    // A post on the obstacle-free drift's path, where that chain is surely open.
    const ref = driveUntil(driftSession(), true, midChain)!;
    expect(ref).not.toBeNull();
    const post: Collider = { kind: 'circle', id: 'post', x: ref.st.car.x, z: ref.st.car.z, r: 1 };
    const crash = driveUntil(driftSession({ walls: [post] }), true, has('hit'))!;
    expect(crash).not.toBeNull();
    expect(crash.prev.score.phase).toBe('active');
    const ev = crash.events;
    const hit = ev.findIndex((e) => e.type === 'hit');
    const burn = ev.findIndex((e) => e.type === 'chainBurned');
    expect(burn).toBeGreaterThan(hit);
    expect(ev[burn]).toEqual({ type: 'chainBurned', points: Math.round(crash.prev.score.chainPoints) });
    expect((ev[burn] as { points: number }).points).toBeGreaterThan(0);
    expect(crash.st.car.mode).toBe('recover');
    expect(crash.st.score.phase).toBe('idle');
    expect(crash.st.score.totalPoints).toBe(crash.prev.score.totalPoints);
  });

  it('a knocked light prop costs propPenalty from the banked total and the chain survives', () => {
    // A can on the second chain's path: the first chain is banked by then, so the total can drop.
    const ref = secondChain(driftSession(), midChain)!;
    expect(ref).not.toBeNull();
    expect(ref.st.score.totalPoints).toBeGreaterThan(TUNING.score.propPenalty);
    const { x, z } = ref.st.car;
    const can: LightPropSpot = { id: 'can-1', kind: 'can', x, z, r: TUNING.pickups.canRadius, heading: 0 };
    const knock = secondChain(driftSession({ lightProps: [can] }), has('propKnocked'))!;
    expect(knock).not.toBeNull();
    expect(knock.prev.score.phase).toBe('active');
    const ev = knock.events;
    expect(ev).toContainEqual({ type: 'penalty', points: TUNING.score.propPenalty });
    expect(types(ev).indexOf('penalty')).toBeGreaterThan(types(ev).indexOf('propKnocked'));
    expect(types(ev)).not.toContain('chainBurned');
    expect(knock.st.score.totalPoints).toBe(knock.prev.score.totalPoints - TUNING.score.propPenalty);
    expect(knock.st.score.phase).toBe('active');
    expect(knock.st.score.chainPoints).toBeGreaterThan(knock.prev.score.chainPoints);
  });
});
