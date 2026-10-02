# Drift Rally — Design Spec (v1)

Status: approved in brainstorming on 2026-10-02/03. Source of truth for implementation.
UI language: Russian. Code, comments, identifiers: English.

## 1. Product

- Hobby browser 3D arcade drift game. Desktop + keyboard only. No backend.
- Deployed later as a static site (GitHub Pages / Netlify / itch.io) and shared with friends. Each player's progress lives in their own browser (localStorage).
- v1 scope: one car («Искра»), one track (map 1 «Площадь»), minimal garage, drift score attack, coins, results with «Поделиться».
- Out of scope for v1: upgrades, paint, shop, opponents, ghost, music, mobile controls, online leaderboard.

## 2. Gameplay

### 2.1 Run structure
Garage → «В ЗАЕЗД» → loading (if needed) → countdown 3-2-1-GO → 3 laps (~1 min each) → results → «Ещё раз» / «В гараж» / «Поделиться».

### 2.2 Controls (mapped by `KeyboardEvent.code`, so they work on a Russian layout)
| Key | Action |
|---|---|
| `KeyW` / `ArrowUp` | throttle |
| `KeyS` / `ArrowDown` | brake; reverse after holding ~0.3 s near standstill |
| `KeyA` / `ArrowLeft`, `KeyD` / `ArrowRight` | steer |
| `Space` | handbrake / drift kick |
| `Escape` | pause |
| `KeyR` | respawn at last respawn marker |
| `KeyM` | mute |

Game keys call `preventDefault()` while racing. UI buttons are blurred when a race starts; `e.repeat` is ignored for actions.

### 2.3 Assisted arcade drift
- Space at speed ≥ 8 m/s with steer held kicks the car into a drift in the steer direction.
- While drifting, the car holds the drift itself. The player controls the **path curvature** with A/D relative to the drift direction: steering into the drift = tighter path and wider angle; neutral = medium; counter-steer = straighter path and smaller angle. Body yaw follows (velocity heading + target slip) through a rate-limited filter, so it cannot oscillate or spin.
- Flick (direction change in the slalom / bicycle snake): strong opposite steer (steer·driftDir ≤ −0.6) + Space press → drift direction flips with a rate-limited body swing; the car stays in drift mode, so the chain stays alive.
- Drift continues while throttle or Space is held. With neither for 0.25 s → exit; lateral grip blends back to normal over 0.3 s (no jolt).
- No drift logic below 8 m/s or when moving backwards.
- Heavy hit → drift ends, 0.4 s recovery (body eases toward velocity heading).

### 2.4 Scoring
- Points accrue only when ALL hold: drifting, |slip| ≥ 10°, surface is road or curb, speed > 8 m/s, unwrapped progress ≥ frontier − 5 m, forward progress speed ds/dt > 2 m/s.
- Rate: `100 pts/s × angleFactor × speedFactor × multiplier`; `angleFactor = min(|slip|, 60°) / 30°`; `speedFactor = clamp(ds/dt / 20, 0, 1.6)`.
- Chain: accrual starts a chain. When accrual stops, a 1.5 s grace timer starts; resuming accrual inside it continues the chain; expiry banks the chain.
- Multiplier = `min(5, 1 + floor(chainDriftTime / 2 s))` (accumulated drifting time in the chain; wiggling cannot pump it).
- Heavy hit (normal impact speed ≥ 6 m/s) or respawn burns the unbanked chain. Contacts below 6 m/s are scrapes: they slow the car, never burn.
- Knocking a light prop: −100 from banked total (floored at 0), once per prop per lap; chain survives.
- Finish banks the active chain.
- All timers use simulation time (fixed steps), never wall clock. Pause freezes everything.

### 2.5 Coins
- ~30 coins per lap on the track (rows on the racing line, some in risky spots). Pickup: coin circle (r 1.4 m) overlapping the car capsule, i.e. ≈ 2.35 m reach from the body axis.
- Coins and knocked light props reset at the start of each lap.
- On finish: `earned = pickedCoins + floor(totalPoints / 1000)`; saved once on finish (quitting forfeits).

### 2.6 Progress, laps, respawn
- Car spawns 3 m after the start line; unwrapped progress `p` starts at 3.
- Projection to the track uses a ±30 m window around the previous `s`; global search only after respawn.
- `ds` per step is wrapped to [−L/2, L/2] and clamped to `|v|·dt·1.5 + 0.5`.
- `frontier = max(frontier, p)`. Lap counter = `floor(frontier / L) + 1`; finished when `frontier ≥ laps·L`. No checkpoint gates.
- Respawn markers every 50 m; R respawns at the last marker ≤ frontier, on the centreline, facing track direction, speed 0.
- Auto-respawn backstop: |lateral| > barrier offset + 2 m, or non-finite state.
- Wrong way: ds/dt < −2 m/s for > 1 s (1.5 s grace after respawn/hit).

### 2.7 Surfaces
`road` (|lat| ≤ 7 m) · `curb` (7–8 m, counts as road) · `runoff` tiles (8–12 m: grip ×0.75, extra drag, top speed ~25 m/s, no points) · barrier at 12 m (one-sided, pushes toward the track).

## 3. World (map 1 «Площадь»)

- Toy scale: physics and camera in car metres (car 4.0 × 1.9 m). World props scaled ×12 relative to real size (person ~20 m, can ~0.8 m wide, bench seat 5.4 m high).
- Daylight, soft pastel flat-shaded low-poly (reference screenshot), office buildings around the plaza, wooden deck, trees.
- Track: centreline = closed centripetal Catmull-Rom through control points below (1 unit = 1 m; mockup y → world z), centred so the plaza centre is the origin. Length ≈ 1.83 km, min radius 24.6 m, min leg gap 66 m, CCW on the top-down map (left turns dominate).

```
[150,378],[270,380],[390,376],[470,385],[535,360],[562,300],[560,238],[540,185],[554,130],[540,85],[490,62],
[420,62],[380,80],[372,150],[372,215],[370,262],[352,288],[330,295],[308,288],[290,262],[287,215],[287,150],
[270,90],[218,72],[163,90],[128,98],[98,124],[84,160],[82,205],[102,250],[82,310],[95,362]
```
(Subtract centre (320, 230) when building world coordinates.)

Zones: 1 start straight (coin row, spectator's giant shoes beyond barrier) · 2 fountain sweeper (cups on outer edge) · 3 bicycle snake (front wheel protrudes onto road edge) · 4 under the giant bench (two legs on the road at lateral ±5.5 m) · 5 hairpin around a planter with a tree (coins on the inside) · 6 soda-can slalom (one smooth wave, cans alternate sides) · 7 sneaker (lies at the road edge at the kink apex, protruding ~2–3 m onto the road).

- Heavy colliders are hand-written footprints (circles / capsules) in track data, not glTF bounds. Nothing outside the barriers gets a collider.
- Decor taller than 5 m must be ≥ 35 m from the centreline (validated by test). Exceptions are tagged `occluder` (bench seat, hairpin tree canopy) and fade to 25 % opacity when they block the camera→car line.

## 4. Camera
High chase camera like the reference: ~25° pitch, far behind, car in the lower third, wide FOV, long view ahead. Yaw target blends from body heading (< 5 m/s or reversing) to velocity direction (at speed), so the drift angle is visible. Exponential smoothing `1 − exp(−k·dt)`, yaw-rate cap, slight FOV/distance increase with speed, shake on heavy hits. Snaps (no smoothing) on race start and respawn. Driven only from interpolated transforms.

## 5. Architecture

Vite + TypeScript (strict, TS 7 for typecheck only) + three r186 `WebGLRenderer`. DOM/CSS UI, no framework. Vitest for logic, Playwright smoke test. Fonts `@fontsource/unbounded` (700) and `@fontsource/manrope` (500/700/800), specific weight files only, awaited before the loading screen hides.

```
src/
  shared/   types.ts (contracts), math.ts, tuning.ts (all gameplay constants)
  physics/  car.ts, collision.ts                       pure TS, unit-tested
  track/    trackDef.ts (types), plaza.ts (map data), build.ts   pure TS, unit-tested
  game/     driftScore.ts, progress.ts, pickups.ts, session.ts   pure TS, unit-tested
  core/     loop.ts, input.ts, save.ts, assets.ts, quality.ts
  render/   bridge.ts, carModel.ts, garageScene.ts, environment.ts, trackMesh.ts,
            world.ts, procedural.ts, props.ts, fx.ts, chaseCamera.ts, occlusion.ts
  ui/       styles.css, garage.ts, hud.ts, pause.ts, results.ts, screens.ts, share.ts
  audio/    sfx.ts
  app/      main.ts (bootstrap), raceScreen.ts, garageScreen.ts, testHook.ts, debugGui.ts
```

Frame: input (edge actions latched; consumed by the first sub-step) → N fixed steps at 120 Hz (cap 12/frame): car → collisions → pickups/props → drift score → progress → returns `GameEvent[]` → render with interpolation (car + camera target only; shortest-arc yaw) → camera → HUD (DOM writes only on value change, ≤ 30 Hz) / audio / fx. Pure modules return events; no global event bus.

Physics ↔ three bridge: `heading` h has forward `(sin h, cos h)` in (x, z); `+yaw` turns left; `object.rotation.y = h` for models built facing +Z. One `bridge.ts`, unit-tested.

### Rendering rules (from critique)
- `setPixelRatio(min(devicePixelRatio, cap))`, quality presets low (1.0, no shadows) / medium (1.25) / high (1.5), saved; default auto (medium; low if WebGL renderer string looks software).
- `NeutralToneMapping`, sRGB output; colours via `Color.setHex` (vertex colours converted).
- Camera `near = 1`, `far = 1500`; fog colour = clear colour, `fog.far ≤ camera.far`.
- Ground layers: plaza 0.00, runoff 0.02, road 0.04, curbs/paint 0.06, skid marks 0.07 (+ `polygonOffset`, `depthWrite: false` on decals).
- Lights fixed for the whole session: 1 hemisphere + 1 directional. `PCFShadowMap` (PCFSoft removed in r186), 2048 map, shadow box ~170 m centred on the camera look-at point, texel-snapped, light ~400 m back along its direction, `scene.add(light.target)`. Buildings/tall decor `castShadow = false`.
- `MeshLambertMaterial` (flat shading) for world; `MeshStandardMaterial` + small `RoomEnvironment` PMREM only for car paint.
- `renderer.compileAsync(scene, camera)` + one hidden prewarm frame with fx visible during loading.
- InstancedMesh only for coins, cans, cups (`frustumCulled = false`); hidden instance = zero-scale matrix. Static decor merged per sector by material; `matrixAutoUpdate = false`.
- One renderer for the app; garage and race scenes both stay resident (no disposal dance). One `ResizeObserver` updates both cameras.
- `webglcontextlost` → "reload" screen. Renderer creation in try/catch → no-WebGL screen.

### Assets
Kenney (CC0, verified): City Kit Commercial (buildings), Mini Characters (people, frozen idle), Food Kit (Soda Can, Soda/Frappe cups), Nature Kit (trees, bushes), Holiday or Coaster Kit (bench, lamp), Fantasy Town Kit (fountain). Procedural: car, track, bicycle, sneaker, planter. Offline script (`scripts/build-assets.mjs`, gltf-transform): pick models → normalise (metallic 0, unlit → lit check, dedup, textures ≤ 1024) → `public/models/*.glb` + `src/render/catalog.ts` with real-world heights for consistent ×12 scaling. Missing asset in dev = loud error; in prod = skip + `console.warn`.

### Audio
Web Audio, synthesized: engine (2 detuned oscillators → lowpass; pitch from rpm), tyre screech (band-passed noise ∝ drift intensity), hit thump, coin blip, chain banked arpeggio, countdown beeps. Master gain → DynamicsCompressor → destination. `AudioContext` created on first gesture; `suspend()` on pause/blur/hidden; params via `setTargetAtTime`. Mute (M) persisted.

### Save (localStorage key `driftRally.save.v1`)
`{ version: 1, coins, bestScore, bestLapMs, quality, muted }`. Corrupt/unavailable → defaults, never throws.

## 6. UI (Russian)
- Garage (minimal): top bar (logo, ПРАВИЛА modal, ГАРАЖ active, РЕКОРДЫ modal, coin counter); left panel «Искра» + stat bars (Скорость 76, Разгон 85, Управление 77, Сцепление 64); car rotating on a golden podium in a dark garage with coral/red accents; bottom-right «Площадь · 1» + best score; CTA «В ЗАЕЗД».
- HUD: top-left card (Круг n/3, time, best lap, pause button); top-centre drift chain (points, ×multiplier, banked «+1 240» flash, «СГОРЕЛО»); top-right coins; bottom-right speedometer (km/h); countdown; wrong-way banner; controls hint for first 6 s. Tabular numbers, transform/opacity animations only, no backdrop-filter in race.
- Pause: Продолжить / Заново / В гараж, quality, mute.
- Results: очки, лучшая цепочка, время, лучший круг, монеты (собрано + за дрифт), «Новый рекорд!», buttons Ещё раз / В гараж / Поделиться (clipboard text: «Я набрал N очков в Drift Rally на трассе «Площадь»! Побей мой рекорд: <url>», fallback: selectable text).
- Screens: loading, no-WebGL, context lost, mobile («Игра для компьютера с клавиатурой»).

## 7. Errors & edge cases
See §2–§6: storage failure → defaults; WebGL missing/lost → screens; tab hidden or window blur → auto-pause + audio suspend; resume resets loop time; dt clamp 0.1 s; NaN/out-of-bounds → respawn; edge inputs latched once; focus/Space handling; audio after gesture.

## 8. Testing
- Vitest (node): physics invariants (no NaN, |slip| ≤ cap, no speed gain without throttle, determinism across frame-dt schedules 1/60, 1/144, jittered), drift entry/hold/exit/flick scenarios with thresholds read from `tuning.ts`; collision (capsule vs circle/capsule/segment, one-sided barrier, impact threshold, cooldown); track validation (radius, offset folds, leg gap, obstacle corridor ≥ car width + 1 m, tall-decor keep-out, spawn pose free); drift score (each exploit: donuts, wrong way, U-turn replay, respawn replay, wiggle multiplier, pause, burn, penalty floor, finish bank); progress (wrap, laps, wrong-way, respawn markers); save (corrupt JSON, missing storage); bridge sign convention.
- Playwright: `?test` mode (seeded, 640×360, DPR 1, shadows off, `window.__game.step(n, input)` / `state()`), Chromium flags `--use-angle=swiftshader --enable-unsafe-swiftshader`; asserts WebGL2 context, garage → race → scripted drive → score/progress > 0, no console errors; screenshots as artifacts only.
- DEV-only lil-gui (from `three/addons/libs`) bound to `tuning.ts` values + Stats.

## 9. Deployment
`vite.config.ts` `base: './'`; `npm run build` → `dist/` < 10 MB; host chosen at publish time.
