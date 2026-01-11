import { getDatabase } from '../connection.js';
import { PriceRecord, Candle } from '../../types/index.js';

export class PriceRepository {
  insertPrice(price: PriceRecord): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO prices (symbol, timestamp, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      price.symbol,
      price.timestamp,
      price.open,
      price.high,
      price.low,
      price.close,
      price.volume
    );
  }

  insertMany(prices: PriceRecord[]): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO prices (symbol, timestamp, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items: PriceRecord[]) => {
      for (const price of items) {
        stmt.run(
          price.symbol,
          price.timestamp,
          price.open,
          price.high,
          price.low,
          price.close,
          price.volume
        );
      }
    });

    insertMany(prices);
  }

  getLatestPrices(symbol: string, limit: number = 100): PriceRecord[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM prices
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(symbol, limit) as PriceRecord[];
  }

  getPriceRange(symbol: string, startTs: number, endTs: number): PriceRecord[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM prices
      WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(symbol, startTs, endTs) as PriceRecord[];
  }

  getLatestPrice(symbol: string): PriceRecord | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM prices
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    return (stmt.get(symbol) as PriceRecord) || null;
  }

  getPriceAtTimestamp(symbol: string, timestamp: number): PriceRecord | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM prices
      WHERE symbol = ? AND timestamp <= ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    return (stmt.get(symbol, timestamp) as PriceRecord) || null;
  }

  getSymbols(): string[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT DISTINCT symbol FROM prices ORDER BY symbol');
    return (stmt.all() as { symbol: string }[]).map((row) => row.symbol);
  }

  candlesToRecords(symbol: string, candles: Candle[]): PriceRecord[] {
    return candles.map((candle) => ({
      symbol,
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
  }
}

export default new PriceRepository();
