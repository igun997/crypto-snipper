import indodax from '../exchange/indodax.js';
import priceRepo from '../database/repositories/prices.js';
import { TradingPair, PriceRecord } from '../types/index.js';

// Timeframe in milliseconds
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

export class DataFetcher {
  /**
   * Fetch and store OHLCV data for a symbol
   * Returns: { fetched: number, skipped: number, fromCache: boolean }
   */
  async fetchAndStore(symbol: string, timeframe: string = '15m', limit: number = 100): Promise<number> {
    const candles = await indodax.fetchOHLCV(symbol, timeframe, limit);
    const records = priceRepo.candlesToRecords(symbol, candles);
    priceRepo.insertMany(records);
    return records.length;
  }

  /**
   * Smart fetch - checks DB first, only fetches missing data from API
   * Returns: { total: number, fetched: number, cached: number }
   */
  async smartFetch(
    symbol: string,
    timeframe: string = '15m',
    limit: number = 100
  ): Promise<{ total: number; fetched: number; cached: number }> {
    const tfMs = TIMEFRAME_MS[timeframe] || 15 * 60 * 1000;
    const now = Date.now();
    const requiredStart = now - (limit * tfMs);

    // Check existing data in DB
    const existing = priceRepo.getLatestPrices(symbol, limit * 2);

    if (existing.length > 0) {
      const oldestExisting = Math.min(...existing.map(p => p.timestamp));
      const newestExisting = Math.max(...existing.map(p => p.timestamp));

      // Check if we have enough recent data
      const hasRecentData = (now - newestExisting) < tfMs * 2; // Within 2 candles
      const hasEnoughHistory = oldestExisting <= requiredStart;

      if (hasRecentData && hasEnoughHistory && existing.length >= limit * 0.8) {
        // We have enough cached data, just fetch latest candle to update
        const latestCandles = await indodax.fetchOHLCV(symbol, timeframe, 5);
        const latestRecords = priceRepo.candlesToRecords(symbol, latestCandles);
        priceRepo.insertMany(latestRecords);

        return {
          total: existing.length,
          fetched: latestRecords.length,
          cached: existing.length,
        };
      }

      // Calculate how many candles we need to fetch
      const gapCandles = Math.ceil((requiredStart - oldestExisting) / tfMs);
      const recentCandles = Math.ceil((now - newestExisting) / tfMs);

      if (gapCandles > 0 || recentCandles > 5) {
        // Need to fetch more data
        const fetchLimit = Math.min(limit, Math.max(gapCandles, recentCandles) + 10);
        const candles = await indodax.fetchOHLCV(symbol, timeframe, fetchLimit);
        const records = priceRepo.candlesToRecords(symbol, candles);
        priceRepo.insertMany(records);

        return {
          total: existing.length + records.length,
          fetched: records.length,
          cached: existing.length,
        };
      }
    }

    // No existing data, fetch everything
    const candles = await indodax.fetchOHLCV(symbol, timeframe, limit);
    const records = priceRepo.candlesToRecords(symbol, candles);
    priceRepo.insertMany(records);

    return {
      total: records.length,
      fetched: records.length,
      cached: 0,
    };
  }

  /**
   * Fetch and store data for all active trading pairs
   */
  async fetchAll(timeframe: string = '15m', limit: number = 100): Promise<Map<string, number>> {
    const pairs = await indodax.getTradingPairs();
    const results = new Map<string, number>();

    for (const pair of pairs) {
      try {
        const count = await this.fetchAndStore(pair.symbol, timeframe, limit);
        results.set(pair.symbol, count);
        // Rate limiting - wait a bit between requests
        await this.sleep(200);
      } catch (error) {
        console.error(`Failed to fetch ${pair.symbol}:`, error);
        results.set(pair.symbol, 0);
      }
    }

    return results;
  }

  /**
   * Get available trading pairs
   */
  async getTradingPairs(): Promise<TradingPair[]> {
    return indodax.getTradingPairs();
  }

  /**
   * Get latest ticker for a symbol
   */
  async getTicker(symbol: string): Promise<{ last: number; volume: number }> {
    const ticker = await indodax.fetchTicker(symbol);
    return { last: ticker.last, volume: ticker.volume };
  }

  /**
   * Get historical prices from database
   */
  getStoredPrices(symbol: string, limit: number = 100): PriceRecord[] {
    return priceRepo.getLatestPrices(symbol, limit);
  }

  /**
   * Get all symbols that have stored data
   */
  getStoredSymbols(): string[] {
    return priceRepo.getSymbols();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default new DataFetcher();
