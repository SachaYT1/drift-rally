# Sport Cars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three drift cars in the spirit of the BMW E30, Nissan Skyline and Porsche 911 that players buy for coins in the garage, each with its own handling, shown on the friends table next to the record they set.

**Architecture:** A car is data (`src/shared/cars.ts`): name, price, card stats and physics overrides laid over `TUNING` by `tuningFor()` and passed to `createSession(track, { tuning })`; the physics stays untouched. The save gains `ownedCars`, `selectedCar`, `bestScoreCar`; buying goes through `updateSave` (read-modify-write on the stored save). Car visuals are procedural bodies (like «Искра») on a shared wheel/suspension rig; each scene keeps a rack of car models and shows one. The garage card browses the line-up (‹ › / ← →) and its CTA races an owned car or buys a locked one after a confirmation dialog.

**Tech Stack:** TypeScript, three.js r186, Vite, Vitest (+ jsdom for DOM suites), Playwright e2e, Supabase (Postgres RPC) for the friends table.

---

## Decisions (agreed with the user, 2026-10-04)

- **Line-up:** «Искра» (free, the starter) → «Квадро» (E30-style sedan, 300 coins) → «Ронин» (Skyline-style turbo coupe, 900) → «Скарабей» (911-style rear-engined coupe, 2000). Names are fictional: no real makes, models or logos anywhere (trademarks). Silhouettes only evoke the originals.
- **Visuals:** procedural, built in code like «Искра» (no downloaded models, no licences to track). Every car shares Iskra's footprint (4.0 × 1.9 m, wheelbase 2.5 m, wheel radius 0.42 m), so the collision capsule and the track's tight spots behave the same for every car.
- **Handling:** each car has its own character, but the drift *geometry* (`curvInto`, `curvNeutral`, `curvCounter`) is never overridden: the track was laid out for those arcs.
- **Balance finding:** drift points accrue *per second* of drifting (base × angle × speed (capped at 32 m/s) × chain multiplier), so raw speed does not pay: a faster car finishes sooner and drifts fewer seconds. The drift angle does pay. Pricier cars therefore hold wider angles. Autopilot measurements (3 laps, all clean: 0 hits, 0 respawns):

  | Car | Price | Points | Race time |
  |---|---|---|---|
  | Искра | — | 51 365 | 174.9 s |
  | Квадро | 300 | 54 847 (+7 %) | 180.6 s |
  | Ронин | 900 | 60 695 (+18 %) | **157.5 s** (fastest) |
  | Скарабей | 2000 | 66 535 (+30 %) | 173.9 s |

  Re-measured after rebasing onto v0.4.0 (bombs on the drift lines): Квадро's wide, slow line swept over the bomb
  by the bicycle (2 bombs, 2 burned chains, 44 082 points). `dragSlip: 5` (it keeps its speed in the slide)
  carries it wide of the bomb: Искра 51 871 / 175.3 s, Квадро 54 929 (+6 %) / 175.0 s, Ронин 60 785 / 158.0 s,
  Скарабей 66 535 / 174.2 s, no bombs blown.

  A full autopilot race earns ~100 coins, so the prices mean ~3–6, then ~6–9, then ~11–20 more races.
- **Save:** stays `version: 1`; the new fields are additive with defaults. Bumping the version would make an open old tab read "other version" → defaults and overwrite the coins.
  - *Code review fix:* an old (v0.4.0) tab still rewrites `SAVE_KEY` with only the fields it knows, so cars kept there would be stripped and a purchase lost. The garage (`ownedCars`, `selectedCar`) therefore lives under its own key `driftRally.garage.v1`, which old versions never write; `bestScoreCar` stays next to the score (stripped = «unknown car»).
- **Friends table:** one table; each player's row shows the car of their best score (`best_car` column, `p_car` RPC argument). The migration is applied to the live project **only after the user confirms** (Task 14), and before the client ships.
- **Garage UX:** browse on the podium (‹ › buttons, ← → keys); the card shows the browsed car; CTA = «В заезд» for an owned car, «Купить · ● price» (disabled with «Не хватает N монет» when short) for a locked one; buying needs a confirmation dialog whose default focus is «Отмена». Enter never buys and never starts a race on a locked car. Browsing to an owned car selects it for the next race; buying selects the bought car.
- **Out of scope (follow-ups):** per-car engine voices (needs listening in the sound lab), paint choice, per-car leaderboards, the car on the results screen.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/shared/cars.ts` | new | Line-up data (`CARS`, `CAR_IDS`, `CarId`), `isCarId`, `tuningFor` |
| `src/shared/cars.test.ts` | new | Catalogue invariants, `tuningFor` |
| `src/app/carsBalance.test.ts` | new | Autopilot race per car: clean driving, points ladder, Ронин fastest |
| `src/shared/types.ts` | modify | `SaveData.ownedCars / selectedCar / bestScoreCar` |
| `src/core/save.ts` (+ test) | modify | Defaults, sanitising, persisting the car fields |
| `src/app/context.ts` (+ test) | modify | `sameProgress` covers the car fields (other tabs' purchases reach the garage) |
| `src/app/carShop.ts` (+ test) | new | `buyCar`, `selectCar`, `purchaseCar` |
| `src/app/saveResult.ts` (+ tests) | modify | `bestScoreCar` on a new best |
| `src/render/carParts.ts` | new | Materials, trim palette, `PartBuilder`, wheel geometry, `CarBody` |
| `src/render/bodies/iskra.ts` | new (moved) | «Искра» body (from `carModel.ts`) |
| `src/render/bodies/quadro.ts`, `ronin.ts`, `scarab.ts` | new | The three new bodies |
| `src/render/carModel.ts` | modify | Rig only: `createCarModel(body)` — hierarchy, wheels, suspension |
| `src/render/carModel.test.ts` | new | Footprint and wheel rig of every body |
| `src/render/carBodies.ts` | new | `CAR_BODIES: Record<CarId, CarBody>` |
| `src/render/carRack.ts` (+ test) | new | All car models under one parent, one visible |
| `src/render/garageScene.ts`, `src/app/raceScene.ts` | modify | `setCar(id)` via a rack |
| `src/app/raceRun.ts`, `src/app/testHook.ts` | modify | Race the selected car with its tuning; hook exposes `car` |
| `src/ui/garageCar.ts` | new | Card stats, CTA state, buy dialog markup, line-up stepping |
| `src/ui/garage.ts` (+ test), `src/ui/styles.css` | modify | Switcher, buy flow |
| `src/app/garageScreen.ts`, `src/app/main.ts` | modify | Wiring, `?test&car=<id>` preview |
| `src/shared/leaderboard.ts`, `src/core/leaderboardApi.ts`, `src/app/leaderboard.ts`, `src/ui/leaderboardView.ts` (+ tests) | modify | `car` on rows and submits |
| `supabase/migrations/20261004120000_leaderboard_best_car.sql` | new | `best_car` column, view, `standing`, `submit_result(p_car)` |
| `tests/e2e/cars.spec.ts` | new | Buy a car in the garage and race it |
| `CHANGELOG.md`, `README.md` | modify | Player-facing notes |

**Branch:** `feature/sport-cars` (worktree `.claude/worktrees/sport-cars`, from `develop`). Parallel branches to keep in mind at merge time: `feature/ghost-bots` moves `src/app/autopilot.ts` into the game layer (whichever merges second fixes the import in `src/app/carsBalance.test.ts` and `src/app/testHook.ts`); `feature/bombs` puts bombs on the drift lines of four corners, so after merging it re-run `src/app/carsBalance.test.ts` and re-measure the ladder if a car starts hitting bombs.

**Commands:** `npm test` (all unit suites), `npx vitest run <file>` (one suite), `npm run typecheck`, `npm run build`, `npm run e2e` (GPU) / `npm run e2e:software` (SwiftShader).

---

### Task 1: Car catalogue

**Files:**
- Create: `src/shared/cars.ts`
- Test: `src/shared/cars.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/cars.test.ts
import { describe, expect, it } from 'vitest';
import { CAR_IDS, CARS, DEFAULT_CAR, isCarId, tuningFor } from './cars';
import { TUNING } from './tuning';
import { DEG } from './math';

describe('car catalogue', () => {
  it('lists every car once under its own id, the free starter first', () => {
    expect(new Set(CAR_IDS).size).toBe(CAR_IDS.length);
    expect(Object.keys(CARS).sort()).toEqual([...CAR_IDS].sort());
    for (const id of CAR_IDS) expect(CARS[id].id).toBe(id);
    expect(CAR_IDS[0]).toBe(DEFAULT_CAR);
    expect(CARS[DEFAULT_CAR].price).toBe(0);
  });

  it('prices rise along the line-up', () => {
    for (let i = 1; i < CAR_IDS.length; i++) expect(CARS[CAR_IDS[i]].price).toBeGreaterThan(CARS[CAR_IDS[i - 1]].price);
  });

  it('only overrides values that exist in TUNING', () => {
    for (const id of CAR_IDS) {
      const { car = {}, drift = {} } = CARS[id].tuning;
      for (const key of Object.keys(car)) expect(TUNING.car).toHaveProperty(key);
      for (const key of Object.keys(drift)) expect(TUNING.drift).toHaveProperty(key);
    }
  });

  it('keeps the drift arcs the track was laid out for', () => {
    for (const id of CAR_IDS) {
      const d = tuningFor(id).drift;
      expect([d.curvInto, d.curvNeutral, d.curvCounter]).toEqual([TUNING.drift.curvInto, TUNING.drift.curvNeutral, TUNING.drift.curvCounter]);
    }
  });

  it('keeps slip angles ordered and within the scoring cap', () => {
    for (const id of CAR_IDS) {
      const d = tuningFor(id).drift;
      expect(d.slipNarrow).toBeLessThan(d.slipMid);
      expect(d.slipMid).toBeLessThan(d.slipWide);
      expect(d.slipWide).toBeLessThanOrEqual(d.slipMax);
      expect(d.slipMax).toBeLessThanOrEqual(TUNING.score.angleCap);
    }
  });

  it('keeps card stats within 0..100', () => {
    for (const id of CAR_IDS) {
      for (const v of Object.values(CARS[id].stats)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('recognises car ids only', () => {
    expect(isCarId('ronin')).toBe(true);
    for (const v of ['RONIN', 'bmw', '', null, 3, undefined, 'toString']) expect(isCarId(v)).toBe(false);
  });
});

describe('tuningFor', () => {
  it('returns the base itself for a car without overrides (live DEV GUI edits keep working)', () => {
    expect(tuningFor('iskra')).toBe(TUNING);
  });

  it('lays a car over car and drift, shares every other section and leaves the base alone', () => {
    const maxSpeed = TUNING.car.maxSpeed;
    const t = tuningFor('ronin');
    expect(t.car.maxSpeed).toBe(43);
    expect(t.car.length).toBe(TUNING.car.length);
    expect(t.drift.slipMid).toBeCloseTo(39 * DEG);
    expect(t.drift.curvNeutral).toBe(TUNING.drift.curvNeutral);
    expect(t.score).toBe(TUNING.score);
    expect(TUNING.car.maxSpeed).toBe(maxSpeed);
  });

  it('uses the given base', () => {
    const base = { ...TUNING, car: { ...TUNING.car, rollingResistance: 1.5 } };
    expect(tuningFor('scarab', base).car.rollingResistance).toBe(1.5);
    expect(tuningFor('scarab', base).car.engineAccel).toBe(13);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/cars.test.ts`
Expected: FAIL — `Failed to resolve import "./cars"`.

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/cars.ts
/**
 * The car line-up (plan/2026-10-04-sport-cars.md): what the garage shows and sells, and what each car changes in
 * the physics. A car's `tuning` lists only the values that differ from TUNING; tuningFor() lays them over the
 * live TUNING. Every car shares Iskra's footprint (length, width, collision capsule, wheels): TuningOverrides does
 * not let a car change them, so collisions and the track's tight spots behave the same for every car. The drift
 * arcs (curvInto / curvNeutral / curvCounter) are never overridden either: the track was laid out for them.
 *
 * Balance (src/app/carsBalance.test.ts): drift points accrue per second of drifting, so raw speed does NOT pay (a
 * faster car finishes sooner); the drift angle does. Pricier cars hold wider angles: Искра < Квадро < Ронин <
 * Скарабей in autopilot points, and Ронин has the fastest race.
 *
 * Names are fictional on purpose: the cars only evoke real ones (E30, Skyline, 911), never name them.
 */
import { DEG } from './math';
import { TUNING, type Tuning } from './tuning';

export const CAR_IDS = ['iskra', 'quadro', 'ronin', 'scarab'] as const;
export type CarId = (typeof CAR_IDS)[number];
/** The car every player starts with: free and always owned. */
export const DEFAULT_CAR: CarId = 'iskra';

/** Footprint values shared by every car (collision capsule, wheel placement): a car never overrides them. */
type Footprint = 'length' | 'width' | 'capsuleHalf' | 'radius' | 'wheelBase' | 'wheelRadius';

export interface TuningOverrides {
  car?: Partial<Omit<Tuning['car'], Footprint>>;
  drift?: Partial<Tuning['drift']>;
}

/** Garage card values, 0..100: display only, not physics parameters. */
export interface CarStats {
  speed: number;
  accel: number;
  handling: number;
  /** Drift angle. */
  angle: number;
}

export interface CarSpec {
  readonly id: CarId;
  /** Player-facing name. */
  readonly name: string;
  /** Garage subtitle under the name. */
  readonly subtitle: string;
  /** One line about the car's character. */
  readonly tagline: string;
  /** Coins; 0 = owned from the start. */
  readonly price: number;
  readonly stats: Readonly<CarStats>;
  readonly tuning: TuningOverrides;
}

export const CARS: Readonly<Record<CarId, CarSpec>> = {
  iskra: {
    id: 'iskra',
    name: 'Искра',
    subtitle: 'Дрифт-кар · задний привод',
    tagline: 'Лёгкая и послушная — с неё начинает каждый.',
    price: 0,
    stats: { speed: 76, accel: 85, handling: 77, angle: 60 },
    tuning: {},
  },
  quadro: {
    id: 'quadro',
    name: 'Квадро',
    subtitle: 'Спорт-седан · задний привод',
    tagline: 'Предсказуемый занос и большой угол. Лучшая первая покупка.',
    price: 300,
    stats: { speed: 72, accel: 80, handling: 84, angle: 68 },
    tuning: {
      // Gentle and wide: kicks from a lower speed, holds a wider angle, swings the body in more softly.
      car: { maxSpeed: 38, engineAccel: 11.5 },
      drift: {
        minSpeed: 7,
        kickSteerThreshold: 0.18,
        slipNarrow: 16 * DEG,
        slipMid: 32 * DEG,
        slipWide: 47 * DEG,
        slipMax: 56 * DEG,
        bodyResponse: 7,
      },
    },
  },
  ronin: {
    id: 'ronin',
    name: 'Ронин',
    subtitle: 'Турбо-купе · задний привод',
    tagline: 'Мощный: держит занос на высокой скорости. Самый быстрый заезд.',
    price: 900,
    stats: { speed: 90, accel: 92, handling: 74, angle: 80 },
    tuning: {
      // Power: needs speed to kick, grips harder before it lets go, keeps its speed in a wide slide.
      car: { maxSpeed: 43, engineAccel: 13.5, maxLatAccelGrip: 15 },
      drift: {
        minSpeed: 9,
        thrust: 10.5,
        driftTopSpeed: 60,
        dragSlip: 4.5,
        slipNarrow: 20 * DEG,
        slipMid: 39 * DEG,
        slipWide: 53 * DEG,
        slipMax: 60 * DEG,
      },
    },
  },
  scarab: {
    id: 'scarab',
    name: 'Скарабей',
    subtitle: 'Спорткар · задний мотор',
    tagline: 'Резко срывается и быстро перекладывается. Сложный, но с самым высоким потолком очков.',
    price: 2000,
    stats: { speed: 84, accel: 88, handling: 92, angle: 86 },
    tuning: {
      // Rear-engined snap: lets go early, rotates and flicks fast, drops out of a slide sooner off the throttle.
      car: { maxSpeed: 42, engineAccel: 13, maxLatAccelGrip: 13 },
      drift: {
        kickSteerThreshold: 0.15,
        bodyResponse: 11,
        bodyMaxYawRate: 5,
        flickBlendTime: 0.22,
        slipNarrow: 20 * DEG,
        slipMid: 38 * DEG,
        slipWide: 52 * DEG,
        slipMax: 60 * DEG,
        thrust: 10,
        exitDelay: 0.2,
        gripBlendTime: 0.25,
      },
    },
  },
};

export function isCarId(v: unknown): v is CarId {
  return typeof v === 'string' && (CAR_IDS as readonly string[]).includes(v);
}

/**
 * `base` with the car's overrides laid over its car and drift sections (every other section is shared). A car
 * without overrides gets `base` itself, so the DEV debug GUI's live edits keep reaching a running race; other
 * cars get a snapshot of car / drift taken when the race starts.
 */
export function tuningFor(id: CarId, base: Tuning = TUNING): Tuning {
  const o = CARS[id].tuning;
  if (!o.car && !o.drift) return base;
  return { ...base, car: { ...base.car, ...o.car }, drift: { ...base.drift, ...o.drift } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/cars.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/cars.ts src/shared/cars.test.ts
git commit -m "feat(cars): add the car line-up and per-car tuning"
```

---

### Task 2: Line-up balance test

**Files:**
- Test: `src/app/carsBalance.test.ts`

- [ ] **Step 1: Write the test**

```ts
// src/app/carsBalance.test.ts
/**
 * Line-up balance (src/shared/cars.ts): the autopilot drives a full race in every car. Every car must drive it
 * cleanly, pricier cars must score more (drift angle pays, raw speed does not), and Ронин keeps its niche: the
 * fastest race. Measured when written (2026-10-04): Искра 51 365 pts / 174.9 s, Квадро 54 847 / 180.6,
 * Ронин 60 695 / 157.5, Скарабей 66 535 / 173.9.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createAutopilot } from './autopilot';
import { createSession } from '../game/session';
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
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/app/carsBalance.test.ts`
Expected: PASS (6 tests). If a car fails, the catalogue numbers in Task 1 drifted from the measured ones: compare with the table in «Decisions», do not loosen the thresholds.

- [ ] **Step 3: Commit**

```bash
git add src/app/carsBalance.test.ts
git commit -m "test(app): guard the car line-up balance with autopilot races"
```

---

### Task 3: Car fields in the save

**Files:**
- Modify: `src/shared/types.ts` (`SaveData`)
- Modify: `src/core/save.ts`
- Modify: `src/app/context.ts:145-149` (`sameProgress`)
- Test: `src/core/save.test.ts`, `src/app/context.test.ts`
- Fix literals: `src/ui/garage.test.ts:11`, `src/ui/leaderboardUi.test.ts` (every `SaveData` object literal with `version: 1`)

- [ ] **Step 1: Write the failing tests** (append to `src/core/save.test.ts`)

```ts
describe('save: cars', () => {
  const base = { version: 1, coins: 50, bestScore: 10, bestLapMs: null, quality: null, muted: false };

  it('reads a save from before the line-up as «Искра» only', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify(base));
    expect(loadSave(s)).toEqual({ ...DEFAULT_SAVE, coins: 50, bestScore: 10 });
    expect(loadSave(s)).toMatchObject({ ownedCars: ['iskra'], selectedCar: 'iskra', bestScoreCar: null });
  });

  it('keeps known owned cars in line-up order, always with «Искра»', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ ...base, ownedCars: ['scarab', 'bmw', 'quadro', 'quadro'] }));
    expect(loadSave(s).ownedCars).toEqual(['iskra', 'quadro', 'scarab']);
  });

  it('selects «Искра» when the stored car is unknown or not owned', () => {
    for (const selectedCar of ['ronin', 'bmw', 7]) {
      const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ ...base, ownedCars: ['quadro'], selectedCar }));
      expect(loadSave(s).selectedCar).toBe('iskra');
    }
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ ...base, ownedCars: ['quadro'], selectedCar: 'quadro' }));
    expect(loadSave(s).selectedCar).toBe('quadro');
  });

  it('keeps a known record car and drops an unknown one', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ ...base, bestScoreCar: 'ronin' }));
    expect(loadSave(s).bestScoreCar).toBe('ronin');
    s.setItem(SAVE_KEY, JSON.stringify({ ...base, bestScoreCar: 'bmw' }));
    expect(loadSave(s).bestScoreCar).toBeNull();
  });

  it('round-trips the car fields', () => {
    const s = mem();
    const data = { ...DEFAULT_SAVE, coins: 3, ownedCars: ['iskra', 'ronin'] as const, selectedCar: 'ronin' as const, bestScoreCar: 'iskra' as const };
    expect(writeSave(data, s)).toBe(true);
    expect(loadSave(s)).toEqual(data);
  });
});
```

And in `src/app/context.test.ts`, next to the other two-tab tests (same `browserStorage` / `openTab` helpers; read the helper first: without `browser.hold()` storage events reach the other tab right away):

```ts
  it('a car bought in another tab reaches this tab and its save listeners', () => {
    const browser = browserStorage();
    const t1 = browser.tab();
    const t2 = browser.tab();
    const a = openTab(t1.storage, t1.events);
    const b = openTab(t2.storage, t2.events);
    recordRaceResult(b, race({ coinsEarned: 400 }), 'iskra');
    const seen: string[][] = [];
    a.onSaveChanged((s) => seen.push([...s.ownedCars]));
    purchaseCar(b, 'quadro');
    expect(a.save).toMatchObject({ coins: 100, ownedCars: ['iskra', 'quadro'], selectedCar: 'quadro' });
    expect(seen.at(-1)).toEqual(['iskra', 'quadro']);
  });
```

This context test needs Task 4 (`purchaseCar`, the `car` argument of `recordRaceResult`); add it in Task 4, Step 1 if Task 4 is not done yet. In this task only the save tests are run.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/save.test.ts`
Expected: FAIL — `ownedCars` is `undefined`.

- [ ] **Step 3: Implement**

`src/shared/types.ts` — import the type and extend `SaveData`:

```ts
import type { CarId } from './cars';
```

```ts
export interface SaveData {
  version: 1;
  coins: number;
  bestScore: number;
  /** Milliseconds, null if never finished. */
  bestLapMs: number | null;
  /** null = auto-detect. */
  quality: QualityLevel | null;
  muted: boolean;
  /** Cars bought, in line-up order (shared/cars.ts CAR_IDS); always includes the free DEFAULT_CAR. */
  ownedCars: readonly CarId[];
  /** The car of the next race; always an owned one. */
  selectedCar: CarId;
  /** The car of the race that set bestScore; null before the first record (or one set before the line-up). */
  bestScoreCar: CarId | null;
}
```

`src/core/save.ts`:

```ts
import { CAR_IDS, DEFAULT_CAR, isCarId, type CarId } from '../shared/cars';
```

```ts
export const DEFAULT_SAVE: Readonly<SaveData> = Object.freeze({
  version: 1,
  coins: 0,
  bestScore: 0,
  bestLapMs: null,
  quality: null,
  muted: false,
  ownedCars: Object.freeze([DEFAULT_CAR]) as readonly CarId[],
  selectedCar: DEFAULT_CAR,
  bestScoreCar: null,
});
```

In `writeSave`, the persisted record gains the three fields:

```ts
  const record: SaveData = {
    version: 1,
    coins: data.coins,
    bestScore: data.bestScore,
    bestLapMs: data.bestLapMs,
    quality: data.quality,
    muted: data.muted,
    ownedCars: [...data.ownedCars],
    selectedCar: data.selectedCar,
    bestScoreCar: data.bestScoreCar,
  };
```

In `sanitize`, before the `return`, and in the returned object:

```ts
  const ownedCars = ownedCarsFrom(r.ownedCars);
  return {
    version: 1,
    coins: coins === null ? DEFAULT_SAVE.coins : Math.floor(coins),
    bestScore: bestScore ?? DEFAULT_SAVE.bestScore,
    bestLapMs: bestLapMs ?? DEFAULT_SAVE.bestLapMs,
    quality: isQualityLevel(r.quality) ? r.quality : DEFAULT_SAVE.quality,
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SAVE.muted,
    ownedCars,
    selectedCar: isCarId(r.selectedCar) && ownedCars.includes(r.selectedCar) ? r.selectedCar : DEFAULT_CAR,
    bestScoreCar: isCarId(r.bestScoreCar) ? r.bestScoreCar : DEFAULT_SAVE.bestScoreCar,
  };
```

and a helper at the end of the file:

```ts
/** Known car ids of a stored list, in line-up order, always with the free car; unknown or repeated ids drop out. */
function ownedCarsFrom(v: unknown): CarId[] {
  const stored: unknown[] = Array.isArray(v) ? v : [];
  return CAR_IDS.filter((id) => id === DEFAULT_CAR || stored.includes(id));
}
```

`src/app/context.ts` — progress now includes the cars (a purchase in another tab must reach the garage):

```ts
/** Progress equal: coins, records and cars (settings aside). */
function sameProgress(a: Readonly<SaveData>, b: Readonly<SaveData>): boolean {
  return (
    a.coins === b.coins &&
    a.bestScore === b.bestScore &&
    a.bestLapMs === b.bestLapMs &&
    a.selectedCar === b.selectedCar &&
    a.bestScoreCar === b.bestScoreCar &&
    a.ownedCars.join() === b.ownedCars.join()
  );
}
```

Update the `App.save` doc comment in `context.ts` ("Progress (coins, records) as stored") to "Progress (coins, records, cars) as stored".

Test literals: in `src/ui/garage.test.ts` change `SAVE` to spread the defaults, so future fields do not break it:

```ts
import { DEFAULT_SAVE } from '../core/save';
const SAVE: SaveData = { ...DEFAULT_SAVE, coins: 120, bestScore: 4200, bestLapMs: 61_000, quality: 'medium' };
```

Do the same for every `version: 1` `SaveData` literal in `src/ui/leaderboardUi.test.ts` (keep each literal's own values). `tests/e2e/smoke.spec.ts` uses `toMatchObject` and needs no change.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core src/ui src/app/context.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/core/save.ts src/core/save.test.ts src/app/context.ts src/ui/garage.test.ts src/ui/leaderboardUi.test.ts
git commit -m "feat(core): store owned cars, the selected car and the record car"
```

---

### Task 4: Buying and choosing cars; the record car

**Files:**
- Create: `src/app/carShop.ts`
- Modify: `src/app/saveResult.ts`
- Test: `src/app/carShop.test.ts`, `src/app/saveResult.test.ts`, `src/app/context.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/carShop.test.ts
import { describe, expect, it } from 'vitest';
import type { SaveData } from '../shared/types';
import { DEFAULT_SAVE } from '../core/save';
import { buyCar, purchaseCar, selectCar } from './carShop';

const SAVE: SaveData = { ...DEFAULT_SAVE, coins: 1000 };

describe('buyCar', () => {
  it('pays the price, owns the car and selects it', () => {
    expect(buyCar(SAVE, 'ronin')).toEqual({
      ok: true,
      save: { ...SAVE, coins: 100, ownedCars: ['iskra', 'ronin'], selectedCar: 'ronin' },
    });
  });

  it('keeps the owned list in line-up order', () => {
    const out = buyCar({ ...SAVE, coins: 5000, ownedCars: ['iskra', 'scarab'] }, 'quadro');
    expect(out.ok && out.save.ownedCars).toEqual(['iskra', 'quadro', 'scarab']);
  });

  it('refuses a car the player cannot afford, down to the last coin', () => {
    expect(buyCar({ ...SAVE, coins: 299 }, 'quadro')).toEqual({ ok: false, reason: 'coins' });
    expect(buyCar({ ...SAVE, coins: 300 }, 'quadro')).toMatchObject({ ok: true, save: { coins: 0 } });
  });

  it('refuses a car already owned', () => {
    expect(buyCar(SAVE, 'iskra')).toEqual({ ok: false, reason: 'owned' });
    expect(buyCar({ ...SAVE, ownedCars: ['iskra', 'quadro'] }, 'quadro')).toEqual({ ok: false, reason: 'owned' });
  });

  it('never mutates the input', () => {
    const save = Object.freeze({ ...SAVE, ownedCars: Object.freeze(['iskra'] as const) });
    expect(() => buyCar(save, 'quadro')).not.toThrow();
    expect(save.ownedCars).toEqual(['iskra']);
  });
});

describe('selectCar', () => {
  it('selects an owned car', () => {
    expect(selectCar({ ...SAVE, ownedCars: ['iskra', 'ronin'] }, 'ronin').selectedCar).toBe('ronin');
  });

  it('ignores a car that is not owned', () => {
    expect(selectCar(SAVE, 'ronin')).toEqual(SAVE);
  });
});

describe('purchaseCar', () => {
  it('buys against the save as stored now (another tab may have spent the coins)', () => {
    let stored: SaveData = { ...SAVE, coins: 350 };
    const store = {
      updateSave(change: (s: SaveData) => SaveData): SaveData {
        stored = change(stored);
        return stored;
      },
    };
    expect(purchaseCar(store, 'ronin')).toEqual({ ok: false, reason: 'coins' });
    expect(stored.coins).toBe(350);
    expect(purchaseCar(store, 'quadro').ok).toBe(true);
    expect(stored).toMatchObject({ coins: 50, ownedCars: ['iskra', 'quadro'], selectedCar: 'quadro' });
  });
});
```

Append to the `applyRaceResult` describe of `src/app/saveResult.test.ts` (its fixtures are `result(over)` and `save(over)`):

```ts
  it('remembers the car of a new best score and keeps the old one otherwise', () => {
    const before = save({ bestScore: 5000, bestScoreCar: 'iskra' });
    expect(applyRaceResult(before, result({ totalPoints: 6000 }), 'ronin').save.bestScoreCar).toBe('ronin');
    expect(applyRaceResult(before, result({ totalPoints: 4000 }), 'ronin').save.bestScoreCar).toBe('iskra');
  });
```

Add the two-tab purchase test from Task 3 to `src/app/context.test.ts` (import `purchaseCar` from `./carShop`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/carShop.test.ts src/app/saveResult.test.ts`
Expected: FAIL — `./carShop` missing; `bestScoreCar` not set.

- [ ] **Step 3: Implement**

```ts
// src/app/carShop.ts
/**
 * Buying and choosing cars (plan/2026-10-04-sport-cars.md). buyCar and selectCar are pure: they return a new
 * SaveData and never mutate the input. purchaseCar applies a purchase to the save as stored NOW (App.updateSave),
 * so two tabs cannot spend the same coins twice and a purchase is never lost to another tab's write.
 */
import { CAR_IDS, CARS, type CarId } from '../shared/cars';
import type { SaveData } from '../shared/types';
import type { SaveStore } from './saveResult';

export type BuyOutcome = { ok: true; save: SaveData } | { ok: false; reason: 'owned' | 'coins' };

/** Pay the car's price and own it; the bought car becomes the selected one. */
export function buyCar(save: Readonly<SaveData>, id: CarId): BuyOutcome {
  if (save.ownedCars.includes(id)) return { ok: false, reason: 'owned' };
  const price = CARS[id].price;
  if (save.coins < price) return { ok: false, reason: 'coins' };
  return {
    ok: true,
    save: {
      ...save,
      coins: save.coins - price,
      ownedCars: CAR_IDS.filter((c) => c === id || save.ownedCars.includes(c)),
      selectedCar: id,
    },
  };
}

/** The save with `id` as the car of the next race; unchanged when the car is not owned. */
export function selectCar(save: Readonly<SaveData>, id: CarId): SaveData {
  return save.ownedCars.includes(id) ? { ...save, selectedCar: id } : { ...save };
}

/** buyCar on the save as stored now; a refused purchase leaves the stored save as it was. */
export function purchaseCar(store: SaveStore, id: CarId): BuyOutcome {
  const applied: { outcome: BuyOutcome } = { outcome: { ok: false, reason: 'coins' } };
  store.updateSave((current) => {
    applied.outcome = buyCar(current, id);
    return applied.outcome.ok ? applied.outcome.save : current;
  });
  return applied.outcome;
}
```

`src/app/saveResult.ts`: add `import type { CarId } from '../shared/cars';`, a `car` parameter and the field:

```ts
/**
 * coins += coinsEarned; bestScore = max(bestScore, round(totalPoints)) and bestScoreCar = `car` when that is a new
 * best; bestLapMs = min(bestLapMs, round(bestLap * 1000)) (RaceResult times are seconds, the save keeps
 * milliseconds). Settings fields (quality, muted) and the garage fields are kept.
 */
export function applyRaceResult(save: Readonly<SaveData>, r: Readonly<RaceResult>, car: CarId): SaveOutcome {
  ...
  return {
    save: {
      ...save,
      coins: wholeNonNegative(save.coins) + wholeNonNegative(r.coinsEarned),
      bestScore: newBest ? score : save.bestScore,
      bestScoreCar: newBest ? car : save.bestScoreCar,
      bestLapMs: newBestLap ? lapMs : save.bestLapMs,
    },
    newBest,
    newBestLap,
  };
}
```

```ts
/** Applies a finished race in `car` to the save as stored NOW (see applyRaceResult). */
export function recordRaceResult(store: SaveStore, r: Readonly<RaceResult>, car: CarId): SaveOutcome {
  const applied: { outcome: SaveOutcome | null } = { outcome: null };
  store.updateSave((current) => {
    applied.outcome = applyRaceResult(current, r, car);
    return applied.outcome.save;
  });
  if (applied.outcome === null) throw new Error('updateSave did not apply the race result');
  return applied.outcome;
}
```

Keep the existing doc comment of `recordRaceResult` (another tab may have raced since; newBest compares against the stored save) and add the `car` sentence to it. Update every existing call: `applyRaceResult(x, y)` → `applyRaceResult(x, y, 'iskra')` in `src/app/saveResult.test.ts`, `recordRaceResult(x, y)` → `recordRaceResult(x, y, 'iskra')` in `src/app/context.test.ts`. The production caller (`raceRun.ts`) is updated in Task 8; until then `npx tsc --noEmit` reports it — that is expected in this task only, so for now pass `app.save.selectedCar` there:

```ts
    outcome = { result, save: recordRaceResult(app, result, app.save.selectedCar) };
```

(Task 8 replaces it with the car captured at race start.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/app && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/carShop.ts src/app/carShop.test.ts src/app/saveResult.ts src/app/saveResult.test.ts src/app/context.test.ts src/app/raceRun.ts
git commit -m "feat(app): buy and select cars, remember the car of the best score"
```

---

### Task 5: Split the car model into a rig and bodies

Pure refactor: «Искра» must look exactly as before.

**Files:**
- Create: `src/render/carParts.ts`, `src/render/bodies/iskra.ts`
- Modify: `src/render/carModel.ts`
- Test: `src/render/carModel.test.ts`

- [ ] **Step 1: Take a "before" screenshot of the garage**

```bash
npm run build && (npx vite preview --port 4173 >/dev/null 2>&1 &) && sleep 2
mkdir -p temp/cars && node scripts/screenshot.mjs "http://127.0.0.1:4173/?test&full" temp/cars/before.png 1280 720 15000
```

- [ ] **Step 2: Write the failing test**

```ts
// src/render/carModel.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCarModel } from './carModel';
import type { CarBody } from './carParts';
import { ISKRA } from './bodies/iskra';
import { createCarState } from '../physics/car';
import { TUNING } from '../shared/tuning';

/** Every body of the line-up (Task 7 replaces this with CAR_BODIES). */
const BODIES: Record<string, CarBody> = { iskra: ISKRA };
const WHEELS = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'];

describe('car models', () => {
  for (const [id, body] of Object.entries(BODIES)) {
    it(`${id}: stays within the shared footprint, on the ground`, () => {
      const car = createCarModel(body);
      car.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(car.root);
      expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
      expect(box.max.y).toBeLessThan(1.6);
      expect(Math.max(-box.min.x, box.max.x)).toBeLessThanOrEqual(TUNING.car.width / 2 + 0.06);
      expect(Math.max(-box.min.z, box.max.z)).toBeLessThanOrEqual(TUNING.car.length / 2 + 0.1);
    });

    it(`${id}: has four wheel pivots at the wheelbase that the front ones steer`, () => {
      const car = createCarModel(body);
      const pivots = WHEELS.map((name) => car.root.getObjectByName(name));
      for (const p of pivots) expect(p).toBeDefined();
      expect(pivots.map((p) => Math.sign(p!.position.z))).toEqual([1, 1, -1, -1]);
      for (const p of pivots) expect(Math.abs(p!.position.z)).toBeCloseTo(TUNING.car.wheelBase / 2);
      const state = { ...createCarState(0, 0, 0), steer: 1, forwardSpeed: 5, speed: 5 };
      car.update(state, 0);
      expect(pivots[0]!.rotation.y).toBeGreaterThan(0.1);
      expect(pivots[2]!.rotation.y).toBe(0);
    });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/render/carModel.test.ts`
Expected: FAIL — `./carParts` / `./bodies/iskra` missing.

- [ ] **Step 4: Move the building blocks to `src/render/carParts.ts`**

Create the file with: the header below; `WHEEL_WIDTH`, `CAP_OUT`; `COLORS` **without** `hub` and `cap`; `Materials` + `createMaterials` (unchanged); `PartBuilder` (unchanged, exported, plus the `cylinder` method); `WheelColors`, `CarBody`; `createWheelGeometry` taking the wheel colours. All moved code is copied verbatim from `carModel.ts` except where shown.

```ts
/**
 * Building blocks shared by the procedural cars (render/bodies/*, carModel.ts): the four materials every car
 * uses, the trim palette, PartBuilder (collects transformed parts and merges them per material) and the wheel
 * geometry.
 *
 * Model space: built facing +Z, local +X = the car's LEFT side, y up from the ground (see bridge.ts).
 * Rotations (PartBuilder rx, about X): rx < 0 lifts a part's front (+Z) end and leans its top back; rx > 0 the
 * opposite. rx = PI/2 turns a cylinder's axis from +Y to +Z (a lamp facing forward).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TUNING } from '../shared/tuning';

export const WHEEL_WIDTH = 0.35;
/** Hub disc + cap protrude this far beyond the tyre's outer face; the car width includes them. */
export const CAP_OUT = 0.045;

/** Trim colours shared by every body (sRGB hex; converted to linear vertex colours via Color.setHex). */
export const COLORS = {
  dark: 0x1c1a1c,
  seat: 0x2e2a2c,
  metal: 0x4a4b50,
  frame: 0xc4c8cc,
  glass: 0x1f3a39,
  headlight: 0xfff6e2,
  taillight: 0xff2b24,
  tyre: 0x1e1e21,
} as const;

/** Hub and centre-cap colours of a body's wheels. */
export interface WheelColors {
  hub: number;
  cap: number;
}

/** One procedural car body: its default paint, its wheel colours and its parts. */
export interface CarBody {
  /** Default paint colour (sRGB hex). */
  readonly paint: number;
  readonly wheel: WheelColors;
  /** Adds every part except the wheels to `b`, in model space (see the file header), on `m`'s materials. */
  build(b: PartBuilder, m: Materials): void;
}
```

`PartBuilder` gains:

```ts
  /** Cylinder of radius r and height h, axis along Y before the rotation (rx = PI/2 points it along +Z). */
  cylinder(mat: THREE.Material, color: number | null, r: number, h: number, segments: number, x: number, y: number, z: number, rx = 0, rz = 0): void {
    this.add(mat, new THREE.CylinderGeometry(r, r, h, segments), color, x, y, z, rx, rz);
  }
```

`createWheelGeometry` takes the colours:

```ts
/** Tyre + hub disc + cap as one geometry, axle along X; hub and cap on the `outward` (+1/-1) face. */
export function createWheelGeometry(mat: THREE.Material, outward: number, colors: WheelColors): THREE.BufferGeometry {
  const r = TUNING.car.wheelRadius;
  const axle = Math.PI / 2;
  const b = new PartBuilder();
  b.add(mat, new THREE.CylinderGeometry(r, r, WHEEL_WIDTH, 16), COLORS.tyre, 0, 0, 0, 0, axle);
  b.add(mat, new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.03, 16), colors.hub, outward * (WHEEL_WIDTH / 2 + 0.01), 0, 0, 0, axle);
  b.add(mat, new THREE.CylinderGeometry(r * 0.26, r * 0.26, CAP_OUT * 2, 8), colors.cap, outward * (WHEEL_WIDTH / 2), 0, 0, 0, axle);
  return b.merged(mat);
}
```

- [ ] **Step 5: Move the «Искра» body to `src/render/bodies/iskra.ts`**

```ts
/** «Искра»: the open-top toy buggy from the user's garage reference; the starter car. */
import { TUNING } from '../../shared/tuning';
import { COLORS, type CarBody, type Materials, type PartBuilder } from '../carParts';

const PAINT = 0xf0573a;

/** Body parts in model space (y up from the ground, +Z forward, +X left). */
function build(b: PartBuilder, mats: Materials): void {
  // The body of the old buildBody(), verbatim, minus `const b = new PartBuilder();` and `b.build(target);`.
}

export const ISKRA: CarBody = { paint: PAINT, wheel: { hub: 0xb4aea6, cap: PAINT }, build };
```

Paste the old `buildBody` statements (from `const L = TUNING.car.length;` to the head/tail light loop) into `build`.

- [ ] **Step 6: Reduce `src/render/carModel.ts` to the rig**

Keep: the `CarModel` interface, `DEFAULT_ENV_INTENSITY`, the visual-only constants that the rig uses (`STEER_SPEED_SOFTEN`, `COUNTER_STEER_GAIN`, `DRIFT_STEER_SHARE`, `WHEEL_STEER_RATE`, the roll/pitch/spring constants), `Wheel`, `createWheel`, `Spring`, `stepSpring`, `update`, `reset`, `updateSuspension`. Remove what moved, and `DEFAULT_CAR_COLOR` (nothing imports it: `grep -rn DEFAULT_CAR_COLOR src tests` must print nothing after the change). Update the header: "Procedural low-poly car rig: one body from render/bodies/* (see carParts.ts) on four animated wheels."

New imports and factory head:

```ts
import * as THREE from 'three';
import type { CarState } from '../shared/types';
import { TUNING } from '../shared/tuning';
import { TAU, clamp, damp } from '../shared/math';
import { CAP_OUT, PartBuilder, WHEEL_WIDTH, createMaterials, createWheelGeometry, type CarBody } from './carParts';
import { ISKRA } from './bodies/iskra';
```

```ts
/** A car model of `body`, painted `color` (default: the body's own paint). */
export function createCarModel(body: CarBody = ISKRA, color: number = body.paint): CarModel {
  const mats = createMaterials(color);
  // ... root / body / bodyContent groups as before ...
  const parts = new PartBuilder();
  body.build(parts, mats);
  parts.build(bodyContent);

  // Left (+X) and right wheels share one geometry per side.
  const leftGeo = createWheelGeometry(mats.wheel, 1, body.wheel);
  const rightGeo = createWheelGeometry(mats.wheel, -1, body.wheel);
  // ... the rest unchanged ...
}
```

- [ ] **Step 7: Run tests, typecheck, compare screenshots**

Run: `npx vitest run src/render && npx tsc --noEmit`
Expected: PASS.

```bash
npm run build && node scripts/screenshot.mjs "http://127.0.0.1:4173/?test&full" temp/cars/after.png 1280 720 15000
```

Open `temp/cars/before.png` and `temp/cars/after.png` (Read tool): the car must look identical (the turntable angle may differ slightly with load time).

- [ ] **Step 8: Commit**

```bash
git add src/render/carParts.ts src/render/bodies/iskra.ts src/render/carModel.ts src/render/carModel.test.ts
git commit -m "refactor(render): split the car model into a wheel rig and bodies"
```

---

### Task 6: Three new bodies

Each body is one file; add it to `BODIES` in `src/render/carModel.test.ts` and run that test before committing. Coordinates: `L = 4.0`, `F = L / 2 = 2.0`; wheels sit at x = ±0.73, z = ±1.25, radius 0.42 (they span z 0.83..1.67 and x 0.555..0.905), so no part may cross them below y = 0.84 between |z| 0.83 and 1.67 unless it is an arch/flare above the tyre. The shapes are a first pass: Task 11 tunes them from screenshots.

**Files:**
- Create: `src/render/bodies/quadro.ts`, `src/render/bodies/ronin.ts`, `src/render/bodies/scarab.ts`
- Modify: `src/render/carModel.test.ts` (`BODIES`)

- [ ] **Step 1: «Квадро» (E30-style)**

```ts
// src/render/bodies/quadro.ts
/**
 * «Квадро»: a boxy late-80s German sport sedan in the spirit of the E30 M3 (no badges, no real name): flat
 * panels with sharp edges, box flares over the wheels, an upright glasshouse, black bumpers, a black nose with
 * four round headlights and twin kidney grilles, wide red tail lights and a boot-lip spoiler. Alpine white,
 * gold mesh wheels.
 */
import { TUNING } from '../../shared/tuning';
import { COLORS, type CarBody, type Materials, type PartBuilder } from '../carParts';

const PAINT = 0xf1f0ea;
const HALF_PI = Math.PI / 2;

function build(b: PartBuilder, m: Materials): void {
  const L = TUNING.car.length;
  const F = L / 2;
  const WB = TUNING.car.wheelBase / 2;
  const { paint, trim, lamps } = m;
  // Boxy lower body with small edge radii; hood and boot decks just below the beltline.
  b.rounded(paint, null, 1.74, 0.44, L - 0.12, 0.05, 0, 0.62, 0);
  b.rounded(paint, null, 1.66, 0.08, 1.15, 0.03, 0, 0.87, 1.3);
  b.rounded(paint, null, 1.66, 0.1, 0.78, 0.03, 0, 0.88, -1.5);
  // Box flares over all four wheels.
  for (const sx of [1, -1]) for (const z of [WB, -WB]) b.rounded(paint, null, 0.14, 0.17, 1.0, 0.04, sx * 0.86, 0.77, z);
  // Upright glasshouse: a dark glass block under a flat roof that overhangs it a little; door mirrors.
  b.box(trim, COLORS.glass, 1.48, 0.42, 1.62, 0, 1.1, -0.14);
  b.rounded(paint, null, 1.56, 0.08, 1.42, 0.03, 0, 1.34, -0.16);
  for (const sx of [1, -1]) b.box(paint, null, 0.12, 0.08, 0.12, sx * 0.84, 1.0, 0.56);
  // Black nose: four round headlights and twin kidneys (silver frame, dark inside).
  b.box(trim, COLORS.dark, 1.62, 0.2, 0.05, 0, 0.7, F - 0.03);
  for (const x of [0.44, 0.64]) for (const sx of [1, -1]) b.cylinder(lamps, COLORS.headlight, 0.075, 0.04, 12, sx * x, 0.7, F, HALF_PI);
  for (const sx of [1, -1]) {
    b.box(trim, COLORS.frame, 0.15, 0.17, 0.04, sx * 0.1, 0.71, F - 0.005);
    b.box(trim, COLORS.dark, 0.11, 0.13, 0.04, sx * 0.1, 0.71, F + 0.005);
  }
  // Chunky black bumpers.
  for (const sz of [1, -1]) b.rounded(trim, COLORS.dark, 1.8, 0.15, 0.18, 0.05, 0, 0.46, sz * (F - 0.02));
  // Wide red tail lights around a dark centre panel; boot-lip spoiler.
  for (const sx of [1, -1]) b.box(lamps, COLORS.taillight, 0.5, 0.15, 0.04, sx * 0.56, 0.74, -F + 0.045);
  b.box(trim, COLORS.dark, 0.6, 0.15, 0.04, 0, 0.74, -F + 0.045);
  b.box(trim, COLORS.dark, 1.42, 0.04, 0.14, 0, 0.95, -1.84);
}

export const QUADRO: CarBody = { paint: PAINT, wheel: { hub: 0xc9a24a, cap: 0x2b2b2e }, build };
```

Add `quadro: QUADRO` to `BODIES`; run `npx vitest run src/render/carModel.test.ts`; expected PASS. Commit:

```bash
git add src/render/bodies/quadro.ts src/render/carModel.test.ts
git commit -m "feat(render): add the «Квадро» body"
```

- [ ] **Step 2: «Ронин» (Skyline-style)**

```ts
// src/render/bodies/ronin.ts
/**
 * «Ронин»: a Japanese turbo coupe in the spirit of the R32–R34 GT-R (no badges, no real name): a long hood with
 * a vent, a low glasshouse set back behind a raked windshield, a tall rear wing, four round tail lights, slim
 * headlights, a front lip and side skirts. Bayside-blue paint, bronze wheels.
 */
import { TUNING } from '../../shared/tuning';
import { COLORS, type CarBody, type Materials, type PartBuilder } from '../carParts';

const PAINT = 0x2556b4;
const HALF_PI = Math.PI / 2;

function build(b: PartBuilder, m: Materials): void {
  const L = TUNING.car.length;
  const F = L / 2;
  const { paint, trim, lamps } = m;
  // Lower body; long hood with a dark vent; short boot deck.
  b.rounded(paint, null, 1.78, 0.42, L - 0.08, 0.1, 0, 0.61, 0);
  b.rounded(paint, null, 1.7, 0.1, 1.5, 0.05, 0, 0.85, 1.18);
  b.box(trim, COLORS.dark, 0.52, 0.03, 0.34, 0, 0.905, 1.2);
  b.rounded(paint, null, 1.7, 0.1, 0.72, 0.05, 0, 0.85, -1.58);
  // Low glasshouse set back: glass block, raked windshield (top leans back) and rear glass (top leans forward),
  // a flat roof; door mirrors.
  b.rounded(trim, COLORS.glass, 1.42, 0.36, 1.36, 0.06, 0, 1.06, -0.36);
  b.box(trim, COLORS.glass, 1.4, 0.52, 0.04, 0, 1.08, 0.36, -0.85);
  b.box(trim, COLORS.glass, 1.4, 0.44, 0.04, 0, 1.075, -1.085, 0.66);
  b.rounded(paint, null, 1.46, 0.07, 1.1, 0.03, 0, 1.25, -0.4);
  for (const sx of [1, -1]) b.box(paint, null, 0.12, 0.07, 0.12, sx * 0.84, 0.98, 0.32);
  // Tall rear wing on two dark uprights.
  for (const sx of [1, -1]) b.box(trim, COLORS.dark, 0.06, 0.2, 0.1, sx * 0.56, 1.0, -1.78);
  b.rounded(paint, null, 1.62, 0.05, 0.32, 0.02, 0, 1.12, -1.8);
  // Four round tail lights.
  for (const x of [0.42, 0.66]) for (const sx of [1, -1]) b.cylinder(lamps, COLORS.taillight, 0.1, 0.04, 14, sx * x, 0.7, -F + 0.035, HALF_PI);
  // Slim headlights, a dark grille, the front lip and side skirts (between the wheels).
  for (const sx of [1, -1]) b.box(lamps, COLORS.headlight, 0.42, 0.09, 0.04, sx * 0.58, 0.74, F - 0.035);
  b.box(trim, COLORS.dark, 0.56, 0.1, 0.04, 0, 0.72, F - 0.035);
  b.box(trim, COLORS.dark, 1.74, 0.05, 0.22, 0, 0.4, F - 0.1);
  for (const sx of [1, -1]) b.box(trim, COLORS.dark, 0.06, 0.08, 1.5, sx * 0.88, 0.42, 0);
}

export const RONIN: CarBody = { paint: PAINT, wheel: { hub: 0xa07d3b, cap: 0x1e1e21 }, build };
```

Add `ronin: RONIN` to `BODIES`; run the test; commit `feat(render): add the «Ронин» body`.

- [ ] **Step 3: «Скарабей» (911-style)**

```ts
// src/render/bodies/scarab.ts
/**
 * «Скарабей»: a rear-engined sports coupe in the spirit of the classic 911 (no badges, no real name): a round
 * body, bug-eye headlights in the front wings, a low hood between them, a fastback falling to the tail, wide
 * rear haunches, a ducktail spoiler and a full-width tail light bar. Signal-yellow paint, silver wheels.
 */
import { TUNING } from '../../shared/tuning';
import { COLORS, type CarBody, type Materials, type PartBuilder } from '../carParts';

const PAINT = 0xf4c23d;
const HALF_PI = Math.PI / 2;

function build(b: PartBuilder, m: Materials): void {
  const L = TUNING.car.length;
  const F = L / 2;
  const WB = TUNING.car.wheelBase / 2;
  const { paint, trim, lamps } = m;
  // Round lower body.
  b.rounded(paint, null, 1.7, 0.4, L - 0.14, 0.16, 0, 0.6, 0);
  // Front wings rise above the low hood; bug-eye headlights (tilted up a little) in dark rings at their noses.
  for (const sx of [1, -1]) {
    b.rounded(paint, null, 0.42, 0.22, 1.12, 0.1, sx * 0.63, 0.83, WB - 0.05);
    b.cylinder(trim, COLORS.dark, 0.125, 0.04, 16, sx * 0.63, 0.86, F - 0.2, HALF_PI - 0.25);
    b.cylinder(lamps, COLORS.headlight, 0.1, 0.04, 16, sx * 0.63, 0.86, F - 0.18, HALF_PI - 0.25);
  }
  // Low hood between the wings, falling toward the nose.
  b.rounded(paint, null, 0.86, 0.08, 1.2, 0.04, 0, 0.82, 1.22, 0.06);
  // Wide rear haunches over the rear wheels.
  for (const sx of [1, -1]) b.rounded(paint, null, 0.34, 0.26, 1.2, 0.12, sx * 0.74, 0.84, -WB + 0.05);
  // Round glasshouse behind a raked windshield, a short roof, the fastback falling from the roof to the tail.
  b.rounded(trim, COLORS.glass, 1.32, 0.4, 1.3, 0.14, 0, 1.03, -0.12);
  b.box(trim, COLORS.glass, 1.3, 0.42, 0.04, 0, 1.06, 0.56, -0.7);
  b.rounded(paint, null, 1.34, 0.08, 0.82, 0.04, 0, 1.24, -0.2);
  b.rounded(paint, null, 1.36, 0.1, 1.3, 0.05, 0, 1.0, -1.12, -0.32);
  for (const sx of [1, -1]) b.box(paint, null, 0.12, 0.07, 0.12, sx * 0.8, 0.98, 0.4);
  // Ducktail lip rising toward the tail.
  b.rounded(paint, null, 1.28, 0.05, 0.34, 0.02, 0, 0.92, -1.86, 0.3);
  // Full-width tail light bar over a dark engine grille; slim dark bumpers.
  b.box(lamps, COLORS.taillight, 1.36, 0.06, 0.04, 0, 0.74, -F + 0.055);
  b.box(trim, COLORS.dark, 0.7, 0.1, 0.04, 0, 0.6, -F + 0.055);
  for (const sz of [1, -1]) b.rounded(trim, COLORS.dark, 1.66, 0.1, 0.12, 0.04, 0, 0.44, sz * (F - 0.04));
}

export const SCARAB: CarBody = { paint: PAINT, wheel: { hub: 0xd6d8db, cap: 0x1e1e21 }, build };
```

Add `scarab: SCARAB` to `BODIES`; run the test; commit `feat(render): add the «Скарабей» body`.

---

### Task 7: Body registry and the car rack in both scenes

**Files:**
- Create: `src/render/carBodies.ts`, `src/render/carRack.ts`
- Modify: `src/render/garageScene.ts`, `src/app/raceScene.ts`, `src/render/carModel.test.ts`
- Test: `src/render/carRack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/render/carRack.test.ts
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createCarRack } from './carRack';

describe('car rack', () => {
  it('shows one car at a time and builds each model once', () => {
    const parent = new THREE.Group();
    const prepare = vi.fn();
    const rack = createCarRack(parent, prepare);
    expect(rack.currentId).toBe('iskra');
    expect(prepare).toHaveBeenCalledTimes(1);
    const iskra = rack.current;

    const ronin = rack.show('ronin');
    expect(rack.current).toBe(ronin);
    expect(ronin.root.visible).toBe(true);
    expect(iskra.root.visible).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(2);

    expect(rack.show('iskra')).toBe(iskra);
    expect(rack.show('ronin')).toBe(ronin);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(parent.children.filter((c) => c.visible)).toHaveLength(1);
  });

  it('starts on the given car', () => {
    expect(createCarRack(new THREE.Group(), () => {}, 'scarab').currentId).toBe('scarab');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/render/carRack.test.ts`
Expected: FAIL — `./carRack` missing.

- [ ] **Step 3: Implement**

```ts
// src/render/carBodies.ts
/** The procedural body of every car in the line-up (src/shared/cars.ts). */
import type { CarId } from '../shared/cars';
import type { CarBody } from './carParts';
import { ISKRA } from './bodies/iskra';
import { QUADRO } from './bodies/quadro';
import { RONIN } from './bodies/ronin';
import { SCARAB } from './bodies/scarab';

export const CAR_BODIES: Readonly<Record<CarId, CarBody>> = { iskra: ISKRA, quadro: QUADRO, ronin: RONIN, scarab: SCARAB };
```

```ts
// src/render/carRack.ts
/**
 * Every car model of the line-up under one parent, each built on first use and kept; exactly one is visible.
 * The garage podium and the race scene each own a rack. Every body uses the same four material types, so a car
 * shown for the first time reuses the compiled shader programs (no compile hitch, only a small geometry upload).
 */
import type * as THREE from 'three';
import { DEFAULT_CAR, type CarId } from '../shared/cars';
import { CAR_BODIES } from './carBodies';
import { createCarModel, type CarModel } from './carModel';

export interface CarRack {
  /** The visible car's model. */
  readonly current: CarModel;
  readonly currentId: CarId;
  /** Make `id` the visible car (built on first use, `prepare` applied once) and return its model. */
  show(id: CarId): CarModel;
}

export function createCarRack(parent: THREE.Object3D, prepare: (car: CarModel) => void, initial: CarId = DEFAULT_CAR): CarRack {
  const models = new Map<CarId, CarModel>();

  function modelFor(id: CarId): CarModel {
    let model = models.get(id);
    if (!model) {
      model = createCarModel(CAR_BODIES[id]);
      prepare(model);
      model.root.visible = false;
      parent.add(model.root);
      models.set(id, model);
    }
    return model;
  }

  let currentId = initial;
  let current = modelFor(initial);
  current.root.visible = true;

  return {
    get current() {
      return current;
    },
    get currentId() {
      return currentId;
    },
    show(id) {
      if (id === currentId) return current;
      const next = modelFor(id);
      current.root.visible = false;
      next.root.visible = true;
      current = next;
      currentId = id;
      return next;
    },
  };
}
```

`src/render/carModel.test.ts`: replace the local `BODIES` map and the body imports with `import { CAR_BODIES } from './carBodies';` and iterate `Object.entries(CAR_BODIES)`.

`src/render/garageScene.ts`: in the interface replace the `car` member and add `setCar`:

```ts
  /** The car on the podium. */
  readonly car: CarModel;
  /** Show this car of the line-up on the podium. */
  setCar(id: CarId): void;
```

In `createGarageScene`, replace the `createCarModel()` block with a rack on the turntable (import `createCarRack` and `type CarId`; drop the `createCarModel` import):

```ts
  const rack = createCarRack(turntable, (car) => {
    car.setEnvMap(envMap);
    car.root.position.y = PODIUM_TOP;
  });
```

and in the returned object: `get car() { return rack.current; },` and `setCar(id) { rack.show(id); },` (remove the old `car,` shorthand).

`src/app/raceScene.ts`: same pattern. Interface: keep `readonly car: CarModel` (doc: "The visible car.") and add `/** Race this car of the line-up (call before reset()). */ setCar(id: CarId): void;`. In `createRaceScene` replace `const car = createCarModel(); car.setEnvMap(...); scene.add(car.root);` with:

```ts
  // Paint reflections from the garage PMREM; never scene.environment (it would light every Lambert surface).
  const rack = createCarRack(scene, (model) => model.setEnvMap(envMap, RACE_ENV_INTENSITY));
```

In `sync`, start with `const car = rack.current;`. In the returned object: `get car() { return rack.current; },` and `setCar(id) { rack.show(id); },`. The rack must be created before `separateInstancedShadowCasters(scene)` (same place the car was added).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/render src/app && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/carBodies.ts src/render/carRack.ts src/render/carRack.test.ts src/render/carModel.test.ts src/render/garageScene.ts src/app/raceScene.ts
git commit -m "feat(render): show any car of the line-up in the garage and the race"
```

---

### Task 8: Race the selected car

**Files:**
- Modify: `src/app/raceRun.ts`, `src/app/testHook.ts`
- Test: `tests/e2e/cars.spec.ts` covers it end to end (Task 12); unit-level: `npx tsc --noEmit` + the existing suites.

- [ ] **Step 1: `raceRun.ts`**

Imports: `import { tuningFor, type CarId } from '../shared/cars';` and `import type { Tuning } from '../shared/tuning';` (keep the `TUNING` import).

`RaceRun` interface gains:

```ts
  /** The car of this run (the save's selected car when the run began). */
  readonly car: CarId;
  /** The physics of this run: TUNING with the car's overrides. */
  readonly tuning: Tuning;
```

In `startRaceRun`, replace the session line and set the car before `race.reset()`:

```ts
  const car = app.save.selectedCar;
  const tuning = tuningFor(car);
  const session = createSession(app.track, { bestLap: bestLapSeconds(app.save), tuning });
```

```ts
  race.setCar(car);
  race.reset();
```

In `onFinish`: `outcome = { result, save: recordRaceResult(app, result, car) };`. In the returned `RaceRun` object add `car,` and `tuning,` (read the bottom of the file for the object literal).

- [ ] **Step 2: `testHook.ts`**

`GameTestState` gains `/** The car of the running race. */ car: CarId | null;` (import `type CarId` from `../shared/cars`; import `type RaceRun` from `./raceRun`). The autopilot is created per run with that run's tuning:

```ts
  let autopilot: { run: RaceRun; source: InputSource } | null = null;
```

```ts
  /** The autopilot of the running race, driving with that race's car physics. */
  function drive(): InputSource {
    const r = run();
    if (autopilot?.run !== r) autopilot = { run: r, source: createAutopilot(app().track, r.tuning) };
    return autopilot.source;
  }
```

`run()` must return `RaceRun` (it already returns `target.race()?.run`; annotate `function run(): RaceRun`). In `state()` add `car: r?.car ?? null,`.

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck`
Expected: all unit suites PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/raceRun.ts src/app/testHook.ts
git commit -m "feat(app): race the selected car with its own physics"
```

---

### Task 9: Garage line-up switcher and buying

**Files:**
- Create: `src/ui/garageCar.ts`
- Modify: `src/ui/garage.ts`, `src/ui/styles.css`
- Test: `src/ui/garage.test.ts`

- [ ] **Step 1: Write the failing tests** (add a `describe` inside `src/ui/garage.test.ts`; `click`, `keydown`, `q`, `root`, `SAVE` are the file's helpers — `keydown(code)` dispatches on `window`, read `domTestEnv.ts` to confirm)

```ts
  describe('car line-up', () => {
    let onStart: ReturnType<typeof vi.fn<() => void>>;
    let onBrowse: ReturnType<typeof vi.fn<(id: CarId) => void>>;
    let onBuy: ReturnType<typeof vi.fn<(id: CarId) => boolean>>;

    function mountCars(save: SaveData = SAVE, initialCar?: CarId): void {
      onStart = vi.fn<() => void>();
      onBrowse = vi.fn<(id: CarId) => void>();
      onBuy = vi.fn<(id: CarId) => boolean>((id) => {
        // What garageScreen does: the purchase comes back as a new save.
        ui.update({ ...save, coins: save.coins - CARS[id].price, ownedCars: [...save.ownedCars, id], selectedCar: id });
        return true;
      });
      ui = createGarageUI(root, { save, trackName: 'Площадь', onStart, onMute: () => {}, initialCar, onBrowse, onBuy });
    }
    const cta = (): HTMLButtonElement => q<HTMLButtonElement>('.dr-cta');

    it('opens on the selected car and steps through the line-up with ← →, wrapping around', () => {
      mountCars({ ...SAVE, ownedCars: ['iskra', 'ronin'], selectedCar: 'ronin' });
      expect(q('.dr-car__name').textContent).toBe('Ронин');
      expect(q('.dr-car__count').textContent).toBe('Машина 3/4');
      keydown('ArrowRight');
      expect(q('.dr-car__name').textContent).toBe('Скарабей');
      keydown('ArrowRight');
      expect(q('.dr-car__name').textContent).toBe('Искра');
      keydown('ArrowLeft');
      expect(onBrowse.mock.calls.map(([id]) => id)).toEqual(['scarab', 'iskra', 'scarab']);
    });

    it('steps with the ‹ › buttons too', () => {
      mountCars();
      click(q('.dr-carnav__btn[data-step="1"]'));
      expect(q('.dr-car__name').textContent).toBe('Квадро');
      click(q('.dr-carnav__btn[data-step="-1"]'));
      expect(q('.dr-car__name').textContent).toBe('Искра');
    });

    it('shows a locked car with its price, and Enter does not start a race in it', () => {
      mountCars({ ...SAVE, coins: 500 });
      keydown('ArrowRight');
      expect(q('.dr-car__lock').textContent).toBe('Не куплена');
      expect(cta().classList.contains('dr-cta--buy')).toBe(true);
      expect(norm(cta().textContent)).toContain('Купить');
      expect(norm(cta().textContent)).toContain('300');
      keydown('Enter');
      expect(onStart).not.toHaveBeenCalled();
      keydown('ArrowLeft');
      keydown('Enter');
      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it('disables «Купить» and tells how many coins are missing', () => {
      mountCars({ ...SAVE, coins: 120 });
      keydown('ArrowRight');
      expect(cta().disabled).toBe(true);
      expect(norm(q('.dr-cta-hint').textContent)).toContain('Не хватает');
      expect(norm(q('.dr-cta-hint').textContent)).toContain('180 монет');
    });

    it('buys only after the confirmation; «Отмена» buys nothing', () => {
      mountCars({ ...SAVE, coins: 500 });
      keydown('ArrowRight');
      click(cta());
      expect(norm(q('.dr-modal__title').textContent)).toBe('Купить «Квадро»?');
      click(q('[data-ref="cancel"]'));
      expect(root.querySelector('.dr-modal')).toBeNull();
      expect(onBuy).not.toHaveBeenCalled();

      click(cta());
      click(q('[data-confirm-buy]'));
      expect(onBuy).toHaveBeenCalledWith('quadro');
      expect(root.querySelector('.dr-modal')).toBeNull();
      expect(q('.dr-car__lock').textContent).toBe('');
      expect(cta().classList.contains('dr-cta--buy')).toBe(false);
      expect(norm(cta().textContent)).toContain('В заезд');
    });

    it('focuses «Отмена» in the buy dialog, so Enter there cancels', () => {
      mountCars({ ...SAVE, coins: 500 });
      keydown('ArrowRight');
      click(cta(), 0);
      expect(document.activeElement).toBe(q('[data-ref="cancel"]'));
    });

    it('opens on `initialCar` when given (test preview)', () => {
      mountCars(SAVE, 'scarab');
      expect(q('.dr-car__name').textContent).toBe('Скарабей');
    });
  });
```

Imports to add at the top of the test file: `import { CARS, type CarId } from '../shared/cars';`. `SAVE` must own only `['iskra']` (it spreads `DEFAULT_SAVE` since Task 3).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/garage.test.ts`
Expected: the new tests FAIL (`.dr-car__count` missing); the old ones pass.

- [ ] **Step 3: Create `src/ui/garageCar.ts`**

```ts
/**
 * Garage car card pieces (plan/2026-10-04-sport-cars.md): stat bars, what the CTA does for the browsed car, the
 * buy dialog and stepping through the line-up. Pure: strings and values only.
 */
import { CAR_IDS, CARS, type CarId, type CarSpec, type CarStats } from '../shared/cars';
import { formatPoints } from './format';
import { COIN_HTML, escapeHtml } from './screens';

const STAT_ROWS: readonly { key: keyof CarStats; label: string; color: string }[] = [
  { key: 'speed', label: 'Скорость', color: 'var(--dr-coral)' },
  { key: 'accel', label: 'Разгон', color: 'var(--dr-text)' },
  { key: 'handling', label: 'Управление', color: 'var(--dr-gold)' },
  { key: 'angle', label: 'Занос', color: 'var(--dr-green)' },
];

/** The card's stat bars for `spec` (display values, design spec §6). */
export function statsHtml(spec: CarSpec): string {
  return STAT_ROWS.map((s, i) => {
    const value = spec.stats[s.key];
    return `<li class="dr-stat" style="--c:${s.color};--v:${value / 100};--d:${0.25 + i * 0.08}s">
        <span class="dr-stat__label">${s.label}</span>
        <span class="dr-stat__val dr-num">${value}</span>
        <span class="dr-stat__bar"><i></i></span>
      </li>`;
  }).join('');
}

/** What the CTA does for the browsed car: race it, or buy it (`short`: coins missing, 0 = affordable). */
export type CtaState = { kind: 'race' } | { kind: 'buy'; price: number; short: number };

export function ctaState(id: CarId, owned: readonly CarId[], coins: number): CtaState {
  if (owned.includes(id)) return { kind: 'race' };
  const price = CARS[id].price;
  return { kind: 'buy', price, short: Math.max(0, price - coins) };
}

/** «Машина 2/4». */
export function carCountLabel(id: CarId): string {
  return `Машина ${CAR_IDS.indexOf(id) + 1}/${CAR_IDS.length}`;
}

/** The car `step` places away in the line-up, wrapping around. */
export function stepCar(id: CarId, step: number): CarId {
  const n = CAR_IDS.length;
  return CAR_IDS[(((CAR_IDS.indexOf(id) + step) % n) + n) % n];
}

/** Body of the buy confirmation dialog; its title carries `titleId` (the dialog's aria-labelledby). */
export function buyDialogHtml(spec: CarSpec, coins: number, titleId: string): string {
  return `<h2 class="dr-h dr-modal__title" id="${titleId}">Купить «${escapeHtml(spec.name)}»?</h2>
    <p class="dr-buy__text">Цена ${COIN_HTML}<b class="dr-num">${formatPoints(spec.price)}</b>. После покупки останется ${COIN_HTML}<b class="dr-num">${formatPoints(coins - spec.price)}</b>.</p>
    <div class="dr-buy__actions">
      <button type="button" class="dr-btn" data-close data-ref="cancel">Отмена</button>
      <button type="button" class="dr-btn dr-btn--primary" data-confirm-buy>Купить</button>
    </div>`;
}
```

- [ ] **Step 4: Change `src/ui/garage.ts`**

1. Header comment: "Garage overlay: top bar, car card with the line-up switcher (‹ › / ← →), track card whose CTA races an owned car or buys a locked one after a confirmation, rules / records modals."
2. Imports: add `import { CARS, type CarId } from '../shared/cars';` and `import { buyDialogHtml, carCountLabel, ctaState, statsHtml, stepCar } from './garageCar';`. Remove `CAR_STATS` and the local `statsHtml` (moved). `GarageUI.update` doc: "New save: coins pop in the wallet; records, the sound toggle and the car card follow it."
3. `type ModalKind = 'rules' | 'records' | 'buy';` and `const COIN_FORMS = ['монеты', 'монет', 'монет'] as const;` («не хватает 1 монеты / 2 монет / 5 монет»).
4. Options gain:

```ts
    /** The car the garage opens on (default: the save's selected car). */
    initialCar?: CarId;
    /** The player browsed to another car: the podium shows it (an owned one also becomes the selected car). */
    onBrowse?(id: CarId): void;
    /** «Купить» confirmed. True when the car was bought; the new save arrives through update() as well. */
    onBuy?(id: CarId): boolean;
```

5. Markup: the car section and the CTA become (everything else unchanged):

```html
    <section class="dr-panel dr-car">
      <div class="dr-eyebrow dr-car__eyebrow"><span class="dr-car__count"></span><span class="dr-car__lock"></span></div>
      <h1 class="dr-h dr-car__name"></h1>
      <div class="dr-car__class"></div>
      <p class="dr-car__tagline"></p>
      <ul class="dr-stats"></ul>
    </section>
    <div class="dr-carnav">
      <button type="button" class="dr-carnav__btn" data-step="-1" aria-label="Предыдущая машина" title="Предыдущая машина (←)">‹</button>
      <button type="button" class="dr-carnav__btn" data-step="1" aria-label="Следующая машина" title="Следующая машина (→)">›</button>
    </div>
```

```html
      <button type="button" class="dr-cta"><span class="dr-cta__label">В заезд</span><span class="dr-cta__arrows" aria-hidden="true"><i>›</i><i>›</i><i>›</i></span></button>
      <div class="dr-cta-hint"></div>
```

6. Refs and state, after the existing refs (`let save = opts.save;` must come before `browsed`):

```ts
  const carCard = qs(layer, '.dr-car');
  const carCount = qs(layer, '.dr-car__count');
  const carLock = qs(layer, '.dr-car__lock');
  const carName = qs(layer, '.dr-car__name');
  const carClass = qs(layer, '.dr-car__class');
  const carTagline = qs(layer, '.dr-car__tagline');
  const statsList = qs(layer, '.dr-stats');
  const ctaLabel = qs(layer, '.dr-cta__label');
  const ctaHint = qs(layer, '.dr-cta-hint');
  const carNavButtons = Array.from(layer.querySelectorAll<HTMLButtonElement>('.dr-carnav__btn'));
```

```ts
  /** The car on the card and the podium (owned or not). */
  let browsed: CarId = opts.initialCar ?? save.selectedCar;
  const isOwned = (id: CarId): boolean => save.ownedCars.includes(id);
```

7. New functions:

```ts
  /** The browsed car's card, the CTA (race it or buy it) and the hint under it. */
  function renderCar(): void {
    const spec = CARS[browsed];
    carCount.textContent = carCountLabel(browsed);
    carLock.textContent = isOwned(browsed) ? '' : 'Не куплена';
    carName.textContent = spec.name;
    carClass.textContent = spec.subtitle;
    carTagline.textContent = spec.tagline;
    // Rebuilt only for another car, so the bars replay their grow animation then and only then.
    if (statsList.dataset.car !== browsed) {
      statsList.innerHTML = statsHtml(spec);
      statsList.dataset.car = browsed;
    }
    const state = ctaState(browsed, save.ownedCars, save.coins);
    cta.classList.toggle('dr-cta--buy', state.kind === 'buy');
    cta.disabled = state.kind === 'buy' && state.short > 0;
    if (state.kind === 'race') {
      ctaLabel.textContent = 'В заезд';
      ctaHint.innerHTML = `или ${keyHtml('Enter')} · ${keyHtml('←')}${keyHtml('→')} машины`;
    } else {
      ctaLabel.innerHTML = `Купить <span class="dr-cta__price">${COIN_HTML}${formatPoints(state.price)}</span>`;
      ctaHint.innerHTML =
        state.short > 0
          ? `Не хватает ${COIN_HTML}<b class="dr-num">${formatPoints(state.short)}</b> ${pluralRu(state.short, COIN_FORMS)}`
          : 'Машина останется в гараже навсегда';
    }
  }

  function browse(step: number): void {
    browsed = stepCar(browsed, step);
    renderCar();
    opts.onBrowse?.(browsed);
  }

  function confirmBuy(): void {
    const bought = opts.onBuy?.(browsed) ?? false;
    closeModal();
    renderCar();
    if (bought) play(carCard, POP, { duration: 420, easing: 'ease-out' });
  }
```

Check the hint test: `formatPoints(180)` must render `180` and the text must read `… 180 монет` — `norm()` collapses whitespace; if `formatPoints` inserts a narrow no-break space for thousands only, `180` is unaffected.

8. `start()` gets a guard as its first line: `if (!isOwned(browsed)) return;` (Enter and the CTA never race a locked car).
9. `openModal`: the body, a kind class, the confirm button and the initial focus:

```ts
    el.className = `dr-modal dr-modal--${kind}`;
```

```ts
    body.innerHTML =
      kind === 'rules' ? rulesHtml() : kind === 'records' ? recordsHtml(save, board !== null) : buyDialogHtml(CARS[browsed], save.coins, MODAL_TITLE_ID);
```

```ts
    el.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('[data-confirm-buy]')) confirmBuy();
      else if (e.target.closest('[data-close]')) closeModal();
    });
    // The buy dialog starts on «Отмена»: Enter there must never spend coins.
    qs(el, kind === 'buy' ? '[data-ref="cancel"]' : '.dr-close').focus({ preventScroll: true });
```

10. `closeModal`: also `opener.classList.remove('is-open');` (the CTA can be an opener now).
11. Listeners: replace `cta.addEventListener('click', start);` with

```ts
  const onCta = (e: MouseEvent): void => {
    if (isOwned(browsed)) start();
    // detail === 0: keyboard activation; focus returns to the CTA when the dialog closes.
    else openModal('buy', cta, e.detail === 0);
  };
  cta.addEventListener('click', onCta);
  const onCarNav = (e: MouseEvent): void => {
    const btn = e.currentTarget as HTMLButtonElement;
    // A pointer click must not leave focus on the arrow, or the next Enter would step again instead of racing.
    if (e.detail !== 0) btn.blur();
    browse(Number(btn.dataset.step));
  };
  for (const b of carNavButtons) b.addEventListener('click', onCarNav);
```

12. `onKey`: before the `Enter` branch add

```ts
    } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !modal && !isTextField(e.target)) {
      e.preventDefault();
      browse(e.code === 'ArrowLeft' ? -1 : 1);
```

13. Initial render: `render(null); renderCar();`. In `update(next)`: after `render(prevCoins);` add `renderCar();`.

- [ ] **Step 5: Styles** (append to the garage block of `src/ui/styles.css`, after `.dr-cta-hint`)

```css
.dr-car__eyebrow { display: flex; justify-content: space-between; gap: 1em; }
.dr-car__lock { color: var(--dr-gold); }
.dr-car__tagline { margin: 0.9em 0 0; font-size: 0.86em; line-height: 1.45; color: var(--dr-muted); }
.dr-carnav { position: absolute; inset: 0; pointer-events: none; }
.dr-carnav__btn { pointer-events: auto; position: absolute; top: 50%; width: 2.4em; height: 2.4em; margin-top: -1.2em; display: grid; place-items: center; border: 1px solid var(--dr-border-hi); border-radius: 50%; background: rgb(20 15 14 / 0.6); color: var(--dr-text); font-family: var(--dr-head); font-size: 1.5em; line-height: 1; transition: transform 0.15s var(--dr-ease), border-color 0.15s; }
.dr-carnav__btn:hover { border-color: var(--dr-coral); transform: scale(1.06); }
.dr-carnav__btn[data-step="-1"] { left: calc(50% - 6.5em); }
.dr-carnav__btn[data-step="1"] { right: calc(50% - 6.5em); }
.dr-cta--buy { color: #1a1310; }
.dr-cta--buy::before { background: linear-gradient(100deg, var(--dr-gold) 0%, #ffd27a 100%); }
.dr-cta--buy::after { background: var(--dr-gold); }
.dr-cta--buy .dr-cta__arrows { display: none; }
.dr-cta:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.dr-cta__price { display: inline-flex; align-items: center; gap: 0.3em; margin-left: 0.4em; }
.dr-modal--buy .dr-modal__card { width: min(28em, calc(100% - 3em)); }
.dr-buy__text { margin: 0.8em 0 0; line-height: 1.5; }
.dr-buy__actions { display: flex; justify-content: flex-end; gap: 0.6em; margin-top: 1.4em; }
```

Check the custom properties exist (`grep -n "\-\-dr-gold\|--dr-muted\|--dr-border-hi\|--dr-text" src/ui/styles.css`); use the file's names if they differ. Arrow positions are tuned visually in Task 11.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/ui && npx tsc --noEmit`
Expected: PASS. If an older garage test asserted the CTA's exact text or the old «Ваша машина» eyebrow, update it to the new markup (do not weaken what it checks).

- [ ] **Step 7: Commit**

```bash
git add src/ui/garageCar.ts src/ui/garage.ts src/ui/garage.test.ts src/ui/styles.css
git commit -m "feat(ui): browse the car line-up and buy cars in the garage"
```

---

### Task 10: Garage screen wiring and the preview URL

**Files:**
- Modify: `src/app/garageScreen.ts`, `src/app/main.ts`
- Test: `src/ui/garage.test.ts` (`enterGarage` suite)

- [ ] **Step 1: Write the failing test** (a new describe at the end of `src/ui/garage.test.ts`, built like the existing `enterGarage mute wiring (jsdom)` suite; that suite's inline fake `garage` also needs `setCar: () => {}` now)

```ts
describe('enterGarage line-up wiring (jsdom)', () => {
  it('shows the browsed car on the podium and selects it when owned', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let save: SaveData = { ...SAVE, ownedCars: ['iskra', 'ronin'] };
    const shown: string[] = [];
    const selected: string[] = [];
    const app = {
      ui: root,
      garage: { scene: {}, camera: {}, update: () => {}, setCar: (id: string) => shown.push(id) },
      renderer: { render: () => {} },
      track: { def: { name: 'Площадь' } },
      input: { setRacing: () => {} },
      audio: { setEngineActive: () => {}, unlock: () => Promise.resolve() },
      get save() {
        return save;
      },
      updateSave: (change: (s: SaveData) => SaveData) => {
        save = change(save);
        selected.push(save.selectedCar);
        return save;
      },
      setMuted: () => {},
      onSaveChanged: () => () => {},
      screen: 'loading',
      redraw: null,
      frameDone: () => {},
    } as unknown as App;
    const screen = enterGarage(app, { lastShown: null, onStart: () => {} });
    expect(shown).toEqual(['iskra']);
    keydown('ArrowRight'); // Квадро: not owned
    keydown('ArrowRight'); // Ронин: owned
    expect(shown).toEqual(['iskra', 'quadro', 'ronin']);
    expect(selected).toEqual(['ronin']);
    screen.destroy();
    root.remove();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/ui/garage.test.ts`
Expected: FAIL — `setCar` never called.

- [ ] **Step 3: Implement `src/app/garageScreen.ts`**

```ts
import { selectCar, purchaseCar } from './carShop';
import type { CarId } from '../shared/cars';
```

```ts
export function enterGarage(
  app: App,
  opts: {
    lastShown: SaveData | null;
    onStart(): void;
    /** Test preview (`?test&car=<id>`): open on this car without changing the save. */
    previewCar?: CarId | null;
  },
): GarageScreen {
```

Before `createGarageUI`:

```ts
  const initialCar = opts.previewCar ?? app.save.selectedCar;
  garage.setCar(initialCar);

  /** The podium follows the browsed car; an owned one becomes the car of the next race. */
  function browse(id: CarId): void {
    garage.setCar(id);
    if (app.save.ownedCars.includes(id) && app.save.selectedCar !== id) app.updateSave((s) => selectCar(s, id));
  }
```

and pass `initialCar, onBrowse: browse, onBuy: (id) => purchaseCar(app, id).ok,` to `createGarageUI`. (A purchase writes through `app.updateSave`; `onSaveChanged` then calls `ui.update`, so the card and wallet follow.)

- [ ] **Step 4: `src/app/main.ts`**

```ts
import { isCarId } from '../shared/cars';
```

After `const { test, quality: forced } = testFlagsFrom(params);`:

```ts
  // `?test&car=<id>`: the garage opens on that car (screenshots of every body); the save is not changed.
  const carParam = params.get('car');
  const previewCar = test.enabled && isCarId(carParam) ? carParam : null;
```

In `goGarage`: `garageScreen = enterGarage(app, { lastShown: lastShownSave, onStart: goRace, previewCar });`

Mention the parameter in `README.md`'s test-mode paragraph: «`?test&full&car=ronin` — гараж открывается на нужной машине (скриншоты кузовов)».

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/garageScreen.ts src/app/main.ts src/ui/garage.test.ts README.md
git commit -m "feat(app): wire the garage line-up, purchases and the car preview URL"
```

---

### Task 11: Visual pass on the bodies

**Files:**
- Modify: `src/render/bodies/quadro.ts`, `ronin.ts`, `scarab.ts` (shapes, colours), `src/ui/styles.css` (arrow placement)

- [ ] **Step 1: Screenshot every car in the garage**

```bash
npm run build && (npx vite preview --port 4173 >/dev/null 2>&1 &) && sleep 2
for id in iskra quadro ronin scarab; do
  node scripts/screenshot.mjs "http://127.0.0.1:4173/?test&full&car=$id" "temp/cars/$id.png" 1280 720 15000
done
```

The turntable turns over time: for more angles, repeat with a different `waitMs` (last argument) or a 4000 ms longer sleep before the shot.

- [ ] **Step 2: Review and iterate**

Open each PNG (Read tool). Check, per car:
- reads as its inspiration at a glance: «Квадро» — boxy three-box sedan, quad round lamps, kidneys, flares; «Ронин» — long hood, set-back low cabin, big wing, four round tail lights; «Скарабей» — bug-eyes on the wings, fastback, wide haunches, ducktail;
- no gaps between glass, roof and decks; no z-fighting (coplanar faces flicker: offset by ≥ 0.005 m);
- the paint reads well under the garage lights (white not blown out; yellow not greenish; blue not black);
- the wheels show below the body and nothing pokes through the podium;
- the ‹ › arrows flank the podium without covering the car or the side panels at 1280×720 and 1920×1080 (screenshot both).

Adjust positions, sizes and colours in the body files; re-run `npx vitest run src/render/carModel.test.ts` after each change (the footprint must hold) and re-shoot. Two or three rounds are expected. Delete `temp/cars` when done.

- [ ] **Step 3: Commit**

```bash
git add src/render/bodies src/ui/styles.css
git commit -m "fix(render): tune the new bodies after the screenshot review"
```

---

### Task 12: End-to-end: buy a car and race it

**Files:**
- Create: `tests/e2e/cars.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/cars.spec.ts
/** Buying a car in the garage and racing it (plan/2026-10-04-sport-cars.md), on the production build. */
import { expect, test } from '@playwright/test';

const SAVE_KEY = 'driftRally.save.v1';
/** TUNING.race.physicsHz. */
const HZ = 120;

test('buy «Квадро» in the garage and race it', async ({ page }, info) => {
  await page.addInitScript(
    ([key]) => {
      if (localStorage.getItem(key) !== null) return;
      localStorage.setItem(key, JSON.stringify({
        version: 1, coins: 500, bestScore: 0, bestLapMs: null, quality: null, muted: true,
        ownedCars: ['iskra'], selectedCar: 'iskra', bestScoreCar: null,
      }));
    },
    [SAVE_KEY],
  );
  await page.goto('./?test');
  await expect(page.locator('.dr-cta')).toContainText('В ЗАЕЗД', { useInnerText: true, timeout: 120_000 });

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.dr-car__name')).toHaveText('Квадро');
  await expect(page.locator('.dr-cta')).toContainText('Купить');
  await page.locator('.dr-cta').click();
  await page.locator('[data-confirm-buy]').click();
  await expect(page.locator('.dr-cta')).toContainText('В ЗАЕЗД', { useInnerText: true });

  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), SAVE_KEY);
  expect(saved).toMatchObject({ coins: 200, ownedCars: ['iskra', 'quadro'], selectedCar: 'quadro' });

  await page.evaluate(() => window.__game!.startRace());
  expect(await page.evaluate(() => window.__game!.state().car)).toBe('quadro');
  await page.evaluate((n) => window.__game!.autopilot(n), 8 * HZ);
  const st = await page.evaluate(() => window.__game!.state());
  expect(st.phase).toBe('racing');
  expect(st.speed).toBeGreaterThan(5);
  const path = info.outputPath('quadro-race.png');
  await page.screenshot({ path });
  await info.attach('quadro-race', { path, contentType: 'image/png' });
});
```

- [ ] **Step 2: Run it**

Run: `npm run e2e -- tests/e2e/cars.spec.ts` (no GPU: `npm run e2e:software -- tests/e2e/cars.spec.ts`)
Expected: PASS. Open the attached `quadro-race.png` from `test-results/` and check the car looks right from the chase camera.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/cars.spec.ts
git commit -m "test(e2e): buy a car in the garage and race it"
```

---

### Task 13: The car of the record on the friends table (client)

**Files:**
- Modify: `src/shared/leaderboard.ts`, `src/core/leaderboardApi.ts`, `src/app/leaderboard.ts`, `src/ui/leaderboardView.ts`, `src/ui/styles.css`
- Test: `src/core/leaderboardApi.test.ts`, `src/app/leaderboard.test.ts`, `src/ui/leaderboardUi.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/core/leaderboardApi.test.ts` (reuse the file's `fakeFetch` / `json` / `api` helpers):

```ts
  it('reads the car of each best and ignores unknown cars', async () => {
    const rows = [
      { place: 1, nick: 'Ёжик', best_score: 900, best_lap_ms: 50000, best_car: 'ronin' },
      { place: 2, nick: 'Вася', best_score: 800, best_lap_ms: null, best_car: 'bmw' },
      { place: 3, nick: 'Петя', best_score: 700, best_lap_ms: null, best_car: null },
    ];
    const r = await api(fakeFetch(json(rows)).fetch).board(null);
    expect(r.ok && r.value.top.map((row) => row.car)).toEqual(['ronin', undefined, undefined]);
  });

  it('sends the car of the best score', async () => {
    const { fetch, calls } = fakeFetch(json({ nick: 'Ёжик', place: 3, total: 12, best_score: 1500, best_lap_ms: 52000 }));
    await api(fetch).submit({ key: 'k'.repeat(64), nick: 'Ёжик', score: 1500, lapMs: 52000, races: 1, car: 'scarab' });
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ p_car: 'scarab' });
  });
```

(Use the helpers' real names and shapes from the file; the existing submit test's `toEqual` on the body gains `p_car`.)

`src/ui/leaderboardUi.test.ts`: a row with `car: 'ronin'` renders `Ронин` in `.dr-board__car` inside the nick cell; a row without `car` renders no `.dr-board__car`.

`src/app/leaderboard.test.ts`: the exact `toHaveBeenCalledWith({ key: KEY, nick: 'Ёжик', score: 1500, lapMs: 52000, races: 3 })` (line ~58) gains `car: null` (its save has no record car); add a test next to it where the save has `bestScoreCar: 'quadro'` and the submit carries `car: 'quadro'` (copy that test's setup).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/leaderboardApi.test.ts src/app/leaderboard.test.ts src/ui/leaderboardUi.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/shared/leaderboard.ts`: `import type { CarId } from './cars';` and in `BoardRow`:

```ts
  /** The car of the best score; absent when unknown (a record from before the line-up, or a car this version does not know). */
  car?: CarId;
```

`src/core/leaderboardApi.ts`:

```ts
import { isCarId, type CarId } from '../shared/cars';
```

`SubmitRequest` gains `/** The car of the best score, null when unknown. */ car: CarId | null;`. `const ROW_COLUMNS = 'place,nick,best_score,best_lap_ms,best_car';`. In `parseRow`:

```ts
  const row: BoardRow = { place, nick: v.nick, score, lapMs: lap };
  if (isCarId(v.best_car)) row.car = v.best_car;
  return row;
```

In `submit`, the RPC body gains `p_car: req.car,`.

`src/app/leaderboard.ts`: the object that `bests(save)` returns gains `car: save.bestScoreCar` (read the function; it is spread into `api.submit({ key, nick, ...bests(...), races })`).

`src/ui/leaderboardView.ts`:

```ts
import { CARS } from '../shared/cars';
```

```ts
      <td class="dr-board__nick">${escapeHtml(r.nick)}${r.car ? `<span class="dr-board__car">${escapeHtml(CARS[r.car].name)}</span>` : ''}</td>
```

`src/ui/styles.css` (next to the other `.dr-board` rules): `.dr-board__car { display: block; font-size: 0.78em; color: var(--dr-muted); }`

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/leaderboard.ts src/core/leaderboardApi.ts src/core/leaderboardApi.test.ts src/app/leaderboard.ts src/app/leaderboard.test.ts src/ui/leaderboardView.ts src/ui/leaderboardUi.test.ts src/ui/styles.css
git commit -m "feat(ui): show the car of each record on the friends table"
```

---

### Task 14: Database: `best_car` (migration, applied only with the user's go-ahead)

**Files:**
- Create: `supabase/migrations/20261004120000_leaderboard_best_car.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Friends leaderboard: remember which car set each player's best score (plan/2026-10-04-sport-cars.md).
--
-- submit_result gains p_car (default null, so clients that do not send it keep working). The table keeps the car
-- of the best score: it changes only when the score improves. The 5-argument submit_result is dropped, not
-- overloaded: with both, PostgREST could not choose between them for a call without p_car.
--
-- Apply BEFORE deploying a client that sends p_car: an older database answers such a call with "function not
-- found", and the client keeps those finishes queued as offline until the migration lands.

alter table public.leaderboard
  add column best_car text,
  add constraint leaderboard_car_format check (best_car is null or best_car ~ '^[a-z][a-z0-9-]{1,23}$');

grant select (best_car) on public.leaderboard to anon, authenticated;

-- New columns go last, so the view can be replaced in place.
create or replace view public.leaderboard_ranked with (security_invoker = true) as
  select
    rank() over (order by best_score desc, best_lap_ms asc nulls last)::integer as place,
    nick,
    best_score,
    best_lap_ms,
    best_car
  from public.leaderboard;

create or replace function leaderboard_private.standing(p_hash bytea)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'nick', r.nick,
    'place', r.place,
    'total', r.total,
    'best_score', r.best_score,
    'best_lap_ms', r.best_lap_ms,
    'best_car', r.best_car
  )
  from (
    select
      key_hash,
      nick,
      best_score,
      best_lap_ms,
      best_car,
      rank() over (order by best_score desc, best_lap_ms asc nulls last)::integer as place,
      count(*) over ()::integer as total
    from public.leaderboard
  ) r
  where r.key_hash = p_hash;
$$;

revoke all on function leaderboard_private.standing(bytea) from public, anon, authenticated;

drop function public.submit_result(text, text, integer, integer, integer);

/**
 * Record finished races under the browser key (see 20261003150000_leaderboard.sql). p_car: the car of p_score;
 * stored when the score improves. Errors (message): bad_key, bad_nick, bad_score, bad_lap, bad_races, bad_car,
 * nick_taken, rate_limited.
 */
create function public.submit_result(
  p_key text,
  p_nick text,
  p_score integer,
  p_lap_ms integer,
  p_races integer default 1,
  p_car text default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea := leaderboard_private.key_hash(p_key);
  v_row public.leaderboard%rowtype;
  v_constraint text;
begin
  perform leaderboard_private.check_nick(p_nick);
  if p_score is null or p_score < 0 or p_score > 200000 then
    raise exception 'bad_score' using errcode = 'P0001';
  end if;
  if p_lap_ms is not null and (p_lap_ms < 30000 or p_lap_ms > 3600000) then
    raise exception 'bad_lap' using errcode = 'P0001';
  end if;
  if p_races is null or p_races < 1 or p_races > 100 then
    raise exception 'bad_races' using errcode = 'P0001';
  end if;
  if p_car is not null and p_car !~ '^[a-z][a-z0-9-]{1,23}$' then
    raise exception 'bad_car' using errcode = 'P0001';
  end if;

  select * into v_row from public.leaderboard where key_hash = v_hash for update;

  begin
    if found then
      if v_row.submitted_at > now() - interval '10 seconds' then
        raise exception 'rate_limited' using errcode = 'P0001';
      end if;
      update public.leaderboard
      set
        nick = p_nick,
        best_score = greatest(best_score, p_score),
        -- SET expressions see the row before the update: the car follows the score only when it improves.
        best_car = case when p_score > best_score then p_car else best_car end,
        best_lap_ms = case
          when p_lap_ms is null then best_lap_ms
          when best_lap_ms is null then p_lap_ms
          else least(best_lap_ms, p_lap_ms)
        end,
        races = races + p_races,
        updated_at = case
          when p_score > best_score or (p_lap_ms is not null and (best_lap_ms is null or p_lap_ms < best_lap_ms))
            then now()
          else updated_at
        end,
        submitted_at = now()
      where id = v_row.id;
    else
      if (select count(*) from public.leaderboard where created_at > now() - interval '1 minute') >= 20 then
        raise exception 'rate_limited' using errcode = 'P0001';
      end if;
      insert into public.leaderboard (nick, key_hash, best_score, best_lap_ms, races, best_car)
      values (p_nick, v_hash, p_score, p_lap_ms, p_races, p_car);
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'leaderboard_nick_ci' then
      raise exception 'nick_taken' using errcode = 'P0001';
    end if;
    -- The same key inserted concurrently (two tabs): the other call won.
    raise exception 'rate_limited' using errcode = 'P0001';
  end;

  return leaderboard_private.standing(v_hash);
end;
$$;

revoke all on function public.submit_result(text, text, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.submit_result(text, text, integer, integer, integer, text) to anon, authenticated;
```

Before writing, re-read both existing migrations and copy any rule of the latest `submit_result` that differs from the body above (the body above is the 20261003170000 version plus `p_car`).

- [ ] **Step 2: Commit the file**

```bash
git add supabase/migrations/20261004120000_leaderboard_best_car.sql
git commit -m "feat(db): keep the car of each player's best score"
```

- [ ] **Step 3: STOP — ask the user before touching the live database**

Applying changes the production friends table. Ask the user explicitly; only on a yes:
1. apply with the Supabase MCP `apply_migration` (name `leaderboard_best_car`, query = the file's contents);
2. verify with `execute_sql`: `select pg_get_function_identity_arguments('public.submit_result'::regproc);` → `p_key text, p_nick text, p_score integer, p_lap_ms integer, p_races integer, p_car text`, and `select best_car from public.leaderboard_ranked limit 1;` runs without error;
3. run `get_advisors` (security) and report anything new.

No test rows are written to the live table. If the user says no or later, record in the final report that the migration is pending and that the client must not be released before it lands.

---

### Task 15: Docs, full verification, review

**Files:**
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: CHANGELOG** (`## [Unreleased]`, Russian, player-facing)

```markdown
## [Unreleased]

### Добавлено
- Три дрифт-машины в гараже: «Квадро» (300 монет), «Ронин» (900) и «Скарабей» (2000). У каждой свой характер:
  угол и скорость заноса, разгон, отклик на руль. Чем дороже машина, тем больше угол — и тем больше очков.
- Выбор машины в гараже: стрелки ‹ › по бокам подиума или ← →. Покупка — с подтверждением.
- В таблице друзей под ником видно, на какой машине поставлен рекорд.

### Изменено
- В карточке машины вместо «Сцепления» — «Занос».
```

- [ ] **Step 2: README** — in the intro paragraph after «Игрушечная машинка «Искра» носится…» add: «За монеты в гараже покупаются ещё три дрифт-машины со своим характером.» (the `?car=` note was added in Task 10).

- [ ] **Step 3: Full verification**

```bash
npm test
npm run typecheck
npm run build
npm run e2e        # or: npm run e2e:software
```

Expected: every unit suite passes (711 before this work + the new ones), no type errors, the build succeeds, both e2e specs (smoke, leaderboard, cars) pass. Paste the summary lines into the final report.

- [ ] **Step 4: Code review**

Dispatch the `code-reviewer` agent on `git diff develop...feature/sport-cars`; fix confirmed findings in focused commits.

- [ ] **Step 5: Commit the docs**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog and README for the car line-up"
```

Do not push, merge or release: the user decides (release steps: memory «release-versioning»; the migration must be live before the client ships).

---

## Follow-ups (not in this plan)

- Engine voice per car (E30 four, RB-style six, flat six): `sfx.ts` builds the loop voices once; switching needs a rebuild per car and new presets tuned by ear in the sound lab.
- Paint choice per car; per-car leaderboards; the car on the results screen.
