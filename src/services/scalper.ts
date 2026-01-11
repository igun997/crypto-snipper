/**
 * Scalping Service
 *
 * Detects quick entry/exit signals for scalp trading:
 * - Order book imbalance & walls
 * - Volume spikes
 * - Momentum shifts
 * - Spread analysis
 * - Quick price action patterns
 */

import { EventEmitter } from 'events';
import { Direction, PriceRecord } from '../types/index.js';
import orderBookAnalyzer, { OrderBookAnalysis, Wall } from './orderbook-analyzer.js';
import technicalIndicators from '../models/technical-indicators.js';
import priceRepo from '../database/repositories/prices.js';
import realtimeFetcher, { TradeData } from './realtime-fetcher.js';

export interface ScalpSignal {
  type: 'entry' | 'exit';
  direction: 'long' | 'short';
  symbol: string;
  price: number;
  timestamp: number;

  // Targets
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  riskReward: number;

  // Signal strength
  confidence: number;
  reasons: string[];

  // Market context
  spread: number;
  spreadPercent: number;
  imbalance: number;
  nearestSupport?: number;
  nearestResistance?: number;
}

export interface ScalpConfig {
  // Target percentages
  takeProfitPercent: number;    // Default 0.3% (30 bps)
  stopLossPercent: number;      // Default 0.15% (15 bps)
  minRiskReward: number;        // Minimum R:R ratio (default 1.5)

  // Signal thresholds
  minConfidence: number;        // Minimum confidence to trigger (0-1)
  minImbalance: number;         // Order book imbalance threshold
  volumeSpikeMultiplier: number;// Volume spike detection (x avg)

  // Timing
  cooldownMs: number;           // Cooldown between signals

  // Smart wall exit
  enableWallExit: boolean;      // Auto-exit when wall blocks TP
  minProfitForWallExit: number; // Minimum profit % to trigger wall exit (default 0.1%)
  wallBreakThreshold: number;   // Max break probability to trigger exit (default 0.3)
}

export interface ActiveScalp {
  signal: ScalpSignal;
  status: 'active' | 'tp_hit' | 'sl_hit' | 'manual_exit' | 'expired' | 'wall_exit';
  entryTime: number;
  exitTime?: number;
  exitPrice?: number;
  profitPercent?: number;
  duration?: number;
  exitReason?: string;
}

export interface WallAnalysis {
  hasBlockingWall: boolean;
  wallPrice: number;
  wallStrength: 'weak' | 'medium' | 'strong' | 'massive';
  wallVolume: number;
  distancePercent: number;
  breakProbability: number;  // 0-1, lower = harder to break
  recommendation: 'hold' | 'exit_profit' | 'tighten_tp';
}

const DEFAULT_CONFIG: ScalpConfig = {
  takeProfitPercent: 0.3,
  stopLossPercent: 0.15,
  minRiskReward: 1.5,
  minConfidence: 0.6,
  minImbalance: 0.15,
  volumeSpikeMultiplier: 2.0,
  cooldownMs: 30000, // 30 seconds
  enableWallExit: true,
  minProfitForWallExit: 0.1, // 0.1% minimum profit
  wallBreakThreshold: 0.3,   // Exit if wall has <30% break probability
};

export class Scalper extends EventEmitter {
  private config: ScalpConfig;
  private lastSignalTime: Map<string, number> = new Map();
  private activeScalps: Map<string, ActiveScalp> = new Map();
  private tradeHistory: ActiveScalp[] = [];

  constructor(config: Partial<ScalpConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze market for scalp opportunities
   */
  async analyze(symbol: string, currentPrice: number): Promise<ScalpSignal | null> {
    // Check cooldown
    const lastSignal = this.lastSignalTime.get(symbol) || 0;
    if (Date.now() - lastSignal < this.config.cooldownMs) {
      return null;
    }

    // Check if we have an active scalp
    const activeScalp = this.activeScalps.get(symbol);
    if (activeScalp && activeScalp.status === 'active') {
      // Check if TP or SL hit
      this.checkScalpExit(symbol, currentPrice);
      return null;
    }

    const reasons: string[] = [];
    let longScore = 0;
    let shortScore = 0;

    // 1. Order Book Analysis
    let orderBook: OrderBookAnalysis | null = null;
    try {
      orderBook = await orderBookAnalyzer.analyze(symbol);

      // Imbalance signal
      if (orderBook.imbalance > this.config.minImbalance) {
        longScore += 0.25;
        reasons.push(`Buy pressure: ${(orderBook.imbalance * 100).toFixed(1)}% imbalance`);
      } else if (orderBook.imbalance < -this.config.minImbalance) {
        shortScore += 0.25;
        reasons.push(`Sell pressure: ${(Math.abs(orderBook.imbalance) * 100).toFixed(1)}% imbalance`);
      }

      // Wall proximity signals
      const nearestBuyWall = orderBook.buyWalls.find(w => w.strength !== 'weak');
      const nearestSellWall = orderBook.sellWalls.find(w => w.strength !== 'weak');

      if (nearestBuyWall && Math.abs(nearestBuyWall.percentFromPrice) < 0.5) {
        longScore += 0.2;
        reasons.push(`Near support wall at ${nearestBuyWall.price.toFixed(0)}`);
      }

      if (nearestSellWall && Math.abs(nearestSellWall.percentFromPrice) < 0.5) {
        shortScore += 0.2;
        reasons.push(`Near resistance wall at ${nearestSellWall.price.toFixed(0)}`);
      }

      // Spread check (tight spread = good for scalping)
      if (orderBook.spreadPercent < 0.1) {
        longScore += 0.1;
        shortScore += 0.1;
        reasons.push(`Tight spread: ${orderBook.spreadPercent.toFixed(3)}%`);
      } else if (orderBook.spreadPercent > 0.3) {
        // Wide spread - reduce confidence
        longScore -= 0.15;
        shortScore -= 0.15;
      }

    } catch (err) {
      // Continue without order book data
    }

    // 2. Technical Analysis (fast indicators) - Use combined realtime + historical data
    const prices = this.getLivePrices(symbol, 50);
    if (prices.length >= 20) {
      const indicators = technicalIndicators.calculate(prices);

      // RSI extremes (oversold/overbought)
      if (indicators.rsi < 25) {
        longScore += 0.25;
        reasons.push(`RSI oversold: ${indicators.rsi.toFixed(1)}`);
      } else if (indicators.rsi > 75) {
        shortScore += 0.25;
        reasons.push(`RSI overbought: ${indicators.rsi.toFixed(1)}`);
      }

      // Stochastic crossover
      if (indicators.stochK < 20 && indicators.stochK > indicators.stochD) {
        longScore += 0.2;
        reasons.push('Stochastic bullish crossover');
      } else if (indicators.stochK > 80 && indicators.stochK < indicators.stochD) {
        shortScore += 0.2;
        reasons.push('Stochastic bearish crossover');
      }

      // Momentum
      if (indicators.momentumSignal === 'up') {
        longScore += 0.15;
      } else if (indicators.momentumSignal === 'down') {
        shortScore += 0.15;
      }

      // Bollinger Band touch
      if (indicators.bollingerSignal === 'up') {
        longScore += 0.15;
        reasons.push('Price at lower Bollinger Band');
      } else if (indicators.bollingerSignal === 'down') {
        shortScore += 0.15;
        reasons.push('Price at upper Bollinger Band');
      }
    }

    // 2b. Realtime momentum from recent trades (very fast signals)
    const realtimeMomentum = this.analyzeRealtimeMomentum(symbol);
    if (realtimeMomentum.signal === 'long') {
      longScore += realtimeMomentum.score;
      if (realtimeMomentum.reason) reasons.push(realtimeMomentum.reason);
    } else if (realtimeMomentum.signal === 'short') {
      shortScore += realtimeMomentum.score;
      if (realtimeMomentum.reason) reasons.push(realtimeMomentum.reason);
    }

    // 3. Volume spike detection
    const volumeSpike = this.detectVolumeSpike(prices);
    if (volumeSpike > this.config.volumeSpikeMultiplier) {
      const boost = Math.min(0.2, (volumeSpike - 1) * 0.1);
      longScore += boost;
      shortScore += boost;
      reasons.push(`Volume spike: ${volumeSpike.toFixed(1)}x average`);
    }

    // 4. Quick price action (last few candles)
    const priceAction = this.analyzePriceAction(prices.slice(0, 5));
    if (priceAction.signal === 'long') {
      longScore += 0.2;
      reasons.push(priceAction.reason);
    } else if (priceAction.signal === 'short') {
      shortScore += 0.2;
      reasons.push(priceAction.reason);
    }

    // Determine direction and confidence
    const direction = longScore > shortScore ? 'long' : 'short';
    const confidence = Math.max(longScore, shortScore);

    // Check minimum confidence
    if (confidence < this.config.minConfidence) {
      return null;
    }

    // Calculate targets
    const takeProfitPercent = this.config.takeProfitPercent;
    const stopLossPercent = this.config.stopLossPercent;

    const takeProfit = direction === 'long'
      ? currentPrice * (1 + takeProfitPercent / 100)
      : currentPrice * (1 - takeProfitPercent / 100);

    const stopLoss = direction === 'long'
      ? currentPrice * (1 - stopLossPercent / 100)
      : currentPrice * (1 + stopLossPercent / 100);

    const riskReward = takeProfitPercent / stopLossPercent;

    // Check minimum R:R
    if (riskReward < this.config.minRiskReward) {
      return null;
    }

    const signal: ScalpSignal = {
      type: 'entry',
      direction,
      symbol,
      price: currentPrice,
      timestamp: Date.now(),
      entryPrice: currentPrice,
      takeProfit,
      stopLoss,
      takeProfitPercent,
      stopLossPercent,
      riskReward,
      confidence: Math.min(1, confidence),
      reasons,
      spread: orderBook?.spreadPercent || 0,
      spreadPercent: orderBook?.spreadPercent || 0,
      imbalance: orderBook?.imbalance || 0,
      nearestSupport: orderBook?.buyWalls[0]?.price,
      nearestResistance: orderBook?.sellWalls[0]?.price,
    };

    // Record signal time
    this.lastSignalTime.set(symbol, Date.now());

    // Track active scalp
    this.activeScalps.set(symbol, {
      signal,
      status: 'active',
      entryTime: Date.now(),
    });

    this.emit('signal', signal);
    return signal;
  }

  /**
   * Check if active scalp should exit
   */
  checkScalpExit(symbol: string, currentPrice: number): ActiveScalp | null {
    const activeScalp = this.activeScalps.get(symbol);
    if (!activeScalp || activeScalp.status !== 'active') {
      return null;
    }

    const signal = activeScalp.signal;
    let exitReason: 'tp_hit' | 'sl_hit' | 'wall_exit' | null = null;
    let exitReasonText = '';

    // Calculate current P/L
    const currentPnL = signal.direction === 'long'
      ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
      : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

    // Check TP/SL hits
    if (signal.direction === 'long') {
      if (currentPrice >= signal.takeProfit) {
        exitReason = 'tp_hit';
      } else if (currentPrice <= signal.stopLoss) {
        exitReason = 'sl_hit';
      }
    } else {
      if (currentPrice <= signal.takeProfit) {
        exitReason = 'tp_hit';
      } else if (currentPrice >= signal.stopLoss) {
        exitReason = 'sl_hit';
      }
    }

    // If no TP/SL hit, check wall-based exit (only if in profit)
    if (!exitReason && this.config.enableWallExit && currentPnL >= this.config.minProfitForWallExit) {
      const wallAnalysis = this.analyzeWallsForExit(symbol, currentPrice, signal);

      if (wallAnalysis.hasBlockingWall &&
          wallAnalysis.breakProbability < this.config.wallBreakThreshold &&
          wallAnalysis.recommendation === 'exit_profit') {
        exitReason = 'wall_exit';
        exitReasonText = `${wallAnalysis.wallStrength} wall at ${wallAnalysis.wallPrice.toFixed(0)} (${wallAnalysis.breakProbability.toFixed(0)}% break prob)`;
      }
    }

    if (exitReason) {
      activeScalp.status = exitReason;
      activeScalp.exitTime = Date.now();
      activeScalp.exitPrice = currentPrice;
      activeScalp.duration = activeScalp.exitTime - activeScalp.entryTime;
      activeScalp.exitReason = exitReasonText;
      activeScalp.profitPercent = currentPnL;

      // Move to history
      this.tradeHistory.push(activeScalp);
      this.activeScalps.delete(symbol);

      this.emit('exit', activeScalp);
      return activeScalp;
    }

    return null;
  }

  /**
   * Analyze walls to determine if TP is blocked
   */
  private analyzeWallsForExit(symbol: string, currentPrice: number, signal: ScalpSignal): WallAnalysis {
    const defaultResult: WallAnalysis = {
      hasBlockingWall: false,
      wallPrice: 0,
      wallStrength: 'weak',
      wallVolume: 0,
      distancePercent: 0,
      breakProbability: 1,
      recommendation: 'hold',
    };

    // Get realtime order book from cache
    const realtimeData = realtimeFetcher.getPrice(symbol);
    if (!realtimeData?.orderBook) {
      return defaultResult;
    }

    const orderBook = realtimeData.orderBook;
    const isLong = signal.direction === 'long';

    // For LONG: check sell walls between current price and TP
    // For SHORT: check buy walls between current price and TP
    const wallsToCheck = isLong ? orderBook.asks : orderBook.bids;
    const targetPrice = signal.takeProfit;

    // Find walls blocking the path to TP
    const blockingWalls: Array<{ price: number; volume: number; volumeIdr: number }> = [];
    let totalBlockingVolume = 0;

    for (const order of wallsToCheck) {
      const isBlocking = isLong
        ? order.price > currentPrice && order.price < targetPrice
        : order.price < currentPrice && order.price > targetPrice;

      if (isBlocking && order.volumeIdr > 0) {
        blockingWalls.push(order);
        totalBlockingVolume += order.volumeIdr;
      }
    }

    if (blockingWalls.length === 0) {
      return defaultResult;
    }

    // Find the strongest blocking wall
    const strongestWall = blockingWalls.reduce((max, w) =>
      w.volumeIdr > max.volumeIdr ? w : max
    );

    // Calculate total depth on the opposite side (buying power for long, selling power for short)
    const oppositeOrders = isLong ? orderBook.bids : orderBook.asks;
    const oppositeVolume = oppositeOrders.reduce((sum, o) => sum + o.volumeIdr, 0);

    // Determine wall strength based on volume relative to opposite side
    const volumeRatio = oppositeVolume > 0 ? totalBlockingVolume / oppositeVolume : 10;
    let wallStrength: WallAnalysis['wallStrength'] = 'weak';

    if (volumeRatio > 3) wallStrength = 'massive';
    else if (volumeRatio > 2) wallStrength = 'strong';
    else if (volumeRatio > 1) wallStrength = 'medium';

    // Calculate break probability
    // Lower if: wall is massive, multiple walls stacked, low opposite volume
    let breakProbability = 0.5;

    // Adjust for wall strength
    if (wallStrength === 'massive') breakProbability -= 0.3;
    else if (wallStrength === 'strong') breakProbability -= 0.2;
    else if (wallStrength === 'medium') breakProbability -= 0.1;

    // Adjust for number of walls (stacked walls are harder to break)
    if (blockingWalls.length >= 5) breakProbability -= 0.2;
    else if (blockingWalls.length >= 3) breakProbability -= 0.1;

    // Adjust for distance (closer walls are more relevant)
    const distancePercent = Math.abs((strongestWall.price - currentPrice) / currentPrice) * 100;
    if (distancePercent < 0.1) breakProbability -= 0.1; // Very close wall

    // Clamp probability
    breakProbability = Math.max(0.05, Math.min(0.95, breakProbability));

    // Determine recommendation
    let recommendation: WallAnalysis['recommendation'] = 'hold';

    if (breakProbability < 0.2 && wallStrength === 'massive') {
      recommendation = 'exit_profit';
    } else if (breakProbability < 0.3 && (wallStrength === 'strong' || wallStrength === 'massive')) {
      recommendation = 'exit_profit';
    } else if (breakProbability < 0.4) {
      recommendation = 'tighten_tp';
    }

    return {
      hasBlockingWall: true,
      wallPrice: strongestWall.price,
      wallStrength,
      wallVolume: totalBlockingVolume,
      distancePercent,
      breakProbability,
      recommendation,
    };
  }

  /**
   * Detect volume spike
   */
  private detectVolumeSpike(prices: PriceRecord[]): number {
    if (prices.length < 10) return 1;

    const volumes = prices.map(p => p.volume);
    const avgVolume = volumes.slice(1, 10).reduce((a, b) => a + b, 0) / 9;
    const currentVolume = volumes[0];

    return avgVolume > 0 ? currentVolume / avgVolume : 1;
  }

  /**
   * Analyze recent price action
   */
  private analyzePriceAction(recentPrices: PriceRecord[]): { signal: 'long' | 'short' | 'neutral'; reason: string } {
    if (recentPrices.length < 3) {
      return { signal: 'neutral', reason: '' };
    }

    // Check for consecutive green/red candles
    let greenCount = 0;
    let redCount = 0;

    for (let i = 0; i < Math.min(3, recentPrices.length); i++) {
      const p = recentPrices[i];
      if (p.close > p.open) greenCount++;
      else if (p.close < p.open) redCount++;
    }

    // Reversal patterns
    const latest = recentPrices[0];
    const prev = recentPrices[1];

    // Bullish engulfing
    if (latest.close > latest.open &&
        prev.close < prev.open &&
        latest.close > prev.open &&
        latest.open < prev.close) {
      return { signal: 'long', reason: 'Bullish engulfing pattern' };
    }

    // Bearish engulfing
    if (latest.close < latest.open &&
        prev.close > prev.open &&
        latest.close < prev.open &&
        latest.open > prev.close) {
      return { signal: 'short', reason: 'Bearish engulfing pattern' };
    }

    // Hammer (bullish)
    const bodySize = Math.abs(latest.close - latest.open);
    const lowerWick = Math.min(latest.open, latest.close) - latest.low;
    const upperWick = latest.high - Math.max(latest.open, latest.close);

    if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5) {
      return { signal: 'long', reason: 'Hammer pattern (bullish reversal)' };
    }

    // Shooting star (bearish)
    if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5) {
      return { signal: 'short', reason: 'Shooting star (bearish reversal)' };
    }

    // Momentum based on consecutive candles
    if (greenCount >= 3) {
      return { signal: 'long', reason: '3+ consecutive green candles' };
    }
    if (redCount >= 3) {
      return { signal: 'short', reason: '3+ consecutive red candles' };
    }

    return { signal: 'neutral', reason: '' };
  }

  /**
   * Get combined realtime + historical price data
   * Prioritizes realtime trades for most recent data
   */
  private getLivePrices(symbol: string, limit: number): PriceRecord[] {
    // Get historical data from DB
    const historical = priceRepo.getLatestPrices(symbol, limit);

    // Get realtime trades
    const realtimeTrades = realtimeFetcher.getTrades(symbol, 50);

    if (realtimeTrades.length < 5) {
      return historical;
    }

    // Convert realtime trades to price records (aggregate into mini-candles)
    const realtimeRecords: PriceRecord[] = [];
    const chunkSize = 5; // 5 trades per candle

    for (let i = 0; i < realtimeTrades.length; i += chunkSize) {
      const chunk = realtimeTrades.slice(i, i + chunkSize);
      if (chunk.length < 2) continue;

      const prices = chunk.map(t => t.price);
      const volumes = chunk.map(t => t.volumeCrypto);

      realtimeRecords.push({
        symbol,
        timestamp: chunk[chunk.length - 1].timestamp,
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        volume: volumes.reduce((a, b) => a + b, 0),
      });
    }

    // Combine: realtime first, then historical (avoiding duplicates by timestamp)
    const combined: PriceRecord[] = [...realtimeRecords];
    const realtimeTimestamps = new Set(realtimeRecords.map(r => Math.floor(r.timestamp / 60000))); // minute granularity

    for (const h of historical) {
      const minuteTs = Math.floor(h.timestamp / 60000);
      if (!realtimeTimestamps.has(minuteTs)) {
        combined.push(h);
      }
    }

    // Sort by timestamp descending and limit
    return combined
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Analyze realtime momentum from recent trades
   * Fast signal detection from trade flow
   */
  private analyzeRealtimeMomentum(symbol: string): { signal: 'long' | 'short' | 'neutral'; score: number; reason: string } {
    const trades = realtimeFetcher.getTrades(symbol, 30);

    if (trades.length < 10) {
      return { signal: 'neutral', score: 0, reason: '' };
    }

    // Analyze recent trade flow
    const recentTrades = trades.slice(0, 20);
    let buyVolume = 0;
    let sellVolume = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const trade of recentTrades) {
      if (trade.side === 'buy') {
        buyVolume += trade.volumeIdr;
        buyCount++;
      } else {
        sellVolume += trade.volumeIdr;
        sellCount++;
      }
    }

    const totalVolume = buyVolume + sellVolume;
    const buyRatio = totalVolume > 0 ? buyVolume / totalVolume : 0.5;

    // Price momentum (compare first 5 vs last 5 trades)
    const firstPrices = trades.slice(15, 20).map(t => t.price);
    const lastPrices = trades.slice(0, 5).map(t => t.price);

    const avgFirst = firstPrices.length > 0 ? firstPrices.reduce((a, b) => a + b, 0) / firstPrices.length : 0;
    const avgLast = lastPrices.length > 0 ? lastPrices.reduce((a, b) => a + b, 0) / lastPrices.length : 0;

    const priceMomentum = avgFirst > 0 ? ((avgLast - avgFirst) / avgFirst) * 100 : 0;

    // Generate signal
    let signal: 'long' | 'short' | 'neutral' = 'neutral';
    let score = 0;
    let reason = '';

    // Strong buy flow
    if (buyRatio > 0.65 && priceMomentum > 0.05) {
      signal = 'long';
      score = Math.min(0.3, (buyRatio - 0.5) * 0.6 + priceMomentum * 2);
      reason = `Strong buy flow: ${(buyRatio * 100).toFixed(0)}% buys, +${priceMomentum.toFixed(2)}% momentum`;
    }
    // Strong sell flow
    else if (buyRatio < 0.35 && priceMomentum < -0.05) {
      signal = 'short';
      score = Math.min(0.3, (0.5 - buyRatio) * 0.6 + Math.abs(priceMomentum) * 2);
      reason = `Strong sell flow: ${((1 - buyRatio) * 100).toFixed(0)}% sells, ${priceMomentum.toFixed(2)}% momentum`;
    }
    // Large buy orders (whale detection)
    else if (buyCount < sellCount * 0.5 && buyVolume > sellVolume * 1.5) {
      signal = 'long';
      score = 0.2;
      reason = `Large buy orders detected (whale accumulation)`;
    }
    // Large sell orders
    else if (sellCount < buyCount * 0.5 && sellVolume > buyVolume * 1.5) {
      signal = 'short';
      score = 0.2;
      reason = `Large sell orders detected (whale distribution)`;
    }

    return { signal, score, reason };
  }

  /**
   * Get trade statistics
   */
  getStats(): {
    totalTrades: number;
    wins: number;
    losses: number;
    wallExits: number;
    winRate: number;
    avgProfit: number;
    avgDuration: number;
    totalProfit: number;
  } {
    const trades = this.tradeHistory;
    const wins = trades.filter(t => t.status === 'tp_hit');
    const wallExits = trades.filter(t => t.status === 'wall_exit' && (t.profitPercent || 0) > 0);
    const losses = trades.filter(t => t.status === 'sl_hit');

    const totalProfit = trades.reduce((sum, t) => sum + (t.profitPercent || 0), 0);
    const avgProfit = trades.length > 0 ? totalProfit / trades.length : 0;
    const avgDuration = trades.length > 0
      ? trades.reduce((sum, t) => sum + (t.duration || 0), 0) / trades.length
      : 0;

    // Wall exits with profit count as wins
    const totalWins = wins.length + wallExits.length;

    return {
      totalTrades: trades.length,
      wins: totalWins,
      losses: losses.length,
      wallExits: wallExits.length,
      winRate: trades.length > 0 ? (totalWins / trades.length) * 100 : 0,
      avgProfit,
      avgDuration,
      totalProfit,
    };
  }

  /**
   * Get active scalps
   */
  getActiveScalps(): Map<string, ActiveScalp> {
    return this.activeScalps;
  }

  /**
   * Get trade history
   */
  getHistory(): ActiveScalp[] {
    return this.tradeHistory;
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<ScalpConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current config
   */
  getConfig(): ScalpConfig {
    return { ...this.config };
  }

  /**
   * Manual exit
   */
  manualExit(symbol: string, exitPrice: number): ActiveScalp | null {
    const activeScalp = this.activeScalps.get(symbol);
    if (!activeScalp || activeScalp.status !== 'active') {
      return null;
    }

    activeScalp.status = 'manual_exit';
    activeScalp.exitTime = Date.now();
    activeScalp.exitPrice = exitPrice;
    activeScalp.duration = activeScalp.exitTime - activeScalp.entryTime;

    const signal = activeScalp.signal;
    if (signal.direction === 'long') {
      activeScalp.profitPercent = ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100;
    } else {
      activeScalp.profitPercent = ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;
    }

    this.tradeHistory.push(activeScalp);
    this.activeScalps.delete(symbol);

    return activeScalp;
  }
}

export default new Scalper();
