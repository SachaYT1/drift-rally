/** Assisted arcade drift car model. Pure: no three.js imports. See design spec §2.3. */
import type { CarState, InputFrame, SurfaceKind } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { approach, clamp, damp, lerp, wrapAngle } from '../shared/math';

interface SurfaceParams {
  grip: number;
  dragExtra: number;
  maxSpeed: number;
}

/** Per-step quantities shared by the mode machine and the integrators. */
interface StepContext {
  /** Incoming heading, rad. */
  h: number;
  /** Incoming |v|, forward speed, velocity heading and slip (recomputed from raw fields). */
  speed: number;
  vf: number;
  phi: number;
  slip: number;
  /** Clamped raw steer input (drift kick / flick) and the smoothed steer (integration). */
  steerInput: number;
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  handbrakePressed: boolean;
  surf: SurfaceParams;
  dt: number;
  t: Tuning;
}

type ModeFields = Pick<CarState, 'mode' | 'driftDir' | 'driftTime' | 'gripBlend' | 'modeTimer'>;

/** Physics-private memory on stepCar results, outside the shared CarState contract (absent = nothing remembered). */
interface CarMemory {
  /** Seconds a recent Space press stays armed for a flick (drift.flickWindow), counting down. */
  flickArm?: number;
}

/** Mode-machine result: the mode fields plus the updated flick arm. */
type ModeStep = ModeFields & { flickArm: number };

/** Velocity and yaw rate produced by one integration step. */
interface Motion {
  vx: number;
  vz: number;
  yawRate: number;
}

type Derived = Pick<CarState, 'speed' | 'forwardSpeed' | 'lateralSpeed' | 'slip'>;

/** m/s; below this the velocity direction is noise, so slip is 0 whatever car.slipMinSpeed says. */
const SLIP_SPEED_EPSILON = 1e-6;
/** m/s; a smaller |forward speed| is rounding noise (e.g. sliding exactly sideways) and counts as 0. */
const FORWARD_SPEED_EPSILON = 1e-6;

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
  // Seconds in the CURRENT drift, always 0 outside drift mode. exitDrift and the heavy-hit response in
  // collision.ts already clear it; zeroing here also normalises states built outside the simulation.
  let driftTime = 0;
  if (m.mode === 'drift') {
    motion = integrateDrift(ctx, m.driftDir);
    driftTime = m.driftTime + dt;
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
  const next: CarState & Required<CarMemory> = {
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
    ...derived,
    rpm: clamp(rpm, 0, 1),
    flickArm: m.flickArm,
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

/** Steps 1-2 plus the incoming kinematics. Derived fields of `s` are ignored (they may be stale). */
function makeContext(s: CarState, input: InputFrame, surface: SurfaceKind, dt: number, t: Tuning): StepContext {
  const h = s.heading;
  const steerInput = clamp(input.steer, -1, 1);

  // 1. Steer smoothing: rise toward a larger same-side target, return otherwise.
  const rising =
    Math.abs(steerInput) > Math.abs(s.steer) && (s.steer === 0 || Math.sign(steerInput) === Math.sign(s.steer));
  const steer = approach(s.steer, steerInput, (rising ? t.car.steerRiseRate : t.car.steerReturnRate) * dt);

  const d = derive(h, s.vx, s.vz, t);
  return {
    h,
    speed: d.speed,
    vf: d.forwardSpeed,
    phi: Math.atan2(s.vx, s.vz),
    slip: d.slip,
    steerInput,
    steer,
    throttle: clamp(input.throttle, 0, 1),
    brake: clamp(input.brake, 0, 1),
    handbrake: input.handbrake,
    handbrakePressed: input.handbrakePressed,
    surf: surfaceParams(surface, t),
    dt,
    t,
  };
}

/** 2. Surface parameters: road and curb drive identically. */
function surfaceParams(kind: SurfaceKind, t: Tuning): SurfaceParams {
  if (kind === 'road' || kind === 'curb') return { grip: 1, dragExtra: 0, maxSpeed: t.car.maxSpeed };
  return t.surface[kind];
}

/** 3. Mode state machine. */
function nextMode(s: CarState & CarMemory, c: StepContext): ModeStep {
  const d = c.t.drift;
  // A Space press arms a flick for flickWindow seconds; the kick or flick it triggers consumes it.
  const armLeft = Math.max(0, (s.flickArm ?? 0) - c.dt);
  const cur: ModeStep = {
    mode: s.mode,
    driftDir: s.driftDir,
    driftTime: s.driftTime,
    gripBlend: s.gripBlend,
    modeTimer: s.modeTimer,
    flickArm: c.handbrakePressed ? d.flickWindow : armLeft,
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
    return { ...cur, mode: 'drift', driftDir: c.steerInput > 0 ? 1 : -1, driftTime: 0, modeTimer: 0, flickArm: 0 };
  }

  // Drift.
  if (c.speed < d.minSpeed * d.holdSpeedFactor || c.vf <= 0) return exitDrift(cur);
  // Exit timer: S held ends the drift after brakeExitTime; throttle and Space both released after exitDelay.
  let modeTimer = 0;
  if (braking || (c.throttle < d.throttleMin && !c.handbrake)) {
    modeTimer = s.modeTimer + c.dt;
    if (modeTimer >= (braking ? d.brakeExitTime : d.exitDelay)) return exitDrift(cur);
  }
  return isFlick(s, c, armLeft > 0)
    ? { ...cur, driftDir: s.driftDir === 1 ? -1 : 1, modeTimer, flickArm: 0 }
    : { ...cur, modeTimer };
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

/** Entering grip from drift: lateral grip blends back in from gripDrift. */
function exitDrift(cur: ModeStep): ModeStep {
  return { ...cur, mode: 'grip', driftDir: 0, driftTime: 0, gripBlend: 0, modeTimer: 0 };
}

/** 4. Grip / recover integration, in the body frame of the incoming heading. */
function integrateGrip(
  s: CarState,
  m: ModeFields,
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

/** Throttle, brake / reverse and drag along the body axis (grip / recover modes). */
function integrateLongitudinal(
  vf0: number,
  reverseHold0: number,
  c: StepContext,
): { vf: number; reverseHold: number } {
  const car = c.t.car;
  const dt = c.dt;
  let vf = Math.abs(vf0) < FORWARD_SPEED_EPSILON ? 0 : vf0;

  // Throttle while rolling backwards brakes toward 0; the rest of the step after stopping drives forward.
  let driveTime = dt;
  if (vf < 0 && c.throttle > 0) {
    const stopTime = -vf / (car.brakeDecel * c.throttle);
    driveTime = Math.max(0, dt - stopTime);
    vf = stopTime < dt ? 0 : vf + car.brakeDecel * c.throttle * dt;
  }
  if (vf >= 0) {
    const ratio = vf / c.surf.maxSpeed;
    vf += car.engineAccel * c.throttle * (1 - ratio * ratio) * driveTime;
  }

  // reverseHold counts only while the brake is held near standstill.
  let reverseHold = 0;
  if (c.brake > 0) {
    if (vf > car.standstillSpeed) {
      vf = Math.max(0, vf - car.brakeDecel * c.brake * dt);
    } else {
      reverseHold = reverseHold0 + dt;
      if (reverseHold >= car.reverseDelay && vf > -car.maxReverseSpeed) {
        vf = Math.max(-car.maxReverseSpeed, vf - car.reverseAccel * c.brake * dt);
      }
    }
  }

  const drag = (car.rollingResistance + c.surf.dragExtra + car.airDrag * vf * vf) * dt;
  vf = vf > 0 ? Math.max(0, vf - drag) : Math.min(0, vf + drag);
  return { vf, reverseHold };
}

/** 5. Drift integration: the path curves, the body tracks velocity heading + target slip. */
function integrateDrift(c: StepContext, driftDir: -1 | 0 | 1): Motion {
  const d = c.t.drift;
  const u = c.steer * driftDir;
  const baseCurv = u >= 0 ? lerp(d.curvNeutral, d.curvInto, u) : lerp(d.curvNeutral, d.curvCounter, -u);
  const curvature = baseCurv * (c.handbrake ? d.handbrakeCurvBoost : 1);
  const baseSlip = u >= 0 ? lerp(d.slipMid, d.slipWide, u) : lerp(d.slipMid, d.slipNarrow, -u);
  const targetSlip = Math.min(baseSlip + (c.handbrake ? d.handbrakeExtraSlip : 0), d.slipMax);

  // Path: rotate the velocity direction by pathRate * dt, keeping |v|.
  const pathRate = driftDir * c.speed * curvature;
  const phiNew = c.phi + pathRate * c.dt;

  const accel =
    -(d.dragBase + d.dragSlip * Math.abs(Math.sin(c.slip))) -
    c.surf.dragExtra -
    (c.handbrake ? d.handbrakeDecel : 0) -
    d.brakeFactor * c.t.car.brakeDecel * c.brake +
    d.thrust * c.throttle;
  const speed = Math.max(0, capDriftSpeed(c.speed, c.speed + accel * c.dt, d.maxSpeedFactor * c.surf.maxSpeed, c));

  // Body: rate-limited tracking of (velocity heading + target slip), on top of the path rotation.
  const hTarget = phiNew + driftDir * targetSlip;
  const bodyRate = clamp(wrapAngle(hTarget - c.h) * d.bodyResponse, -d.bodyMaxYawRate, d.bodyMaxYawRate);

  return { vx: speed * Math.sin(phiNew), vz: speed * Math.cos(phiNew), yawRate: pathRate + bodyRate };
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
 * Kinematic fields derived from heading and velocity; the single source for every module (stepCar's
 * context, its result, withDerived, the defensive fallback). Slip is 0 below car.slipMinSpeed, and
 * always below SLIP_SPEED_EPSILON: a live-edited threshold of 0 must not turn atan2(0, 0) into a
 * slip equal to the heading for a car at rest.
 */
function derive(heading: number, vx: number, vz: number, t: Tuning): Derived {
  const speed = Math.hypot(vx, vz);
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  return {
    speed,
    forwardSpeed: vx * fx + vz * fz,
    lateralSpeed: vx * fz - vz * fx,
    slip: speed < Math.max(t.car.slipMinSpeed, SLIP_SPEED_EPSILON) ? 0 : wrapAngle(heading - Math.atan2(vx, vz)),
  };
}

function isFiniteState(s: CarState): boolean {
  return Object.values(s).every((v) => typeof v !== 'number' || Number.isFinite(v));
}

/** The previous state with zero velocity (defensive fallback for non-finite results). */
function stopped(prev: CarState, t: Tuning): CarState {
  return { ...prev, vx: 0, vz: 0, yawRate: 0, ...derive(prev.heading, 0, 0, t) };
}
