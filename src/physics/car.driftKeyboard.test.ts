/**
 * Drift entry as a keyboard player drives it (player test-drives 2026-10-03): kick into the plaza's fountain
 * sweeper (r 55-200 m) exactly as the rules teach («держите руль и нажмите пробел»), then hold the drift with
 * digital keys and a human perception lag, and leave it with a lift. The car must stay on the road (inside of
 * the corner within track.roadHalfWidth) with no heavy hit, however long the into-key stays down after Space:
 * - quick: the key comes up 0.1 s after the Space tap;
 * - rules: the key comes up once the player SEES the car head inside (0.15 s perception lag);
 * - novice: the key stays down 0.75 s after the Space tap.
 * The kick used to bend the path to r ~16-20 m with the key down, so the drift hooked into the inner runoff or
 * the barrier in every style but the quickest.
 */
import { describe, expect, it } from 'vitest';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { createSession, type Session } from '../game/session';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type GameEvent, type InputFrame } from '../shared/types';
import { wrapAngle } from '../shared/math';

const track = buildTrack(PLAZA);
const DT = 1 / TUNING.race.physicsHz;
const D = TUNING.drift;
const DEG = Math.PI / 180;

/** The fountain sweeper: a left-hander; kick at s 358 (r ~124 m), lift at s 452 (r ~200 m). */
const FOUNTAIN = { side: 1 as const, kickS: 358, exitS: 452, approachV: 24 };
/** Driver timings, s (test driver, not game tuning). */
const LAG = 0.15;
const DECIDE = 0.075;
const TAP = 0.3;
const TAP_GAP = 0.1;

type Style = 'quick' | 'rules' | 'novice';
interface Keys {
  w: boolean;
  s: boolean;
  into: boolean;
  counter: boolean;
  space: boolean;
}
interface Seen {
  t: number;
  lat: number;
  /** Velocity heading minus road heading, + = into the corner. */
  headErr: number;
  /** Path curvature the driver wants, relative to the corner (+ = tighter). */
  want: number;
}
interface Outcome {
  kicked: boolean;
  /** Largest lateral toward the inside of the corner, kick to 1.5 s after the drift, m. */
  maxInside: number;
  heavyHits: number;
  burned: number;
}

function drive(style: Style): Outcome {
  const z = FOUNTAIN;
  const sess: Session = createSession(track, { laps: 1 });
  let keys: Keys = { w: false, s: false, into: false, counter: false, space: false };
  let prevSpace = false;
  const seen: Seen[] = [];
  const out: Outcome = { kicked: false, maxInside: -Infinity, heavyHits: 0, burned: 0 };
  let recording = false;

  const look = (): Seen => {
    const st = sess.state();
    const c = st.car;
    const road = track.sampleAt(st.progress.s);
    const ahead = track.sampleAt(st.progress.s + 8);
    const headErr = wrapAngle(Math.atan2(c.vx, c.vz) - Math.atan2(road.tx, road.tz)) * z.side;
    const lat = st.progress.lateral * z.side;
    return { t: st.time, lat, headErr, want: ahead.curvature * z.side - 0.01 * lat - 0.15 * headErr };
  };
  const step = (): void => {
    const steer = (keys.into ? z.side : 0) - (keys.counter ? z.side : 0);
    const input: InputFrame = {
      ...NEUTRAL_INPUT,
      throttle: keys.w ? 1 : 0,
      brake: keys.s ? 1 : 0,
      steer,
      handbrake: keys.space,
      handbrakePressed: keys.space && !prevSpace,
    };
    prevSpace = keys.space;
    const events: GameEvent[] = sess.step(input, { respawn: false }, DT);
    seen.push(look());
    if (!recording) return;
    out.maxInside = Math.max(out.maxInside, sess.state().progress.lateral * z.side);
    for (const e of events) {
      if (e.type === 'hit') out.heavyHits++;
      if (e.type === 'chainBurned') out.burned++;
    }
  };
  const wait = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) step();
  };
  /** What the player perceives now: the state LAG seconds ago. */
  const perceived = (): Seen => {
    const now = sess.state().time;
    for (let i = seen.length - 1; i >= 0; i--) if (now - seen[i].t >= LAG - 1e-9) return seen[i];
    return seen[0];
  };
  /** Grip pursuit of the centreline at ~v m/s with digital keys, until progress reaches s (or for `seconds`). */
  const grip = (v: number, until: { s?: number; seconds?: number }): void => {
    const t0 = sess.state().time;
    for (let guard = 0; guard < 20000; guard++) {
      const st = sess.state();
      if (until.s !== undefined && st.progress.s >= until.s) return;
      if (until.seconds !== undefined && st.time - t0 >= until.seconds) return;
      const c = st.car;
      const tgt = track.poseAt(st.progress.s + 10 + c.speed * 0.4, 0);
      const dx = tgt.x - c.x;
      const dz = tgt.z - c.z;
      const kappa = (2 * Math.sin(wrapAngle(Math.atan2(dx, dz) - c.heading))) / Math.max(1, Math.hypot(dx, dz));
      const wheel = (Math.atan(kappa * TUNING.car.wheelBase) * (1 + c.speed / TUNING.car.steerSpeedRef)) / TUNING.car.maxSteerAngle;
      const left = wheel * z.side;
      keys = { w: c.speed < v - 0.5, s: c.speed > v + 3, into: left > 0.15, counter: left < -0.15, space: false };
      wait(0.025);
    }
  };

  while (sess.state().phase === 'countdown') step();
  grip(28, { s: z.kickS - 60 });
  grip(z.approachV, { s: z.kickS });

  // Kick as the rules teach: hold the steer, tap Space.
  keys = { w: true, s: false, into: true, counter: false, space: false };
  wait(0.1);
  const lat0 = sess.state().progress.lateral * z.side;
  recording = true;
  keys = { ...keys, space: true };
  wait(0.15);
  keys = { ...keys, space: false };
  out.kicked = sess.state().car.mode === 'drift';
  if (!out.kicked) return out;
  const released = sess.state().time;
  if (style === 'quick') wait(0.1);
  else if (style === 'novice') wait(0.75);
  else {
    for (;;) {
      wait(0.025);
      const p = perceived();
      if (p.t >= released && (p.lat - lat0 > 1.5 || p.headErr > 6 * DEG)) break;
      if (sess.state().time - released > 1.2) break;
    }
  }

  // Hold the drift: counter-key taps for a straighter path (short of a catch), the into-key for a tighter one.
  let tapSince = -1;
  let tapOffUntil = 0;
  while (sess.state().car.mode === 'drift' && sess.state().progress.s < z.exitS) {
    const now = sess.state().time;
    const u = perceived().want;
    const wantCounter = u < 0.75 * D.curvNeutral && now >= tapOffUntil;
    const counter = wantCounter && !(tapSince >= 0 && now - tapSince >= TAP);
    if (wantCounter && !counter) tapOffUntil = now + TAP_GAP;
    if (counter && tapSince < 0) tapSince = now;
    if (!counter) tapSince = -1;
    keys = { w: true, s: false, into: u > 1.25 * D.curvNeutral, counter, space: false };
    wait(DECIDE);
  }
  // Leave it with a lift, then drive on in grip.
  keys = { w: false, s: false, into: false, counter: false, space: false };
  while (sess.state().car.mode === 'drift') step();
  grip(z.approachV, { seconds: 1.5 });
  return out;
}

describe('car physics: a keyboard kick into the fountain sweeper', () => {
  const when: Record<Style, string> = { quick: 'at once', rules: 'once the tuck-in is seen', novice: 'after 0.75 s' };
  for (const style of ['quick', 'rules', 'novice'] as const) {
    it(`stays on the road with the into-key let go ${when[style]}`, () => {
      const r = drive(style);
      expect(r.kicked).toBe(true);
      expect(r.maxInside).toBeLessThanOrEqual(TUNING.track.roadHalfWidth);
      expect(r.heavyHits).toBe(0);
      expect(r.burned).toBe(0);
    });
  }
});
