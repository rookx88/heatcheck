export enum NarrativeType {
  REVENGE = 'Revenge/Homecoming',
  MOTIVATION = 'Motivation/Belief',
  PACE = 'Scheme/Pace',
  GAME_SCRIPT = 'Game Script/Vegas',
  SHADOW = 'Shadow Coverage',
  DEFENSIVE_SCHEME = 'Defensive Scheme',
  UNKNOWN = 'General Value'
}

export interface PlayerInput {
  [key: string]: any;
}

export interface PlayerAnalysis {
  rank: number;
  playerName: string;
  position: string;
  team: string;
  opponent: string;
  salary: string | number;
  narrativeType: NarrativeType;
  confidenceScore: number; // 1-100
  analysis: string;
  keyStat?: string; // e.g., "+8.7% historical boost"
}

export interface AnalysisResult {
  topPlayers: PlayerAnalysis[];
  summary: string;
}
