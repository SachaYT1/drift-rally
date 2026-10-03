/**
 * Engine voice presets and the pure curves that map engine speed (`rev`, see gearbox.ts) and
 * throttle to synth parameters. The voice is a warm small petrol engine, never shrill:
 * - pitch: firing frequency linear in rev, ~50 Hz idle, ~175 Hz at the top of a gear, hard cap;
 * - brightness: the lowpass tracks the pitch (a fixed number of harmonics), opens with throttle,
 *   gentle Q (no resonant peak), plus a fixed lowpass and high-shelf cut for the 2-5 kHz band;
 * - loudness: equal-loudness compensated (gain falls as rev rises), coasting clearly quieter.
 *
 * Preset A ships in the game; B and C are alternatives for the sound lab (temp/sound-lab.html).
 */
import { clamp, lerp } from '../shared/math';
import type { GearboxConfig } from './gearbox';

export interface EnginePreset {
  readonly id: string;
  /** Sound-lab label and caption (Russian, player-facing). */
  readonly title: string;
  readonly caption: string;
  readonly gearbox: GearboxConfig;
  /** Firing frequency at the redline (rev 1), Hz. pitch = redlineHz * rev. */
  readonly redlineHz: number;
  /** Hard cap on the fundamental, Hz. */
  readonly pitchCapHz: number;
  /** Oscillator mix: saw (bite), triangle (warmth), sub-octave sine at f/2 (body). */
  readonly sawMix: number;
  readonly triMix: number;
  readonly subMix: number;
  /** Soft-saturation drive, coasting .. full throttle (engine under load growls a little). */
  readonly driveCoast: number;
  readonly driveFull: number;
  /** Firing-pulse amplitude modulation by the f/2 sub (half-order "burble"), at idle .. redline. */
  readonly lumpIdle: number;
  readonly lumpRedline: number;
  /** Combustion noise under throttle, pulsed at the firing rate: gain at full throttle, band centre Hz. */
  readonly rumble: number;
  readonly rumbleHz: number;
  /** Main lowpass cutoff = pitch * harmonics (coasting .. full throttle), clamped to [min, max] Hz. */
  readonly harmonicsCoast: number;
  readonly harmonicsFull: number;
  readonly cutoffMinHz: number;
  readonly cutoffMaxHz: number;
  readonly filterQ: number;
  /** Fixed second lowpass and high-shelf cut that keep the ear's most sensitive band down. */
  readonly tameHz: number;
  readonly shelfHz: number;
  readonly shelfDb: number;
  /** Output gain on full throttle at idle rev; coasting multiplies it by coastLevel. */
  readonly level: number;
  readonly coastLevel: number;
  /**
   * Off-throttle gain multiplier at idle (idling is not coasting: the engine still has to be heard on
   * the start line); blends into coastLevel over the first IDLE_BLEND of the rev range.
   */
  readonly idleLevel: number;
  /** Equal-loudness compensation: the gain falls by this many dB from idle to the redline. */
  readonly rpmCompDb: number;
  /** Pitch wobble at idle, cents (two slow incommensurate LFOs). */
  readonly idleWobble: number;
  /** Up-shift level dip (gain multiplier); it lasts gearbox.shiftTime. */
  readonly shiftDip: number;
  /** Glide time constants: pitch, and filter / level / timbre, s. */
  readonly pitchTau: number;
  readonly toneTau: number;
}

/**
 * Five gears; neighbours ~1:1.5 apart so every up-shift drops the rev 31-37 %. With maxSpeed 40 the
 * shipped preset shifts up at ~9 / 14 / 21 / 30.5 m/s; on tarmac the car tops out near 34 m/s in 5th.
 */
const GEAR_TOPS = [0.24, 0.38, 0.57, 0.83, 1.22] as const;

const A: EnginePreset = {
  id: 'A',
  title: 'A — Спортивный',
  caption: 'Тёплый бензиновый мотор маленькой спортивной машины: мягкий гул на холостых, бодрый разгон с переключениями передач.',
  gearbox: { gearTops: GEAR_TOPS, idleRev: 0.274, upshiftRev: 0.92, downshiftRev: 0.5, launchRev: 0.5,
    driftFlare: 0.15, flareTau: 0.2, revLimit: 1, shiftTime: 0.12 },
  redlineHz: 190,
  pitchCapHz: 215,
  sawMix: 0.5, triMix: 0.5, subMix: 0.6,
  driveCoast: 1, driveFull: 1.7,
  lumpIdle: 0.45, lumpRedline: 0.2,
  rumble: 1.2, rumbleHz: 260,
  harmonicsCoast: 4.5, harmonicsFull: 7.5, cutoffMinHz: 280, cutoffMaxHz: 1450, filterQ: 0.8,
  tameHz: 2000, shelfHz: 2500, shelfDb: -10,
  level: 0.115, coastLevel: 0.4, idleLevel: 0.65, rpmCompDb: 4.5,
  idleWobble: 16,
  shiftDip: 0.45,
  pitchTau: 0.03, toneTau: 0.07,
};

const B: EnginePreset = {
  id: 'B',
  title: 'B — Глубокий',
  caption: 'Ниже и раскатистее: больше баса и «бульканья» на холостых, грубее рычит под газом — как маслкар.',
  gearbox: { gearTops: GEAR_TOPS, idleRev: 0.262, upshiftRev: 0.9, downshiftRev: 0.5, launchRev: 0.48,
    driftFlare: 0.18, flareTau: 0.18, revLimit: 1, shiftTime: 0.13 },
  redlineHz: 176,
  pitchCapHz: 200,
  sawMix: 0.6, triMix: 0.3, subMix: 0.85,
  driveCoast: 1.2, driveFull: 2.3,
  lumpIdle: 0.6, lumpRedline: 0.3,
  rumble: 2, rumbleHz: 200,
  harmonicsCoast: 4, harmonicsFull: 6.5, cutoffMinHz: 240, cutoffMaxHz: 1200, filterQ: 0.9,
  tameHz: 1800, shelfHz: 2200, shelfDb: -12,
  level: 0.1, coastLevel: 0.4, idleLevel: 0.65, rpmCompDb: 4.5,
  idleWobble: 22,
  shiftDip: 0.4,
  pitchTau: 0.035, toneTau: 0.08,
};

const C: EnginePreset = {
  id: 'C',
  title: 'C — Мягкий',
  caption: 'Ровный и бархатный: почти без рычания, спокойнее под нагрузкой — самый щадящий для ушей.',
  gearbox: { gearTops: GEAR_TOPS, idleRev: 0.286, upshiftRev: 0.9, downshiftRev: 0.5, launchRev: 0.5,
    driftFlare: 0.12, flareTau: 0.3, revLimit: 1, shiftTime: 0.14 },
  redlineHz: 196,
  pitchCapHz: 215,
  sawMix: 0.25, triMix: 0.75, subMix: 0.45,
  driveCoast: 0.9, driveFull: 1.25,
  lumpIdle: 0.25, lumpRedline: 0.1,
  rumble: 0.6, rumbleHz: 300,
  harmonicsCoast: 4, harmonicsFull: 6, cutoffMinHz: 280, cutoffMaxHz: 1200, filterQ: 0.7,
  tameHz: 1800, shelfHz: 2200, shelfDb: -12,
  level: 0.125, coastLevel: 0.45, idleLevel: 0.7, rpmCompDb: 5,
  idleWobble: 12,
  shiftDip: 0.5,
  pitchTau: 0.04, toneTau: 0.09,
};

export const ENGINE_PRESETS = { A, B, C } as const;
export type EnginePresetId = keyof typeof ENGINE_PRESETS;
/** The voice the game uses. */
export const DEFAULT_ENGINE_PRESET: EnginePreset = A;

/** Share of the idle..redline range over which the off-throttle gain blends from idleLevel to coastLevel. */
const IDLE_BLEND = 0.2;

/** Finite value clamped to [0, 1]; anything non-finite becomes 0. */
function unit(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

/** Engine load from the pedal, 0..1. Concave: the sound is mostly "on load" by half throttle. */
export function throttleLoad(throttle: number): number {
  const t = unit(throttle);
  return 1 - (1 - t) * (1 - t);
}

/** 0 at idle .. 1 at the redline. */
export function revProgress(rev: number, p: EnginePreset = DEFAULT_ENGINE_PRESET): number {
  const idle = p.gearbox.idleRev;
  return Number.isFinite(rev) ? unit((rev - idle) / (1 - idle)) : 0;
}

/** Fundamental (firing) frequency, Hz: linear in rev, idle floor, hard cap. */
export function enginePitch(rev: number, p: EnginePreset = DEFAULT_ENGINE_PRESET): number {
  const g = p.gearbox;
  const r = Number.isFinite(rev) ? clamp(rev, g.idleRev, g.revLimit) : g.idleRev;
  return Math.min(p.pitchCapHz, p.redlineHz * r);
}

/** Main lowpass cutoff, Hz: a fixed number of harmonics (more on throttle), clamped. */
export function engineCutoff(rev: number, throttle: number, p: EnginePreset = DEFAULT_ENGINE_PRESET): number {
  const harmonics = lerp(p.harmonicsCoast, p.harmonicsFull, throttleLoad(throttle));
  return clamp(enginePitch(rev, p) * harmonics, p.cutoffMinHz, p.cutoffMaxHz);
}

/**
 * Output gain: louder on load, quieter as the rev (and so the perceived loudness) rises.
 * Off-throttle: idleLevel at idle, coastLevel once the engine is turning faster (coasting).
 */
export function engineLevel(rev: number, throttle: number, p: EnginePreset = DEFAULT_ENGINE_PRESET): number {
  const k = revProgress(rev, p);
  const offThrottle = lerp(p.idleLevel, p.coastLevel, unit(k / IDLE_BLEND));
  const load = lerp(offThrottle, 1, throttleLoad(throttle));
  return p.level * load * Math.pow(10, (-p.rpmCompDb * k) / 20);
}

/** Pre-shaper drive (1 = barely saturating). */
export function engineDrive(throttle: number, p: EnginePreset = DEFAULT_ENGINE_PRESET): number {
  return lerp(p.driveCoast, p.driveFull, throttleLoad(throttle));
}

/** Depth of the f/2 firing-pulse amplitude modulation: lumpy at idle, smoother when revving. */
export function engineLump(rev: number, p: EnginePreset = DEFAULT_ENGINE_PRESET): number {
  return lerp(p.lumpIdle, p.lumpRedline, revProgress(rev, p));
}

/** Combustion-noise gain: only on throttle, a little more at high rev. */
export function rumbleLevel(rev: number, throttle: number, p: EnginePreset = DEFAULT_ENGINE_PRESET): number {
  return p.rumble * throttleLoad(throttle) * lerp(0.6, 1, revProgress(rev, p));
}

/** Idle pitch wobble depth, cents: full at rest off-throttle, gone once the engine is pulling. */
export function idleWobbleCents(rev: number, throttle: number, p: EnginePreset = DEFAULT_ENGINE_PRESET): number {
  const near = 1 - unit(revProgress(rev, p) / 0.12);
  return p.idleWobble * near * near * (1 - throttleLoad(throttle));
}
