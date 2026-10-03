import { describe, expect, it } from 'vitest';
import { applyRaceResult, bestLapSeconds } from './saveResult';
import { DEFAULT_SAVE } from '../core/save';
import type { RaceResult, SaveData } from '../shared/types';

function result(over: Partial<RaceResult> = {}): RaceResult {
  return {
    totalPoints: 12_345.6,
    bestChain: 4000,
    totalTime: 190.5,
    lapTimes: [64.2, 63.1234, 63.2],
    bestLap: 63.1234,
    coinsPicked: 40,
    coinsFromDrift: 12,
    coinsEarned: 52,
    ...over,
  };
}

function save(over: Partial<SaveData> = {}): SaveData {
  return { ...DEFAULT_SAVE, ...over };
}

describe('applyRaceResult', () => {
  it('first finish: adds coins, sets best score (rounded) and best lap in ms', () => {
    const out = applyRaceResult(save(), result());
    expect(out.save.coins).toBe(52);
    expect(out.save.bestScore).toBe(12_346);
    expect(out.save.bestLapMs).toBe(63_123);
    expect(out.newBest).toBe(true);
    expect(out.newBestLap).toBe(true);
  });

  it('keeps better records, still adds coins and keeps settings', () => {
    const prev = save({ coins: 100, bestScore: 50_000, bestLapMs: 60_000, quality: 'high', muted: true });
    const out = applyRaceResult(prev, result());
    expect(out.save).toEqual({ ...prev, coins: 152 });
    expect(out.newBest).toBe(false);
    expect(out.newBestLap).toBe(false);
  });

  it('a better run replaces the records', () => {
    const out = applyRaceResult(save({ coins: 3, bestScore: 10_000, bestLapMs: 70_000 }), result());
    expect(out.save).toMatchObject({ coins: 55, bestScore: 12_346, bestLapMs: 63_123 });
    expect(out.newBest && out.newBestLap).toBe(true);
  });

  it('a tie is not a new record', () => {
    const out = applyRaceResult(save({ bestScore: 12_346, bestLapMs: 63_123 }), result());
    expect(out.newBest).toBe(false);
    expect(out.newBestLap).toBe(false);
  });

  it('a zero-point run is never a new best score', () => {
    const out = applyRaceResult(save(), result({ totalPoints: 0, coinsEarned: 5 }));
    expect(out.newBest).toBe(false);
    expect(out.save.bestScore).toBe(0);
    expect(out.save.coins).toBe(5);
  });

  it('ignores non-finite or invalid result fields', () => {
    const prev = save({ coins: 7, bestScore: 10, bestLapMs: 50_000 });
    const out = applyRaceResult(prev, result({ totalPoints: Number.NaN, bestLap: Infinity, coinsEarned: Number.NaN }));
    expect(out.save).toEqual(prev);
    expect(applyRaceResult(prev, result({ totalPoints: -5, bestLap: 0, coinsEarned: -3 })).save).toEqual(prev);
  });

  it('never mutates the input save', () => {
    const prev = Object.freeze(save({ coins: 1 }));
    const out = applyRaceResult(prev, result());
    expect(prev.coins).toBe(1);
    expect(out.save).not.toBe(prev);
  });
});

describe('bestLapSeconds', () => {
  it('converts ms to seconds and maps a missing record to null', () => {
    expect(bestLapSeconds(save({ bestLapMs: 63_123 }))).toBeCloseTo(63.123, 9);
    expect(bestLapSeconds(save())).toBeNull();
  });
});
