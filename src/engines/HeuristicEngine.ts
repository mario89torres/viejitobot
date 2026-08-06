import { ScoringFeatures } from '../types/domain';

export const HEURISTIC_WEIGHTS = {
  f_prob_justa: 0.35,
  f_avance: 0.30,
  f_situacion: 0.20,
  f_linea: 0.15,
};

export class HeuristicEngine {
  public readonly name = 'HeuristicEngine';

  public evaluate(features: ScoringFeatures): number {
    let conf = 0;
    conf += HEURISTIC_WEIGHTS.f_prob_justa * features.f_prob_justa;
    conf += HEURISTIC_WEIGHTS.f_avance * features.f_avance;
    conf += HEURISTIC_WEIGHTS.f_situacion * features.f_situacion;
    conf += HEURISTIC_WEIGHTS.f_linea * features.f_linea;
    return conf;
  }
}
