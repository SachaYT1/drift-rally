/** Assisted arcade drift car model. Pure: no three.js imports. See design spec §2.3. */
import type { CarState, InputFrame, SurfaceKind } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { DEG, approach, clamp, damp, lerp, wrapAngle } from '../shared/math';

// Fixed constants of the Task 1 algorithm that are not exposed in TUNING.
/** Below this speed the slip angle is reported as 0, m/s. */
const SLIP_MIN_SPEED = 1;
/** A drift ends when speed drops below drift.minSpeed times this factor. */
const DRIFT_HOLD_SPEED_FACTOR = 0.75;
/** Throttle below this counts as released for the drift exit timer. */
const DRIFT_THROTTLE_MIN = 0.1;
/** Extra target slip while the handbrake is held in a drift, rad. */
const HANDBRAKE_EXTRA_SLIP = 5 * DEG;
/** Recovery eases the body toward the velocity heading only above this speed, m/s. */
const RECOVER_MIN_SPEED = 3;
/** Recovery yaw-rate target per radian of heading error, 1/s. */
const RECOVER_YAW_GAIN = 4;
/** rpm = |vf| / maxSpeed * RPM_SPEED_SHARE + throttle * (1 - RPM_SPEED_SHARE). */
const RPM_SPEED_SHARE = 0.85;

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

/** Velocity and yaw rate produced by one integration step. */
interface Motion {
  vx: number;
  vz: number;
  yawRate: number;
}

type Derived = Pick<CarState, 'speed' | 'forwardSpeed' | 'lateralSpeed' | 'slip'>;

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
    ...derive(heading, 0, 0),
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
  // Seconds in the CURRENT drift: 0 in grip / recover (collision.ts enters recover without resetting it).
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
  const derived = derive(heading, motion.vx, motion.vz);
  const rpm = (Math.abs(derived.forwardSpeed) / t.car.maxSpeed) * RPM_SPEED_SHARE + ctx.throttle * (1 - RPM_SPEED_SHARE);
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
    ...derived,
    rpm: clamp(rpm, 0, 1),
  };

  // 7. Defensive: never let a non-finite value escape the simulation.
  return isFiniteState(next) ? next : stopped(state);
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

  const speed = Math.hypot(s.vx, s.vz);
  const phi = Math.atan2(s.vx, s.vz);
  return {
    h,
    speed,
    vf: s.vx * Math.sin(h) + s.vz * Math.cos(h),
    phi,
    slip: speed < SLIP_MIN_SPEED ? 0 : wrapAngle(h - phi),
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
function nextMode(s: CarState, c: StepContext): ModeFields {
  const cur: ModeFields = {
    mode: s.mode,
    driftDir: s.driftDir,
    driftTime: s.driftTime,
    gripBlend: s.gripBlend,
    modeTimer: s.modeTimer,
  };
  const d = c.t.drift;

  if (s.mode === 'recover') {
    const modeTimer = s.modeTimer - c.dt;
    return modeTimer <= 0 ? { ...cur, mode: 'grip', modeTimer: 0 } : { ...cur, modeTimer };
  }

  if (s.mode === 'grip') {
    // A Space press kicks; holding Space (not drifting) kicks as soon as the other conditions hold.
    // Zero steer never kicks, so a live-edited kickSteerThreshold of 0 cannot pick a side.
    const kick =
      (c.handbrakePressed || c.handbrake) &&
      c.speed >= d.minSpeed &&
      c.vf > 0 &&
      c.steerInput !== 0 &&
      Math.abs(c.steerInput) >= d.kickSteerThreshold;
    if (!kick) return cur;
    return { ...cur, mode: 'drift', driftDir: c.steerInput > 0 ? 1 : -1, driftTime: 0, modeTimer: 0 };
  }

  // Drift.
  if (c.speed < d.minSpeed * DRIFT_HOLD_SPEED_FACTOR || c.vf <= 0) return exitDrift(cur);
  let modeTimer = 0;
  if (c.throttle < DRIFT_THROTTLE_MIN && !c.handbrake) {
    modeTimer = s.modeTimer + c.dt;
    if (modeTimer >= d.exitDelay) return exitDrift(cur);
  }
  const flick = s.driftDir !== 0 && c.handbrakePressed && c.steerInput * s.driftDir <= -d.flickSteer;
  const driftDir = flick ? (s.driftDir === 1 ? -1 : 1) : s.driftDir;
  return { ...cur, driftDir, modeTimer };
}

/** Entering grip from drift: lateral grip blends back in from gripDrift. */
function exitDrift(cur: ModeFields): ModeFields {
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
  if (m.mode === 'recover' && c.speed > RECOVER_MIN_SPEED && c.vf > 0) {
    // Additionally ease the body toward the velocity heading, only while moving forward: after a
    // head-on bounce the velocity points backwards (error ~ +-pi) and easing would spin the car.
    const recoverYaw = wrapAngle(c.phi - c.h) * RECOVER_YAW_GAIN;
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
  let vf = vf0;

  if (vf >= 0) {
    const ratio = vf / c.surf.maxSpeed;
    vf += car.engineAccel * c.throttle * (1 - ratio * ratio) * dt;
  } else {
    // Throttle while rolling backwards brakes toward 0.
    vf = Math.min(0, vf + car.brakeDecel * c.throttle * dt);
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
  const targetSlip = Math.min(baseSlip + (c.handbrake ? HANDBRAKE_EXTRA_SLIP : 0), d.slipMax);

  // Path: rotate the velocity direction by pathRate * dt, keeping |v|.
  const pathRate = driftDir * c.speed * curvature;
  const phiNew = c.phi + pathRate * c.dt;

  const accel =
    -(d.dragBase + d.dragSlip * Math.abs(Math.sin(c.slip))) -
    c.surf.dragExtra -
    (c.handbrake ? d.handbrakeDecel : 0) +
    d.thrust * c.throttle;
  const speed = Math.max(0, capDriftSpeed(c.speed, c.speed + accel * c.dt, d.maxSpeedFactor * c.surf.maxSpeed, c));

  // Body: rate-limited tracking of (velocity heading + target slip), on top of the path rotation.
  const hTarget = phiNew + driftDir * targetSlip;
  const bodyRate = clamp(wrapAngle(hTarget - c.h) * d.bodyResponse, -d.bodyMaxYawRate, d.bodyMaxYawRate);

  return { vx: speed * Math.sin(phiNew), vz: speed * Math.cos(phiNew), yawRate: pathRate + bodyRate };
}

/**
 * Drift speed cap. Below the cap it is a hard limit. Above it (a fast drift running onto runoff, or a
 * kick above the cap) speed bleeds off at the brake rate instead of snapping down in one step.
 */
function capDriftSpeed(speed: number, raw: number, cap: number, c: StepContext): number {
  if (speed <= cap) return Math.min(raw, cap);
  return Math.min(raw, Math.max(cap, speed - c.t.car.brakeDecel * c.dt));
}

function derive(heading: number, vx: number, vz: number): Derived {
  const speed = Math.hypot(vx, vz);
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  return {
    speed,
    forwardSpeed: vx * fx + vz * fz,
    lateralSpeed: vx * fz - vz * fx,
    slip: speed < SLIP_MIN_SPEED ? 0 : wrapAngle(heading - Math.atan2(vx, vz)),
  };
}

function isFiniteState(s: CarState): boolean {
  return Object.values(s).every((v) => typeof v !== 'number' || Number.isFinite(v));
}

/** The previous state with zero velocity (defensive fallback for non-finite results). */
function stopped(prev: CarState): CarState {
  return { ...prev, vx: 0, vz: 0, yawRate: 0, ...derive(prev.heading, 0, 0) };
}
