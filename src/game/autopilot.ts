/**
 * Drift-aware pure-pursuit autopilot. Drives the ghost bots (src/game/bots.ts, one style per level), the ?test
 * hook, the session tests and FPS measurements. Pure: reads the session state and the track, returns one
 * InputFrame per fixed step.
 *
 * Grip: steer by body heading (inverse bicycle model), brake for the grip lateral limit (not for a drift
 * corner), kick a drift into tight corners. Drift: pursue with the VELOCITY heading and map the required
 * path curvature onto the drift steer range (counter .. neutral .. into), short of a catch while the path
 * still curves into the drift; flick when the next corner turns the other way. Once the path ahead needs
 * less than exitCurv into the drift, leave it the way a player would (design spec §2.3): S when well over
 * the grip limit ahead, lift W when just over it, otherwise catch the slide (full counter-steer on W, held
 * once the wheel is across until the catch completes, as full counter-steer bends the path slightly outward).
 *
 * A style (AutopilotStyle) sets the skill; the defaults are the reference driver. Weaker: a throttle cap,
 * drifts left after maxDriftTime and not linked into chains (linkDrifts). Stronger: keepChain stays in one
 * drift from the first kick to the finish, so the multiplier holds its top across the straights.
 */
import { NEUTRAL_INPUT, type Collider, type InputFrame } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { clamp, loopDelta, wrapAngle } from '../shared/math';
import type { Track } from '../track/build';
import type { SessionState } from './session';

/** Autopilot constants (test driving style, not game tuning). */
export const AUTOPILOT = {
  /** |curvature| ahead that triggers a drift kick / a flick into the opposite direction, 1/m. */
  kickCurv: 1 / 60,
  flickCurv: 1 / 60,
  /**
   * Leave the drift once the path ahead needs less than this curvature into the drift, 1/m. Partial
   * counter-steer can follow a mild sweeper in drift, but a drift on W runs well below the grip top speed.
   */
  exitCurv: 1 / 150,
  /**
   * Once the wheel is at full counter-steer (catching), keep catching unless the path ahead needs at least
   * this curvature into the drift (a neutral drift's), 1/m: full counter-steer bends the path slightly
   * outward, so with the plain exitCurv the pursuit would swing back into a hold every few steps and the
   * catch would never complete.
   */
  catchCommitCurv: 1 / 38,
  /**
   * Holding a drift while the path still curves into it, counter-steer stays this far short of
   * drift.catchSteer (no accidental catch); once it needs a straight path, full counter-steer catches.
   * Keeping the chain (keepChain), every hold stays this far short of a catch.
   */
  catchMargin: 0.1,
  /** Grip-mode speed limit uses this fraction of car.maxLatAccelGrip. */
  latShare: 0.9,
  /** Pursuit look-ahead = lookBase + lookSpeed * speed, m; corner scan window = cornerSpeed * speed, m. */
  lookBase: 10,
  lookSpeed: 0.4,
  cornerSpeed: 0.8,
  /** Keep this far (m) from the road-side edge of heavy obstacles within avoidRange m along the track. */
  clearance: 7,
  avoidRange: 25,
  /** Keep this far (m) from the road-side edge of a bomb within avoidRange m along the track. */
  bombClearance: 3,
  /** Corner scan sample spacing, m. */
  scanStep: 2,
  /** Corner scan starts this far ahead of the car, m. */
  scanOffset: 3,
  /** Kick a drift only above drift.minSpeed + this, m/s. */
  kickSpeedMargin: 4,
  /** Brake (grip, or out of a drift) when faster than the grip limit + this, m/s. */
  brakeMargin: 6,
  /** Highest throttle ever output (grip, kicks and drift), 0..1. Below 1 the drift settles much slower. */
  throttleCap: 1,
  /** Leave a drift (the usual S / lift / catch exit) after this many seconds in it; Infinity: never. */
  maxDriftTime: Infinity,
  /**
   * 1: kick into the next corner while the last chain is still in its grace, linking the drifts into one
   * chain. 0: kick only once it has banked, braking for the grip limit meanwhile, so every drift scores on
   * its own at a low multiplier.
   */
  linkDrifts: 1,
  /**
   * 1: keep the chain from the first kick to the finish: never leave a drift on purpose, slide down the
   * straights with counter-steer catchMargin short of a catch (a nearly straight path, drift.curvCounter),
   * flick to bend the other way. 0: leave the drift once the path ahead straightens (exitCurv).
   */
  keepChain: 0,
  /** Keeping the chain, flick once the path ahead needs more than this curvature away from the drift, 1/m. */
  keepFlickCurv: 1 / 300,
} as const;

/** A driving style: AUTOPILOT with any constant overridden (tests and tuning sweeps). */
export type AutopilotStyle = { [K in keyof typeof AUTOPILOT]: number };

export type Autopilot = (st: Readonly<SessionState>) => InputFrame;

interface ObstacleEdge {
  s: number;
  /** Lateral of the obstacle edge nearest the centreline, m. */
  edge: number;
  /** How far (m) the racing line keeps from that edge. */
  clearance: number;
}

/** Heavy obstacles and bombs as (s, lateral of the edge nearest the centreline), via the public Track API. */
function obstacleEdges(track: Track, AP: AutopilotStyle): ObstacleEdge[] {
  const edgeOf = (x: number, z: number, r: number, clearance: number): ObstacleEdge => {
    const p = track.project(x, z);
    return { s: p.s, edge: p.lateral > 0 ? p.lateral - r : p.lateral + r, clearance };
  };
  const heavy = track.heavyColliders.flatMap((c: Collider) => {
    if (c.kind === 'wall') return [];
    const points = c.kind === 'circle' ? [[c.x, c.z]] : [[c.ax, c.az], [c.bx, c.bz]];
    return points.map(([x, z]) => edgeOf(x, z, c.r, AP.clearance));
  });
  return [...heavy, ...track.bombs.map((b) => edgeOf(b.x, b.z, b.r, AP.bombClearance))];
}

export function createAutopilot(track: Track, t: Tuning = TUNING, AP: AutopilotStyle = AUTOPILOT): Autopilot {
  const edges = obstacleEdges(track, AP);

  /** Racing-line lateral at s: steer clear of obstacles that intrude on the road (e.g. the sneaker) and bombs. */
  function lineAt(s: number): number {
    let lo = -Infinity;
    let hi = Infinity;
    for (const e of edges) {
      if (Math.abs(loopDelta(e.s, s, track.length)) > AP.avoidRange) continue;
      if (e.edge < 0) lo = Math.max(lo, e.edge + e.clearance);
      else hi = Math.min(hi, e.edge - e.clearance);
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

    // Grip corner speed limit for the peak curvature ahead.
    const vmax = Math.sqrt((AP.latShare * C.maxLatAccelGrip) / Math.max(Math.abs(corner), 1e-3));

    const gas = AP.throttleCap;
    const keep = AP.keepChain > 0;
    if (drifting) {
      const dir = c.driftDir;
      const u = kappa * dir;
      // Flick when the next corner turns the other way, or (keeping the chain) when the path bends away
      // from the drift more than a hold short of a catch can follow.
      if (u < 0 && (corner * dir < -AP.flickCurv || (keep && u < -AP.keepFlickCurv))) {
        return { ...NEUTRAL_INPUT, throttle: gas, steer: -dir, handbrake: true, handbrakePressed: true };
      }
      const rel =
        u >= D.curvNeutral
          ? clamp((u - D.curvNeutral) / (D.curvInto - D.curvNeutral), 0, 1)
          : -clamp((D.curvNeutral - u) / (D.curvNeutral - D.curvCounter), 0, 1);
      const floor = AP.catchMargin - D.catchSteer;
      if (keep) return { ...NEUTRAL_INPUT, throttle: gas, steer: Math.max(rel, floor) * dir };
      const catching = c.steer * dir <= -D.catchSteer;
      const tired = c.driftTime >= AP.maxDriftTime;
      if (!tired && (u >= (catching ? AP.catchCommitCurv : AP.exitCurv) || corner * dir >= AP.kickCurv)) {
        const hold = u > 0 ? Math.max(rel, floor) : rel;
        return { ...NEUTRAL_INPUT, throttle: gas, steer: hold * dir };
      }
      // Leave the drift: S when well over the grip limit ahead, lift W when just over it, else catch the
      // slide with full counter-steer on W (keeps the speed; the exit keeps the direction of travel).
      if (v > vmax + AP.brakeMargin) return { ...NEUTRAL_INPUT, brake: 1, steer: rel * dir };
      if (v > vmax) return { ...NEUTRAL_INPUT, steer: rel * dir };
      return { ...NEUTRAL_INPUT, throttle: gas, steer: -dir };
    }

    // Not linking drifts, no kick while the last chain is in its grace: brake for that corner like a grip one.
    const kickable = Math.abs(corner) > AP.kickCurv && (AP.linkDrifts > 0 || st.score.phase !== 'grace');
    if (c.mode === 'grip' && kickable && v > D.minSpeed + AP.kickSpeedMargin && kappa * corner > 0) {
      return { ...NEUTRAL_INPUT, throttle: gas, steer: Math.sign(corner), handbrake: true, handbrakePressed: true };
    }
    const steer = clamp((Math.atan(kappa * C.wheelBase) * (1 + v / C.steerSpeedRef)) / C.maxSteerAngle, -1, 1);
    // No braking for a drift corner ahead: the drift takes it at speed.
    const brake = v > vmax + AP.brakeMargin && !kickable ? 1 : 0;
    return { ...NEUTRAL_INPUT, throttle: brake ? 0 : gas, brake, steer };
  };
}
