/** One race: countdown -> racing -> finished. Orchestrates the pure modules. See design spec §2, §5. */
import type { CarState, Contact, GameEvent, InputFrame, RaceResult, SurfaceKind } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { createCarState, stepCar } from '../physics/car';
import { resolveCollisions } from '../physics/collision';
import type { Track } from '../track/build';
import { canAccrue, createDriftScore, updateDriftScore, type DriftScoreState } from './driftScore';
import { createPickups, resetLap, updatePickups, type PickupState } from './pickups';
import { createProgress, respawn, startGrace, updateProgress, type ProgressState } from './progress';

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface SessionState {
  phase: RacePhase;
  /** Seconds left in the countdown (phase 'countdown'). */
  countdownLeft: number;
  /** Race time since GO, s (simulation time). */
  time: number;
  laps: number;
  car: CarState;
  /** Car state before the latest step (for render interpolation). */
  prevCar: CarState;
  /**
   * Renderers must snap car and camera while this is true. It holds from creation through the whole
   * countdown (the car sits frozen at the start pose, so a loop that steps before rendering still sees
   * the start teleport), is cleared by the first racing step, and is set again only on a respawn step.
   */
  teleported: boolean;
  surface: SurfaceKind;
  progress: ProgressState;
  score: DriftScoreState;
  pickups: PickupState;
  /**
   * Per-collider seconds until it may emit another 'scrape'. Every eligible contact and every heavy hit
   * (re)starts it. Heavy hits ignore it: they always emit 'hit' (see contactEvent).
   */
  hitCooldowns: Readonly<Record<string, number>>;
  bestLap: number | null;
  result: RaceResult | null;
}

export interface Session {
  readonly track: Track;
  state(): Readonly<SessionState>;
  /** Advance one fixed step. `respawn` is an edge action. */
  step(input: InputFrame, actions: { respawn: boolean }, dt: number): GameEvent[];
}

/**
 * Seconds. Timers decremented by repeated fixed steps (1/120) land a hair above whole values;
 * without this tolerance the countdown ticks and cooldowns would expire one step late.
 */
const TIME_EPSILON = 1e-9;
/** Broad-phase margin added to the car capsule reach when querying colliders, m. */
const COLLIDER_QUERY_MARGIN = 4;

interface StepResult {
  state: SessionState;
  events: GameEvent[];
}

/** Static per-session parameters. */
interface SessionConfig {
  track: Track;
  laps: number;
  /** Initial countdown, s (detects the first countdown step). */
  countdown: number;
  t: Tuning;
}

/**
 * Create a race on `track`. `opts.bestLap` (seconds, e.g. the saved record) seeds `state.bestLap`
 * and the `best` flag of lap events: a lap is `best` only when it beats the seed (if any) and every
 * earlier lap; the first lap without a seed is never `best` (nothing to beat).
 */
export function createSession(
  track: Track,
  opts: { laps?: number; bestLap?: number | null; tuning?: Tuning } = {},
): Session {
  const t = opts.tuning ?? TUNING;
  // A non-finite lap count (NaN, Infinity) would never finish: fall back to the tuning default.
  const laps = opts.laps ?? t.race.laps;
  const cfg: SessionConfig = {
    track,
    laps: Math.max(1, Math.floor(Number.isFinite(laps) ? laps : t.race.laps)),
    countdown: Math.max(0, t.race.countdown),
    t,
  };
  const seed = opts.bestLap;
  let state = initialState(cfg, typeof seed === 'number' && Number.isFinite(seed) && seed > 0 ? seed : null);

  return {
    track,
    state: () => state,
    step(input, actions, dt) {
      // Finished races are frozen; a non-positive (or NaN) step is a pause and changes nothing.
      if (state.phase === 'finished' || !(dt > 0)) return [];
      const r = state.phase === 'countdown' ? stepCountdown(state, cfg, dt) : stepRacing(state, cfg, input, actions, dt);
      state = r.state;
      return r.events;
    },
  };
}

function initialState(cfg: SessionConfig, bestLap: number | null): SessionState {
  const { track, t } = cfg;
  const pose = track.spawnPose;
  const car = createCarState(pose.x, pose.z, pose.heading);
  const progress = createProgress(track, cfg.laps, t);
  return {
    phase: 'countdown',
    countdownLeft: cfg.countdown,
    time: 0,
    laps: cfg.laps,
    car,
    prevCar: car,
    // The race start is a teleport; the countdown keeps the flag set (see SessionState.teleported).
    teleported: true,
    surface: track.surfaceAt(progress.lateral),
    progress,
    score: createDriftScore(),
    pickups: createPickups(),
    hitCooldowns: {},
    bestLap,
    result: null,
  };
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

/** Whole seconds shown for `left` seconds remaining (ceil with tolerance). */
function countdownTick(left: number): number {
  return Math.ceil(left - TIME_EPSILON);
}

function pushCountdown(events: GameEvent[], tick: number): void {
  if (tick === 3 || tick === 2 || tick === 1 || tick === 0) events.push({ type: 'countdown', value: tick });
}

/**
 * 3 on the first step, 2 and 1 as the whole second drops, 0 at GO. The car is frozen, input ignored,
 * and `teleported` stays true (the start snap); the first racing step clears it.
 */
function stepCountdown(s: SessionState, cfg: SessionConfig, dt: number): StepResult {
  const events: GameEvent[] = [];
  const before = s.countdownLeft;
  const left = before - dt;
  const first = before === cfg.countdown;
  if (first && countdownTick(before) > 0) pushCountdown(events, countdownTick(before));

  if (left <= TIME_EPSILON) {
    pushCountdown(events, 0);
    return { state: { ...s, phase: 'racing', countdownLeft: 0, prevCar: s.car, teleported: true }, events };
  }
  if (countdownTick(left) < countdownTick(before)) pushCountdown(events, countdownTick(left));
  return { state: { ...s, countdownLeft: left, prevCar: s.car, teleported: true }, events };
}

// ---------------------------------------------------------------------------
// Racing
// ---------------------------------------------------------------------------

/**
 * One racing step: respawn -> car -> collisions -> pickups -> progress -> drift score -> finish.
 * Event order within a step follows the same sequence.
 */
function stepRacing(
  s: SessionState,
  cfg: SessionConfig,
  input: InputFrame,
  actions: { respawn: boolean },
  dt: number,
): StepResult {
  const { track, t } = cfg;
  const events: GameEvent[] = [];
  let progress = s.progress;
  let car = s.car;
  let prevCar = s.car;

  // 1. Respawn: the R action, or the backstop (out of bounds, non-finite car).
  const respawned = actions.respawn || outOfBounds(progress, track, t) || !isFiniteCar(car);
  if (respawned) {
    const r = respawn(progress, track, t);
    progress = r.state;
    car = createCarState(r.pose.x, r.pose.z, r.pose.heading);
    // Interpolation starts at the respawn pose, so even a renderer that ignores `teleported` never smears.
    prevCar = car;
    events.push({ type: 'respawn' });
  }

  // 2. Car physics on the surface under the car.
  car = stepCar(car, input, track.surfaceAt(progress.lateral), dt, t);

  // 3. Collisions: at most one hit/scrape event per step; per-collider cooldowns throttle scrapes,
  //    while a heavy hit always reports (it burns the chain and starts the wrong-way grace below).
  const reach = t.car.capsuleHalf + t.car.radius + COLLIDER_QUERY_MARGIN;
  const col = resolveCollisions(car, track.collidersNear(car.x, car.z, reach), t);
  car = col.state;
  const contact = contactEvent(col.contacts, col.heavyHit, tickCooldowns(s.hitCooldowns, dt), t);
  if (contact.event) events.push(contact.event);
  const heavyHit = col.heavyHit !== null;
  if (heavyHit) progress = startGrace(progress, t);

  // 4. Coins and light props.
  const pu = updatePickups(s.pickups, track, car, t);
  car = pu.car;
  let pickups = pu.state;
  events.push(...pu.events);

  // 5. Progress and laps. Lap times use the race time at the END of this step.
  const time = s.time + dt;
  const pr = updateProgress(progress, track, car, time, dt, cfg.laps, t);
  progress = pr.state;
  let bestLap = s.bestLap;
  for (const e of pr.events) {
    if (e.type !== 'lap') {
      events.push(e);
      continue;
    }
    // "Best" needs something to beat: the seeded record or an earlier lap of this race.
    const best = bestLap !== null && e.lapTime < bestLap;
    if (bestLap === null || e.lapTime < bestLap) bestLap = e.lapTime;
    events.push({ ...e, best });
  }
  // An item still touching the car here would re-trigger next step; track data keeps coins and light
  // props out of reach of the start line (guarded in session.test.ts).
  if (pr.lapCompleted) pickups = resetLap(pickups);
  const justFinished = progress.finished && !s.progress.finished;

  // 6. Drift score, judged on the surface under the car after this step.
  const surface = track.surfaceAt(progress.lateral);
  const accruing = canAccrue(
    { car, surface, progress: progress.p, frontier: progress.frontier, progressSpeed: progress.progressSpeed },
    t,
  );
  const ds = updateDriftScore(
    s.score,
    {
      accruing,
      slip: car.slip,
      progressSpeed: progress.progressSpeed,
      heavyHit,
      respawned,
      propsKnocked: pu.knocked,
      finished: justFinished,
    },
    dt,
    t,
  );
  // Passed through unfiltered: a chain can bank (or burn) 0 points; consumers decide what to show.
  events.push(...ds.events);

  const next: SessionState = {
    ...s,
    time,
    car,
    prevCar,
    teleported: respawned,
    surface,
    progress,
    score: ds.state,
    pickups,
    hitCooldowns: contact.cooldowns,
    bestLap,
  };

  // 7. Finish: freeze the race and report the result.
  if (!justFinished) return { state: next, events };
  const result = raceResult(next, t);
  events.push({ type: 'finish', result });
  return { state: { ...next, phase: 'finished', result }, events };
}

/** |lateral| beyond the barrier + margin (also catches a non-finite lateral). */
function outOfBounds(progress: ProgressState, track: Track, t: Tuning): boolean {
  return !(Math.abs(progress.lateral) <= track.barrier + t.progress.outOfBoundsMargin);
}

function isFiniteCar(car: CarState): boolean {
  return Object.values(car).every((v) => typeof v !== 'number' || Number.isFinite(v));
}

/** Cooldowns after `dt`; expired entries are dropped. Returns a new object. */
function tickCooldowns(cooldowns: Readonly<Record<string, number>>, dt: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [id, left] of Object.entries(cooldowns)) {
    const remaining = left - dt;
    if (remaining > TIME_EPSILON) next[id] = remaining;
  }
  return next;
}

/**
 * This step's single contact event (a multi-collider crash reports once):
 * - a heavy hit (`resolveCollisions().heavyHit`, the strongest contact) is always a 'hit', even when its
 *   collider is cooling down, because it burns the chain and starts recovery: the player must see why;
 * - otherwise the strongest contact whose collider is not cooling down is a 'scrape'.
 * Every eligible contact of the step starts its cooldown, and a heavy hit restarts its collider's.
 * Ties keep the deepest contact (contacts arrive deepest first). `cooldowns` is a fresh object (mutated).
 */
function contactEvent(
  contacts: readonly Contact[],
  heavyHit: Contact | null,
  cooldowns: Record<string, number>,
  t: Tuning,
): { event: GameEvent | null; cooldowns: Readonly<Record<string, number>> } {
  let strongest: Contact | null = null;
  for (const c of contacts) {
    if (cooldowns[c.colliderId] !== undefined) continue;
    if (!strongest || c.impactSpeed > strongest.impactSpeed) strongest = c;
    cooldowns[c.colliderId] = t.collision.cooldown;
  }
  if (heavyHit) {
    cooldowns[heavyHit.colliderId] = t.collision.cooldown;
    return { event: { type: 'hit', impactSpeed: heavyHit.impactSpeed, x: heavyHit.x, z: heavyHit.z }, cooldowns };
  }
  if (!strongest) return { event: null, cooldowns };
  return { event: { type: 'scrape', x: strongest.x, z: strongest.z }, cooldowns };
}

function raceResult(s: SessionState, t: Tuning): RaceResult {
  const totalPoints = s.score.totalPoints;
  // A copy: consumers that sort or edit the result must not reach into the frozen progress state.
  const lapTimes = [...s.progress.lapTimes];
  const coinsPicked = s.pickups.coinsPicked;
  const coinsFromDrift = Math.floor(totalPoints / t.score.pointsPerCoin);
  return {
    totalPoints,
    bestChain: s.score.bestChain,
    totalTime: s.time,
    lapTimes,
    bestLap: lapTimes.length > 0 ? Math.min(...lapTimes) : s.time,
    coinsPicked,
    coinsFromDrift,
    coinsEarned: coinsPicked + coinsFromDrift,
  };
}
