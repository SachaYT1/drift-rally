/** Test scaffolding shared by the session test files (not game code). */
import type { Session } from './session';
import type { Track } from '../track/build';
import { createAutopilot } from './autopilot';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type GameEvent, type InputFrame } from '../shared/types';

/** One fixed simulation step, s. */
export const DT = 1 / TUNING.race.physicsHz;

export const FULL_THROTTLE: InputFrame = { ...NEUTRAL_INPUT, throttle: 1 };

/** Steps `seconds` of fixed steps, feeding `input(sess)` each step; returns every event. */
export function runFor(sess: Session, seconds: number, input: (s: Session) => InputFrame): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) events.push(...sess.step(input(sess), { respawn: false }, DT));
  return events;
}

/**
 * The drift-aware autopilot (src/game/autopilot.ts: the ghost bots, also behind the ?test hook) as a session driver,
 * so the session tests race the same driver the e2e smoke test and FPS runs use.
 */
export function autopilotFor(track: Track): (sess: Session) => InputFrame {
  const drive = createAutopilot(track);
  return (sess) => drive(sess.state());
}
