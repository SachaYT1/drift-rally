/**
 * Per-step context and shared kinematics of the car model (physics/car.ts, physics/driftModes.ts).
 * Internal to physics/: the public API lives in car.ts.
 */
import type { CarState, InputFrame, SurfaceKind } from '../shared/types';
import type { Tuning } from '../shared/tuning';
import { approach, clamp, wrapAngle } from '../shared/math';

export interface SurfaceParams {
  grip: number;
  dragExtra: number;
  maxSpeed: number;
}

/** Per-step quantities shared by the mode machine and the integrators. */
export interface StepContext {
  /** Incoming heading, rad. */
  h: number;
  /** Incoming |v|, forward speed, velocity heading and slip (recomputed from raw fields). */
  speed: number;
  vf: number;
  phi: number;
  slip: number;
  /** Clamped raw steer input (drift kick / flick / catch) and the smoothed steer (integration). */
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

/** Velocity and yaw rate produced by one integration step. */
export interface Motion {
  vx: number;
  vz: number;
  yawRate: number;
}

export type Derived = Pick<CarState, 'speed' | 'forwardSpeed' | 'lateralSpeed' | 'slip'>;

/** m/s; below this the velocity direction is noise, so slip is 0 whatever car.slipMinSpeed says. */
const SLIP_SPEED_EPSILON = 1e-6;
/** m/s; a smaller |forward speed| is rounding noise (e.g. sliding exactly sideways) and counts as 0. */
const FORWARD_SPEED_EPSILON = 1e-6;

/** Steps 1-2 plus the incoming kinematics. Derived fields of `s` are ignored (they may be stale). */
export function makeContext(s: CarState, input: InputFrame, surface: SurfaceKind, dt: number, t: Tuning): StepContext {
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

/**
 * Throttle, brake / reverse and drag along one axis (grip mode: the body axis; drift-exit phase: the
 * direction of travel).
 */
export function integrateLongitudinal(
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

/**
 * Kinematic fields derived from heading and velocity; the single source for every module (stepCar's
 * context, its result, withDerived, the defensive fallback). Slip is 0 below car.slipMinSpeed, and
 * always below SLIP_SPEED_EPSILON: a live-edited threshold of 0 must not turn atan2(0, 0) into a
 * slip equal to the heading for a car at rest.
 */
export function derive(heading: number, vx: number, vz: number, t: Tuning): Derived {
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
