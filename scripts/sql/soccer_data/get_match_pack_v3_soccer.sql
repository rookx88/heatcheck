-- HeatChecks: MatchPack V3 (soccer_data)
-- Install:
--   psql "$SOCCER_DATA_DATABASE_URL" -f scripts/sql/soccer_data/get_match_pack_v3_soccer.sql
--
-- This function is adapted to the actual soccer database schema:
--   - dim_team (not teams) with team_name_std (not full_name)
--   - matches (not games) with match_id (not game_id) and date_utc (not game_date_utc)
--   - team_form_rollups has pre-calculated xg_diff for different windows
--   - team_match_stats has per-match xG data
--   - match_table_snapshot has standings data

create or replace function public.get_match_pack_v3_soccer(
  p_team_a text,
  p_team_b text,
  p_game_date date default null,
  p_season varchar default null,
  p_close_xg_diff numeric default 0.5,
  p_form_leaders int default 3
) returns jsonb
language sql
stable
as $$
with
-- 1) Resolve team IDs (flexible): prefer teams with standings data, then exact match, then partial match
-- Also handle common suffixes like "FC", "United", etc.
ta as (
  select 
    dt.team_id, 
    dt.team_name_std, 
    dt.league
  from public.dim_team dt
  left join lateral (
    select 1 as has_standings
    from public.league_standings ls
    where ls.team_id = dt.team_id
      and (p_season is null or ls.season = p_season)
    limit 1
  ) standings_check on true
  where
    lower(dt.team_name_std) = lower(p_team_a)
    or dt.team_name_std ilike '%' || p_team_a || '%'
    or lower(p_team_a) = lower(regexp_replace(dt.team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
    or lower(regexp_replace(p_team_a, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(dt.team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
    -- Handle RB Leipzig / RasenBallsport Leipzig: if both contain "leipzig" and one has "rb"/"rasenballsport", treat as same team
    or (
      lower(dt.team_name_std) like '%leipzig%' 
      and lower(p_team_a) like '%leipzig%'
      and (
        (lower(dt.team_name_std) like '%rb%' and lower(p_team_a) like '%rb%')
        or (lower(dt.team_name_std) like '%rasenballsport%' and lower(p_team_a) like '%rasenballsport%')
        or (lower(dt.team_name_std) like '%rb%' and lower(p_team_a) like '%rasenballsport%')
        or (lower(dt.team_name_std) like '%rasenballsport%' and lower(p_team_a) like '%rb%')
      )
    )
  order by
    case when matches_check.has_matches = 1 then 0 else 1 end, -- PRIORITIZE teams with matches first (most important)
    case when standings_check.has_standings = 1 then 0 else 1 end, -- Then prioritize teams with standings data
    case
      when lower(dt.team_name_std) = lower(p_team_a) then 0
      when lower(regexp_replace(dt.team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(p_team_a, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) then 1
      else 2
    end,
    length(dt.team_name_std) asc
  limit 1
),
tb as (
  select 
    dt.team_id, 
    dt.team_name_std, 
    dt.league
  from public.dim_team dt
  left join lateral (
    select 1 as has_standings
    from public.league_standings ls
    where ls.team_id = dt.team_id
      and (p_season is null or ls.season = p_season)
    limit 1
  ) standings_check on true
  left join lateral (
    select 1 as has_matches
    from public.matches m
    where (m.home_team_id = dt.team_id or m.away_team_id = dt.team_id)
      and (p_season is null or m.season = p_season)
      and (p_game_date is null or m.date_utc::date >= p_game_date)
    limit 1
  ) matches_check on true
  where
    lower(dt.team_name_std) = lower(p_team_b)
    or dt.team_name_std ilike '%' || p_team_b || '%'
    or lower(p_team_b) = lower(regexp_replace(dt.team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
    or lower(regexp_replace(p_team_b, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(dt.team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g'))
    -- Handle RB Leipzig / RasenBallsport Leipzig: if both contain "leipzig" and one has "rb"/"rasenballsport", treat as same team
    or (
      lower(dt.team_name_std) like '%leipzig%' 
      and lower(p_team_b) like '%leipzig%'
      and (
        (lower(dt.team_name_std) like '%rb%' and lower(p_team_b) like '%rb%')
        or (lower(dt.team_name_std) like '%rasenballsport%' and lower(p_team_b) like '%rasenballsport%')
        or (lower(dt.team_name_std) like '%rb%' and lower(p_team_b) like '%rasenballsport%')
        or (lower(dt.team_name_std) like '%rasenballsport%' and lower(p_team_b) like '%rb%')
      )
    )
  order by
    case when matches_check.has_matches = 1 then 0 else 1 end, -- PRIORITIZE teams with matches first (most important)
    case when standings_check.has_standings = 1 then 0 else 1 end, -- Then prioritize teams with standings data
    case
      when lower(dt.team_name_std) = lower(p_team_b) then 0
      when lower(regexp_replace(dt.team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) = lower(regexp_replace(p_team_b, '\s+(FC|CF|United|City|Town|Athletic|Club)$', '', 'g')) then 1
      else 2
    end,
    length(dt.team_name_std) asc
  limit 1
),

-- 2) Choose the match:
-- If p_game_date provided, prefer that day; if no match, fall back to next upcoming.
-- Also check for alternate team names (e.g., "Girona" vs "Girona FC", "Werder Bremen" vs "SV Werder Bremen")
-- Find all team variations that match the input names
ta_alternates as (
  select team_id, team_name_std, league
  from public.dim_team
  where (
    team_name_std ilike '%' || (select team_name_std from ta) || '%'
    or (select team_name_std from ta) ilike '%' || team_name_std || '%'
    or lower(regexp_replace(team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club|SV|TSG)$', '', 'g')) = 
       lower(regexp_replace((select team_name_std from ta), '\s+(FC|CF|United|City|Town|Athletic|Club|SV|TSG)$', '', 'g'))
    or lower(regexp_replace(team_name_std, '^(SV|TSG)\s+', '', 'g')) = 
       lower(regexp_replace((select team_name_std from ta), '^(SV|TSG)\s+', '', 'g'))
    or lower(p_team_a) = lower(regexp_replace(team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club|SV|TSG)$', '', 'g'))
    or lower(p_team_a) = lower(regexp_replace(team_name_std, '^(SV|TSG)\s+', '', 'g'))
    -- Handle RB Leipzig / RasenBallsport Leipzig: include both Leipzig teams when one is found
    or (
      lower(team_name_std) like '%leipzig%' 
      and (select team_name_std from ta) is not null
      and lower((select team_name_std from ta)) like '%leipzig%'
      and (
        (lower(team_name_std) like '%rb%' or lower(team_name_std) like '%rasenballsport%')
        and (lower((select team_name_std from ta)) like '%rb%' or lower((select team_name_std from ta)) like '%rasenballsport%')
      )
    )
  )
),
tb_alternates as (
  select team_id, team_name_std, league
  from public.dim_team
  where (
    team_name_std ilike '%' || (select team_name_std from tb) || '%'
    or (select team_name_std from tb) ilike '%' || team_name_std || '%'
    or lower(regexp_replace(team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club|SV|TSG)$', '', 'g')) = 
       lower(regexp_replace((select team_name_std from tb), '\s+(FC|CF|United|City|Town|Athletic|Club|SV|TSG)$', '', 'g'))
    or lower(regexp_replace(team_name_std, '^(SV|TSG)\s+', '', 'g')) = 
       lower(regexp_replace((select team_name_std from tb), '^(SV|TSG)\s+', '', 'g'))
    or lower(p_team_b) = lower(regexp_replace(team_name_std, '\s+(FC|CF|United|City|Town|Athletic|Club|SV|TSG)$', '', 'g'))
    or lower(p_team_b) = lower(regexp_replace(team_name_std, '^(SV|TSG)\s+', '', 'g'))
    -- Handle RB Leipzig / RasenBallsport Leipzig: include both Leipzig teams when one is found
    or (
      lower(team_name_std) like '%leipzig%' 
      and (select team_name_std from tb) is not null
      and lower((select team_name_std from tb)) like '%leipzig%'
      and (
        (lower(team_name_std) like '%rb%' or lower(team_name_std) like '%rasenballsport%')
        and (lower((select team_name_std from tb)) like '%rb%' or lower((select team_name_std from tb)) like '%rasenballsport%')
      )
    )
  )
),
m_exact as (
  select
    m.match_id,
    m.season,
    m.date_utc,
    m.date_utc::date as game_date,
    m.home_team_id,
    m.away_team_id,
    m.venue,
    m.league,
    m.status,
    m.home_score,
    m.away_score
  from public.matches m
  join ta on true
  join tb on true
  where (
    (m.home_team_id = ta.team_id and m.away_team_id = tb.team_id)
    or (m.home_team_id = tb.team_id and m.away_team_id = ta.team_id)
    or (m.home_team_id in (select team_id from ta_alternates) and m.away_team_id in (select team_id from tb_alternates))
    or (m.home_team_id in (select team_id from tb_alternates) and m.away_team_id in (select team_id from ta_alternates))
  )
  and (p_season is null or m.season = p_season)
  and p_game_date is not null
  and m.date_utc::date = p_game_date
  order by m.date_utc asc
  limit 1
),
m_next as (
  select
    m.match_id,
    m.season,
    m.date_utc,
    m.date_utc::date as game_date,
    m.home_team_id,
    m.away_team_id,
    m.venue,
    m.league,
    m.status,
    m.home_score,
    m.away_score
  from public.matches m
  join ta on true
  join tb on true
  where (
    (m.home_team_id = ta.team_id and m.away_team_id = tb.team_id)
    or (m.home_team_id = tb.team_id and m.away_team_id = ta.team_id)
    or (m.home_team_id in (select team_id from ta_alternates) and m.away_team_id in (select team_id from tb_alternates))
    or (m.home_team_id in (select team_id from tb_alternates) and m.away_team_id in (select team_id from ta_alternates))
  )
  and (p_season is null or m.season = p_season)
  and m.date_utc >= now() - interval '6 hours'
  order by m.date_utc asc
  limit 1
),
m as (
  select * from m_exact
  union all
  select * from m_next
  limit 1
),

ctx as (
  select
    (select team_id from ta) as team_a_id,
    (select team_id from tb) as team_b_id,
    (select team_name_std from ta) as team_a_name,
    (select team_name_std from tb) as team_b_name,
    (select league from ta) as team_a_league,
    (select league from tb) as team_b_league,
    (select match_id from m) as match_id,
    (select season from m) as season,
    (select game_date from m) as game_date,
    (select date_utc from m) as date_utc,
    (select home_team_id from m) as home_team_id,
    (select away_team_id from m) as away_team_id,
    (select venue from m) as venue_name,
    (select league from m) as match_league
),

-- 3) Team form: Calculate from team_match_stats (form_rollups tables are empty)
-- Calculate W-D-L and xG diff from team_match_stats for last 10 and last 3 matches
team_match_history as (
  select
    tms.team_id,
    tms.match_id,
    m.date_utc::date as match_date,
    tms.goals_for,
    tms.goals_against,
    tms.xg_for,
    tms.xg_against,
    (tms.xg_for - tms.xg_against)::numeric as xg_diff,
    case when tms.goals_for > tms.goals_against then 'W'
         when tms.goals_for < tms.goals_against then 'L'
         else 'D' end as result,
    -- Map team_id to the matched team (A or B) for aggregation
    case 
      when tms.team_id = (select team_id from ta) then (select team_id from ta)
      when tms.team_id in (select team_id from ta_alternates) then (select team_id from ta)
      when tms.team_id = (select team_id from tb) then (select team_id from tb)
      when tms.team_id in (select team_id from tb_alternates) then (select team_id from tb)
      else tms.team_id
    end as matched_team_id,
    row_number() over (
      partition by case 
        when tms.team_id = (select team_id from ta) then (select team_id from ta)
        when tms.team_id in (select team_id from ta_alternates) then (select team_id from ta)
        when tms.team_id = (select team_id from tb) then (select team_id from tb)
        when tms.team_id in (select team_id from tb_alternates) then (select team_id from tb)
        else tms.team_id
      end 
      order by m.date_utc desc
    ) as rn
  from public.team_match_stats tms
  join public.matches m on m.match_id = tms.match_id
  join ctx c on (
    tms.team_id in (c.team_a_id, c.team_b_id)
    or tms.team_id in (select team_id from ta_alternates)
    or tms.team_id in (select team_id from tb_alternates)
  )
  where (c.season is null or m.season = c.season)
    and (c.game_date is null or m.date_utc::date < c.game_date)
    and (c.date_utc is null or m.date_utc < c.date_utc)
  order by m.date_utc desc
),
team_form_agg as (
  select
    matched_team_id as team_id,
    -- last 10
    sum(case when rn <= 10 and result = 'W' then 1 else 0 end) as w10,
    sum(case when rn <= 10 and result = 'D' then 1 else 0 end) as d10,
    sum(case when rn <= 10 and result = 'L' then 1 else 0 end) as l10,
    avg(case when rn <= 10 then xg_diff end)::numeric(10,2) as xg_diff10,
    sum(case when rn <= 10 and (abs(xg_diff) <= p_close_xg_diff or abs(goals_for - goals_against) <= 1) and result = 'W' then 1 else 0 end) as close_w10,
    sum(case when rn <= 10 and (abs(xg_diff) <= p_close_xg_diff or abs(goals_for - goals_against) <= 1) and result = 'L' then 1 else 0 end) as close_l10,
    -- last 3
    sum(case when rn <= 3 and result = 'W' then 1 else 0 end) as w3,
    sum(case when rn <= 3 and result = 'D' then 1 else 0 end) as d3,
    sum(case when rn <= 3 and result = 'L' then 1 else 0 end) as l3,
    avg(case when rn <= 3 then xg_diff end)::numeric(10,2) as xg_diff3,
    -- last 5 (for xgDiff5 comparison)
    avg(case when rn <= 5 then xg_diff end)::numeric(10,2) as xg_diff5
  from team_match_history
  group by matched_team_id
),

-- 4) Standings snapshot: from league_standings table
-- Get the most recent standings for each team before or on the match date, filtered by season and league
a_standings_raw as (
  select distinct on (ls.team_id)
    ls.team_id,
    ls.position,
    ls.points,
    ls.matches_played,
    ls.wins,
    ls.draws,
    ls.losses,
    ls.goals_for,
    ls.goals_against,
    ls.goal_difference,
    ls.snapshot_date,
    ls.pulled_at
  from public.league_standings ls
  join ctx c on ls.team_id = c.team_a_id
  where (c.season is null or ls.season = c.season)
    and (c.match_league is null or ls.league = c.match_league)
    and ls.snapshot_date <= coalesce(c.game_date, c.date_utc::date, current_date)
  order by ls.team_id, ls.snapshot_date desc, ls.pulled_at desc
),
b_standings_raw as (
  select distinct on (ls.team_id)
    ls.team_id,
    ls.position,
    ls.points,
    ls.matches_played,
    ls.wins,
    ls.draws,
    ls.losses,
    ls.goals_for,
    ls.goals_against,
    ls.goal_difference,
    ls.snapshot_date,
    ls.pulled_at
  from public.league_standings ls
  join ctx c on ls.team_id = c.team_b_id
  where (c.season is null or ls.season = c.season)
    and (c.match_league is null or ls.league = c.match_league)
    and ls.snapshot_date <= coalesce(c.game_date, c.date_utc::date, current_date)
  order by ls.team_id, ls.snapshot_date desc, ls.pulled_at desc
),

-- 5) Availability: from match_missing_players
availability_base as (
  select
    mmp.team_id,
    mmp.player_id,
    coalesce(p.player_name_std, mmp.player_name_raw) as player_name,
    mmp.status,
    mmp.reason
  from public.match_missing_players mmp
  left join public.dim_player p on p.player_id = mmp.player_id
  join ctx c on mmp.team_id in (c.team_a_id, c.team_b_id)
  where mmp.match_id = (select match_id from ctx)
    and mmp.status in ('injured', 'suspended', 'doubtful', 'out')
),
availability_major_absences_wrapped as (
  select
    team_id,
    jsonb_build_object(
      'count', count(*),
      'players', jsonb_agg(
        jsonb_build_object(
          'name', player_name,
          'status', coalesce(status, 'unknown'),
          'reason', coalesce(reason, '')
        )
        order by player_name
      )
    ) as obj
  from availability_base
  group by team_id
),
availability_by_team as (
  select
    ab.team_id,
    (select team_name_std from public.dim_team t where t.team_id = ab.team_id) as team_name,
    string_agg(ab.player_name || 
      case when ab.status = 'injured' then ' [injured]'
           when ab.status = 'suspended' then ' [suspended]'
           when ab.status = 'doubtful' then ' [doubtful]'
           else '' end, ', ' order by ab.player_name) as players_list
  from availability_base ab
  group by ab.team_id
),
availability_bullet as (
  select
    string_agg(
      team_name || ' missing ' || players_list,
      ' | '
      order by team_id
    ) as value_text
  from availability_by_team
),

-- 6) Player form leaders: from player_match_stats (last 5 matches)
player_match_history as (
  select
    pms.player_id,
    pms.team_id,
    pms.match_id,
    m.date_utc::date as match_date,
    pms.minutes,
    pms.xg,
    row_number() over (partition by pms.player_id, pms.team_id order by m.date_utc desc) as rn
  from public.player_match_stats pms
  join public.matches m on m.match_id = pms.match_id
  join ctx c on pms.team_id in (c.team_a_id, c.team_b_id)
  where (c.season is null or m.season = c.season)
    and (c.game_date is null or m.date_utc::date < c.game_date)
    and m.date_utc < (select date_utc from ctx)
    and pms.minutes > 0
),
player_form_agg as (
  select
    player_id,
    team_id,
    sum(case when rn <= 5 then minutes else 0 end) as min5,
    sum(case when rn <= 5 then xg else 0 end)::numeric(10,2) as xg5
  from player_match_history
  where rn <= 5
  group by player_id, team_id
),
player_season_agg as (
  select
    pms.player_id,
    pms.team_id,
    avg(pms.minutes)::numeric(10,1) as min_season,
    avg(pms.xg)::numeric(10,2) as xg_season
  from public.player_match_stats pms
  join public.matches m on m.match_id = pms.match_id
  join ctx c on pms.team_id in (c.team_a_id, c.team_b_id)
  where (c.season is null or m.season = c.season)
    and (c.game_date is null or m.date_utc::date < c.game_date)
    and m.date_utc < (select date_utc from ctx)
    and pms.minutes > 0
  group by pms.player_id, pms.team_id
),
form_leaders_combined as (
  select
    pfa.player_id,
    pfa.team_id,
    (select team_name_std from public.dim_team t where t.team_id = pfa.team_id) as team_name,
    p.player_name_std as player_name,
    coalesce(pfa.min5, 0) as min5,
    coalesce(pfa.xg5, 0)::numeric(10,2) as xg5,
    coalesce(psa.min_season, 0)::numeric(10,1) as min_season,
    coalesce(psa.xg_season, 0)::numeric(10,2) as xg_season,
    (coalesce(pfa.xg5, 0) - coalesce(psa.xg_season, 0) * 5)::numeric(10,2) as delta_xg5_vs_season
  from player_form_agg pfa
  join public.dim_player p on p.player_id = pfa.player_id
  left join player_season_agg psa on psa.player_id = pfa.player_id and psa.team_id = pfa.team_id
  where coalesce(pfa.min5, 0) >= 200  -- At least 200 minutes in last 5 matches
),
form_leaders_ranked as (
  select
    *,
    row_number() over (
      partition by team_id
      order by (min5 + xg5 * 10) desc nulls last  -- Weighted: minutes + xG importance
    ) as rn,
    case when row_number() over (partition by team_id order by (min5 + xg5 * 10) desc) <= 2 then true else false end as display_priority
  from form_leaders_combined
),
form_leaders_json_all as (
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'playerName', player_name,
        'teamName', team_name,
        'MIN5', min5,
        'xG5', xg5,
        'MINSeason', min_season,
        'xGSeason', xg_season,
        'deltaXG5vsSeason', delta_xg5_vs_season,
        'displayPriority', display_priority
      )
      order by team_id, rn
    ) filter (where rn <= p_form_leaders * 2), '[]'::jsonb) as items
  from form_leaders_ranked
),
form_leaders_priority_json as (
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'playerName', player_name,
        'teamName', team_name,
        'MIN5', min5,
        'xG5', xg5
      )
      order by team_id, rn
    ) filter (where display_priority = true), '[]'::jsonb) as items
  from form_leaders_ranked
),
form_leaders_display_text as (
  select
    coalesce(jsonb_agg(
      player_name || ' (' || team_name || ') — ' ||
      min5::text || ' min, ' || xg5::text || ' xG'
      order by team_id, rn
    ) filter (where display_priority = true), '[]'::jsonb) as items
  from form_leaders_ranked
),

-- 7) Revenge Watch: players facing former clubs (optional - leave empty if none)
-- Note: This would require a player_team_history table which may not exist
-- For now, we'll leave this empty or check if such a table exists
revenge_hits as (
  select null::text as player_name
  where false  -- Placeholder - implement if player_team_history table exists
),

-- 8) Opponent history: player xG/goals vs opponent (optional)
opp_hist as (
  select null::text as player_name
  where false  -- Placeholder - implement if player_opponent_history table exists
),

-- 9) Compose FactDrop bullets + comparisons + sections
a_form as (
  select * from team_form_agg where team_id = (select team_a_id from ctx)
),
b_form as (
  select * from team_form_agg where team_id = (select team_b_id from ctx)
),
a_stand as (
  select 
    coalesce((select position from a_standings_raw), 0) as position,
    coalesce((select points from a_standings_raw), 0) as points,
    coalesce((select matches_played from a_standings_raw), 0) as matches_played,
    coalesce((select wins from a_standings_raw), 0) as wins,
    coalesce((select draws from a_standings_raw), 0) as draws,
    coalesce((select losses from a_standings_raw), 0) as losses
),
b_stand as (
  select 
    coalesce((select position from b_standings_raw), 0) as position,
    coalesce((select points from b_standings_raw), 0) as points,
    coalesce((select matches_played from b_standings_raw), 0) as matches_played,
    coalesce((select wins from b_standings_raw), 0) as wins,
    coalesce((select draws from b_standings_raw), 0) as draws,
    coalesce((select losses from b_standings_raw), 0) as losses
),

-- 10a) Chart datasets
-- Momentum Line: last 10 xG diff values from team_match_history
momentum_ranked as (
  select
    tmh.team_id,
    tmh.rn,
    tmh.match_date,
    round(coalesce(tmh.xg_diff,0), 2) as xg_diff
  from team_match_history tmh
  where tmh.rn <= 10
),
momentum_series as (
  select
    jsonb_build_object(
      'window', 10,
      'series', jsonb_build_object(
        'A', jsonb_build_object(
          'label', (select substring(team_a_name, 1, 3) from ctx),
          'dates', coalesce((
            select jsonb_agg(to_char(m.match_date, 'YYYY-MM-DD') order by m.rn desc)
            from momentum_ranked m
            where m.team_id = (select team_a_id from ctx)
          ), '[]'::jsonb),
          'xgDiff', coalesce((
            select jsonb_agg(m.xg_diff order by m.rn desc)
            from momentum_ranked m
            where m.team_id = (select team_a_id from ctx)
          ), '[]'::jsonb)
        ),
        'B', jsonb_build_object(
          'label', (select substring(team_b_name, 1, 3) from ctx),
          'dates', coalesce((
            select jsonb_agg(to_char(m.match_date, 'YYYY-MM-DD') order by m.rn desc)
            from momentum_ranked m
            where m.team_id = (select team_b_id from ctx)
          ), '[]'::jsonb),
          'xgDiff', coalesce((
            select jsonb_agg(m.xg_diff order by m.rn desc)
            from momentum_ranked m
            where m.team_id = (select team_b_id from ctx)
          ), '[]'::jsonb)
        )
      )
    ) as obj
),

-- Star Load: top XI minutes concentration
star_load as (
  select jsonb_build_object('players', (select items from form_leaders_priority_json)) as obj
),

-- Pressure Bar: close-game record in last 10
pressure_bar as (
  select
    jsonb_build_object(
      'closeXgDiff', p_close_xg_diff,
      'A', jsonb_build_object(
        'label', (select substring(team_a_name, 1, 3) from ctx),
        'wins', coalesce((select close_w10 from a_form),0),
        'losses', coalesce((select close_l10 from a_form),0)
      ),
      'B', jsonb_build_object(
        'label', (select substring(team_b_name, 1, 3) from ctx),
        'wins', coalesce((select close_w10 from b_form),0),
        'losses', coalesce((select close_l10 from b_form),0)
      )
    ) as obj
),

-- Role Volatility: players with biggest xG change
volatility_json as (
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'teamName', team_name,
        'playerName', player_name,
        'xGChange', delta_xg5_vs_season,
        'MIN5', min5
      )
      order by team_id, abs(delta_xg5_vs_season) desc nulls last
    ) filter (where abs(delta_xg5_vs_season) > 0.2 and min5 >= 200), '[]'::jsonb) as items
  from form_leaders_ranked
  where rn <= 6
),
role_volatility as (
  select jsonb_build_object('players', (select items from volatility_json)) as obj
),

sections_raw as (
  select
    jsonb_build_object(
      'title','AVAILABILITY_SHOCK',
      'items', coalesce((
        select jsonb_agg(
          ab.player_name || ' (' ||
          (select team_name_std from public.dim_team t where t.team_id = ab.team_id) ||
          ') — ' || coalesce(ab.status, 'unknown') ||
          case when ab.reason <> '' then ' — ' || ab.reason else '' end
        )
        from availability_base ab
        limit 10
      ), '[]'::jsonb)
    ) as section_obj

  union all

  select
    jsonb_build_object(
      'title','FORM_LEADERS',
      'items', (select items from form_leaders_display_text),
      'itemsDetailed', (select items from form_leaders_json_all)
    )
),
sections_filtered as (
  select section_obj
  from sections_raw
  where jsonb_typeof(section_obj->'items') = 'array'
    and jsonb_array_length(section_obj->'items') > 0
)

select
  case
    when (select team_a_id from ctx) is null or (select team_b_id from ctx) is null then
      jsonb_build_object(
        'error', 'TEAM_NOT_FOUND',
        'message', 'Could not resolve one or both team identifiers',
        'input', jsonb_build_object('teamA', p_team_a, 'teamB', p_team_b)
      )
    when (select match_id from ctx) is null then
      jsonb_build_object(
        'error', 'GAME_NOT_FOUND',
        'message', 'Could not find a matching game (by date or upcoming)',
        'input', jsonb_build_object('teamA', p_team_a, 'teamB', p_team_b, 'gameDate', p_game_date, 'season', p_season)
      )
    else
      jsonb_build_object(
        'version', 'v3',
        'source', 'soccer_stats_db',
        'generatedAtUtc', now(),
        'matchup', jsonb_build_object(
          'gameId', (select match_id from ctx),
          'season', (select season from ctx),
          'gameDate', (select game_date from ctx),
          'gameDateUtc', to_char(((select date_utc from ctx) at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'teamA', (select team_a_name from ctx),
          'teamB', (select team_b_name from ctx),
          'teamAAbbr', (select substring(team_a_name, 1, 3) from ctx),
          'teamBAbbr', (select substring(team_b_name, 1, 3) from ctx),
          'homeTeamId', (select home_team_id from ctx),
          'awayTeamId', (select away_team_id from ctx),
          'homeAway', jsonb_build_object(
            'A', case
              when (select team_a_id from ctx) = (select home_team_id from ctx) then 'home'
              when (select team_a_id from ctx) = (select away_team_id from ctx) then 'away'
              else null
            end,
            'B', case
              when (select team_b_id from ctx) = (select home_team_id from ctx) then 'home'
              when (select team_b_id from ctx) = (select away_team_id from ctx) then 'away'
              else null
            end
          ),
          'venue', jsonb_build_object(
            'name', (select venue_name from ctx),
            'league', (select match_league from ctx)
          )
        ),
        'factDrop', jsonb_build_object(
          'meta', jsonb_build_object(
            'closeXgDiff', p_close_xg_diff,
            'formWindow10', 10,
            'formWindow3', 3,
            'formLeaders', p_form_leaders
          ),
          'raw', jsonb_build_object(
            'teamForm', jsonb_build_object(
              'A', jsonb_build_object(
                'w10', coalesce((select w10 from a_form),0),
                'd10', coalesce((select d10 from a_form),0),
                'l10', coalesce((select l10 from a_form),0),
                'xgDiff10', round(coalesce((select xg_diff10 from a_form),0),2),
                'w3', coalesce((select w3 from a_form),0),
                'd3', coalesce((select d3 from a_form),0),
                'l3', coalesce((select l3 from a_form),0),
                'xgDiff3', round(coalesce((select xg_diff3 from a_form),0),2),
                'closeW10', coalesce((select close_w10 from a_form),0),
                'closeL10', coalesce((select close_l10 from a_form),0)
              ),
              'B', jsonb_build_object(
                'w10', coalesce((select w10 from b_form),0),
                'd10', coalesce((select d10 from b_form),0),
                'l10', coalesce((select l10 from b_form),0),
                'xgDiff10', round(coalesce((select xg_diff10 from b_form),0),2),
                'w3', coalesce((select w3 from b_form),0),
                'd3', coalesce((select d3 from b_form),0),
                'l3', coalesce((select l3 from b_form),0),
                'xgDiff3', round(coalesce((select xg_diff3 from b_form),0),2),
                'closeW10', coalesce((select close_w10 from b_form),0),
                'closeL10', coalesce((select close_l10 from b_form),0)
              )
            ),
            'standings', jsonb_build_object(
              'A', jsonb_build_object(
                'position', coalesce((select position from a_stand),0),
                'points', coalesce((select points from a_stand),0)
              ),
              'B', jsonb_build_object(
                'position', coalesce((select position from b_stand),0),
                'points', coalesce((select points from b_stand),0)
              )
            ),
            'availability', jsonb_build_object(
              'majorAbsences', jsonb_build_object(
                'A', coalesce((select obj from availability_major_absences_wrapped where team_id = (select team_a_id from ctx) limit 1), jsonb_build_object('count', 0, 'players', '[]'::jsonb)),
                'B', coalesce((select obj from availability_major_absences_wrapped where team_id = (select team_b_id from ctx) limit 1), jsonb_build_object('count', 0, 'players', '[]'::jsonb))
              )
            )
          ),
          'bullets', jsonb_build_array(
            jsonb_build_object(
              'key', 'last10',
              'label', 'LAST 10',
              'display',
                (select substring(team_a_name, 1, 3) from ctx) || ' ' ||
                coalesce((select w10 from a_form),0)::text || '-' ||
                coalesce((select d10 from a_form),0)::text || '-' ||
                coalesce((select l10 from a_form),0)::text ||
                ' (' ||
                  (case when round(coalesce((select xg_diff10 from a_form),0),2) > 0 then '+' else '' end) ||
                  round(coalesce((select xg_diff10 from a_form),0),2)::text || ' xG' ||
                ') | ' ||
                (select substring(team_b_name, 1, 3) from ctx) || ' ' ||
                coalesce((select w10 from b_form),0)::text || '-' ||
                coalesce((select d10 from b_form),0)::text || '-' ||
                coalesce((select l10 from b_form),0)::text ||
                ' (' ||
                  (case when round(coalesce((select xg_diff10 from b_form),0),2) > 0 then '+' else '' end) ||
                  round(coalesce((select xg_diff10 from b_form),0),2)::text || ' xG' ||
                ')',
              'raw', jsonb_build_object(
                'A', (select (jsonb_build_object(
                  'w10', coalesce(w10,0),
                  'd10', coalesce(d10,0),
                  'l10', coalesce(l10,0),
                  'xgDiff10', round(coalesce(xg_diff10,0),2)
                )) from a_form),
                'B', (select (jsonb_build_object(
                  'w10', coalesce(w10,0),
                  'd10', coalesce(d10,0),
                  'l10', coalesce(l10,0),
                  'xgDiff10', round(coalesce(xg_diff10,0),2)
                )) from b_form)
              )
            ),
            jsonb_build_object(
              'key', 'last3',
              'label', 'LAST 3',
              'display',
                (select substring(team_a_name, 1, 3) from ctx) || ' ' ||
                coalesce((select w3 from a_form),0)::text || '-' ||
                coalesce((select d3 from a_form),0)::text || '-' ||
                coalesce((select l3 from a_form),0)::text ||
                ' (' ||
                  (case when round(coalesce((select xg_diff3 from a_form),0),2) > 0 then '+' else '' end) ||
                  round(coalesce((select xg_diff3 from a_form),0),2)::text || ' xG' ||
                ') | ' ||
                (select substring(team_b_name, 1, 3) from ctx) || ' ' ||
                coalesce((select w3 from b_form),0)::text || '-' ||
                coalesce((select d3 from b_form),0)::text || '-' ||
                coalesce((select l3 from b_form),0)::text ||
                ' (' ||
                  (case when round(coalesce((select xg_diff3 from b_form),0),2) > 0 then '+' else '' end) ||
                  round(coalesce((select xg_diff3 from b_form),0),2)::text || ' xG' ||
                ')',
              'raw', jsonb_build_object(
                'A', (select (jsonb_build_object(
                  'w3', coalesce(w3,0),
                  'd3', coalesce(d3,0),
                  'l3', coalesce(l3,0),
                  'xgDiff3', round(coalesce(xg_diff3,0),2)
                )) from a_form),
                'B', (select (jsonb_build_object(
                  'w3', coalesce(w3,0),
                  'd3', coalesce(d3,0),
                  'l3', coalesce(l3,0),
                  'xgDiff3', round(coalesce(xg_diff3,0),2)
                )) from b_form)
              )
            ),
            jsonb_build_object(
              'key', 'momentum',
              'label', 'MOMENTUM',
              'display',
                (select substring(team_a_name, 1, 3) from ctx) || ' ' ||
                (case 
                  when round(coalesce((select xg_diff3 from a_form),0),2) > round(coalesce((select xg_diff10 from a_form),0),2) then 'trending up'
                  when round(coalesce((select xg_diff3 from a_form),0),2) < round(coalesce((select xg_diff10 from a_form),0),2) then 'slipping'
                  else 'stable'
                end) ||
                ' | ' ||
                (select substring(team_b_name, 1, 3) from ctx) || ' ' ||
                (case 
                  when round(coalesce((select xg_diff3 from b_form),0),2) > round(coalesce((select xg_diff10 from b_form),0),2) then 'trending up'
                  when round(coalesce((select xg_diff3 from b_form),0),2) < round(coalesce((select xg_diff10 from b_form),0),2) then 'slipping'
                  else 'stable'
                end),
              'raw', jsonb_build_object(
                'A', round(coalesce((select xg_diff3 from a_form),0),2),
                'B', round(coalesce((select xg_diff3 from b_form),0),2)
              )
            ),
            jsonb_build_object(
              'key', 'availability',
              'label', 'AVAILABILITY',
              'display', coalesce((select value_text from availability_bullet), 'No major absences'),
              'raw', jsonb_build_object(
                'A', coalesce((select obj from availability_major_absences_wrapped where team_id = (select team_a_id from ctx) limit 1), jsonb_build_object('count', 0, 'players', '[]'::jsonb)),
                'B', coalesce((select obj from availability_major_absences_wrapped where team_id = (select team_b_id from ctx) limit 1), jsonb_build_object('count', 0, 'players', '[]'::jsonb))
              )
            ),
            jsonb_build_object(
              'key', 'closeGames',
              'label', 'CLOSE GAMES (≤ ' || p_close_xg_diff::text || ' xG or 1 goal)',
              'display',
                (select substring(team_a_name, 1, 3) from ctx) || ' ' ||
                coalesce((select close_w10 from a_form),0)::text || '-' || coalesce((select close_l10 from a_form),0)::text ||
                ' | ' ||
                (select substring(team_b_name, 1, 3) from ctx) || ' ' ||
                coalesce((select close_w10 from b_form),0)::text || '-' || coalesce((select close_l10 from b_form),0)::text,
              'raw', jsonb_build_object(
                'A', jsonb_build_object('closeW10', coalesce((select close_w10 from a_form),0), 'closeL10', coalesce((select close_l10 from a_form),0)),
                'B', jsonb_build_object('closeW10', coalesce((select close_w10 from b_form),0), 'closeL10', coalesce((select close_l10 from b_form),0))
              )
            ),
            jsonb_build_object(
              'key', 'standings',
              'label', 'STANDINGS',
              'display',
                coalesce((select team_a_name from ctx), 'Team A') || ' ' ||
                coalesce((select position from a_stand),0)::text || 'th (' ||
                coalesce((select points from a_stand),0)::text || ' pts)' ||
                ' | ' ||
                coalesce((select team_b_name from ctx), 'Team B') || ' ' ||
                coalesce((select position from b_stand),0)::text || 'th (' ||
                coalesce((select points from b_stand),0)::text || ' pts)',
              'raw', jsonb_build_object(
                'A', jsonb_build_object(
                  'position', coalesce((select position from a_stand),0),
                  'points', coalesce((select points from a_stand),0),
                  'matches_played', coalesce((select matches_played from a_stand),0),
                  'wins', coalesce((select wins from a_stand),0),
                  'draws', coalesce((select draws from a_stand),0),
                  'losses', coalesce((select losses from a_stand),0)
                ),
                'B', jsonb_build_object(
                  'position', coalesce((select position from b_stand),0),
                  'points', coalesce((select points from b_stand),0),
                  'matches_played', coalesce((select matches_played from b_stand),0),
                  'wins', coalesce((select wins from b_stand),0),
                  'draws', coalesce((select draws from b_stand),0),
                  'losses', coalesce((select losses from b_stand),0)
                )
              )
            )
          ),
          'comparisons', jsonb_build_array(
            jsonb_build_object(
              'key', 'xgDiff10',
              'metric', 'AVG xG DIFF (L10)',
              'A', round(coalesce((select xg_diff10 from a_form),0),2),
              'B', round(coalesce((select xg_diff10 from b_form),0),2),
              'winner',
                case
                  when coalesce((select xg_diff10 from a_form),0) > coalesce((select xg_diff10 from b_form),0) then 'A'
                  when coalesce((select xg_diff10 from a_form),0) < coalesce((select xg_diff10 from b_form),0) then 'B'
                  else 'even'
                end,
              'display', jsonb_build_object(
                'A', (case when round(coalesce((select xg_diff10 from a_form),0),2) > 0 then '+' else '' end) || round(coalesce((select xg_diff10 from a_form),0),2)::text || ' xG',
                'B', (case when round(coalesce((select xg_diff10 from b_form),0),2) > 0 then '+' else '' end) || round(coalesce((select xg_diff10 from b_form),0),2)::text || ' xG'
              )
            ),
            jsonb_build_object(
              'key', 'xgDiff5',
              'metric', 'AVG xG DIFF (L5)',
              'A', round(coalesce((select xg_diff5 from a_form),0),2),
              'B', round(coalesce((select xg_diff5 from b_form),0),2),
              'winner',
                case
                  when coalesce((select xg_diff5 from a_form),0) > coalesce((select xg_diff5 from b_form),0) then 'A'
                  when coalesce((select xg_diff5 from a_form),0) < coalesce((select xg_diff5 from b_form),0) then 'B'
                  else 'even'
                end,
              'display', jsonb_build_object(
                'A', (case when round(coalesce((select xg_diff5 from a_form),0),2) > 0 then '+' else '' end) || round(coalesce((select xg_diff5 from a_form),0),2)::text || ' xG',
                'B', (case when round(coalesce((select xg_diff5 from b_form),0),2) > 0 then '+' else '' end) || round(coalesce((select xg_diff5 from b_form),0),2)::text || ' xG'
              )
            )
          ),
          'charts', jsonb_build_object(
            'momentumLine', (select obj from momentum_series),
            'starLoad', (select obj from star_load),
            'pressureBar', (select obj from pressure_bar),
            'roleVolatility', (select obj from role_volatility)
          ),
          'sections', jsonb_build_array(
            jsonb_build_object(
              'key', 'formLeaders',
              'title', 'FORM_LEADERS',
              'itemsDetailed', (select items from form_leaders_json_all),
              'items', (select items from form_leaders_display_text),
              'priorityPlayers', (select items from form_leaders_priority_json)
            ),
            jsonb_build_object(
              'key', 'availabilityShock',
              'title', 'AVAILABILITY_SHOCK',
              'items', coalesce((select (section_obj->'items') from sections_filtered where section_obj->>'title' = 'AVAILABILITY_SHOCK' limit 1), '[]'::jsonb)
            )
          )
        )
      )
  end;
$$;
