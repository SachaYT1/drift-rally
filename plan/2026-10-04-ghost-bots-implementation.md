# Ghost Bots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three bot-driven ghost cars («Новичок», «Профи», «Мастер») race the player on drift points, with live
standings in the HUD, a «Ты против ботов» block in the results and a «Призраки» switch in the garage.

**Architecture:** Each bot is its own `Session` driven by the (moved) autopilot with a per-level style, stepped in
the player's fixed step (`src/game/bots.ts`, pure). `src/app/ghostRun.ts` glues the bot field to the race run
(interpolation, fades, views); `src/render/ghostCars.ts` draws translucent car models with a depth pre-pass and
sprite labels; UI gets `src/ui/standings.ts` and a versus block in `results.ts`; the save gains `ghosts`.

**Tech Stack:** TypeScript (strict, TS 7 typecheck), three r186, Vite, Vitest (+ jsdom DOM suites), Playwright.

Spec: `plan/2026-10-04-ghost-bots-design.md`. Worktree: `.claude/worktrees/ghost-bots`, branch `feature/ghost-bots`.
Commands run from the worktree root. Verification per task: `npx vitest run <files>`, then `npm test` and
`npm run typecheck` before each commit.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `tests/e2e/tsconfig.json` | modify | include `../../src/env.d.ts` (pre-existing typecheck failure) |
| `src/game/autopilot.ts` (+ `.test.ts`) | move from `src/app/` | autopilot; new style knobs |
| `src/game/bots.ts` (+ `.test.ts`) | create | roster, bot field, standings, calibration |
| `src/shared/types.ts` | modify | `SaveData.ghosts` |
| `src/core/save.ts` (+ test) | modify | default, sanitize, persist `ghosts` |
| `src/app/context.ts` (+ test) | modify | `setGhosts`, keep `ghosts` as a live setting |
| `src/render/ghostCars.ts` (+ `.test.ts`) | create | ghost models, depth pre-pass, labels, `ghostOpacity` |
| `src/app/raceScene.ts` | modify | own the ghost layer; `RaceFrame.ghosts` |
| `src/app/ghostRun.ts` (+ `.test.ts`) | create | per-run bot glue: step, interpolate, fade, views |
| `src/app/raceRun.ts` | modify | create/step ghostRun, finish fast-forward, results versus |
| `src/app/raceView.ts` | modify | `HudView.standings` filled by ghostRun |
| `src/ui/standings.ts` (+ `.test.ts`) | create | HUD standings block |
| `src/ui/hud.ts` | modify | mount standings, pass `HudView.standings` |
| `src/ui/results.ts` (+ test) | modify | `versus` block |
| `src/ui/garage.ts` (+ test), `src/app/garageScreen.ts` | modify | «Призраки» switch |
| `src/ui/styles.css` | modify | standings, versus, ghost switch styles |
| `src/app/testHook.ts` | modify | `state().bots` |
| `tests/e2e/smoke.spec.ts` | modify | bots and versus assertions; ghosts-off run |
| `CHANGELOG.md`, `README.md` | modify | docs |

## Shared types (defined in Task 3, used everywhere)

```ts
// src/game/bots.ts
export type BotId = 'rookie' | 'pro' | 'master';
export interface BotDef { id: BotId; name: string; color: number; style: Partial<AutopilotStyle> }
export const BOTS: readonly BotDef[];
export interface BotRun { readonly def: BotDef; readonly session: Session }
export interface BotField {
  readonly bots: readonly BotRun[];
  step(dt: number): void;
  /** Steps unfinished bots to their finish or the cap (race time, s). */
  fastForward(capSeconds?: number): void;
}
export function createBotField(track: Track, roster?: readonly BotDef[], t?: Tuning): BotField;
export interface StandingRow { id: BotId | 'player'; name: string; color: number | null; points: number; finished: boolean }
export function standings(player: { points: number; finished: boolean }, bots: readonly BotRun[], final: boolean): StandingRow[];
export const PLAYER_NAME = 'Ты';
export const BOT_TIME_CAP = 600;
```

`standings`: live (`final` false) uses `score.totalPoints`; final uses `result.totalPoints` when the bot finished,
else `score.totalPoints`. Sort by points desc; ties: player first, then roster order.

---

### Task 0: Baseline fixes

**Files:** `tests/e2e/tsconfig.json`, `package-lock.json`

- [ ] Add `"../../src/env.d.ts"` to `include` in `tests/e2e/tsconfig.json`.
- [ ] `npm run typecheck` → exit 0.
- [ ] Commit `fix(test): declare the app version in the e2e typecheck project` (tsconfig) and
      `chore: sync the lockfile version with package.json` (lockfile).

### Task 1: Move the autopilot to `src/game/`

**Files:** `git mv src/app/autopilot.ts src/game/autopilot.ts`, same for `.test.ts`; update imports in
`src/app/testHook.ts`, `src/game/session.test.ts`, `src/game/testSession.ts`, `tests/e2e/smoke.spec.ts` (if any),
and the moved files' own relative imports (`../game/session` → `./session`).

- [ ] Move, fix imports, update the file header ("Used by the ghost bots, the ?test hook ...").
- [ ] `npm test` (all pass, autopilot suite unchanged) and `npm run typecheck`.
- [ ] Commit `refactor(game): move the autopilot into the game layer`.

### Task 2: Autopilot style knobs and level calibration (R&D, delegated)

**Files:** `src/game/autopilot.ts`, `src/game/autopilot.test.ts`; scratch scripts in `temp/ghost/` only.

New `AUTOPILOT` keys (defaults reproduce today's driving exactly — the existing autopilot tests must pass
unchanged, and the default 3-lap score stays 51 365):
- `throttleCap` (default 1): max throttle in grip and drift.
- rookie weakening via existing keys (`kickCurv`, `exitCurv`, `kickSpeedMargin`, `latShare`) plus `throttleCap`.
- master chain-keeping: keys of the implementer's choosing (e.g. `keepChain` 0/1, a flick-on-straight threshold,
  a counter-steer floor short of a catch) so the bot stays in drift (or re-kicks within `score.graceTime`) between
  corners; deterministic.

Targets on the plaza, 3 laps, `createSession(track)`: rookie 20 000–30 000, pro (default style or near it)
45 000–55 000, master ≥ 85 000; every level finishes, 0 respawns, ≤ 2 heavy hits.

- [ ] Add knobs with defaults; existing autopilot tests pass.
- [ ] Find the rookie and master styles with a scratch sweep script (`temp/ghost/`).
- [ ] Unit tests for the knobs: `throttleCap` caps the throttle of every frame; master style keeps a chain
      through the start straight (a chain alive across the gap where the default style banks).
- [ ] Report the three styles and their scores (points, total time, laps, hits, burns).
- [ ] If master < 85 000 after a serious attempt: stop and report the best score and ideas (do not lower the bar).

### Task 3: Bot field (`src/game/bots.ts`)

- [ ] Tests first (`src/game/bots.test.ts`):
  - roster: 3 bots, unique ids, names «Новичок»/«Профи»/«Мастер», distinct colours.
  - `createBotField` sessions start in countdown at the spawn pose; `step(dt)` advances every bot.
  - calibration: drive a field until all bots finish → ranges of Task 2, order rookie < pro < master, 3 laps,
    no respawn events (count via a session wrapper or by `progress` state; bots drop events, so the test steps the
    sessions with its own loop using the roster styles).
  - `fastForward()` from mid-race finishes all bots; with `capSeconds` small, stops at the cap (time ≈ cap).
  - player isolation: a player session driven by the default autopilot reaches the same final `SessionState`
    whether or not a bot field steps alongside it.
  - `standings`: sort, tie (player above bot; bots in roster order), finished flags, final vs live points.
- [ ] Implement (`createAutopilot(track, t, { ...AUTOPILOT, ...def.style })`).
- [ ] Run tests, `npm test`, typecheck; commit `feat(game): add the ghost bot field and standings`.

### Task 4: Save and settings (`ghosts`)

- [ ] `SaveData.ghosts: boolean`; `DEFAULT_SAVE.ghosts = true`; `sanitize` keeps a boolean, else true;
      `writeSave` persists it. Tests in `src/core/save.test.ts`: default, old record without the field → true,
      `false` round trip, non-boolean → true.
- [ ] `App.setGhosts(on)`; `adopt()` keeps `ghosts` as this tab's live setting (like `muted`);
      `patchSetting` accepts `ghosts`. Test in `src/app/context.test.ts`: `setGhosts(false)` persists only that field.
- [ ] Commit `feat(app): persist the ghost bots setting`.

### Task 5: Ghost render layer (`src/render/ghostCars.ts`)

```ts
export const GHOST_OPACITY = 0.45; export const GHOST_NEAR_OPACITY = 0.1;
export const GHOST_FADE_NEAR = 8; export const GHOST_FADE_FAR = 14; // smoothstep between, m
export const LABEL_MAX_DISTANCE = 250;
export function ghostOpacity(distance: number, fade: number): number;
export interface GhostView { car: CarState; points: number; opacity: number; visible: boolean }
export interface GhostLayer {
  readonly group: THREE.Group;
  /** Build (or rebuild) one ghost per roster entry: colours and names. */
  setRoster(defs: readonly { name: string; color: number }[]): void;
  /** One frame: pose, wheels, opacity, label text and visibility; `cameraPos` for the label range. */
  update(views: readonly GhostView[], snap: boolean, dt: number, cameraPos: THREE.Vector3): void;
  hide(): void;
}
export function createGhostLayer(): GhostLayer;
export function labelText(name: string, points: number): string; // «Профи · 12 400»
```

- Model: `createCarModel(color)`; traverse meshes: `castShadow = false`; colour material clone with
  `transparent: true`, `depthWrite: false`, `opacity`; plus a depth-only sibling mesh (same geometry,
  `MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true })`). `renderOrder`: depth 10, colour 11.
  Opacity per ghost via its colour materials (shared within one ghost).
- Label: `THREE.Sprite` with `SpriteMaterial({ map: CanvasTexture, depthTest: false, transparent: true,
  sizeAttenuation: false })`, `renderOrder` 12, above the car (y ≈ 2.6); redraw canvas only when the text changes
  and ≥ 0.25 s since the last redraw; hidden beyond `LABEL_MAX_DISTANCE` from the camera or when the ghost is hidden.
  Canvas drawing guarded for test environments without 2D context (node): skip the texture redraw.
- [ ] Tests (`src/render/ghostCars.test.ts`, node): `ghostOpacity` (far, near, between monotonic, fade 0 → 0);
      `labelText`; layer: after `setRoster` 3 ghosts, no mesh casts shadows, colour materials transparent with
      depthWrite false, depth meshes colorWrite false, renderOrder depth < colour; `update` sets positions and
      opacity; `hide()` hides all.
- [ ] Commit `feat(render): draw translucent ghost cars with name and score labels`.

### Task 6: HUD standings and results versus block

- `src/ui/standings.ts`: `createStandings(parent: HTMLElement): { update(rows: readonly StandingRow[] | null): void;
  destroy(): void }` — section `.dr-panel.dr-standings` placed under the coin card; 4 `li` rows (place, dot with the
  bot colour, name, points, ✓ when finished), player row `.is-player`; DOM written only when a row's displayed
  values change; `null` hides the block.
- `HudView.standings: StandingRow[] | null` (raceView fills `null`; ghostRun fills rows).
- `results.ts`: `ctx.versus?: StandingRow[] | null` → block `.dr-versus` under `.dr-results__grid`:
  «Ты против ботов» eyebrow, «Место: N из M», rows.
- CSS in `styles.css` next to the HUD / results rules.
- [ ] Tests: `src/ui/standings.test.ts` (rows, order, player highlight, ✓, change-only writes, null hides);
      `src/ui/results.test.ts` (versus present with place line; absent without `versus`); `src/ui/hud.test.ts`
      (standings block hidden for `null`, shown for rows).
- [ ] Commit `feat(ui): show the ghost standings in the HUD and the versus block in the results`.

### Task 7: Garage switch

- `createGarageUI` opts: `onGhosts(on: boolean): void`; button `.dr-ghosts[role=switch]` with a ghost SVG and the
  label «Призраки» before the sound switch; `aria-checked` follows `save.ghosts`; pointer click blurs (Enter must
  still start the race).
- `garageScreen.ts`: `onGhosts: (on) => app.setGhosts(on)`.
- [ ] Tests in `src/ui/garage.test.ts`: switch reflects the save, click toggles and calls `onGhosts`, update()
      follows a new save.
- [ ] Commit `feat(ui): add the ghost bots switch to the garage`.

### Task 8: Race wiring (`ghostRun.ts`, `raceRun.ts`, `raceScene.ts`, test hook)

```ts
// src/app/ghostRun.ts
export const GHOST_FADE_TIME = 0.5;
export interface GhostRun {
  readonly field: BotField;
  step(dt: number): void;
  /** Player finished: fast-forward the bots and start fading every ghost. */
  finish(): void;
  /** Ghost views for one render (interpolated with `alpha`, opacity from the player's car). */
  views(alpha: number, snap: boolean, player: CarState, dt: number): readonly GhostView[];
  standings(player: { points: number; finished: boolean }): StandingRow[];
  finalStandings(playerPoints: number): StandingRow[];
}
export function createGhostRun(track: Track, roster?: readonly BotDef[]): GhostRun;
```

- Fades: per bot `fade` 1 → 0 over `GHOST_FADE_TIME` of render time once its session finished or the player
  finished; views reuse one `CarState` per bot (no per-frame allocation).
- `raceScene`: `createGhostLayer()` added to the scene; `setRoster(BOTS)` once; `RaceFrame.ghosts:
  readonly GhostView[] | null`; `sync()` calls `ghosts.update(f.ghosts, f.snap, dt, camera.position)` or `hide()`;
  `reset()` hides.
- `raceRun`: `const ghosts = app.save.ghosts ? createGhostRun(app.track) : null`; `simStep` → `ghosts?.step(dt)`
  after the player step; `syncVisuals` passes `frame.ghosts = ghosts?.views(...) ?? null`; `hudTick` fills
  `hudView.standings`; `onFinish` → `ghosts?.finish()` before results; `showResults(..., { versus:
  ghosts?.finalStandings(result.totalPoints) ?? null })`.
- Test hook: `GameTestState.bots: { id: string; points: number; finished: boolean }[]` from
  `run.ghosts?.field` (expose `RaceRun.ghosts: GhostRun | null`).
- [ ] Tests `src/app/ghostRun.test.ts`: step advances bots; views interpolate and keep identity across calls;
      opacity drops near the player; finish() fast-forwards and fades to 0 after `GHOST_FADE_TIME`; standings rows.
- [ ] `npm test`, typecheck, `npm run build`; commit `feat(app): race the ghost bots alongside the player`.

### Task 9: e2e and manual check

- [ ] `tests/e2e/smoke.spec.ts`: after the drift step, `state().bots` has 3 entries with points > 0 for at least one;
      after finish, `.dr-versus` visible with «Ты против ботов». New test: `localStorage` save with `ghosts:false`
      (via `page.addInitScript`) → no `.dr-standings`, no `.dr-versus`, `bots` empty.
- [ ] `npm run e2e:software` (and `npm run e2e` if a GPU is available) pass.
- [ ] Manual: `npm run dev` / preview with the autopilot (`?test&full`, `__game.realtime('autopilot')`), screenshots
      at start, mid-race, results (`temp/ghost/`); FPS with and without ghosts.
- [ ] Commit `test(e2e): cover the ghost bots`.

### Task 10: Docs and review

- [ ] `CHANGELOG.md` `[Unreleased]` → «Добавлено»: боты-призраки «Новичок», «Профи», «Мастер» с местами в
      заезде и блоком «Ты против ботов»; переключатель «Призраки» в гараже. `README.md`: a line in the scoring
      paragraph about the bots and the switch.
- [ ] Code review (code-reviewer agent) of the branch diff; fix findings; final `npm test`, typecheck, build, e2e.
- [ ] Commit `docs: describe the ghost bots`.
