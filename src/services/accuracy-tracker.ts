import predictionRepo from '../database/repositories/predictions.js';
import priceRepo from '../database/repositories/prices.js';
import { calculateSingleMAPE, interpretMAPE } from '../models/utils/mape.js';
import { Prediction, AccuracyResult, AccuracySummary, Direction, FormulaType } from '../types/index.js';

export interface EvaluationResult {
  prediction: Prediction;
  startPrice: number;       // Price when prediction was made
  actualPrice: number;      // Price at target time
  predictedPrice: number;   // What we predicted
  actualDirection: Direction;
  mape: number;
  isDirectionCorrect: boolean;
  interpretation: string;
}

export class AccuracyTracker {
  /**
   * Evaluate all pending predictions
   */
  async evaluatePending(): Promise<EvaluationResult[]> {
    const pending = predictionRepo.getPendingEvaluations();
    const results: EvaluationResult[] = [];

    for (const prediction of pending) {
      try {
        const result = await this.evaluatePrediction(prediction);
        if (result) {
          results.push(result);
        }
      } catch (error) {
        console.error(`Failed to evaluate prediction ${prediction.id}:`, error);
      }
    }

    return results;
  }

  /**
   * Evaluate a single prediction
   */
  async evaluatePrediction(prediction: Prediction): Promise<EvaluationResult | null> {
    // Get actual price at target timestamp
    const actualPriceRecord = priceRepo.getPriceAtTimestamp(
      prediction.symbol,
      prediction.target_timestamp
    );

    if (!actualPriceRecord) {
      return null; // No price data available yet
    }

    const actualPrice = actualPriceRecord.close;

    // Get price at prediction time to determine actual direction
    const predictionTimePrice = priceRepo.getPriceAtTimestamp(
      prediction.symbol,
      prediction.timestamp
    );

    if (!predictionTimePrice) {
      return null;
    }

    // Calculate actual direction
    const priceDiff = actualPrice - predictionTimePrice.close;
    const threshold = predictionTimePrice.close * 0.001;

    let actualDirection: Direction = 'neutral';
    if (priceDiff > threshold) {
      actualDirection = 'up';
    } else if (priceDiff < -threshold) {
      actualDirection = 'down';
    }

    // Calculate MAPE
    const mape = calculateSingleMAPE(actualPrice, prediction.predicted_price);
    const interpretation = interpretMAPE(mape);

    // Check if direction was correct
    // NEUTRAL predictions are NOT counted as meaningful HITs
    // Only UP/DOWN predictions that match actual direction are HITs
    const isDirectionCorrect =
      prediction.predicted_direction !== 'neutral' &&
      prediction.predicted_direction === actualDirection;

    // Save accuracy result
    const accuracyResult: AccuracyResult = {
      prediction_id: prediction.id!,
      actual_price: actualPrice,
      actual_direction: actualDirection,
      mape,
      is_direction_correct: isDirectionCorrect ? 1 : 0,
    };

    predictionRepo.insertAccuracyResult(accuracyResult);

    return {
      prediction,
      startPrice: predictionTimePrice.close,
      actualPrice,
      predictedPrice: prediction.predicted_price,
      actualDirection,
      mape,
      isDirectionCorrect,
      interpretation,
    };
  }

  /**
   * Get accuracy summary for a symbol
   */
  getSummary(symbol?: string, formulaType?: FormulaType): AccuracySummary[] {
    return predictionRepo.getAccuracySummary(symbol, formulaType);
  }

  /**
   * Get comparison statistics between formulas
   */
  getFormulaComparison(): {
    formulaType: FormulaType;
    total: number;
    correct: number;
    accuracy: number;
    avgMape: number;
    interpretation: string;
  }[] {
    const stats = predictionRepo.getComparisonStats();

    return stats.map((s) => ({
      formulaType: s.formula_type,
      total: s.total,
      correct: s.correct,
      accuracy: s.total > 0 ? (s.correct / s.total) * 100 : 0,
      avgMape: s.avg_mape,
      interpretation: interpretMAPE(s.avg_mape),
    }));
  }

  /**
   * Get detailed accuracy results
   */
  getResults(symbol?: string, formulaType?: FormulaType): AccuracyResult[] {
    return predictionRepo.getAccuracyResults(symbol, formulaType);
  }
}

export default new AccuracyTracker();
