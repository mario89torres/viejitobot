import * as fs from 'fs';
import * as path from 'path';
import { ScoringFeatures } from '../types/domain';

export interface ModelData {
  trained_at: string;
  n_samples: number;
  score_versions: number[];
  calibration_method: string;
  adopted: boolean;
  features: string[];
  intercept: number;
  coef: Record<string, number>;
  sport_coef: Record<string, number>;
  calibration: {
    x: number[];
    y: number[];
  };
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

function interp(table: { x: number[]; y: number[] }, v: number): number {
  const { x, y } = table;
  if (v <= x[0]) return y[0];
  if (v >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= v) lo = mid;
    else hi = mid;
  }
  const t = (v - x[lo]) / (x[hi] - x[lo]);
  return y[lo] + t * (y[hi] - y[lo]);
}

export class MLEngine {
  public readonly name = 'MLEngine';
  private model: ModelData | null = null;
  private modelPath: string;

  constructor(modelPath?: string) {
    this.modelPath = modelPath || path.join(__dirname, '..', '..', 'model.json');
    this.reloadModel();
  }

  public reloadModel(): ModelData | null {
    try {
      if (fs.existsSync(this.modelPath)) {
        const raw = fs.readFileSync(this.modelPath, 'utf8');
        const m = JSON.parse(raw) as ModelData;
        if (m && typeof m.intercept === 'number' && m.coef && m.calibration) {
          this.model = m;
          return this.model;
        }
      }
    } catch (e) {
      this.model = null;
    }
    this.model = null;
    return null;
  }

  public isAdopted(): boolean {
    return !!(this.model && this.model.adopted === true);
  }

  public evaluate(features: ScoringFeatures, sport: string): number | null {
    if (!this.model || this.model.adopted === false) return null;
    const featList = this.model.features && this.model.features.length
      ? this.model.features
      : ['f_prob_justa', 'f_avance', 'f_situacion', 'f_linea'];

    let z = this.model.intercept;
    for (const f of featList) {
      const key = f as keyof ScoringFeatures;
      z += (this.model.coef[f] || 0) * (features[key] ?? 0.5);
    }
    const sc = this.model.sport_coef || {};
    const sportKey = sc[sport] !== undefined ? sport : 'otros';
    z += sc[sportKey] || 0;

    const raw = sigmoid(z);
    const cal = interp(this.model.calibration, raw);
    return Math.min(1, Math.max(0, cal));
  }
}
