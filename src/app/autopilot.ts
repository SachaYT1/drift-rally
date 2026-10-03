/**
 * Drift-aware pure-pursuit autopilot (ported from the session tests). Used by the ?test hook to drive
 * whole races and by FPS measurements; not part of normal play. Pure: reads the session state and the
 * track, returns one InputFrame per fixed step.
 *
 * Grip: steer by body heading (inverse bicycle model), brake for the grip lateral limit, kick a drift into
 * tight corners. Drift: pursue with the VELOCITY heading and map the required path curvature onto the drift
 * steer range (counter .. neutral .. into); flick when the next corner turns the other way; release the
 * throttle to exit when the drift cannot run straight enough.
 */
import { NEUTRAL_INPUT, type Collider, type InputFrame } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { clamp, loopDelta, wrapAngle } from '../shared/math';
import type { Track } from '../track/build';
import type { SessionState } from '../game/session';

/** Autopilot constants (test driving style, not game tuning). */
export const AUTOPILOT = {
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
  /** Corner scan sample spacing, m. */
  scanStep: 2,
  /** Corner scan starts this far ahead of the car, m. */
  scanOffset: 3,
  /** Kick a drift only above drift.minSpeed + this, m/s. */
  kickSpeedMargin: 4,
  /** Brake when faster than the grip limit + this, m/s. */
  brakeMargin: 2,
} as const;

export type Autopilot = (st: Readonly<SessionState>) => InputFrame;

interface ObstacleEdge {
  s: number;
  /** Lateral of the obstacle edge nearest the centreline, m. */
  edge: number;
}

/** Heavy obstacles as (s, lateral of the edge nearest the centreline), via the public Track API. */
function obstacleEdges(track: Track): ObstacleEdge[] {
  return track.heavyColliders.flatMap((c: Collider) => {
    if (c.kind === 'wall') return [];
    const points = c.kind === 'circle' ? [[c.x, c.z]] : [[c.ax, c.az], [c.bx, c.bz]];
    return points.map(([x, z]) => {
      const p = track.project(x, z);
      return { s: p.s, edge: p.lateral > 0 ? p.lateral - c.r : p.lateral + c.r };
    });
  });
}

export function createAutopilot(track: Track, t: Tuning = TUNING): Autopilot {
  const AP = AUTOPILOT;
  const edges = obstacleEdges(track);

  /** Racing-line lateral at s: steer clear of obstacles that intrude on the road (e.g. the sneaker). */
  function lineAt(s: number): number {
    let lo = -Infinity;
    let hi = Infinity;
    for (const e of edges) {
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
    for (let s = s0; s <= s1; s += AP.scanStep) {
      const k = track.sampleAt(s).curvature;
      if (Math.abs(k) > Math.abs(best)) best = k;
    }
    return best;
  }

  return (st) => {
    const D = t.drift;
    const C = t.car;
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
    const corner = peakCurvature(s + AP.scanOffset, s + AP.scanOffset + v * AP.cornerSpeed);

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

    if (c.mode === 'grip' && Math.abs(corner) > AP.kickCurv && v > D.minSpeed + AP.kickSpeedMargin && kappa * corner > 0) {
      return { ...NEUTRAL_INPUT, throttle: 1, steer: Math.sign(corner), handbrake: true, handbrakePressed: true };
    }
    const steer = clamp((Math.atan(kappa * C.wheelBase) * (1 + v / C.steerSpeedRef)) / C.maxSteerAngle, -1, 1);
    const vmax = Math.sqrt((AP.latShare * C.maxLatAccelGrip) / Math.max(Math.abs(corner), 1e-3));
    const brake = v > vmax + AP.brakeMargin ? 1 : 0;
    return { ...NEUTRAL_INPUT, throttle: brake ? 0 : 1, brake, steer };
  };
}
