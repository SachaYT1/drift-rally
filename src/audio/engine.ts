/**
 * Audio graph building blocks (design spec §5 Audio): the master chain, the shared noise buffer
 * and the continuous race voices:
 * - engine: 2 detuned oscillators (saw + square) -> resonant lowpass -> highpass; pitch from rpm.
 *   Voiced as a small buzzy RC-car motor: high idle, fast-rising pitch, nasal filter resonance.
 * - tyre screech: looping white noise -> 2 cascaded bandpasses (centre wobbles a little)
 *   -> gain ∝ drift intensity.
 *
 * Sources are created and started once (they cannot be restarted); everything else is driven
 * with `setTargetAtTime`, so parameter changes never click. The mapping functions are pure.
 */
import { clamp, lerp } from '../shared/math';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';

/** Engine voicing. Audio-only mix constants (gameplay thresholds come from TUNING). */
export const ENGINE_VOICE = {
  idleHz: 82,
  maxHz: 430,
  /** Exponent < 1: pitch climbs quickly off idle, like a tiny high-revving motor. */
  pitchCurve: 0.85,
  /** Pitch bump while drifting (wheelspin). */
  driftPitch: 1.07,
  /**
   * Saw and a quieter square detuned ~60 cents apart: at driving rpm the beat (~9-15 Hz) is
   * heard as raspy roughness, not slow "wow" pulsing; at idle it gives a lumpy ~3 Hz idle.
   */
  sawDetuneCents: -15,
  squareDetuneCents: 45,
  squareMix: 0.25,
  cutoffBaseHz: 520,
  cutoffRpmHz: 2400,
  cutoffThrottleHz: 1300,
  filterQ: 4.5,
  /** Small-speaker character: no rumble below this. */
  highpassHz: 95,
  levelIdle: 0.045,
  levelRpm: 0.035,
  levelThrottle: 0.055,
  pitchTau: 0.035,
  levelTau: 0.06,
} as const;

/** Tyre screech voicing. */
export const SCREECH_VOICE = {
  /** Gain at intensity 1 (narrow band-passed white noise is ~ -25 dB, so this is > 1). */
  level: 1.15,
  baseHz: 1500,
  slipHz: 700,
  /** Band centre rises by this many Hz per m/s. */
  speedHz: 18,
  /** Two cascaded bandpasses at this Q: steep skirts give a tonal squeal instead of hiss. */
  q: 5,
  wobbleHz: 7.5,
  wobbleDepthHz: 110,
  /** Intensity floor while drifting: the tyres are always sliding in a drift. */
  driftFloor: 0.45,
  /** Fraction of drift screech for a grip-mode slide (recovery, scrubbing). */
  slideScale: 0.55,
  tau: 0.05,
} as const;

/** Fade time constant for activating / silencing the whole loop bus, s. */
const BUS_TAU = 0.07;

/** master gain -> compressor -> destination. Returns the master gain (the mix input). */
export function buildMasterChain(ctx: BaseAudioContext, level: number): GainNode {
  const master = ctx.createGain();
  master.gain.value = level;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.knee.value = 10;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.2;
  master.connect(compressor).connect(ctx.destination);
  return master;
}

/** Mono white noise, shared by the screech loop and noise one-shots. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Finite value clamped to [0, 1]; anything non-finite becomes 0. */
function unit(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

/** Engine oscillator frequency, Hz. */
export function engineFrequency(rpm: number, drifting: boolean): number {
  const E = ENGINE_VOICE;
  const f = lerp(E.idleHz, E.maxHz, Math.pow(unit(rpm), E.pitchCurve));
  return drifting ? f * E.driftPitch : f;
}

/** Engine gain (pre-bus): louder on throttle and at high rpm. */
export function engineLevel(rpm: number, throttle: number): number {
  const E = ENGINE_VOICE;
  return E.levelIdle + E.levelRpm * unit(rpm) + E.levelThrottle * unit(throttle);
}

/** Engine lowpass cutoff, Hz: brighter on throttle and at high rpm. */
export function engineCutoff(rpm: number, throttle: number): number {
  const E = ENGINE_VOICE;
  return E.cutoffBaseHz + E.cutoffRpmHz * unit(rpm) + E.cutoffThrottleHz * unit(throttle);
}

/**
 * Screech intensity 0..1 from |slip| and speed. A drift always screeches (floor), wider angles
 * louder; outside a drift only a real slide (|slip| above the scoring threshold) screeches.
 */
export function screechIntensity(car: CarState, drifting: boolean): number {
  const speed = car.speed;
  const slip = Math.abs(car.slip);
  if (!Number.isFinite(speed) || !Number.isFinite(slip)) return 0;
  const minSpeed = TUNING.drift.minSpeed;
  const speedK = clamp((speed - minSpeed * 0.25) / minSpeed, 0, 1);
  if (speedK === 0) return 0;
  const lo = TUNING.score.minSlip;
  const slipK = clamp((slip - lo) / (TUNING.drift.slipWide - lo), 0, 1);
  if (drifting) return speedK * lerp(SCREECH_VOICE.driftFloor, 1, slipK);
  return speedK * slipK * SCREECH_VOICE.slideScale;
}

/** Screech band centre, Hz: higher with wider slip and more speed. */
export function screechFrequency(car: CarState): number {
  const S = SCREECH_VOICE;
  const slipK = unit(Math.abs(car.slip) / TUNING.drift.slipWide);
  const speed = Number.isFinite(car.speed) ? clamp(car.speed, 0, TUNING.car.maxSpeed) : 0;
  return S.baseHz + S.slipHz * slipK + S.speedHz * speed;
}

function createBandpass(ctx: BaseAudioContext, hz: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

export interface LoopVoices {
  /** Glide engine/screech params toward the car state. `now` = context currentTime. */
  update(car: CarState, throttle: number, drifting: boolean, now: number): void;
  /** Fade both voices in/out. Sources keep running silently (they cannot be restarted). */
  setActive(on: boolean, now: number): void;
}

/** Builds the engine + screech graph into `out` and starts its sources. Starts silent. */
export function createLoopVoices(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer): LoopVoices {
  const E = ENGINE_VOICE;
  const S = SCREECH_VOICE;

  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(out);

  // Engine: saw + quieter square, slightly detuned, through a resonant lowpass.
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = E.idleHz;
  saw.detune.value = E.sawDetuneCents;
  const square = ctx.createOscillator();
  square.type = 'square';
  square.frequency.value = E.idleHz;
  square.detune.value = E.squareDetuneCents;
  const squareMix = ctx.createGain();
  squareMix.gain.value = E.squareMix;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = E.cutoffBaseHz;
  lowpass.Q.value = E.filterQ;
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = E.highpassHz;
  highpass.Q.value = 0.7;
  const engineGain = ctx.createGain();
  engineGain.gain.value = E.levelIdle;
  saw.connect(lowpass);
  square.connect(squareMix).connect(lowpass);
  lowpass.connect(highpass).connect(engineGain).connect(bus);

  // Screech: looping noise through two bandpasses whose centre wobbles a little.
  const hiss = ctx.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  const bandA = createBandpass(ctx, S.baseHz, S.q);
  const bandB = createBandpass(ctx, S.baseHz, S.q);
  const wobble = ctx.createOscillator();
  wobble.frequency.value = S.wobbleHz;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = S.wobbleDepthHz;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(bandA.frequency);
  wobbleDepth.connect(bandB.frequency);
  const screechGain = ctx.createGain();
  screechGain.gain.value = 0;
  hiss.connect(bandA).connect(bandB).connect(screechGain).connect(bus);

  const t0 = ctx.currentTime;
  saw.start(t0);
  square.start(t0);
  hiss.start(t0);
  wobble.start(t0);

  return {
    update(car, throttle, drifting, now) {
      const f = engineFrequency(car.rpm, drifting);
      saw.frequency.setTargetAtTime(f, now, E.pitchTau);
      square.frequency.setTargetAtTime(f, now, E.pitchTau);
      lowpass.frequency.setTargetAtTime(engineCutoff(car.rpm, throttle), now, E.levelTau);
      engineGain.gain.setTargetAtTime(engineLevel(car.rpm, throttle), now, E.levelTau);
      const k = screechIntensity(car, drifting);
      screechGain.gain.setTargetAtTime(k * S.level, now, S.tau);
      if (k > 0) {
        const hz = screechFrequency(car);
        bandA.frequency.setTargetAtTime(hz, now, S.tau);
        bandB.frequency.setTargetAtTime(hz, now, S.tau);
      }
    },
    setActive(on, now) {
      bus.gain.setTargetAtTime(on ? 1 : 0, now, BUS_TAU);
      // Never resume with a stale screech.
      if (!on) screechGain.gain.setTargetAtTime(0, now, S.tau);
    },
  };
}
