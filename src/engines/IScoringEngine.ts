import { PickEvent, ScoringFeatures, ConfidenceScore } from '../types/domain';

export interface IScoringEngine {
  name: string;
  score(event: PickEvent, features: ScoringFeatures): ConfidenceScore;
}
