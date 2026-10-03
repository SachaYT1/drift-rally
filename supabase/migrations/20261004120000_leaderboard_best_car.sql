-- Friends leaderboard: remember which car set each player's best score (plan/2026-10-04-sport-cars.md).
--
-- submit_result gains p_car (default null, so clients that do not send it keep working). The table keeps the car
-- of the best score: it changes only when the score improves. The 5-argument submit_result is dropped, not
-- overloaded: with both, PostgREST could not choose between them for a call without p_car.
--
-- Apply BEFORE merging the client to master (every push to master deploys it). Without this migration the new
-- client breaks: reading the table with best_car answers 400 (undefined column), so «Рекорды» shows its error
-- state, and submit_result with p_car answers "function not found", so finishes stay queued as offline.

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
