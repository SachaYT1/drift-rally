/**
 * Synthesized Web Audio for Drift Rally (design spec §5 Audio).
 *
 * Graph: [engine + screech loop bus (engine.ts)] + [one-shot SFX]
 *        -> master gain -> DynamicsCompressor -> destination.
 * Reward cues (coin, chain banked) briefly duck the loop bus so they cut through a drift.
 *
 * The AudioContext is created on the first `unlock()` (call it from a user gesture). Every method
 * is a safe no-op when Web Audio is missing (node, old browsers) or the context cannot be created.
 * Continuous params move with `setTargetAtTime`; one-shots use attack/hold/exponential-release
 * envelopes that start and end at silence, so nothing clicks.
 */
import { clamp } from '../shared/math';
import { TUNING } from '../shared/tuning';
import type { CarState, GameEvent } from '../shared/types';
import { buildMasterChain, createLoopVoices, createNoiseBuffer, type LoopVoices } from './engine';

export interface GameAudio {
  /** Create/resume the AudioContext; call from a user gesture. */
  unlock(): Promise<void>;
  setMuted(m: boolean): void;
  /** Fade out and suspend the context (pause, blur, hidden tab). */
  suspend(): void;
  resume(): void;
  /** Engine pitch from car.rpm & throttle; screech gain from drift intensity (|slip|, speed). Uses setTargetAtTime. */
  update(car: CarState, throttle: number, drifting: boolean, dt: number): void;
  onEvent(e: GameEvent): void; // coin, hit, scrape, chainBanked, chainBurned, countdown, lap, finish, penalty
  /**
   * Silence engine/screech (garage, results). They start INACTIVE: the race screen must call
   * `setEngineActive(true)` (e.g. at countdown start) to hear the engine.
   */
  setEngineActive(on: boolean): void;
}

/** Returns a new AudioContext, or null when Web Audio is unavailable. May throw. */
export type AudioContextFactory = () => AudioContext | null;

/** Master gain when unmuted. */
export const MASTER_LEVEL = 0.8;
/** Soft cap on simultaneously playing one-shot sources. */
export const MAX_VOICES = 48;

/** Master fade time constant (mute, pause), s. */
const FADE_TAU = 0.02;
/** Delay before suspending, so the pause fade (6 x FADE_TAU) completes first. */
const SUSPEND_DELAY_MS = 120;
/** Minimum interval between loop-param updates (caps automation events on high-Hz displays), s. */
const PARAM_INTERVAL = 1 / 90;
/** One-shots start slightly in the future so their attack ramps are never truncated, s. */
const LOOKAHEAD = 0.01;
const NOISE_SECONDS = 2;
/** Envelope floor for exponential releases (-80 dB). */
const SILENT = 0.0001;
const ATTACK = 0.004;
/** Sources stop this long after their envelope reaches SILENT, s. */
const TAIL = 0.03;

const NOTE = {
  C5: 523.25, E5: 659.26, G5: 783.99, B5: 987.77,
  C6: 1046.5, E6: 1318.51, G6: 1567.98, C7: 2093.0,
} as const;
const BANK_NOTES = [NOTE.C6, NOTE.E6, NOTE.G6, NOTE.C7] as const;
const LAP_NOTES = [NOTE.G5, NOTE.C6] as const;
const BEST_LAP_NOTES = [NOTE.G5, NOTE.C6, NOTE.E6, NOTE.G6] as const;
const FINISH_NOTES = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6] as const;
const BURN_DETUNE_CENTS = [0, 28] as const;
/** How long each reward cue keeps the engine/screech ducked, s. */
const DUCK_HOLD: Partial<Record<GameEvent['type'], number>> = { coin: 0.12, chainBanked: 0.26 };

const noop = (): void => {};

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function defaultContextFactory(): AudioContext | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
}

/** 0 -> peak (linear attack) -> hold -> exponential release to SILENT. Returns the end time. */
function envelope(g: AudioParam, at: number, peak: number, attack: number, hold: number, release: number): number {
  g.setValueAtTime(0, at);
  g.linearRampToValueAtTime(peak, at + attack);
  if (hold > 0) g.setValueAtTime(peak, at + attack + hold);
  const end = at + attack + hold + release;
  g.exponentialRampToValueAtTime(SILENT, end);
  return end;
}

interface ToneSpec {
  type: OscillatorType;
  hz: number;
  /** Exponential pitch glide target. */
  toHz?: number;
  /** Glide duration, s (default: the whole sound). */
  glide?: number;
  peak: number;
  attack?: number;
  hold?: number;
  release: number;
}

interface NoiseSpec {
  filter: BiquadFilterType;
  hz: number;
  /** Exponential filter sweep target, reached at the end of the release. */
  toHz?: number;
  q: number;
  peak: number;
  attack?: number;
  hold?: number;
  release: number;
}

export interface SfxPlayer {
  /**
   * Schedule the sound for `e` at context time `at`. Returns false when nothing was scheduled
   * (events without a sound, voice cap reached).
   */
  play(e: GameEvent, at: number): boolean;
}

/** One-shot synthesizer writing into `out`. Exported separately for offline rendering checks. */
export function createSfxPlayer(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
): SfxPlayer {
  let active = 0;

  /** Schedules the stop and frees the voice (and its node chain) when it ends. */
  function track(src: AudioScheduledSourceNode, tail: AudioNode, end: number): void {
    active++;
    src.onended = () => {
      active--;
      src.disconnect();
      tail.disconnect();
    };
    src.stop(end + TAIL);
  }

  function tone(s: ToneSpec, at: number): void {
    const osc = ctx.createOscillator();
    osc.type = s.type;
    osc.frequency.setValueAtTime(s.hz, at);
    const g = ctx.createGain();
    const end = envelope(g.gain, at, s.peak, s.attack ?? ATTACK, s.hold ?? 0, s.release);
    if (s.toHz !== undefined) osc.frequency.exponentialRampToValueAtTime(s.toHz, at + (s.glide ?? end - at));
    osc.connect(g).connect(out);
    osc.start(at);
    track(osc, g, end);
  }

  function hiss(s: NoiseSpec, at: number): void {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = s.filter;
    filter.Q.value = s.q;
    filter.frequency.setValueAtTime(s.hz, at);
    const g = ctx.createGain();
    const end = envelope(g.gain, at, s.peak, s.attack ?? ATTACK, s.hold ?? 0, s.release);
    if (s.toHz !== undefined) filter.frequency.exponentialRampToValueAtTime(s.toHz, end);
    src.connect(filter).connect(g).connect(out);
    // Random read offset so repeated bursts do not sound identical.
    const span = Math.max(0, noise.duration - (end - at) - 2 * TAIL);
    src.start(at, Math.random() * span);
    track(src, g, end);
  }

  function arpeggio(notes: readonly number[], at: number, gap: number, type: OscillatorType, peak: number, lastRelease: number): void {
    for (let i = 0; i < notes.length; i++) {
      const last = i === notes.length - 1;
      tone({ type, hz: notes[i], peak, hold: last ? 0.1 : 0.03, release: last ? lastRelease : 0.12 }, at + i * gap);
    }
  }

  function countdown(value: number, at: number): void {
    if (value > 0) {
      tone({ type: 'square', hz: NOTE.E5, peak: 0.11, hold: 0.11, release: 0.08 }, at);
      return;
    }
    // GO: an octave up, longer, with a soft triangle underneath.
    tone({ type: 'square', hz: NOTE.E6, peak: 0.08, hold: 0.28, release: 0.3 }, at);
    tone({ type: 'triangle', hz: NOTE.E5, peak: 0.16, hold: 0.28, release: 0.3 }, at);
  }

  function coin(at: number): void {
    tone({ type: 'square', hz: NOTE.B5, peak: 0.15, attack: 0.002, hold: 0.045, release: 0.03 }, at);
    tone({ type: 'square', hz: NOTE.E6, peak: 0.15, attack: 0.002, hold: 0.05, release: 0.22 }, at + 0.07);
  }

  /** Plastic toy body thump (pitch-dropping triangle) + crunchy band-passed noise, scaled by impact. */
  function hit(impactSpeed: number, at: number): void {
    const ref = TUNING.collision.heavyImpact * 3;
    const k = Number.isFinite(impactSpeed) ? clamp(impactSpeed / ref, 0.35, 1) : 0.35;
    tone({ type: 'triangle', hz: 190, toHz: 55, glide: 0.16, peak: 0.45 * k, attack: 0.003, hold: 0.015, release: 0.22 }, at);
    hiss({ filter: 'bandpass', hz: 1400, toHz: 400, q: 0.9, peak: 0.55 * k, attack: 0.002, hold: 0.012, release: 0.12 }, at);
  }

  function scrape(at: number): void {
    hiss({ filter: 'bandpass', hz: 800 + 400 * Math.random(), q: 1.4, peak: 0.55, attack: 0.012, hold: 0.05, release: 0.12 }, at);
  }

  /** Deflating "bwaaow": two detuned saws gliding down through a closing lowpass. */
  function burned(at: number): void {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 3;
    filter.frequency.setValueAtTime(2400, at);
    const g = ctx.createGain();
    const end = envelope(g.gain, at, 0.12, 0.01, 0.06, 0.45);
    filter.frequency.exponentialRampToValueAtTime(260, end);
    filter.connect(g).connect(out);
    for (const cents of BURN_DETUNE_CENTS) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = cents;
      osc.frequency.setValueAtTime(392, at);
      osc.frequency.exponentialRampToValueAtTime(98, end);
      osc.connect(filter);
      osc.start(at);
      track(osc, g, end);
    }
  }

  /** Knocked can/cup: metallic tink (inharmonic partials) + a short descending "nope". */
  function penalty(at: number): void {
    tone({ type: 'sine', hz: 1900, peak: 0.13, attack: 0.002, release: 0.25 }, at);
    tone({ type: 'sine', hz: 2870, peak: 0.08, attack: 0.002, release: 0.16 }, at);
    tone({ type: 'square', hz: 466, toHz: 233, peak: 0.06, attack: 0.005, hold: 0.04, release: 0.14 }, at + 0.06);
  }

  function finish(at: number): void {
    arpeggio(FINISH_NOTES, at, 0.12, 'square', 0.06, 0.9);
    const chordAt = at + 0.12 * (FINISH_NOTES.length - 1);
    tone({ type: 'triangle', hz: NOTE.E5, peak: 0.12, hold: 0.1, release: 0.9 }, chordAt);
    tone({ type: 'triangle', hz: NOTE.G5, peak: 0.12, hold: 0.1, release: 0.9 }, chordAt);
  }

  return {
    play(e, at) {
      if (active >= MAX_VOICES) return false;
      switch (e.type) {
        case 'countdown': countdown(e.value, at); return true;
        case 'coin': coin(at); return true;
        case 'hit': hit(e.impactSpeed, at); return true;
        case 'scrape': scrape(at); return true;
        case 'chainBanked':
          if (e.points <= 0) return false; // nothing earned: no reward cue
          arpeggio(BANK_NOTES, at, 0.055, 'square', 0.12, 0.28);
          return true;
        case 'chainBurned': burned(at); return true;
        case 'penalty': penalty(at); return true;
        case 'lap':
          // The final lap is announced by the finish fanfare (same step).
          if (e.lap >= TUNING.race.laps) return false;
          arpeggio(e.best ? BEST_LAP_NOTES : LAP_NOTES, at, 0.085, 'triangle', 0.2, 0.35);
          return true;
        case 'finish': finish(at); return true;
        default:
          // chainStart, multiplier (not in the SFX list; the HUD shows it), propKnocked (penalty
          // covers it), wrongWay, respawn: HUD/fx only.
          return false;
      }
    },
  };
}

/** Creates the game audio. The context is built lazily on the first `unlock()`. */
export function createAudio(factory: AudioContextFactory = defaultContextFactory): GameAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let loops: LoopVoices | null = null;
  let player: SfxPlayer | null = null;
  let tried = false;
  let muted = false;
  let paused = false;
  let engineOn = false;
  let sinceParams = Infinity;
  let suspendTimer: ReturnType<typeof setTimeout> | undefined;

  const masterTarget = (): number => (muted || paused ? 0 : MASTER_LEVEL);

  /** The context if sounds may be scheduled right now, else null. */
  function live(): AudioContext | null {
    return ctx !== null && !paused && ctx.state === 'running' ? ctx : null;
  }

  function fadeMaster(): void {
    if (ctx && master) master.gain.setTargetAtTime(masterTarget(), ctx.currentTime, FADE_TAU);
  }

  /** Audio must never break the game: any Web Audio error turns audio off for the session. */
  function disable(err: unknown): void {
    console.warn('[audio] Web Audio failed, running silent:', err);
    const c = ctx;
    ctx = null;
    master = null;
    loops = null;
    player = null;
    clearTimeout(suspendTimer);
    if (c && c.state !== 'closed') c.close().catch(noop);
  }

  function init(): void {
    tried = true;
    try {
      ctx = factory();
      if (!ctx) return;
      master = buildMasterChain(ctx, masterTarget());
      const noise = createNoiseBuffer(ctx, NOISE_SECONDS);
      loops = createLoopVoices(ctx, master, noise);
      player = createSfxPlayer(ctx, master, noise);
      if (engineOn) loops.setActive(true, ctx.currentTime);
    } catch (err) {
      disable(err);
    }
  }

  return {
    unlock() {
      paused = false;
      clearTimeout(suspendTimer);
      if (!tried) init();
      if (!ctx) return Promise.resolve();
      fadeMaster();
      sinceParams = Infinity;
      // resume() is called synchronously so it still counts as inside the user gesture.
      return ctx.resume().catch(noop);
    },
    setMuted(m) {
      muted = m;
      fadeMaster();
    },
    suspend() {
      paused = true;
      if (!ctx || ctx.state === 'closed') return;
      fadeMaster();
      clearTimeout(suspendTimer);
      const c = ctx;
      suspendTimer = setTimeout(() => {
        if (paused) c.suspend().catch(noop);
      }, SUSPEND_DELAY_MS);
    },
    resume() {
      paused = false;
      clearTimeout(suspendTimer);
      if (!ctx || ctx.state === 'closed') return;
      ctx.resume().catch(noop);
      fadeMaster();
      sinceParams = Infinity;
    },
    update(car, throttle, drifting, dt) {
      const c = live();
      if (!c || !loops || !engineOn) return;
      sinceParams += dt > 0 ? dt : 0;
      if (sinceParams < PARAM_INTERVAL) return;
      sinceParams = 0;
      try {
        loops.update(car, throttle, drifting, c.currentTime);
      } catch (err) {
        disable(err);
      }
    },
    onEvent(e) {
      const c = live();
      if (!c || !player || muted) return;
      try {
        const at = c.currentTime + LOOKAHEAD;
        const hold = DUCK_HOLD[e.type];
        if (player.play(e, at) && hold !== undefined && engineOn && loops) loops.duck(at, hold);
      } catch (err) {
        disable(err);
      }
    },
    setEngineActive(on) {
      engineOn = on;
      sinceParams = Infinity;
      // Paused / suspended: the output is already silent and the clock may be frozen, so cut.
      if (loops && ctx) loops.setActive(on, ctx.currentTime, paused || ctx.state !== 'running');
    },
  };
}
