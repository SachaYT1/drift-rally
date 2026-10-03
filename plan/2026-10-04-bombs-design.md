# Bombs on the track: design

## Player-facing behaviour

- Cartoon bombs (black ball, fuse, blinking spark) stand on the road of «Площадь».
- Driving over a bomb blows it up: the car is pushed away from the bomb, loses about half its speed, spins
  a little and leaves the drift (the same recovery as after a heavy wall hit). The camera shakes, sparks and
  smoke burst out, the body hops, a «бах» plays.
- The blast **burns the unbanked drift chain**, exactly like a heavy wall hit: «Сгорело −N» in the HUD,
  banked points untouched. With no chain open the blast only throws the car.
- A blown bomb is gone for the rest of the lap and is back on the next lap (like cans and cups).
- Four bombs, one per long drift: the fountain sweeper (zone 2), the bicycle snake (zone 3), the hairpin
  (zone 5), the top-left corner after the slalom. Each sits on the natural drift line, off the centre, so one
  side always leaves a clear passage: hug the bomb on the drift line or swing wide.

## Simulation (pure modules)

### Data

- `track/trackDef.ts`: `BombDef { id: string; s: number; lateral: number }`, `TrackDef.bombs: BombDef[]`
  (authored in the same (s, lateral) frame as light props).
- `shared/types.ts`: `BombSpot { id: string; x: number; z: number; r: number }`, built into `Track.bombs`
  by `track/build.ts`; new event `{ type: 'bomb'; id: string; x: number; z: number }`.
- `shared/tuning.ts`, new section `bomb` (tests read thresholds from it):
  - `radius` ≈ 0.8 m: trigger radius, tested against the car capsule (`BombSpot.r` = this);
  - `speedKeep` ≈ 0.45: share of the velocity kept;
  - `push` ≈ 7 m/s: velocity added away from the bomb;
  - `yawKick` ≈ 2.5 rad/s: spin added;
  - `shakeImpact` ≈ 14 m/s: the camera shakes as for a heavy hit at this impact speed.

### `game/bombs.ts`

Separate from `pickups.ts`: coins and props are rewards/penalties, a bomb is a hazard with physics.

- `BombState { blown: ReadonlySet<string> }`, `createBombs()`, `resetBombs()` (new lap: all back).
- `updateBombs(state, track, car, t) -> { state, car, events, blasted: boolean }`: every bomb overlapping the
  car capsule (not yet blown) is marked blown and emits `bomb`; the blast impulse is applied once per step,
  from the touched bomb nearest the car centre. Non-finite car positions trigger nothing.
- The capsule-vs-circle overlap helper (`touches`) moves out of `pickups.ts` into a shared module both use.

### `physics/blast.ts`: `applyBlast(car, bomb, t): CarState`

- Velocity: `v' = v * speedKeep + n * push`, `n` = unit vector from the bomb centre to the car centre. When
  the centres (nearly) coincide, `n` is the car's left or right vector, away from the bomb's side (left when
  exactly centred).
- Spin by where the bomb sits under the body (body frame: `lon` along forward, `lat` along left): the end of
  the car over the bomb is thrown away from it, so `yawRate += yawKick * sign(lat) * sign(lon)` (bomb under
  the front left -> nose kicked right; under the rear left -> nose swings left); no kick when `lat` or `lon`
  is 0.
- The car enters `recover` exactly as after a heavy hit: `mode: 'recover'`, `modeTimer: drift.recoverTime`,
  `driftDir: 0`, and leaving a drift resets `driftTime` / `gripBlend`. That block of `collision.ts` `respond()`
  moves into a shared `enterRecover(state, t)` helper used by both.
- Derived fields recomputed (`withDerived`).

### Session and score

- `game/session.ts`: step 4b, right after coins and light props: `updateBombs`. A blast starts the wrong-way
  grace (`startGrace`) like a heavy hit, since the spin can point the car backwards. A lap completion resets
  bombs together with pickups. `SessionState.bombs: BombState`.
- `game/driftScore.ts`: `DriftScoreInput.bombed: boolean`; the chain burns on
  `heavyHit || respawned || bombed` in phases `active` and `grace` (one `chainBurned` per step). No penalty on
  banked points.
- Event order within a step: ... `propKnocked` -> `bomb` -> progress events -> `chainBurned`.

## Placement and autopilot

- Four `BombDef`s in `track/plaza.ts`, exact (s, lateral) chosen during implementation from the actual drift
  path through each corner, |lateral| roughly 1.5–3.5 m.
- Track validation tests (next to the existing prop/obstacle checks):
  - the whole bomb is on the road: `|lateral| + radius <= track.roadHalfWidth`;
  - at least 5 m from any coin, light prop and heavy obstacle footprint;
  - out of reach of the car at the start line, the spawn pose and every respawn marker (bombs come back on lap
    completion, like props; a respawn must never land on a bomb);
  - bombs join the existing widest-free-gap check in `build.test.ts` (across the road), which must stay
    `>= track.minFreeWidth`.
- `app/autopilot.ts`: bombs join the obstacle list (`obstacleEdges` -> `lineAt`), so the autopilot steers
  around them like the sneaker. Test: three autopilot laps produce no `bomb` event and keep the existing
  points threshold (> 15 000), which also proves the placement is drivable.

## Presentation

- `render/procedural.ts`: `createBomb()`: black glossy sphere (r ≈ 0.8 m) on the road, metal collar, curved
  fuse, a blinking emissive spark at its tip (no light source). Casts a shadow like the cans.
- `render/bombs.ts`: one mesh per bomb; reads `RaceFrame.bombs` (the session's `BombState`), hides blown
  bombs, shows them again when the state no longer lists them. `update()` does not allocate.
- `render/fx.ts` on `bomb`: a short additive flash, a large burst of orange sparks (the hit spark pool), a
  couple of dark smoke puffs rising.
- `render/carModel.ts`: visual hop of the body on `bomb` (≈ 0.5 m, ≈ 0.35 s parabola). Rendering only; the
  2D simulation is unchanged.
- `app/raceScene.ts`: `chase.shake(camera.shakePerImpact * bomb.shakeImpact)` on `bomb`; the bombs layer joins
  `sync()` / `reset()`.
- `app/loading.ts`: a fake `bomb` event during prewarm, so the first blast does not hitch on shader compile.
- `audio/sfx.ts`: `bomb` -> «бах»: a noise burst through a falling low-pass plus a low sine thump. The chain
  burn sound follows via `chainBurned` as today.
- HUD: unchanged («Сгорело −N» comes from `chainBurned`).
- Texts: the «Правила» tab in the garage, README («Как набирать очки»), CHANGELOG `[Unreleased]` → «Добавлено».

## Testing (Vitest, tests first)

- `game/bombs.test.ts`: triggers on overlap, once per lap, back after `resetBombs`, nothing when far or with a
  non-finite car, one impulse when two bombs touch at once.
- `physics/blast.test.ts`: pushed away from the bomb, speed reduced, `recover` and drift exit, spin sign for
  front-left / rear-left / centred, coincident centres stay finite.
- `game/driftScore.test.ts`: `bombed` burns an `active` and a `grace` chain, nothing in `idle`, banked total kept.
- Session: a drift into a bomb emits `bomb` then `chainBurned`, starts the wrong-way grace, the bomb is back
  on the next lap; a blast with no chain emits no `chainBurned`.
- Track validation and autopilot as above.
- Render / audio: `bombs` layer hides and restores, fx and sfx handle `bomb` (patterns of the existing
  `fx.test.ts`, `sfx.test.ts`).
- `npm run typecheck`, `npm test`, `npm run e2e:software` (smoke) pass unchanged.

## Out of scope

- Bombs on other maps (there is one map), moving or timed bombs, proximity fuses, scorch marks.
- A dedicated HUD label for the blast.
