-- Friends leaderboard (plan/2026-10-03-leaderboard-design.md).
--
-- Access model:
--  * public.leaderboard: RLS on; anon/authenticated may SELECT only nick, best_score, best_lap_ms (column
--    grants) and never write. key_hash, races and timestamps stay private.
--  * public.leaderboard_ranked: security_invoker view with the place, the only read surface the game uses.
--  * Writes go through submit_result / rename_player (SECURITY DEFINER, they check the browser key
--    themselves). Helpers live in leaderboard_private, which the Data API does not expose.

create table public.leaderboard (
  id bigint generated always as identity primary key,
  nick text not null,
  -- sha256 of the browser's secret key; the key itself is never stored.
  key_hash bytea not null unique,
  best_score integer not null default 0,
  best_lap_ms integer,
  races integer not null default 0,
  -- When the best score or lap last improved.
  updated_at timestamptz not null default now(),
  -- Last submit_result call (rate limit).
  submitted_at timestamptz not null default now(),
  constraint leaderboard_nick_format check (nick ~ '^[A-Za-zА-Яа-яЁё0-9_-]{2,16}$'),
  constraint leaderboard_score_range check (best_score between 0 and 200000),
  constraint leaderboard_lap_range check (best_lap_ms is null or best_lap_ms between 30000 and 3600000),
  constraint leaderboard_races_range check (races >= 0)
);

-- Nicks are unique regardless of case.
create unique index leaderboard_nick_ci on public.leaderboard (lower(nick));
create index leaderboard_standing on public.leaderboard (best_score desc, best_lap_ms asc nulls last);

alter table public.leaderboard enable row level security;
revoke all on table public.leaderboard from public, anon, authenticated;
revoke all on sequence public.leaderboard_id_seq from public, anon, authenticated;
grant select (nick, best_score, best_lap_ms) on public.leaderboard to anon, authenticated;
create policy "leaderboard rows are public" on public.leaderboard
  for select to anon, authenticated using (true);

-- Ties on score and lap share a place.
create view public.leaderboard_ranked with (security_invoker = true) as
  select
    rank() over (order by best_score desc, best_lap_ms asc nulls last)::integer as place,
    nick,
    best_score,
    best_lap_ms
  from public.leaderboard;

revoke all on public.leaderboard_ranked from public, anon, authenticated;
grant select on public.leaderboard_ranked to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private helpers (not reachable through the Data API)
-- ---------------------------------------------------------------------------

create schema leaderboard_private;
revoke all on schema leaderboard_private from public, anon, authenticated;

/** sha256 of a well-formed browser key (64 lowercase hex chars); raises bad_key otherwise. */
create function leaderboard_private.key_hash(p_key text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'bad_key' using errcode = 'P0001';
  end if;
  return sha256(convert_to(p_key, 'UTF8'));
end;
$$;

/** Raises bad_nick unless the nick is 2-16 Russian/Latin letters, digits, _ or -. */
create function leaderboard_private.check_nick(p_nick text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_nick is null or p_nick !~ '^[A-Za-zА-Яа-яЁё0-9_-]{2,16}$' then
    raise exception 'bad_nick' using errcode = 'P0001';
  end if;
end;
$$;

/** The player's row with place and table size, as the game reads it. */
create function leaderboard_private.standing(p_hash bytea)
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
    'best_lap_ms', r.best_lap_ms
  )
  from (
    select
      key_hash,
      nick,
      best_score,
      best_lap_ms,
      rank() over (order by best_score desc, best_lap_ms asc nulls last)::integer as place,
      count(*) over ()::integer as total
    from public.leaderboard
  ) r
  where r.key_hash = p_hash;
$$;

revoke all on all functions in schema leaderboard_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public RPC
-- ---------------------------------------------------------------------------

/**
 * Record finished races under the browser key: creates the player (claiming p_nick) or updates the bests,
 * renaming to p_nick when it changed. p_score / p_lap_ms are the player's bests so far; the table keeps the
 * better of stored and sent. p_races: finishes not sent yet. Errors (message): bad_key, bad_nick, bad_score,
 * bad_lap, bad_races, nick_taken, rate_limited.
 */
create function public.submit_result(
  p_key text,
  p_nick text,
  p_score integer,
  p_lap_ms integer,
  p_races integer default 1
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
      insert into public.leaderboard (nick, key_hash, best_score, best_lap_ms, races)
      values (p_nick, v_hash, p_score, p_lap_ms, p_races);
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'leaderboard_nick_ci' then
      raise exception 'nick_taken' using errcode = 'P0001';
    end if;
    raise;
  end;

  return leaderboard_private.standing(v_hash);
end;
$$;

/** Change the nick of the player who owns p_key. Errors: bad_key, bad_nick, unknown_player, nick_taken. */
create function public.rename_player(p_key text, p_nick text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea := leaderboard_private.key_hash(p_key);
  v_constraint text;
begin
  perform leaderboard_private.check_nick(p_nick);
  begin
    update public.leaderboard set nick = p_nick where key_hash = v_hash;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'leaderboard_nick_ci' then
      raise exception 'nick_taken' using errcode = 'P0001';
    end if;
    raise;
  end;
  if not found then
    raise exception 'unknown_player' using errcode = 'P0001';
  end if;
  return leaderboard_private.standing(v_hash);
end;
$$;

/** True when no player holds the nick (case-insensitive). Runs as the caller: reads only the public nick. */
create function public.nick_available(p_nick text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select not exists (select 1 from public.leaderboard where lower(nick) = lower(p_nick));
$$;

revoke all on function public.submit_result(text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.rename_player(text, text) from public, anon, authenticated;
revoke all on function public.nick_available(text) from public, anon, authenticated;
grant execute on function public.submit_result(text, text, integer, integer, integer) to anon, authenticated;
grant execute on function public.rename_player(text, text) to anon, authenticated;
grant execute on function public.nick_available(text) to anon, authenticated;
