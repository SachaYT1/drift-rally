# Bombs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cartoon bombs on «Площадь» that, when driven over, throw the car and burn the unbanked drift chain like a heavy wall hit; back every lap.

**Architecture:** Pure simulation first: track data (`BombDef` -> `BombSpot`), a blast impulse (`physics/blast.ts`, sharing `enterRecover` with the heavy-hit response), a per-lap bomb state (`game/bombs.ts`), session wiring and a `bombed` burn reason in the drift score. Then placement + autopilot avoidance, then presentation (bomb models layer, fx, car hop, camera shake, sound) and texts.

**Tech Stack:** TypeScript, three.js, Web Audio, Vitest (`npm test`), Playwright (`npm run e2e:software`).

Spec: `plan/2026-10-04-bombs-design.md`. Branch: `feature/bombs`. Commit after every task (Conventional Commits, no push).
Commands: `npx vitest run <file>` for one file, `npm test` for all, `npm run typecheck`.

---

### Task 1: Bomb data in the track

**Files:**
- Modify: `src/track/trackDef.ts` (BombDef, TrackDef.bombs), `src/shared/types.ts` (BombSpot, 'bomb' event),
  `src/shared/tuning.ts` (bomb section), `src/track/build.ts` (Track.bombs), `src/track/plaza.ts` (`bombs: []`),
  `src/game/testTracks.ts` (extras.bombs)
- Test: `src/track/build.test.ts` (CIRCLE def gets a bomb)

- [ ] **Step 1: failing test** — in `build.test.ts` add `bombs: [{ id: 'b', s: 150, lateral: 1.5 }]` to `CIRCLE` and:

```ts
  it('places bombs at (s, lateral) with the tuning radius', () => {
    const p = circle.poseAt(150, 1.5);
    expect(circle.bombs).toEqual([{ id: 'b', x: p.x, z: p.z, r: TUNING.bomb.radius }]);
  });
```

- [ ] **Step 2:** `npx vitest run src/track/build.test.ts` → FAIL (type error / `bombs` undefined).
- [ ] **Step 3: implement**

`trackDef.ts`:
```ts
/** Bomb on the road: blows up when the car touches it (burns the chain, throws the car); back every lap. */
export interface BombDef {
  id: string;
  s: number;
  lateral: number;
}
// TrackDef, after `light`:
  bombs: BombDef[];
```
`types.ts`:
```ts
export interface BombSpot {
  id: string;
  x: number;
  z: number;
  /** Trigger radius, m (tuning.bomb.radius). */
  r: number;
}
// GameEvent, after propKnocked:
  | { type: 'bomb'; id: string; x: number; z: number }
```
`tuning.ts`, after `pickups`:
```ts
  bomb: {
    /** Trigger radius tested against the car capsule, m; also the model's radius. */
    radius: 0.8,
    /** Share of the car velocity kept through a blast. */
    speedKeep: 0.45,
    /** Velocity added away from the bomb centre, m/s. */
    push: 7,
    /** Spin added by a bomb under one end of the car, rad/s. */
    yawKick: 2.5,
    /** The camera shakes as for a heavy hit at this impact speed, m/s. */
    shakeImpact: 14,
  },
```
`build.ts`: `Track.bombs: BombSpot[]` (doc: "Bombs, world positions; r = tuning.bomb.radius."), built as
```ts
  const bombs: BombSpot[] = def.bombs.map((b) => {
    const p = poseAt(b.s, b.lateral);
    return { id: b.id, x: p.x, z: p.z, r: t.bomb.radius };
  });
```
`plaza.ts`: `bombs: []` (filled in Task 7). `testTracks.ts`: `extras.bombs?: BombSpot[]`, `bombs: extras.bombs ?? []`.

- [ ] **Step 4:** `npx vitest run src/track` → PASS; `npm run typecheck` → clean.
- [ ] **Step 5:** commit `feat(track): bomb spots in the track data`.

### Task 2: Shared trigger overlap helper (refactor)

**Files:** Create `src/game/overlap.ts`; modify `src/game/pickups.ts` (import it, drop the local copy).

```ts
/** Car-capsule-vs-circle trigger test shared by pickups and bombs. Pure. */
import type { CarState } from '../shared/types';
import type { Tuning } from '../shared/tuning';
import type { carCapsule } from '../physics/car';
import { capsuleOverlapsCircle } from '../physics/collision';

export type Capsule = ReturnType<typeof carCapsule>;

/**
 * Cheap centre-distance precheck (pickups.nearRadius, widened when the capsule reach is larger),
 * then the exact capsule-vs-circle test. NaN-safe (no overlap).
 */
export function touches(car: CarState, cap: Capsule, x: number, z: number, r: number, t: Tuning): boolean {
  const near = Math.max(t.pickups.nearRadius, t.car.capsuleHalf + t.car.radius + r);
  const dx = x - car.x;
  const dz = z - car.z;
  return dx * dx + dz * dz <= near * near && capsuleOverlapsCircle(cap, x, z, r);
}
```
- [ ] `npx vitest run src/game/pickups.test.ts` → PASS (behaviour unchanged). Commit `refactor(game): share the trigger overlap test`.

### Task 3: Blast impulse and the shared recovery entry

**Files:** Create `src/physics/recover.ts`, `src/physics/blast.ts`, `src/physics/blast.test.ts`; modify `src/physics/collision.ts` (`respond` uses `enterRecover`).

- [ ] **Step 1: failing tests** `blast.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { applyBlast } from './blast';
import { createCarState, withDerived } from './car';
import { TUNING } from '../shared/tuning';
import type { CarState } from '../shared/types';

const B = TUNING.bomb;
/** Car at the origin heading +z (forward (0, 1), left (1, 0)) at 20 m/s, drifting. */
const car = (over: Partial<CarState> = {}): CarState =>
  withDerived({ ...createCarState(0, 0, 0), vz: 20, mode: 'drift', driftDir: 1, driftTime: 2, gripBlend: 0.4, ...over });

describe('applyBlast', () => {
  it('keeps speedKeep of the velocity and pushes away from the bomb', () => {
    const r = applyBlast(car(), 0, 1); // under the nose: pushed back
    expect(r.vx).toBeCloseTo(0, 9);
    expect(r.vz).toBeCloseTo(20 * B.speedKeep - B.push, 9);
    expect(r.speed).toBeCloseTo(Math.abs(20 * B.speedKeep - B.push), 9);
    const side = applyBlast(car(), 0.5, 0); // on the left: pushed right
    expect(side.vx).toBeCloseTo(-B.push, 9);
    expect(side.vz).toBeCloseTo(20 * B.speedKeep, 9);
  });

  it('throws the end of the car over the bomb away from it', () => {
    expect(applyBlast(car(), 0.5, 1).yawRate).toBeCloseTo(-B.yawKick, 9); // front left: nose right
    expect(applyBlast(car(), 0.5, -1).yawRate).toBeCloseTo(B.yawKick, 9); // rear left: nose left
    expect(applyBlast(car(), -0.5, 1).yawRate).toBeCloseTo(B.yawKick, 9); // front right: nose left
    expect(applyBlast(car(), 0, 1).yawRate).toBeCloseTo(0, 9); // on the axis
    expect(applyBlast(car(), 0.5, 0).yawRate).toBeCloseTo(0, 9); // beside the centre
  });

  it('enters recovery and leaves the drift like a heavy hit', () => {
    expect(applyBlast(car(), 0.5, 1)).toMatchObject({
      mode: 'recover', modeTimer: TUNING.drift.recoverTime, driftDir: 0, driftTime: 0, gripBlend: 0,
    });
    const grip = applyBlast(car({ mode: 'grip', driftDir: 0, driftTime: 0, gripBlend: 1 }), 0.5, 1);
    expect(grip).toMatchObject({ mode: 'recover', gripBlend: 1 });
  });

  it('on top of the car centre pushes sideways away from the bomb side, left when exactly centred', () => {
    const exact = applyBlast(car(), 0, 0);
    expect(exact.vx).toBeCloseTo(B.push, 9);
    const nearLeft = applyBlast(car(), 1e-4, 0);
    expect(nearLeft.vx).toBeCloseTo(-B.push, 9);
    for (const r of [exact, nearLeft])
      for (const v of Object.values(r)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('never mutates the input car', () => {
    const c = Object.freeze(car());
    applyBlast(c, 0.5, 1);
    expect(c.vz).toBe(20);
  });
});
```
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3: implement**

`recover.ts`:
```ts
/** The car knocked out of control (heavy hit, bomb blast). Pure. */
import type { CarState } from '../shared/types';
import type { Tuning } from '../shared/tuning';

/**
 * Recovery mode for drift.recoverTime. Leaving a drift resets the same fields as a normal drift exit
 * (car.ts exitDrift): the drift clock restarts and lateral grip blends back in (no jolt).
 */
export function enterRecover(s: CarState, t: Tuning): CarState {
  return {
    ...s,
    mode: 'recover',
    modeTimer: t.drift.recoverTime,
    driftDir: 0,
    ...(s.mode === 'drift' ? { driftTime: 0, gripBlend: 0 } : {}),
  };
}
```
`collision.ts` `respond`: `const state = enterRecover({ ...s, x, z, vx, vz, yawRate: s.yawRate + ... }, t);`

`blast.ts`:
```ts
/** Bomb blast impulse on the car. Pure. See plan/2026-10-04-bombs-design.md. */
import type { CarState } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { withDerived } from './car';
import { enterRecover } from './recover';

/** Closer than this (m) the bomb counts as under the car centre: the push goes sideways. */
const MIN_DIST = 1e-3;

/**
 * The car thrown by a bomb at (bx, bz): velocity * bomb.speedKeep + bomb.push away from the bomb centre;
 * the end of the car over the bomb is thrown away from it (yawRate -= yawKick * sign(lat) * sign(lon), with
 * lat/lon the bomb offset in the body frame, + = left / forward); then recovery as after a heavy hit.
 */
export function applyBlast(car: CarState, bx: number, bz: number, t: Tuning = TUNING): CarState {
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const dx = bx - car.x;
  const dz = bz - car.z;
  // Body frame: forward (fx, fz), left (fz, -fx).
  const lon = dx * fx + dz * fz;
  const lat = dx * fz - dz * fx;
  const dist = Math.hypot(dx, dz);
  // Away from the bomb; with the bomb under the centre, sideways away from its side (left when centred).
  const side = lat > 0 ? -1 : 1;
  const nx = dist > MIN_DIST ? -dx / dist : side * fz;
  const nz = dist > MIN_DIST ? -dz / dist : -side * fx;
  const b = t.bomb;
  const thrown: CarState = {
    ...car,
    vx: car.vx * b.speedKeep + nx * b.push,
    vz: car.vz * b.speedKeep + nz * b.push,
    yawRate: car.yawRate - b.yawKick * Math.sign(lat) * Math.sign(lon),
  };
  return withDerived(enterRecover(thrown, t), t);
}
```
- [ ] **Step 4:** `npx vitest run src/physics` → PASS (collision tests unchanged).
- [ ] **Step 5:** commit `feat(physics): bomb blast impulse`.

### Task 4: Per-lap bomb state

**Files:** Create `src/game/bombs.ts`, `src/game/bombs.test.ts`.

- [ ] **Step 1: failing tests**
```ts
import { describe, expect, it } from 'vitest';
import { createBombs, resetBombs, updateBombs } from './bombs';
import { makeCircleTrack } from './testTracks';
import { createCarState, withDerived } from '../physics/car';
import { TUNING } from '../shared/tuning';
import type { BombSpot } from '../shared/types';

const bomb = (id: string, x: number, z: number): BombSpot => ({ id, x, z, r: TUNING.bomb.radius });
/** Car at (0, z) heading +z at 20 m/s; its capsule axis spans z +/- capsuleHalf. */
const car = (z = 0) => withDerived({ ...createCarState(0, z, 0), vz: 20 });
const track = makeCircleTrack(100, { bombs: [bomb('b1', 0.5, 1.5), bomb('far', 0, 30)] });

describe('bombs', () => {
  it('blows a touched bomb once per lap and throws the car', () => {
    const r1 = updateBombs(createBombs(), track, car());
    expect(r1.events).toEqual([{ type: 'bomb', id: 'b1', x: 0.5, z: 1.5 }]);
    expect(r1.blasted).toBe(true);
    expect(r1.state.blown).toEqual(new Set(['b1']));
    expect(r1.car.mode).toBe('recover');
    expect(r1.car.speed).toBeLessThan(20);
    const r2 = updateBombs(r1.state, track, car());
    expect(r2).toMatchObject({ events: [], blasted: false, state: r1.state });
  });

  it('resetBombs brings every bomb back; an untouched state is kept as is', () => {
    const fresh = resetBombs(updateBombs(createBombs(), track, car()).state);
    expect(fresh.blown.size).toBe(0);
    expect(updateBombs(fresh, track, car()).blasted).toBe(true);
    const idle = createBombs();
    expect(resetBombs(idle)).toBe(idle);
  });

  it('leaves car and state untouched with no bomb in reach', () => {
    const c = car(10);
    const s = createBombs();
    const res = updateBombs(s, track, c);
    expect(res.car).toBe(c);
    expect(res.state).toBe(s);
    expect(res.events).toEqual([]);
  });

  it('two bombs touched at once both blow; the car takes one blast, from the nearer', () => {
    const two = makeCircleTrack(100, { bombs: [bomb('a', 0.6, 1.8), bomb('b', -0.3, -0.4)] });
    const res = updateBombs(createBombs(), two, car());
    expect(res.events.map((e) => (e as { id: string }).id)).toEqual(['a', 'b']);
    expect(res.state.blown).toEqual(new Set(['a', 'b']));
    const onlyB = updateBombs(createBombs(), makeCircleTrack(100, { bombs: [bomb('b', -0.3, -0.4)] }), car());
    expect(res.car).toEqual(onlyB.car);
  });

  it('blows nothing for a non-finite car and never mutates its inputs', () => {
    expect(updateBombs(createBombs(), track, { ...car(), x: Number.NaN })).toMatchObject({ events: [], blasted: false });
    const s = createBombs();
    const c = Object.freeze(car());
    updateBombs(s, track, c);
    expect(s.blown.size).toBe(0);
    expect(c.vz).toBe(20);
  });
});
```
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement** `bombs.ts`:
```ts
/** Bombs on the road: a touch blows one up once per lap, throwing the car. Pure. See plan/2026-10-04-bombs-design.md. */
import type { CarState, GameEvent } from '../shared/types';
import { TUNING, type Tuning } from '../shared/tuning';
import { carCapsule } from '../physics/car';
import { applyBlast } from '../physics/blast';
import type { Track } from '../track/build';
import { touches } from './overlap';

export interface BombState {
  /** Bomb ids blown in the current lap. Replaced (never mutated) on change. */
  blown: ReadonlySet<string>;
}

export function createBombs(): BombState {
  return { blown: new Set<string>() };
}

/** New lap: every bomb is back (the same object when none was blown). */
export function resetBombs(state: BombState): BombState {
  return state.blown.size === 0 ? state : createBombs();
}

/**
 * Blow up every not-yet-blown bomb overlapping the car capsule; each emits 'bomb'. The car takes one blast
 * per step, from the touched bomb nearest its centre. `blasted` tells the session to burn the chain.
 */
export function updateBombs(
  state: BombState,
  track: Track,
  car: CarState,
  t: Tuning = TUNING,
): { state: BombState; car: CarState; events: GameEvent[]; blasted: boolean } {
  const events: GameEvent[] = [];
  if (track.bombs.length === 0) return { state, car, events, blasted: false };
  const cap = carCapsule(car, t);
  const ids: string[] = [];
  let nearest: { x: number; z: number; d: number } | null = null;
  for (const b of track.bombs) {
    if (state.blown.has(b.id) || !touches(car, cap, b.x, b.z, b.r, t)) continue;
    ids.push(b.id);
    events.push({ type: 'bomb', id: b.id, x: b.x, z: b.z });
    const d = Math.hypot(b.x - car.x, b.z - car.z);
    if (!nearest || d < nearest.d) nearest = { x: b.x, z: b.z, d };
  }
  if (!nearest) return { state, car, events, blasted: false };
  return {
    state: { blown: new Set([...state.blown, ...ids]) },
    car: applyBlast(car, nearest.x, nearest.z, t),
    events,
    blasted: true,
  };
}
```
- [ ] **Step 4:** run → PASS. **Step 5:** commit `feat(game): bombs blow once per lap`.

### Task 5: A bomb burns the chain

**Files:** Modify `src/game/driftScore.ts`, `src/game/driftScore.test.ts`.

- [ ] **Step 1: failing test** — add `bombed: false` to `base`, then:
```ts
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
  });
```
- [ ] **Step 2:** run → FAIL. **Step 3:** `DriftScoreInput.bombed: boolean` ("A bomb blew up under the car this step."); burn on `input.heavyHit || input.respawned || input.bombed`; comment "1. A heavy hit, a bomb blast or a respawn burns the unbanked chain." Session passes `bombed: false` for now so typecheck stays green.
- [ ] **Step 4:** PASS + typecheck. **Step 5:** commit `feat(game): a bomb blast burns the drift chain`.

### Task 6: Session wiring

**Files:** Modify `src/game/session.ts`, `src/game/session.drift.test.ts`.

- [ ] **Step 1: failing tests** in `session.drift.test.ts` (`driftSession` extras gain `bombs?: BombSpot[]`):
```ts
  it('a bomb in the middle of a drift blows once, burns the chain and starts the wrong-way grace', () => {
    const ref = driveUntil(driftSession(), true, midChain)!;
    expect(ref).not.toBeNull();
    const bomb: BombSpot = { id: 'bomb-1', x: ref.st.car.x, z: ref.st.car.z, r: TUNING.bomb.radius };
    const sess = driftSession({ bombs: [bomb] });
    const blast = driveUntil(sess, true, has('bomb'))!;
    expect(blast).not.toBeNull();
    expect(blast.prev.score.phase).toBe('active');
    const ev = blast.events;
    expect(ev).toContainEqual({ type: 'bomb', id: 'bomb-1', x: bomb.x, z: bomb.z });
    expect(types(ev).indexOf('chainBurned')).toBeGreaterThan(types(ev).indexOf('bomb'));
    expect(ev).toContainEqual({ type: 'chainBurned', points: Math.round(blast.prev.score.chainPoints) });
    expect(blast.st.car.mode).toBe('recover');
    expect(blast.st.car.speed).toBeLessThan(blast.prev.car.speed);
    expect(blast.st.progress.graceTimer).toBeGreaterThan(TUNING.progress.graceTime - 2 * DT);
    expect(blast.st.bombs.blown.has('bomb-1')).toBe(true);
    expect(blast.st.score.totalPoints).toBe(blast.prev.score.totalPoints);
    expect(driveUntil(sess, true, has('bomb'), 5)).toBeNull(); // gone for the rest of the lap
  });

  it('a bomb comes back on the next lap; a blast with no chain open burns nothing', () => {
    const at = makeCircleTrack(RADIUS).poseAt(Math.PI * RADIUS, 0); // half a lap from the start
    const bomb: BombSpot = { id: 'bomb-1', x: at.x, z: at.z, r: TUNING.bomb.radius };
    const sess = createSession(makeCircleTrack(RADIUS, { bombs: [bomb] }), { laps: 2 });
    while (sess.state().phase === 'countdown') sess.step(NEUTRAL_INPUT, { respawn: false }, DT);
    const events: GameEvent[] = [];
    driveUntil(sess, false, (s) => (events.push(...s.events), false), 240);
    expect(sess.state().phase).toBe('finished');
    expect(events.filter((e) => e.type === 'bomb')).toHaveLength(2);
    expect(types(events)).not.toContain('chainBurned');
  });
```
- [ ] **Step 2:** run → FAIL. **Step 3: implement** in `session.ts`: `SessionState.bombs: BombState` ("Bombs blown in the current lap."), `initialState` `bombs: createBombs()`, after step 4:
```ts
  // 4b. Bombs: a blast throws the car into recovery and, like a heavy hit, starts the wrong-way grace.
  const bm = updateBombs(s.bombs, track, car, t);
  car = bm.car;
  let bombs = bm.state;
  events.push(...bm.events);
  if (bm.blasted) progress = startGrace(progress, t);
```
lap reset `if (pr.lapCompleted) { pickups = resetLap(pickups); bombs = resetBombs(bombs); }`, score input `bombed: bm.blasted`, `next` gets `bombs`. Step-order doc: "respawn -> car -> collisions -> pickups -> bombs -> progress -> drift score -> finish".
- [ ] **Step 4:** `npx vitest run src/game` → PASS. **Step 5:** commit `feat(game): wire bombs into the race session`.

### Task 7: Bombs on «Площадь», validation, autopilot avoidance

**Files:** Modify `src/track/plaza.ts`, `src/track/plaza.test.ts`, `src/track/build.test.ts`, `src/game/session.test.ts`,
`src/app/autopilot.ts`, `src/app/autopilot.test.ts`.

- [ ] **Step 1: measure the drift line.** Temp script (`temp/bomb-line.test.ts`, run with `npx vitest run --dir temp temp/bomb-line.test.ts`
  or an equivalent vitest invocation) drives one autopilot lap on PLAZA with no bombs and prints, per 5 m of `s`,
  the car's lateral and mode. Zones: fountain sweeper (zone 2, s ≈ 380–520), bicycle snake (zone 3, s ≈ 520–640),
  hairpin (zone 5, s ≈ 1020–1140), top-left corner (s ≈ 1520–1600). In each, pick the s mid-drift whose lateral
  has |lateral| in [1.5, 3.5] (round to 0.5), at least 5 m clear of coins/props/heavy footprints and not within
  4 m of a respawn marker (startS + k * 50).
- [ ] **Step 2: failing validation tests.**
  `plaza.test.ts`: ids unique and every s in one lap include `PLAZA.bombs`; plus
```ts
  it('one bomb in each long drift, off the centreline', () => {
    expect(PLAZA.bombs.map((b) => b.id)).toEqual(['bomb-fountain', 'bomb-bicycle', 'bomb-hairpin', 'bomb-corner']);
    for (const b of PLAZA.bombs) {
      expect(Math.abs(b.lateral)).toBeGreaterThanOrEqual(1.5);
      expect(Math.abs(b.lateral)).toBeLessThanOrEqual(3.5);
    }
  });
```
  `build.test.ts` (plaza block):
```ts
  it('bombs sit on the road with a free passage, clear of pickups, obstacles and respawn poses', () => {
    const H = TUNING.track.roadHalfWidth;
    const CLEAR = 5;
    const poses = [track.spawnPose, ...track.respawnMarkers.map((s) => track.poseAt(s, 0))];
    expect(track.bombs).toHaveLength(4);
    for (const b of track.bombs) {
      const lat = track.project(b.x, b.z).lateral;
      expect(Math.abs(lat) + b.r).toBeLessThanOrEqual(H);
      expect(Math.max(H - (lat + b.r), lat - b.r + H)).toBeGreaterThanOrEqual(TUNING.track.minFreeWidth);
      const gap = (x: number, z: number, r: number) => Math.hypot(x - b.x, z - b.z) - r - b.r;
      for (const c of track.coins) expect(gap(c.x, c.z, TUNING.pickups.coinRadius)).toBeGreaterThanOrEqual(CLEAR);
      for (const p of track.lightProps) expect(gap(p.x, p.z, p.r)).toBeGreaterThanOrEqual(CLEAR);
      for (const c of track.heavyColliders) {
        if (c.kind === 'wall') continue;
        const seg = c.kind === 'circle' ? { ax: c.x, az: c.z, bx: c.x, bz: c.z } : c;
        expect(capsuleOverlapsCircle({ ax: seg.ax, az: seg.az, bx: seg.bx, bz: seg.bz, r: c.r + CLEAR }, b.x, b.z, b.r)).toBe(false);
      }
      for (const p of poses) {
        const ox = Math.sin(p.heading) * TUNING.car.capsuleHalf;
        const oz = Math.cos(p.heading) * TUNING.car.capsuleHalf;
        const cap = { ax: p.x + ox, az: p.z + oz, bx: p.x - ox, bz: p.z - oz, r: TUNING.car.radius };
        expect(capsuleOverlapsCircle(cap, b.x, b.z, b.r)).toBe(false);
      }
    }
  });
```
  `session.test.ts` start-line guard: add `...track.bombs.map((b) => toLine(b.x, b.z) - b.r)` to `gaps` (comment: bombs too).
  `autopilot.test.ts`: both plaza tests assert `expect(events.filter((e) => e.type === 'bomb')).toHaveLength(0)`
  (the 1-lap test collects its events the same way).
- [ ] **Step 3:** add the four `BombDef`s (`BOMBS`, comments per zone) to `plaza.ts`, `bombs: BOMBS`.
- [ ] **Step 4: autopilot avoidance.** `AUTOPILOT.bombClearance: 4` ("Keep this far (m) from the road-side edge of a bomb
  within avoidRange m along the track."); `ObstacleEdge.clearance`; `obstacleEdges(track, AP)` maps heavy colliders
  with `AP.clearance` and `track.bombs` (circle r) with `AP.bombClearance`; `lineAt` uses `e.clearance`.
- [ ] **Step 5:** `npm test` → PASS (autopilot: no bomb events, > 15000 points, laps < 60 s). If the autopilot clips a
  bomb, raise `bombClearance` / move the bomb within the zone rules and re-run.
- [ ] **Step 6:** commit `feat(track): four bombs on the plaza drift line` (autopilot change in the same commit, it keeps the tests green).

### Task 8: Bomb models

**Files:** Create `src/render/bombs.ts`, `src/render/bombs.test.ts`.

- [ ] **Step 1: failing tests**
```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createBombsLayer } from './bombs';
import { makeCircleTrack } from '../game/testTracks';
import { TUNING } from '../shared/tuning';

const r = TUNING.bomb.radius;
const track = makeCircleTrack(100, { bombs: [{ id: 'a', x: 1, z: 2, r }, { id: 'b', x: -3, z: 4, r }] });

describe('bombs layer', () => {
  it('stands one bomb model per spot on the road, about the trigger size', () => {
    const layer = createBombsLayer(track);
    const roots = layer.group.children;
    expect(roots.map((o) => o.name)).toEqual(['bomb-a', 'bomb-b']);
    expect(roots[0].position.toArray()).toEqual([1, 0, 2]);
    layer.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(roots[0]);
    expect(box.min.y).toBeLessThanOrEqual(0.01);
    expect(box.max.x - box.min.x).toBeGreaterThan(1.8 * r);
    expect(box.max.x - box.min.x).toBeLessThan(3 * r);
  });

  it('hides blown bombs and shows them again when the state no longer lists them', () => {
    const layer = createBombsLayer(track);
    const visible = () => layer.group.children.map((o) => o.visible);
    layer.update({ blown: new Set(['a']) }, 0);
    expect(visible()).toEqual([false, true]);
    layer.update({ blown: new Set() }, 0.1);
    expect(visible()).toEqual([true, true]);
    layer.update({ blown: new Set(['b']) }, 0.2);
    layer.update(null, 0.3);
    expect(visible()).toEqual([true, true]);
  });

  it('blinks the fuse spark on the sim clock', () => {
    const layer = createBombsLayer(track);
    const spark = layer.group.children[0].getObjectByName('bomb-spark')!;
    const scales = [0, 0.03, 0.06, 0.09, 0.12].map((t) => (layer.update(null, t), spark.scale.x));
    expect(new Set(scales.map((s) => s.toFixed(4))).size).toBeGreaterThan(2);
    for (const s of scales) expect(s).toBeGreaterThan(0);
  });
});
```
- [ ] **Step 2:** FAIL. **Step 3: implement** `bombs.ts`: `createBomb(r)` (PartSet: flat-shaded dark shell sphere sunk 8 % into the
  road, metal collar `cylinderAt`, two-piece curved fuse `tubeBetween`; returns `{ root, sparkAt: THREE.Vector3 }`) and
  `createBombsLayer(track): BombsLayer` (`group` named `bombs`; per bomb `root` named `bomb-<id>` at (x, 0, z),
  yawed `i * 2.1` for variety, an unlit `MeshBasicMaterial({ toneMapped: false })` icosahedron `bomb-spark` at the fuse
  tip, shared geometry/material; `update(state, time)` sets `visible` and the spark scale
  `r * SPARK_SCALE * (BLINK_MIN + (1 - BLINK_MIN) * (0.5 + 0.5 * sin(TAU * (time * BLINK_HZ + phase))))`, no allocation).
- [ ] **Step 4:** PASS. **Step 5:** commit `feat(render): cartoon bomb models`.

### Task 9: Blast effects, car hop, camera shake, wiring

**Files:** Modify `src/render/fx.ts`, `src/render/fx.test.ts`, `src/render/carModel.ts` (+ new `src/render/carModel.test.ts`),
`src/app/raceScene.ts`, `src/app/raceRun.ts`, `src/app/loading.ts`, `src/app/raceScene.test.ts` if it lists layers.

- [ ] **Step 1: failing tests**
  fx: 
```ts
  it('a bomb flashes, bursts sparks and rolls up smoke', () => {
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    fx.onEvent({ type: 'bomb', id: 'b', x: 0, z: 0 });
    fx.update(makeDriver(0, 0, 'grip').state(), 'road', DT);
    expect(live(scene, 'fx-bursts')).toBeGreaterThanOrEqual(30);
    expect(live(scene, 'fx-smoke')).toBeGreaterThanOrEqual(8);
  });
```
  carModel:
```ts
import { describe, expect, it } from 'vitest';
import { createCarModel } from './carModel';
import { createCarState } from '../physics/car';

describe('car model hop', () => {
  it('a hop lifts the whole car, lands it back on the ground and reset() cancels it', () => {
    const m = createCarModel();
    const car = createCarState(0, 0, 0);
    m.hop();
    const ys: number[] = [];
    for (let i = 0; i < 60; i++) {
      m.root.position.y = 0; // applyPose() runs before every update
      m.update(car, 1 / 60);
      ys.push(m.root.position.y);
    }
    expect(Math.max(...ys)).toBeGreaterThan(0.3);
    expect(Math.max(...ys)).toBeLessThan(0.8);
    expect(ys.at(-1)).toBe(0);
    m.hop();
    m.update(car, 1 / 60);
    m.reset();
    m.root.position.y = 0;
    m.update(car, 1 / 60);
    expect(m.root.position.y).toBe(0);
  });
});
```
- [ ] **Step 2:** FAIL. **Step 3: implement**
  - `fx.ts`: colours `blast: 0xffa040`, `soot: 0x3d3936`; presets `BLAST_FLASH = { life: [0.32, 0.32], size: [2.2, 2.2], grow: [3, 3], drag: 0, gravity: 0 }`,
    `SOOT = { life: [1.2, 1.8], size: [1.2, 1.8], grow: [2.4, 3.2], drag: 1.8, gravity: -1.2 }`, `BLAST_SMOKE = 10`;
    `blast(x, z)`: flash at y 1, `sparks(x, 0.6, z, 32, 16)`, 10 soot puffs thrown out and up; `onEvent` handles `'bomb'`;
    interface doc lists it.
  - `carModel.ts`: `hop(): void` in the interface ("Visual hop of the whole car (bomb blast). Rendering only.");
    constants `HOP_SPEED = 4.4` m/s, `HOP_GRAVITY = 20` m/s² (≈ 0.48 m, ≈ 0.44 s); state `hopY`, `hopVel`;
    `update` (dt > 0) integrates and writes `root.position.y = hopY` while airborne, 0 on landing; `reset()` clears it.
  - `raceScene.ts`: `RaceFrame.bombs?: BombState | null` ("Bombs blown this lap; absent shows every bomb."); create
    `createBombsLayer(track)`, add its group, `bombs.update(f.bombs ?? null, f.simTime)` in `sync`; `onEvent` on `'bomb'`:
    `chase.shake(TUNING.camera.shakePerImpact * TUNING.bomb.shakeImpact)` and `car.hop()`.
  - `raceRun.ts`: frame `bombs: session.state().bombs`, refreshed next to `frame.pickups`.
  - `loading.ts`: prewarm fires `{ type: 'bomb', id: 'prewarm', x: pose.x + fx * 4, z: pose.z + fz * 4 }` after the hit.
- [ ] **Step 4:** `npm test` + `npm run typecheck` → PASS. **Step 5:** commit `feat(render): bomb blast effects, car hop and camera shake`.

### Task 10: Bomb sound

**Files:** Modify `src/audio/sfx.ts`, `src/audio/sfx.test.ts`.

- [ ] **Step 1:** add `{ type: 'bomb', id: 'b1', x: 0, z: 0 }` to `ALL_EVENTS` and a test that `createSfxPlayer(...).play(bombEvent, 0)`
  returns `true` (same fake context set-up as the existing player tests).
- [ ] **Step 2:** FAIL (play returns false). **Step 3:**
```ts
  /** Bomb: a deep falling thump under a noise burst through a closing lowpass, plus a short crackle. */
  function boom(at: number): void {
    tone({ type: 'sine', hz: 120, toHz: 38, glide: 0.35, peak: 0.6, attack: 0.003, hold: 0.04, release: 0.5 }, at);
    hiss({ filter: 'lowpass', hz: 3200, toHz: 140, q: 0.7, peak: 0.7, attack: 0.002, hold: 0.05, release: 0.6 }, at);
    hiss({ filter: 'bandpass', hz: 2400, toHz: 900, q: 1.1, peak: 0.25, attack: 0.002, hold: 0.01, release: 0.18 }, at + 0.03);
  }
```
  `case 'bomb': boom(at); return true;`; the `onEvent` doc comment lists `bomb`.
- [ ] **Step 4:** PASS. **Step 5:** commit `feat(audio): bomb boom`.

### Task 11: Texts

**Files:** `src/ui/garage.ts`, `src/ui/garage.test.ts`, `README.md`, `CHANGELOG.md`.

- [ ] Rules line: `Сильный удар, взрыв бомбы или возврат на трассу (${keyHtml('R')}) <b>сжигают цепочку</b>. Сбитая банка или стакан — минус ${sc.propPenalty} очков.`;
  test expects `'Сильный удар, взрыв бомбы или возврат на трассу (R) сжигают цепочку'`.
- [ ] README «Как набирать очки»: "Сильный удар или взрыв бомбы сжигает цепочку".
- [ ] CHANGELOG `[Unreleased]` → `### Добавлено`: «Бомбы на «Площади»: по одной в четырёх длинных поворотах, на линии заноса.
  Наезд взрывает бомбу: машину отбрасывает и закручивает, незачтённая цепочка сгорает, как от сильного удара. Взорванная
  бомба возвращается на следующем круге.»
- [ ] `npm test` → PASS; commit `docs: bombs in the rules, README and changelog`.

### Task 12: Verification

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e:software` → all pass.
- [ ] Visual check: `?test&quality=medium` screenshot near a bomb (temp Playwright script) — bomb readable on the asphalt,
  blast visible; fix colours/sizes if not.
- [ ] Code review of the branch diff (code-reviewer agent); fix findings; commit.
- [ ] Remove temp scripts created for this work.
