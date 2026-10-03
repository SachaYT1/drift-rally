/**
 * The ghost bots of one race run (plan/2026-10-04-ghost-bots-design.md §3.4, §4.2): steps the bot field with the
 * player's fixed steps, turns the bot sessions into ghost views (interpolated pose, opacity, label points) and
 * ranks the player among the bots. A ghost fades out over GHOST_FADE_TIME once its bot finished, and every ghost
 * does when the player finishes: the bots are then fast-forwarded to their results while the ghosts stay where
 * they were. views() reuses its objects: no per-frame allocation.
 */
import type { CarState, StandingRow } from '../shared/types';
import type { Track } from '../track/build';
import { BOTS, createBotField, livePoints, standings, type BotDef, type BotField } from '../game/bots';
import { ghostOpacity, type GhostView } from '../render/ghostCars';
import { interpolateCar } from './interpolate';

/** Seconds a finished ghost takes to fade out. */
export const GHOST_FADE_TIME = 0.5;

export interface GhostRun {
  readonly field: BotField;
  /** One fixed step of every bot (none after the player's finish). */
  step(dt: number): void;
  /** The player finished: fast-forward the bots to their results and fade every ghost out where it is. */
  finish(): void;
  /**
   * Ghost views for one render: `alpha` between the last two steps, `player` = the drawn player car. Only a bot's
   * own teleport snaps its ghost (the player's respawn does not).
   */
  views(alpha: number, player: Readonly<CarState>, dt: number): readonly GhostView[];
  /** Live standings (`player.points`: banked plus the running chain, like livePoints()). */
  standings(player: { points: number; finished: boolean }): StandingRow[];
  /** Standings after finish(): every bot's result. */
  finalStandings(playerPoints: number): StandingRow[];
}

export function createGhostRun(track: Track, roster: readonly BotDef[] = BOTS): GhostRun {
  const field = createBotField(track, roster);
  let finished = false;
  const fades = field.bots.map(() => 1);
  const out: GhostView[] = field.bots.map((b) => ({
    car: { ...b.session.state().car },
    points: 0,
    opacity: 0,
    visible: false,
    snap: true,
  }));

  return {
    field,
    step(dt) {
      if (!finished) field.step(dt);
    },
    finish() {
      if (finished) return;
      finished = true;
      // The views keep the poses last drawn: the fast-forward must not teleport the fading ghosts.
      field.fastForward();
    },
    views(alpha, player, dt) {
      for (let i = 0; i < out.length; i++) {
        const st = field.bots[i].session.state();
        const v = out[i];
        const done = st.phase === 'finished';
        if (!finished) {
          // A finished session no longer steps: draw its final pose, not a blend with the step before.
          interpolateCar(st.prevCar, st.car, done ? 1 : alpha, st.teleported, v.car);
          v.points = livePoints(st.score);
        }
        if (finished || done) fades[i] = Math.max(0, fades[i] - dt / GHOST_FADE_TIME);
        v.opacity = ghostOpacity(Math.hypot(v.car.x - player.x, v.car.z - player.z), fades[i]);
        v.visible = fades[i] > 0;
        v.snap = !finished && st.teleported;
      }
      return out;
    },
    standings(player) {
      return standings(player, field.bots, false);
    },
    finalStandings(playerPoints) {
      return standings({ points: playerPoints, finished: true }, field.bots, true);
    },
  };
}
