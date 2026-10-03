import { describe, expect, it } from 'vitest';
import { canAccrue, createDriftScore, updateDriftScore, type DriftScoreInput, type DriftScoreState } from './driftScore';
import { TUNING } from '../shared/tuning';
import { DEG } from '../shared/math';
import type { CarState, GameEvent } from '../shared/types';

const DT = 1 / 120;
const base: DriftScoreInput = { accruing: false, slip: 30 * DEG, progressSpeed: 20, heavyHit: false, respawned: false, bombed: false, propsKnocked: 0, finished: false };

function feed(state: DriftScoreState, seconds: number, input: Partial<DriftScoreInput>) {
  const events: GameEvent[] = [];
  let s = state;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const r = updateDriftScore(s, { ...base, ...input }, DT);
    s = r.state;
    events.push(...r.events);
  }
  return { s, events };
}

const driftCar = { mode: 'drift', speed: 20, slip: 30 * DEG } as unknown as CarState;
const ok = { car: driftCar, surface: 'road' as const, progress: 100, frontier: 100, progressSpeed: 18 };

describe('drift score', () => {
  it('starts idle', () => {
    const s = createDriftScore();
    expect(s).toMatchObject({ phase: 'idle', chainPoints: 0, totalPoints: 0, multiplier: 1 });
  });

  it('canAccrue requires every condition', () => {
    expect(canAccrue(ok)).toBe(true);
    expect(canAccrue({ ...ok, surface: 'runoff' })).toBe(false);
    expect(canAccrue({ ...ok, car: { ...driftCar, slip: 5 * DEG } })).toBe(false);
    expect(canAccrue({ ...ok, car: { ...driftCar, speed: TUNING.score.minSpeed - 1 } })).toBe(false);
    expect(canAccrue({ ...ok, car: { ...driftCar, mode: 'grip' } })).toBe(false);
    expect(canAccrue({ ...ok, progress: 100 - TUNING.score.frontierSlack - 1 })).toBe(false); // replaying old ground
    expect(canAccrue({ ...ok, progressSpeed: 1 })).toBe(false); // donuts
    expect(canAccrue({ ...ok, progressSpeed: -10 })).toBe(false); // wrong way
  });

  it('accrues ~100 pts/s at reference angle and speed', () => {
    const { s } = feed(createDriftScore(), 1, { accruing: true });
    expect(s.chainPoints).toBeGreaterThan(97);
    expect(s.chainPoints).toBeLessThan(103);
  });

  it('caps angle and speed factors', () => {
    const a = feed(createDriftScore(), 1, { accruing: true, slip: 80 * DEG }).s.chainPoints;
    const b = feed(createDriftScore(), 1, { accruing: true, slip: TUNING.score.angleCap }).s.chainPoints;
    expect(a).toBeCloseTo(b, 6);
    const c = feed(createDriftScore(), 1, { accruing: true, progressSpeed: 500 }).s.chainPoints;
    expect(c).toBeCloseTo(100 * TUNING.score.speedFactorCap, 0);
  });

  it('multiplier grows with accumulated drift time and caps', () => {
    const { s, events } = feed(createDriftScore(), 4.1, { accruing: true });
    expect(s.multiplier).toBe(3);
    expect(events.filter((e) => e.type === 'multiplier').map((e) => (e as { value: number }).value)).toEqual([2, 3]);
    expect(feed(createDriftScore(), 30, { accruing: true }).s.multiplier).toBe(TUNING.score.multiplierMax);
  });

  it('wiggling cannot pump the multiplier', () => {
    let s = createDriftScore();
    for (let k = 0; k < 40; k++) s = feed(s, 0.05, { accruing: k % 2 === 0 }).s;
    expect(s.multiplier).toBe(1);
  });

  it('banks after the grace period, not before', () => {
    let { s } = feed(createDriftScore(), 1, { accruing: true });
    const chain = Math.round(s.chainPoints);
    s = feed(s, TUNING.score.graceTime - 0.02, {}).s;
    expect(s.totalPoints).toBe(0);
    const r = feed(s, 0.05, {});
    expect(r.s.totalPoints).toBe(chain);
    expect(r.events.filter((e) => e.type === 'chainBanked')).toHaveLength(1);
    expect(r.s.bestChain).toBe(chain);
    expect(r.s.phase).toBe('idle');
  });

  it('resuming within grace continues the same chain', () => {
    let { s } = feed(createDriftScore(), 1, { accruing: true });
    s = feed(s, 0.5, {}).s;
    const r = feed(s, 1, { accruing: true });
    expect(r.events.filter((e) => e.type === 'chainStart')).toHaveLength(0);
    expect(r.s.chainPoints).toBeGreaterThan(190);
  });

  it('heavy hit and respawn burn the unbanked chain', () => {
    for (const k of ['heavyHit', 'respawned'] as const) {
      const { s } = feed(createDriftScore(), 1, { accruing: true });
      const r = updateDriftScore(s, { ...base, [k]: true }, DT);
      expect(r.state.chainPoints).toBe(0);
      expect(r.state.totalPoints).toBe(0);
      expect(r.events.some((e) => e.type === 'chainBurned')).toBe(true);
    }
  });

  it('a bomb burns an active or a grace chain and keeps the banked total; nothing when idle', () => {
    const banked = feed(feed(createDriftScore(), 1, { accruing: true }).s, TUNING.score.graceTime + 0.5, {}).s;
    expect(banked.totalPoints).toBeGreaterThan(0);
    const active = feed(banked, 1, { accruing: true }).s;
    const grace = feed(active, TUNING.score.graceTime / 2, {}).s;
    expect([active.phase, grace.phase]).toEqual(['active', 'grace']);
    for (const s of [active, grace]) {
      const r = updateDriftScore(s, { ...base, bombed: true }, DT);
      expect(r.events).toEqual([{ type: 'chainBurned', points: Math.round(s.chainPoints) }]);
      expect(r.state).toMatchObject({ phase: 'idle', chainPoints: 0, multiplier: 1, totalPoints: banked.totalPoints });
    }
    expect(updateDriftScore(createDriftScore(), { ...base, bombed: true }, DT).events).toEqual([]);
    // A heavy hit and a blast in the same step burn the chain once.
    const both = updateDriftScore(active, { ...base, heavyHit: true, bombed: true }, DT);
    expect(both.events).toEqual([{ type: 'chainBurned', points: Math.round(active.chainPoints) }]);
  });

  it('prop penalty hits the banked total, floored at 0, chain survives', () => {
    let { s } = feed(createDriftScore(), 1, { accruing: true });
    const r = updateDriftScore(s, { ...base, accruing: true, propsKnocked: 2 }, DT);
    expect(r.state.totalPoints).toBe(0);
    expect(r.state.chainPoints).toBeGreaterThan(90);
    // Changed by the final review (penalty-flash-without-deduction): nothing banked, nothing deducted,
    // so no penalty event (was: an event with the nominal penalty).
    expect(r.events.some((e) => e.type === 'penalty')).toBe(false);
    s = { ...r.state, totalPoints: 150 };
    expect(updateDriftScore(s, { ...base, propsKnocked: 1 }, DT).state.totalPoints).toBe(50);
  });

  it('finish banks the active chain', () => {
    const { s } = feed(createDriftScore(), 1, { accruing: true });
    const r = updateDriftScore(s, { ...base, accruing: true, finished: true }, DT);
    expect(r.state.totalPoints).toBeGreaterThan(97);
    expect(r.state.phase).toBe('idle');
  });

  it('dt = 0 changes nothing', () => {
    const { s } = feed(createDriftScore(), 1, { accruing: true });
    expect(updateDriftScore(s, { ...base, accruing: true }, 0).state).toEqual(s);
  });
});

describe('drift score edge cases', () => {
  const sc = TUNING.score;
  /** A chain this long is still at x1. */
  const SHORT = sc.multiplierStep / 2;
  /** Idle for less than the grace period: the chain is still in grace. */
  const IN_GRACE = sc.graceTime / 3;
  /** Simulated time feed() actually covers for `seconds`. */
  const fed = (seconds: number) => Math.round(seconds / DT) * DT;

  it('canAccrue boundaries: curb counts, strict speed thresholds, slack is inclusive', () => {
    expect(canAccrue({ ...ok, surface: 'curb' })).toBe(true);
    expect(canAccrue({ ...ok, surface: 'outside' })).toBe(false);
    expect(canAccrue({ ...ok, car: { ...driftCar, speed: sc.minSpeed } })).toBe(false);
    expect(canAccrue({ ...ok, progress: 100 - sc.frontierSlack })).toBe(true);
    expect(canAccrue({ ...ok, progressSpeed: sc.minProgressSpeed })).toBe(false);
    expect(canAccrue({ ...ok, car: { ...driftCar, slip: -30 * DEG } })).toBe(true);
  });

  it('never mutates its inputs', () => {
    const s = Object.freeze(feed(createDriftScore(), SHORT, { accruing: true }).s);
    const input = Object.freeze({ ...base, accruing: true, propsKnocked: 1, finished: true });
    const snapshot = { ...s };
    const r = updateDriftScore(s, input, DT);
    expect(s).toEqual(snapshot);
    expect(r.state).not.toBe(s);
  });

  it('dt = 0 emits nothing and does not start a chain', () => {
    const r = updateDriftScore(createDriftScore(), { ...base, accruing: true }, 0);
    expect(r.events).toEqual([]);
    expect(r.state).toEqual(createDriftScore());
  });

  it('emits chainStart once per chain and no multiplier event at x1', () => {
    const { events } = feed(createDriftScore(), SHORT, { accruing: true });
    expect(events).toEqual([{ type: 'chainStart' }]);
  });

  it('negative slip scores like positive slip; backward progress speed scores nothing', () => {
    const pos = feed(createDriftScore(), SHORT, { accruing: true }).s.chainPoints;
    const neg = feed(createDriftScore(), SHORT, { accruing: true, slip: -30 * DEG }).s.chainPoints;
    expect(neg).toBeCloseTo(pos, 9);
    expect(feed(createDriftScore(), SHORT, { accruing: true, progressSpeed: -5 }).s.chainPoints).toBe(0);
  });

  it('a chain in grace keeps its multiplier and drift time when it resumes', () => {
    // Accrue into the x2 band, pause inside the grace period, resume while still below x3.
    const accrue = sc.multiplierStep * 1.25;
    const resume = sc.multiplierStep * 0.05;
    let { s } = feed(createDriftScore(), accrue, { accruing: true });
    expect(s.multiplier).toBe(2);
    s = feed(s, (sc.graceTime * 2) / 3, {}).s;
    expect(s.phase).toBe('grace');
    expect(s.multiplier).toBe(2);
    const r = feed(s, resume, { accruing: true });
    expect(r.s.multiplier).toBe(2);
    expect(r.s.chainDriftTime).toBeCloseTo(fed(accrue) + fed(resume), 6);
    expect(r.events.filter((e) => e.type === 'multiplier' || e.type === 'chainStart')).toHaveLength(0);
  });

  it('burns a chain that is in grace; no burn event when idle', () => {
    let { s } = feed(createDriftScore(), SHORT, { accruing: true });
    s = feed(s, IN_GRACE, {}).s;
    expect(s.phase).toBe('grace');
    const r = updateDriftScore(s, { ...base, heavyHit: true }, DT);
    expect(r.state).toMatchObject({ phase: 'idle', chainPoints: 0, multiplier: 1, totalPoints: 0 });
    expect(r.events).toEqual([{ type: 'chainBurned', points: Math.round(s.chainPoints) }]);
    expect(updateDriftScore(createDriftScore(), { ...base, respawned: true }, DT).events).toEqual([]);
  });

  it('finish banks a chain in grace; finishing while idle emits nothing', () => {
    let { s } = feed(createDriftScore(), SHORT, { accruing: true });
    s = feed(s, IN_GRACE, {}).s;
    const chain = Math.round(s.chainPoints);
    const r = updateDriftScore(s, { ...base, finished: true }, DT);
    expect(r.state.totalPoints).toBe(chain);
    expect(r.events).toEqual([{ type: 'chainBanked', points: chain }]);
    expect(updateDriftScore(r.state, { ...base, finished: true }, DT).events).toEqual([]);
  });

  it('a new chain after banking starts fresh; totals add up and bestChain keeps the max', () => {
    let { s } = feed(createDriftScore(), SHORT, { accruing: true });
    s = feed(s, sc.graceTime + 0.1, {}).s;
    const first = s.totalPoints;
    const secondTime = sc.multiplierStep / 4;
    const r = feed(s, secondTime, { accruing: true });
    expect(r.events[0]).toEqual({ type: 'chainStart' });
    expect(r.s.multiplier).toBe(1);
    expect(r.s.chainDriftTime).toBeCloseTo(fed(secondTime), 6);
    const done = feed(r.s, sc.graceTime + 0.1, {}).s;
    const second = Math.round(r.s.chainPoints);
    expect(done.totalPoints).toBe(first + second);
    expect(done.bestChain).toBe(Math.max(first, second));
  });

  it('penalty event reports the points actually deducted for all knocked props', () => {
    // Changed by the final review (penalty-flash-without-deduction): the event carries
    // min(banked total, propPenalty * props), not the nominal penalty.
    const r = updateDriftScore({ ...createDriftScore(), totalPoints: 1000 }, { ...base, propsKnocked: 3 }, DT);
    expect(r.state.totalPoints).toBe(1000 - 3 * sc.propPenalty);
    expect(r.events).toEqual([{ type: 'penalty', points: 3 * sc.propPenalty }]);
    const floored = 1.5 * sc.propPenalty;
    const partial = updateDriftScore({ ...createDriftScore(), totalPoints: floored }, { ...base, propsKnocked: 2 }, DT);
    expect(partial.state.totalPoints).toBe(0);
    expect(partial.events).toEqual([{ type: 'penalty', points: floored }]);
  });

  it('emits no penalty event when nothing is banked to deduct', () => {
    const r = updateDriftScore(createDriftScore(), { ...base, propsKnocked: 1 }, DT);
    expect(r.state.totalPoints).toBe(0);
    expect(r.events).toEqual([]);
  });
});
