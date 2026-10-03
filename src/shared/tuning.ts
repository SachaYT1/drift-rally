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
    /** Below this speed the slip angle is reported as 0, m/s (CarState.slip contract). */
    slipMinSpeed: 1,
    /** rpm = |vf| / maxSpeed * rpmSpeedShare + throttle * (1 - rpmSpeedShare). */
    rpmSpeedShare: 0.85,
  },
  drift: {
    minSpeed: 8,
    /** |steer| needed for Space to kick a drift. */
    kickSteerThreshold: 0.2,
    slipNarrow: 15 * DEG,
    slipMid: 30 * DEG,
    slipWide: 45 * DEG,
    slipMax: 55 * DEG,
    /**
     * Path curvature (1/m) when steering into the drift / neutral / counter-steering. Full counter-steer
     * (negative: a slight OUTWARD curve) widens a line that is too tight while the car keeps sliding. The
     * into arc is only as tight as a keyboard tap can take back (a 1/20 tap swung the heading ~20 deg in on a
     * wide sweeper). The steer held through a kick or flick does not count as into-steer (CarState.intoLatch);
     * into-steer follows the wheel in but lets go with the key.
     */
    curvInto: 1 / 28,
    curvNeutral: 1 / 38,
    curvCounter: -1 / 150,
    /** Path curvature multiplier while Space is held in a drift (tighter arc). */
    handbrakeCurvBoost: 1.25,
    /**
     * Smooth entry: seconds over which a kick bends the path from the curvature the car had in grip to the
     * drift target (smoothstep). The kick swings the body into the slide at once without yanking the path.
     */
    entryBlendTime: 0.4,
    /**
     * The kick holds the line: seconds over which the neutral drift arc eases (smoothstep) from the path the
     * car had in grip to curvNeutral, so a kick on a wide sweeper does not tuck in before the player reacts.
     */
    entryHoldTime: 1.3,
    /** Seconds over which a flick bends the path from the one the car is on to the new side (smoothstep). */
    flickBlendTime: 0.3,
    /**
     * Space held in a drift (spec §2.3): the rear wheels lock, so there is no engine drive and the speed bleeds
     * at this rate on top of the drift drag (dragBase + dragSlip*|sin slip|, ~5-7.6), m/s^2: ~10.5-12.5 in
     * total. Holding W + Space reaches the low-speed exit in ~1.5-1.8 s from 25 m/s, ~1.9-2.2 s from 30 m/s
     * (a neutral drift on W); a 0.2 s tap costs ~2.3 m/s. Space is for kicking and tightening, never for
     * sustaining.
     */
    handbrakeDecel: 5,
    /** Space held in grip (below drift speed, no steer, the exit phase): no engine drive, light braking, m/s^2. */
    handbrakeGripDecel: 4,
    /** Body yaw tracking toward (velocity heading + target slip). */
    bodyResponse: 8,
    bodyMaxYawRate: 4,
    /**
     * Speed change while drifting: -(dragBase + dragSlip*|sin slip|) + thrust*throttle*fade, m/s^2, with
     * fade = 1 - (speed / top)^2 (floored at 0): a drift on W settles at a steady speed instead of running
     * to the drift cap. top = driftTopSpeed, scaled down to topStraight times that at zero path curvature
     * (blending back to 1 at curvNeutral): a counter-steered drift slides at a narrower angle and drags
     * less, so without this it would outrun a neutral drift down a straight (the "drift highway").
     */
    dragBase: 3,
    dragSlip: 6,
    thrust: 9,
    driftTopSpeed: 57,
    topStraight: 0.75,
    /** Drift speed cap as a fraction of car.maxSpeed. */
    maxSpeedFactor: 0.9,
    /** Seconds without throttle before the drift ends (Space held or not: only throttle sustains a drift). */
    exitDelay: 0.25,
    /** Seconds for lateral grip (and, during the exit phase, steering authority) to blend back after a drift. */
    gripBlendTime: 0.3,
    /** Lateral decay rate at the start of the grip blend, 1/s. */
    gripDrift: 1.5,
    /** steer * driftDir below -flickSteer + a Space press flips the drift direction. */
    flickSteer: 0.6,
    /**
     * Seconds a Space press stays armed for a flick, so Space pressed slightly before the opposite steer
     * still flicks (holding Space while the steer crosses over flicks too).
     */
    flickWindow: 0.12,
    /**
     * Catch: full counter-steer (steer * driftDir <= -catchSteer) held for catchTime seconds with Space
     * released ends the drift. Counted while both the input and the wheel (smoothed steer, which sets the
     * path curvature) are at full counter-steer, so a keyboard counter-steer first slides on a slightly
     * outward path for catchTime (~0.5 s from the key press out of a neutral drift). Partial counter-steer
     * keeps drifting; Space held keeps the slide (locked rear wheels), which then bleeds speed (handbrakeDecel)
     * until the low-speed exit.
     */
    catchSteer: 0.85,
    catchTime: 0.3,
    /**
     * Every drift exit keeps the direction of travel: for exitAlignTime seconds the path only turns by
     * steering (authority blending in with gripBlend) while the body swings to the velocity heading as a
     * critically damped spring (natural frequency exitAlignResponse, 1/s; no overshoot), its yaw rate
     * capped at exitAlignMaxYawRate, rad/s.
     */
    exitAlignTime: 0.5,
    exitAlignResponse: 10,
    exitAlignMaxYawRate: 4,
    /** Brake (S) in a drift scrubs speed at car.brakeDecel times this. */
    brakeFactor: 0.6,
    /** Seconds of brake held before a drift ends (grip blends back in as on a normal exit). */
    brakeExitTime: 0.15,
    recoverTime: 0.4,
    /** A drift ends when speed drops below minSpeed times this factor. */
    holdSpeedFactor: 0.75,
    /** Throttle below this counts as released for the drift exit timer. */
    throttleMin: 0.1,
    /** Extra target slip while the handbrake is held in a drift, rad. */
    handbrakeExtraSlip: 5 * DEG,
    /** Speed bleed above the drift speed cap (fast drift onto runoff, kick above the cap), m/s^2. */
    overspeedDecel: 24,
    /** Recovery eases the body toward the velocity heading only above this speed, m/s. */
    recoverMinSpeed: 3,
    /** Recovery yaw-rate target per radian of heading error, 1/s. */
    recoverYawGain: 4,
    /**
     * Recovery eases the body only while the velocity heading is within this angle of the body heading,
     * rad: a car sliding sideways (~90 deg) eases; one moving backwards after a head-on bounce would spin.
     */
    recoverMaxAngle: 100 * DEG,
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
    /** Seconds before the same collider can emit another scrape event (heavy hits always report). */
    cooldown: 0.3,
    /**
     * Wall slide: a scrape (no heavy hit that step) with the nose into a barrier turns the nose toward the
     * barrier's tangent in the direction of travel, so W slides the car along a barrier instead of
     * grinding it into it. Turn rate = slideAlignGain (1/s) per radian of heading error, kept within
     * [slideAlignMinRate, slideAlignMaxRate] (rad/s; the floor reaches parallel in finite time, so the car
     * leaves the wall instead of grazing it, and scrapeFriction, forever); times slideDriftScale in drift mode
     * (a drift kissing the wall is not spun). Slower than slideTravelSpeed along the surface (m/s), the nose
     * turns toward the track's driving direction instead: a pinned car is turned back onto the course, never
     * into the wrong way. At a heavy obstacle (bench leg, sneaker, bicycle tyre) the nose only deflects
     * slideObstacleAngle (rad) past the track direction toward the free side (past head-on where no barrier
     * gives the track direction), and the car is carried along the obstacle's surface toward that side at up
     * to slideObstacleSpeed (m/s, topping up its own speed along it; a nose pressed in at that angle would
     * only crawl): it slides around the obstacle and leaves along the track, not along the obstacle's own
     * surface and across the road.
     */
    slideAlignGain: 6,
    slideAlignMinRate: 0.3,
    slideAlignMaxRate: 2.5,
    slideDriftScale: 0.2,
    slideTravelSpeed: 4,
    slideObstacleAngle: 20 * DEG,
    slideObstacleSpeed: 4,
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
    /** Exponential smoothing rate of progressSpeed (ds/dt), 1/s. */
    speedSmoothing: 10,
    /** Per-step progress cap: |ds| <= |v|·dt·dsSpeedFactor + dsSlack, m (spec §2.6). */
    dsSpeedFactor: 1.5,
    dsSlack: 0.5,
  },
  pickups: {
    /** Coin trigger radius, tested against the car CAPSULE (reach ≈ coinRadius + car.radius from the body axis). */
    coinRadius: 1.4,
    canRadius: 0.5,
    cupRadius: 0.6,
    /** Fraction of speed lost when knocking a light prop. */
    knockSpeedLoss: 0.03,
    /** Broad-phase radius around the car centre, m; widened per spot when the capsule reach is larger. */
    nearRadius: 8,
    /** A knocked prop is launched with the car velocity times this factor (fx only). */
    propLaunchFactor: 1.2,
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
    height: 9.5,
    /** Look-at point ahead of the car, m. Puts the car in the lower third like the reference. */
    lookAhead: 24,
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
    /** Shake amplitude per m/s of heavy-hit impact speed, m; capped at shakeMax. */
    shakePerImpact: 0.05,
    shakeMax: 0.8,
    /** Shake jitter angular frequencies, rad/s (incommensurate so the pattern does not repeat). */
    shakeFreqX: 37,
    shakeFreqY: 43,
    shakeFreqZ: 29,
    /** Vertical shake relative to horizontal. */
    shakeYScale: 0.6,
    near: 1,
    far: 1500,
  },
};

export type Tuning = typeof TUNING;

/** Barrier offset from the centreline, m. */
export function barrierOffset(t: Tuning = TUNING): number {
  return t.track.roadHalfWidth + t.track.curbWidth + t.track.runoffWidth;
}
