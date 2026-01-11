/**
 * Real-time WebSocket data fetcher for Indodax
 * Uses WSS to get live trade and order book updates
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { PriceRecord } from '../types/index.js';
import priceRepo from '../database/repositories/prices.js';

const WS_URL = 'wss://ws3.indodax.com/ws/';
const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE5NDY2MTg0MTV9.UR1lBM6Eqh0yWz-PVirw1uPCxe60FdchR8eNVdsskeo';

export interface TradeData {
  symbol: string;
  pair: string;
  timestamp: number;
  side: 'buy' | 'sell';
  price: number;
  volumeIdr: number;
  volumeCrypto: number;
}

export interface OrderBookData {
  symbol: string;
  pair: string;
  asks: Array<{ price: number; volume: number; volumeIdr: number }>;
  bids: Array<{ price: number; volume: number; volumeIdr: number }>;
  timestamp: number;
}

export interface RealtimePrice {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
  trades: TradeData[];
  orderBook?: OrderBookData;
}

type RealtimeEvents = {
  trade: [TradeData];
  orderbook: [OrderBookData];
  price: [RealtimePrice];
  connected: [];
  disconnected: [];
  error: [Error];
};

export class RealtimeFetcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedSymbols: Set<string> = new Set();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private messageId: number = 1;
  private isConnected: boolean = false;
  private priceCache: Map<string, RealtimePrice> = new Map();
  private tradeBuffer: Map<string, TradeData[]> = new Map();

  constructor() {
    super();
  }

  /**
   * Connect to Indodax WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.isConnected) {
        resolve();
        return;
      }

      try {
        this.ws = new WebSocket(WS_URL);

        this.ws.on('open', () => {
          console.log('  [WSS] Connected to Indodax WebSocket');
          this.authenticate();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', () => {
          console.log('  [WSS] Disconnected from Indodax WebSocket');
          this.isConnected = false;
          this.emit('disconnected');
          this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
          console.error('  [WSS] WebSocket error:', error.message);
          this.emit('error', error);
          reject(error);
        });

        // Wait for auth response
        const authTimeout = setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('Authentication timeout'));
          }
        }, 10000);

        this.once('connected', () => {
          clearTimeout(authTimeout);
          resolve();
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Authenticate with the WebSocket server
   */
  private authenticate(): void {
    if (!this.ws) return;

    const authMessage = {
      params: {
        token: AUTH_TOKEN
      },
      id: this.messageId++
    };

    this.ws.send(JSON.stringify(authMessage));
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // Auth response
      if (message.id === 1 && message.result) {
        this.isConnected = true;
        this.emit('connected');
        this.startPingInterval();

        // Resubscribe to all symbols
        for (const symbol of this.subscribedSymbols) {
          this.subscribeToSymbol(symbol);
        }
        return;
      }

      // Channel data
      if (message.result && message.result.channel) {
        const channel = message.result.channel;
        const channelData = message.result.data;

        if (channel.startsWith('market:trade-activity-')) {
          this.handleTradeActivity(channel, channelData);
        } else if (channel.startsWith('market:order-book-')) {
          this.handleOrderBook(channel, channelData);
        }
      }

    } catch (error) {
      // Ignore parse errors for ping/pong
    }
  }

  /**
   * Handle trade activity updates
   */
  private handleTradeActivity(channel: string, data: { data: any[]; offset: number }): void {
    const pair = channel.replace('market:trade-activity-', '');
    const symbol = this.pairToSymbol(pair);

    if (!data.data || data.data.length === 0) return;

    for (const trade of data.data) {
      // [pair, timestamp, sequence, side, price, idr_volume, crypto_volume]
      const tradeData: TradeData = {
        symbol,
        pair,
        timestamp: trade[1] * 1000,
        side: trade[3] as 'buy' | 'sell',
        price: parseFloat(trade[4]),
        volumeIdr: parseFloat(trade[5]),
        volumeCrypto: parseFloat(trade[6]),
      };

      this.emit('trade', tradeData);
      this.updatePriceCache(symbol, tradeData);

      // Buffer trades
      if (!this.tradeBuffer.has(symbol)) {
        this.tradeBuffer.set(symbol, []);
      }
      const buffer = this.tradeBuffer.get(symbol)!;
      buffer.push(tradeData);

      // Keep last 100 trades
      if (buffer.length > 100) {
        buffer.shift();
      }
    }
  }

  /**
   * Handle order book updates
   */
  private handleOrderBook(channel: string, data: { data: any; offset: number }): void {
    const pair = channel.replace('market:order-book-', '');
    const symbol = this.pairToSymbol(pair);

    if (!data.data) return;

    const orderBook: OrderBookData = {
      symbol,
      pair,
      asks: (data.data.ask || []).map((a: any) => ({
        price: parseFloat(a.price),
        volume: parseFloat(a[`${pair.replace('idr', '')}_volume`] || a.btc_volume || '0'),
        volumeIdr: parseFloat(a.idr_volume || '0'),
      })),
      bids: (data.data.bid || []).map((b: any) => ({
        price: parseFloat(b.price),
        volume: parseFloat(b[`${pair.replace('idr', '')}_volume`] || b.btc_volume || '0'),
        volumeIdr: parseFloat(b.idr_volume || '0'),
      })),
      timestamp: Date.now(),
    };

    this.emit('orderbook', orderBook);

    // Update price cache with order book
    const cached = this.priceCache.get(symbol);
    if (cached) {
      cached.orderBook = orderBook;
    }
  }

  /**
   * Update price cache from trade data
   */
  private updatePriceCache(symbol: string, trade: TradeData): void {
    let cached = this.priceCache.get(symbol);

    if (!cached) {
      cached = {
        symbol,
        price: trade.price,
        change: 0,
        changePercent: 0,
        volume24h: 0,
        high24h: trade.price,
        low24h: trade.price,
        timestamp: trade.timestamp,
        trades: [],
      };
      this.priceCache.set(symbol, cached);
    }

    const oldPrice = cached.price;
    cached.price = trade.price;
    cached.change = trade.price - oldPrice;
    cached.changePercent = oldPrice > 0 ? ((trade.price - oldPrice) / oldPrice) * 100 : 0;
    cached.timestamp = trade.timestamp;
    cached.volume24h += trade.volumeIdr;

    if (trade.price > cached.high24h) cached.high24h = trade.price;
    if (trade.price < cached.low24h) cached.low24h = trade.price;

    cached.trades = this.tradeBuffer.get(symbol) || [];

    this.emit('price', cached);

    // Save to database periodically (every 10 trades)
    const buffer = this.tradeBuffer.get(symbol);
    if (buffer && buffer.length % 10 === 0) {
      this.saveTradeToDb(symbol, trade);
    }
  }

  /**
   * Save trade data to database as price record
   */
  private saveTradeToDb(symbol: string, trade: TradeData): void {
    const buffer = this.tradeBuffer.get(symbol) || [];
    if (buffer.length < 2) return;

    // Aggregate last 10 trades into OHLCV candle
    const recentTrades = buffer.slice(-10);
    const prices = recentTrades.map(t => t.price);
    const volumes = recentTrades.map(t => t.volumeCrypto);

    const priceRecord: PriceRecord = {
      symbol,
      timestamp: Math.floor(trade.timestamp / 1000),
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: trade.price,
      volume: volumes.reduce((a, b) => a + b, 0),
    };

    try {
      priceRepo.insertPrice(priceRecord);
    } catch {
      // Ignore duplicate errors
    }
  }

  /**
   * Subscribe to a trading symbol
   */
  async subscribe(symbol: string): Promise<void> {
    this.subscribedSymbols.add(symbol);

    if (this.isConnected) {
      this.subscribeToSymbol(symbol);
    }
  }

  /**
   * Internal subscribe to symbol channels
   */
  private subscribeToSymbol(symbol: string): void {
    if (!this.ws || !this.isConnected) return;

    const pair = this.symbolToPair(symbol);

    // Subscribe to trade activity
    this.ws.send(JSON.stringify({
      method: 1,
      params: { channel: `market:trade-activity-${pair}` },
      id: this.messageId++
    }));

    // Subscribe to order book
    this.ws.send(JSON.stringify({
      method: 1,
      params: { channel: `market:order-book-${pair}` },
      id: this.messageId++
    }));

    console.log(`  [WSS] Subscribed to ${symbol} (${pair})`);
  }

  /**
   * Unsubscribe from a trading symbol
   */
  async unsubscribe(symbol: string): Promise<void> {
    this.subscribedSymbols.delete(symbol);

    if (!this.ws || !this.isConnected) return;

    const pair = this.symbolToPair(symbol);

    // Unsubscribe from channels
    this.ws.send(JSON.stringify({
      method: 2,
      params: { channel: `market:trade-activity-${pair}` },
      id: this.messageId++
    }));

    this.ws.send(JSON.stringify({
      method: 2,
      params: { channel: `market:order-book-${pair}` },
      id: this.messageId++
    }));
  }

  /**
   * Get current price from cache
   */
  getPrice(symbol: string): RealtimePrice | undefined {
    return this.priceCache.get(symbol);
  }

  /**
   * Get all cached prices
   */
  getAllPrices(): Map<string, RealtimePrice> {
    return this.priceCache;
  }

  /**
   * Get recent trades for symbol
   */
  getTrades(symbol: string, limit: number = 50): TradeData[] {
    const buffer = this.tradeBuffer.get(symbol) || [];
    return buffer.slice(-limit);
  }

  /**
   * Convert symbol to Indodax pair format
   * BTC/IDR -> btcidr
   */
  private symbolToPair(symbol: string): string {
    return symbol.replace('/', '').toLowerCase();
  }

  /**
   * Convert Indodax pair to symbol format
   * btcidr -> BTC/IDR
   */
  private pairToSymbol(pair: string): string {
    // Handle common suffixes
    if (pair.endsWith('idr')) {
      const base = pair.replace('idr', '').toUpperCase();
      return `${base}/IDR`;
    }
    if (pair.endsWith('usdt')) {
      const base = pair.replace('usdt', '').toUpperCase();
      return `${base}/USDT`;
    }
    return pair.toUpperCase();
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.ping();
      }
    }, 30000);
  }

  /**
   * Schedule reconnection
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(async () => {
      console.log('  [WSS] Attempting to reconnect...');
      try {
        await this.connect();
      } catch (error) {
        console.error('  [WSS] Reconnection failed:', error);
        this.scheduleReconnect();
      }
    }, 5000);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.subscribedSymbols.clear();
    this.priceCache.clear();
    this.tradeBuffer.clear();
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

export default new RealtimeFetcher();
