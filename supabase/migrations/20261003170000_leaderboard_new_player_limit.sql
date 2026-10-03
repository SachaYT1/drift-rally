-- Friends leaderboard: cap how fast new players can appear (code review M2).
--
-- The 10 s limit in submit_result only holds once a row exists for a key; a script minting a fresh key per call
-- could create rows without bound, filling the top and squatting nicks. New players are now limited to 20 per
-- minute across the table. A second insert racing the first under the same key (two tabs) answers rate_limited
-- instead of a raw duplicate-key error.

alter table public.leaderboard add column created_at timestamptz not null default now();
create index leaderboard_created on public.leaderboard (created_at);

create or replace function public.submit_result(
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
      if (select count(*) from public.leaderboard where created_at > now() - interval '1 minute') >= 20 then
        raise exception 'rate_limited' using errcode = 'P0001';
      end if;
      insert into public.leaderboard (nick, key_hash, best_score, best_lap_ms, races)
      values (p_nick, v_hash, p_score, p_lap_ms, p_races);
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

-- Clean-up of junk rows, run by hand in the SQL editor when needed:
--   delete from public.leaderboard where created_at > now() - interval '1 hour' and races <= 1;
