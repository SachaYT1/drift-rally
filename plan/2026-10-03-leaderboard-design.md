# Friends leaderboard: design

## Player-facing behaviour

- **Nick.** After a finish the results screen offers an optional field «Попади в таблицу друзей» (2–16 chars:
  Russian/Latin letters, digits, `_`, `-`). A taken nick shows «ник занят, выбери другой» while typing
  (debounced check) and on submit. The nick can be changed later in «РЕКОРДЫ».
- **«РЕКОРДЫ»** in the garage gains a friends table: top 20 (nick, score, best lap), the player's own row
  highlighted, and the player's row appended below the top when they rank lower than 20th.
- **After every finish** (once a nick is set) the result is sent automatically and the results screen shows
  «Место в таблице: #3 из 12». A run that does not beat the player's best leaves the table unchanged.
- **Offline**: the game works as before; unsent finishes are kept and sent on the next launch.

## Architecture

- Supabase project `brezucvcujjioibrmerd`, migration `supabase/migrations/20261003150000_leaderboard.sql`.
- Table `public.leaderboard`: nick (unique, case-insensitive), sha256 of the browser key, best score, best
  lap (ms), races, updated_at (bests improved), submitted_at (rate limit).
- **Browser key**: on the first nick the game generates 32 random bytes (64 hex chars) and keeps them in
  localStorage (`driftRally.leaderboard.v1`). Only the hash is stored server-side; only the browser holding the
  key can update the row. No passwords.
- **Writes** only through RPC (`SECURITY DEFINER`, `search_path = ''`):
  - `submit_result(p_key, p_nick, p_score, p_lap_ms, p_races)`: creates or updates the player, keeps the
    better of stored/sent bests, renames when the nick changed. Limits: score 0..200 000, lap 30 s..1 h,
    races 1..100 per call, at most one call per 10 s per player.
  - `rename_player(p_key, p_nick)`.
  - `nick_available(p_nick)` (`SECURITY INVOKER`, reads only the public nick column).
  - Errors are `P0001` with the message as a code: `bad_key`, `bad_nick`, `bad_score`, `bad_lap`, `bad_races`,
    `nick_taken`, `rate_limited`, `unknown_player`. PostgREST answers HTTP 400 with `{ message }`.
- **Reads**: view `public.leaderboard_ranked` (`security_invoker`, `rank()` by score desc, lap asc nulls last).
  RLS on the table, a public SELECT policy and column grants on nick/best_score/best_lap_ms only; the key hash
  is unreadable even directly.
- The private helpers live in schema `leaderboard_private`, which the Data API does not expose.
- **Client**: plain `fetch` to the REST API (no SDK). Project URL and publishable key live in the code; the key
  is public by design, the access rules protect the data.

### Client modules

- `src/core/leaderboardApi.ts`: REST client, never throws, results as `{ ok, value } | { ok: false, error }`.
- `src/core/leaderboardIdentity.ts`: nick validation, browser key, localStorage record
  `{ key, nick, pendingRaces }`.
- `src/app/leaderboard.ts`: the service the screens use (finish → count + submit, join/rename, board, flush
  pending at boot).
- UI: `src/ui/nickForm.ts` (shared nick field), results slot in `src/ui/results.ts`, friends table in the
  garage records modal (`src/ui/leaderboardView.ts`).

### Pending model

Every finish increments `pendingRaces`. With a nick, the service sends `{ bestScore, bestLapMs }` from the save
plus `pendingRaces`, and resets the counter on success. `rate_limited` / network failures keep it for the next
launch; `bad_*` rejections drop it (retrying cannot succeed). `nick_taken` on an automatic submit clears the
nick so the player picks a new one.

## Honest limitations

- No anti-cheat: scores are computed in the browser; a knowledgeable player can submit a fake result. The
  limits only cut obvious garbage. Acceptable for friends.
- The free Supabase project pauses after 7 days without activity: the table then shows «недоступна» and the
  game keeps working. Wake it from the Supabase dashboard.
- Nicks are public to anyone with the game link.
- Advisors flag `submit_result` / `rename_player` as anon-executable `SECURITY DEFINER` functions: intentional,
  they are the only write path and authorise by key hash.

## Verification

- Client unit tests with a fake `fetch`.
- SQL checks in the database (as `anon`, rolled back): foreign key, invalid data, rate limit, direct writes and
  key-hash reads denied.
- e2e with mocked server responses (`page.route`).
- Live run: two browser contexts with different nicks against the real project.
