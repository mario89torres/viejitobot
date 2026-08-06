import { HeuristicEngine } from './HeuristicEngine';
import { MLEngine } from './MLEngine';
import { ScoringFeatures } from '../types/domain';

export class UnifiedScorer {
  private heuristicEngine: HeuristicEngine;
  private mlEngine: MLEngine;

  constructor() {
    this.heuristicEngine = new HeuristicEngine();
    this.mlEngine = new MLEngine();
  }

  public getMode(): 'learned' | 'heuristic' | 'shadow' {
    const m = (process.env.MODEL_MODE || 'shadow').toLowerCase();
    return ['learned', 'heuristic', 'shadow'].includes(m)
      ? (m as 'learned' | 'heuristic' | 'shadow')
      : 'shadow';
  }

  public score(features: ScoringFeatures, sport: string) {
    const mode = this.getMode();
    const confHeuristic = this.heuristicEngine.evaluate(features);
    const confLearned = mode === 'heuristic' ? null : this.mlEngine.evaluate(features, sport);

    const conf = (mode === 'learned' && confLearned !== null) ? confLearned : confHeuristic;
    return { conf, confHeuristic, confLearned, mode };
  }

  public computeStake(conf: number, oddDecimal: number, mode = process.env.STAKE_MODE || 'half_kelly', isHighConviction = false): number {
    if (mode === 'flat') return 1;
    const b = oddDecimal - 1;
    if (b <= 0) return 0.1;

    const kellyFrac = Math.max(0, (b * conf - (1 - conf)) / b);
    let frac = mode === 'kelly' ? kellyFrac : kellyFrac / 2;
    if (isHighConviction) frac *= 1.25;

    const unitScale = Number(process.env.STAKE_UNIT_SCALE || 20);
    const units = Math.round(frac * unitScale * 10) / 10;

    const stakeMin = Number(process.env.STAKE_MIN || 0.1);
    const stakeMaxConfig = Number(process.env.STAKE_MAX || 5.0);

    let dynamicMax = stakeMaxConfig;
    if (oddDecimal >= 1.70) dynamicMax = 2.5;
    else if (oddDecimal >= 1.50) dynamicMax = 3.5;

    return Math.min(dynamicMax, Math.max(stakeMin, units));
  }
}
