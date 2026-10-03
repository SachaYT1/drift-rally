/**
 * Tyre screech presets and the pure curves that map the car state to the screech voice
 * (screechVoice.ts). The goal is rubber, not wind:
 * - squeal: two slightly detuned tones (the two rear tyres) at 650-1100 Hz with fast stick-slip
 *   pitch jitter and amplitude chatter. It needs a real slide angle: light slides are mostly scrub,
 *   big angles are full squeal (a drift keeps a little squeal even while the slip swings through 0). Pitch rises a little with angle and speed, sits a little lower off
 *   the throttle (lift / handbrake: the rear tyres are locked or undriven);
 * - scrub: low grainy noise (300-900 Hz, 20-50 Hz grains) whose level follows how fast the rear axle
 *   slides sideways: rubber dragged over asphalt;
 * - chirps: a quick pitch / level blip when a drift starts and on a flick.
 *
 * Preset A ships in the game; B and C are alternatives for the sound lab (temp/sound-lab.html).
 */
import { clamp, DEG, lerp } from '../shared/math';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';

export interface ScreechPreset {
  readonly id: string;
  /** Sound-lab label and caption (Russian, player-facing). */
  readonly title: string;
  readonly caption: string;
  /** Squeal fundamental with no slide and no speed, on throttle, Hz. */
  readonly baseHz: number;
  /** Added from no slide to slipWide, Hz. */
  readonly slipHz: number;
  /** Added from standstill to car.maxSpeed, Hz. */
  readonly speedHz: number;
  /** Pitch multiplier off the throttle (blends in as the pedal lifts). */
  readonly liftPitch: number;
  /** One oscillator per rear tyre: waveform, static detune (cents) and mix. */
  readonly waves: readonly [OscillatorType, OscillatorType];
  readonly detuneCents: readonly [number, number];
  readonly tyreMix: readonly [number, number];
  /** Stick-slip pitch jitter: peak depth, cents, and band limit, Hz (band-limited random). */
  readonly jitterCents: number;
  readonly jitterHz: number;
  /** Stick-slip amplitude chatter: peak depth (fraction of the level) and band limit, Hz. */
  readonly chatter: number;
  readonly chatterHz: number;
  /** Formant bandpass: centre = pitch * formantRatio. */
  readonly formantRatio: number;
  readonly formantQ: number;
  /** Two cascaded gentle lowpasses (Q 0.7) cap the squeal, Hz. */
  readonly capHz: number;
  /** Slide angle where the squeal starts / is full, rad (smoothstep in between). */
  readonly squealSlip: readonly [number, number];
  /** Squeal share that stays on in a drift whatever the angle (mid-flick the slip passes 0). */
  readonly driftSqueal: number;
  /** Output gains at squeal / scrub 1. */
  readonly squealLevel: number;
  readonly scrubLevel: number;
  /** Scrub band: bandpass centre and Q, then a lowpass, Hz. */
  readonly scrubHz: number;
  readonly scrubQ: number;
  readonly scrubCutHz: number;
  /** Granular AM depth (0 = steady noise, 1 = separate grains) and grain rate at a slow .. fast slide, Hz. */
  readonly grain: number;
  readonly grainHz: readonly [number, number];
  /** Rear-axle sideways speed for the full scrub, m/s. */
  readonly scrubRefSpeed: number;
  /** Share of the scrub that is there whenever the tyres slide at all (the rest follows the slide speed). */
  readonly scrubFloor: number;
  /** Chirp: pitch blip, cents; level (fraction of the full squeal); time at the top, s; decay time constant, s. */
  readonly chirpCents: number;
  readonly chirpLevel: number;
  readonly chirpTime: number;
  readonly chirpTau: number;
  /** Envelope time constants (attack when rising, release when falling) and pitch glide, s. */
  readonly attackTau: number;
  readonly releaseTau: number;
  readonly pitchTau: number;
}

/** Overall screech intensity (shared by every preset): drift floor and the grip-slide share. */
export const SCREECH_INTENSITY = {
  /** Intensity floor while drifting: the tyres are always sliding in a drift. */
  driftFloor: 0.45,
  /** Fraction of drift screech for a grip-mode slide (recovery, scrubbing). */
  slideScale: 0.55,
} as const;

/** Scrub level = intensity^SCRUB_CURVE (a light slide is still clearly audible as scrub). */
const SCRUB_CURVE = 0.5;
/** Rear-axle sideways speed for the fastest grains, m/s. */
const GRAIN_FAST_SPEED = 18;

const A: ScreechPreset = {
  id: 'A',
  title: 'A — Резина',
  caption: 'Сбалансированный: две задние шины поют чуть вразнобой, с дрожью и хрустом резины по асфальту. Рекомендуем.',
  baseHz: 730, slipHz: 110, speedHz: 150, liftPitch: 0.95,
  waves: ['sawtooth', 'triangle'], detuneCents: [-6, 6], tyreMix: [0.55, 0.45],
  jitterCents: 62, jitterHz: 30,
  chatter: 0.3, chatterHz: 45,
  formantRatio: 1.3, formantQ: 2.2, capHz: 3400,
  squealSlip: [12 * DEG, 30 * DEG], driftSqueal: 0.3,
  squealLevel: 0.18, scrubLevel: 0.17,
  scrubHz: 520, scrubQ: 0.9, scrubCutHz: 950,
  grain: 0.7, grainHz: [26, 42], scrubRefSpeed: 14, scrubFloor: 0.35,
  chirpCents: 380, chirpLevel: 0.8, chirpTime: 0.02, chirpTau: 0.035,
  attackTau: 0.02, releaseTau: 0.065, pitchTau: 0.06,
};

const B: ScreechPreset = {
  id: 'B',
  title: 'B — Звонкий',
  caption: 'Больше чистого визга: тянет высокую ноту, как в аркадных гонках; шороха резины меньше.',
  baseHz: 780, slipHz: 130, speedHz: 140, liftPitch: 0.94,
  waves: ['sawtooth', 'sawtooth'], detuneCents: [-5, 7], tyreMix: [0.5, 0.5],
  jitterCents: 45, jitterHz: 25,
  chatter: 0.22, chatterHz: 40,
  formantRatio: 1.25, formantQ: 3, capHz: 3100,
  squealSlip: [9 * DEG, 24 * DEG], driftSqueal: 0.4,
  squealLevel: 0.245, scrubLevel: 0.1,
  scrubHz: 560, scrubQ: 0.9, scrubCutHz: 1000,
  grain: 0.6, grainHz: [28, 44], scrubRefSpeed: 14, scrubFloor: 0.35,
  chirpCents: 450, chirpLevel: 0.85, chirpTime: 0.02, chirpTau: 0.04,
  attackTau: 0.018, releaseTau: 0.07, pitchTau: 0.06,
};

const C: ScreechPreset = {
  id: 'C',
  title: 'C — Шершавый',
  caption: 'Больше шороха и хруста резины, визг тише и грубее — шины меньше «поют», больше трутся.',
  baseHz: 700, slipHz: 100, speedHz: 140, liftPitch: 0.95,
  waves: ['triangle', 'triangle'], detuneCents: [-9, 8], tyreMix: [0.5, 0.5],
  jitterCents: 66, jitterHz: 36,
  chatter: 0.4, chatterHz: 55,
  formantRatio: 1.35, formantQ: 1.8, capHz: 3200,
  squealSlip: [16 * DEG, 38 * DEG], driftSqueal: 0.15,
  squealLevel: 0.09, scrubLevel: 0.29,
  scrubHz: 460, scrubQ: 0.8, scrubCutHz: 900,
  grain: 0.85, grainHz: [22, 38], scrubRefSpeed: 13, scrubFloor: 0.3,
  chirpCents: 300, chirpLevel: 0.75, chirpTime: 0.02, chirpTau: 0.03,
  attackTau: 0.022, releaseTau: 0.07, pitchTau: 0.07,
};

export const SCREECH_PRESETS = { A, B, C } as const;
export type ScreechPresetId = keyof typeof SCREECH_PRESETS;
/** The screech the game uses. */
export const DEFAULT_SCREECH_PRESET: ScreechPreset = A;

/** Finite value clamped to [0, 1]; anything non-finite becomes 0. */
function unit(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

function smoothstep(lo: number, hi: number, x: number): number {
  const t = unit((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

/**
 * |slip| folded into [0, π/2], rad. slip is heading minus velocity heading, so rolling straight
 * backwards gives |slip| ≈ π: that counts as aligned (reversing never screeches), while a sideways
 * slide screeches whichever way the car is rolling. Non-finite input stays non-finite.
 */
export function slideAngle(slip: number): number {
  const a = Math.abs(slip);
  return a > Math.PI / 2 ? Math.max(0, Math.PI - a) : a;
}

/** 0 below a quarter of the drift speed .. 1 from 1.25 x drift speed. */
function speedFactor(speed: number): number {
  const minSpeed = TUNING.drift.minSpeed;
  return unit((speed - minSpeed * 0.25) / minSpeed);
}

/**
 * Screech intensity 0..1 from the slide angle and speed. A drift always screeches (floor), wider
 * angles louder; outside a drift only a real slide (above the scoring threshold) screeches.
 */
export function screechIntensity(car: CarState, drifting: boolean): number {
  const slip = slideAngle(car.slip);
  if (!Number.isFinite(car.speed) || !Number.isFinite(slip)) return 0;
  const speedK = speedFactor(car.speed);
  if (speedK === 0) return 0;
  const lo = TUNING.score.minSlip;
  const slipK = unit((slip - lo) / (TUNING.drift.slipWide - lo));
  if (drifting) return speedK * lerp(SCREECH_INTENSITY.driftFloor, 1, slipK);
  return speedK * slipK * SCREECH_INTENSITY.slideScale;
}

/**
 * Sideways speed of the rear axle, m/s: the centre's lateral speed plus the tail swing from the
 * yaw rate (the axle sits wheelBase / 2 behind the centre). 0 for non-finite input.
 */
export function rearSlideSpeed(car: CarState): number {
  const v = Math.abs(car.lateralSpeed - car.yawRate * (TUNING.car.wheelBase / 2));
  return Number.isFinite(v) ? v : 0;
}

/** Squeal and scrub levels, 0..1 each. Both are 0 whenever screechIntensity is 0 (incl. reversing). */
export function screechMix(car: CarState, drifting: boolean, p: ScreechPreset = DEFAULT_SCREECH_PRESET): { squeal: number; scrub: number } {
  const k = screechIntensity(car, drifting);
  if (k === 0) return { squeal: 0, scrub: 0 };
  const tone = smoothstep(p.squealSlip[0], p.squealSlip[1], slideAngle(car.slip));
  const squeal = k * (drifting ? Math.max(p.driftSqueal, tone) : tone);
  const slideK = unit(rearSlideSpeed(car) / p.scrubRefSpeed);
  const scrub = Math.pow(k, SCRUB_CURVE) * lerp(p.scrubFloor, 1, slideK);
  return { squeal, scrub };
}

/** Squeal fundamental, Hz: a little higher with a wider slide and more speed, a little lower off the throttle. */
export function squealPitch(car: CarState, throttle: number, p: ScreechPreset = DEFAULT_SCREECH_PRESET): number {
  const slipK = unit(slideAngle(car.slip) / TUNING.drift.slipWide);
  const speedK = unit(car.speed / TUNING.car.maxSpeed);
  return (p.baseHz + p.slipHz * slipK + p.speedHz * speedK) * lerp(p.liftPitch, 1, unit(throttle));
}

/** Grain modulation rate, Hz: finer grains the faster the rear axle slides. */
export function scrubGrainRate(car: CarState, p: ScreechPreset = DEFAULT_SCREECH_PRESET): number {
  return lerp(p.grainHz[0], p.grainHz[1], unit(rearSlideSpeed(car) / GRAIN_FAST_SPEED));
}

/** What the chirp detector remembers between updates. */
export interface SlideMemo {
  drifting: boolean;
  driftDir: -1 | 0 | 1;
}

export type ChirpKind = 'entry' | 'flick';

/** A chirp on drift entry and on a flick (the drift direction flips). `prev` null = no history: none. */
export function chirpKind(prev: SlideMemo | null, next: SlideMemo): ChirpKind | null {
  if (!prev || !next.drifting) return null;
  if (!prev.drifting) return 'entry';
  return prev.driftDir !== 0 && next.driftDir !== 0 && prev.driftDir !== next.driftDir ? 'flick' : null;
}

/**
 * Chirp level, fraction of the full squeal: scaled by speed only (so the chirp is there at the very
 * start of a drift, before the slip has built up), less on top of a squeal that is already loud
 * (`squealNow`, 0..1).
 */
export function chirpLevel(car: CarState, p: ScreechPreset = DEFAULT_SCREECH_PRESET, squealNow = 0): number {
  return Number.isFinite(car.speed) ? p.chirpLevel * speedFactor(car.speed) * (1 - 0.6 * unit(squealNow)) : 0;
}

/** setTargetAtTime time constant for a level moving from `from` to `to`. */
export function envelopeTau(from: number, to: number, p: ScreechPreset = DEFAULT_SCREECH_PRESET): number {
  return to > from ? p.attackTau : p.releaseTau;
}
