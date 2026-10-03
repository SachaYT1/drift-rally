/**
 * Assisted arcade drift car model: public API and step assembly. Pure: no three.js imports. See design
 * spec §2.3. The drift mode machine and the drift / drift-exit integrators live in driftModes.ts; the
 * per-step context and shared kinematics in carContext.ts.
 */
import type { CarState, InputFrame, SurfaceKind } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { clamp, damp, lerp, wrapAngle } from '../shared/math';
import { derive, integrateLongitudinal, makeContext, type Motion, type StepContext } from './carContext';
import { integrateDrift, integrateExit, nextMode, type ModeStep } from './driftModes';

export function createCarState(x: number, z: number, heading: number): CarState {
  return {
    x,
    z,
    heading,
    vx: 0,
    vz: 0,
    yawRate: 0,
    steer: 0,
    mode: 'grip',
    driftDir: 0,
    driftTime: 0,
    gripBlend: 1,
    modeTimer: 0,
    reverseHold: 0,
    wheelSpin: 0,
    flickArm: 0,
    catchTimer: 0,
    exitAlign: 0,
    pathCurv: 0,
    entryCurv: 0,
    // At rest: every derived field is 0 for any tuning, so the global TUNING is fine here.
    ...derive(heading, 0, 0, TUNING),
    rpm: 0,
  };
}

/** Advance the car by one fixed step. Returns a NEW state; never mutates `state`. */
export function stepCar(
  state: CarState,
  input: InputFrame,
  surface: SurfaceKind,
  dt: number,
  t: Tuning = TUNING,
): CarState {
  const ctx = makeContext(state, input, surface, dt, t);

  // 3. Mode transitions, evaluated before integrating.
  const m = nextMode(state, ctx);

  // 4-5. Integrate velocity and yaw rate for the (new) mode.
  let motion: Motion;
  let gripBlend = m.gripBlend;
  let reverseHold = 0;
  // Seconds in the CURRENT drift, always 0 outside drift mode. The drift exits and the heavy-hit response
  // in collision.ts already clear it; zeroing here also normalises states built outside the simulation.
  let driftTime = 0;
  const exit = m.mode === 'grip' && m.exitAlign > 0 ? integrateExit(state, m.gripBlend, ctx) : null;
  if (m.mode === 'drift') {
    motion = integrateDrift(ctx, m);
    driftTime = m.driftTime + dt;
  } else if (exit) {
    motion = exit;
    gripBlend = exit.gripBlend;
  } else {
    const grip = integrateGrip(state, m, ctx);
    motion = grip;
    gripBlend = grip.gripBlend;
    reverseHold = grip.reverseHold;
  }

  // 6. Integrate pose and visual/audio extras.
  const heading = ctx.h + motion.yawRate * dt;
  const derived = derive(heading, motion.vx, motion.vz, t);
  const share = t.car.rpmSpeedShare;
  const rpm = (Math.abs(derived.forwardSpeed) / t.car.maxSpeed) * share + ctx.throttle * (1 - share);
  const next: CarState = {
    x: state.x + motion.vx * dt,
    z: state.z + motion.vz * dt,
    heading,
    vx: motion.vx,
    vz: motion.vz,
    yawRate: motion.yawRate,
    steer: ctx.steer,
    mode: m.mode,
    driftDir: m.driftDir,
    driftTime,
    gripBlend,
    modeTimer: m.modeTimer,
    reverseHold,
    wheelSpin: state.wheelSpin + (derived.forwardSpeed / t.car.wheelRadius) * dt,
    flickArm: m.flickArm,
    catchTimer: m.catchTimer,
    exitAlign: m.exitAlign,
    pathCurv: pathCurvature(ctx, motion),
    entryCurv: m.entryCurv,
    ...derived,
    rpm: clamp(rpm, 0, 1),
  };

  // 7. Defensive: never let a non-finite value escape the simulation.
  return isFiniteState(next) ? next : stopped(state, t);
}

/**
 * `state` with speed, forwardSpeed, lateralSpeed and slip recomputed from heading and (vx, vz).
 * For code that changes the velocity outside stepCar (collision response, prop knocks).
 */
export function withDerived(state: CarState, t: Tuning = TUNING): CarState {
  return { ...state, ...derive(state.heading, state.vx, state.vz, t) };
}

/** True when the car is in drift mode, fast enough and sliding at >= score.minSlip. */
export function isDrifting(state: CarState, t: Tuning = TUNING): boolean {
  return state.mode === 'drift' && state.speed >= t.drift.minSpeed && Math.abs(state.slip) >= t.score.minSlip;
}

/** Car collision capsule in world space. */
export function carCapsule(
  state: CarState,
  t: Tuning = TUNING,
): { ax: number; az: number; bx: number; bz: number; r: number } {
  const ox = Math.sin(state.heading) * t.car.capsuleHalf;
  const oz = Math.cos(state.heading) * t.car.capsuleHalf;
  return { ax: state.x + ox, az: state.z + oz, bx: state.x - ox, bz: state.z - oz, r: t.car.radius };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** 4. Grip / recover integration, in the body frame of the incoming heading. */
function integrateGrip(
  s: CarState,
  m: ModeStep,
  c: StepContext,
): Motion & { gripBlend: number; reverseHold: number } {
  const car = c.t.car;
  const fx = Math.sin(c.h);
  const fz = Math.cos(c.h);
  // left = (cos h, -sin h) = (fz, -fx)
  const vl0 = s.vx * fz - s.vz * fx;

  const { vf, reverseHold } = integrateLongitudinal(c.vf, s.reverseHold, c);

  // Steering: bicycle-model yaw target, capped by the grip lateral acceleration.
  const angle = (c.steer * car.maxSteerAngle) / (1 + Math.abs(vf) / car.steerSpeedRef);
  const yawCap = car.maxLatAccelGrip / Math.max(Math.abs(vf), 1);
  const targetYaw = clamp((vf * Math.tan(angle)) / car.wheelBase, -yawCap, yawCap);
  const response = damp(car.yawResponse, c.dt);
  let yawRate = s.yawRate + (targetYaw - s.yawRate) * response;
  const error = wrapAngle(c.phi - c.h);
  if (m.mode === 'recover' && c.speed > c.t.drift.recoverMinSpeed && Math.abs(error) <= c.t.drift.recoverMaxAngle) {
    // Also ease the body toward the velocity heading, sideways slides included (|slip| ~ 90 deg after a drift
    // into a barrier), but not when moving backwards: after a head-on bounce (error ~ +-pi) it would spin.
    const recoverYaw = error * c.t.drift.recoverYawGain;
    yawRate += (recoverYaw - yawRate) * response;
  }

  // Lateral grip, blending from drift grip back to normal grip after a drift.
  const k = lerp(c.t.drift.gripDrift, car.gripNormal, m.gripBlend) * c.surf.grip;
  const vl = vl0 * Math.exp(-k * c.dt);
  const gripBlend = Math.min(1, m.gripBlend + c.dt / c.t.drift.gripBlendTime);

  return { vx: vf * fx + vl * fz, vz: vf * fz - vl * fx, yawRate, gripBlend, reverseHold };
}

/**
 * Signed curvature of this step's path, 1/m (+ = left): the velocity-heading change per metre travelled. 0
 * below car.slipMinSpeed, where the velocity direction is noise. A drift kick starts its path from it.
 */
function pathCurvature(c: StepContext, motion: Motion): number {
  if (c.speed < Math.max(c.t.car.slipMinSpeed, 1e-6)) return 0;
  return wrapAngle(Math.atan2(motion.vx, motion.vz) - c.phi) / (c.speed * c.dt);
}

function isFiniteState(s: CarState): boolean {
  return Object.values(s).every((v) => typeof v !== 'number' || Number.isFinite(v));
}

/** The previous state with zero velocity (defensive fallback for non-finite results). */
function stopped(prev: CarState, t: Tuning): CarState {
  return { ...prev, vx: 0, vz: 0, yawRate: 0, pathCurv: 0, ...derive(prev.heading, 0, 0, t) };
}
