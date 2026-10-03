# Integration notes for Task 16 (app wiring)

Collected from the wave 1–2 implementer and reviewer reports. Treat as binding unless the code says otherwise (then trust the code and report the mismatch).

## Session (`src/game/session.ts`)
- `createSession(track, { laps, bestLap, tuning })`. `bestLap` is in **seconds** (save stores ms: convert).
- `state().teleported` is true from creation through every countdown step; the first racing step clears it; afterwards only a respawn sets it. On `teleported`: snap interpolation (`prevCar = car`), `chase.snap(car)`, `carModel.reset()`, and break fx trails (`fx.onEvent({type:'respawn'})` is delivered by the session on respawn; at race start call `fx.reset()` yourself).
- Event order within one step: respawn, hit|scrape, coin/propKnocked, lap/wrongWay, score events (chainStart, multiplier, chainBanked, chainBurned, penalty), finish.
- `hit` = heavy contact, always reported. `scrape` at most once per `TUNING.collision.cooldown` per collider. At most one hit or scrape per step.
- `chainBanked` / `chainBurned` may carry 0 points. A 0-point bank shows and sounds nothing (HUD and audio skip it); a 0-point burn still flashes «Сгорело» and plays the burn cue (a chain was lost).
- `propKnocked` fires for every knocked can/cup. `penalty` carries the points actually deducted (banked total floored at 0) and is **not** emitted when nothing was deducted. Audio plays the knock on `propKnocked` and only a short extra cue on `penalty`; the HUD flashes −N only on `penalty`.
- Lap events: `best` is true only when the lap beats the seeded record (if any) and every earlier lap of this race; the first lap without a record is never best.
- After `finish`, `step()` returns `[]` and state stops changing.
- If the app changes a `CarState`'s vx/vz/heading outside `stepCar`, use `withDerived(state)` from `src/physics/car.ts`.
- Heading is **unwrapped**: interpolate with `lerpAngle` (shortest arc).

## Loop (`src/core/loop.ts`) and input (`src/core/input.ts`)
- Call `input.sample()` once per **physics step** (inside the `step` callback), never per frame: it consumes the Space edge.
- `FixedLoop.start()` always begins unpaused (even if `pause()` was called while stopped). To start paused, call `pause()` right after `start()`.
- `pause()`/`stop()` inside `step()` skips the remaining sub-steps and renders that frame once with `alpha = 0`. Route events to HUD/audio/fx **before** calling `audio.suspend()` / `pauseMenu.show()`.
- While paused, `advance()` neither steps nor renders: re-render explicitly on resize while paused.
- On resume drop the latches (an Esc or R pressed in the pause menu must not act on the first step) and `loop.resume()`. As built (`src/app/pauseInput.ts`): `setRacing(false)` → `setRacing(true)` drops latches but keeps held keys, so W held through an Esc pause keeps driving; `input.reset()` only when the pause came from blur / a hidden tab (keyups may be lost).
- `input.setRacing(true)` while racing (preventDefault for game keys); `false` in garage/results. Blur the active element / focus the canvas when a race starts.

## Rendering
- Assets: `loadAssets()` once; `create()` returns per-call **material clones** (geometry/textures shared — never dispose those).
- Do **not** set `scene.environment` on the race scene (washes out Lambert). Car paint: `raceCar.setEnvMap(garage.envMap, 0.6)` (`RACE_ENV_INTENSITY` in raceScene.ts).
- `CarModel.reset()` on teleport/respawn/race start. Front wheels counter-steer in drift mode (accepted deviation from the plan doc).
- `fx.update(effectsCar, state().surface, frameDt)` every frame (`effectsCar` = the interpolated car; after the finish raceRun passes it parked so tyre smoke stops); `props.update(session.state().pickups, simTime, frameDt)` with **simulation** time (coins freeze while paused). Send every session event to `fx.onEvent` and `props.onEvent`. `props.resetLap()` on `lap` events; `fx.reset()` on race start/restart. Skid marks persist between laps by design.
- Chase camera: `chase.update(interpolatedCar, frameDt)` (`chase.snap(car)` on teleport); on heavy `hit`: `chase.shake(TUNING.camera.shakePerImpact * impactSpeed)` (capped internally at `shakeMax`).
- Shadows: `env.updateShadows(car.x, car.z, target.x - car.x, target.z - car.z)` with `target = chase.target`: the shadow box is centred `SHADOW_LEAD` (58 m) ahead of the car along the camera yaw (only the direction counts), not on the look-at point.
- Occlusion: `fader.update(camera, carCentre, frameDt)` (car centre at y 0.6); `fader.reset()` on race start.
- All of the above runs in `RaceScene.sync()` / `onEvent()` / `reset()` (`src/app/raceScene.ts`).
- Garage: `createGarageScene(renderer)`; framing helpers exist (`applyGarageFraming`).
- World pieces are assembled by `createRaceScene` (`src/app/raceScene.ts`): `createRaceEnvironment`, `createTrackMesh`, `createWorld`, `createPropsLayer`, `createFx`, `createCarModel`, `createChaseCamera`, `createOcclusionFader`.

## UI
- HUD and pause menu must share the same root (`#ui`) for the pause freeze to work. `PauseMenu.sync()` exists.
- The garage UI instance is single-use (start guard): destroy it on leaving the garage and create a new one on return. The contract has no hide().
- Handle Esc while paused in the app: `pause.hide()` + resume.
- Results: `showResults(root, result, { newBest, bestScore, shareUrl: location.href.split(/[?#]/)[0] }, { onRetry, onGarage })` (the share URL drops both the query and the hash).

## Audio
- `audio.unlock()` from the «В ЗАЕЗД» click. `setEngineActive(true)` at countdown start, `false` in garage/results. Every frame: `audio.update(car, input throttle, car.mode === 'drift', frameDt)`. `onEvent` for every session event. `suspend()` on pause/blur/hidden, `resume()` on unpause. Mute (M / pause menu) → `setMuted` + save.

## Save
- On finish only: `recordRaceResult(app, result)` (`src/app/saveResult.ts`) → `app.updateSave`, a read-modify-write on the save as stored NOW (another tab may have saved since): `coins += result.coinsEarned`, `bestScore = max`, `bestLapMs = min(existing, round(result.bestLap*1000))`; «Новый рекорд» is judged against the stored save. Quitting mid-race forfeits.
- `app.save` follows other tabs through the `'storage'` event. main.ts reads the save at boot, before loading, when nothing listens yet: `createApp()` re-reads the stored progress and installs the listener in the same task, so a race finished in another tab during loading is not missed.
- Settings (quality, muted) are this tab's live state: change them with `app.setQuality` / `app.setMuted`, which patch only their own field of the stored save. A test quality override (`?test`, `&quality=`) is never persisted.
