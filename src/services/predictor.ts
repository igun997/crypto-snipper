import ArimaxModel from '../models/arimax.js';
import ArimaxSentimentModel from '../models/arimax-sentiment.js';
import ensembleModel, { EnsemblePrediction } from '../models/ensemble.js';
import technicalIndicators from '../models/technical-indicators.js';
import lstmModel from '../models/lstm.js';
import sentimentFetcher from './sentiment-fetcher.js';
import predictionRepo from '../database/repositories/predictions.js';
import priceRepo from '../database/repositories/prices.js';
import { Prediction, FormulaType, PriceRecord } from '../types/index.js';

export interface PredictorResult {
  symbol: string;
  formulaType: FormulaType;
  prediction: Prediction;
  currentPrice: number;
  ensembleDetails?: EnsemblePrediction;
}

export class Predictor {
  private arimaxModel: ArimaxModel;
  private sentimentModel: ArimaxSentimentModel;

  constructor() {
    // Use auto-tuning enabled ARIMAX with higher lag order
    this.arimaxModel = new ArimaxModel(7, true);
    this.sentimentModel = new ArimaxSentimentModel(7);
  }

  /**
   * Run prediction for a symbol using specified formula
   */
  async predict(
    symbol: string,
    formulaType: FormulaType,
    intervalMinutes: number = 15
  ): Promise<PredictorResult> {
    // Get historical prices
    const prices = priceRepo.getLatestPrices(symbol, 200);

    if (prices.length < 20) {
      throw new Error(`Insufficient data for ${symbol}. Need at least 20 price points.`);
    }

    // Sort ascending for model
    const sortedPrices = [...prices].sort((a, b) => a.timestamp - b.timestamp);
    const currentPrice = sortedPrices[sortedPrices.length - 1].close;

    // Fit model
    if (formulaType === 'arimax') {
      this.arimaxModel.fit(sortedPrices);
    } else {
      this.sentimentModel.fit(sortedPrices);
    }

    // Get prediction
    let result;
    if (formulaType === 'arimax') {
      result = this.arimaxModel.predict(sortedPrices);
    } else {
      // Fetch sentiment data
      const sentiment = await sentimentFetcher.getSentiment(symbol);
      this.sentimentModel.setSentiment(sentiment);
      result = this.sentimentModel.predictWithSentiment(sortedPrices, sentiment);
    }

    const now = Date.now();
    const targetTimestamp = now + intervalMinutes * 60 * 1000;

    // Create prediction record
    const prediction: Prediction = {
      symbol,
      formula_type: formulaType,
      predicted_price: result.predictedPrice,
      predicted_direction: result.direction,
      confidence: result.confidence,
      interval_minutes: intervalMinutes,
      timestamp: now,
      target_timestamp: targetTimestamp,
    };

    // Save to database
    const id = predictionRepo.insertPrediction(prediction);
    prediction.id = id;

    return {
      symbol,
      formulaType,
      prediction,
      currentPrice,
    };
  }

  /**
   * Run predictions using both formulas
   */
  async predictBoth(symbol: string, intervalMinutes: number = 15): Promise<PredictorResult[]> {
    const results: PredictorResult[] = [];

    results.push(await this.predict(symbol, 'arimax', intervalMinutes));
    results.push(await this.predict(symbol, 'arimax_sentiment', intervalMinutes));

    return results;
  }

  /**
   * Run predictions for multiple symbols
   */
  async predictMultiple(
    symbols: string[],
    formulaType: FormulaType | 'both',
    intervalMinutes: number = 15
  ): Promise<PredictorResult[]> {
    const results: PredictorResult[] = [];

    for (const symbol of symbols) {
      try {
        if (formulaType === 'both') {
          results.push(...(await this.predictBoth(symbol, intervalMinutes)));
        } else {
          results.push(await this.predict(symbol, formulaType, intervalMinutes));
        }
      } catch (error) {
        console.error(`Failed to predict ${symbol}:`, error);
      }
    }

    return results;
  }

  /**
   * Run ensemble prediction combining all models
   */
  async predictEnsemble(symbol: string, intervalMinutes: number = 15): Promise<PredictorResult> {
    const prices = priceRepo.getLatestPrices(symbol, 200);

    if (prices.length < 30) {
      throw new Error(`Insufficient data for ${symbol}. Need at least 30 price points for ensemble.`);
    }

    const sortedPrices = [...prices].sort((a, b) => a.timestamp - b.timestamp);
    const currentPrice = sortedPrices[sortedPrices.length - 1].close;

    // Fetch sentiment
    const sentiment = await sentimentFetcher.getSentiment(symbol);

    // Get ensemble prediction
    const ensembleResult = ensembleModel.predict(sortedPrices, intervalMinutes, sentiment);

    const now = Date.now();
    const targetTimestamp = now + intervalMinutes * 60 * 1000;

    const prediction: Prediction = {
      symbol,
      formula_type: 'ensemble',
      predicted_price: ensembleResult.predictedPrice,
      predicted_direction: ensembleResult.direction,
      confidence: ensembleResult.confidence,
      interval_minutes: intervalMinutes,
      timestamp: now,
      target_timestamp: targetTimestamp,
    };

    const id = predictionRepo.insertPrediction(prediction);
    prediction.id = id;

    return {
      symbol,
      formulaType: 'ensemble',
      prediction,
      currentPrice,
      ensembleDetails: ensembleResult,
    };
  }

  /**
   * Run all prediction methods including ensemble
   */
  async predictAll(symbol: string, intervalMinutes: number = 15): Promise<PredictorResult[]> {
    const results: PredictorResult[] = [];

    results.push(await this.predict(symbol, 'arimax', intervalMinutes));
    results.push(await this.predict(symbol, 'arimax_sentiment', intervalMinutes));
    results.push(await this.predictEnsemble(symbol, intervalMinutes));

    return results;
  }

  /**
   * Run technical indicators only prediction
   */
  async predictTechnical(symbol: string, intervalMinutes: number = 15): Promise<PredictorResult> {
    const prices = priceRepo.getLatestPrices(symbol, 200);

    if (prices.length < 30) {
      throw new Error(`Insufficient data for ${symbol}. Need at least 30 price points.`);
    }

    const sortedPrices = [...prices].sort((a, b) => a.timestamp - b.timestamp);
    const currentPrice = sortedPrices[sortedPrices.length - 1].close;

    // Get technical prediction
    const techResult = technicalIndicators.predictPrice(sortedPrices, intervalMinutes);
    const signals = technicalIndicators.calculate(sortedPrices);

    const now = Date.now();
    const targetTimestamp = now + intervalMinutes * 60 * 1000;

    const prediction: Prediction = {
      symbol,
      formula_type: 'technical',
      predicted_price: techResult.price,
      predicted_direction: techResult.direction,
      confidence: techResult.confidence,
      interval_minutes: intervalMinutes,
      timestamp: now,
      target_timestamp: targetTimestamp,
    };

    const id = predictionRepo.insertPrediction(prediction);
    prediction.id = id;

    return {
      symbol,
      formulaType: 'technical',
      prediction,
      currentPrice,
    };
  }

  /**
   * Run predictions by formula type
   */
  async predictByFormula(
    symbol: string,
    formula: 'arimax' | 'sentiment' | 'technical' | 'ensemble' | 'all',
    intervalMinutes: number = 15
  ): Promise<PredictorResult[]> {
    switch (formula) {
      case 'arimax':
        return [await this.predict(symbol, 'arimax', intervalMinutes)];
      case 'sentiment':
        return [await this.predict(symbol, 'arimax_sentiment', intervalMinutes)];
      case 'technical':
        return [await this.predictTechnical(symbol, intervalMinutes)];
      case 'ensemble':
        return [await this.predictEnsemble(symbol, intervalMinutes)];
      case 'all':
      default:
        return this.predictAll(symbol, intervalMinutes);
    }
  }

  /**
   * Get recent predictions for a symbol
   */
  getRecentPredictions(symbol: string, limit: number = 50): Prediction[] {
    return predictionRepo.getRecentPredictions(symbol, limit);
  }
}

export default new Predictor();
