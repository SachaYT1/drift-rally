/**
 * Audio graph building blocks (design spec §5 Audio): the master chain, the shared noise buffer
 * and the continuous race voices:
 * - engine: car speed -> virtual gearbox (gearbox.ts) -> engine rev -> warm petrol-engine voice
 *   (engineVoice.ts, voiced by an EnginePreset from enginePresets.ts; the game uses preset A).
 * - tyre screech: looping white noise -> 2 cascaded bandpasses (centre wobbles a little)
 *   -> gain ∝ drift intensity.
 *
 * Both feed a loop bus (on/off fade) -> duck gain (dips under reward cues) -> master.
 *
 * Sources are created and started once (they cannot be restarted); everything else is driven
 * with `setTargetAtTime`, so parameter changes never click. The mapping functions are pure.
 */
import { clamp, lerp } from '../shared/math';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';
import { DEFAULT_ENGINE_PRESET, type EnginePreset } from './enginePresets';
import { createEngineVoice, hardSet } from './engineVoice';
import { initialGearbox, stepGearbox, type GearboxState } from './gearbox';

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
/** After this long a fade-out is at -52 dB: params may be reset without an audible jump, s. */
const BUS_SILENT_AFTER = 6 * BUS_TAU;

/** Loop-bus dip under reward cues (coin, chain banked) so they are not buried by engine/screech. */
export const LOOP_DUCK = {
  /** Bus gain while ducked (about -4.4 dB). */
  level: 0.6,
  attackTau: 0.012,
  releaseTau: 0.08,
} as const;

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

/**
 * |slip| folded into [0, π/2], rad. slip is heading minus velocity heading, so rolling straight
 * backwards gives |slip| ≈ π: that counts as aligned (reversing never screeches), while a sideways
 * slide screeches whichever way the car is rolling. Non-finite input stays non-finite.
 */
export function slideAngle(slip: number): number {
  const a = Math.abs(slip);
  return a > Math.PI / 2 ? Math.max(0, Math.PI - a) : a;
}

/**
 * Screech intensity 0..1 from the slide angle and speed. A drift always screeches (floor), wider
 * angles louder; outside a drift only a real slide (above the scoring threshold) screeches.
 */
export function screechIntensity(car: CarState, drifting: boolean): number {
  const speed = car.speed;
  const slip = slideAngle(car.slip);
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
  const slipK = unit(slideAngle(car.slip) / TUNING.drift.slipWide);
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
  /**
   * Fade both voices in/out. Sources keep running silently (they cannot be restarted).
   * `cut`: when turning off, silence instantly instead of gliding. Use it when the output is
   * already silent (paused / suspended context): a glide scheduled on a frozen clock would play
   * out audibly after the next resume. Turning on from silence restarts the engine at idle.
   */
  setActive(on: boolean, now: number, cut?: boolean): void;
  /** Dip the loops under a cue that starts at `at` and keep them down for `hold` s. */
  duck(at: number, hold: number): void;
}

/** Engine "lifts off" this much during an up-shift (darker for a moment), throttle multiplier. */
const SHIFT_LIFT = 0.25;
/** Longest gap between two updates the gearbox integrates, s (a stalled tab must not jump the flare). */
const MAX_STEP = 0.1;

/**
 * Builds the engine + screech graph into `out` and starts its sources. Starts silent.
 * `preset` voices the engine (the game uses DEFAULT_ENGINE_PRESET; the sound lab compares others).
 */
export function createLoopVoices(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  preset: EnginePreset = DEFAULT_ENGINE_PRESET,
): LoopVoices {
  const S = SCREECH_VOICE;

  const bus = ctx.createGain();
  bus.gain.value = 0;
  const ducker = ctx.createGain();
  bus.connect(ducker).connect(out);

  const engine = createEngineVoice(ctx, bus, noise, preset);
  let gearbox: GearboxState = initialGearbox(preset.gearbox);
  /** Context time of the previous update (null right after a reset). */
  let lastAt: number | null = null;

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

  /** Whether the bus is (fading) on, and the context time from which it is fully silent. */
  let on = false;
  let silentAt = 0;
  /** Params were moved by update() since the last reset to idle. */
  let stale = false;

  const t0 = ctx.currentTime;
  hiss.start(t0);
  wobble.start(t0);

  return {
    update(car, throttle, drifting, now) {
      stale = true;
      const dt = lastAt === null ? 0 : clamp(now - lastAt, 0, MAX_STEP);
      lastAt = now;
      const step = stepGearbox(gearbox, { speed: car.speed, throttle, drifting }, dt, preset.gearbox);
      gearbox = step.state;
      if (step.shift !== 0) engine.shift(step.shift, now);
      // Clutch out (up-shift): the throttle is lifted for a moment, so the voice darkens briefly.
      engine.set(gearbox.rev, gearbox.clutch > 0 ? unit(throttle) * SHIFT_LIFT : unit(throttle), now);
      const k = screechIntensity(car, drifting);
      screechGain.gain.setTargetAtTime(k * S.level, now, S.tau);
      if (k > 0) {
        const hz = screechFrequency(car);
        bandA.frequency.setTargetAtTime(hz, now, S.tau);
        bandB.frequency.setTargetAtTime(hz, now, S.tau);
      }
    },
    setActive(next, now, cut = false) {
      if (next) {
        // Back from silence: start at idle in first gear, not at the last race's pitch / screech.
        if (stale && !on && now >= silentAt) {
          stale = false;
          gearbox = initialGearbox(preset.gearbox);
          lastAt = null;
          engine.reset(now);
          hardSet(screechGain.gain, 0, now);
        }
        bus.gain.setTargetAtTime(1, now, BUS_TAU);
      } else if (cut) {
        hardSet(bus.gain, 0, now);
        hardSet(screechGain.gain, 0, now);
        silentAt = now;
      } else if (on) {
        bus.gain.setTargetAtTime(0, now, BUS_TAU);
        // Never resume with a stale screech.
        screechGain.gain.setTargetAtTime(0, now, S.tau);
        silentAt = now + BUS_SILENT_AFTER;
      }
      on = next;
    },
    duck(at, hold) {
      const D = LOOP_DUCK;
      // Drop a pending release so back-to-back cues (a coin line) hold one dip instead of pumping.
      ducker.gain.cancelScheduledValues(at);
      ducker.gain.setTargetAtTime(D.level, at, D.attackTau);
      ducker.gain.setTargetAtTime(1, at + Math.max(0, hold), D.releaseTau);
    },
  };
}
