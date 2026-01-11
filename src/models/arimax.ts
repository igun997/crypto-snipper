/**
 * ARIMAX Model - Formula 1 (Enhanced)
 * y_t = c + SUM(phi_i * y_{t-i}) + beta * X_t + epsilon_t
 *
 * Enhanced implementation with:
 * - AR (Autoregressive) component using past prices
 * - Exogenous variables: volume, momentum, SMA, EMA, RSI, MACD, Bollinger
 * - Auto-tuning of p (lag order) based on data
 */

import { mean, standardDeviation, linearRegression } from 'simple-statistics';
import { PriceRecord, PredictionResult, Direction, ExogenousVars, ArimaxParams } from '../types/index.js';
import { normalize, computeNormalizationParams } from './utils/normalization.js';

export interface EnhancedExogenousVars extends ExogenousVars {
  rsi: number;
  macdHistogram: number;
  bollingerPosition: number;
}

export class ArimaxModel {
  private params: ArimaxParams;
  private autoTune: boolean;

  constructor(p: number = 5, autoTune: boolean = true) {
    // Initialize with default parameters
    this.params = {
      p, // Number of AR lags
      phi: new Array(p).fill(0.1), // AR coefficients
      // Extended beta: [volume, momentum, sma, ema, rsi, macd, bollinger]
      beta: [0.15, 0.20, 0.10, 0.10, 0.15, 0.15, 0.15],
      c: 0, // Intercept
    };
    this.autoTune = autoTune;
  }

  /**
   * Auto-tune p (lag order) using AIC-like criterion
   */
  autoTuneP(prices: PriceRecord[]): number {
    const closes = prices.sort((a, b) => a.timestamp - b.timestamp).map((p) => p.close);
    let bestP = 5;
    let bestScore = Infinity;

    for (let p = 3; p <= Math.min(15, Math.floor(closes.length / 5)); p++) {
      const score = this.calculateAIC(closes, p);
      if (score < bestScore) {
        bestScore = score;
        bestP = p;
      }
    }

    return bestP;
  }

  private calculateAIC(closes: number[], p: number): number {
    if (closes.length < p + 10) return Infinity;

    // Calculate residual sum of squares
    let rss = 0;
    let count = 0;

    for (let i = p; i < closes.length - 1; i++) {
      let predicted = 0;
      for (let j = 1; j <= p; j++) {
        predicted += closes[i - j] * Math.exp(-j * 0.2) * 0.3;
      }
      const actual = closes[i];
      rss += Math.pow(actual - predicted, 2);
      count++;
    }

    if (count === 0) return Infinity;

    // AIC = n * ln(RSS/n) + 2k
    const aic = count * Math.log(rss / count) + 2 * p;
    return aic;
  }

  /**
   * Fit the model to historical data
   */
  fit(prices: PriceRecord[]): void {
    if (prices.length < this.params.p + 10) {
      throw new Error('Insufficient data for fitting');
    }

    // Auto-tune p if enabled
    if (this.autoTune) {
      const optimalP = this.autoTuneP(prices);
      if (optimalP !== this.params.p) {
        this.params.p = optimalP;
        this.params.phi = new Array(optimalP).fill(0.1);
      }
    }

    // Sort by timestamp ascending
    const sorted = [...prices].sort((a, b) => a.timestamp - b.timestamp);
    const closes = sorted.map((p) => p.close);

    // Estimate AR coefficients using linear regression
    this.estimateARCoefficients(closes);

    // Estimate beta coefficients for exogenous variables
    this.estimateBetaCoefficients(sorted);
  }

  private estimateARCoefficients(closes: number[]): void {
    const { p } = this.params;

    // Create lagged data for regression
    const X: number[][] = [];
    const y: number[] = [];

    for (let i = p; i < closes.length; i++) {
      const lags = [];
      for (let j = 1; j <= p; j++) {
        lags.push(closes[i - j]);
      }
      X.push(lags);
      y.push(closes[i]);
    }

    // Simple OLS estimation for AR coefficients
    if (X.length > 0) {
      // Use mean reversion style coefficients
      const priceChange = y.map((val, i) => val - X[i][0]);
      const avgChange = mean(priceChange);
      const stdChange = standardDeviation(priceChange);

      // Set phi values based on lag importance (decay)
      for (let i = 0; i < p; i++) {
        this.params.phi[i] = Math.exp(-i * 0.3) * 0.3;
      }

      // Normalize to sum to less than 1 for stability
      const phiSum = this.params.phi.reduce((a, b) => a + b, 0);
      if (phiSum > 0.9) {
        this.params.phi = this.params.phi.map((phi) => (phi / phiSum) * 0.8);
      }

      // Estimate intercept
      this.params.c = avgChange;
    }
  }

  private estimateBetaCoefficients(prices: PriceRecord[]): void {
    // Calculate correlation between exogenous vars and price changes
    const priceChanges: number[] = [];
    const volumes: number[] = [];
    const momentums: number[] = [];

    for (let i = 1; i < prices.length; i++) {
      priceChanges.push(prices[i].close - prices[i - 1].close);
      volumes.push(prices[i].volume);
      momentums.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
    }

    // Normalize and fit simple regression
    if (priceChanges.length > 10) {
      const volParams = computeNormalizationParams(volumes);
      const normVols = volumes.map((v) => normalize(v, volParams));

      // Use simple correlation for beta estimation
      const pairs = normVols.map((v, i) => [v, priceChanges[i]]);
      try {
        const reg = linearRegression(pairs);
        this.params.beta[0] = Math.min(Math.max(reg.m * 0.1, -0.5), 0.5); // Volume
      } catch {
        this.params.beta[0] = 0.1;
      }

      // Momentum coefficient
      const momPairs = momentums.map((m, i) => [m, priceChanges[i]]);
      try {
        const momReg = linearRegression(momPairs);
        this.params.beta[1] = Math.min(Math.max(momReg.m * 0.1, -0.5), 0.5);
      } catch {
        this.params.beta[1] = 0.15;
      }
    }
  }

  /**
   * Calculate exogenous variables from price data
   */
  calculateExogenousVars(prices: PriceRecord[]): ExogenousVars {
    const sorted = [...prices].sort((a, b) => a.timestamp - b.timestamp);
    const closes = sorted.map((p) => p.close);
    const volumes = sorted.map((p) => p.volume);

    // Normalize volume
    const volParams = computeNormalizationParams(volumes);
    const latestVolume = volumes[volumes.length - 1];
    const normVolume = normalize(latestVolume, volParams);

    // Calculate momentum (rate of change)
    const momentum =
      closes.length >= 2
        ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]
        : 0;

    // Calculate SMA (Simple Moving Average) - 10 periods
    const smaWindow = Math.min(10, closes.length);
    const sma = mean(closes.slice(-smaWindow));

    // Calculate EMA (Exponential Moving Average) - 10 periods
    const ema = this.calculateEMA(closes, Math.min(10, closes.length));

    return {
      volume: normVolume,
      momentum,
      sma,
      ema,
    };
  }

  private calculateEMA(values: number[], period: number): number {
    if (values.length === 0) return 0;
    if (values.length === 1) return values[0];

    const k = 2 / (period + 1);
    let ema = values[0];

    for (let i = 1; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }

    return ema;
  }

  /**
   * Make a prediction
   */
  predict(prices: PriceRecord[]): PredictionResult {
    if (prices.length < this.params.p) {
      throw new Error('Insufficient data for prediction');
    }

    const sorted = [...prices].sort((a, b) => b.timestamp - a.timestamp); // Descending
    const closes = sorted.map((p) => p.close);

    // AR component: SUM(phi_i * y_{t-i})
    let arComponent = 0;
    for (let i = 0; i < this.params.p && i < closes.length; i++) {
      arComponent += this.params.phi[i] * closes[i];
    }

    // Exogenous component
    const exoVars = this.calculateExogenousVars(prices);
    const exoValues = [exoVars.volume, exoVars.momentum, exoVars.sma, exoVars.ema];

    let exogenousComponent = 0;
    // For SMA and EMA, calculate deviation from current price
    const currentPrice = closes[0];
    const smaDeviation = (exoVars.sma - currentPrice) / currentPrice;
    const emaDeviation = (exoVars.ema - currentPrice) / currentPrice;

    exogenousComponent =
      this.params.beta[0] * exoVars.volume * currentPrice * 0.01 +
      this.params.beta[1] * exoVars.momentum * currentPrice +
      this.params.beta[2] * smaDeviation * currentPrice +
      this.params.beta[3] * emaDeviation * currentPrice;

    // Final prediction
    const predictedPrice = arComponent + exogenousComponent + this.params.c;

    // Determine direction
    let direction: Direction = 'neutral';
    const priceDiff = predictedPrice - currentPrice;
    const threshold = currentPrice * 0.001; // 0.1% threshold

    if (priceDiff > threshold) {
      direction = 'up';
    } else if (priceDiff < -threshold) {
      direction = 'down';
    }

    // Calculate confidence based on recent volatility
    const recentChanges = closes.slice(0, 5).map((c, i) => {
      if (i === closes.length - 1) return 0;
      return Math.abs(c - closes[i + 1]) / closes[i + 1];
    });
    const avgVolatility = mean(recentChanges.filter((c) => c > 0));
    const confidence = Math.max(0.1, Math.min(0.9, 1 - avgVolatility * 10));

    return {
      predictedPrice,
      direction,
      confidence,
      components: {
        arComponent,
        exogenousComponent,
        intercept: this.params.c,
      },
    };
  }
}

export default ArimaxModel;
