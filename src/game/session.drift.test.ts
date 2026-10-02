/**
 * Session -> drift score wiring (spec §2.4): the finish banks the open chain, a respawn or a heavy hit
 * burns it, a knocked light prop costs banked points. Deterministic scripted drifts on the walless
 * circle test track, so each scenario is reproducible without the plaza autopilot.
 */
import { describe, expect, it } from 'vitest';
import { createSession, type Session, type SessionState } from './session';
import { makeCircleTrack } from './testTracks';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type Collider, type GameEvent, type InputFrame, type LightPropSpot } from '../shared/types';

const DT = 1 / TUNING.race.physicsHz;
const RADIUS = 90;
/** Kick a drift above this speed, m/s. */
const KICK_SPEED = 16;

/** Full throttle; kick a drift once fast enough, then hold it with full counter-lock (a wide, steady drift). */
function driftInput(sess: Session): InputFrame {
  const c = sess.state().car;
  if (c.mode === 'drift') return { ...NEUTRAL_INPUT, throttle: 1, steer: -1 };
  if (c.speed > KICK_SPEED) return { ...NEUTRAL_INPUT, throttle: 1, steer: 1, handbrake: true, handbrakePressed: true };
  return { ...NEUTRAL_INPUT, throttle: 1 };
}

interface Step {
  prev: SessionState;
  st: SessionState;
  events: GameEvent[];
}

/** One-lap race on the circle track (optionally with obstacles), past the countdown. */
function driftSession(extras: { walls?: Collider[]; lightProps?: LightPropSpot[] } = {}): Session {
  const sess = createSession(makeCircleTrack(RADIUS, extras), { laps: 1 });
  while (sess.state().phase === 'countdown') sess.step(NEUTRAL_INPUT, { respawn: false }, DT);
  return sess;
}

/** Drives `driftInput` until `until(step)` holds or the race ends; returns that step or null. */
function driveUntil(sess: Session, until: (s: Step) => boolean, maxSeconds = 60): Step | null {
  for (let i = 0; i < maxSeconds / DT && sess.state().phase !== 'finished'; i++) {
    const prev = sess.state();
    const events = sess.step(driftInput(sess), { respawn: false }, DT);
    const step = { prev, st: sess.state(), events };
    if (until(step)) return step;
  }
  return null;
}

/** Car position in the obstacle-free reference drift at race time `time` (where the chain must be active). */
function refPoint(time: number): { x: number; z: number; points: number } {
  const step = driveUntil(driftSession(), (s) => s.st.time >= time)!;
  expect(step.st.score.phase).toBe('active');
  return { x: step.st.car.x, z: step.st.car.z, points: step.st.score.totalPoints };
}

const types = (events: GameEvent[]) => events.map((e) => e.type);

describe('session: drift score wiring', () => {
  it('the finish banks the open chain before the finish event', () => {
    const sess = driftSession();
    const fin = driveUntil(sess, (s) => s.events.some((e) => e.type === 'finish'))!;
    expect(fin).not.toBeNull();
    // The scripted drift crosses the line mid-chain: nothing else would bank it.
    expect(fin.prev.score.phase).toBe('active');
    expect(types(fin.events)).toEqual(['lap', 'chainBanked', 'finish']);
    const banked = fin.events[1] as { type: 'chainBanked'; points: number };
    // The finish step still accrues before it banks, so the bank is at least the chain going in.
    expect(banked.points).toBeGreaterThan(0);
    expect(banked.points).toBeGreaterThanOrEqual(Math.round(fin.prev.score.chainPoints));
    const r = fin.st.result!;
    expect(r.totalPoints).toBe(fin.prev.score.totalPoints + banked.points);
    expect(r.bestChain).toBeGreaterThanOrEqual(banked.points);
    expect(fin.st.score.phase).toBe('idle');
  });

  it('a respawn in the middle of a drift burns the chain and keeps the banked total', () => {
    const sess = driftSession();
    const mid = driveUntil(sess, (s) => s.st.score.phase === 'active' && s.st.score.chainPoints > 50)!;
    expect(mid).not.toBeNull();
    const before = sess.state();
    const ev = sess.step(driftInput(sess), { respawn: true }, DT);
    expect(ev[0]).toEqual({ type: 'respawn' });
    expect(ev).toContainEqual({ type: 'chainBurned', points: Math.round(before.score.chainPoints) });
    expect(types(ev)).not.toContain('chainBanked');
    const st = sess.state();
    expect(st.score.phase).toBe('idle');
    expect(st.score.chainPoints).toBe(0);
    expect(st.score.totalPoints).toBe(before.score.totalPoints);
  });

  it('a heavy hit in the middle of a drift emits hit, then burns the chain', () => {
    const at = refPoint(3.5);
    const sess = driftSession({ walls: [{ kind: 'circle', id: 'post', x: at.x, z: at.z, r: 1 }] });
    const crash = driveUntil(sess, (s) => s.events.some((e) => e.type === 'hit'))!;
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
    // Second chain of the reference drift: the first one is already banked, so the total can drop.
    const at = refPoint(12.5);
    expect(at.points).toBeGreaterThan(TUNING.score.propPenalty);
    const can: LightPropSpot = { id: 'can-1', kind: 'can', x: at.x, z: at.z, r: TUNING.pickups.canRadius, heading: 0 };
    const sess = driftSession({ lightProps: [can] });
    const knock = driveUntil(sess, (s) => s.events.some((e) => e.type === 'propKnocked'))!;
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
