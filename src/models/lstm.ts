/**
 * LSTM-like Neural Network for price prediction
 * Uses synaptic.js for pure JavaScript neural networks
 *
 * Architecture:
 * - Input: Normalized price sequence + technical features
 * - Hidden: LSTM-like recurrent layer
 * - Output: Predicted price change percentage
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import synaptic from 'synaptic';
const { Architect, Trainer } = synaptic as { Architect: { LSTM: new (...args: number[]) => { activate: (input: number[]) => number[] } }; Trainer: new (network: unknown) => { train: (data: Array<{ input: number[]; output: number[] }>, options?: unknown) => void } };

import { PriceRecord, Direction } from '../types/index.js';
import { minMaxNormalize } from './utils/normalization.js';
import technicalIndicators from './technical-indicators.js';

export interface LSTMPrediction {
  predictedPrice: number;
  direction: Direction;
  confidence: number;
  priceChange: number;
}

export class LSTMModel {
  private network: { activate: (input: number[]) => number[] };
  private trainer: { train: (data: Array<{ input: number[]; output: number[] }>, options?: unknown) => void };
  private sequenceLength: number = 10;
  private trained: boolean = false;
  private priceMin: number = 0;
  private priceMax: number = 0;

  constructor() {
    // LSTM network: 5 inputs, 10 hidden units, 1 output
    // Inputs: normalized price, volume, RSI, MACD, Bollinger position
    this.network = new Architect.LSTM(5, 10, 10, 1);
    this.trainer = new Trainer(this.network);
  }

  /**
   * Train the network on historical data
   */
  train(prices: PriceRecord[]): void {
    if (prices.length < this.sequenceLength + 10) {
      console.log('Not enough data to train LSTM');
      return;
    }

    const trainingData = this.prepareTrainingData(prices);

    if (trainingData.length < 5) {
      console.log('Not enough training sequences');
      return;
    }

    // Train with low iterations for speed
    this.trainer.train(trainingData, {
      rate: 0.1,
      iterations: 100,
      error: 0.01,
      shuffle: true,
      log: 0,
    });

    this.trained = true;
  }

  /**
   * Prepare training data from price records
   */
  private prepareTrainingData(prices: PriceRecord[]): Array<{ input: number[]; output: number[] }> {
    const sortedPrices = prices.sort((a, b) => a.timestamp - b.timestamp);
    const closes = sortedPrices.map((p) => p.close);
    const volumes = sortedPrices.map((p) => p.volume);

    // Store min/max for denormalization
    this.priceMin = Math.min(...closes);
    this.priceMax = Math.max(...closes);

    // Normalize
    const normPrices = minMaxNormalize(closes);
    const normVolumes = minMaxNormalize(volumes);

    // Calculate technical indicators for each point
    const features: number[][] = [];
    for (let i = 26; i < sortedPrices.length; i++) {
      try {
        const slice = sortedPrices.slice(0, i + 1);
        const signals = technicalIndicators.calculate(slice);

        features.push([
          normPrices[i],
          normVolumes[i],
          signals.rsi / 100, // Normalize RSI to 0-1
          (signals.macd + 1) / 2, // Normalize MACD roughly to 0-1
          (slice[i].close - signals.bollingerLower) /
            (signals.bollingerUpper - signals.bollingerLower || 1), // Bollinger position 0-1
        ]);
      } catch {
        // Skip if can't calculate indicators
      }
    }

    // Create sequences
    const trainingData: Array<{ input: number[]; output: number[] }> = [];

    for (let i = 0; i < features.length - this.sequenceLength - 1; i++) {
      // Flatten sequence into single input vector
      const input: number[] = [];
      for (let j = 0; j < this.sequenceLength; j++) {
        input.push(...features[i + j]);
      }

      // Output: next price normalized (predict price change)
      const currentIdx = 26 + i + this.sequenceLength - 1;
      const nextIdx = currentIdx + 1;

      if (nextIdx < closes.length) {
        const priceChange = (closes[nextIdx] - closes[currentIdx]) / closes[currentIdx];
        // Normalize price change to 0-1 range (assuming max 10% change)
        const normChange = (priceChange + 0.1) / 0.2;
        trainingData.push({
          input,
          output: [Math.max(0, Math.min(1, normChange))],
        });
      }
    }

    return trainingData;
  }

  /**
   * Predict next price
   */
  predict(prices: PriceRecord[], intervalMinutes: number = 15): LSTMPrediction {
    const sortedPrices = prices.sort((a, b) => a.timestamp - b.timestamp);
    const currentPrice = sortedPrices[sortedPrices.length - 1].close;

    // Auto-train if not trained
    if (!this.trained && prices.length >= this.sequenceLength + 30) {
      this.train(prices);
    }

    // Prepare input features
    const closes = sortedPrices.map((p) => p.close);
    const volumes = sortedPrices.map((p) => p.volume);

    this.priceMin = Math.min(...closes);
    this.priceMax = Math.max(...closes);

    const normPrices = minMaxNormalize(closes);
    const normVolumes = minMaxNormalize(volumes);

    // Get recent features
    const features: number[][] = [];
    const startIdx = Math.max(26, sortedPrices.length - this.sequenceLength);

    for (let i = startIdx; i < sortedPrices.length; i++) {
      try {
        const slice = sortedPrices.slice(0, i + 1);
        const signals = technicalIndicators.calculate(slice);

        features.push([
          normPrices[i],
          normVolumes[i],
          signals.rsi / 100,
          (signals.macd + 1) / 2,
          (slice[i].close - signals.bollingerLower) /
            (signals.bollingerUpper - signals.bollingerLower || 1),
        ]);
      } catch {
        // Fallback features
        features.push([normPrices[i], normVolumes[i], 0.5, 0.5, 0.5]);
      }
    }

    // Pad if needed
    while (features.length < this.sequenceLength) {
      features.unshift(features[0] || [0.5, 0.5, 0.5, 0.5, 0.5]);
    }

    // Flatten to input
    const input: number[] = [];
    for (let j = 0; j < this.sequenceLength; j++) {
      input.push(...features[j]);
    }

    // Get prediction
    const output = this.network.activate(input);
    const normChange = output[0];

    // Denormalize: convert back from 0-1 to price change percentage
    const priceChangePercent = (normChange * 0.2 - 0.1) * 100;

    // Scale by interval
    const intervalScale = Math.sqrt(intervalMinutes / 15);
    const scaledChange = priceChangePercent * intervalScale;

    const predictedPrice = currentPrice * (1 + scaledChange / 100);

    // Determine direction
    let direction: Direction = 'neutral';
    if (scaledChange > 0.1) direction = 'up';
    else if (scaledChange < -0.1) direction = 'down';

    // Confidence based on how extreme the prediction is
    const confidence = Math.min(0.9, 0.5 + Math.abs(scaledChange) / 5);

    return {
      predictedPrice,
      direction,
      confidence,
      priceChange: scaledChange,
    };
  }

  /**
   * Reset and retrain the network
   */
  reset(): void {
    this.network = new Architect.LSTM(5, 10, 10, 1);
    this.trainer = new Trainer(this.network);
    this.trained = false;
  }
}

export default new LSTMModel();
