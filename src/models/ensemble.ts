/**
 * Ensemble Model - Combines multiple prediction methods
 *
 * Methods:
 * 1. ARIMAX (with optimized parameters)
 * 2. ARIMAX + Sentiment
 * 3. LSTM Neural Network
 * 4. Technical Indicators
 *
 * Voting strategies:
 * - Weighted average for price
 * - Majority vote for direction
 * - Combined confidence
 */

import { PriceRecord, Direction, PredictionResult } from '../types/index.js';
import ArimaxModel from './arimax.js';
import ArimaxSentimentModel, { SentimentData } from './arimax-sentiment.js';
import lstmModel from './lstm.js';
import technicalIndicators from './technical-indicators.js';

export interface EnsemblePrediction {
  predictedPrice: number;
  direction: Direction;
  confidence: number;
  components: {
    arimax: { price: number; direction: Direction; weight: number };
    arimaxSentiment?: { price: number; direction: Direction; weight: number };
    lstm: { price: number; direction: Direction; weight: number };
    technical: { price: number; direction: Direction; weight: number };
  };
  votes: { up: number; down: number; neutral: number };
}

export interface ModelWeights {
  arimax: number;
  arimaxSentiment: number;
  lstm: number;
  technical: number;
}

export class EnsembleModel {
  private arimaxModel: ArimaxModel;
  private arimaxSentimentModel: ArimaxSentimentModel;
  private weights: ModelWeights;

  constructor(weights?: Partial<ModelWeights>) {
    // Optimized ARIMAX with p=7 (more lag terms)
    this.arimaxModel = new ArimaxModel(7);
    this.arimaxSentimentModel = new ArimaxSentimentModel(7);

    // Default weights (can be tuned based on historical accuracy)
    this.weights = {
      arimax: weights?.arimax ?? 0.25,
      arimaxSentiment: weights?.arimaxSentiment ?? 0.25,
      lstm: weights?.lstm ?? 0.30,
      technical: weights?.technical ?? 0.20,
    };
  }

  /**
   * Set model weights
   */
  setWeights(weights: Partial<ModelWeights>): void {
    this.weights = { ...this.weights, ...weights };

    // Normalize weights to sum to 1
    const total = Object.values(this.weights).reduce((a, b) => a + b, 0);
    for (const key of Object.keys(this.weights) as (keyof ModelWeights)[]) {
      this.weights[key] /= total;
    }
  }

  /**
   * Update weights based on historical accuracy
   */
  updateWeightsFromAccuracy(accuracyByModel: Record<string, number>): void {
    const total = Object.values(accuracyByModel).reduce((a, b) => a + b, 0.001);

    if (accuracyByModel.arimax !== undefined) {
      this.weights.arimax = accuracyByModel.arimax / total;
    }
    if (accuracyByModel.arimaxSentiment !== undefined) {
      this.weights.arimaxSentiment = accuracyByModel.arimaxSentiment / total;
    }
    if (accuracyByModel.lstm !== undefined) {
      this.weights.lstm = accuracyByModel.lstm / total;
    }
    if (accuracyByModel.technical !== undefined) {
      this.weights.technical = accuracyByModel.technical / total;
    }
  }

  /**
   * Make ensemble prediction
   */
  predict(prices: PriceRecord[], intervalMinutes: number = 15, sentiment?: SentimentData): EnsemblePrediction {
    const currentPrice = prices.sort((a, b) => b.timestamp - a.timestamp)[0].close;

    // Get predictions from each model
    const arimaxResult = this.arimaxModel.predict(prices);
    const lstmResult = lstmModel.predict(prices, intervalMinutes);
    const technicalResult = technicalIndicators.predictPrice(prices, intervalMinutes);

    let arimaxSentimentResult: PredictionResult | undefined;
    let useSentiment = false;

    if (sentiment && sentiment.tweetCount > 0) {
      this.arimaxSentimentModel.setSentiment(sentiment);
      arimaxSentimentResult = this.arimaxSentimentModel.predictWithSentiment(prices, sentiment);
      useSentiment = true;
    }

    // Collect all predictions
    const predictions = [
      { model: 'arimax', price: arimaxResult.predictedPrice, direction: arimaxResult.direction, weight: this.weights.arimax },
      { model: 'lstm', price: lstmResult.predictedPrice, direction: lstmResult.direction, weight: this.weights.lstm },
      { model: 'technical', price: technicalResult.price, direction: technicalResult.direction, weight: this.weights.technical },
    ];

    if (useSentiment && arimaxSentimentResult) {
      predictions.push({
        model: 'arimaxSentiment',
        price: arimaxSentimentResult.predictedPrice,
        direction: arimaxSentimentResult.direction,
        weight: this.weights.arimaxSentiment,
      });
    } else {
      // Redistribute sentiment weight to others
      const redistributeWeight = this.weights.arimaxSentiment / 3;
      predictions[0].weight += redistributeWeight;
      predictions[1].weight += redistributeWeight;
      predictions[2].weight += redistributeWeight;
    }

    // Weighted average for price
    let weightedPrice = 0;
    let totalWeight = 0;
    for (const pred of predictions) {
      weightedPrice += pred.price * pred.weight;
      totalWeight += pred.weight;
    }
    const predictedPrice = weightedPrice / totalWeight;

    // Vote on direction
    const votes = { up: 0, down: 0, neutral: 0 };
    for (const pred of predictions) {
      votes[pred.direction] += pred.weight;
    }

    // Determine final direction
    let direction: Direction = 'neutral';
    if (votes.up > votes.down && votes.up > votes.neutral) {
      direction = 'up';
    } else if (votes.down > votes.up && votes.down > votes.neutral) {
      direction = 'down';
    }

    // Calculate confidence
    const maxVote = Math.max(votes.up, votes.down, votes.neutral);
    const confidence = maxVote / totalWeight;

    // Build components
    const components: EnsemblePrediction['components'] = {
      arimax: {
        price: arimaxResult.predictedPrice,
        direction: arimaxResult.direction,
        weight: this.weights.arimax,
      },
      lstm: {
        price: lstmResult.predictedPrice,
        direction: lstmResult.direction,
        weight: this.weights.lstm,
      },
      technical: {
        price: technicalResult.price,
        direction: technicalResult.direction,
        weight: this.weights.technical,
      },
    };

    if (useSentiment && arimaxSentimentResult) {
      components.arimaxSentiment = {
        price: arimaxSentimentResult.predictedPrice,
        direction: arimaxSentimentResult.direction,
        weight: this.weights.arimaxSentiment,
      };
    }

    return {
      predictedPrice,
      direction,
      confidence,
      components,
      votes,
    };
  }

  /**
   * Get current weights
   */
  getWeights(): ModelWeights {
    return { ...this.weights };
  }
}

export default new EnsembleModel();
