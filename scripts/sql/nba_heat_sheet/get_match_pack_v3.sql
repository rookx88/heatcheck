-- HeatChecks: MatchPack V3 (nba_heat_sheet)
-- Install:
--   psql "$NBA_HEAT_SHEET_DATABASE_URL" -f scripts/sql/nba_heat_sheet/get_match_pack_v3.sql

create or replace function public.get_match_pack_v3(
  p_team_a text,
  p_team_b text,
  p_game_date_est date default null,
  p_season varchar default null,
  p_close_margin int default 6,
  p_form_leaders int default 3
) returns jsonb
language sql
stable
as $$
with
-- 1) Resolve team IDs (flexible): prefer exact full_name, then exact abbr, then partial full_name.
ta as (
  select team_id, full_name, abbreviation
  from public.teams
  where
    lower(full_name) = lower(p_team_a)
    or lower(abbreviation) = lower(p_team_a)
    or full_name ilike '%' || p_team_a || '%'
  order by
    case
      when lower(full_name) = lower(p_team_a) then 0
      when lower(abbreviation) = lower(p_team_a) then 1
      else 2
    end,
    length(full_name) asc
  limit 1
),
tb as (
  select team_id, full_name, abbreviation
  from public.teams
  where
    lower(full_name) = lower(p_team_b)
    or lower(abbreviation) = lower(p_team_b)
    or full_name ilike '%' || p_team_b || '%'
  order by
    case
      when lower(full_name) = lower(p_team_b) then 0
      when lower(abbreviation) = lower(p_team_b) then 1
      else 2
    end,
    length(full_name) asc
  limit 1
),

-- 2) Choose the game:
-- If p_game_date_est provided, prefer that day; if no match, fall back to next upcoming.
g_exact as (
  select
    g.game_id,
    g.season,
    g.game_date_utc,
    g.game_date_est,
    g.home_team_id,
    g.away_team_id,
    g.venue_name,
    g.venue_city,
    g.venue_state,
    g.game_status,
    g.home_score,
    g.away_score
  from public.games g
  join ta on true
  join tb on true
  where (
    (g.home_team_id = ta.team_id and g.away_team_id = tb.team_id)
    or (g.home_team_id = tb.team_id and g.away_team_id = ta.team_id)
  )
  and (p_season is null or g.season = p_season)
  and p_game_date_est is not null
  and g.game_date_est = p_game_date_est
  order by g.game_date_utc asc
  limit 1
),
g_next as (
  select
    g.game_id,
    g.season,
    g.game_date_utc,
    g.game_date_est,
    g.home_team_id,
    g.away_team_id,
    g.venue_name,
    g.venue_city,
    g.venue_state,
    g.game_status,
    g.home_score,
    g.away_score
  from public.games g
  join ta on true
  join tb on true
  where (
    (g.home_team_id = ta.team_id and g.away_team_id = tb.team_id)
    or (g.home_team_id = tb.team_id and g.away_team_id = ta.team_id)
  )
  and (p_season is null or g.season = p_season)
  and g.game_date_utc >= now() - interval '6 hours'
  order by g.game_date_utc asc
  limit 1
),
g as (
  select * from g_exact
  union all
  select * from g_next
  limit 1
),

ctx as (
  select
    (select team_id from ta) as team_a_id,
    (select team_id from tb) as team_b_id,
    (select full_name from ta) as team_a_name,
    (select full_name from tb) as team_b_name,
    (select abbreviation from ta) as team_a_abbr,
    (select abbreviation from tb) as team_b_abbr,
    (select game_id from g) as game_id,
    (select season from g) as season,
    (select game_date_est from g) as game_date_est,
    (select game_date_utc from g) as game_date_utc,
    (select home_team_id from g) as home_team_id,
    (select away_team_id from g) as away_team_id,
    (select venue_name from g) as venue_name,
    (select venue_city from g) as venue_city,
    (select venue_state from g) as venue_state
),

-- 3) Team form: last 10 + last 3 before game date
team_form_base as (
  select
    tgr.team_id,
    tgr.game_date_est,
    tgr.margin,
    tgr.win_flag
  from public.team_game_results tgr
  join ctx c on tgr.team_id in (c.team_a_id, c.team_b_id)
  where (c.season is null or tgr.season = c.season)
    and (c.game_date_est is null or tgr.game_date_est < c.game_date_est)
),
team_form_ranked as (
  select
    team_id,
    game_date_est,
    margin,
    win_flag,
    row_number() over (partition by team_id order by game_date_est desc) as rn
  from team_form_base
),
team_form_agg as (
  select
    team_id,
    -- last 10
    sum(case when rn <= 10 and win_flag then 1 else 0 end) as w10,
    sum(case when rn <= 10 and win_flag = false then 1 else 0 end) as l10,
    avg(case when rn <= 10 then margin end)::numeric(10,2) as margin10,
    sum(case when rn <= 10 and abs(margin) <= p_close_margin and win_flag then 1 else 0 end) as close_w10,
    sum(case when rn <= 10 and abs(margin) <= p_close_margin and win_flag = false then 1 else 0 end) as close_l10,
    -- last 3
    sum(case when rn <= 3 and win_flag then 1 else 0 end) as w3,
    sum(case when rn <= 3 and win_flag = false then 1 else 0 end) as l3,
    avg(case when rn <= 3 then margin end)::numeric(10,2) as margin3
  from team_form_ranked
  group by team_id
),

-- 4) Standings snapshot: latest before game date (or latest overall)
standings_pick as (
  select distinct on (ts.team_id)
    ts.team_id,
    ts.snapshot_date,
    ts.wins,
    ts.losses,
    ts.conference,
    ts.conference_rank,
    ts.last_10_wins,
    ts.last_10_losses,
    ts.streak
  from public.team_standings ts
  join ctx c on ts.team_id in (c.team_a_id, c.team_b_id)
  where (c.season is null or ts.season = c.season)
    and (c.game_date_est is null or ts.snapshot_date <= c.game_date_est)
  order by ts.team_id, ts.snapshot_date desc
),

-- 5) Roster snapshot for each team (latest <= game date)
roster_pick as (
  select distinct on (r.team_id, r.player_id)
    r.team_id,
    r.player_id,
    r.snapshot_date
  from public.rosters r
  join ctx c on r.team_id in (c.team_a_id, c.team_b_id)
  where (c.season is null or r.season = c.season)
    and (c.game_date_est is null or r.snapshot_date <= c.game_date_est)
  order by r.team_id, r.player_id, r.snapshot_date desc
),

-- 6) Availability: latest unresolved; prefer game-specific if exists
availability_latest as (
  select distinct on (pa.player_id, pa.team_id)
    pa.player_id,
    pa.team_id,
    pa.game_id,
    pa.availability_status,
    pa.reason,
    pa.reported_at
  from public.player_availability pa
  join ctx c on pa.team_id in (c.team_a_id, c.team_b_id)
  where pa.resolved_at is null
    and (
      (c.game_id is not null and pa.game_id = c.game_id)
      or pa.game_id is null
    )
  order by pa.player_id, pa.team_id,
           (case when pa.game_id = (select game_id from ctx) then 0 else 1 end),
           pa.reported_at desc
),
availability_named as (
  select
    a.team_id,
    p.full_name as player_name,
    a.availability_status as status,
    coalesce(a.reason,'') as reason,
    a.reported_at
  from availability_latest a
  join public.players p on p.player_id = a.player_id
),

-- 7) Rolling form leaders (as_of_date <= game_date_est): usage proxy leaders
rolling_pick as (
  select distinct on (prs.player_id, prs.current_team_id)
    prs.player_id,
    prs.current_team_id as team_id,
    prs.as_of_date,
    prs.minutes_avg_10,
    prs.usage_proxy_avg_10,
    prs.minutes_season,
    prs.usage_proxy_season,
    prs.minutes_delta_3_vs_season,
    prs.usage_delta_3_vs_season,
    prs.minutes_avg_3,
    prs.games_count_10
  from public.player_rolling_stats prs
  join ctx c on prs.current_team_id in (c.team_a_id, c.team_b_id)
  where (c.season is null or prs.season = c.season)
    and (c.game_date_est is null or prs.as_of_date <= c.game_date_est)
  order by prs.player_id, prs.current_team_id, prs.as_of_date desc
),
rolling_leaders as (
  select
    rp.team_id,
    pl.full_name as player_name,
    rp.minutes_avg_10,
    rp.minutes_season,
    rp.usage_proxy_avg_10,
    rp.usage_proxy_season,
    rp.usage_delta_3_vs_season,
    rp.minutes_avg_3,
    rp.games_count_10
  from rolling_pick rp
  join public.players pl on pl.player_id = rp.player_id
),
rolling_ranked as (
  select
    team_id,
    player_name,
    minutes_avg_10,
    minutes_season,
    usage_proxy_avg_10,
    usage_proxy_season,
    usage_delta_3_vs_season,
    minutes_avg_3,
    games_count_10,
    row_number() over (partition by team_id order by usage_proxy_avg_10 desc nulls last) as rn
  from rolling_leaders
),

-- 7b) Availability summary (always present for bullets)
availability_summary as (
  select 1 as ord, c.team_a_id as team_id, c.team_a_abbr as abbr,
    case
      when exists (
        select 1 from availability_named an
        where an.team_id = c.team_a_id
          and lower(coalesce(an.status,'')) not like '%active%'
      ) then coalesce((
        select string_agg(x.txt, ', ')
        from (
          select an.player_name || ' ' || an.status as txt
          from availability_named an
          where an.team_id = c.team_a_id
            and lower(coalesce(an.status,'')) not like '%active%'
          order by an.reported_at desc
          limit 2
        ) x
      ), 'No major absences')
      when exists (
        select 1 from availability_named an
        where an.team_id = c.team_a_id
          and lower(coalesce(an.status,'')) like '%active%'
      ) then coalesce((
        select string_agg(x.txt, ', ')
        from (
          select an.player_name || ' available' as txt
          from availability_named an
          where an.team_id = c.team_a_id
            and lower(coalesce(an.status,'')) like '%active%'
          order by an.reported_at desc
          limit 1
        ) x
      ), 'No major absences')
      else 'No major absences'
    end as summary_text
  from ctx c

  union all

  select 2 as ord, c.team_b_id as team_id, c.team_b_abbr as abbr,
    case
      when exists (
        select 1 from availability_named an
        where an.team_id = c.team_b_id
          and lower(coalesce(an.status,'')) not like '%active%'
      ) then coalesce((
        select string_agg(x.txt, ', ')
        from (
          select an.player_name || ' ' || an.status as txt
          from availability_named an
          where an.team_id = c.team_b_id
            and lower(coalesce(an.status,'')) not like '%active%'
          order by an.reported_at desc
          limit 2
        ) x
      ), 'No major absences')
      when exists (
        select 1 from availability_named an
        where an.team_id = c.team_b_id
          and lower(coalesce(an.status,'')) like '%active%'
      ) then coalesce((
        select string_agg(x.txt, ', ')
        from (
          select an.player_name || ' available' as txt
          from availability_named an
          where an.team_id = c.team_b_id
            and lower(coalesce(an.status,'')) like '%active%'
          order by an.reported_at desc
          limit 1
        ) x
      ), 'No major absences')
      else 'No major absences'
    end as summary_text
  from ctx c
),
availability_bullet as (
  select string_agg(abbr || ': ' || summary_text, ' | ' order by ord) as value_text
  from availability_summary
),
availability_major_absences as (
  select
    c.team_a_id as team_id,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'playerName', an.player_name,
        'status', an.status,
        'reason', an.reason,
        'reportedAt', an.reported_at
      )
      order by an.reported_at desc
    ) filter (where an.player_name is not null), '[]'::jsonb) as items
  from ctx c
  left join availability_named an
    on an.team_id = c.team_a_id
   and lower(coalesce(an.status,'')) not like '%active%'
  group by c.team_a_id

  union all

  select
    c.team_b_id as team_id,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'playerName', an.player_name,
        'status', an.status,
        'reason', an.reason,
        'reportedAt', an.reported_at
      )
      order by an.reported_at desc
    ) filter (where an.player_name is not null), '[]'::jsonb) as items
  from ctx c
  left join availability_named an
    on an.team_id = c.team_b_id
   and lower(coalesce(an.status,'')) not like '%active%'
  group by c.team_b_id
),
availability_major_absences_wrapped as (
  select
    team_id,
    jsonb_build_object(
      'count', jsonb_array_length(items),
      'players', items
    ) as obj
  from availability_major_absences
),

-- 7c) Form leaders (detailed objects for AI + displayPriority for UI)
form_leaders_detailed as (
  select
    rr.team_id,
    (select abbreviation from public.teams t where t.team_id = rr.team_id) as team_abbr,
    rr.player_name,
    round(coalesce(rr.usage_proxy_avg_10,0), 1) as usg10,
    round(coalesce(rr.minutes_avg_10,0), 1) as min10,
    round(coalesce(rr.usage_proxy_season,0), 1) as usg_season,
    round(coalesce(rr.minutes_season,0), 1) as min_season,
    round(coalesce(rr.usage_proxy_avg_10,0) - coalesce(rr.usage_proxy_season,0), 1) as delta_usg10_vs_season,
    round(coalesce(rr.minutes_avg_10,0) - coalesce(rr.minutes_season,0), 1) as delta_min10_vs_season,
    round(coalesce(rr.usage_delta_3_vs_season,0), 1) as delta_usg,
    round(coalesce(rr.minutes_avg_3,0), 1) as min3,
    round(coalesce(rr.games_count_10,0), 0) as games10,
    (rr.rn <= 2) as display_priority,
    rr.rn
  from rolling_ranked rr
  where rr.rn <= p_form_leaders
),
form_leaders_text as (
  select
    fld.*,
    (fld.player_name || ' (' || fld.team_abbr || ') — ' ||
      'USG10 ' || fld.usg10::text || ' (SZN ' || fld.usg_season::text || ')' ||
      ' | MIN10 ' || fld.min10::text || ' (SZN ' || fld.min_season::text || ')' ||
      ' | ΔUSG10 ' ||
      (case when fld.delta_usg10_vs_season > 0 then '+' || fld.delta_usg10_vs_season::text else fld.delta_usg10_vs_season::text end)
    ) as display_text
  from form_leaders_detailed fld
),
form_leaders_priority_json as (
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'teamAbbr', team_abbr,
      'playerName', player_name,
      'USG10', usg10,
      'MIN10', min10,
      'USGSeason', usg_season,
      'MINSeason', min_season,
      'deltaUSG10vsSeason', delta_usg10_vs_season,
      'deltaMIN10vsSeason', delta_min10_vs_season,
      'deltaUSG', delta_usg,
      'minutesAvg3', min3,
      'gamesCount10', games10,
      'displayText', display_text
    )
    order by team_id, rn
  ) filter (where display_priority = true), '[]'::jsonb) as items
  from form_leaders_text
),
form_leaders_json_all as (
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'teamId', team_id,
      'teamAbbr', team_abbr,
      'playerName', player_name,
      'USG10', usg10,
      'MIN10', min10,
      'USGSeason', usg_season,
      'MINSeason', min_season,
      'deltaUSG10vsSeason', delta_usg10_vs_season,
      'deltaMIN10vsSeason', delta_min10_vs_season,
      'deltaUSG', delta_usg,
      'minutesAvg3', min3,
      'gamesCount10', games10,
      'displayPriority', display_priority,
      'displayText', display_text
    )
    order by team_id, rn
  ), '[]'::jsonb) as items
  from form_leaders_text
),
form_leaders_display_text as (
  select coalesce(jsonb_agg(display_text order by team_id, rn), '[]'::jsonb) as items
  from form_leaders_text
  where display_priority = true
),
form_leaders_all_text as (
  select coalesce(jsonb_agg(display_text order by team_id, rn), '[]'::jsonb) as items
  from form_leaders_text
),

-- 8) Revenge watch: current roster players with history on opponent team
revenge_candidates as (
  select
    r.team_id as current_team_id,
    r.player_id,
    case
      when r.team_id = (select team_a_id from ctx) then (select team_b_id from ctx)
      else (select team_a_id from ctx)
    end as opponent_team_id
  from roster_pick r
),
revenge_hits as (
  select distinct
    rc.current_team_id,
    rc.opponent_team_id,
    p.full_name as player_name
  from revenge_candidates rc
  join public.player_team_history pth
    on pth.player_id = rc.player_id
   and pth.team_id = rc.opponent_team_id
  join public.players p
    on p.player_id = rc.player_id
),

-- 9) Opponent history nuggets (optional): current roster players vs opponent team
opp_hist as (
  select
    rc.current_team_id,
    p.full_name as player_name,
    poh.games_played,
    poh.avg_pts,
    poh.avg_reb,
    poh.avg_ast
  from revenge_candidates rc
  join public.player_opponent_history poh
    on poh.player_id = rc.player_id
   and poh.opponent_team_id = rc.opponent_team_id
  join public.players p on p.player_id = rc.player_id
  where poh.games_played >= 3
),
opp_hist_ranked as (
  select
    current_team_id as team_id,
    player_name,
    games_played,
    avg_pts, avg_reb, avg_ast,
    row_number() over (partition by current_team_id order by games_played desc, avg_pts desc nulls last) as rn
  from opp_hist
),

-- 10) Compose FactDrop bullets + comparisons + sections
a_form as (
  select * from team_form_agg where team_id = (select team_a_id from ctx)
),
b_form as (
  select * from team_form_agg where team_id = (select team_b_id from ctx)
),
a_stand as (
  select * from standings_pick where team_id = (select team_a_id from ctx)
),
b_stand as (
  select * from standings_pick where team_id = (select team_b_id from ctx)
),

-- 10a) Chart datasets (Chart.js-ready)
-- Momentum Line: last N game margins (oldest -> newest) for each team
momentum_ranked as (
  select
    tfr.team_id,
    tfr.rn,
    tfr.game_date_est,
    round(coalesce(tfr.margin,0), 1) as margin
  from team_form_ranked tfr
  where tfr.rn <= 12
),
momentum_series as (
  select
    jsonb_build_object(
      'window', 12,
      'series', jsonb_build_object(
        'A', jsonb_build_object(
          'label', (select team_a_abbr from ctx),
          'dates', coalesce((
            select jsonb_agg(to_char(m.game_date_est, 'YYYY-MM-DD') order by m.rn desc)
            from momentum_ranked m
            where m.team_id = (select team_a_id from ctx)
          ), '[]'::jsonb),
          'margins', coalesce((
            select jsonb_agg(m.margin order by m.rn desc)
            from momentum_ranked m
            where m.team_id = (select team_a_id from ctx)
          ), '[]'::jsonb)
        ),
        'B', jsonb_build_object(
          'label', (select team_b_abbr from ctx),
          'dates', coalesce((
            select jsonb_agg(to_char(m.game_date_est, 'YYYY-MM-DD') order by m.rn desc)
            from momentum_ranked m
            where m.team_id = (select team_b_id from ctx)
          ), '[]'::jsonb),
          'margins', coalesce((
            select jsonb_agg(m.margin order by m.rn desc)
            from momentum_ranked m
            where m.team_id = (select team_b_id from ctx)
          ), '[]'::jsonb)
        )
      )
    ) as obj
),

-- Star Load: top priority players (top 2 per team)
star_load as (
  select jsonb_build_object('players', (select items from form_leaders_priority_json)) as obj
),

-- Pressure Bar: close-game record in last 10 (already computed in team_form_agg)
pressure_bar as (
  select
    jsonb_build_object(
      'closeMargin', p_close_margin,
      'A', jsonb_build_object(
        'label', (select team_a_abbr from ctx),
        'wins', coalesce((select close_w10 from a_form),0),
        'losses', coalesce((select close_l10 from a_form),0)
      ),
      'B', jsonb_build_object(
        'label', (select team_b_abbr from ctx),
        'wins', coalesce((select close_w10 from b_form),0),
        'losses', coalesce((select close_l10 from b_form),0)
      )
    ) as obj
),

-- Role Volatility: rotation players with biggest ΔUSG3vsSeason (diverging bars)
volatility_pick as (
  select
    rp.team_id,
    (select abbreviation from public.teams t where t.team_id = rp.team_id) as team_abbr,
    pl.full_name as player_name,
    round(coalesce(rp.usage_delta_3_vs_season,0), 1) as delta_usg3,
    round(coalesce(rp.minutes_avg_10,0), 1) as min10
  from rolling_pick rp
  join roster_pick r
    on r.team_id = rp.team_id
   and r.player_id = rp.player_id
  join public.players pl
    on pl.player_id = rp.player_id
  where coalesce(rp.minutes_avg_10,0) >= 12
),
volatility_ranked as (
  select
    vp.*,
    row_number() over (
      partition by vp.team_id
      order by abs(vp.delta_usg3) desc nulls last, vp.min10 desc nulls last
    ) as rn
  from volatility_pick vp
),
volatility_json as (
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'teamAbbr', team_abbr,
        'playerName', player_name,
        'deltaUSG3vsSeason', delta_usg3,
        'MIN10', min10
      )
      order by team_id, rn
    ) filter (where rn <= 6), '[]'::jsonb) as items
  from volatility_ranked
),
role_volatility as (
  select jsonb_build_object('players', (select items from volatility_json)) as obj
),

sections_raw as (
  select
    jsonb_build_object(
      'title','REVENGE_WATCH',
      'items', coalesce((
        select jsonb_agg(
          rh.player_name || ' vs ' ||
          (select full_name from public.teams t where t.team_id = rh.opponent_team_id) ||
          ' [history]'
        )
        from revenge_hits rh
        limit 6
      ), '[]'::jsonb)
    ) as section_obj

  union all

  select
    jsonb_build_object(
      'title','AVAILABILITY_SHOCK',
      'items', coalesce((
        select jsonb_agg(
          an.player_name || ' (' ||
          (select abbreviation from public.teams t where t.team_id = an.team_id) ||
          ') — ' || an.status ||
          case when an.reason <> '' then ' — ' || an.reason else '' end
        )
        from availability_named an
        limit 10
      ), '[]'::jsonb)
    )

  union all

  select
    jsonb_build_object(
      'title','FORM_LEADERS',
      -- items = ONLY displayPriority=true (top 2 per team) for clean UI
      'items', (select items from form_leaders_display_text),
      -- itemsDetailed = structured objects with displayPriority flags
      'itemsDetailed', (select items from form_leaders_json_all)
    )

  union all

  select
    jsonb_build_object(
      'title','VS_OPP_HISTORY',
      'items', coalesce((
        select jsonb_agg(
          ohr.player_name || ' — ' ||
          ohr.games_played::text || ' gp vs opp | ' ||
          'PTS ' || coalesce(ohr.avg_pts,0)::text ||
          ' REB ' || coalesce(ohr.avg_reb,0)::text ||
          ' AST ' || coalesce(ohr.avg_ast,0)::text
        order by ohr.team_id, ohr.rn)
        from opp_hist_ranked ohr
        where ohr.rn <= 2
      ), '[]'::jsonb)
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
    when (select game_id from ctx) is null then
      jsonb_build_object(
        'error', 'GAME_NOT_FOUND',
        'message', 'Could not find a matching game (by date or upcoming)',
        'input', jsonb_build_object('teamA', p_team_a, 'teamB', p_team_b, 'gameDateEst', p_game_date_est, 'season', p_season)
      )
    else
      jsonb_build_object(
        'version', 'v3',
        'source', 'local_stats_db',
        'generatedAtUtc', now(),
        'matchup', jsonb_build_object(
          'gameId', (select game_id from ctx),
          'season', (select season from ctx),
          'gameDateEst', (select game_date_est from ctx),
          -- Store true UTC with Z (do not emit local offset time here)
          'gameDateUtc', to_char(((select game_date_utc from ctx) at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'teamA', (select team_a_name from ctx),
          'teamB', (select team_b_name from ctx),
          'teamAAbbr', (select team_a_abbr from ctx),
          'teamBAbbr', (select team_b_abbr from ctx),
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
            'city', (select venue_city from ctx),
            'state', (select venue_state from ctx)
          )
        ),
        'factDrop', jsonb_build_object(
          'meta', jsonb_build_object(
            'closeMargin', p_close_margin,
            'formWindow10', 10,
            'formWindow3', 3,
            'formLeaders', p_form_leaders
          ),
          'raw', jsonb_build_object(
            'teamForm', jsonb_build_object(
              'A', jsonb_build_object(
                'w10', coalesce((select w10 from a_form),0),
                'l10', coalesce((select l10 from a_form),0),
                'margin10', round(coalesce((select margin10 from a_form),0),1),
                'w3', coalesce((select w3 from a_form),0),
                'l3', coalesce((select l3 from a_form),0),
                'margin3', round(coalesce((select margin3 from a_form),0),1),
                'closeW10', coalesce((select close_w10 from a_form),0),
                'closeL10', coalesce((select close_l10 from a_form),0)
              ),
              'B', jsonb_build_object(
                'w10', coalesce((select w10 from b_form),0),
                'l10', coalesce((select l10 from b_form),0),
                'margin10', round(coalesce((select margin10 from b_form),0),1),
                'w3', coalesce((select w3 from b_form),0),
                'l3', coalesce((select l3 from b_form),0),
                'margin3', round(coalesce((select margin3 from b_form),0),1),
                'closeW10', coalesce((select close_w10 from b_form),0),
                'closeL10', coalesce((select close_l10 from b_form),0)
              )
            ),
            'standings', jsonb_build_object(
              'A', jsonb_build_object(
                'conf', coalesce((select conference from a_stand),''),
                'rank', coalesce((select conference_rank from a_stand),0),
                'wins', coalesce((select wins from a_stand),0),
                'losses', coalesce((select losses from a_stand),0),
                'snapshotDate', (select snapshot_date from a_stand)
              ),
              'B', jsonb_build_object(
                'conf', coalesce((select conference from b_stand),''),
                'rank', coalesce((select conference_rank from b_stand),0),
                'wins', coalesce((select wins from b_stand),0),
                'losses', coalesce((select losses from b_stand),0),
                'snapshotDate', (select snapshot_date from b_stand)
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
                (select team_a_abbr from ctx) || ' ' ||
                coalesce((select w10 from a_form),0)::text || '-' || coalesce((select l10 from a_form),0)::text ||
                ' (' ||
                  (case when round(coalesce((select margin10 from a_form),0),1) > 0 then '+' else '' end) ||
                  round(coalesce((select margin10 from a_form),0),1)::text ||
                ') | ' ||
                (select team_b_abbr from ctx) || ' ' ||
                coalesce((select w10 from b_form),0)::text || '-' || coalesce((select l10 from b_form),0)::text ||
                ' (' ||
                  (case when round(coalesce((select margin10 from b_form),0),1) > 0 then '+' else '' end) ||
                  round(coalesce((select margin10 from b_form),0),1)::text ||
                ')',
              'raw', jsonb_build_object(
                'A', (select (jsonb_build_object(
                  'w10', coalesce(w10,0),
                  'l10', coalesce(l10,0),
                  'margin10', round(coalesce(margin10,0),1)
                )) from a_form),
                'B', (select (jsonb_build_object(
                  'w10', coalesce(w10,0),
                  'l10', coalesce(l10,0),
                  'margin10', round(coalesce(margin10,0),1)
                )) from b_form)
              )
            ),
            jsonb_build_object(
              'key', 'last3',
              'label', 'LAST 3',
              'display',
                (select team_a_abbr from ctx) || ' ' ||
                coalesce((select w3 from a_form),0)::text || '-' || coalesce((select l3 from a_form),0)::text ||
                ' (' ||
                  (case when round(coalesce((select margin3 from a_form),0),1) > 0 then '+' else '' end) ||
                  round(coalesce((select margin3 from a_form),0),1)::text ||
                ') | ' ||
                (select team_b_abbr from ctx) || ' ' ||
                coalesce((select w3 from b_form),0)::text || '-' || coalesce((select l3 from b_form),0)::text ||
                ' (' ||
                  (case when round(coalesce((select margin3 from b_form),0),1) > 0 then '+' else '' end) ||
                  round(coalesce((select margin3 from b_form),0),1)::text ||
                ')',
              'raw', jsonb_build_object(
                'A', (select (jsonb_build_object(
                  'w3', coalesce(w3,0),
                  'l3', coalesce(l3,0),
                  'margin3', round(coalesce(margin3,0),1)
                )) from a_form),
                'B', (select (jsonb_build_object(
                  'w3', coalesce(w3,0),
                  'l3', coalesce(l3,0),
                  'margin3', round(coalesce(margin3,0),1)
                )) from b_form)
              )
            ),
            jsonb_build_object(
              'key', 'momentum',
              'label', 'MOMENTUM',
              'display',
                (select team_a_abbr from ctx) || ' ' ||
                (case when round(coalesce((select margin3 from a_form),0),1) > 0 then '+' else '' end) ||
                round(coalesce((select margin3 from a_form),0),1)::text ||
                ' | ' ||
                (select team_b_abbr from ctx) || ' ' ||
                (case when round(coalesce((select margin3 from b_form),0),1) > 0 then '+' else '' end) ||
                round(coalesce((select margin3 from b_form),0),1)::text,
              'raw', jsonb_build_object(
                'A', round(coalesce((select margin3 from a_form),0),1),
                'B', round(coalesce((select margin3 from b_form),0),1)
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
              'label', 'CLOSE GAMES (≤ ' || p_close_margin::text || ')',
              'display',
                (select team_a_abbr from ctx) || ' ' ||
                coalesce((select close_w10 from a_form),0)::text || '-' || coalesce((select close_l10 from a_form),0)::text ||
                ' | ' ||
                (select team_b_abbr from ctx) || ' ' ||
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
                coalesce((select conference from a_stand),'') || ' #' || coalesce((select conference_rank from a_stand),0)::text ||
                ' (' || coalesce((select wins from a_stand),0)::text || '-' || coalesce((select losses from a_stand),0)::text || ')' ||
                ' | ' ||
                coalesce((select conference from b_stand),'') || ' #' || coalesce((select conference_rank from b_stand),0)::text ||
                ' (' || coalesce((select wins from b_stand),0)::text || '-' || coalesce((select losses from b_stand),0)::text || ')',
              'raw', jsonb_build_object(
                'A', jsonb_build_object('conf', coalesce((select conference from a_stand),''), 'rank', coalesce((select conference_rank from a_stand),0), 'wins', coalesce((select wins from a_stand),0), 'losses', coalesce((select losses from a_stand),0)),
                'B', jsonb_build_object('conf', coalesce((select conference from b_stand),''), 'rank', coalesce((select conference_rank from b_stand),0), 'wins', coalesce((select wins from b_stand),0), 'losses', coalesce((select losses from b_stand),0))
              )
            )
          ),
          'comparisons', jsonb_build_array(
            jsonb_build_object(
              'key', 'margin10',
              'metric', 'AVG MARGIN (L10)',
              'A', round(coalesce((select margin10 from a_form),0),1),
              'B', round(coalesce((select margin10 from b_form),0),1),
              'winner',
                case
                  when coalesce((select margin10 from a_form),0) > coalesce((select margin10 from b_form),0) then 'A'
                  when coalesce((select margin10 from a_form),0) < coalesce((select margin10 from b_form),0) then 'B'
                  else 'even'
                end,
              'display', jsonb_build_object(
                'A', (case when round(coalesce((select margin10 from a_form),0),1) > 0 then '+' else '' end) || round(coalesce((select margin10 from a_form),0),1)::text,
                'B', (case when round(coalesce((select margin10 from b_form),0),1) > 0 then '+' else '' end) || round(coalesce((select margin10 from b_form),0),1)::text
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
              'key', 'revengeWatch',
              'title', 'REVENGE_WATCH',
              'items', coalesce((select (section_obj->'items') from sections_filtered where section_obj->>'title' = 'REVENGE_WATCH' limit 1), '[]'::jsonb)
            ),
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
            ),
            jsonb_build_object(
              'key', 'vsOppHistory',
              'title', 'VS_OPP_HISTORY',
              'items', coalesce((select (section_obj->'items') from sections_filtered where section_obj->>'title' = 'VS_OPP_HISTORY' limit 1), '[]'::jsonb)
            )
          )
        )
      )
  end;
$$;


