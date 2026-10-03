/** Pure mappings from the session state to what the race screen shows. */
import type { CarState } from '../shared/types';
import type { SessionState } from '../game/session';
import type { HudView } from '../ui/hud';

/** Seconds of race time the controls hint stays up (design spec §6: "first 6 s"). */
export const HINT_SECONDS = 6;

/** HUD numbers of `st`, written into `out` when given (the race loop reuses one object per run). */
export function hudViewOf(st: Readonly<SessionState>, out?: HudView): HudView {
  const v = out ?? ({} as HudView);
  v.lap = st.progress.lap;
  v.laps = st.laps;
  v.time = st.time;
  v.bestLap = st.bestLap;
  v.coins = st.pickups.coinsPicked;
  // The session freezes the car at the finish: it no longer moves, so the speedometer drops to 0.
  v.speed = st.phase === 'finished' ? 0 : st.car.speed;
  v.chainPoints = st.score.chainPoints;
  v.multiplier = st.score.multiplier;
  v.chainPhase = st.score.phase;
  v.totalPoints = st.score.totalPoints;
  v.wrongWay = st.progress.wrongWay;
  return v;
}

/** The controls hint shows through the countdown and the first HINT_SECONDS of racing. */
export function hintVisible(st: Readonly<SessionState>): boolean {
  return st.phase === 'countdown' || (st.phase === 'racing' && st.time < HINT_SECONDS);
}

/**
 * The car frozen by the finish, as seen by the effects: at rest and gripping, so tyre smoke and skid
 * marks stop instead of piling up on a car the session no longer moves.
 */
export function parkedCar(car: Readonly<CarState>, out: CarState = { ...car }): CarState {
  Object.assign(out, car);
  out.vx = 0;
  out.vz = 0;
  out.speed = 0;
  out.forwardSpeed = 0;
  out.lateralSpeed = 0;
  out.slip = 0;
  out.yawRate = 0;
  out.mode = 'grip';
  out.driftDir = 0;
  return out;
}
