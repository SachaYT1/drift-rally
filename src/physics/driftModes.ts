/**
 * Drift side of the car model (design spec §2.3, control scheme A): the mode machine (kick, flick, catch
 * and the other exits) and the integrators for drift mode and for the drift-exit phase. Internal to
 * physics/: car.ts assembles the step.
 */
import type { CarState } from '../shared/types';
import { clamp, lerp, wrapAngle } from '../shared/math';
import { integrateLongitudinal, type Motion, type StepContext } from './carContext';

/** Mode-machine result: the mode fields plus the physics memory, always present. */
export type ModeStep = Pick<CarState, 'mode' | 'driftDir' | 'driftTime' | 'gripBlend' | 'modeTimer'> &
  Required<
    Pick<CarState, 'flickArm' | 'catchTimer' | 'exitAlign' | 'entryCurv' | 'entryAt' | 'lineOffset' | 'intoLatch'>
  >;

/** 3. Mode state machine. */
export function nextMode(s: CarState, c: StepContext): ModeStep {
  const d = c.t.drift;
  // A Space press arms a flick for flickWindow seconds; the kick or flick it triggers consumes it.
  const armLeft = Math.max(0, (s.flickArm ?? 0) - c.dt);
  const drifting = s.mode === 'drift';
  const cur: ModeStep = {
    mode: s.mode,
    driftDir: s.driftDir,
    driftTime: s.driftTime,
    gripBlend: s.gripBlend,
    modeTimer: s.modeTimer,
    flickArm: c.handbrakePressed ? d.flickWindow : armLeft,
    catchTimer: 0,
    // The exit phase runs in grip mode only; a heavy hit (recover) ends it.
    exitAlign: s.mode === 'grip' ? Math.max(0, (s.exitAlign ?? 0) - c.dt) : 0,
    entryCurv: drifting ? (s.entryCurv ?? 0) : 0,
    entryAt: drifting ? (s.entryAt ?? 0) : 0,
    lineOffset: drifting ? (s.lineOffset ?? 0) : 0,
    // The steer held through the last kick or flick follows the key down, never back up.
    intoLatch: drifting ? Math.min(s.intoLatch ?? 0, Math.max(0, c.steerInput * s.driftDir)) : 0,
  };
  const braking = c.brake > 0;

  if (s.mode === 'recover') {
    const modeTimer = s.modeTimer - c.dt;
    return modeTimer <= 0 ? { ...cur, mode: 'grip', modeTimer: 0 } : { ...cur, modeTimer };
  }

  if (s.mode === 'grip') {
    // A Space press kicks; holding Space (not drifting) kicks as soon as the other conditions hold.
    // Zero steer never kicks, so a live-edited kickSteerThreshold of 0 cannot pick a side. The brake
    // blocks the kick: S ends a drift, so Space + S would flap between drift and grip.
    const kick =
      (c.handbrakePressed || c.handbrake) &&
      !braking &&
      c.speed >= d.minSpeed &&
      c.vf > 0 &&
      c.steerInput !== 0 &&
      Math.abs(c.steerInput) >= d.kickSteerThreshold;
    if (!kick) return cur;
    const driftDir = c.steerInput > 0 ? 1 : -1;
    // Smooth entry: the drift path starts from the path the car is on (the last step's curvature), and the
    // neutral arc holds that line for a while (never one curving away from the drift: a re-kick right after
    // a catch starts it straight); the steer held through the kick only picks the side.
    const entryCurv = entryPath(s, c);
    const lineOffset = clamp(entryCurv * driftDir, 0, d.curvInto) - d.curvNeutral;
    return {
      ...cur,
      mode: 'drift',
      driftDir,
      driftTime: 0,
      modeTimer: 0,
      flickArm: 0,
      exitAlign: 0,
      entryCurv,
      entryAt: 0,
      lineOffset,
      intoLatch: c.steerInput * driftDir,
    };
  }

  // Drift.
  if (c.speed < d.minSpeed * d.holdSpeedFactor || c.vf <= 0) return exitDrift(cur, c);
  // Exit timer: S held ends the drift after brakeExitTime; throttle and Space both released after exitDelay.
  let modeTimer = 0;
  if (braking || (c.throttle < d.throttleMin && !c.handbrake)) {
    modeTimer = s.modeTimer + c.dt;
    if (modeTimer >= (braking ? d.brakeExitTime : d.exitDelay)) return exitDrift(cur, c);
  }
  if (isFlick(s, c, armLeft > 0)) {
    // A flick bends the path from the one the car is on (flickBlendTime); its steer only picks the new side.
    const driftDir = s.driftDir === 1 ? -1 : 1;
    const intoLatch = Math.max(0, c.steerInput * driftDir);
    const entryCurv = entryPath(s, c);
    return { ...cur, driftDir, modeTimer, flickArm: 0, entryCurv, entryAt: s.driftTime, lineOffset: 0, intoLatch };
  }
  // Catch: full counter-steer held with Space released ends the drift; any let-up restarts the hold. The hold
  // counts once the WHEEL (smoothed steer, which sets the path curvature) is at full counter-steer too, so a
  // keyboard counter-steer first slides on the slightly outward full-counter path for catchTime (spec §2.3)
  // instead of catching while the wheel is still swinging across, and a counter tap followed by Space is a
  // flick, not a catch and a re-kick.
  const countering =
    s.driftDir !== 0 &&
    !c.handbrake &&
    c.steerInput * s.driftDir <= -d.catchSteer &&
    c.steer * s.driftDir <= -d.catchSteer;
  const catchTimer = countering ? (s.catchTimer ?? 0) + c.dt : 0;
  if (countering && catchTimer >= d.catchTime) return exitDrift(cur, c);
  return { ...cur, modeTimer, catchTimer };
}

/**
 * Flick: strong opposite steer (steerInput * driftDir <= -flickSteer) with a Space press before or after it
 * (`armed`: pressed within flickWindow, even if released), or with Space held while the steer crosses over
 * (the smoothed wheel s.steer has not passed -flickSteer yet). A drift without a direction never flicks.
 */
function isFlick(s: CarState, c: StepContext, armed: boolean): boolean {
  const flickSteer = c.t.drift.flickSteer;
  if (s.driftDir === 0 || c.steerInput * s.driftDir > -flickSteer) return false;
  const crossing = c.handbrake && s.steer * s.driftDir > -flickSteer;
  return c.handbrakePressed || armed || crossing;
}

/**
 * The path curvature a drift entry (kick or flick) starts from: the last step's, kept within the tightest
 * drift arc (+-curvInto * handbrakeCurvBoost). Grip integration right after a wall-slide pivot can turn the
 * velocity at r ~2 m; a kick then must not start the drift there.
 */
function entryPath(s: CarState, c: StepContext): number {
  const cap = c.t.drift.curvInto * c.t.drift.handbrakeCurvBoost;
  return clamp(s.pathCurv ?? 0, -cap, cap);
}

/** Entering grip from drift: the exit phase starts and lateral grip blends back in from gripDrift. */
function exitDrift(cur: ModeStep, c: StepContext): ModeStep {
  return {
    ...cur,
    mode: 'grip',
    driftDir: 0,
    driftTime: 0,
    gripBlend: 0,
    modeTimer: 0,
    catchTimer: 0,
    exitAlign: c.t.drift.exitAlignTime,
    entryCurv: 0,
    entryAt: 0,
    lineOffset: 0,
    intoLatch: 0,
  };
}

/**
 * 5. Drift integration: the path curves, the body tracks velocity heading + target slip. The drift target
 * curvature (relative to driftDir) runs into > neutral > 0 > full counter (a slight outward curve).
 * - Into-steer: the wheel, but no more than the key (letting go stops the tightening at once instead of after
 *   the wheel's return), minus the steer held through the last kick or flick (it only picked the side).
 * - The kick holds the line: the neutral arc eases from the path the car had in grip to curvNeutral over
 *   entryHoldTime, so a kick on a wide sweeper does not tuck in before the player can react.
 * - Smooth entry: for entryBlendTime after the kick (flickBlendTime after a flick) the path curvature blends
 *   (smoothstep) from the one the car was on to that target, so the kick swings the body into the slide
 *   without yanking the path, and a flick swings it to the new side without a hook.
 */
export function integrateDrift(
  c: StepContext,
  m: Pick<ModeStep, 'driftDir' | 'driftTime' | 'entryCurv' | 'entryAt' | 'lineOffset' | 'intoLatch'>,
): Motion {
  const d = c.t.drift;
  const driftDir = m.driftDir;
  const u = c.steer * driftDir;
  const age = m.driftTime - m.entryAt + c.dt;
  const neutral = d.curvNeutral + m.lineOffset * (1 - ease(age, d.entryHoldTime));
  const into = Math.max(0, Math.min(u, c.steerInput * driftDir) - m.intoLatch);
  const baseCurv = u >= 0 ? lerp(neutral, d.curvInto, into) : lerp(neutral, d.curvCounter, -u);
  // The drift-highway balance reads the steer alone (from curvNeutral): the line hold is not counter-steer.
  const steerCurv = u >= 0 ? lerp(d.curvNeutral, d.curvInto, into) : lerp(d.curvNeutral, d.curvCounter, -u);
  const target = driftDir * baseCurv * (c.handbrake ? d.handbrakeCurvBoost : 1);
  const blend = ease(age, m.entryAt > 0 ? d.flickBlendTime : d.entryBlendTime);
  const curvature = blend < 1 ? lerp(m.entryCurv, target, blend) : target;
  const baseSlip = u >= 0 ? lerp(d.slipMid, d.slipWide, u) : lerp(d.slipMid, d.slipNarrow, -u);
  const targetSlip = Math.min(baseSlip + (c.handbrake ? d.handbrakeExtraSlip : 0), d.slipMax);

  // Path: rotate the velocity direction by pathRate * dt, keeping |v|.
  const pathRate = c.speed * curvature;
  const phiNew = c.phi + pathRate * c.dt;

  const accel =
    -(d.dragBase + d.dragSlip * Math.abs(Math.sin(c.slip))) -
    c.surf.dragExtra -
    (c.handbrake ? d.handbrakeDecel : 0) -
    d.brakeFactor * c.t.car.brakeDecel * c.brake +
    d.thrust * c.throttle * driftThrustScale(c, steerCurv);
  const speed = Math.max(0, capDriftSpeed(c.speed, c.speed + accel * c.dt, d.maxSpeedFactor * c.surf.maxSpeed, c));

  // Body: rate-limited tracking of (velocity heading + target slip), on top of the path rotation.
  const hTarget = phiNew + driftDir * targetSlip;
  const bodyRate = clamp(wrapAngle(hTarget - c.h) * d.bodyResponse, -d.bodyMaxYawRate, d.bodyMaxYawRate);

  return { vx: speed * Math.sin(phiNew), vz: speed * Math.cos(phiNew), yawRate: pathRate + bodyRate };
}

/** 0 at x <= 0, 1 at x >= 1, eased in between (zero slope at both ends). */
function smoothstep(x: number): number {
  const k = clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
}

/** Smoothstep progress `age` seconds into an ease of `span` seconds (done at once for a span of 0). */
function ease(age: number, span: number): number {
  return span > 0 ? smoothstep(age / span) : 1;
}

/**
 * Drift thrust balance (no "drift highway"): the thrust fades out toward a top speed, so a drift on W settles
 * at a steady speed; a straighter (counter-steered) path, whose narrower slip drags less, gets a lower top
 * speed so it never outruns a neutral drift. Full thrust at low speed either way.
 */
function driftThrustScale(c: StepContext, baseCurv: number): number {
  const d = c.t.drift;
  const share = d.curvNeutral > 0 ? lerp(d.topStraight, 1, clamp(baseCurv / d.curvNeutral, 0, 1)) : 1;
  const top = d.driftTopSpeed * share;
  const r = top > 0 ? c.speed / top : Infinity;
  return Math.max(0, 1 - r * r);
}

/**
 * Drift speed cap. Below the cap it is a hard limit. Above it (a fast drift running onto runoff, or a
 * kick above the cap) speed bleeds off at drift.overspeedDecel instead of snapping down in one step.
 */
function capDriftSpeed(speed: number, raw: number, cap: number, c: StepContext): number {
  if (speed <= cap) return Math.min(raw, cap);
  return Math.min(raw, Math.max(cap, speed - c.t.drift.overspeedDecel * c.dt));
}

/**
 * Drift-exit phase (grip mode while exitAlign > 0): every exit keeps the direction of travel instead of
 * snapping the velocity toward the nose (the old inward dart). Speed changes along the direction of
 * travel (the grip longitudinal model); the path turns only by steering, as in grip, with its authority
 * blending in with gripBlend; the body swings to the velocity heading as a critically damped spring
 * (exact per-step solution, so no overshoot at any dt), its yaw rate capped at exitAlignMaxYawRate.
 * Returns null where there is no direction to keep (slower than car.slipMinSpeed, or sliding backwards
 * relative to the nose): plain grip integration takes over.
 */
export function integrateExit(s: CarState, gripBlend: number, c: StepContext): (Motion & { gripBlend: number }) | null {
  const car = c.t.car;
  const d = c.t.drift;
  const error = wrapAngle(c.phi - c.h);
  if (c.speed < car.slipMinSpeed || Math.abs(error) >= Math.PI / 2) return null;

  const speed = integrateLongitudinal(c.speed, 0, c).vf;
  // Path turn from steering: the grip bicycle model, capped by the grip lateral acceleration.
  const angle = (c.steer * car.maxSteerAngle) / (1 + speed / car.steerSpeedRef);
  const curvCap = car.maxLatAccelGrip / Math.max(speed * speed, 1);
  const pathRate = speed * clamp(Math.tan(angle) / car.wheelBase, -curvCap, curvCap) * gripBlend;
  const phiNew = c.phi + pathRate * c.dt;

  // Critically damped spring on e = velocity heading - heading: e(t) = (e0 + (e0' + w e0) t) exp(-w t).
  const w = d.exitAlignResponse;
  const errorRate = pathRate - s.yawRate;
  const decay = Math.exp(-w * c.dt);
  const nextErrorRate = (errorRate - w * (errorRate + w * error) * c.dt) * decay;
  const yawRate = clamp(pathRate - nextErrorRate, -d.exitAlignMaxYawRate, d.exitAlignMaxYawRate);

  return {
    vx: speed * Math.sin(phiNew),
    vz: speed * Math.cos(phiNew),
    yawRate,
    gripBlend: Math.min(1, gripBlend + c.dt / d.gripBlendTime),
  };
}
