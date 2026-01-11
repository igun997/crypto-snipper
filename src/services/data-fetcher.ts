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

  /**
   * Fetch historical data for a symbol
   * Fetches maximum available candles from exchange for each timeframe
   * Note: Indodax typically provides ~1000 candles max per request
   *
   * @param symbol Trading pair symbol (e.g., 'BTC/IDR')
   * @param onProgress Optional callback for progress updates
   * @returns Total candles fetched
   */
  async fetchHistorical(
    symbol: string,
    onProgress?: (phase: string, progress: number) => void
  ): Promise<{ total: number; timeframes: Record<string, number> }> {
    const results: Record<string, number> = {};
    let totalCandles = 0;

    try {
      // Phase 1: Fetch 15m candles (max available, typically ~1000)
      onProgress?.('Fetching 15m candles', 10);

      const candles15m = await this.fetchMaxCandles(symbol, '15m');
      results['15m'] = candles15m;
      totalCandles += candles15m;

      onProgress?.('Fetching 15m complete', 30);

      // Phase 2: Fetch 1h candles for trend analysis
      onProgress?.('Fetching 1h candles', 40);

      const candles1h = await this.fetchMaxCandles(symbol, '1h');
      results['1h'] = candles1h;
      totalCandles += candles1h;

      onProgress?.('Fetching 1h complete', 60);

      // Phase 3: Fetch 1d candles for long-term trend
      onProgress?.('Fetching 1d candles', 70);

      const candles1d = await this.fetchMaxCandles(symbol, '1d');
      results['1d'] = candles1d;
      totalCandles += candles1d;

      onProgress?.('Fetching 1d complete', 80);

      // Phase 4: Fetch 1m candles for scalping
      onProgress?.('Fetching 1m candles', 90);

      const candles1m = await this.fetchMaxCandles(symbol, '1m');
      results['1m'] = candles1m;
      totalCandles += candles1m;

      onProgress?.('Complete', 100);

      return { total: totalCandles, timeframes: results };
    } catch (error) {
      console.error(`[DataFetcher] Failed to fetch historical data for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Fetch maximum available candles for a timeframe
   * Indodax typically provides up to ~1000 candles
   */
  private async fetchMaxCandles(symbol: string, timeframe: string): Promise<number> {
    try {
      // Request max candles (most exchanges cap at 1000)
      const limit = 1000;

      console.log(`[DataFetcher] Fetching ${timeframe} candles for ${symbol} (limit=${limit})`);

      const candles = await indodax.fetchOHLCV(symbol, timeframe, limit);

      console.log(`[DataFetcher] Got ${candles.length} ${timeframe} candles`);

      if (candles.length === 0) {
        return 0;
      }

      const records = priceRepo.candlesToRecords(symbol, candles);
      priceRepo.insertMany(records);

      // Calculate time span
      const oldest = new Date(candles[0].timestamp);
      const newest = new Date(candles[candles.length - 1].timestamp);
      const days = Math.round((newest.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24));

      console.log(`[DataFetcher] ${symbol} ${timeframe}: ${candles.length} candles spanning ${days} days (${oldest.toISOString()} to ${newest.toISOString()})`);

      // Rate limiting
      await this.sleep(300);

      return records.length;
    } catch (error) {
      console.error(`[DataFetcher] Error fetching ${timeframe} for ${symbol}:`, error);
      return 0;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default new DataFetcher();
