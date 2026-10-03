/**
 * Ghost bots (plan/2026-10-04-ghost-bots-design.md): three autopilot drivers of fixed skill that race the player
 * on drift points. Each bot is its own Session, so it scores, laps and finishes under exactly the player's rules;
 * bots never interact with the player. Pure: no three.js, no DOM.
 */
import { TUNING, type Tuning } from '../shared/tuning';
import type { BotId, InputFrame, StandingRow } from '../shared/types';
import type { Track } from '../track/build';
import { AUTOPILOT, createAutopilot, type AutopilotStyle } from './autopilot';
import { createSession, type Session, type SessionState } from './session';
import type { DriftScoreState } from './driftScore';

export interface BotDef {
  id: BotId;
  /** Shown in the HUD, the ghost label and the results (Russian). */
  name: string;
  /** Ghost paint and label colour, sRGB hex. */
  color: number;
  /** Autopilot constants overridden for this level (the rest are AUTOPILOT's). */
  style: Partial<AutopilotStyle>;
}

/**
 * The levels, weakest first. Target scores over 3 laps of «Площадь» (spec §2.1, pinned by bots.test.ts):
 * rookie 20 000-30 000 (24 777 on 2026-10-04: slower, short drifts that never link into a chain), pro
 * 45 000-55 000 (51 365: the reference autopilot), master >= 85 000 (93 071: one chain from the first kick to
 * the finish at the top multiplier).
 */
export const BOTS: readonly BotDef[] = Object.freeze([
  { id: 'rookie', name: 'Новичок', color: 0x3fd6a0, style: { throttleCap: 0.85, latShare: 0.75, linkDrifts: 0, maxDriftTime: 6.5 } },
  { id: 'pro', name: 'Профи', color: 0x4c8dff, style: {} },
  { id: 'master', name: 'Мастер', color: 0xb070ff, style: { keepChain: 1, catchMargin: 0.04 } },
]);

/** Name of the player's row in the standings. */
export const PLAYER_NAME = 'Ты';
/** Race time, s, after which fastForward() gives up on a bot that has not finished (a safety net). */
export const BOT_TIME_CAP = 600;

export interface BotRun {
  readonly def: BotDef;
  readonly session: Session;
}

export interface BotField {
  /** In roster order. */
  readonly bots: readonly BotRun[];
  /** One fixed step for every bot still racing; bot events are dropped (bots are silent). */
  step(dt: number): void;
  /** Step every unfinished bot until it finishes or its race time reaches `capSeconds`. */
  fastForward(capSeconds?: number): void;
}

/** The autopilot of one level. */
export function createBotDriver(track: Track, def: BotDef, t: Tuning = TUNING): (st: Readonly<SessionState>) => InputFrame {
  return createAutopilot(track, t, { ...AUTOPILOT, ...def.style });
}

export function createBotField(track: Track, roster: readonly BotDef[] = BOTS, t: Tuning = TUNING): BotField {
  const runs = roster.map((def) => ({ def, session: createSession(track, { tuning: t }), drive: createBotDriver(track, def, t) }));
  const NO_RESPAWN = { respawn: false };
  const fixedDt = 1 / t.race.physicsHz;

  function stepRun(r: (typeof runs)[number], dt: number): void {
    r.session.step(r.drive(r.session.state()), NO_RESPAWN, dt);
  }

  return {
    bots: runs.map(({ def, session }) => ({ def, session })),
    step(dt) {
      for (const r of runs) if (r.session.state().phase !== 'finished') stepRun(r, dt);
    },
    fastForward(capSeconds = BOT_TIME_CAP) {
      for (const r of runs) {
        // The countdown does not advance the race time; it lasts a fixed number of steps.
        while (r.session.state().phase === 'countdown') stepRun(r, fixedDt);
        while (r.session.state().phase === 'racing' && r.session.state().time < capSeconds) stepRun(r, fixedDt);
      }
    },
  };
}

/**
 * Points a racer has right now: banked plus the running chain. A chain can still burn, but banked points alone
 * would show a bot that keeps one chain for the whole race (the master) at 0 until the finish.
 */
export function livePoints(score: Readonly<DriftScoreState>): number {
  return score.totalPoints + score.chainPoints;
}

/** Tie order: the player above the bots, the bots weakest first (roster order). */
const TIE_ORDER: Readonly<Record<StandingRow['id'], number>> = { player: 0, rookie: 1, pro: 2, master: 3 };

function byPoints(a: StandingRow, b: StandingRow): number {
  return b.points - a.points || TIE_ORDER[a.id] - TIE_ORDER[b.id];
}

function setRow(r: StandingRow, id: StandingRow['id'], name: string, color: number | null, points: number, finished: boolean): void {
  r.id = id;
  r.name = name;
  r.color = color;
  r.points = Math.round(points);
  r.finished = finished;
}

/**
 * Player and bots by points, best first. Live (`final` false): livePoints(); final: a finished bot's result (a
 * bot cut off by the time cap keeps its live points). `player.points` is the player's counterpart. Points are
 * compared as shown (rounded); on a tie the player ranks above the bots, and bots keep roster order. Writes into
 * `out` when given (the HUD refreshes 30 times a second: its rows are reused) and returns it.
 */
export function standings(
  player: { points: number; finished: boolean },
  bots: readonly BotRun[],
  final: boolean,
  out: StandingRow[] = [],
): StandingRow[] {
  out.length = bots.length + 1;
  for (let i = 0; i < out.length; i++) out[i] ??= { id: 'player', name: '', color: null, points: 0, finished: false };
  setRow(out[0], 'player', PLAYER_NAME, null, player.points, player.finished);
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    const st = b.session.state();
    const finished = st.phase === 'finished';
    const points = final && finished && st.result ? st.result.totalPoints : livePoints(st.score);
    setRow(out[i + 1], b.def.id, b.def.name, b.def.color, points, finished);
  }
  return out.sort(byPoints);
}
