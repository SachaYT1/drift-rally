/**
 * Shared contracts between the pure simulation (physics/, game/, track/),
 * rendering (render/), UI (ui/) and app wiring (app/).
 *
 * Coordinate convention (see design spec §5):
 * - Simulation is 2D on the ground plane (x, z), metres, car scale.
 * - `heading` h: forward = (sin h, cos h); left = (cos h, -sin h); +yaw turns LEFT.
 * - Three.js: models are built facing +Z, so `object.rotation.y = heading`.
 */

export type SurfaceKind = 'road' | 'curb' | 'runoff' | 'outside';

/** Driving intent for one physics step. Produced by core/input.ts, consumed by physics/car.ts. */
export interface InputFrame {
  /** 0..1 */
  throttle: number;
  /** 0..1. Brakes while moving forward; reverses after holding near standstill. */
  brake: number;
  /** -1..1, +1 = steer LEFT (A / ArrowLeft). */
  steer: number;
  /** Space held. */
  handbrake: boolean;
  /** Space went down since the last consumed frame. True on the FIRST physics sub-step only. */
  handbrakePressed: boolean;
}

/** Edge-triggered non-driving actions (latched, consumed once). */
export interface ActionFrame {
  pause: boolean;
  respawn: boolean;
  mute: boolean;
}

export const NEUTRAL_INPUT: Readonly<InputFrame> = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  handbrakePressed: false,
});

export type DriveMode = 'grip' | 'drift' | 'recover';

/** Full car simulation state. Treated as immutable: stepCar() returns a new object. */
export interface CarState {
  x: number;
  z: number;
  /** rad, see file header. */
  heading: number;
  /** World-space velocity, m/s. */
  vx: number;
  vz: number;
  /** rad/s, + = turning left. */
  yawRate: number;
  /** Smoothed steer, -1..1 (+ left). */
  steer: number;
  mode: DriveMode;
  /** +1 = drifting through a left turn, -1 = right turn, 0 = not drifting. */
  driftDir: -1 | 0 | 1;
  /** Seconds spent in the current drift. */
  driftTime: number;
  /** 0..1 lateral-grip blend after leaving a drift (1 = full normal grip). */
  gripBlend: number;
  /** Mode-specific timer (drift exit delay / recovery remaining), seconds. */
  modeTimer: number;
  /** Seconds brake has been held near standstill (reverse engages after tuning.car.reverseDelay). */
  reverseHold: number;
  /** Accumulated wheel rolling angle, rad (visual only). */
  wheelSpin: number;

  // ---- Physics-only memory (physics/), never read elsewhere. createCarState() sets 0; absent = 0, so ----
  // ---- states built outside the simulation (tests, fixtures) stay valid without them.                 ----
  /** Seconds a recent Space press stays armed for a flick (tuning.drift.flickWindow), counting down. */
  flickArm?: number;
  /**
   * Seconds full counter-steer (input AND wheel: steer * driftDir <= -tuning.drift.catchSteer, Space released)
   * has been held in the current drift; at tuning.drift.catchTime the car catches the slide and the drift ends.
   */
  catchTimer?: number;
  /**
   * Seconds left of the drift-exit phase (grip mode): the body swings to the velocity heading while the
   * direction of travel is kept. Set to tuning.drift.exitAlignTime by every drift exit, counting down.
   */
  exitAlign?: number;
  /**
   * Signed path curvature of the last step, 1/m (+ = turning left): the velocity-heading change per metre
   * travelled, from the step's integration alone (collision responses not included). A kick or flick starts
   * from it.
   */
  pathCurv?: number;
  /**
   * Signed path curvature (1/m, + = left) the car had at the drift's last entry: the kick, or the last flick
   * (kept within +-tuning.drift.curvInto * handbrakeCurvBoost); 0 outside drift mode. The drift path
   * curvature blends from it to the drift target over tuning.drift.entryBlendTime (kick) or flickBlendTime.
   */
  entryCurv?: number;
  /** driftTime at the drift's last entry: 0 for the kick, the drift's age at the last flick; 0 outside drift. */
  entryAt?: number;
  /**
   * The kick holds the line: path curvature (1/m, relative to driftDir) by which the neutral drift arc starts
   * off curvNeutral, from the path the car had in grip (kept within [0, curvInto]); it eases out
   * over tuning.drift.entryHoldTime. 0 after a flick and outside drift mode.
   */
  lineOffset?: number;
  /**
   * Steer (0..1 toward driftDir) held through the drift's last kick or flick. It only picked the side, so it
   * does not count as into-steer; it follows the steer input down (never back up), so letting go clears it
   * and a fresh press tightens the drift. 0 outside drift mode.
   */
  intoLatch?: number;

  // ---- Derived values, recomputed at the end of every step ----
  /** |v|, m/s */
  speed: number;
  /** v · forward (negative when reversing), m/s */
  forwardSpeed: number;
  /** v · left, m/s */
  lateralSpeed: number;
  /** Body heading minus velocity heading, wrapped to (-pi, pi]; 0 when speed < 1 m/s. + = nose left of motion. */
  slip: number;
  /** 0..1 normalised engine rpm (audio/visual). */
  rpm: number;
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

export type Collider =
  | { kind: 'circle'; id: string; x: number; z: number; r: number }
  | { kind: 'capsule'; id: string; ax: number; az: number; bx: number; bz: number; r: number }
  /** One-sided wall segment. (nx, nz) is the unit normal pointing TOWARD the drivable track. */
  | { kind: 'wall'; id: string; ax: number; az: number; bx: number; bz: number; nx: number; nz: number };

export interface Contact {
  colliderId: string;
  /** Normal approach speed before resolution, m/s (>= 0). */
  impactSpeed: number;
  /** Contact point (world). */
  x: number;
  z: number;
  /** Unit normal pushing the car out. */
  nx: number;
  nz: number;
}

export interface CollisionResult {
  state: CarState;
  /** At most one contact per collider, deepest first. */
  contacts: Contact[];
  /** Strongest contact whose impactSpeed >= tuning.collision.heavyImpact, else null. */
  heavyHit: Contact | null;
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

export interface TrackSample {
  /** Arc length from the curve start, m. */
  s: number;
  x: number;
  z: number;
  /** Unit tangent (driving direction). */
  tx: number;
  tz: number;
  /** Signed curvature, 1/m (+ = turning left). */
  curvature: number;
}

export interface TrackProjection {
  /** Arc length of the closest centreline point, wrapped to [0, length). */
  s: number;
  /** Signed distance from the centreline, m (+ = left of driving direction). */
  lateral: number;
  /** Index of the closest sample. */
  index: number;
}

export interface Pose {
  x: number;
  z: number;
  heading: number;
}

export interface CoinSpot {
  id: number;
  x: number;
  z: number;
}

export interface LightPropSpot {
  id: string;
  kind: 'can' | 'cup';
  x: number;
  z: number;
  /** Collision/trigger radius, m. */
  r: number;
  heading: number;
}

export interface BombSpot {
  id: string;
  x: number;
  z: number;
  /** Trigger radius, m (tuning.bomb.radius). */
  r: number;
}

// ---------------------------------------------------------------------------
// Game events (returned from session.step; consumed by HUD, audio, fx)
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: 'countdown'; value: 3 | 2 | 1 | 0 }
  | { type: 'coin'; id: number; x: number; z: number }
  | { type: 'propKnocked'; id: string; kind: 'can' | 'cup'; x: number; z: number; vx: number; vz: number }
  | { type: 'bomb'; id: string; x: number; z: number }
  | { type: 'hit'; impactSpeed: number; x: number; z: number }
  | { type: 'scrape'; x: number; z: number }
  | { type: 'chainStart' }
  | { type: 'multiplier'; value: number }
  | { type: 'chainBanked'; points: number }
  | { type: 'chainBurned'; points: number }
  | { type: 'penalty'; points: number }
  | { type: 'lap'; lap: number; lapTime: number; best: boolean }
  | { type: 'wrongWay'; active: boolean }
  | { type: 'respawn' }
  | { type: 'finish'; result: RaceResult };

export interface RaceResult {
  totalPoints: number;
  bestChain: number;
  /** Seconds. */
  totalTime: number;
  /** Seconds per lap. */
  lapTimes: number[];
  bestLap: number;
  coinsPicked: number;
  coinsFromDrift: number;
  coinsEarned: number;
}

// ---------------------------------------------------------------------------
// Ghost bots (game/bots.ts -> HUD, results)
// ---------------------------------------------------------------------------

export type BotId = 'rookie' | 'pro' | 'master';

/** One row of the player-vs-bots standings. */
export interface StandingRow {
  id: BotId | 'player';
  name: string;
  /** Bot colour (sRGB hex); null for the player. */
  color: number | null;
  /** Whole points, rounded like the HUD shows them. */
  points: number;
  finished: boolean;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type QualityLevel = 'low' | 'medium' | 'high';

export interface SaveData {
  version: 1;
  coins: number;
  bestScore: number;
  /** Milliseconds, null if never finished. */
  bestLapMs: number | null;
  /** null = auto-detect. */
  quality: QualityLevel | null;
  muted: boolean;
  /** Race the ghost bots (plan/2026-10-04-ghost-bots-design.md). Absent in older saves: on. */
  ghosts: boolean;
}
