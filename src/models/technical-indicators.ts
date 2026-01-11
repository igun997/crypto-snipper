/**
 * Technical Indicators for crypto trading signals
 * Extended with 10+ indicators for better accuracy
 */

import { PriceRecord, Direction } from '../types/index.js';

export interface TechnicalSignals {
  // RSI
  rsi: number;
  rsiSignal: Direction;
  // MACD
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  macdDirection: Direction;
  // Bollinger Bands
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  bollingerSignal: Direction;
  // Moving Averages
  ema12: number;
  ema26: number;
  sma20: number;
  sma50: number;
  // Stochastic
  stochK: number;
  stochD: number;
  stochSignal: Direction;
  // ADX (trend strength)
  adx: number;
  adxSignal: Direction;
  // CCI
  cci: number;
  cciSignal: Direction;
  // Williams %R
  williamsR: number;
  williamsSignal: Direction;
  // OBV trend
  obvTrend: Direction;
  // ATR (volatility)
  atr: number;
  // EMA Crossover
  emaCrossSignal: Direction;
  // Momentum
  momentum: number;
  momentumSignal: Direction;
  // Overall
  overallSignal: Direction;
  confidence: number;
  buySignals: number;
  sellSignals: number;
  neutralSignals: number;
}

export class TechnicalIndicators {
  /**
   * Calculate all technical indicators
   */
  calculate(prices: PriceRecord[]): TechnicalSignals {
    const sorted = [...prices].sort((a, b) => a.timestamp - b.timestamp);
    const closes = sorted.map((p) => p.close);
    const highs = sorted.map((p) => p.high);
    const lows = sorted.map((p) => p.low);
    const volumes = sorted.map((p) => p.volume);

    if (closes.length < 50) {
      throw new Error('Need at least 50 price points for full technical analysis');
    }

    // RSI
    const rsi = this.calculateRSI(closes, 14);
    const rsiSignal = this.interpretRSI(rsi);

    // Moving Averages
    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    const sma20 = this.calculateSMA(closes, 20);
    const sma50 = this.calculateSMA(closes, 50);

    // MACD
    const { macd, signal: macdSignal, histogram: macdHistogram } = this.calculateMACD(closes);
    const macdDirection = this.interpretMACD(macd, macdSignal, macdHistogram);

    // Bollinger Bands
    const { upper, middle, lower } = this.calculateBollingerBands(closes, 20, 2);
    const currentPrice = closes[closes.length - 1];
    const bollingerSignal = this.interpretBollinger(currentPrice, upper, middle, lower);

    // Stochastic Oscillator
    const { k: stochK, d: stochD } = this.calculateStochastic(highs, lows, closes, 14, 3);
    const stochSignal = this.interpretStochastic(stochK, stochD);

    // ADX
    const adx = this.calculateADX(highs, lows, closes, 14);
    const adxSignal = this.interpretADX(adx, closes);

    // CCI
    const cci = this.calculateCCI(highs, lows, closes, 20);
    const cciSignal = this.interpretCCI(cci);

    // Williams %R
    const williamsR = this.calculateWilliamsR(highs, lows, closes, 14);
    const williamsSignal = this.interpretWilliamsR(williamsR);

    // OBV
    const obvTrend = this.calculateOBVTrend(closes, volumes);

    // ATR
    const atr = this.calculateATR(highs, lows, closes, 14);

    // EMA Crossover (9/21)
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const emaCrossSignal = this.interpretEMACross(ema9, ema21, closes);

    // Momentum (Rate of Change)
    const momentum = this.calculateMomentum(closes, 10);
    const momentumSignal = this.interpretMomentum(momentum);

    // Collect all signals for voting
    const allSignals = [
      rsiSignal,
      macdDirection,
      bollingerSignal,
      stochSignal,
      adxSignal,
      cciSignal,
      williamsSignal,
      obvTrend,
      emaCrossSignal,
      momentumSignal,
    ];

    const { overallSignal, confidence, buySignals, sellSignals, neutralSignals } = this.voteSignals(allSignals);

    return {
      rsi,
      rsiSignal,
      macd,
      macdSignal,
      macdHistogram,
      macdDirection,
      bollingerUpper: upper,
      bollingerMiddle: middle,
      bollingerLower: lower,
      bollingerSignal,
      ema12,
      ema26,
      sma20,
      sma50,
      stochK,
      stochD,
      stochSignal,
      adx,
      adxSignal,
      cci,
      cciSignal,
      williamsR,
      williamsSignal,
      obvTrend,
      atr,
      emaCrossSignal,
      momentum,
      momentumSignal,
      overallSignal,
      confidence,
      buySignals,
      sellSignals,
      neutralSignals,
    };
  }

  /**
   * RSI - Relative Strength Index (0-100)
   * >70 = Overbought, <30 = Oversold
   */
  calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;

    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    const recentChanges = changes.slice(-period);
    let gains = 0;
    let losses = 0;

    for (const change of recentChanges) {
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  interpretRSI(rsi: number): Direction {
    if (rsi > 70) return 'down'; // Overbought
    if (rsi < 30) return 'up'; // Oversold
    return 'neutral';
  }

  /**
   * MACD - Moving Average Convergence Divergence
   */
  calculateMACD(prices: number[]): { macd: number; signal: number; histogram: number } {
    const ema12 = this.calculateEMA(prices, 12);
    const ema26 = this.calculateEMA(prices, 26);
    const macdLine = ema12 - ema26;

    const macdHistory: number[] = [];
    for (let i = 26; i <= prices.length; i++) {
      const slice = prices.slice(0, i);
      const e12 = this.calculateEMA(slice, 12);
      const e26 = this.calculateEMA(slice, 26);
      macdHistory.push(e12 - e26);
    }

    const signalLine = macdHistory.length >= 9 ? this.calculateEMA(macdHistory, 9) : macdLine;
    const histogram = macdLine - signalLine;

    return { macd: macdLine, signal: signalLine, histogram };
  }

  interpretMACD(macd: number, signal: number, histogram: number): Direction {
    if (histogram > 0 && macd > signal) return 'up';
    if (histogram < 0 && macd < signal) return 'down';
    return 'neutral';
  }

  /**
   * Bollinger Bands
   */
  calculateBollingerBands(
    prices: number[],
    period: number = 20,
    stdDev: number = 2
  ): { upper: number; middle: number; lower: number } {
    const sma = this.calculateSMA(prices, period);
    const recentPrices = prices.slice(-period);

    const variance =
      recentPrices.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
    const sd = Math.sqrt(variance);

    return {
      upper: sma + stdDev * sd,
      middle: sma,
      lower: sma - stdDev * sd,
    };
  }

  interpretBollinger(currentPrice: number, upper: number, middle: number, lower: number): Direction {
    const range = upper - lower;
    const position = (currentPrice - lower) / range;

    if (position > 0.8) return 'down'; // Near upper = overbought
    if (position < 0.2) return 'up'; // Near lower = oversold
    return 'neutral';
  }

  /**
   * Stochastic Oscillator (%K and %D)
   * >80 = Overbought, <20 = Oversold
   */
  calculateStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number = 14,
    smoothK: number = 3
  ): { k: number; d: number } {
    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    const highestHigh = Math.max(...recentHighs);
    const lowestLow = Math.min(...recentLows);
    const currentClose = closes[closes.length - 1];

    const rawK = ((currentClose - lowestLow) / (highestHigh - lowestLow || 1)) * 100;

    // Calculate %K values for smoothing
    const kValues: number[] = [];
    for (let i = period; i <= closes.length; i++) {
      const h = highs.slice(i - period, i);
      const l = lows.slice(i - period, i);
      const c = closes[i - 1];
      const hh = Math.max(...h);
      const ll = Math.min(...l);
      kValues.push(((c - ll) / (hh - ll || 1)) * 100);
    }

    const k = this.calculateSMA(kValues, smoothK);
    const d = this.calculateSMA(kValues.slice(-smoothK * 2), smoothK);

    return { k, d };
  }

  interpretStochastic(k: number, d: number): Direction {
    if (k > 80 && d > 80) return 'down'; // Overbought
    if (k < 20 && d < 20) return 'up'; // Oversold
    if (k > d && k < 80) return 'up'; // Bullish crossover
    if (k < d && k > 20) return 'down'; // Bearish crossover
    return 'neutral';
  }

  /**
   * ADX - Average Directional Index (trend strength)
   * >25 = Strong trend, <20 = Weak/no trend
   */
  calculateADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 0;

    const trueRanges: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 1; i < closes.length; i++) {
      const high = highs[i];
      const low = lows[i];
      const prevHigh = highs[i - 1];
      const prevLow = lows[i - 1];
      const prevClose = closes[i - 1];

      // True Range
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);

      // Directional Movement
      const upMove = high - prevHigh;
      const downMove = prevLow - low;

      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const atr = this.calculateEMA(trueRanges, period);
    const smoothPlusDM = this.calculateEMA(plusDM, period);
    const smoothMinusDM = this.calculateEMA(minusDM, period);

    const plusDI = (smoothPlusDM / atr) * 100;
    const minusDI = (smoothMinusDM / atr) * 100;

    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1)) * 100;

    return dx;
  }

  interpretADX(adx: number, closes: number[]): Direction {
    // ADX shows trend strength, not direction
    // Use price movement to determine direction when trend is strong
    if (adx < 20) return 'neutral'; // Weak trend

    const recentChange = closes[closes.length - 1] - closes[closes.length - 5];
    if (adx > 25) {
      return recentChange > 0 ? 'up' : 'down';
    }
    return 'neutral';
  }

  /**
   * CCI - Commodity Channel Index
   * >100 = Overbought, <-100 = Oversold
   */
  calculateCCI(highs: number[], lows: number[], closes: number[], period: number = 20): number {
    const typicalPrices: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      typicalPrices.push((highs[i] + lows[i] + closes[i]) / 3);
    }

    const smaTP = this.calculateSMA(typicalPrices, period);
    const recentTP = typicalPrices.slice(-period);

    // Mean deviation
    const meanDev = recentTP.reduce((sum, tp) => sum + Math.abs(tp - smaTP), 0) / period;

    const currentTP = typicalPrices[typicalPrices.length - 1];
    return (currentTP - smaTP) / (0.015 * meanDev || 1);
  }

  interpretCCI(cci: number): Direction {
    if (cci > 100) return 'down'; // Overbought
    if (cci < -100) return 'up'; // Oversold
    if (cci > 0) return 'up'; // Bullish
    if (cci < 0) return 'down'; // Bearish
    return 'neutral';
  }

  /**
   * Williams %R (-100 to 0)
   * >-20 = Overbought, <-80 = Oversold
   */
  calculateWilliamsR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    const highestHigh = Math.max(...recentHighs);
    const lowestLow = Math.min(...recentLows);
    const currentClose = closes[closes.length - 1];

    return ((highestHigh - currentClose) / (highestHigh - lowestLow || 1)) * -100;
  }

  interpretWilliamsR(wr: number): Direction {
    if (wr > -20) return 'down'; // Overbought
    if (wr < -80) return 'up'; // Oversold
    return 'neutral';
  }

  /**
   * OBV - On-Balance Volume trend
   */
  calculateOBVTrend(closes: number[], volumes: number[]): Direction {
    let obv = 0;
    const obvValues: number[] = [0];

    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1]) {
        obv += volumes[i];
      } else if (closes[i] < closes[i - 1]) {
        obv -= volumes[i];
      }
      obvValues.push(obv);
    }

    // Compare recent OBV trend
    const recentOBV = obvValues.slice(-10);
    const obvSMA = this.calculateSMA(recentOBV, 5);
    const currentOBV = obvValues[obvValues.length - 1];

    if (currentOBV > obvSMA * 1.02) return 'up';
    if (currentOBV < obvSMA * 0.98) return 'down';
    return 'neutral';
  }

  /**
   * ATR - Average True Range (volatility measure)
   */
  calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    const trueRanges: number[] = [];

    for (let i = 1; i < closes.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trueRanges.push(tr);
    }

    return this.calculateEMA(trueRanges, period);
  }

  /**
   * EMA Crossover (9/21)
   */
  interpretEMACross(ema9: number, ema21: number, closes: number[]): Direction {
    // Calculate previous EMAs for crossover detection
    const prevCloses = closes.slice(0, -1);
    const prevEma9 = this.calculateEMA(prevCloses, 9);
    const prevEma21 = this.calculateEMA(prevCloses, 21);

    // Golden cross (9 crosses above 21)
    if (prevEma9 <= prevEma21 && ema9 > ema21) return 'up';
    // Death cross (9 crosses below 21)
    if (prevEma9 >= prevEma21 && ema9 < ema21) return 'down';
    // Trend continuation
    if (ema9 > ema21) return 'up';
    if (ema9 < ema21) return 'down';
    return 'neutral';
  }

  /**
   * Momentum (Rate of Change)
   */
  calculateMomentum(prices: number[], period: number = 10): number {
    if (prices.length < period) return 0;
    const current = prices[prices.length - 1];
    const past = prices[prices.length - period - 1];
    return ((current - past) / past) * 100;
  }

  interpretMomentum(momentum: number): Direction {
    if (momentum > 2) return 'up'; // Strong upward momentum
    if (momentum < -2) return 'down'; // Strong downward momentum
    if (momentum > 0.5) return 'up'; // Slight bullish
    if (momentum < -0.5) return 'down'; // Slight bearish
    return 'neutral';
  }

  /**
   * EMA - Exponential Moving Average
   */
  calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1];

    const multiplier = 2 / (period + 1);
    let ema = this.calculateSMA(prices.slice(0, period), period);

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * SMA - Simple Moving Average
   */
  calculateSMA(prices: number[], period: number): number {
    const slice = prices.slice(-period);
    return slice.reduce((sum, p) => sum + p, 0) / slice.length;
  }

  /**
   * Vote on signals to get overall direction
   */
  private voteSignals(signals: Direction[]): {
    overallSignal: Direction;
    confidence: number;
    buySignals: number;
    sellSignals: number;
    neutralSignals: number;
  } {
    const counts = { up: 0, down: 0, neutral: 0 };

    for (const signal of signals) {
      counts[signal]++;
    }

    const total = signals.length;
    let overallSignal: Direction = 'neutral';
    let maxCount = counts.neutral;

    // Need clear majority for directional signal
    if (counts.up > counts.down && counts.up > counts.neutral) {
      overallSignal = 'up';
      maxCount = counts.up;
    } else if (counts.down > counts.up && counts.down > counts.neutral) {
      overallSignal = 'down';
      maxCount = counts.down;
    }

    const confidence = maxCount / total;

    return {
      overallSignal,
      confidence,
      buySignals: counts.up,
      sellSignals: counts.down,
      neutralSignals: counts.neutral,
    };
  }

  /**
   * Predict next price using technical analysis
   */
  predictPrice(prices: PriceRecord[], intervalMinutes: number): { price: number; direction: Direction; confidence: number } {
    const signals = this.calculate(prices);
    const currentPrice = prices.sort((a, b) => b.timestamp - a.timestamp)[0].close;

    let changePercent = 0;

    // RSI contribution (weight: 1.5)
    if (signals.rsi > 70) changePercent -= 0.75;
    else if (signals.rsi < 30) changePercent += 0.75;
    else changePercent += (50 - signals.rsi) * 0.015;

    // MACD contribution (weight: 1.5)
    if (signals.macdHistogram > 0) changePercent += 0.45;
    else if (signals.macdHistogram < 0) changePercent -= 0.45;

    // Bollinger contribution (weight: 1)
    const bollingerRange = signals.bollingerUpper - signals.bollingerLower;
    const bollingerPosition = (currentPrice - signals.bollingerLower) / bollingerRange;
    changePercent += (0.5 - bollingerPosition) * 0.5;

    // Stochastic contribution (weight: 1)
    if (signals.stochK > 80) changePercent -= 0.3;
    else if (signals.stochK < 20) changePercent += 0.3;

    // CCI contribution (weight: 0.5)
    if (signals.cci > 100) changePercent -= 0.2;
    else if (signals.cci < -100) changePercent += 0.2;

    // Momentum contribution (weight: 1)
    changePercent += signals.momentum * 0.1;

    // EMA crossover contribution (weight: 1)
    if (signals.emaCrossSignal === 'up') changePercent += 0.3;
    else if (signals.emaCrossSignal === 'down') changePercent -= 0.3;

    // Scale by interval
    const intervalScale = Math.sqrt(intervalMinutes / 15);
    changePercent *= intervalScale;

    const predictedPrice = currentPrice * (1 + changePercent / 100);

    return {
      price: predictedPrice,
      direction: signals.overallSignal,
      confidence: signals.confidence,
    };
  }
}

export default new TechnicalIndicators();
