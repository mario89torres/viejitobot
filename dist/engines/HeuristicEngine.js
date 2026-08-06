"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeuristicEngine = exports.HEURISTIC_WEIGHTS = void 0;
exports.HEURISTIC_WEIGHTS = {
    f_prob_justa: 0.35,
    f_avance: 0.30,
    f_situacion: 0.20,
    f_linea: 0.15,
};
class HeuristicEngine {
    name = 'HeuristicEngine';
    evaluate(features) {
        let conf = 0;
        conf += exports.HEURISTIC_WEIGHTS.f_prob_justa * features.f_prob_justa;
        conf += exports.HEURISTIC_WEIGHTS.f_avance * features.f_avance;
        conf += exports.HEURISTIC_WEIGHTS.f_situacion * features.f_situacion;
        conf += exports.HEURISTIC_WEIGHTS.f_linea * features.f_linea;
        return conf;
    }
}
exports.HeuristicEngine = HeuristicEngine;
