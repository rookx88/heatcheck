export interface Source {
  source_id: string;
  title: string;
  publisher: string;
  url: string;
  published_utc: string;
  reliability_tier: 'A' | 'B' | 'C';
}

export interface Quote {
  quote_id: string;
  speaker: string;
  team: string;
  quote: string;
  context: string;
  date_utc: string;
  source_id: string;
}

export interface TimelineEvent {
  event_id: string;
  event_type: 'trade' | 'transfer' | 'benching' | 'injury' | 'contract' | 'rivalry' | 'other';
  date_utc: string;
  summary: string;
  source_id: string;
}

export interface EvidenceBundle {
  sources: Source[];
  quotes: Quote[];
  timeline_events: TimelineEvent[];
}

export interface OddsMarket {
  market: string;
  outcomes: string[];
  price: number;
  point?: number;
  book: string;
}

export interface FactPack {
  odds: {
    source: string;
    last_updated_utc: string;
    markets: OddsMarket[];
    movement_summary: string[];
  };
  context: {
    standings_summary?: string;
    recent_form: { home: string; away: string };
    injuries: { name: string; team: string; status: string }[];
  };
  key_stats: { label: string; value: string; why_it_matters: string }[];
}

export interface NarrativeScoreBreakdown {
  factual_support: number; // 0-5
  recency: number; // 0-5
  stakes: number; // 0-5
  performance_alignment: number; // 0-5
  uniqueness: number; // 0-5
  audience_resonance: number; // 0-5
  volatility_optional: number; // 0-5
}

export interface NarrativeCard {
  narrative_id: string;
  title: string;
  claim: string;
  emotion_tags: string[];
  key_characters: string[];
  evidence_requirements_met: boolean;
  score_breakdown: NarrativeScoreBreakdown;
  total_score: number; // 0-35
  risk_notes: string[];
  must_cite_source_ids: string[];
}

export interface ArticleData {
  seo: {
    primary_keyword: string;
    title_options: string[];
    meta_description: string;
  };
  long_form_markdown: string;
}

export interface HeatCheckMatchup {
  match_id: string;
  league: string;
  teams: { home: string; away: string };
  fact_pack: FactPack;
  evidence_bundle: EvidenceBundle;
  narratives: {
    candidate_cards: NarrativeCard[];
    selected: {
      primary_narrative_id: string;
      secondary_narrative_ids: string[];
    };
    fallback_lane_used: string;
  };
  article: ArticleData;
  quality_report: {
    missing_data_warnings: string[];
    hallucination_checks_passed: boolean;
    corrections_applied: string[];
  };
}

export interface HeatCheckResponse {
  run_meta: { timestamp_utc: string; notes: string };
  matchups: HeatCheckMatchup[];
}

export type Sport = 'NBA' | 'NFL' | 'Premier League' | 'MLB' | 'NHL' | 'UFC' | 'Other';

export interface MatchupRequest {
  teamA: string;
  teamB: string;
  sport: Sport;
  context?: string;
}

export interface KeyFigure {
  name: string;
  team: string;
  role: string;
  relevance: string;
  isRevengeGame: boolean;
}