/**
 * Every gameplay constant lives here. Tests read thresholds from this object instead of
 * hard-coding numbers, so tuning passes do not break them.
 *
 * Intentionally a plain mutable object: the DEV-only debug GUI edits values live.
 * Gameplay code must treat it as read-only.
 */
import { DEG } from './math';

export const TUNING = {
  car: {
    length: 4.0,
    width: 1.9,
    /** Collision capsule: segment along the body axis at +/- capsuleHalf, radius `radius`. */
    capsuleHalf: 1.05,
    radius: 0.95,
    wheelBase: 2.5,
    wheelRadius: 0.42,
    maxSpeed: 40,
    maxReverseSpeed: 8,
    engineAccel: 12,
    reverseAccel: 6,
    brakeDecel: 24,
    rollingResistance: 0.6,
    /** Quadratic air drag, 1/m. */
    airDrag: 0.0025,
    /** Front wheel angle at low speed, rad. */
    maxSteerAngle: 0.6,
    /** Steer angle is divided by (1 + speed / steerSpeedRef). */
    steerSpeedRef: 12,
    /** Smoothed steer rise / return rates, 1/s (keyboard steer is digital). */
    steerRiseRate: 4,
    steerReturnRate: 6,
    /** Grip-mode lateral acceleration cap, m/s^2 (forces drifting/braking in tight corners at speed). */
    maxLatAccelGrip: 14,
    /** Grip-mode yaw-rate response, 1/s. */
    yawResponse: 12,
    /** Grip-mode lateral velocity decay rate, 1/s. */
    gripNormal: 9,
    /** Seconds of brake near standstill before reverse engages. */
    reverseDelay: 0.3,
    standstillSpeed: 0.8,
  },
  drift: {
    minSpeed: 8,
    /** |steer| needed for Space to kick a drift. */
    kickSteerThreshold: 0.2,
    slipNarrow: 15 * DEG,
    slipMid: 30 * DEG,
    slipWide: 45 * DEG,
    slipMax: 55 * DEG,
    /** Path curvature (1/m) when steering into the drift / neutral / counter-steering. */
    curvInto: 1 / 20,
    curvNeutral: 1 / 38,
    curvCounter: 1 / 90,
    handbrakeCurvBoost: 1.25,
    handbrakeDecel: 3,
    /** Body yaw tracking toward (velocity heading + target slip). */
    bodyResponse: 8,
    bodyMaxYawRate: 4,
    /** Speed change while drifting: -(dragBase + dragSlip*|sin slip|) + thrust*throttle, m/s^2. */
    dragBase: 3,
    dragSlip: 6,
    thrust: 9,
    /** Drift speed cap as a fraction of car.maxSpeed. */
    maxSpeedFactor: 0.9,
    /** Seconds without throttle and handbrake before the drift ends. */
    exitDelay: 0.25,
    /** Seconds for lateral grip to blend back to normal after a drift. */
    gripBlendTime: 0.3,
    /** Lateral decay rate at the start of the grip blend, 1/s. */
    gripDrift: 1.5,
    /** steer * driftDir below -flickSteer + a Space press flips the drift direction. */
    flickSteer: 0.6,
    recoverTime: 0.4,
  },
  surface: {
    runoff: { grip: 0.75, dragExtra: 2.5, maxSpeed: 25 },
    outside: { grip: 0.6, dragExtra: 4, maxSpeed: 15 },
  },
  collision: {
    restitution: 0.3,
    /** Normal impact speed (m/s) at or above which a contact is a heavy hit (burns the chain). */
    heavyImpact: 6,
    /** Tangential velocity kept per contact step: scrape vs heavy hit. */
    scrapeFriction: 0.985,
    hitFriction: 0.8,
    /** Yaw impulse per m/s of impact, scaled by lever arm sign. */
    yawImpulse: 0.15,
    iterations: 3,
    /** Seconds before the same collider can emit another hit/scrape event. */
    cooldown: 0.3,
  },
  score: {
    basePerSec: 100,
    minSlip: 10 * DEG,
    angleRef: 30 * DEG,
    angleCap: 60 * DEG,
    speedRef: 20,
    speedFactorCap: 1.6,
    minSpeed: 8,
    minProgressSpeed: 2,
    frontierSlack: 5,
    graceTime: 1.5,
    /** Multiplier = min(multiplierMax, 1 + floor(chainDriftTime / multiplierStep)). */
    multiplierStep: 2,
    multiplierMax: 5,
    propPenalty: 100,
    pointsPerCoin: 1000,
  },
  progress: {
    /** Projection search window around the previous s, m. */
    window: 30,
    wrongWaySpeed: -2,
    wrongWayTime: 1,
    /** Seconds after respawn/heavy hit during which wrong-way is not reported. */
    graceTime: 1.5,
    respawnSpacing: 50,
    /** Car spawns this far after the start line, m. */
    spawnOffset: 3,
    /** Auto-respawn when |lateral| exceeds barrier offset + this, m. */
    outOfBoundsMargin: 2,
  },
  pickups: {
    coinRadius: 2.2,
    canRadius: 0.5,
    cupRadius: 0.6,
    /** Fraction of speed lost when knocking a light prop. */
    knockSpeedLoss: 0.03,
  },
  track: {
    roadHalfWidth: 7,
    curbWidth: 1,
    runoffWidth: 4,
    minRadius: 22,
    tallDecorHeight: 5,
    tallDecorKeepOut: 35,
    /** Minimum free width next to an intruding obstacle, m. */
    minFreeWidth: 7,
  },
  race: {
    laps: 3,
    countdown: 3,
    physicsHz: 120,
    maxStepsPerFrame: 12,
    maxFrameDt: 0.1,
  },
  camera: {
    distance: 18,
    height: 8.5,
    lookAhead: 6,
    lookHeight: 0.5,
    fov: 58,
    fovSpeedBoost: 6,
    distanceSpeedBoost: 4,
    posSmoothing: 6,
    yawSmoothing: 4,
    maxYawRate: 2.5,
    /** Below this speed the camera follows body heading instead of velocity direction. */
    headingBlendSpeed: 5,
    shakeDecay: 6,
    near: 1,
    far: 1500,
  },
};

export type Tuning = typeof TUNING;

/** Barrier offset from the centreline, m. */
export function barrierOffset(t: Tuning = TUNING): number {
  return t.track.roadHalfWidth + t.track.curbWidth + t.track.runoffWidth;
}
