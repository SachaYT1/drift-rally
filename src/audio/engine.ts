/**
 * Audio graph building blocks (design spec §5 Audio): the master chain, the shared noise buffer
 * and the continuous race voices:
 * - engine: car speed -> virtual gearbox (gearbox.ts) -> engine rev -> warm petrol-engine voice
 *   (engineVoice.ts, voiced by an EnginePreset from enginePresets.ts; the game uses preset A).
 * - tyre screech: a pitched stick-slip squeal of the two rear tyres over a low grainy rubber
 *   scrub, with chirps on drift entry / flicks (screechVoice.ts, voiced by a ScreechPreset from
 *   screechPresets.ts; the game uses preset A).
 *
 * Both feed a loop bus (on/off fade) -> duck gain (dips under reward cues) -> master.
 *
 * Sources are created and started once (they cannot be restarted); everything else is driven
 * with `setTargetAtTime`, so parameter changes never click. The mapping functions are pure.
 */
import { clamp } from '../shared/math';
import type { CarState } from '../shared/types';
import { DEFAULT_ENGINE_PRESET, type EnginePreset } from './enginePresets';
import { createEngineVoice, hardSet } from './engineVoice';
import { initialGearbox, stepGearbox, type GearboxState } from './gearbox';
import { DEFAULT_SCREECH_PRESET, type ScreechPreset } from './screechPresets';
import { createScreechVoice } from './screechVoice';

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
 * `preset` voices the engine, `screechPreset` the tyres (the game uses the defaults, preset A of
 * each; the sound lab compares the others).
 */
export function createLoopVoices(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  preset: EnginePreset = DEFAULT_ENGINE_PRESET,
  screechPreset: ScreechPreset = DEFAULT_SCREECH_PRESET,
): LoopVoices {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  const ducker = ctx.createGain();
  bus.connect(ducker).connect(out);

  const engine = createEngineVoice(ctx, bus, noise, preset);
  let gearbox: GearboxState = initialGearbox(preset.gearbox);
  /** Context time of the previous update (null right after a reset). */
  let lastAt: number | null = null;

  const screech = createScreechVoice(ctx, bus, noise, screechPreset);

  /** Whether the bus is (fading) on, and the context time from which it is fully silent. */
  let on = false;
  let silentAt = 0;
  /** Params were moved by update() since the last reset to idle. */
  let stale = false;

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
      screech.update(car, unit(throttle), drifting, now);
    },
    setActive(next, now, cut = false) {
      if (next) {
        // Back from silence: start at idle in first gear, not at the last race's pitch / screech.
        if (stale && !on && now >= silentAt) {
          stale = false;
          gearbox = initialGearbox(preset.gearbox);
          lastAt = null;
          engine.reset(now);
          screech.silence(now, true);
        }
        bus.gain.setTargetAtTime(1, now, BUS_TAU);
      } else if (cut) {
        hardSet(bus.gain, 0, now);
        screech.silence(now, true);
        silentAt = now;
      } else if (on) {
        bus.gain.setTargetAtTime(0, now, BUS_TAU);
        // Never resume with a stale screech.
        screech.silence(now, false);
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
