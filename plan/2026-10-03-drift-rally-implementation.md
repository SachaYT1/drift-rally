# Drift Rally v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playable browser 3D arcade drift game: minimal garage → 3-lap drift score attack on the toy-scale «Площадь» map → results, coins saved locally, deployable as a static site.

**Architecture:** Pure TypeScript simulation (physics/, track/, game/) driven by a fixed 120 Hz loop, returning `GameEvent[]` per step; Three.js renders interpolated state; DOM/CSS UI; synthesized Web Audio. Contracts live in `src/shared/` (already written in Task 0) and in stub files with exact signatures.

**Tech Stack:** Vite 6, TypeScript 7 (`tsc --noEmit` only), three r186 (`WebGLRenderer`), Vitest 4, Playwright 1.63, @fontsource (Unbounded, Manrope), gltf-transform (asset script only).

**Design spec (source of truth):** `plan/2026-10-03-drift-rally-design.md`. Read it before any task.

---

## Ground rules for every task (agents)

1. **Own only the files listed in your task.** Other agents edit other files in the same working tree at the same time. Never edit `src/shared/*`, `src/track/trackDef.ts` or another task's files. If a contract is wrong, stop and report it instead of changing it.
2. **Do not commit.** The coordinator commits after each wave.
3. **Signatures in stub files are contracts.** Replace the stub bodies, keep exported names/signatures/types. You may add exports and private helpers.
4. **Run only your own tests:** `npx vitest run <your paths>`. Typecheck with `npx tsc --noEmit 2>&1 | grep -E '<your paths>'` — errors in files you do not own are expected while other agents work.
5. Read thresholds from `TUNING` (`src/shared/tuning.ts`) in code and tests. Never hard-code tuning numbers in logic.
6. Files ≤ 400 lines; split if bigger. English comments. No `console.log` (use `console.warn` only for real warnings). No `any`.
7. Pure modules (physics/, track/, game/, core/save, core/loop) must not import from `three` except `track/build.ts`, which may use `three`'s math classes (`CatmullRomCurve3`, `Vector3`).
8. Immutability: simulation functions return new state objects and never mutate inputs. Sets/arrays in state are replaced, not mutated.

## File structure

```
index.html                      UI root + canvas (Task 14)
vite.config.ts                  base './' (Task 17)
scripts/build-assets.mjs        Kenney download/normalise pipeline (Task 9)
public/models/*.glb             generated assets (Task 9)
src/shared/types.ts math.ts tuning.ts          DONE (Task 0)
src/track/trackDef.ts                           DONE (Task 0)
src/physics/car.ts collision.ts                 Task 1, Task 2
src/track/build.ts plaza.ts                     Task 3
src/game/driftScore.ts                          Task 4
src/game/progress.ts                            Task 5
src/game/pickups.ts                             Task 6
src/core/save.ts input.ts loop.ts quality.ts    Task 7
src/game/session.ts                             Task 8 (wave 2)
src/render/catalog.ts src/core/assets.ts        Task 9
src/render/bridge.ts carModel.ts garageScene.ts Task 10
src/render/environment.ts trackMesh.ts procedural.ts world.ts occlusion.ts   Task 11 (wave 2)
src/render/props.ts fx.ts                       Task 12
src/render/chaseCamera.ts                       Task 13
src/ui/*.ts src/ui/styles.css index.html        Task 14
src/audio/sfx.ts                                Task 15
src/app/*.ts src/main.ts                        Task 16 (wave 3)
playwright.config.ts tests/e2e/smoke.spec.ts    Task 17 (wave 3)
```

## Execution waves

- **Wave 1 (parallel):** Tasks 1, 2, 3, 4, 5, 6, 7 (pure logic) and Tasks 9, 10, 12, 13, 14, 15 (presentation).
- **Wave 2:** Task 8 (needs 1–7), Task 11 (needs 3, 9).
- **Wave 3:** Task 16 integration, Task 17 e2e/build.
- **Wave 4:** Task 18 playtest + tuning, review, fixes.

Test helpers shared by several test files live next to the tests that need them (`src/game/testTracks.ts` is created by Task 5 and may be imported by Task 6 tests; if Task 6 runs first it may create an identical copy named `src/game/testTracks.pickups.ts`).

---

## Task 0: Scaffold and contracts — DONE

Created: `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`, `src/shared/{types,math,tuning}.ts`, `src/track/trackDef.ts`, stubs for `physics/car.ts`, `physics/collision.ts`, `track/build.ts`, `game/{driftScore,progress,pickups,session}.ts`, `core/save.ts`.

---

## Task 1: Car physics (`src/physics/car.ts`)

**Files:** Modify `src/physics/car.ts` · Test `src/physics/car.test.ts`

### Algorithm (implement exactly; constants from `TUNING.car`, `TUNING.drift`, `TUNING.surface`)

Notation: `f = (sin h, cos h)`, `l = (cos h, −sin h)`, `vf = v·f`, `vl = v·l`, `φ = atan2(vx, vz)` (velocity heading), `slip = wrapAngle(h − φ)` (0 when speed < 1).

Per step `stepCar(s, input, surface, dt, t)`:

1. **Steer smoothing:** target = clamp(input.steer, −1, 1); `steer = approach(steer, target, (|target| > |steer| && sign same or steer==0 ? steerRiseRate : steerReturnRate) * dt)`.
2. **Surface params:** road/curb → grip 1, dragExtra 0, maxSpeed `car.maxSpeed`; runoff/outside → `TUNING.surface[kind]`.
3. **Mode transitions** (evaluate before integrating):
   - `recover`: `modeTimer −= dt`; at ≤ 0 → `grip`.
   - `grip` → `drift` when `input.handbrakePressed` (or handbrake held and was not drifting) AND `speed ≥ drift.minSpeed` AND `vf > 0` AND `|steer input| ≥ kickSteerThreshold`: `driftDir = sign(input.steer)`, `driftTime = 0`, `modeTimer = 0`.
   - `drift`: if `speed < drift.minSpeed * 0.75` OR `vf ≤ 0` → `grip` (with grip blend). If `input.throttle < 0.1 && !input.handbrake`: `modeTimer += dt`, and when `modeTimer ≥ exitDelay` → `grip`; else `modeTimer = 0`. **Flick:** if `input.handbrakePressed && input.steer * driftDir ≤ −flickSteer` → `driftDir = −driftDir` (stay in drift).
   - Entering `grip` from `drift`: `gripBlend = 0`, `driftDir = 0`.
4. **Grip / recover integration:**
   - Longitudinal: throttle → `vf += engineAccel * throttle * (1 − (vf/maxSpeedSurface)²) dt` (only when vf ≥ 0). Brake: if `vf > standstillSpeed` → `vf −= brakeDecel*brake*dt` (not below 0); else count `reverseHold += dt` while brake held, and once `≥ reverseDelay` apply `vf −= reverseAccel*brake*dt` down to `−maxReverseSpeed`. Throttle while `vf < 0` brakes toward 0. Drag: `vf −= sign(vf)(rollingResistance + dragExtra + airDrag vf²) dt` without crossing 0.
   - Steering: `angle = steer * maxSteerAngle / (1 + |vf| / steerSpeedRef)`; `targetYaw = vf * tan(angle) / wheelBase`; clamp `|targetYaw| ≤ maxLatAccelGrip / max(|vf|, 1)`; `yawRate += (targetYaw − yawRate) * damp(yawResponse, dt)`.
   - Lateral: `k = lerp(drift.gripDrift, car.gripNormal, gripBlend) * surfaceGrip`; `vl *= exp(−k dt)`; `gripBlend = min(1, gripBlend + dt / gripBlendTime)`.
   - In `recover`: additionally ease heading toward φ when speed > 3 (`yawRate` toward `wrapAngle(φ−h) * 4`).
5. **Drift integration:**
   - `u = steer * driftDir` (−1..1). Curvature: `u ≥ 0 ? lerp(curvNeutral, curvInto, u) : lerp(curvNeutral, curvCounter, −u)`; ×`handbrakeCurvBoost` when handbrake held. Target slip: `u ≥ 0 ? lerp(slipMid, slipWide, u) : lerp(slipMid, slipNarrow, −u)`, plus +5° when handbrake held, clamp `slipMax`.
   - Path: rotate velocity direction by `ωp = driftDir * speed * curvature * dt` (keeps |v|).
   - Speed: `dv = (−(dragBase + dragSlip*|sin slip|) − dragExtra − (handbrake ? handbrakeDecel : 0) + thrust*throttle) dt`, then cap `speed ≤ maxSpeedFactor * maxSpeedSurface`, floor 0.
   - Body: `hTarget = φ_new + driftDir * targetSlip`; `bodyRate = clamp(wrapAngle(hTarget − h) * bodyResponse, ±bodyMaxYawRate)`; `yawRate = ωp/dt + bodyRate`.
   - `driftTime += dt`.
6. **Integrate:** `h += yawRate dt`; position += v dt; `wheelSpin += vf/wheelRadius * dt`; `rpm = clamp(|vf|/maxSpeed * 0.85 + throttle*0.15, 0, 1)`.
7. **Derived fields** recomputed; any non-finite value → return the previous state with zero velocity (defensive; tests assert it never triggers).

`isDrifting(s)`: `mode === 'drift' && speed ≥ drift.minSpeed && |slip| ≥ score.minSlip`.
`carCapsule(s)`: `(x,z) ± capsuleHalf * f`, `r = car.radius`.

### Tests — `src/physics/car.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { carCapsule, createCarState, isDrifting, stepCar } from './car';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type CarState, type InputFrame, type SurfaceKind } from '../shared/types';
import { DEG, seededRandom } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const inp = (p: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...p });

function run(
  start: CarState,
  seconds: number,
  input: (t: number, s: CarState) => InputFrame,
  surface: SurfaceKind = 'road',
): { s: CarState; trace: CarState[] } {
  let s = start;
  const trace: CarState[] = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    s = stepCar(s, input(i * DT, s), surface, DT);
    trace.push(s);
  }
  return { s, trace };
}

/** Car heading 0 (+z) cruising at v m/s, in grip mode. */
function cruising(v: number): CarState {
  const c = createCarState(0, 0, 0);
  return stepCar({ ...c, vz: v }, inp({ throttle: 0 }), 'road', 1e-6);
}

/** A left drift established for 0.6 s at ~22 m/s. */
function establishedLeftDrift(): CarState {
  let s = cruising(22);
  s = stepCar(s, inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
  return run(s, 0.6, () => inp({ throttle: 1, steer: 0.3 })).s;
}

describe('car physics', () => {
  it('starts at rest in grip mode with finite fields', () => {
    const c = createCarState(1, 2, 0.5);
    expect(c.mode).toBe('grip');
    expect(c.speed).toBe(0);
    for (const v of Object.values(c)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('accelerates with throttle and never exceeds maxSpeed', () => {
    const { s: s3 } = run(createCarState(0, 0, 0), 3, () => inp({ throttle: 1 }));
    expect(s3.speed).toBeGreaterThan(15);
    const { trace } = run(createCarState(0, 0, 0), 25, () => inp({ throttle: 1 }));
    for (const s of trace) expect(s.speed).toBeLessThanOrEqual(TUNING.car.maxSpeed + 1e-6);
    expect(trace[trace.length - 1].speed).toBeGreaterThan(0.7 * TUNING.car.maxSpeed);
  });

  it('never gains speed without throttle', () => {
    const { trace } = run(cruising(20), 3, () => inp());
    for (let i = 1; i < trace.length; i++) expect(trace[i].speed).toBeLessThanOrEqual(trace[i - 1].speed + 1e-9);
  });

  it('brakes to a stop, then reverses after the delay, capped', () => {
    const { s, trace } = run(cruising(10), 4, () => inp({ brake: 1 }));
    expect(trace.some((x) => Math.abs(x.forwardSpeed) < 0.5)).toBe(true);
    expect(s.forwardSpeed).toBeLessThan(0);
    expect(s.forwardSpeed).toBeGreaterThanOrEqual(-TUNING.car.maxReverseSpeed - 1e-6);
  });

  it('steering left (+1) turns left: heading increases, car moves toward +x', () => {
    const { s } = run(cruising(10), 1, () => inp({ throttle: 0.3, steer: 1 }));
    expect(s.heading).toBeGreaterThan(0.2);
    expect(s.x).toBeGreaterThan(0);
  });

  it('grip cornering respects the lateral acceleration cap', () => {
    const { trace } = run(cruising(30), 2, () => inp({ throttle: 1, steer: 1 }));
    for (const s of trace.slice(60)) {
      expect(s.mode).toBe('grip');
      expect(Math.abs(s.yawRate * s.speed)).toBeLessThanOrEqual(TUNING.car.maxLatAccelGrip * 1.15);
    }
  });

  it('Space + steer at speed enters a drift within 0.3 s', () => {
    let s = stepCar(cruising(20), inp({ throttle: 1, steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    s = run(s, 0.3, () => inp({ throttle: 1, steer: 1 })).s;
    expect(s.mode).toBe('drift');
    expect(s.driftDir).toBe(1);
    expect(isDrifting(s)).toBe(true);
    expect(s.slip).toBeGreaterThan(TUNING.score.minSlip);
  });

  it('does not kick a drift below minSpeed or when reversing', () => {
    const slow = stepCar(cruising(TUNING.drift.minSpeed - 3), inp({ steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    expect(slow.mode).toBe('grip');
    const back = stepCar({ ...cruising(0), vz: -6 }, inp({ steer: 1, handbrake: true, handbrakePressed: true }), 'road', DT);
    expect(back.mode).toBe('grip');
  });

  it('a held drift never spins out', () => {
    const { trace } = run(establishedLeftDrift(), 4, () => inp({ throttle: 1, steer: 1 }));
    for (const s of trace) {
      expect(s.mode).toBe('drift');
      expect(Math.abs(s.slip)).toBeLessThanOrEqual(TUNING.drift.slipMax + 2 * DEG);
      expect(s.speed).toBeGreaterThan(10);
    }
  });

  it('steering into the drift tightens the path, counter-steer widens it', () => {
    const base = establishedLeftDrift();
    const turn = (steer: number) => {
      const { s } = run(base, 1, () => inp({ throttle: 1, steer }));
      const a0 = Math.atan2(base.vx, base.vz);
      const a1 = Math.atan2(s.vx, s.vz);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return d;
    };
    const into = turn(1), neutral = turn(0), counter = turn(-0.5);
    expect(into).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(counter);
    expect(counter).toBeGreaterThan(0);
  });

  it('releasing throttle and handbrake exits smoothly to grip', () => {
    const { trace } = run(establishedLeftDrift(), 2, () => inp());
    const exitIdx = trace.findIndex((s) => s.mode === 'grip');
    expect(exitIdx).toBeGreaterThan(-1);
    expect(exitIdx * DT).toBeLessThanOrEqual(TUNING.drift.exitDelay + 0.05);
    for (let i = 1; i < trace.length; i++) {
      expect(Math.abs(trace[i].lateralSpeed - trace[i - 1].lateralSpeed)).toBeLessThan(0.6);
    }
    expect(Math.abs(trace[trace.length - 1].slip)).toBeLessThan(5 * DEG);
  });

  it('flick: strong counter-steer + Space flips the drift without leaving drift mode', () => {
    let s = stepCar(establishedLeftDrift(), inp({ throttle: 1, steer: -1, handbrake: true, handbrakePressed: true }), 'road', DT);
    const { s: end, trace } = run(s, 0.6, () => inp({ throttle: 1, steer: -1 }));
    s = end;
    expect(trace.every((x) => x.mode === 'drift')).toBe(true);
    expect(s.driftDir).toBe(-1);
    expect(s.slip).toBeLessThan(0);
  });

  it('recover mode returns to grip after recoverTime', () => {
    const start = { ...cruising(10), mode: 'recover' as const, modeTimer: TUNING.drift.recoverTime };
    const { s } = run(start, TUNING.drift.recoverTime + 0.05, () => inp({ throttle: 1 }));
    expect(s.mode).toBe('grip');
  });

  it('runoff limits top speed', () => {
    const { s } = run(createCarState(0, 0, 0), 15, () => inp({ throttle: 1 }), 'runoff');
    expect(s.speed).toBeLessThanOrEqual(TUNING.surface.runoff.maxSpeed + 0.5);
  });

  it('is deterministic and finite under random inputs', () => {
    const script = (seed: number) => {
      const rnd = seededRandom(seed);
      const frames: InputFrame[] = [];
      for (let i = 0; i < 20 * 120; i++) {
        const space = rnd() < 0.02;
        frames.push(inp({ throttle: rnd() < 0.7 ? 1 : 0, brake: rnd() < 0.1 ? 1 : 0, steer: Math.round(rnd() * 2 - 1), handbrake: space, handbrakePressed: space }));
      }
      return frames;
    };
    const frames = script(42);
    const a = run(createCarState(0, 0, 0), 20, (t) => frames[Math.round(t / DT)]).s;
    const b = run(createCarState(0, 0, 0), 20, (t) => frames[Math.round(t / DT)]).s;
    expect(a).toEqual(b);
    for (const v of Object.values(a)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('carCapsule follows heading', () => {
    const c = carCapsule(createCarState(0, 0, 0));
    expect(c.az).toBeCloseTo(TUNING.car.capsuleHalf);
    expect(c.bz).toBeCloseTo(-TUNING.car.capsuleHalf);
    expect(c.r).toBe(TUNING.car.radius);
  });
});
```

- [ ] Step 1: write the test file; run `npx vitest run src/physics/car.test.ts` → FAIL (not implemented).
- [ ] Step 2: implement the algorithm above.
- [ ] Step 3: run → PASS. If a scenario fails because of tuning (not logic), adjust **only** the derivation logic, not the tests; report any tuning value you believe must change.
- [ ] Step 4: typecheck own files.

---

## Task 2: Collision (`src/physics/collision.ts`)

**Files:** Modify `src/physics/collision.ts` · Test `src/physics/collision.test.ts`

### Algorithm
- Car capsule from `carCapsule(state)` (import from `./car` — Task 1 implements it; if Task 1 is not ready yet, compute it locally with the same formula and keep a private helper).
- Closest-points: segment–point (circle), segment–segment (capsule), segment–segment with one-sided rule (wall).
- **Wall (one-sided):** let `d = (closestCarPoint − wallPoint)·n` over the capsule segment endpoints and the closest point to the wall segment; penetration `pen = r − d_min` where `d_min` is the minimum signed distance of the capsule segment to the wall line, restricted to the wall's extent (project onto the segment; ignore if the projection is outside [0,1] by more than r). The push direction is ALWAYS `+n` (toward the track), even if the car centre is behind the wall.
- Up to `collision.iterations` passes: collect overlaps, resolve the deepest first: move car by `pen * n`; record contact once per collider id (keep the max impactSpeed).
- Velocity: `vn = v·n`; if `vn < 0`: `impact = −vn`; `v −= (1 + restitution) * vn * n`; tangential `vt *= impact ≥ heavyImpact ? hitFriction : scrapeFriction`.
- Heavy hit (impact ≥ `heavyImpact`): `mode = 'recover'`, `modeTimer = drift.recoverTime`, `driftDir = 0`, yaw impulse: lever `p = contact − carCentre`, `τ = (n.x * p.z − n.z * p.x) / (capsuleHalf + radius)`, `yawRate += yawImpulse * impact * clamp(τ, −1, 1)`.
- Recompute derived fields (speed, forwardSpeed, lateralSpeed, slip) after resolution.

### Tests — `src/physics/collision.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { capsuleOverlapsCircle, resolveCollisions } from './collision';
import { carCapsule, createCarState } from './car';
import { TUNING } from '../shared/tuning';
import type { CarState, Collider } from '../shared/types';

function car(x: number, z: number, heading: number, vx = 0, vz = 0): CarState {
  const c = createCarState(x, z, heading);
  const speed = Math.hypot(vx, vz);
  return { ...c, vx, vz, speed, forwardSpeed: vx * Math.sin(heading) + vz * Math.cos(heading) };
}
const circle = (x: number, z: number, r: number, id = 'c'): Collider => ({ kind: 'circle', id, x, z, r });
const wallX = (z: number): Collider => ({ kind: 'wall', id: 'w', ax: -50, az: z, bx: 50, bz: z, nx: 0, nz: 1 });

function segPointDist(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

describe('collision', () => {
  it('pushes the car out of a circle along the contact normal', () => {
    const r = resolveCollisions(car(0, 0, 0), [circle(1.5, 0, 1)]);
    const cap = carCapsule(r.state);
    expect(segPointDist(cap.ax, cap.az, cap.bx, cap.bz, 1.5, 0)).toBeGreaterThanOrEqual(1 + TUNING.car.radius - 1e-6);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].nx).toBeLessThan(0);
  });

  it('reflects approaching velocity with restitution and flags a heavy hit', () => {
    const r = resolveCollisions(car(0, 0, 0, 10, 0), [circle(1.5, 0, 1)]);
    expect(r.state.vx).toBeLessThan(0);
    expect(r.state.vx).toBeGreaterThanOrEqual(-TUNING.collision.restitution * 10 - 1e-6);
    expect(r.heavyHit).not.toBeNull();
    expect(r.heavyHit!.impactSpeed).toBeCloseTo(10, 5);
    expect(r.state.mode).toBe('recover');
  });

  it('does not reflect a car already moving away', () => {
    const r = resolveCollisions(car(0, 0, 0, -5, 0), [circle(1.5, 0, 1)]);
    expect(r.state.vx).toBeCloseTo(-5, 6);
    expect(r.heavyHit).toBeNull();
  });

  it('a slow contact is a scrape: no heavy hit, tangential speed mostly kept', () => {
    const r = resolveCollisions(car(0, 0, Math.PI / 2, 3, 20), [circle(1.5, 0, 1)]);
    expect(r.heavyHit).toBeNull();
    expect(r.contacts[0].impactSpeed).toBeLessThan(TUNING.collision.heavyImpact);
    expect(r.state.vz).toBeGreaterThan(20 * 0.97);
  });

  it('one-sided wall pushes toward the track even from behind', () => {
    const inFront = resolveCollisions(car(0, 0.5, Math.PI / 2), [wallX(0)]);
    expect(inFront.state.z).toBeGreaterThanOrEqual(TUNING.car.radius - 1e-6);
    const behind = resolveCollisions(car(0, -0.5, Math.PI / 2), [wallX(0)]);
    expect(behind.state.z).toBeGreaterThanOrEqual(TUNING.car.radius - 1e-6);
  });

  it('collides with capsule colliders', () => {
    const cap: Collider = { kind: 'capsule', id: 'k', ax: 1.2, az: -3, bx: 1.2, bz: 3, r: 0.5 };
    const r = resolveCollisions(car(0, 0, 0), [cap]);
    expect(r.state.x).toBeLessThanOrEqual(1.2 - 0.5 - TUNING.car.radius + 1e-6);
  });

  it('front-right hit yaws the car left (positive yaw rate)', () => {
    // circle overlaps the front-right corner (right of heading 0 is -x)
    const r = resolveCollisions(car(0, 0, 0, 0, 12), [circle(-1.0, 1.9, 0.5)]);
    expect(r.heavyHit).not.toBeNull();
    expect(r.state.yawRate).toBeGreaterThan(0);
  });

  it('reports at most one contact per collider, deepest first', () => {
    const r = resolveCollisions(car(0, 0, 0), [circle(1.6, 0, 1, 'a'), circle(-1.2, 0, 1, 'b'), circle(1.6, 0.2, 1, 'a')]);
    const ids = r.contacts.map((c) => c.colliderId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('capsuleOverlapsCircle', () => {
    const cap = carCapsule(createCarState(0, 0, 0));
    expect(capsuleOverlapsCircle(cap, 0, 2.3, 0.5)).toBe(true);
    expect(capsuleOverlapsCircle(cap, 3, 0, 0.5)).toBe(false);
  });
});
```

- [ ] Steps: write tests → FAIL → implement → PASS → typecheck own files.

---

## Task 3: Track build + map data (`src/track/build.ts`, `src/track/plaza.ts`)

**Files:** Modify `src/track/build.ts` · Create `src/track/plaza.ts`, `src/track/geometry.ts` (optional helper split) · Test `src/track/build.test.ts`, `src/track/plaza.test.ts`

### build.ts
- World coords: `world = map − origin`. Centreline: `new CatmullRomCurve3(points (x,0,z), true, 'centripetal')`; `curve.arcLengthDivisions = 4000`; `length = curve.getLength()`; samples via `getSpacedPoints(N)` with `N = round(length)` (drop the duplicated last point); tangents from neighbours (central difference); signed curvature = turning angle between the tangents at i−3 and i+3 divided by 6·spacing (+ = left, i.e. tangent rotating toward `l`). The ±3 window suppresses sampling noise; the design check measured min radius 24.6 m this way.
- `project(x,z,hintS?,window?)`: brute force over samples (global) or over indices within ±window of hintS; refine on the segment to the next sample; `lateral = (p − c)·l` with `l = (tz, −tx)`.
- `surfaceAt(lat)`: `|lat| ≤ roadHalfWidth` road; `≤ +curbWidth` curb; `≤ barrier` runoff; else outside.
- `poseAt(s, lat=0)`, `sampleAt(s)`: linear interpolation between samples; heading `atan2(tx, tz)`.
- Walls: offset polylines at ±barrier, every 4 m, one-sided segments with normal toward the centreline (ids `wall-in-<i>`, `wall-out-<i>`).
- Heavy obstacles: anchor = poseAt(s, lateral) rotated by yaw; footprint local (+x along tangent, +z = left) → world colliders with ids `<obstacleId>#<k>`.
- Coins: rows → poseAt(s + i*spacing, lateral); ids 0..n−1 in order. Light props → `LightPropSpot` with r = `pickups.canRadius` / `cupRadius`.
- `collidersNear`: uniform grid, cell 16 m, colliders inserted by AABB (inflated by r).
- `respawnMarkers`: `startS + k*respawnSpacing` (wrapped) for k = 0.. while < length; `spawnPose = poseAt(startS + spawnOffset, 0)`.
- `ground`: def.ground converted to world.

### plaza.ts — `export const PLAZA: TrackDef`
- `id: 'plaza'`, `name: 'Площадь'`, `origin: [320, 230]`, control points exactly as in the design spec §3, `startS: 50`, `ground: [-200, -260, 860, 700]`.
- Author obstacle/prop/coin positions as `(s, lateral)`. Use a throwaway script (do not commit it; put it in `temp/`) that builds the curve and projects the mockup positions below to get `s` values, then hard-code the results.
- Mockup positions (map units = mockup x, mockup y − 40):
  - Zone 4 bench (heavy, procedural, `occluder: true`): anchor on the centreline near map (450, 61); footprint: 4 circles r 0.45 at local (±2.5, ±5.5).
  - Zone 3 bicycle (heavy): parked diagonally just outside the right (−lateral) barrier near map (565, 185); footprint: one capsule (the front wheel's ground line) reaching lateral ≈ −5 (2 m onto the road), the rest beyond the barrier (no extra colliders beyond the barrier).
  - Zone 7 sneaker (heavy): at the left-side kink near map (60, 240) on the right (−lateral) edge; footprint capsule r 1.0, ~6 m long, reaching lateral ≈ −4.5.
  - Zone 6 cans: ≥ 6 cans along the slalom wave (map (229,79), (195,73), (160,95) and three more), alternating lateral ±3 m.
  - Zone 2 cups: ≥ 3 cups on the outer (−lateral) side of the fountain sweeper at lateral −5.
  - Coins: 26–36 total: start straight row (6 × 8 m), fountain inner line (+4, 5 × 10 m), bench passage (3 × 6 m, lat 0), hairpin inner side (−4, 4 × 8 m), slalom wave (4), sneaker kink (3), top-left corner (3).
  - Decor (map coords): fountain (480, 305); planterTree (330, 245) `occluder: true`; startArch at the start line (centreline, `occluder: true`); office towers/blocks along the north edge (z ≈ −160…−60) and east edge (x ≈ 680…760); person (spectator) south of the start straight at ≥ 35 m from the centreline (e.g. (300, 425)); 2–3 more persons around the plaza; lamps, benches, trash bins, trees, bushes around the perimeter and inside the loop, all respecting the keep-out rule.

### Tests — `src/track/build.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { buildTrack } from './build';
import { PLAZA } from './plaza';
import { VISUAL_HEIGHT } from './trackDef';
import { TUNING, barrierOffset } from '../shared/tuning';
import { capsuleOverlapsCircle } from '../physics/collision';
import { seededRandom } from '../shared/math';

const track = buildTrack(PLAZA);
const B = barrierOffset();

function segX(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0;
}

describe('track build (plaza)', () => {
  it('has the expected length and ~1 m sample spacing', () => {
    expect(track.length).toBeGreaterThan(1700);
    expect(track.length).toBeLessThan(1950);
    expect(Math.abs(track.spacing - 1)).toBeLessThan(0.05);
  });

  it('projects offset points back to (s, lateral)', () => {
    for (let i = 0; i < track.samples.length; i += 37) {
      const sm = track.samples[i];
      const px = sm.x + sm.tz * 3, pz = sm.z - sm.tx * 3; // 3 m to the left
      const g = track.project(px, pz);
      expect(Math.abs(g.lateral - 3)).toBeLessThan(0.25);
      const ds = Math.abs(((g.s - sm.s + track.length * 1.5) % track.length) - track.length / 2);
      expect(ds).toBeLessThan(1.5);
      const h = track.project(px, pz, sm.s, TUNING.progress.window);
      expect(Math.abs(h.lateral - 3)).toBeLessThan(0.25);
    }
  });

  it('classifies surfaces by lateral offset', () => {
    expect(track.surfaceAt(0)).toBe('road');
    expect(track.surfaceAt(-TUNING.track.roadHalfWidth - 0.5)).toBe('curb');
    expect(track.surfaceAt(B - 1)).toBe('runoff');
    expect(track.surfaceAt(-(B + 1))).toBe('outside');
  });

  it('every corner radius is at least minRadius', () => {
    for (const s of track.samples) expect(Math.abs(s.curvature)).toBeLessThanOrEqual(1 / TUNING.track.minRadius);
  });

  it('barrier offset curves do not self-intersect', () => {
    for (const side of [1, -1]) {
      const pts = track.samples.filter((_, i) => i % 2 === 0).map((s) => [s.x + side * s.tz * B, s.z - side * s.tx * B]);
      let crossings = 0;
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 2; j < pts.length; j++) {
          if (i === 0 && j === pts.length - 1) continue;
          if (segX(pts[i], pts[(i + 1) % pts.length], pts[j], pts[(j + 1) % pts.length])) crossings++;
        }
      expect(crossings).toBe(0);
    }
  });

  it('separate legs of the track keep a gap wider than both barriers', () => {
    const S = track.samples;
    let min = Infinity;
    for (let i = 0; i < S.length; i += 3)
      for (let j = i + 3; j < S.length; j += 3) {
        const along = Math.min(j - i, S.length - (j - i));
        if (along < 80) continue;
        min = Math.min(min, Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z));
      }
    expect(min).toBeGreaterThan(2 * B + 6);
  });

  it('walls face the track', () => {
    for (const w of track.walls) {
      if (w.kind !== 'wall') continue;
      const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
      const p = track.project(mx, mz);
      const c = track.poseAt(p.s, 0);
      expect((c.x - mx) * w.nx + (c.z - mz) * w.nz).toBeGreaterThan(0);
    }
  });

  it('coins and light props lie on the road; coin count is 26-36', () => {
    expect(track.coins.length).toBeGreaterThanOrEqual(26);
    expect(track.coins.length).toBeLessThanOrEqual(36);
    for (const c of track.coins) expect(Math.abs(track.project(c.x, c.z).lateral)).toBeLessThanOrEqual(TUNING.track.roadHalfWidth);
    expect(track.lightProps.filter((p) => p.kind === 'can').length).toBeGreaterThanOrEqual(6);
    expect(track.lightProps.filter((p) => p.kind === 'cup').length).toBeGreaterThanOrEqual(3);
    for (const p of track.lightProps) expect(Math.abs(track.project(p.x, p.z).lateral)).toBeLessThanOrEqual(TUNING.track.roadHalfWidth);
  });

  it('heavy obstacles leave a free corridor and no car-trapping wedges', () => {
    const carW = TUNING.car.width;
    for (const { def } of track.heavyPlacements) {
      const blocked: [number, number][] = [];
      for (const c of track.heavyColliders.filter((k) => k.id.startsWith(def.id + '#'))) {
        const pts = c.kind === 'circle' ? [[c.x, c.z, c.r]] : c.kind === 'capsule' ? [[c.ax, c.az, c.r], [c.bx, c.bz, c.r], [(c.ax + c.bx) / 2, (c.az + c.bz) / 2, c.r]] : [];
        for (const [x, z, r] of pts) {
          const lat = track.project(x, z, def.s, 40).lateral;
          blocked.push([lat - r, lat + r]);
        }
      }
      blocked.sort((a, b) => a[0] - b[0]);
      const H = TUNING.track.roadHalfWidth;
      let cursor = -B, widest = 0;
      for (const [lo, hi] of blocked) {
        const gap = Math.max(-B, lo) - cursor;
        if (gap > 0) {
          widest = Math.max(widest, Math.min(lo, H) - Math.max(cursor, -H));
          expect(gap === 0 || gap >= carW + 1).toBe(true);
        }
        cursor = Math.max(cursor, hi);
      }
      widest = Math.max(widest, H - Math.max(cursor, -H));
      expect(widest).toBeGreaterThanOrEqual(TUNING.track.minFreeWidth);
    }
  });

  it('tall decor keeps out of the camera corridor unless tagged as an occluder', () => {
    for (const d of track.decor) {
      if (VISUAL_HEIGHT[d.def.visual] <= TUNING.track.tallDecorHeight || d.def.occluder) continue;
      const p = track.project(d.x, d.z);
      expect(Math.abs(p.lateral)).toBeGreaterThanOrEqual(TUNING.track.tallDecorKeepOut);
    }
  });

  it('spawn pose and every respawn marker are collision-free and face the track', () => {
    const poses = [track.spawnPose, ...track.respawnMarkers.map((s) => track.poseAt(s, 0))];
    for (const p of poses) {
      const near = track.collidersNear(p.x, p.z, 6);
      for (const c of near) {
        if (c.kind === 'circle') {
          const cap = { ax: p.x + Math.sin(p.heading) * 1.05, az: p.z + Math.cos(p.heading) * 1.05, bx: p.x - Math.sin(p.heading) * 1.05, bz: p.z - Math.cos(p.heading) * 1.05, r: TUNING.car.radius };
          expect(capsuleOverlapsCircle(cap, c.x, c.z, c.r)).toBe(false);
        }
      }
    }
    expect(track.respawnMarkers.length).toBe(Math.ceil(track.length / TUNING.progress.respawnSpacing));
  });

  it('collidersNear returns a superset of brute-force nearby colliders', () => {
    const rnd = seededRandom(7);
    const all = [...track.walls, ...track.heavyColliders];
    for (let k = 0; k < 200; k++) {
      const sm = track.samples[Math.floor(rnd() * track.samples.length)];
      const x = sm.x + (rnd() * 2 - 1) * 14, z = sm.z + (rnd() * 2 - 1) * 14;
      const got = new Set(track.collidersNear(x, z, 4).map((c) => c.id));
      for (const c of all) {
        const cx = c.kind === 'circle' ? c.x : (c.ax + c.bx) / 2;
        const cz = c.kind === 'circle' ? c.z : (c.az + c.bz) / 2;
        const half = c.kind === 'circle' ? c.r : Math.hypot(c.bx - c.ax, c.bz - c.az) / 2 + (c.kind === 'capsule' ? c.r : 0);
        if (Math.hypot(cx - x, cz - z) + 1e-6 < 4 - half) expect(got.has(c.id)).toBe(true);
      }
    }
  });
});
```

- [ ] Steps: write tests → FAIL → implement build.ts → write plaza.ts → PASS → typecheck. If a validation test fails for the data, fix `plaza.ts` data (never loosen a test).

---

## Task 4: Drift score (`src/game/driftScore.ts`)

**Files:** Modify `src/game/driftScore.ts` · Test `src/game/driftScore.test.ts`

### Algorithm
- `canAccrue`: `isDrifting(car)` (from `../physics/car`; if not yet implemented, replicate: `mode==='drift' && speed ≥ drift.minSpeed && |slip| ≥ score.minSlip`) AND surface ∈ {road, curb} AND `speed > score.minSpeed` AND `progress ≥ frontier − frontierSlack` AND `progressSpeed > minProgressSpeed`.
- `updateDriftScore(state, input, dt)` order: (1) burn if `heavyHit || respawned` and phase ≠ idle → event `chainBurned{points: round(chainPoints)}`, reset chain to idle; (2) penalties: `totalPoints = max(0, totalPoints − propPenalty * propsKnocked)`, event `penalty` if > 0 knocked; (3) accrual if `accruing`: from idle → `chainStart` event; phase active; `chainDriftTime += dt`; new multiplier = `min(max, 1 + floor(chainDriftTime / step))` → `multiplier` event when it increases; `chainPoints += basePerSec * angleFactor * speedFactor * multiplier * dt`; (4) not accruing: active → grace with `graceTimer = graceTime`; grace → `graceTimer −= dt`, expiry → bank; (5) `finished` → bank if active/grace. Bank: `totalPoints += round(chainPoints)`, `bestChain = max`, event `chainBanked{points}`, reset to idle (multiplier 1).
- `dt = 0` changes nothing.

### Tests — `src/game/driftScore.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { canAccrue, createDriftScore, updateDriftScore, type DriftScoreInput, type DriftScoreState } from './driftScore';
import { TUNING } from '../shared/tuning';
import { DEG } from '../shared/math';
import type { CarState, GameEvent } from '../shared/types';

const DT = 1 / 120;
const base: DriftScoreInput = { accruing: false, slip: 30 * DEG, progressSpeed: 20, heavyHit: false, respawned: false, propsKnocked: 0, finished: false };

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

  it('prop penalty hits the banked total, floored at 0, chain survives', () => {
    let { s } = feed(createDriftScore(), 1, { accruing: true });
    const r = updateDriftScore(s, { ...base, accruing: true, propsKnocked: 2 }, DT);
    expect(r.state.totalPoints).toBe(0);
    expect(r.state.chainPoints).toBeGreaterThan(90);
    expect(r.events.some((e) => e.type === 'penalty')).toBe(true);
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
```

---

## Task 5: Progress (`src/game/progress.ts`) + test track helper

**Files:** Modify `src/game/progress.ts` · Create `src/game/testTracks.ts` · Test `src/game/progress.test.ts`

### Algorithm
- `createProgress(track, laps)`: s = `spawnPose` projection; `p = frontier = spawnOffset`; lap 1.
- `updateProgress(state, track, car, time, dt, laps)`: projection with `hintS = state.s` and `window` unless `needsGlobalSearch`; `ds = loopDelta(state.s, proj.s, L)` clamped to `±(speed*dt*1.5 + 0.5)`; `p += ds`; `frontier = max`; `progressSpeed` = exponential smoothing of ds/dt with k = 10/s; laps: while `floor(frontier / L) > lapsCompleted` → push `time − lapStartTime`, `lapStartTime = time`, event `lap {lap: lapsCompleted, lapTime, best}`; finished when `frontier ≥ laps * L` (once). Wrong way: `graceTimer > 0` → decrement and wrongWay false; else if `progressSpeed < wrongWaySpeed` accumulate timer → after `wrongWayTime` set true (event once); clear when progressSpeed ≥ 0 (event once).
- `respawn`: marker = largest `k*respawnSpacing` (unwrapped from start) ≤ frontier; `p = marker`, s = wrap(startS + marker); pose = `poseAt(s, 0)`; `needsGlobalSearch = false` after this (the pose is known), `graceTimer = graceTime`.
- `startGrace`: `graceTimer = graceTime`.

### testTracks.ts — analytic circle track implementing `Track`

```ts
import type { Track } from '../track/build';
import { TUNING, barrierOffset } from '../shared/tuning';
import { loopDelta, wrapLength } from '../shared/math';
import type { Collider, CoinSpot, LightPropSpot, Pose, SurfaceKind } from '../shared/types';

/** Circle of radius R driven left (CCW in the heading sense). s = 0 at (0,0) heading +z. Centre (R, 0). */
export function makeCircleTrack(
  R = 100,
  extras: { coins?: CoinSpot[]; lightProps?: LightPropSpot[]; walls?: Collider[] } = {},
): Track {
  const L = 2 * Math.PI * R;
  const B = barrierOffset();
  const poseAt = (s: number, lat = 0): Pose => {
    const th = wrapLength(s, L) / R;
    const rr = R - lat;
    return { x: R - rr * Math.cos(th), z: rr * Math.sin(th), heading: th };
  };
  const project = (x: number, z: number) => {
    const th = Math.atan2(z, R - x);
    const s = wrapLength(th * R, L);
    return { s, lateral: R - Math.hypot(R - x, z), index: Math.round(s) % Math.round(L) };
  };
  const surfaceAt = (lat: number): SurfaceKind => {
    const a = Math.abs(lat);
    if (a <= TUNING.track.roadHalfWidth) return 'road';
    if (a <= TUNING.track.roadHalfWidth + TUNING.track.curbWidth) return 'curb';
    return a <= B ? 'runoff' : 'outside';
  };
  const markers: number[] = [];
  for (let k = 0; k * TUNING.progress.respawnSpacing < L; k++) markers.push(k * TUNING.progress.respawnSpacing);
  const sampleAt = (s: number) => {
    const p = poseAt(s);
    return { s: wrapLength(s, L), x: p.x, z: p.z, tx: Math.sin(p.heading), tz: Math.cos(p.heading), curvature: 1 / R };
  };
  const walls = extras.walls ?? [];
  return {
    def: undefined as unknown as Track['def'],
    length: L,
    samples: [],
    spacing: 1,
    startS: 0,
    barrier: B,
    project: (x, z) => project(x, z),
    surfaceAt,
    poseAt,
    sampleAt,
    walls,
    heavyColliders: [],
    collidersNear: () => walls,
    coins: extras.coins ?? [],
    lightProps: extras.lightProps ?? [],
    heavyPlacements: [],
    decor: [],
    respawnMarkers: markers,
    spawnPose: poseAt(TUNING.progress.spawnOffset),
    ground: { minX: -500, minZ: -500, maxX: 500, maxZ: 500 },
  };
}

export { loopDelta };
```

### Tests — `src/game/progress.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createProgress, respawn, startGrace, updateProgress, type ProgressState } from './progress';
import { makeCircleTrack } from './testTracks';
import { TUNING } from '../shared/tuning';
import type { GameEvent } from '../shared/types';

const DT = 1 / 120;
const track = makeCircleTrack(100);
const L = track.length;

/** Drive along the centreline at `speed` (negative = backwards) for `seconds`. */
function drive(state: ProgressState, startS: number, speed: number, seconds: number, t0 = 0, laps = 3) {
  let s = state, along = startS, time = t0;
  const events: GameEvent[] = [];
  let lapsDone = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    along += speed * DT;
    time += DT;
    const pose = track.poseAt(along, 0);
    const r = updateProgress(s, track, { x: pose.x, z: pose.z, speed: Math.abs(speed) }, time, DT, laps);
    s = r.state;
    events.push(...r.events);
    if (r.lapCompleted) lapsDone++;
  }
  return { s, along, time, events, lapsDone };
}

describe('progress', () => {
  it('starts at the spawn offset on lap 1', () => {
    const p = createProgress(track, 3);
    expect(p.p).toBeCloseTo(TUNING.progress.spawnOffset, 1);
    expect(p.frontier).toBe(p.p);
    expect(p.lap).toBe(1);
    expect(p.finished).toBe(false);
  });

  it('completes a lap with the right lap time, continuous across the s wrap', () => {
    const start = createProgress(track, 3);
    const r = drive(start, TUNING.progress.spawnOffset, 20, (L + 10) / 20);
    expect(r.lapsDone).toBe(1);
    expect(r.s.lap).toBe(2);
    expect(r.s.lapTimes[0]).toBeCloseTo((L - TUNING.progress.spawnOffset) / 20, 1);
    expect(r.events.filter((e) => e.type === 'lap')).toHaveLength(1);
  });

  it('finishes after the configured laps exactly once and caps the lap display', () => {
    const r = drive(createProgress(track, 3), TUNING.progress.spawnOffset, 30, (3 * L + 50) / 30);
    expect(r.s.finished).toBe(true);
    expect(r.s.lap).toBe(3);
    expect(r.lapsDone).toBe(3);
  });

  it('driving backwards lowers p, keeps the frontier, and raises wrong-way after the delay', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 3);
    const back = drive(fwd.s, fwd.along, -6, TUNING.progress.wrongWayTime + 0.6, fwd.time);
    expect(back.s.p).toBeLessThan(fwd.s.p);
    expect(back.s.frontier).toBeCloseTo(fwd.s.frontier, 6);
    expect(back.s.wrongWay).toBe(true);
    expect(back.events.filter((e) => e.type === 'wrongWay' && e.active)).toHaveLength(1);
    const again = drive(back.s, back.along, 10, 1, back.time);
    expect(again.s.wrongWay).toBe(false);
  });

  it('grace suppresses wrong-way', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 3);
    const back = drive(startGrace(fwd.s), fwd.along, -6, TUNING.progress.graceTime - 0.1, fwd.time);
    expect(back.s.wrongWay).toBe(false);
  });

  it('clamps teleport-like jumps', () => {
    const s0 = createProgress(track, 3);
    const jump = track.poseAt(TUNING.progress.spawnOffset + 40, 0);
    const r = updateProgress(s0, track, { x: jump.x, z: jump.z, speed: 10 }, DT, DT, 3);
    expect(r.state.p - s0.p).toBeLessThanOrEqual(10 * DT * 1.5 + 0.5 + 1e-6);
  });

  it('respawns at the last marker at or below the frontier', () => {
    const fwd = drive(createProgress(track, 3), 3, 20, 177 / 20);
    const { pose, state } = respawn(fwd.s, track);
    expect(state.p).toBeCloseTo(150, 6);
    const expected = track.poseAt(150, 0);
    expect(pose.x).toBeCloseTo(expected.x, 6);
    expect(pose.heading).toBeCloseTo(expected.heading, 6);
    expect(state.frontier).toBeCloseTo(fwd.s.frontier, 6);
  });
});
```

---

## Task 6: Pickups (`src/game/pickups.ts`)

**Files:** Modify `src/game/pickups.ts` · Test `src/game/pickups.test.ts`

### Algorithm
- Capsule = `carCapsule(car)` (from `../physics/car`; replicate locally if not ready). Coins: collected when `capsuleOverlapsCircle(cap, x, z, coinRadius)` (from `../physics/collision`; replicate locally if not ready) and id not in `coinsTaken` → event `coin`, `coinsPicked++`.
- Props: overlap with `prop.r` and id not in `propsKnocked` → event `propKnocked{vx: car.vx*1.2, vz: car.vz*1.2}`; car velocity scaled by `(1 − knockSpeedLoss)` per knocked prop (recompute speed/forwardSpeed/lateralSpeed); `knocked` count returned.
- Only check spots within 8 m of the car (cheap distance precheck).
- `resetLap`: empty sets, keep `coinsPicked`.

### Tests — `src/game/pickups.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createPickups, resetLap, updatePickups } from './pickups';
import { makeCircleTrack } from './testTracks';
import { createCarState } from '../physics/car';
import { TUNING } from '../shared/tuning';

const track = makeCircleTrack(100, {
  coins: [{ id: 0, x: 0, z: 2.0 + 1.05 }, { id: 1, x: 3.5, z: 0 }],
  lightProps: [{ id: 'can-1', kind: 'can', x: 0, z: -2, r: TUNING.pickups.canRadius, heading: 0 }],
});
const movingCar = () => ({ ...createCarState(0, 0, 0), vz: 20, speed: 20, forwardSpeed: 20 });

describe('pickups', () => {
  it('collects coins within the radius of the capsule, once per lap', () => {
    const r1 = updatePickups(createPickups(), track, movingCar());
    expect(r1.events.filter((e) => e.type === 'coin').map((e) => (e as { id: number }).id)).toEqual([0]);
    expect(r1.state.coinsPicked).toBe(1);
    const r2 = updatePickups(r1.state, track, movingCar());
    expect(r2.events.filter((e) => e.type === 'coin')).toHaveLength(0);
  });

  it('resetLap restores coins and props but keeps the race total', () => {
    const r1 = updatePickups(createPickups(), track, movingCar());
    const reset = resetLap(r1.state);
    expect(reset.coinsTaken.size).toBe(0);
    expect(reset.propsKnocked.size).toBe(0);
    expect(reset.coinsPicked).toBe(1);
    expect(updatePickups(reset, track, movingCar()).events.some((e) => e.type === 'coin')).toBe(true);
  });

  it('knocks a light prop once, launching it and slowing the car slightly', () => {
    const r = updatePickups(createPickups(), track, movingCar());
    const knock = r.events.find((e) => e.type === 'propKnocked');
    expect(knock).toBeDefined();
    expect(r.knocked).toBe(1);
    expect(r.car.speed).toBeCloseTo(20 * (1 - TUNING.pickups.knockSpeedLoss), 6);
    expect(updatePickups(r.state, track, r.car).knocked).toBe(0);
  });
});
```

---

## Task 7: Core: save, input, loop, quality

**Files:** Modify `src/core/save.ts` · Create `src/core/input.ts`, `src/core/loop.ts`, `src/core/quality.ts` · Tests `src/core/save.test.ts`, `src/core/input.test.ts`, `src/core/loop.test.ts`, `src/core/quality.test.ts`

### Interfaces
```ts
// input.ts
export interface InputController {
  /** Call once per PHYSICS STEP. Returns held state; handbrakePressed is true once per Space press. */
  sample(): InputFrame;
  /** Latched actions since the last call (each true at most once per key press). */
  consumeActions(): ActionFrame;
  /** While racing, game keys preventDefault() and Space/arrows never reach page scrolling or focused buttons. */
  setRacing(on: boolean): void;
  /** Clear held keys and latches (blur, pause). */
  reset(): void;
  dispose(): void;
}
export function createInput(target: EventTarget, onBlur?: () => void): InputController;
// Keys by event.code: KeyW/ArrowUp throttle, KeyS/ArrowDown brake, KeyA/ArrowLeft steer +1, KeyD/ArrowRight steer -1,
// Space handbrake, Escape pause, KeyR respawn, KeyM mute. Ignore e.repeat for edges. 'blur' on target clears keys and calls onBlur.

// loop.ts
export interface FixedLoop {
  start(): void;            // requestAnimationFrame-driven
  stop(): void;
  pause(): void;
  resume(): void;           // resets last-time and accumulator (no lurch)
  readonly paused: boolean;
  /** Run the accumulator for one frame of length frameDt (used by rAF and by tests/test-hook). */
  advance(frameDt: number): number; // returns number of steps run
}
export function createFixedLoop(opts: {
  hz: number; maxStepsPerFrame: number; maxFrameDt: number;
  step(dt: number): void;
  render(alpha: number, frameDt: number): void;
  now?: () => number; raf?: (cb: FrameRequestCallback) => number; caf?: (id: number) => void;
}): FixedLoop;

// quality.ts
export function detectQuality(rendererName: string | null): QualityLevel; // 'low' if /swiftshader|llvmpipe|software|basic render/i, else 'medium'
export function pixelRatioFor(level: QualityLevel, devicePixelRatio: number): number; // min(dpr, {low:1, medium:1.25, high:1.5})
export function shadowsFor(level: QualityLevel): boolean; // low → false
```

### Tests (write all of these)

`src/core/save.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SAVE, SAVE_KEY, loadSave, writeSave } from './save';

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  key() { return null; }
  get length() { return this.map.size; }
}
const mem = () => new MemStorage() as unknown as Storage;

describe('save', () => {
  it('returns defaults without storage', () => expect(loadSave(null)).toEqual(DEFAULT_SAVE));
  it('returns defaults on corrupt JSON', () => {
    const s = mem(); s.setItem(SAVE_KEY, '{oops');
    expect(loadSave(s)).toEqual(DEFAULT_SAVE);
  });
  it('returns defaults on wrong version', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ version: 9, coins: 5 }));
    expect(loadSave(s)).toEqual(DEFAULT_SAVE);
  });
  it('sanitises bad fields and keeps good ones', () => {
    const s = mem(); s.setItem(SAVE_KEY, JSON.stringify({ version: 1, coins: -5, bestScore: 1200, bestLapMs: 'x', quality: 'ultra', muted: true }));
    expect(loadSave(s)).toEqual({ ...DEFAULT_SAVE, bestScore: 1200, muted: true });
  });
  it('round-trips', () => {
    const s = mem();
    const data = { ...DEFAULT_SAVE, coins: 42, bestScore: 9000, bestLapMs: 61234, quality: 'high' as const };
    expect(writeSave(data, s)).toBe(true);
    expect(loadSave(s)).toEqual(data);
  });
  it('write returns false when storage throws', () => {
    const bad = { setItem() { throw new Error('quota'); } } as unknown as Storage;
    expect(writeSave({ ...DEFAULT_SAVE }, bad)).toBe(false);
  });
});
```

`src/core/input.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import { createInput } from './input';

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string, repeat = false) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, repeat });
  target.dispatchEvent(e);
  return e;
}

describe('input', () => {
  it('maps WASD by code (layout independent)', () => {
    const t = new EventTarget(); const inp = createInput(t);
    key(t, 'keydown', 'KeyW'); key(t, 'keydown', 'KeyA');
    expect(inp.sample()).toMatchObject({ throttle: 1, steer: 1 });
    key(t, 'keydown', 'KeyD');
    expect(inp.sample().steer).toBe(0);
    key(t, 'keyup', 'KeyA');
    expect(inp.sample().steer).toBe(-1);
  });
  it('reports a Space press once, while the hold persists', () => {
    const t = new EventTarget(); const inp = createInput(t);
    key(t, 'keydown', 'Space');
    expect(inp.sample()).toMatchObject({ handbrake: true, handbrakePressed: true });
    key(t, 'keydown', 'Space', true);
    expect(inp.sample()).toMatchObject({ handbrake: true, handbrakePressed: false });
  });
  it('keeps an unconsumed press until the next sample', () => {
    const t = new EventTarget(); const inp = createInput(t);
    key(t, 'keydown', 'Space'); key(t, 'keyup', 'Space');
    expect(inp.sample().handbrakePressed).toBe(true);
    expect(inp.sample().handbrakePressed).toBe(false);
  });
  it('latches actions once and ignores auto-repeat', () => {
    const t = new EventTarget(); const inp = createInput(t);
    key(t, 'keydown', 'Escape'); key(t, 'keydown', 'Escape', true);
    expect(inp.consumeActions().pause).toBe(true);
    expect(inp.consumeActions().pause).toBe(false);
    key(t, 'keydown', 'KeyR');
    expect(inp.consumeActions().respawn).toBe(true);
  });
  it('clears keys on blur and notifies', () => {
    const t = new EventTarget(); const onBlur = vi.fn(); const inp = createInput(t, onBlur);
    key(t, 'keydown', 'KeyW');
    t.dispatchEvent(new Event('blur'));
    expect(inp.sample().throttle).toBe(0);
    expect(onBlur).toHaveBeenCalledOnce();
  });
  it('prevents default for game keys only while racing', () => {
    const t = new EventTarget(); const inp = createInput(t);
    expect(key(t, 'keydown', 'Space').defaultPrevented).toBe(false);
    inp.setRacing(true);
    expect(key(t, 'keydown', 'Space').defaultPrevented).toBe(true);
    expect(key(t, 'keydown', 'KeyQ').defaultPrevented).toBe(false);
  });
});
```

`src/core/loop.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { createFixedLoop } from './loop';

function make() {
  const steps: number[] = []; const alphas: number[] = [];
  const loop = createFixedLoop({ hz: 120, maxStepsPerFrame: 12, maxFrameDt: 0.1, step: (dt) => steps.push(dt), render: (a) => alphas.push(a), raf: () => 0, caf: () => {} });
  return { loop, steps, alphas };
}

describe('fixed loop', () => {
  it('runs 2 steps per 60 Hz frame on average', () => {
    const { loop, steps } = make();
    for (let i = 0; i < 60; i++) loop.advance(1 / 60);
    expect(steps.length).toBeGreaterThanOrEqual(119);
    expect(steps.length).toBeLessThanOrEqual(120);
    expect(steps.every((d) => d === 1 / 120)).toBe(true);
  });
  it('clamps long frames and caps steps', () => {
    const { loop } = make();
    expect(loop.advance(0.5)).toBeLessThanOrEqual(12);
  });
  it('alpha stays in [0, 1)', () => {
    const { loop, alphas } = make();
    for (const d of [1 / 144, 1 / 60, 0.013, 0.021]) loop.advance(d);
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
  });
  it('does not step while paused and does not lurch on resume', () => {
    const { loop, steps } = make();
    loop.pause();
    loop.advance(1 / 60);
    expect(steps).toHaveLength(0);
    loop.resume();
    expect(loop.advance(1 / 60)).toBeLessThanOrEqual(2);
  });
});
```

`src/core/quality.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { detectQuality, pixelRatioFor, shadowsFor } from './quality';

describe('quality', () => {
  it('detects software renderers', () => {
    expect(detectQuality('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe('low');
    expect(detectQuality('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('low');
    expect(detectQuality('ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)')).toBe('medium');
    expect(detectQuality(null)).toBe('medium');
  });
  it('caps pixel ratio per level', () => {
    expect(pixelRatioFor('low', 2)).toBe(1);
    expect(pixelRatioFor('medium', 2)).toBe(1.25);
    expect(pixelRatioFor('high', 2)).toBe(1.5);
    expect(pixelRatioFor('high', 1)).toBe(1);
  });
  it('disables shadows on low', () => {
    expect(shadowsFor('low')).toBe(false);
    expect(shadowsFor('medium')).toBe(true);
  });
});
```

---

## Task 8 (wave 2): Session (`src/game/session.ts`)

**Files:** Modify `src/game/session.ts` · Test `src/game/session.test.ts`

### Algorithm — `step(input, actions, dt)` (no-op returning [] when finished)
1. `prevCar = car`; `teleported = false`.
2. Countdown phase: `countdownLeft −= dt`; emit `countdown` events at the start (3) and each time `ceil(countdownLeft)` drops (2, 1), and `0` when it reaches 0 → phase `racing`. Car does not move (input ignored).
3. Racing: if `actions.respawn` or auto-respawn backstop (`|lateral| > barrier + outOfBoundsMargin` or non-finite car) → `respawn()` pose, car = `createCarState(pose)`, `teleported = true`, event `respawn`, drift input `respawned = true`.
4. `surface = track.surfaceAt(progress.lateral)`; `car = stepCar(car, input, surface, dt)`.
5. `resolveCollisions(car, track.collidersNear(car.x, car.z, 6))`; cooldowns decrement; for each contact whose collider cooldown ≤ 0 (max one event per step: the strongest): `hit` if heavy else `scrape`; set cooldown. Heavy hit → `startGrace(progress)`.
6. `updatePickups` → events, knocked count, car.
7. `updateProgress` → events; lap completed → `resetLap(pickups)`, update `bestLap`.
8. `canAccrue` + `updateDriftScore` (finished flag when progress just finished) → events.
9. `time += dt` (racing only). On finish: phase `finished`; result = `{ totalPoints, bestChain, totalTime: time, lapTimes, bestLap: min(lapTimes), coinsPicked, coinsFromDrift: floor(totalPoints / pointsPerCoin), coinsEarned }`; event `finish`.

The autopilot below is test-only scaffolding. If it fails to finish because the autopilot itself is weak (it oversteers, under-brakes), improve the autopilot in the test, not the game; if it fails because of a game bug (car stuck on a collider, NaN, progress not counting), fix the game. Report which one it was.

### Tests — `src/game/session.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createSession, type Session } from './session';
import { buildTrack } from '../track/build';
import { PLAZA } from '../track/plaza';
import { createFixedLoop } from '../core/loop';
import { TUNING } from '../shared/tuning';
import { NEUTRAL_INPUT, type GameEvent, type InputFrame } from '../shared/types';
import { wrapAngle } from '../shared/math';

const DT = 1 / TUNING.race.physicsHz;
const track = buildTrack(PLAZA);

/** Pure-pursuit autopilot with drift kicks in tight corners. */
function autopilot(sess: Session): InputFrame {
  const st = sess.state();
  const c = st.car;
  const ahead = track.poseAt(st.progress.s + 14 + c.speed * 0.4, 0);
  const want = Math.atan2(ahead.x - c.x, ahead.z - c.z);
  const err = wrapAngle(want - c.heading);
  const curv = Math.abs(track.sampleAt(st.progress.s + 25).curvature);
  const tight = curv > 1 / 45;
  const kick = tight && c.mode === 'grip' && c.speed > 14;
  return { ...NEUTRAL_INPUT, throttle: c.speed > 30 && tight ? 0.3 : 1, brake: c.speed > 34 && tight ? 1 : 0, steer: Math.max(-1, Math.min(1, err * 2.5)), handbrake: kick, handbrakePressed: kick };
}

function runFor(sess: Session, seconds: number, input: (s: Session) => InputFrame) {
  const events: GameEvent[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) events.push(...sess.step(input(sess), { respawn: false }, DT));
  return events;
}

describe('session', () => {
  it('counts down 3-2-1-0 once each and holds the car still', () => {
    const sess = createSession(track);
    const ev = runFor(sess, TUNING.race.countdown + 0.05, () => ({ ...NEUTRAL_INPUT, throttle: 1 }));
    expect(ev.filter((e) => e.type === 'countdown').map((e) => (e as { value: number }).value)).toEqual([3, 2, 1, 0]);
    expect(sess.state().phase).toBe('racing');
    expect(sess.state().car.speed).toBeLessThan(1);
  });

  it('the autopilot finishes 3 laps with points, coins and no NaN', () => {
    const sess = createSession(track);
    let finish: GameEvent | undefined;
    for (let i = 0; i < 400 * 120 && !finish; i++) {
      const ev = sess.step(autopilot(sess), { respawn: false }, DT);
      finish = ev.find((e) => e.type === 'finish');
      const c = sess.state().car;
      expect(Number.isFinite(c.x) && Number.isFinite(c.z)).toBe(true);
    }
    expect(finish).toBeDefined();
    const r = sess.state().result!;
    expect(r.lapTimes).toHaveLength(3);
    expect(r.totalPoints).toBeGreaterThan(0);
    expect(r.coinsEarned).toBe(r.coinsPicked + Math.floor(r.totalPoints / TUNING.score.pointsPerCoin));
    expect(sess.step(autopilot(sess), { respawn: false }, DT)).toEqual([]);
  });

  it('respawn teleports to a marker and flags the step', () => {
    const sess = createSession(track);
    runFor(sess, TUNING.race.countdown + 6, autopilot);
    const ev = sess.step(NEUTRAL_INPUT, { respawn: true }, DT);
    expect(ev.some((e) => e.type === 'respawn')).toBe(true);
    expect(sess.state().teleported).toBe(true);
    expect(sess.state().car.speed).toBeLessThan(0.5);
  });

  it('is deterministic: two sessions fed the same autopilot end in identical states', () => {
    const run = () => { const s = createSession(track); for (let i = 0; i < 1500; i++) s.step(autopilot(s), { respawn: false }, DT); return s.state(); };
    const a = run(), b = run();
    expect(a.car).toEqual(b.car);
    expect(a.score).toEqual(b.score);
    expect(a.progress).toEqual(b.progress);
  });

  it('the fixed loop runs the same number of steps for 60 Hz and 144 Hz frame schedules', () => {
    const count = (frame: number) => {
      let k = 0;
      const loop = createFixedLoop({ hz: 120, maxStepsPerFrame: 12, maxFrameDt: 0.1, raf: () => 0, caf: () => {}, render: () => {}, step: () => { k++; } });
      for (let t = 0; t < 10 - 1e-9; t += frame) loop.advance(frame);
      return k;
    };
    expect(Math.abs(count(1 / 60) - count(1 / 144))).toBeLessThanOrEqual(1);
  });
});
```

---

## Task 9: Assets pipeline (`scripts/build-assets.mjs`, `src/render/catalog.ts`, `src/core/assets.ts`)

**Files:** Create `scripts/build-assets.mjs`, `public/models/*.glb`, `public/models/LICENSES.md`, `src/render/catalog.ts`, `src/core/assets.ts` · devDependencies `@gltf-transform/core`, `@gltf-transform/functions`, `@gltf-transform/extensions`, `unzipper` (or `adm-zip`)

- Download official Kenney zips (CC0; verify the licence line on each page again) into `temp/kenney/` (gitignored): City Kit Commercial, Mini Characters, Food Kit, Nature Kit, Holiday Kit (or Coaster Kit) for bench/lamp, Fantasy Town Kit (fountain), Furniture Kit (trash bin). Find the real download URLs on each `https://kenney.nl/assets/<name>` page.
- Pick GLB files for each `VisualId` that comes from Kenney: `officeTower` (2 variants), `officeBlock` (2–3 variants), `person` (3 variants, freeze idle: strip animations and skins; bake the bind pose), `lamp`, `tree` (2 variants), `bush`, `trashBin`, `fountain`, `can`, `cup`, and a decor `bench` (decor only; the obstacle bench is procedural).
- Normalise with gltf-transform: dedup, prune, strip animations, set `metallicFactor = 0`, `roughnessFactor = 1`, remove `KHR_materials_unlit`, resize textures ≤ 1024, keep the kit colormap (embed it). Output one GLB per VisualId variant: `public/models/<visual>[-<n>].glb`.
- Record the measured bounding-box height of each GLB; `catalog.ts` exports `CATALOG: Record<VisualId, { files: string[] | null; realHeight: number; tint?: number }>` where `realHeight` is the real-world height in metres (×12 gives VISUAL_HEIGHT) and `files: null` for procedural visuals (`planterTree`, `bicycle`, `sneaker`, `startArch`).
- `assets.ts`:
  ```ts
  export interface AssetLibrary {
    /** Deep-cloned, scaled (×12 of real size via catalog), origin at ground centre, facing +Z; null if the visual is procedural or failed. */
    create(visual: VisualId, variant?: number): THREE.Object3D | null;
  }
  export function loadAssets(onProgress?: (fraction: number) => void): Promise<AssetLibrary>;
  ```
  Uses `GLTFLoader` with `import.meta.env.BASE_URL + 'models/...'`. Materials converted to `MeshLambertMaterial` (keep map/color, `flatShading: true`). Missing asset: in DEV throw; in PROD `console.warn` and return null.
- `LICENSES.md`: list each Kenney pack, URL, and "CC0 1.0".
- Total `public/models` size < 6 MB.
- Verification: a node script check (`node scripts/build-assets.mjs --verify`) that prints each file, size, triangle count and height; record output in the task report.

## Task 10: Car model, garage scene, bridge (`src/render/bridge.ts`, `carModel.ts`, `garageScene.ts`)

**Files:** Create those three + `src/render/bridge.test.ts`

```ts
// bridge.ts
export function applyPose(obj: THREE.Object3D, x: number, z: number, heading: number, y?: number): void; // obj.rotation.y = heading
// bridge.test.ts: heading h applied → obj.getWorldDirection() ≈ (sin h, 0, cos h); h = +0.3 turns toward +x.

// carModel.ts
export interface CarModel {
  root: THREE.Group;                       // built facing +Z, origin at ground centre
  /** Wheels steer by car.steer, spin by car.wheelSpin, body rolls with lateral accel, pitches with accel. */
  update(car: CarState, dt: number): void;
  setColor(hex: number): void;
}
export function createCarModel(color?: number): CarModel; // default 0xF0573A
```
Car look (from the user's reference): open-top low-poly buggy, body 4.0 × 1.9 m: rounded slab body (RoundedBoxGeometry), slightly raised hood, dark windshield frame, black seat + headrest, small roll bar, chunky black wheels (r 0.42, width 0.35) with coral hubs, white headlights, red tail lights (emissive, no lights). `MeshStandardMaterial` for paint (roughness 0.45) + Lambert for the rest. Casts shadows.

```ts
// garageScene.ts
export interface GarageScene {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  update(dt: number, time: number): void;   // car slowly rotates on the podium
  resize(width: number, height: number): void;
}
export function createGarageScene(renderer: THREE.WebGLRenderer): GarageScene;
```
Garage look (from the user's garage screenshot): dark room (near-black walls with subtle panels), warm red/coral accent light strips, round podium with a glowing golden rim (emissive ring) and dark top; one key light + rim lights; camera framing the car slightly from above, car centred lower-middle; `RoomEnvironment` PMREM for paint reflections.

## Task 11 (wave 2): World rendering (`environment.ts`, `trackMesh.ts`, `procedural.ts`, `world.ts`, `occlusion.ts`)

```ts
// environment.ts
export function createRenderer(canvas: HTMLCanvasElement, quality: QualityLevel): THREE.WebGLRenderer; // throws on no WebGL; NeutralToneMapping; sRGB; shadows per quality; PCFShadowMap
export interface RaceEnvironment {
  scene: THREE.Scene;
  /** Re-centre the shadow box on the camera look-at point (texel-snapped). */
  updateShadows(focusX: number, focusZ: number): void;
  setQuality(q: QualityLevel): void;
}
export function createRaceEnvironment(renderer: THREE.WebGLRenderer, quality: QualityLevel): RaceEnvironment;
// sky: clear colour = fog colour (soft lavender #dcd9e6-ish), Fog(300, 1200); HemisphereLight + DirectionalLight (scene.add(light.target)), shadow map 2048, box ~170 m, light 400 m back.

// trackMesh.ts
export function createTrackMesh(track: Track): THREE.Group;
// road ribbon (|lat| ≤ 7, y 0.04, asphalt with subtle noise via vertex colours), white dashed centre line (y 0.06),
// curbs (7..8, alternating coral #F0806A / white every 3 m, y 0.06), runoff tiles (8..12, light grey #e4e2de with darker grout, y 0.02),
// low barrier at 12 m (height 0.9, white with a coral stripe), start/finish checker strip across the road at startS.
// Merged per material; matrixAutoUpdate false; road/curbs receive shadows.

// procedural.ts — exact dims must match plaza.ts footprints
export function createBench(): THREE.Group;          // giant bench spanning the road, legs at local (±2.5, ±5.5), seat at 5.4 m, backrest; tagged occluder parts
export function createBicycle(): THREE.Group;        // ~21 m long, wheels r 4.2, frame tubes, coral frame
export function createSneaker(): THREE.Group;        // ~6 m long, white sole, blue upper, laces
export function createPlanterTree(): THREE.Group;    // planter box ~40 m wide, low-poly tree canopy (occluder)
export function createStartArch(width: number): THREE.Group; // two posts beyond the barriers + banner «СТАРТ», checker

// world.ts
export interface World { group: THREE.Group; occluders: THREE.Object3D[]; }
export function createWorld(track: Track, assets: AssetLibrary): World;
// plaza ground (tiles, y 0) over def.ground, wooden deck strip south, decor from track.decor via assets/procedural,
// heavy obstacles from track.heavyPlacements (procedural for bench/bicycle/sneaker), buildings castShadow=false, static merge per sector.

// occlusion.ts
export function createOcclusionFader(occluders: THREE.Object3D[]): { update(camera: THREE.Camera, target: THREE.Vector3): void };
// raycast-free: test camera→target segment against each occluder's world Box3; fade materials to opacity 0.25 (transparent) and back over 0.2 s.
```
Acceptance: a DEV page `/?preview=world` is NOT needed; Task 16 integrates. Provide a pure test `src/render/procedural.test.ts` that builds each procedural object and checks bounding-box sizes match the documented dims (±10 %).

## Task 12: Props and FX (`src/render/props.ts`, `src/render/fx.ts`)

```ts
// props.ts
export interface PropsLayer {
  group: THREE.Group;
  /** Hide taken coins / knocked props; spin coins; animate knocked props along a kinematic arc + tumble, fade after landing. */
  update(pickups: PickupState, time: number, dt: number): void;
  onEvent(e: GameEvent): void;   // 'propKnocked' starts an arc with the event velocity (+ upward 6 m/s)
  resetLap(): void;              // all props back to rest pose
}
export function createPropsLayer(track: Track, assets: AssetLibrary): PropsLayer;
// Coins: InstancedMesh (gold cylinder r 0.9, thickness 0.18, standing upright, emissive rim), frustumCulled = false.
// Cans/cups: InstancedMesh per kind from assets (fallback: procedural cylinder) — hidden instance = zero-scale matrix.

// fx.ts
export interface Fx {
  update(car: CarState, surface: SurfaceKind, dt: number): void; // smoke from rear wheels when drifting or hard braking; skid marks while sliding
  onEvent(e: GameEvent): void;   // 'hit' → spark burst; 'coin' → gold burst; 'respawn' → break skid trails
  reset(): void;
}
export function createFx(scene: THREE.Scene): Fx;
// Smoke: ≤ 200 pooled camera-facing quads (InstancedMesh with per-instance opacity via attribute or Points with size attenuation), depthWrite false, soft white.
// Skid marks: ring buffer ≤ 2000 quads per wheel pair, preallocated BufferGeometry, DynamicDrawUsage, addUpdateRange, frustumCulled false, y 0.07, polygonOffset.
```

## Task 13: Chase camera (`src/render/chaseCamera.ts`)

```ts
export interface ChaseCamera {
  update(car: CarState, dt: number): void;  // car = INTERPOLATED state
  snap(car: CarState): void;                // no smoothing (start, respawn)
  shake(amount: number): void;
  /** Point the camera looks at (for shadows and occlusion). */
  readonly target: THREE.Vector3;
}
export function createChaseCamera(camera: THREE.PerspectiveCamera, t?: Tuning): ChaseCamera;
```
Behaviour per spec §4 using `TUNING.camera`. Yaw target: blend body heading → velocity heading by `smoothstep(headingBlendSpeed, headingBlendSpeed*2, speed)`, body heading when reversing; `yaw += clamp(wrapAngle(target − yaw) * damp(yawSmoothing, dt) , ±maxYawRate*dt)`. Position = car − dir(yaw)·(distance + boost) + up·height; look at car + dir(yaw)·lookAhead + lookHeight. FOV = fov + fovSpeedBoost·(speed/maxSpeed). Shake decays with `shakeDecay`. Test `src/render/chaseCamera.test.ts`: after snap at heading h the camera is behind the car (dot((car − cam), forward) > 0) and above it; with a velocity heading 30° off the body at 25 m/s, after 2 s the camera yaw is closer to the velocity heading than to the body heading.

## Task 14: UI (`index.html`, `src/ui/*`)

**Files:** `index.html`, `src/ui/styles.css`, `src/ui/garage.ts`, `src/ui/hud.ts`, `src/ui/pause.ts`, `src/ui/results.ts`, `src/ui/screens.ts`, `src/ui/share.ts`, `src/ui/format.ts` + `src/ui/format.test.ts`, `src/ui/share.test.ts`

Visual language from the user's garage reference: near-black panels `#151111` with 1px `#2b2220` borders, radius 10–12, coral accent `#F0573A`, gold `#F3B23C` coins, stat colours (speed coral, accel white, handling yellow `#F3B23C`, grip green `#4CAF6A`), headings in Unbounded 700 uppercase with letter-spacing, body Manrope. Import only `@fontsource/unbounded/700.css`, `@fontsource/manrope/500.css`, `700.css`, `800.css`; `ui/screens.ts` exposes `fontsReady(): Promise<void>` awaiting `document.fonts.load('700 1em Unbounded', 'ДРИФТ 0123')` and Manrope weights.

```ts
// index.html: <canvas id="game" tabindex="-1">, <div id="ui"></div>, <script type="module" src="/src/app/main.ts">, lang="ru", title «Drift Rally».

// format.ts
export function formatTime(seconds: number): string;      // 61.234 → "1:01.23"
export function formatPoints(n: number): string;          // 48210 → "48 210" (thin no-break spaces U+202F)
export function formatKmh(ms: number): string;            // m/s → integer km/h string

// share.ts
export function buildShareText(points: number, url: string): string; // «Я набрал 48 210 очков в Drift Rally на трассе «Площадь»! Побей мой рекорд: <url>»
export function copyText(text: string): Promise<boolean>;            // navigator.clipboard, fallback execCommand on a hidden textarea

// garage.ts
export interface GarageUI { update(save: SaveData): void; destroy(): void; }
export function createGarageUI(root: HTMLElement, opts: { save: SaveData; trackName: string; onStart(): void }): GarageUI;
// Top bar: logo «DRIFT RALLY», nav ПРАВИЛА (modal: controls + scoring rules in Russian), ГАРАЖ (active), РЕКОРДЫ (modal: best score, best lap, total coins), coin counter.
// Left panel: «ИСКРА» + bars Скорость 76, Разгон 85, Управление 77, Сцепление 64. Bottom-right: «Площадь · 1», «Рекорд: N». CTA «В ЗАЕЗД» (Enter also starts).

// hud.ts
export interface HudView { lap: number; laps: number; time: number; bestLap: number | null; coins: number; speed: number; chainPoints: number; multiplier: number; chainPhase: 'idle' | 'active' | 'grace'; totalPoints: number; wrongWay: boolean; }
export interface Hud { update(v: HudView): void; onEvent(e: GameEvent): void; setCountdown(value: number | null): void; showHint(visible: boolean): void; destroy(): void; }
export function createHud(root: HTMLElement, opts: { onPause(): void }): Hud;
// Writes DOM only when the rounded displayed value changes; tabular numbers; transform/opacity animations; no backdrop-filter.

// pause.ts
export interface PauseMenu { show(): void; hide(): void; readonly visible: boolean; destroy(): void; }
export function createPauseMenu(root: HTMLElement, h: { onResume(): void; onRestart(): void; onGarage(): void; onQuality(q: QualityLevel): void; onMute(m: boolean): void; quality: QualityLevel; muted: boolean }): PauseMenu;

// results.ts
export function showResults(root: HTMLElement, r: RaceResult, ctx: { newBest: boolean; bestScore: number; shareUrl: string }, h: { onRetry(): void; onGarage(): void }): { destroy(): void };

// screens.ts
export function showLoading(root: HTMLElement): { setProgress(f: number): void; hide(): void };
export function showFatal(root: HTMLElement, kind: 'noWebGL' | 'contextLost' | 'mobile'): void;
export function fontsReady(): Promise<void>;
export function isProbablyMobile(): boolean; // coarse pointer && no fine pointer, or small touch screen
```
Tests: `format.test.ts` (time, points, km/h), `share.test.ts` (text contains points with spaces and the URL).

## Task 15: Audio (`src/audio/sfx.ts`)

```ts
export interface GameAudio {
  /** Create/resume the AudioContext; call from a user gesture. */
  unlock(): Promise<void>;
  setMuted(m: boolean): void;
  suspend(): void;
  resume(): void;
  /** Engine pitch from car.rpm & throttle; screech gain from drift intensity (|slip|, speed). Uses setTargetAtTime. */
  update(car: CarState, throttle: number, drifting: boolean, dt: number): void;
  onEvent(e: GameEvent): void; // coin, hit, scrape, chainBanked, chainBurned, countdown, lap, finish, penalty
  /** Silence engine/screech (garage, results). */
  setEngineActive(on: boolean): void;
}
export function createAudio(): GameAudio;
```
Synthesis per spec §5 Audio; master gain → DynamicsCompressor → destination; engine sources created once. No-op safely when Web Audio is missing. Test `src/audio/sfx.test.ts`: in node (no AudioContext) every method is a safe no-op.

## Task 16 (wave 3): App integration (`src/app/*`)

**Files:** `src/app/main.ts`, `src/app/garageScreen.ts`, `src/app/raceScreen.ts`, `src/app/testHook.ts`, `src/app/debugGui.ts`

- `main.ts`: mobile check → fatal screen; `createRenderer` in try/catch → `noWebGL`; `webglcontextlost` → `contextLost`; load save; quality = save.quality ?? detectQuality(renderer debug info); loading screen (fonts + assets + `compileAsync` of both scenes + one hidden prewarm render) → garage. One `ResizeObserver` → both cameras + renderer size + render once when paused.
- `garageScreen.ts`: garage scene + garage UI; Start → `audio.unlock()` → race screen.
- `raceScreen.ts`: builds track once (cached), race environment, track mesh, world, props, fx, car model, chase camera, occlusion, HUD, pause, input, audio, session; fixed loop: `step` = `session.step(input.sample(), {respawn}, dt)` → route events to HUD/audio/fx/props; render = interpolate car (`lerp` position, `lerpAngle` heading between prevCar and car by alpha; snap when `teleported`) → carModel.update, camera.update, env.updateShadows(camera.target), occlusion.update, fx/props update, HUD.update (≤ 30 Hz), audio.update → `renderer.render`. Pause on Esc/blur/visibilitychange (input.reset, audio.suspend, loop.pause, show menu); resume resets loop time. Finish → save once (`coins += coinsEarned`, `bestScore`, `bestLapMs`), results screen; retry → new session (reuse scene objects, reset props/fx); garage → stop loop, `input.setRacing(false)`.
- `testHook.ts`: when URL has `?test`, expose `window.__game = { startRace(): Promise<void>; step(n: number, input?: Partial<InputFrame>): void; state(): { phase, lap, speed, points, coins, p, frontier }; }`, and force quality low, DPR 1, 640×360 canvas, deterministic (no rAF stepping while the hook drives). As built: plain `?test` applies that render contract; `&full` (saved/auto quality) or `&quality=<level>` opt out for full-size screenshots and FPS runs. Extras: `autopilot(n)` (closed-loop driver), `finish()`, `realtime(driver)`, `info()`.
- `debugGui.ts`: `import.meta.env.DEV` only, dynamic import of `three/addons/libs/lil-gui.module.min.js` and `stats.module.js`; folders for car / drift / camera bound to `TUNING`.

## Task 17 (wave 3): Build, e2e, deploy config

- `vite.config.ts`: `base: './'`.
- `playwright.config.ts`: webServer `npm run build && npx vite preview --port 4173 --strictPort`, chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, use the installed chromium (if version mismatch, run `npx playwright install chromium`).
- `tests/e2e/smoke.spec.ts`: open `/?test`; assert a WebGL2 context exists on `#game`; garage visible (text «В ЗАЕЗД»); `await __game.startRace()`; `__game.step(360)` (countdown); `__game.autopilot(1200)` → `state().p > 50` (closed loop: about 270 m; the open-loop `step(1200, { throttle: 1, steer: 0.2 })` steers into the left barrier and stalls at p ≈ 54, too close to the bound); no `console.error` / `pageerror`; screenshots of garage and race saved under `test-results/` (artifacts only).
- `package.json` scripts: `"e2e": "playwright test"`, `"assets": "node scripts/build-assets.mjs"`.
- Acceptance: `npm run typecheck`, `npm test`, `npm run build` (dist < 10 MB), `npm run e2e` all pass.

## Task 18 (wave 4): Playtest, tuning, review

- Headful-ish visual review: Playwright screenshots at 1280×720 (quality medium: `/?test&quality=medium`, plain `?test` renders 640×360) of garage, race start, fountain sweeper drift, bench pass, hairpin, slalom, results; compare against the reference look; fix visual issues.
- Tune `TUNING` (camera framing like the reference; drift feel) using the autopilot and scripted drift scenarios; keep all tests green.
- Multi-lens code review (correctness, game feel, performance, UI fidelity, spec compliance) with adversarial verification; fix confirmed findings.
