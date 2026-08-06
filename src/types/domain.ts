export type MarketType =
  | 'winner'
  | 'handicap'
  | 'total'
  | 'btts'
  | 'dnb'
  | 'double_chance'
  | 'unknown';

export interface PickEvent {
  eventId: number;
  event: string;
  sport: string;
  sportId?: number;
  champ?: string;
  market: string;
  selection: string;
  oddDecimal: number;
  fairProb?: number;
  minute?: number | null;
  score?: string | null;
  setNum?: number | null;
  suspended?: boolean;
  sharpMatch?: string;
  sharp_match?: string;
}

export interface ScoringFeatures {
  f_prob_justa: number;
  f_avance: number;
  f_situacion: number;
  f_linea: number;
  f_apertura: number;
}

export interface ConfidenceScore {
  conf: number;
  confHeuristic: number;
  confLearned: number | null;
  edge: number;
  stake: number;
  stakeMode: string;
  isHighConviction: boolean;
  base: number;
  progress: number;
  scoreFactor: number;
  lineFactor: number;
  lineDelta: number;
  linePoints: number;
  openingOdd: number | null;
  fApertura: number;
  scoreVersion: number;
  lead: number | null;
  marketType: MarketType | null;
}

export interface SettledPick {
  id: number;
  ts: string;
  event_id: number;
  event: string;
  sport: string;
  market: string;
  selection: string;
  odd_decimal: number;
  conf: number;
  result: 'win' | 'loss' | 'push' | 'unknown';
  final_score: string;
  settled_ts?: string;
  stake: number;
  stake_mode?: string;
  source?: string;
  loss_minute?: number | null;
  edge?: number;
  profit?: number;
}

export interface CalibrationBin {
  range: string;
  n: number;
  avgConf: string;
  actualAcc: string;
  gap: string;
}

export interface QuantitativeHealth {
  n: number;
  wins: number;
  wr: number;
  totalStaked: number;
  totalProfit: number;
  roi: number;
  brierScore: number;
  logLoss: number;
  ece: number;
  sharpN: number;
  clvBeatRate: number | null;
  avgClvPct: number | null;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  bins: CalibrationBin[];
  status: string;
  color: string;
  message: string;
}
