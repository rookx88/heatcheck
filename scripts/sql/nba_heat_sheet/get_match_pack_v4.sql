-- HeatChecks: MatchPack V4 (nba_heat_sheet)
-- Extends V3 with advancedHeatStats for 3-pillar heat scoring
-- Install:
--   psql "$NBA_HEAT_SHEET_DATABASE_URL" -f scripts/sql/nba_heat_sheet/get_match_pack_v4.sql
--
-- NOTE: This function requires the following tables/views to exist:
--   - team_game_results (for momentumDivergence)
--   - team_trends (for creationAsymmetry)
--   - team_hustle_stats (for creationAsymmetry)
--   - opponent_defensive_stats (for shotQualityMismatch)
--   - player_rolling_stats (for rotationVolatility)
--   - player_trends (for rotationVolatility)
--   - player_availability (for availabilityImbalance)
--   - games (for scheduleStress)
-- If these tables don't exist, the function will return NULL for those scalars.

create or replace function public.get_match_pack_v4(
  p_team_a text,
  p_team_b text,
  p_game_date_est date default null,
  p_season varchar default null
) returns jsonb
language sql
stable
as $$
with
-- Reuse V3 CTEs for team resolution, game selection, form, standings
-- (Copy all CTEs from get_match_pack_v3 here, then add advancedHeatStats)

-- 1) Resolve team IDs (same as V3)
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

-- 2) Choose the game (same as V3)
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

-- 1) CONTROL STRESS: momentumDivergence (0-12)
-- Measure divergence in recent momentum between teams
-- Formula: |(L3_margin_A - L10_margin_A) - (L3_margin_B - L10_margin_B)|
momentum_base as (
  select
    tgr.team_id,
    tgr.game_date_est,
    tgr.margin,
    row_number() over (partition by tgr.team_id order by tgr.game_date_est desc) as rn
  from public.team_game_results tgr
  join ctx c on tgr.team_id in (c.team_a_id, c.team_b_id)
  where (c.season is null or tgr.season = c.season)
    and (c.game_date_est is null or tgr.game_date_est < c.game_date_est)
),
momentum_agg as (
  select
    team_id,
    avg(case when rn <= 3 then margin end)::numeric(10,2) as margin3,
    avg(case when rn <= 10 then margin end)::numeric(10,2) as margin10
  from momentum_base
  where rn <= 10
  group by team_id
),
momentum_deltas as (
  select
    team_id,
    (margin3 - margin10)::numeric(10,2) as momentum_delta
  from momentum_agg
),
momentum_divergence_raw as (
  select
    abs(
      coalesce((select momentum_delta from momentum_deltas where team_id = (select team_a_id from ctx)), 0) -
      coalesce((select momentum_delta from momentum_deltas where team_id = (select team_b_id from ctx)), 0)
    ) as divergence
),
momentum_divergence_scalar as (
  select
    least(coalesce((select divergence from momentum_divergence_raw), 0) * 0.6, 12)::numeric(5,2) as momentumDivergence,
    case
      when coalesce((select divergence from momentum_divergence_raw), 0) > 0 then
        array[
          'Team A momentum Δ: ' || 
          case when coalesce((select momentum_delta from momentum_deltas where team_id = (select team_a_id from ctx)), 0) > 0 then '+' else '' end ||
          round(coalesce((select momentum_delta from momentum_deltas where team_id = (select team_a_id from ctx)), 0), 1)::text ||
          ', Team B: ' ||
          case when coalesce((select momentum_delta from momentum_deltas where team_id = (select team_b_id from ctx)), 0) > 0 then '+' else '' end ||
          round(coalesce((select momentum_delta from momentum_deltas where team_id = (select team_b_id from ctx)), 0), 1)::text
        ]
      else array[]::text[]
    end as receipts
  from momentum_divergence_raw
),

-- 2) CONTROL STRESS: creationAsymmetry (0-10)
-- Measure asymmetry in creation trends (screen assists, secondary assists per 100 poss)
-- Use deltas: (L5 vs season) for both teams
-- team_trends has screen_assists_per_100_poss, secondary_assists_per_100_poss with window_size=5 for L5
creation_trends_l5 as (
  select distinct on (team_id)
    team_id,
    screen_assists_per_100_poss - screen_assists_season_avg as delta_screen,
    secondary_assists_per_100_poss - secondary_assists_season_avg as delta_sec
  from public.team_trends
  where team_id in ((select team_a_id from ctx), (select team_b_id from ctx))
    and (select season from ctx) is not null
    and season = (select season from ctx)
    and (select game_date_est from ctx) is not null
    and as_of_date <= (select game_date_est from ctx)
    and window_size = 5  -- L5 window
  order by team_id, as_of_date desc
),
creation_asymmetry_raw as (
  select
    abs(
      coalesce((select delta_screen + delta_sec from creation_trends_l5 where team_id = (select team_a_id from ctx)), 0) -
      coalesce((select delta_screen + delta_sec from creation_trends_l5 where team_id = (select team_b_id from ctx)), 0)
    ) as asymmetry
),
creation_asymmetry_scalar as (
  select
    least(coalesce((select asymmetry from creation_asymmetry_raw), 0) * 0.5, 10)::numeric(5,2) as creationAsymmetry,
    case
      when coalesce((select asymmetry from creation_asymmetry_raw), 0) > 0 then
        array[
          'Team A creation Δ: ' ||
          round(coalesce((select delta_screen + delta_sec from creation_trends_l5 where team_id = (select team_a_id from ctx)), 0), 1)::text ||
          ', Team B: ' ||
          round(coalesce((select delta_screen + delta_sec from creation_trends_l5 where team_id = (select team_b_id from ctx)), 0), 1)::text
        ]
      else array[]::text[]
    end as receipts
  from creation_asymmetry_raw
),

-- 3) CONTROL STRESS: shotQualityMismatch (0-8)
-- Measure mismatch between team offensive shot quality trend vs opponent defensive allowance
-- opponent_defensive_stats has uncontested_fga_allowed_delta and uncontested_fg_pct_allowed_delta
shot_quality_off_trend as (
  select distinct on (team_id)
    team_id,
    uncontested_fga_allowed_delta as off_trend_fga,
    uncontested_fg_pct_allowed_delta as off_trend_fg_pct
  from public.opponent_defensive_stats
  where team_id in ((select team_a_id from ctx), (select team_b_id from ctx))
    and (select season from ctx) is not null
    and season = (select season from ctx)
    and (select game_date_est from ctx) is not null
    and game_date_est <= (select game_date_est from ctx)
  order by team_id, game_date_est desc
),
shot_quality_mismatch_raw as (
  select
    abs(
      coalesce((select off_trend_fga + off_trend_fg_pct from shot_quality_off_trend where team_id = (select team_a_id from ctx)), 0) -
      coalesce((select off_trend_fga + off_trend_fg_pct from shot_quality_off_trend where team_id = (select team_b_id from ctx)), 0)
    ) +
    abs(
      coalesce((select off_trend_fga + off_trend_fg_pct from shot_quality_off_trend where team_id = (select team_b_id from ctx)), 0) -
      coalesce((select off_trend_fga + off_trend_fg_pct from shot_quality_off_trend where team_id = (select team_a_id from ctx)), 0)
    ) as mismatch
),
shot_quality_mismatch_scalar as (
  select
    least(coalesce((select mismatch from shot_quality_mismatch_raw), 0) * 0.4, 8)::numeric(5,2) as shotQualityMismatch,
    case
      when coalesce((select mismatch from shot_quality_mismatch_raw), 0) > 0 then
        array['Shot quality mismatch detected'::text]
      else array[]::text[]
    end as receipts
  from shot_quality_mismatch_raw
),

-- 4) STRUCTURAL INSTABILITY: rotationVolatility (0-8)
-- Measure instability in roles/minutes (L3 vs season deltas)
-- player_rolling_stats has minutes_delta_3_vs_season and usage_delta_3_vs_season
rotation_volatility_base as (
  select
    current_team_id as team_id,
    avg(abs(coalesce(minutes_delta_3_vs_season, 0)) + abs(coalesce(usage_delta_3_vs_season, 0))) as volatility
  from public.player_rolling_stats
  where current_team_id in ((select team_a_id from ctx), (select team_b_id from ctx))
    and (select season from ctx) is not null
    and season = (select season from ctx)
    and (select game_date_est from ctx) is not null
    and as_of_date <= (select game_date_est from ctx)
  group by current_team_id
),
rotation_volatility_scalar as (
  select
    least(coalesce((select max(volatility) from rotation_volatility_base), 0) * 0.4, 8)::numeric(5,2) as rotationVolatility,
    case
      when coalesce((select max(volatility) from rotation_volatility_base), 0) > 0 then
        array[
          'Team A volatility: ' || round(coalesce((select volatility from rotation_volatility_base where team_id = (select team_a_id from ctx)), 0), 1)::text ||
          ', Team B: ' || round(coalesce((select volatility from rotation_volatility_base where team_id = (select team_b_id from ctx)), 0), 1)::text
        ]
      else array[]::text[]
    end as receipts
  from rotation_volatility_base
  limit 1
),

-- 5) STRUCTURAL INSTABILITY: availabilityImbalance (0-7)
-- Measure imbalance in rotation-impact player availability
-- Count OUT > QUESTIONABLE for rotation players (filter by players with recent minutes)
availability_rotation_players as (
  select distinct
    prs.current_team_id as team_id,
    prs.player_id
  from public.player_rolling_stats prs
  where prs.current_team_id in ((select team_a_id from ctx), (select team_b_id from ctx))
    and (select season from ctx) is not null
    and prs.season = (select season from ctx)
    and (select game_date_est from ctx) is not null
    and prs.as_of_date <= (select game_date_est from ctx)
    and prs.minutes_avg_3 >= 10  -- Rotation players: at least 10 min/game in L3
),
availability_counts as (
  select
    arp.team_id,
    count(*) filter (where pa.availability_status = 'OUT') as count_out,
    count(*) filter (where pa.availability_status IN ('QUESTIONABLE', 'DOUBTFUL')) as count_questionable
  from availability_rotation_players arp
  left join public.player_availability pa on pa.player_id = arp.player_id
    and pa.team_id = arp.team_id
    and pa.resolved_at is null
    and (
      (pa.game_id = (select game_id from ctx) and (select game_id from ctx) is not null)
      or pa.game_id is null
    )
  group by arp.team_id
),
availability_imbalance_raw as (
  select
    abs(
      coalesce((select count_out from availability_counts where team_id = (select team_a_id from ctx)), 0) -
      coalesce((select count_out from availability_counts where team_id = (select team_b_id from ctx)), 0)
    ) as imbalance
),
availability_imbalance_scalar as (
  select
    least(coalesce((select imbalance from availability_imbalance_raw), 0) * 0.7, 7)::numeric(5,2) as availabilityImbalance,
    case
      when coalesce((select imbalance from availability_imbalance_raw), 0) > 0 then
        array[
          'Team A OUT: ' || coalesce((select count_out::text from availability_counts where team_id = (select team_a_id from ctx)), '0') ||
          ', Team B: ' || coalesce((select count_out::text from availability_counts where team_id = (select team_b_id from ctx)), '0')
        ]
      else array[]::text[]
    end as receipts
  from availability_imbalance_raw
),

-- 6) STRUCTURAL INSTABILITY: scheduleStress (0-5)
-- Detect schedule compression (B2B, 3-in-4, 4-in-6)
-- Simplified to avoid nested EXISTS and COUNT queries that can cause locking
schedule_games_recent as (
  select
    case when home_team_id in ((select team_a_id from ctx), (select team_b_id from ctx)) then home_team_id
         when away_team_id in ((select team_a_id from ctx), (select team_b_id from ctx)) then away_team_id
         else null end as team_id,
    game_date_est
  from public.games
  where (home_team_id in ((select team_a_id from ctx), (select team_b_id from ctx))
         or away_team_id in ((select team_a_id from ctx), (select team_b_id from ctx)))
    and (select game_date_est from ctx) is not null
    and game_date_est < (select game_date_est from ctx)
    and game_date_est >= (select game_date_est from ctx) - interval '6 days'
),
schedule_stress_calc as (
  select
    team_id,
    count(*) filter (where game_date_est = (select game_date_est from ctx) - interval '1 day') > 0 as is_b2b,
    count(*) filter (where game_date_est >= (select game_date_est from ctx) - interval '4 days') >= 2 as is_3_in_4,
    count(*) filter (where game_date_est >= (select game_date_est from ctx) - interval '6 days') >= 3 as is_4_in_6
  from schedule_games_recent
  where team_id is not null
  group by team_id
),
schedule_stress_scalar as (
  select
    least(
      case
        when (select bool_or(is_b2b) from schedule_stress_calc) then 3
        when (select bool_or(is_3_in_4) from schedule_stress_calc) then 2
        when (select bool_or(is_4_in_6) from schedule_stress_calc) then 1
        else 0
      end,
      5
    )::numeric(5,2) as scheduleStress,
    case
      when (select bool_or(is_b2b) from schedule_stress_calc) then
        array['B2B detected'::text]
      when (select bool_or(is_3_in_4) from schedule_stress_calc) then
        array['3-in-4 detected'::text]
      when (select bool_or(is_4_in_6) from schedule_stress_calc) then
        array['4-in-6 detected'::text]
      else array[]::text[]
    end as receipts
),

-- Build advancedHeatStats JSON (nested under 'advancedHeatStats' key)
advanced_heat_stats as (
  select
    jsonb_build_object(
      'advancedHeatStats', jsonb_build_object(
        'controlStress', jsonb_build_object(
          'momentumDivergence', coalesce((select momentumDivergence from momentum_divergence_scalar), 0),
          'creationAsymmetry', coalesce((select creationAsymmetry from creation_asymmetry_scalar), 0),
          'shotQualityMismatch', coalesce((select shotQualityMismatch from shot_quality_mismatch_scalar), 0),
          'receipts', jsonb_build_object(
            'creation', to_jsonb((select receipts from creation_asymmetry_scalar)),
            'shotQuality', to_jsonb((select receipts from shot_quality_mismatch_scalar))
          )
        ),
        'structuralInstability', jsonb_build_object(
          'rotationVolatility', coalesce((select rotationVolatility from rotation_volatility_scalar), 0),
          'availabilityImbalance', coalesce((select availabilityImbalance from availability_imbalance_scalar), 0),
          'scheduleStress', coalesce((select scheduleStress from schedule_stress_scalar), 0),
          'receipts', jsonb_build_object(
            'rotation', to_jsonb((select receipts from rotation_volatility_scalar)),
            'availability', to_jsonb((select receipts from availability_imbalance_scalar)),
            'schedule', to_jsonb((select receipts from schedule_stress_scalar))
          )
        )
      )
    ) as advancedHeatStats
),
-- Get V3 pack once and merge with advancedHeatStats
v3_pack as (
  select public.get_match_pack_v3(p_team_a, p_team_b, p_game_date_est, p_season, 6, 3) as pack
)

-- Merge V3 pack with advancedHeatStats
select
  (select pack from v3_pack) || jsonb_build_object(
    'factDrop', (
      (select pack->'factDrop' from v3_pack)
    ) || jsonb_build_object(
      'raw', (
        (select pack->'factDrop'->'raw' from v3_pack)
      ) || (select advancedHeatStats from advanced_heat_stats)
    )
  )
$$;

