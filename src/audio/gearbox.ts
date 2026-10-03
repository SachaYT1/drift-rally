/**
 * Virtual gearbox for the engine SOUND (audio layer only: the physics has no gears).
 *
 * The physics `CarState.rpm` rises in one straight line with speed; voiced directly it is a siren.
 * Here the car speed is mapped to an engine speed `rev` through a few gears instead, so the pitch
 * climbs inside a gear, drops ~30-40 % on every up-shift and jumps back up on a down-shift.
 *
 * `rev` is the engine speed as a fraction of the redline (1 = redline); the voice maps it linearly
 * to the firing frequency, like a real engine. All functions here are pure.
 */
import { clamp } from '../shared/math';
import { TUNING } from '../shared/tuning';

export interface GearboxConfig {
  /**
   * Car speed at which each gear reaches the redline (rev 1), as fractions of TUNING.car.maxSpeed.
   * Ascending; a 1:1.5 step between neighbours gives a ~33 % rev drop per up-shift.
   */
  readonly gearTops: readonly number[];
  /** Engine speed at idle, fraction of the redline. */
  readonly idleRev: number;
  /** Up-shift when the rev in the current gear reaches this. */
  readonly upshiftRev: number;
  /** Down-shift when the rev in the current gear falls below this (wide hysteresis: no hunting). */
  readonly downshiftRev: number;
  /** First-gear clutch slip: at full throttle the rev is held at least here until the wheels catch up. */
  readonly launchRev: number;
  /** Wheel-spin rev boost while drifting on full throttle (0.15 = +15 %). */
  readonly driftFlare: number;
  /** Smoothing time constant of the flare, s. */
  readonly flareTau: number;
  /** Rev limiter: the flare cannot push past it. */
  readonly revLimit: number;
  /** Up-shift clutch time, s: the rev holds at the new gear's value (no climbing) while the clutch is out. */
  readonly shiftTime: number;
}

export interface GearboxState {
  /** 1-based gear. */
  readonly gear: number;
  /** Smoothed wheel-spin flare, 0..driftFlare. */
  readonly flare: number;
  /** Engine speed, fraction of the redline. */
  readonly rev: number;
  /** Seconds left in the current up-shift (0 = clutch engaged). */
  readonly clutch: number;
  /** Rev held while the clutch is out (the new gear's rev at the shift). */
  readonly held: number;
}

export interface GearboxInput {
  /** |v|, m/s. */
  readonly speed: number;
  /** 0..1 */
  readonly throttle: number;
  /** car.mode === 'drift' */
  readonly drifting: boolean;
}

/** +1 up-shift, -1 down-shift (possibly several gears at once), 0 none. */
export type Shift = -1 | 0 | 1;

/** Finite and >= 0, else 0. */
function nonNeg(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Finite value clamped to [0, 1]; anything non-finite becomes 0. */
function unit(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

function clampGear(gear: number, cfg: GearboxConfig): number {
  return Number.isFinite(gear) ? clamp(Math.round(gear), 1, cfg.gearTops.length) : 1;
}

/** Rev in `gear` from the road speed alone (clutch engaged): proportional to speed. */
export function gearRev(speed: number, gear: number, cfg: GearboxConfig, maxSpeed: number = TUNING.car.maxSpeed): number {
  return nonNeg(speed) / (cfg.gearTops[clampGear(gear, cfg) - 1] * maxSpeed);
}

/**
 * Engine rev in `gear`: the road-speed rev, never below idle; in first gear the clutch slips so the
 * throttle alone revs the engine up to `launchRev`; the drift flare adds wheel-spin on top, up to the limiter.
 */
export function engineRev(
  speed: number,
  gear: number,
  throttle: number,
  flare: number,
  cfg: GearboxConfig,
  maxSpeed: number = TUNING.car.maxSpeed,
): number {
  const g = clampGear(gear, cfg);
  let rev = Math.max(cfg.idleRev, gearRev(speed, g, cfg, maxSpeed));
  if (g === 1) rev = Math.max(rev, cfg.idleRev + (cfg.launchRev - cfg.idleRev) * unit(throttle));
  return Math.min(cfg.revLimit, rev * (1 + nonNeg(flare)));
}

/** Gear for `speed` starting from `gear`, with hysteresis. Jumps several gears at once after a respawn. */
export function selectGear(speed: number, gear: number, cfg: GearboxConfig, maxSpeed: number = TUNING.car.maxSpeed): number {
  let g = clampGear(gear, cfg);
  const top = cfg.gearTops.length;
  while (g < top && gearRev(speed, g, cfg, maxSpeed) >= cfg.upshiftRev) g++;
  while (g > 1 && gearRev(speed, g, cfg, maxSpeed) < cfg.downshiftRev) g--;
  return g;
}

export function initialGearbox(cfg: GearboxConfig): GearboxState {
  return { gear: 1, flare: 0, rev: cfg.idleRev, clutch: 0, held: cfg.idleRev };
}

/** Advances the gearbox by `dt` seconds. Returns the new state and the shift direction (if any). */
export function stepGearbox(
  state: GearboxState,
  input: GearboxInput,
  dt: number,
  cfg: GearboxConfig,
  maxSpeed: number = TUNING.car.maxSpeed,
): { state: GearboxState; shift: Shift } {
  const speed = nonNeg(input.speed);
  const throttle = unit(input.throttle);
  const prev = clampGear(state.gear, cfg);
  const gear = selectGear(speed, prev, cfg, maxSpeed);
  const target = input.drifting ? cfg.driftFlare * throttle : 0;
  const k = cfg.flareTau > 0 ? 1 - Math.exp(-nonNeg(dt) / cfg.flareTau) : 1;
  const was = Number.isFinite(state.flare) ? state.flare : 0;
  const flare = was + (target - was) * k;
  const free = engineRev(speed, gear, throttle, flare, cfg, maxSpeed);
  const shift: Shift = gear > prev ? 1 : gear < prev ? -1 : 0;
  // Up-shift: hold the new gear's rev for the clutch time, so the drop is heard before the next climb.
  let clutch = shift < 0 ? 0 : Math.max(0, (Number.isFinite(state.clutch) ? state.clutch : 0) - nonNeg(dt));
  let held = Number.isFinite(state.held) ? state.held : free;
  if (shift > 0) {
    clutch = cfg.shiftTime;
    held = free;
  }
  const rev = clutch > 0 ? Math.min(free, held) : free;
  return { state: { gear, flare, rev, clutch, held }, shift };
}
