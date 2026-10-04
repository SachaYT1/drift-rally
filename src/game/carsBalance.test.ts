/**
 * Line-up balance (src/shared/cars.ts): the autopilot drives a full race in every car. Every car must drive it
 * cleanly, pricier cars must score more (drift angle pays, raw speed does not), and Ронин keeps its niche: the
 * fastest race. Measured with the bombs on the track (2026-10-04, v0.4.0): Искра 51 871 pts / 175.3 s,
 * Квадро 54 929 / 175.0, Ронин 60 785 / 158.0, Скарабей 66 535 / 174.2; no car blows a bomb.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createAutopilot } from './autopilot';
import { createSession } from './session';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { TUNING } from '../shared/tuning';
import { CAR_IDS, CARS, tuningFor, type CarId } from '../shared/cars';
import type { RaceResult } from '../shared/types';

const track = buildTrack(PLAZA);
const DT = 1 / TUNING.race.physicsHz;
/** Simulated seconds before a race counts as not finished. */
const LIMIT_S = 400;
/** Each next car (by price) scores at least this much more. */
const MIN_STEP = 1.04;
/** The top car scores at most this much over the starter: an upgrade, not another game. */
const MAX_SPREAD = 1.45;
/** Every lap of every car stays under this, s. */
const MAX_LAP = 65;

interface Run {
  result: RaceResult;
  hits: number;
  burned: number;
  respawns: number;
}

function race(id: CarId): Run {
  const t = tuningFor(id);
  const sess = createSession(track, { tuning: t });
  const drive = createAutopilot(track, t);
  let hits = 0;
  let burned = 0;
  let respawns = 0;
  for (let i = 0; i < LIMIT_S / DT && sess.state().phase !== 'finished'; i++) {
    for (const e of sess.step(drive(sess.state()), { respawn: false }, DT)) {
      if (e.type === 'hit') hits++;
      else if (e.type === 'chainBurned') burned++;
      else if (e.type === 'respawn') respawns++;
    }
  }
  const result = sess.state().result;
  if (!result) throw new Error(`${id}: the autopilot did not finish in ${LIMIT_S} s`);
  return { result, hits, burned, respawns };
}

describe('car line-up balance (autopilot, full race)', () => {
  let runs: Record<CarId, Run>;
  const points = (id: CarId): number => runs[id].result.totalPoints;

  beforeAll(() => {
    runs = Object.fromEntries(CAR_IDS.map((id) => [id, race(id)])) as Record<CarId, Run>;
  });

  it.each(CAR_IDS)('%s drives the race cleanly', (id) => {
    const r = runs[id];
    expect(r.respawns).toBe(0);
    expect(r.hits).toBeLessThanOrEqual(1);
    expect(r.burned).toBeLessThanOrEqual(1);
    for (const lap of r.result.lapTimes) expect(lap).toBeLessThan(MAX_LAP);
  });

  it('pricier cars score more, within an upgrade’s reach', () => {
    const byPrice = [...CAR_IDS].sort((a, b) => CARS[a].price - CARS[b].price);
    for (let i = 1; i < byPrice.length; i++) {
      expect(points(byPrice[i])).toBeGreaterThanOrEqual(points(byPrice[i - 1]) * MIN_STEP);
    }
    expect(points(byPrice[byPrice.length - 1])).toBeLessThanOrEqual(points(byPrice[0]) * MAX_SPREAD);
  });

  it('Ронин has the fastest race', () => {
    for (const id of CAR_IDS) if (id !== 'ronin') expect(runs.ronin.result.totalTime).toBeLessThan(runs[id].result.totalTime);
  });
});
