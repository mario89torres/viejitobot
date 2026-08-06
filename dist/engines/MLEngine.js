"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MLEngine = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function interp(table, v) {
    const { x, y } = table;
    if (v <= x[0])
        return y[0];
    if (v >= x[x.length - 1])
        return y[y.length - 1];
    let lo = 0;
    let hi = x.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (x[mid] <= v)
            lo = mid;
        else
            hi = mid;
    }
    const t = (v - x[lo]) / (x[hi] - x[lo]);
    return y[lo] + t * (y[hi] - y[lo]);
}
class MLEngine {
    name = 'MLEngine';
    model = null;
    modelPath;
    constructor(modelPath) {
        this.modelPath = modelPath || path.join(__dirname, '..', '..', 'model.json');
        this.reloadModel();
    }
    reloadModel() {
        try {
            if (fs.existsSync(this.modelPath)) {
                const raw = fs.readFileSync(this.modelPath, 'utf8');
                const m = JSON.parse(raw);
                if (m && typeof m.intercept === 'number' && m.coef && m.calibration) {
                    this.model = m;
                    return this.model;
                }
            }
        }
        catch (e) {
            this.model = null;
        }
        this.model = null;
        return null;
    }
    isAdopted() {
        return !!(this.model && this.model.adopted === true);
    }
    evaluate(features, sport) {
        if (!this.model || this.model.adopted === false)
            return null;
        const featList = this.model.features && this.model.features.length
            ? this.model.features
            : ['f_prob_justa', 'f_avance', 'f_situacion', 'f_linea'];
        let z = this.model.intercept;
        for (const f of featList) {
            const key = f;
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
exports.MLEngine = MLEngine;
