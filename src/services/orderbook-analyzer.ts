/**
 * Order Book Analyzer
 *
 * Analyzes order book data to understand market behavior:
 * - Bid/Ask imbalance (buy/sell pressure)
 * - Support/Resistance levels
 * - Market depth
 * - Whale detection (large orders)
 */

import indodax from '../exchange/indodax.js';
import realtimeFetcher, { OrderBookData } from './realtime-fetcher.js';
import { getDatabase } from '../database/connection.js';
import { Direction } from '../types/index.js';

export interface Wall {
  price: number;                 // Price level of the wall
  volume: number;                // Total volume at this level
  type: 'buy' | 'sell';          // Buy wall (support) or Sell wall (resistance)
  strength: 'weak' | 'medium' | 'strong' | 'massive';  // Wall strength
  percentFromPrice: number;      // Distance from current price (%)
  valueIDR: number;              // Total value in IDR
}

export interface OrderBookAnalysis {
  symbol: string;
  timestamp: number;
  currentPrice: number;          // Current mid price
  bidAskRatio: number;           // > 1 = more buy pressure
  imbalance: number;             // -1 to 1 (negative = sell pressure)
  spreadPercent: number;         // Bid-ask spread as percentage
  bidDepth: number;              // Total bid volume
  askDepth: number;              // Total ask volume
  supportLevel: number;          // Strongest bid level
  resistanceLevel: number;       // Strongest ask level
  buyWalls: Wall[];              // Detected buy walls (support)
  sellWalls: Wall[];             // Detected sell walls (resistance)
  whaleActivity: 'buy' | 'sell' | 'none';  // Large order detection
  signal: Direction;             // Trading signal
  confidence: number;            // Signal confidence
}

export interface OrderBookSnapshot {
  id?: number;
  symbol: string;
  bid_ask_ratio: number;
  imbalance: number;
  spread_percent: number;
  bid_depth: number;
  ask_depth: number;
  support_level: number;
  resistance_level: number;
  signal: Direction;
  timestamp: number;
}

export class OrderBookAnalyzer {
  private readonly depthLevels: number = 50;  // Analyze top 50 levels for wall detection
  private readonly whaleThreshold: number = 0.1;  // 10% of total depth = whale
  private readonly wallThresholds = {
    weak: 0.02,      // 2% of total depth
    medium: 0.05,    // 5% of total depth
    strong: 0.10,    // 10% of total depth
    massive: 0.20,   // 20% of total depth
  };
  private readonly cacheMaxAge: number = 5000; // 5 seconds max cache age

  constructor() {
    this.initializeTable();
  }

  /**
   * Convert WebSocket OrderBookData to analyzer format
   */
  private convertFromWebSocket(wsBook: OrderBookData): { bids: [number, number][]; asks: [number, number][] } {
    return {
      bids: wsBook.bids.map(b => [b.price, b.volume] as [number, number]),
      asks: wsBook.asks.map(a => [a.price, a.volume] as [number, number]),
    };
  }

  /**
   * Initialize orderbook_snapshots table
   */
  private initializeTable(): void {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS orderbook_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        bid_ask_ratio REAL NOT NULL,
        imbalance REAL NOT NULL,
        spread_percent REAL NOT NULL,
        bid_depth REAL NOT NULL,
        ask_depth REAL NOT NULL,
        support_level REAL NOT NULL,
        resistance_level REAL NOT NULL,
        signal TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_orderbook_symbol_time ON orderbook_snapshots(symbol, timestamp)`);
  }

  /**
   * Fetch and analyze order book for a symbol
   * @param symbol Trading pair symbol (e.g., BTC/IDR)
   * @param useCache Whether to use WebSocket cache (default: true)
   */
  async analyze(symbol: string, useCache: boolean = true): Promise<OrderBookAnalysis> {
    const timestamp = Date.now();
    let orderBook: { bids: [number, number][]; asks: [number, number][] };

    // Try to use WebSocket cache first
    if (useCache) {
      const cachedPrice = realtimeFetcher.getPrice(symbol);
      if (cachedPrice?.orderBook && (timestamp - cachedPrice.orderBook.timestamp) < this.cacheMaxAge) {
        orderBook = this.convertFromWebSocket(cachedPrice.orderBook);
      } else {
        // Cache miss or stale - fetch from REST API
        orderBook = await indodax.fetchOrderBook(symbol, this.depthLevels);
      }
    } else {
      // Force REST API fetch
      orderBook = await indodax.fetchOrderBook(symbol, this.depthLevels);
    }

    // Calculate bid depth (total volume on bid side)
    const bidDepth = orderBook.bids.reduce((sum, [, volume]) => sum + volume, 0);
    const askDepth = orderBook.asks.reduce((sum, [, volume]) => sum + volume, 0);

    // Bid/Ask ratio
    const bidAskRatio = askDepth > 0 ? bidDepth / askDepth : 1;

    // Imbalance: -1 (all sells) to +1 (all buys)
    const totalDepth = bidDepth + askDepth;
    const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

    // Spread calculation
    const bestBid = orderBook.bids[0]?.[0] || 0;
    const bestAsk = orderBook.asks[0]?.[0] || 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadPercent = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 0;

    // Find support level (highest bid concentration)
    const supportLevel = this.findConcentrationLevel(orderBook.bids);

    // Find resistance level (highest ask concentration)
    const resistanceLevel = this.findConcentrationLevel(orderBook.asks);

    // Detect walls (support/resistance)
    const buyWalls = this.detectWalls(orderBook.bids, bidDepth, midPrice, 'buy');
    const sellWalls = this.detectWalls(orderBook.asks, askDepth, midPrice, 'sell');

    // Detect whale activity
    const whaleActivity = this.detectWhales(orderBook.bids, orderBook.asks, bidDepth, askDepth);

    // Generate trading signal
    const { signal, confidence } = this.generateSignal(imbalance, spreadPercent, whaleActivity, bidAskRatio);

    const analysis: OrderBookAnalysis = {
      symbol,
      timestamp,
      currentPrice: midPrice,
      bidAskRatio,
      imbalance,
      spreadPercent,
      bidDepth,
      askDepth,
      supportLevel,
      resistanceLevel,
      buyWalls,
      sellWalls,
      whaleActivity,
      signal,
      confidence,
    };

    // Save snapshot
    this.saveSnapshot(analysis);

    return analysis;
  }

  /**
   * Detect walls (large orders at specific price levels)
   */
  private detectWalls(
    orders: [number, number][],
    totalDepth: number,
    currentPrice: number,
    type: 'buy' | 'sell'
  ): Wall[] {
    const walls: Wall[] = [];

    // Group orders by price level (aggregate nearby prices)
    const priceGroups = new Map<number, number>();

    for (const [price, volume] of orders) {
      // Round price to reduce noise (group within 0.1% range)
      const roundedPrice = Math.round(price / (price * 0.001)) * (price * 0.001);
      priceGroups.set(roundedPrice, (priceGroups.get(roundedPrice) || 0) + volume);
    }

    // Check each price level for walls
    for (const [price, volume] of priceGroups) {
      const volumeRatio = totalDepth > 0 ? volume / totalDepth : 0;

      // Determine wall strength
      let strength: Wall['strength'] | null = null;
      if (volumeRatio >= this.wallThresholds.massive) {
        strength = 'massive';
      } else if (volumeRatio >= this.wallThresholds.strong) {
        strength = 'strong';
      } else if (volumeRatio >= this.wallThresholds.medium) {
        strength = 'medium';
      } else if (volumeRatio >= this.wallThresholds.weak) {
        strength = 'weak';
      }

      if (strength) {
        const percentFromPrice = currentPrice > 0
          ? ((price - currentPrice) / currentPrice) * 100
          : 0;

        walls.push({
          price,
          volume,
          type,
          strength,
          percentFromPrice,
          valueIDR: price * volume,
        });
      }
    }

    // Sort by strength (massive first) then by distance from current price
    walls.sort((a, b) => {
      const strengthOrder = { massive: 0, strong: 1, medium: 2, weak: 3 };
      if (strengthOrder[a.strength] !== strengthOrder[b.strength]) {
        return strengthOrder[a.strength] - strengthOrder[b.strength];
      }
      return Math.abs(a.percentFromPrice) - Math.abs(b.percentFromPrice);
    });

    // Return top 5 walls
    return walls.slice(0, 5);
  }

  /**
   * Find price level with highest volume concentration
   */
  private findConcentrationLevel(orders: [number, number][]): number {
    if (orders.length === 0) return 0;

    let maxVolume = 0;
    let concentrationPrice = orders[0][0];

    for (const [price, volume] of orders) {
      if (volume > maxVolume) {
        maxVolume = volume;
        concentrationPrice = price;
      }
    }

    return concentrationPrice;
  }

  /**
   * Detect whale orders (unusually large orders)
   */
  private detectWhales(
    bids: [number, number][],
    asks: [number, number][],
    bidDepth: number,
    askDepth: number
  ): 'buy' | 'sell' | 'none' {
    // Check for whale bid orders
    for (const [, volume] of bids) {
      if (volume > bidDepth * this.whaleThreshold) {
        return 'buy';
      }
    }

    // Check for whale ask orders
    for (const [, volume] of asks) {
      if (volume > askDepth * this.whaleThreshold) {
        return 'sell';
      }
    }

    return 'none';
  }

  /**
   * Generate trading signal based on order book analysis
   */
  private generateSignal(
    imbalance: number,
    spreadPercent: number,
    whaleActivity: 'buy' | 'sell' | 'none',
    bidAskRatio: number
  ): { signal: Direction; confidence: number } {
    let bullScore = 0;
    let bearScore = 0;

    // Imbalance signal (strongest indicator)
    if (imbalance > 0.2) bullScore += 0.4;
    else if (imbalance > 0.1) bullScore += 0.2;
    else if (imbalance < -0.2) bearScore += 0.4;
    else if (imbalance < -0.1) bearScore += 0.2;

    // Whale activity
    if (whaleActivity === 'buy') bullScore += 0.3;
    else if (whaleActivity === 'sell') bearScore += 0.3;

    // Bid/Ask ratio
    if (bidAskRatio > 1.5) bullScore += 0.2;
    else if (bidAskRatio > 1.2) bullScore += 0.1;
    else if (bidAskRatio < 0.67) bearScore += 0.2;
    else if (bidAskRatio < 0.83) bearScore += 0.1;

    // Spread penalty (high spread = uncertainty)
    const spreadPenalty = Math.min(0.2, spreadPercent * 0.1);
    bullScore -= spreadPenalty;
    bearScore -= spreadPenalty;

    // Determine signal
    const netScore = bullScore - bearScore;
    let signal: Direction = 'neutral';
    let confidence = 0.5;

    if (netScore > 0.15) {
      signal = 'up';
      confidence = Math.min(0.9, 0.5 + netScore);
    } else if (netScore < -0.15) {
      signal = 'down';
      confidence = Math.min(0.9, 0.5 + Math.abs(netScore));
    }

    return { signal, confidence };
  }

  /**
   * Save order book snapshot to database
   */
  private saveSnapshot(analysis: OrderBookAnalysis): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO orderbook_snapshots
      (symbol, bid_ask_ratio, imbalance, spread_percent, bid_depth, ask_depth, support_level, resistance_level, signal, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      analysis.symbol,
      analysis.bidAskRatio,
      analysis.imbalance,
      analysis.spreadPercent,
      analysis.bidDepth,
      analysis.askDepth,
      analysis.supportLevel,
      analysis.resistanceLevel,
      analysis.signal,
      analysis.timestamp
    );
  }

  /**
   * Get order book history for a symbol
   */
  getHistory(symbol: string, limit: number = 50): OrderBookSnapshot[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM orderbook_snapshots
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(symbol, limit) as OrderBookSnapshot[];
  }

  /**
   * Get order book trend (buy/sell pressure over time)
   */
  getTrend(symbol: string, periods: number = 10): { pressure: 'buy' | 'sell' | 'neutral'; avgImbalance: number } {
    const history = this.getHistory(symbol, periods);

    if (history.length === 0) {
      return { pressure: 'neutral', avgImbalance: 0 };
    }

    const avgImbalance = history.reduce((sum, h) => sum + h.imbalance, 0) / history.length;

    let pressure: 'buy' | 'sell' | 'neutral' = 'neutral';
    if (avgImbalance > 0.1) pressure = 'buy';
    else if (avgImbalance < -0.1) pressure = 'sell';

    return { pressure, avgImbalance };
  }

  /**
   * Get combined market signal from order book
   */
  getMarketSignal(symbol: string): { signal: Direction; confidence: number; details: string } {
    const history = this.getHistory(symbol, 5);

    if (history.length === 0) {
      return { signal: 'neutral', confidence: 0.5, details: 'No order book data' };
    }

    // Count signals
    let upCount = 0, downCount = 0, neutralCount = 0;
    let avgImbalance = 0;
    let avgRatio = 0;

    for (const h of history) {
      if (h.signal === 'up') upCount++;
      else if (h.signal === 'down') downCount++;
      else neutralCount++;
      avgImbalance += h.imbalance;
      avgRatio += h.bid_ask_ratio;
    }

    avgImbalance /= history.length;
    avgRatio /= history.length;

    let signal: Direction = 'neutral';
    let confidence = 0.5;

    if (upCount > downCount && upCount > neutralCount) {
      signal = 'up';
      confidence = upCount / history.length;
    } else if (downCount > upCount && downCount > neutralCount) {
      signal = 'down';
      confidence = downCount / history.length;
    }

    const details = `Imbalance: ${(avgImbalance * 100).toFixed(1)}% | Ratio: ${avgRatio.toFixed(2)} | Recent: ${upCount}↑ ${downCount}↓ ${neutralCount}→`;

    return { signal, confidence, details };
  }
}

export default new OrderBookAnalyzer();
