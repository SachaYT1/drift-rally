# Ghost bots: design

Status: approved in brainstorming on 2026-10-04. Source of truth for implementation.
UI language: Russian. Code, comments, identifiers: English.

## 1. Goal

Make a race more interesting with three ghost cars driven by bots of fixed skill. The player races them on the
game's own currency, drift points, and sees a live place and a final «you vs bots» table. Ghosts are pure
competition: they never touch the player, the coins, the records or the friends table.

Out of scope: ghosts of the player's own or friends' runs, adaptive difficulty, choosing individual bots, bot
sounds or tyre effects, a ghost toggle in the pause menu.

## 2. Player-facing behaviour

### 2.1 Bots

| id | Name (UI) | Target score (3 laps) | Colour |
|---|---|---|---|
| `rookie` | «Новичок» | ~25 000 (accepted 20 000–30 000) | mint |
| `pro` | «Профи» | ~50 000 (accepted 45 000–55 000) | blue |
| `master` | «Мастер» | ~90 000 (accepted ≥ 85 000) | violet |

Reference points (2026-10-04): today's autopilot scores 51 365 in 174.9 s (laps 59.6 / 57.7 / 57.6 s); the
friends table holds 120 343, 93 284, 64 946 and 25 657. Bots score under exactly the player's rules (chains,
multiplier, penalties), because each bot runs its own game session.

### 2.2 In the race

- All bots start from the player's spawn pose, overlapping the player's car like ghosts in TrackMania, and
  spread out after GO. Spawn logic is unchanged.
- A ghost is a translucent «Искра» in the bot's colour, opacity 0.45. No shadow, smoke, skid marks or sound.
- Proximity fade: a ghost overlapping the player's car (closer than 4 m, e.g. on the start grid) is not drawn,
  and it fades in up to full ghost opacity at 14 m, so it never tints the player's car, piles labels on it or
  blocks the view. (Changed from "~0.1 within 8 m" after the first visual check: a ghost exactly on the player's
  car tinted it.)
- Above each ghost a label: bot name in its colour and its current points, e.g. «Профи · 12 400».
- HUD: a standings block under the coin counter (top right): 4 rows sorted by current points (place, colour dot,
  name, points). The player's row reads «Ты» and is highlighted; a finished bot shows a ✓.
- The player's respawn (R) and hits do not affect bots; pause freezes everyone.
- A bot that finishes before the player fades out over 0.5 s and keeps its final points (✓) in the standings.

### 2.3 Finish and results

- When the player finishes, every bot still racing is simulated to its finish at once (no rendering) and all
  ghosts fade out over 0.5 s.
- The results screen gains a «Ты против ботов» block under the stat tiles, above the coins: «Место: 2 из 4» and
  4 rows by final points.
- Coins, personal records and the friends table are computed from the player's run only, exactly as today.

### 2.4 Garage toggle

- A «Призраки» switch next to the sound switch in the garage top bar (`role="switch"`, like the sound one),
  on by default, persisted in the save.
- Off: no bots, no standings block, no results block — the race is exactly as before this feature.
- The switch applies from the next race. It is not offered in the pause menu.

## 3. Simulation

### 3.1 Autopilot move

`src/app/autopilot.ts` (+ test) moves to `src/game/autopilot.ts`: bots make it gameplay, and `game/` must not
depend on `app/` (today `game/session.test.ts` and `game/testSession.ts` already import it from `app/`). The
test hook, the e2e smoke and the FPS measurements only change their import.

### 3.2 Driving styles

`AutopilotStyle` gains knobs that define a skill level; the defaults reproduce today's autopilot exactly (its
existing tests keep passing unchanged):

- Weakening (rookie): a throttle cap, fewer drift kicks (higher `kickCurv`), earlier drift exits.
- Strengthening (master): a chain-keeping mode — on a short straight the bot keeps sliding (partial counter-steer
  or a flick into the next corner) instead of catching the slide, so the chain survives the gap between corners
  and the multiplier reaches ×5.

All knobs are deterministic (no randomness). The exact knob set is settled during calibration.

### 3.3 Bot field (`src/game/bots.ts`, pure TS)

- `BOTS`: the roster `{ id, name, color, style }` × 3 (§2.1).
- `createBotField(track, roster = BOTS)` creates one `Session` (`createSession(track)`, no lap seed) and one
  autopilot per bot:
  - `step(dt)`: one fixed step for every bot still racing; `session.step(autopilot(state), { respawn: false }, dt)`;
    bot events are dropped (bots are silent).
  - `fastForward()`: steps unfinished bots until they finish or reach the cap of 600 s race time.
  - `bots()`: per bot `{ id, name, color, state }` for rendering and points.
- `standings(player, bots)`: pure; rows `{ id, name, color, points, finished, isPlayer }` sorted by points
  descending; on a tie the player ranks above a bot, and bots keep roster order. Live standings use banked
  points plus the running chain (`score.totalPoints + score.chainPoints`, for the player too: the master keeps
  one chain for the whole race, so banked points alone would show it at 0 until the finish); final standings
  use `result.totalPoints`. A bot cut off by the cap counts with
  its points at the cap and is marked not finished.

### 3.4 Frame order

`raceRun` steps the player's session, then the bot field, with the same `dt`, inside the same fixed step. All
sessions are created together, so the countdown is in sync. Pausing stops the loop and therefore everyone. On
the player's finish `onFinish` calls `fastForward()` synchronously (expected ≤ 0.2 s worst case, during the
«Финиш!» toast).

### 3.5 Calibration

Bots are deterministic, so their scores are fixed numbers. `bots.test.ts` runs the 3 full races (~0.4 s total)
and asserts: scores within the §2.1 ranges, rookie < pro < master, 3 laps finished, 0 respawns. A physics change
that moves a level breaks the test.

Risk: the master level is the only open-ended part. If ≥ 85 000 is not reached within reasonable effort, stop and
report the measured score and options to the user instead of silently lowering the bar.

## 4. Rendering and UI

### 4.1 Ghost cars (`src/render/ghostCars.ts`)

- One `createCarModel()` per bot, painted with the bot colour; every mesh `castShadow = false`; no env map.
- Translucency without the "x-ray" look (wheels and seats showing through the body): two passes per mesh. A
  depth-only pass (`colorWrite: false`) followed by the colour pass (cloned materials, `transparent: true`,
  `depthFunc: LessEqualDepth`) so only the nearest surface is blended. Both passes are transparent objects with
  a `renderOrder` above the default, so they draw after the opaque world (no holes) and the depth pass precedes
  the colour pass.
- `ghostOpacity(distanceToPlayer, fade)`: pure, unit-tested; 0 up to 4 m, smoothstep to 0.45 at 14 m;
  `fade` (1 → 0 over 0.5 s) for finished bots and the player's finish.
- Label: a `Sprite` with a `CanvasTexture` (name in the bot colour + points), `sizeAttenuation: false`, redrawn
  only when the rounded points change and at most 4 times per second; hidden beyond ~250 m.
- Draw cost: 3 × 14 draw calls + 3 sprites.

### 4.2 Wiring

- `src/app/ghostRun.ts`: the per-run bot glue — owns the bot field, the per-bot interpolated `CarState`s
  (`interpolateCar(prev, car, alpha, snap, out)`, no per-frame allocation), the fade timers and the HUD/results
  views. Keeps `raceRun.ts` (310 lines) from growing much.
- `raceRun.ts` creates it only when `app.save.ghosts` is on; steps it in `simStep`; passes the ghost frames in
  `RaceFrame.ghosts`; calls `fastForward()` in `onFinish`; hands the final standings to the results screen.
- `raceScene.ts`: owns the ghost layer (built once with the scene); `sync()` applies `RaceFrame.ghosts`;
  `reset()` hides the ghosts.
- HUD: the standings block lives in a new `src/ui/standings.ts` (markup + change-only updates) that `hud.ts`
  (368 lines) mounts under the coin counter; DOM written only on change, at the HUD's ≤ 30 Hz; absent when ghosts
  are off. `HudView` gains `standings: StandingRow[] | null`.
- Results (`src/ui/results.ts`): optional `versus` in the context renders the «Ты против ботов» block.

### 4.3 Save and garage

- `SaveData.ghosts: boolean`, default `true`. `version` stays 1: saves without the field read as `true`
  (`sanitize`); `writeSave` persists it.
- `app.setGhosts(on)` patches only its field, like `setMuted`.
- Garage top bar: the «Призраки» switch next to the sound switch.

### 4.4 Test hook

`window.__game.state()` adds `bots: { id, points, finished }[]` (empty when ghosts are off).

## 5. Edge cases

- «Заново» / «Ещё раз»: a new run creates a new bot field; the ghost models live in the cached race scene and
  are only hidden and reset.
- Player finishes first: bots fast-forwarded, ghosts fade out.
- Bot finishes first: its session freezes; its ghost fades out; HUD shows ✓ and its final points.
- Hidden tab / lost focus: the existing auto-pause stops the loop, bots included.
- `?test`: bots follow the save; e2e sets the toggle through `localStorage` before load.
- A bot leaving the track or going non-finite hits the session's existing backstop respawn; calibration tests
  require 0 respawns.

## 6. Testing

- `game/bots.test.ts`: calibration (§3.5); `standings` (sorting, ties, finished flag, cap); `fastForward`
  (finishes, respects the cap); bots do not affect the player — a scripted player run with and without a bot
  field yields the same player `SessionState`.
- `game/autopilot.test.ts`: moved as is, plus tests for the new style knobs (defaults unchanged).
- `render/ghostCars.test.ts`: `ghostOpacity`; materials transparent with the depth pass; no shadows; label text.
- `core/save.test.ts`: `ghosts` field — default for old saves, round trip.
- `ui/standings.test.ts`, `ui/hud.test.ts`, `ui/results.test.ts`, `ui/garage.test.ts`: standings block, versus
  block and the switch present when ghosts are on, absent when off.
- `app/ghostRun.test.ts`: HUD and results views from bot states, fade timers.
- e2e (`tests/e2e/smoke.spec.ts`): with ghosts on, `state().bots` points grow and the results show «Ты против
  ботов»; a second run with ghosts off shows no block.
- Manual: a race in `npm run dev`, screenshots of the start, mid-race and results; FPS with and without ghosts.

## 7. Docs

- `CHANGELOG.md` → `[Unreleased]` → «Добавлено»: ghost bots and the garage switch.
- `README.md`: one line about the bots and the «Призраки» switch.

## 8. Pre-existing issue fixed alongside

`npm run typecheck` fails on `develop`: `tests/e2e/tsconfig.json` pulls in `src/app/main.ts` but not
`src/env.d.ts`, so `__APP_VERSION__` (v0.3.0 version label) is undeclared there. Fix: add `../../src/env.d.ts` to
that project's `include`, as its own commit.
