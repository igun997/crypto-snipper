/**
 * Adaptive Learning Service
 *
 * Learns from past prediction accuracy and adjusts model weights.
 * Uses exponential moving average to weight recent performance higher.
 */

import { getDatabase } from '../database/connection.js';
import predictionRepo from '../database/repositories/predictions.js';
import ensembleModel, { ModelWeights } from '../models/ensemble.js';
import { FormulaType } from '../types/index.js';

interface ModelPerformance {
  formulaType: FormulaType;
  totalPredictions: number;
  correctDirections: number;
  avgMape: number;
  recentAccuracy: number; // Weighted recent performance
  score: number; // Combined score for weight calculation
}

interface LearnedWeights {
  arimax: number;
  arimaxSentiment: number;
  lstm: number;
  technical: number;
  updatedAt: number;
}

export class AdaptiveLearner {
  private readonly decayFactor: number = 0.9; // EMA decay for recent performance
  private readonly minWeight: number = 0.1; // Minimum weight for any model
  private readonly maxWeight: number = 0.5; // Maximum weight for any model

  constructor() {
    this.initializeTable();
  }

  /**
   * Initialize learned_weights table if not exists
   */
  private initializeTable(): void {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS learned_weights (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        arimax REAL NOT NULL DEFAULT 0.25,
        arimax_sentiment REAL NOT NULL DEFAULT 0.25,
        lstm REAL NOT NULL DEFAULT 0.30,
        technical REAL NOT NULL DEFAULT 0.20,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    // Insert default row if not exists
    const existing = db.prepare('SELECT id FROM learned_weights WHERE id = 1').get();
    if (!existing) {
      db.prepare(`
        INSERT INTO learned_weights (id, arimax, arimax_sentiment, lstm, technical, updated_at)
        VALUES (1, 0.25, 0.25, 0.30, 0.20, ?)
      `).run(Date.now());
    }
  }

  /**
   * Get current learned weights
   */
  getLearnedWeights(): LearnedWeights {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM learned_weights WHERE id = 1').get() as {
      arimax: number;
      arimax_sentiment: number;
      lstm: number;
      technical: number;
      updated_at: number;
    };

    return {
      arimax: row.arimax,
      arimaxSentiment: row.arimax_sentiment,
      lstm: row.lstm,
      technical: row.technical,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Save updated weights to database
   */
  private saveWeights(weights: LearnedWeights): void {
    const db = getDatabase();
    db.prepare(`
      UPDATE learned_weights
      SET arimax = ?, arimax_sentiment = ?, lstm = ?, technical = ?, updated_at = ?
      WHERE id = 1
    `).run(weights.arimax, weights.arimaxSentiment, weights.lstm, weights.technical, Date.now());
  }

  /**
   * Calculate performance score for each model type
   */
  calculateModelPerformance(): ModelPerformance[] {
    const db = getDatabase();

    // Get accuracy stats grouped by formula type
    const stats = db.prepare(`
      SELECT
        p.formula_type,
        COUNT(ar.id) as total,
        SUM(ar.is_direction_correct) as correct,
        AVG(ar.mape) as avg_mape,
        -- Recent accuracy (last 20 predictions weighted higher)
        (
          SELECT AVG(ar2.is_direction_correct * 1.0)
          FROM accuracy_results ar2
          JOIN predictions p2 ON ar2.prediction_id = p2.id
          WHERE p2.formula_type = p.formula_type
          ORDER BY ar2.evaluated_at DESC
          LIMIT 20
        ) as recent_accuracy
      FROM predictions p
      JOIN accuracy_results ar ON p.id = ar.prediction_id
      GROUP BY p.formula_type
    `).all() as Array<{
      formula_type: FormulaType;
      total: number;
      correct: number;
      avg_mape: number;
      recent_accuracy: number | null;
    }>;

    return stats.map((s) => {
      const directionAccuracy = s.total > 0 ? s.correct / s.total : 0.5;
      const recentAccuracy = s.recent_accuracy ?? directionAccuracy;

      // Combined score: 60% direction accuracy, 40% MAPE-based score
      // Lower MAPE = higher score
      const mapeScore = Math.max(0, 1 - (s.avg_mape || 10) / 20);
      const score = directionAccuracy * 0.4 + recentAccuracy * 0.4 + mapeScore * 0.2;

      return {
        formulaType: s.formula_type,
        totalPredictions: s.total,
        correctDirections: s.correct,
        avgMape: s.avg_mape || 10,
        recentAccuracy,
        score,
      };
    });
  }

  /**
   * Learn from past predictions and update weights
   */
  learn(): { updated: boolean; weights: ModelWeights; performance: ModelPerformance[] } {
    const performance = this.calculateModelPerformance();

    // Need at least 5 evaluated predictions per model to start learning
    const validModels = performance.filter((p) => p.totalPredictions >= 5);

    if (validModels.length < 2) {
      // Not enough data to learn
      const currentWeights = this.getLearnedWeights();
      return {
        updated: false,
        weights: {
          arimax: currentWeights.arimax,
          arimaxSentiment: currentWeights.arimaxSentiment,
          lstm: currentWeights.lstm,
          technical: currentWeights.technical,
        },
        performance,
      };
    }

    // Calculate new weights based on performance scores
    const currentWeights = this.getLearnedWeights();
    const newWeights: LearnedWeights = { ...currentWeights, updatedAt: Date.now() };

    // Map formula types to weight keys
    const formulaToKey: Record<string, keyof ModelWeights> = {
      arimax: 'arimax',
      arimax_sentiment: 'arimaxSentiment',
      ensemble: 'arimax', // Ensemble doesn't have its own weight
    };

    // Update weights based on performance
    for (const perf of performance) {
      const key = formulaToKey[perf.formulaType];
      if (!key) continue;

      // Blend current weight with performance-based weight
      // Use EMA: new_weight = decay * current + (1-decay) * performance-based
      const performanceWeight = this.scoreToWeight(perf.score);
      const blendedWeight =
        this.decayFactor * currentWeights[key] + (1 - this.decayFactor) * performanceWeight;

      newWeights[key] = blendedWeight;
    }

    // Normalize weights to sum to 1
    this.normalizeWeights(newWeights);

    // Save to database
    this.saveWeights(newWeights);

    // Apply to ensemble model
    const modelWeights: ModelWeights = {
      arimax: newWeights.arimax,
      arimaxSentiment: newWeights.arimaxSentiment,
      lstm: newWeights.lstm,
      technical: newWeights.technical,
    };
    ensembleModel.setWeights(modelWeights);

    return {
      updated: true,
      weights: modelWeights,
      performance,
    };
  }

  /**
   * Convert performance score to weight
   */
  private scoreToWeight(score: number): number {
    // Score is 0-1, map to weight range
    const weight = this.minWeight + score * (this.maxWeight - this.minWeight);
    return Math.max(this.minWeight, Math.min(this.maxWeight, weight));
  }

  /**
   * Normalize weights to sum to 1
   */
  private normalizeWeights(weights: LearnedWeights): void {
    const total = weights.arimax + weights.arimaxSentiment + weights.lstm + weights.technical;
    if (total > 0) {
      weights.arimax /= total;
      weights.arimaxSentiment /= total;
      weights.lstm /= total;
      weights.technical /= total;
    }
  }

  /**
   * Apply learned weights to ensemble model
   */
  applyLearnedWeights(): void {
    const weights = this.getLearnedWeights();
    ensembleModel.setWeights({
      arimax: weights.arimax,
      arimaxSentiment: weights.arimaxSentiment,
      lstm: weights.lstm,
      technical: weights.technical,
    });
  }

  /**
   * Get learning summary
   */
  getSummary(): string {
    const weights = this.getLearnedWeights();
    const performance = this.calculateModelPerformance();

    let summary = '\n=== Adaptive Learning Summary ===\n\n';
    summary += 'Current Weights:\n';
    summary += `  ARIMAX:           ${(weights.arimax * 100).toFixed(1)}%\n`;
    summary += `  ARIMAX+Sentiment: ${(weights.arimaxSentiment * 100).toFixed(1)}%\n`;
    summary += `  LSTM:             ${(weights.lstm * 100).toFixed(1)}%\n`;
    summary += `  Technical:        ${(weights.technical * 100).toFixed(1)}%\n`;
    summary += `\nLast Updated: ${new Date(weights.updatedAt).toLocaleString()}\n`;

    if (performance.length > 0) {
      summary += '\nModel Performance:\n';
      for (const p of performance) {
        const acc = p.totalPredictions > 0 ? (p.correctDirections / p.totalPredictions * 100).toFixed(1) : '0.0';
        summary += `  ${p.formulaType.padEnd(18)} Accuracy: ${acc}%  MAPE: ${p.avgMape.toFixed(2)}%  Score: ${(p.score * 100).toFixed(1)}\n`;
      }
    }

    return summary;
  }
}

export default new AdaptiveLearner();
