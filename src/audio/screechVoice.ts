/**
 * The tyre screech voice (Web Audio graph), driven by the car state through the pure curves in
 * screechPresets.ts. Rubber, not wind: a pitched stick-slip squeal over a low grainy scrub.
 *
 *   per rear tyre: osc(pitch, detune) <- jitter: band-limited random -> cents -> detune
 *                  -> mix -> chatter gain (1 + depth * band-limited random)
 *   both tyres -> formant bandpass (tracks the pitch) -> 2 gentle lowpasses -> squeal level -> out
 *                                                                           -> chirp level  -> out
 *   noise -> bandpass (300-900 Hz) -> highpass + lowpass -> grain AM (random Hann grains) -> scrub level -> out
 *
 * Chirps (drift entry, flick) blip the oscillators' detune and a parallel chirp gain. Sources are
 * created and started once; everything moves with `setTargetAtTime`, so nothing clicks. The
 * modulators are periodic buffers, so their loop points never step.
 */
import type { CarState } from '../shared/types';
import { hardSet } from './engineVoice';
import {
  chirpKind,
  chirpLevel,
  DEFAULT_SCREECH_PRESET,
  envelopeTau,
  screechMix,
  scrubGrainRate,
  squealPitch,
  type ScreechPreset,
  type SlideMemo,
} from './screechPresets';

/** Modulator buffers' sample rate, Hz (in the 8-96 kHz range every browser must support; content < 100 Hz). */
const MOD_RATE = 11025;
/** Band limit of the smooth random modulator at playback rate 1, Hz (control points at twice this rate). */
const MOD_BAND_HZ = 30;
const SMOOTH_SECONDS = 3.1;
/** Grain train: grains per second at playback rate 1, and its length, s. */
const GRAIN_BASE_HZ = 30;
const GRAIN_SECONDS = 2.3;
/** Grain-rate glide, s. */
const GRAIN_TAU = 0.1;
/** Chirp rise time constant, s. */
const CHIRP_RISE_TAU = 0.005;
/** Minimum time between two chirps, s (a burst of direction flips stays one chirp). */
const CHIRP_GAP = 0.2;
/** Q of the lowpass caps and the scrub's highpass (no resonant peak). */
const CAP_Q = 0.7;
/** The scrub stays out of the engine's range: highpass, Hz. */
const SCRUB_LOW_HZ = 250;

export interface ScreechVoice {
  /** Glide toward the car state; chirps on drift entry and on a flick. `now` = context time. */
  update(car: CarState, throttle: number, drifting: boolean, now: number): void;
  /**
   * Silence the screech and forget the slide history (no chirp on the next first update).
   * `cut`: jump instead of gliding; only when the output is already inaudible.
   */
  silence(now: number, cut: boolean): void;
}

function gain(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

/**
 * Band-limited random in [-1, 1] that loops seamlessly: periodic Catmull-Rom through random control
 * points at 2 * MOD_BAND_HZ, zero mean, peak-normalised.
 */
export function smoothNoiseBuffer(ctx: BaseAudioContext, seconds = SMOOTH_SECONDS): AudioBuffer {
  const len = Math.max(8, Math.round(seconds * MOD_RATE));
  const n = Math.max(4, Math.round(seconds * 2 * MOD_BAND_HZ));
  const pts = Array.from({ length: n }, () => Math.random() * 2 - 1);
  const buffer = ctx.createBuffer(1, len, MOD_RATE);
  const d = buffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const u = (i * n) / len;
    const j = Math.floor(u);
    const t = u - j;
    const p0 = pts[(j - 1 + n) % n], p1 = pts[j % n], p2 = pts[(j + 1) % n], p3 = pts[(j + 2) % n];
    d[i] = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * (p1 - p2) + p3 - p0) * t * t * t);
    sum += d[i];
  }
  const mean = sum / len;
  let peak = 1e-9;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i] - mean));
  for (let i = 0; i < len; i++) d[i] = (d[i] - mean) / peak;
  return buffer;
}

/**
 * A seamless train of random Hann grains (random spacing, width and height) at ~GRAIN_BASE_HZ, mean 1,
 * never negative: the granular amplitude pattern of rubber dragged over asphalt.
 */
export function grainBuffer(ctx: BaseAudioContext, seconds = GRAIN_SECONDS): AudioBuffer {
  const len = Math.max(8, Math.round(seconds * MOD_RATE));
  const period = MOD_RATE / GRAIN_BASE_HZ;
  const buffer = ctx.createBuffer(1, len, MOD_RATE);
  const d = buffer.getChannelData(0);
  for (let at = 0; at < len; at += Math.max(1, Math.round(period * (0.5 + Math.random())))) {
    const width = Math.max(2, Math.round(period * (0.8 + 0.6 * Math.random())));
    const amp = 0.3 + 0.7 * Math.random();
    for (let k = 0; k < width; k++) d[(at + k) % len] += amp * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / width));
  }
  let sum = 0;
  for (let i = 0; i < len; i++) sum += d[i];
  const mean = sum / len || 1;
  for (let i = 0; i < len; i++) d[i] /= mean;
  return buffer;
}

/** Builds the screech into `out` (silent) and starts its sources. */
export function createScreechVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  p: ScreechPreset = DEFAULT_SCREECH_PRESET,
): ScreechVoice {
  const smooth = smoothNoiseBuffer(ctx);
  const grains = grainBuffer(ctx);
  const sources: AudioBufferSourceNode[] = [];
  const loop = (buffer: AudioBuffer, rate: number): AudioBufferSourceNode => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    sources.push(s);
    return s;
  };

  // Squeal: two jittered, chattering tyres -> formant -> caps -> squeal level (+ chirp level).
  const formant = filter(ctx, 'bandpass', p.baseHz * p.formantRatio, p.formantQ);
  const oscs = p.waves.map((type, i) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = p.baseHz;
    o.detune.value = p.detuneCents[i];
    loop(smooth, p.jitterHz / MOD_BAND_HZ).connect(gain(ctx, p.jitterCents)).connect(o.detune);
    const chatter = gain(ctx, 1);
    loop(smooth, p.chatterHz / MOD_BAND_HZ).connect(gain(ctx, p.chatter)).connect(chatter.gain);
    o.connect(gain(ctx, p.tyreMix[i])).connect(chatter).connect(formant);
    return o;
  });
  const squeal = gain(ctx, 0);
  const chirp = gain(ctx, 0);
  const capped = formant.connect(filter(ctx, 'lowpass', p.capHz, CAP_Q)).connect(filter(ctx, 'lowpass', p.capHz, CAP_Q));
  capped.connect(squeal).connect(out);
  capped.connect(chirp).connect(out);

  // Scrub: low band of noise, chopped into grains whose rate follows the slide speed.
  const hiss = ctx.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  const grainAm = gain(ctx, 1 - p.grain);
  const grainSrc = loop(grains, p.grainHz[0] / GRAIN_BASE_HZ);
  grainSrc.connect(gain(ctx, p.grain)).connect(grainAm.gain);
  const scrub = gain(ctx, 0);
  hiss
    .connect(filter(ctx, 'bandpass', p.scrubHz, p.scrubQ))
    .connect(filter(ctx, 'highpass', SCRUB_LOW_HZ, CAP_Q))
    .connect(filter(ctx, 'lowpass', p.scrubCutHz, CAP_Q))
    .connect(grainAm)
    .connect(scrub)
    .connect(out);

  const t0 = ctx.currentTime;
  for (const o of oscs) o.start(t0);
  // Random read offsets decorrelate the modulators (they share two buffers) and the engine's noise.
  for (const s of [...sources, hiss]) s.start(t0, Math.random() * (s.buffer?.duration ?? 0));

  /** Slide state at the previous update (null after silence), last level targets, last chirp time. */
  let memo: SlideMemo | null = null;
  let squealNow = 0;
  let scrubNow = 0;
  let lastChirp = -Infinity;

  function chirpAt(now: number, level: number): void {
    if (!(level > 0)) return;
    oscs.forEach((o, i) => {
      const d = o.detune;
      d.cancelScheduledValues(now);
      d.setTargetAtTime(p.detuneCents[i] + p.chirpCents, now, CHIRP_RISE_TAU);
      d.setTargetAtTime(p.detuneCents[i], now + p.chirpTime, p.chirpTau);
    });
    const g = chirp.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(level * p.squealLevel, now, CHIRP_RISE_TAU);
    g.setTargetAtTime(0, now + p.chirpTime, p.chirpTau);
  }

  return {
    update(car, throttle, drifting, now) {
      const mix = screechMix(car, drifting, p);
      squeal.gain.setTargetAtTime(mix.squeal * p.squealLevel, now, envelopeTau(squealNow, mix.squeal, p));
      scrub.gain.setTargetAtTime(mix.scrub * p.scrubLevel, now, envelopeTau(scrubNow, mix.scrub, p));
      const f = squealPitch(car, throttle, p);
      for (const o of oscs) o.frequency.setTargetAtTime(f, now, p.pitchTau);
      formant.frequency.setTargetAtTime(f * p.formantRatio, now, p.pitchTau);
      grainSrc.playbackRate.setTargetAtTime(scrubGrainRate(car, p) / GRAIN_BASE_HZ, now, GRAIN_TAU);

      const next: SlideMemo = { drifting, driftDir: car.driftDir };
      const kind = chirpKind(memo, next);
      if (kind && now - lastChirp >= CHIRP_GAP) {
        lastChirp = now;
        chirpAt(now, chirpLevel(car, p, squealNow));
      }
      memo = next;
      squealNow = mix.squeal;
      scrubNow = mix.scrub;
    },
    silence(now, cut) {
      memo = null;
      squealNow = 0;
      scrubNow = 0;
      if (cut) {
        for (const g of [squeal.gain, chirp.gain, scrub.gain]) hardSet(g, 0, now);
        oscs.forEach((o, i) => hardSet(o.detune, p.detuneCents[i], now));
        return;
      }
      chirp.gain.cancelScheduledValues(now);
      for (const g of [squeal.gain, chirp.gain, scrub.gain]) g.setTargetAtTime(0, now, p.releaseTau);
    },
  };
}
