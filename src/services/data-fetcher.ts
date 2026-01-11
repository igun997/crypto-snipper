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
   * Fetch 1 month of historical data for a symbol
   * Uses multiple timeframes for comprehensive coverage:
   * - 15m candles for ~1 month (2880 candles)
   * - 1m candles for recent 200 candles (for scalping)
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
      // Phase 1: Fetch 1 month of 15m candles (main historical data)
      // 30 days * 24 hours * 4 (15m intervals) = 2880 candles
      onProgress?.('Fetching 15m candles (1 month)', 10);

      const candles15m = await this.fetchWithPagination(symbol, '15m', 2880);
      results['15m'] = candles15m;
      totalCandles += candles15m;

      onProgress?.('Fetching 15m candles complete', 40);

      // Phase 2: Fetch 1h candles for longer trend analysis
      // 30 days * 24 hours = 720 candles
      onProgress?.('Fetching 1h candles', 50);

      const candles1h = await this.fetchWithPagination(symbol, '1h', 720);
      results['1h'] = candles1h;
      totalCandles += candles1h;

      onProgress?.('Fetching 1h candles complete', 70);

      // Phase 3: Fetch recent 1m candles for scalping (last ~3 hours)
      onProgress?.('Fetching 1m candles (recent)', 80);

      const candles1m = await indodax.fetchOHLCV(symbol, '1m', 200);
      const records1m = priceRepo.candlesToRecords(symbol, candles1m);
      priceRepo.insertMany(records1m);
      results['1m'] = records1m.length;
      totalCandles += records1m.length;

      onProgress?.('Complete', 100);

      return { total: totalCandles, timeframes: results };
    } catch (error) {
      console.error(`[DataFetcher] Failed to fetch historical data for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Fetch candles with pagination for large datasets
   * Uses 'since' parameter to fetch historical data in batches
   */
  private async fetchWithPagination(
    symbol: string,
    timeframe: string,
    targetCandles: number
  ): Promise<number> {
    const batchSize = 500; // Safe batch size for most exchanges
    let totalFetched = 0;

    const tfMs = TIMEFRAME_MS[timeframe] || 15 * 60 * 1000;

    // Calculate start time (targetCandles ago from now)
    let since = Date.now() - (targetCandles * tfMs);

    console.log(`[DataFetcher] Fetching ${targetCandles} ${timeframe} candles for ${symbol}, starting from ${new Date(since).toISOString()}`);

    while (totalFetched < targetCandles) {
      const limit = Math.min(batchSize, targetCandles - totalFetched);

      try {
        console.log(`[DataFetcher] Batch fetch: since=${new Date(since).toISOString()}, limit=${limit}`);

        const candles = await indodax.fetchOHLCV(symbol, timeframe, limit, since);

        console.log(`[DataFetcher] Got ${candles.length} candles`);

        if (candles.length === 0) {
          console.log(`[DataFetcher] No more candles available`);
          break;
        }

        const records = priceRepo.candlesToRecords(symbol, candles);
        priceRepo.insertMany(records);
        totalFetched += records.length;

        // Move since to after the last candle for next batch
        const lastTimestamp = candles[candles.length - 1].timestamp;
        since = lastTimestamp + tfMs;

        console.log(`[DataFetcher] Total fetched: ${totalFetched}, next since: ${new Date(since).toISOString()}`);

        // If we got fewer candles than requested, we've reached the end
        if (candles.length < limit) {
          console.log(`[DataFetcher] Received fewer candles than limit, ending pagination`);
          break;
        }

        // Rate limiting - be gentle with the API
        await this.sleep(500);
      } catch (error) {
        console.error(`[DataFetcher] Batch fetch error for ${symbol} ${timeframe}:`, error);
        break;
      }
    }

    console.log(`[DataFetcher] Final total for ${symbol} ${timeframe}: ${totalFetched} candles`);
    return totalFetched;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default new DataFetcher();
