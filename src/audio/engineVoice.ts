/**
 * The engine voice (Web Audio graph), driven by `rev` + throttle from the virtual gearbox:
 *
 *   saw(f) + triangle(f) + sub sine(f/2) -> drive -> soft tanh shaper -> firing-pulse AM (by the f/2 sub)
 *   noise -> bandpass -> pulsed at f (by the triangle) -> rumble gain ---------------------------+
 *   -> lowpass (tracks pitch, Q <= 1.2) -> fixed lowpass -> high-shelf cut -> highpass (DC/subsonic)
 *   -> shift dip -> level -> out
 *   two slow LFOs -> idle wobble (cents) -> every oscillator's detune
 *
 * Sources are created and started once; everything moves with `setTargetAtTime`, so it never clicks.
 */
import { DEFAULT_ENGINE_PRESET, engineCutoff, engineDrive, engineLevel, engineLump, enginePitch, idleWobbleCents,
  rumbleLevel, type EnginePreset } from './enginePresets';

/** The tanh shaper spans +/- SHAPER_SPAN of tanh input; the drive gain divides by it. */
const SHAPER_SPAN = 4;
const SHAPER_POINTS = 1024;
/** Idle wobble LFO rates, Hz (incommensurate, so the wobble never repeats audibly). */
const WOBBLE_HZ = [1.7, 0.43] as const;
const WOBBLE_B_MIX = 0.5;
const WOBBLE_TAU = 0.25;
/** Highpass under the voice: removes the shaper's DC and inaudible sub-bass, Hz. */
const SUBSONIC_HZ = 30;
const RUMBLE_Q = 0.7;
const TAME_Q = 0.6;
/** Down-shifts dip much less than up-shifts (the throttle stays on). */
const DOWNSHIFT_DIP_SHARE = 0.4;

export interface EngineVoice {
  /** Glide toward `rev` (fraction of the redline) and `throttle` (0..1) from context time `now`. */
  set(rev: number, throttle: number, now: number): void;
  /** Gear change at `now`: brief level dip (smaller on a down-shift). */
  shift(dir: 1 | -1, now: number): void;
  /** Jump to idle at `now`. Only while the voice is inaudible. */
  reset(now: number): void;
}

/** tanh(S x) / tanh(S) over x in [-1, 1]. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(SHAPER_POINTS);
  const norm = Math.tanh(SHAPER_SPAN);
  for (let i = 0; i < SHAPER_POINTS; i++) {
    const x = (i / (SHAPER_POINTS - 1)) * 2 - 1;
    curve[i] = Math.tanh(SHAPER_SPAN * x) / norm;
  }
  return curve;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, hz: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = hz;
  return o;
}

function gain(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q: number, db = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  f.gain.value = db;
  return f;
}

/** Cancels pending automation and jumps to `v` at `now`. Only for params that are inaudible. */
export function hardSet(p: AudioParam, v: number, now: number): void {
  p.cancelScheduledValues(now);
  p.setValueAtTime(v, now);
}

/** Builds the engine voice into `out` (starts at idle, audible at idle level) and starts its sources. */
export function createEngineVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  p: EnginePreset = DEFAULT_ENGINE_PRESET,
): EngineVoice {
  const idleRev = p.gearbox.idleRev;
  const f0 = enginePitch(idleRev, p);

  const saw = osc(ctx, 'sawtooth', f0);
  const tri = osc(ctx, 'triangle', f0);
  const sub = osc(ctx, 'sine', f0 / 2);
  const drive = gain(ctx, engineDrive(0, p) / SHAPER_SPAN);
  saw.connect(gain(ctx, p.sawMix)).connect(drive);
  tri.connect(gain(ctx, p.triMix)).connect(drive);
  sub.connect(gain(ctx, p.subMix)).connect(drive);

  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve();
  shaper.oversample = '4x';
  // Firing-pulse AM: gain = 1 + lump * sub(f/2) -> half-order sidebands, the "burble" of a real engine.
  const pulse = gain(ctx, 1);
  const lump = gain(ctx, engineLump(idleRev, p));
  sub.connect(lump).connect(pulse.gain);
  drive.connect(shaper).connect(pulse);

  const lowpass = filter(ctx, 'lowpass', engineCutoff(idleRev, 0, p), p.filterQ);
  pulse.connect(lowpass);

  // Combustion noise: band-passed noise chopped at the firing rate by the triangle (0..1 gain).
  const hiss = ctx.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  const chop = gain(ctx, 0.5);
  tri.connect(gain(ctx, 0.5)).connect(chop.gain);
  const rumble = gain(ctx, 0);
  hiss.connect(filter(ctx, 'bandpass', p.rumbleHz, RUMBLE_Q)).connect(chop).connect(rumble).connect(lowpass);

  const shift = gain(ctx, 1);
  const level = gain(ctx, engineLevel(idleRev, 0, p));
  lowpass
    .connect(filter(ctx, 'lowpass', p.tameHz, TAME_Q))
    .connect(filter(ctx, 'highshelf', p.shelfHz, 0.7, p.shelfDb))
    .connect(filter(ctx, 'highpass', SUBSONIC_HZ, 0.7))
    .connect(shift)
    .connect(level)
    .connect(out);

  // Idle wobble: two slow LFOs -> cents -> every oscillator's detune (frequency stays free for glides).
  const wobble = gain(ctx, idleWobbleCents(idleRev, 0, p));
  const lfoA = osc(ctx, 'sine', WOBBLE_HZ[0]);
  const lfoB = osc(ctx, 'sine', WOBBLE_HZ[1]);
  lfoA.connect(wobble);
  lfoB.connect(gain(ctx, WOBBLE_B_MIX)).connect(wobble);
  for (const o of [saw, tri, sub]) wobble.connect(o.detune);

  const t0 = ctx.currentTime;
  for (const s of [saw, tri, sub, lfoA, lfoB, hiss]) s.start(t0);

  function apply(rev: number, throttle: number, now: number, jump: boolean): void {
    const f = enginePitch(rev, p);
    const put = jump
      ? (param: AudioParam, v: number) => hardSet(param, v, now)
      : (param: AudioParam, v: number, tau: number) => param.setTargetAtTime(v, now, tau);
    put(saw.frequency, f, p.pitchTau);
    put(tri.frequency, f, p.pitchTau);
    put(sub.frequency, f / 2, p.pitchTau);
    put(lowpass.frequency, engineCutoff(rev, throttle, p), p.toneTau);
    put(drive.gain, engineDrive(throttle, p) / SHAPER_SPAN, p.toneTau);
    put(lump.gain, engineLump(rev, p), p.toneTau);
    put(rumble.gain, rumbleLevel(rev, throttle, p), p.toneTau);
    put(level.gain, engineLevel(rev, throttle, p), p.toneTau);
    put(wobble.gain, idleWobbleCents(rev, throttle, p), WOBBLE_TAU);
  }

  return {
    set(rev, throttle, now) {
      apply(rev, throttle, now, false);
    },
    shift(dir, now) {
      const dip = dir > 0 ? p.shiftDip : 1 - (1 - p.shiftDip) * DOWNSHIFT_DIP_SHARE;
      const t = p.gearbox.shiftTime;
      const g = shift.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(dip, now, t * 0.12);
      g.setTargetAtTime(1, now + t * 0.5, t * 0.3);
    },
    reset(now) {
      apply(idleRev, 0, now, true);
      hardSet(shift.gain, 1, now);
    },
  };
}
