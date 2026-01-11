import ccxt, { Exchange, OHLCV, Order, Balances } from 'ccxt';
import config from '../config/index.js';
import { Candle, TradingPair, OrderType, OrderSide } from '../types/index.js';

// Order result from exchange
export interface ExchangeOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  price?: number;
  amount: number;
  filled: number;
  remaining: number;
  status: 'open' | 'closed' | 'canceled';
  fee?: { cost: number; currency: string };
  timestamp: number;
}

// Balance result
export interface ExchangeBalance {
  currency: string;
  free: number;
  used: number;
  total: number;
}

// Trade result
export interface ExchangeTrade {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  cost: number;
  fee?: { cost: number; currency: string };
  timestamp: number;
}

export class IndodaxExchange {
  private exchange: Exchange;
  private credentials?: { apiKey: string; secret: string };

  constructor(apiKey?: string, secret?: string) {
    this.credentials = apiKey && secret ? { apiKey, secret } : undefined;
    this.exchange = new ccxt.indodax({
      apiKey: apiKey || config.indodax.apiKey,
      secret: secret || config.indodax.secret,
      enableRateLimit: true,
    });
  }

  /**
   * Create an exchange instance with custom credentials
   */
  static createWithCredentials(apiKey: string, secret: string): IndodaxExchange {
    return new IndodaxExchange(apiKey, secret);
  }

  /**
   * Check if this instance has trading credentials
   */
  hasCredentials(): boolean {
    return !!(this.credentials?.apiKey || config.indodax.apiKey);
  }

  private marketsLoaded: boolean = false;

  async loadMarkets(force: boolean = false): Promise<void> {
    if (!this.marketsLoaded || force) {
      await this.exchange.loadMarkets();

      // Fix market IDs for Indodax private API
      // The API expects 'sol_idr' format but CCXT has 'solidr'
      for (const symbol of Object.keys(this.exchange.markets)) {
        const market = this.exchange.markets[symbol];
        if (market && market.base && market.quote) {
          // Convert to underscore format: SOL/IDR -> sol_idr
          const correctId = `${market.base.toLowerCase()}_${market.quote.toLowerCase()}`;
          if (market.id !== correctId) {
            market.id = correctId;
          }
        }
      }

      this.marketsLoaded = true;
    }
  }

  /**
   * Get list of available trading pairs
   */
  getAvailableSymbols(): string[] {
    return Object.keys(this.exchange.markets || {});
  }

  async getTradingPairs(): Promise<TradingPair[]> {
    await this.loadMarkets();
    const markets = this.exchange.markets;
    const pairs: TradingPair[] = [];

    for (const [symbol, market] of Object.entries(markets)) {
      if (!market) continue;
      pairs.push({
        symbol,
        base: String(market.base || ''),
        quote: String(market.quote || ''),
        active: Boolean(market.active ?? true),
      });
    }

    return pairs.filter((p) => p.active);
  }

  async fetchOHLCV(
    symbol: string,
    timeframe: string = '15m',
    limit: number = 100,
    since?: number
  ): Promise<Candle[]> {
    await this.loadMarkets();

    // Normalize symbol
    const normalizedSymbol = this.normalizeSymbol(symbol);

    const ohlcv: OHLCV[] = await this.exchange.fetchOHLCV(normalizedSymbol, timeframe, since, limit);

    return ohlcv.map((candle) => ({
      timestamp: candle[0] as number,
      open: candle[1] as number,
      high: candle[2] as number,
      low: candle[3] as number,
      close: candle[4] as number,
      volume: candle[5] as number,
    }));
  }

  async fetchTicker(symbol: string): Promise<{
    last: number;
    bid: number;
    ask: number;
    volume: number;
    timestamp: number;
  }> {
    await this.loadMarkets();

    // Normalize symbol
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Validate symbol exists
    if (!(normalizedSymbol in this.exchange.markets)) {
      throw new Error(`Invalid trading pair: ${symbol}`);
    }

    const ticker = await this.exchange.fetchTicker(normalizedSymbol);

    return {
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      volume: ticker.baseVolume ?? 0,
      timestamp: ticker.timestamp ?? Date.now(),
    };
  }

  async fetchAllTickers(): Promise<Map<string, { last: number; volume: number }>> {
    await this.loadMarkets();
    const tickers = await this.exchange.fetchTickers();
    const result = new Map<string, { last: number; volume: number }>();

    for (const [symbol, ticker] of Object.entries(tickers)) {
      result.set(symbol, {
        last: ticker.last ?? 0,
        volume: ticker.baseVolume ?? 0,
      });
    }

    return result;
  }

  getAvailableTimeframes(): string[] {
    return Object.keys(this.exchange.timeframes || {});
  }

  /**
   * Fetch order book for a symbol
   */
  async fetchOrderBook(symbol: string, limit: number = 20): Promise<{
    bids: [number, number][];  // [price, volume]
    asks: [number, number][];
    timestamp: number;
  }> {
    await this.loadMarkets();

    // Normalize symbol
    const normalizedSymbol = this.normalizeSymbol(symbol);

    const orderBook = await this.exchange.fetchOrderBook(normalizedSymbol, limit);

    return {
      bids: orderBook.bids as [number, number][],
      asks: orderBook.asks as [number, number][],
      timestamp: orderBook.timestamp || Date.now(),
    };
  }

  // ============================================
  // Trading Methods (require API credentials)
  // ============================================

  /**
   * Validate and normalize symbol format
   */
  private normalizeSymbol(symbol: string): string {
    // Ensure symbol is in correct format (e.g., BTC/IDR)
    if (!symbol.includes('/')) {
      // Try to add slash before common quote currencies
      if (symbol.toUpperCase().endsWith('IDR')) {
        return symbol.slice(0, -3).toUpperCase() + '/IDR';
      }
      if (symbol.toUpperCase().endsWith('USDT')) {
        return symbol.slice(0, -4).toUpperCase() + '/USDT';
      }
    }
    return symbol.toUpperCase();
  }

  /**
   * Convert symbol to Indodax API pair format (e.g., SOL/IDR -> sol_idr)
   * Note: Indodax private API expects underscore-separated lowercase pairs
   */
  private toApiPair(symbol: string): string {
    const parts = symbol.split('/');
    if (parts.length === 2) {
      return `${parts[0].toLowerCase()}_${parts[1].toLowerCase()}`;
    }
    return symbol.toLowerCase();
  }

  /**
   * Check if a symbol is valid in the markets
   */
  async isValidSymbol(symbol: string): Promise<boolean> {
    await this.loadMarkets();
    const normalized = this.normalizeSymbol(symbol);
    return normalized in this.exchange.markets;
  }

  /**
   * Create a market or limit order
   */
  async createOrder(
    symbol: string,
    type: 'market' | 'limit',
    side: 'buy' | 'sell',
    amount: number,
    price?: number
  ): Promise<ExchangeOrder> {
    if (!this.hasCredentials()) {
      throw new Error('API credentials required for trading');
    }

    await this.loadMarkets();

    // Normalize symbol
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Validate symbol exists
    if (!(normalizedSymbol in this.exchange.markets)) {
      const availableSymbols = this.getAvailableSymbols().slice(0, 10).join(', ');
      throw new Error(`Invalid trading pair: ${symbol} (normalized: ${normalizedSymbol}). Some available pairs: ${availableSymbols}`);
    }

    try {
      // Get market info for the symbol
      const market = this.exchange.market(normalizedSymbol);

      // Check minimum amount
      const minAmount = market.limits?.amount?.min || 0;
      if (amount < minAmount) {
        throw new Error(`Amount ${amount} is below minimum ${minAmount} for ${normalizedSymbol}`);
      }

      console.log(`[Indodax] Creating ${type} ${side} order: ${normalizedSymbol} amount=${amount} price=${price || 'market'}`);

      const order = await this.exchange.createOrder(
        normalizedSymbol,
        type,
        side,
        amount,
        type === 'limit' ? price : undefined
      );

      console.log(`[Indodax] Order created: ${order.id}`);

      return {
        id: order.id,
        symbol: order.symbol,
        side: order.side as 'buy' | 'sell',
        type: order.type as 'market' | 'limit',
        price: order.price || undefined,
        amount: order.amount || 0,
        filled: order.filled || 0,
        remaining: order.remaining || 0,
        status: order.status as 'open' | 'closed' | 'canceled',
        fee: order.fee ? { cost: order.fee.cost || 0, currency: order.fee.currency || '' } : undefined,
        timestamp: order.timestamp || Date.now(),
      };
    } catch (error: any) {
      // Parse CCXT/Indodax error for better message
      const errorMessage = error?.message || String(error);
      console.error(`[Indodax] Order failed: ${errorMessage}`);

      if (errorMessage.includes('Invalid pair')) {
        // Check if it's a market ID issue
        const market = this.exchange.markets[normalizedSymbol];
        const marketId = market?.id || 'unknown';
        throw new Error(`Trading pair ${normalizedSymbol} (market id: ${marketId}) failed. The pair may not support ${type} orders.`);
      }
      throw error;
    }
  }

  /**
   * Create a market buy order
   */
  async marketBuy(symbol: string, amount: number): Promise<ExchangeOrder> {
    return this.createOrder(symbol, 'market', 'buy', amount);
  }

  /**
   * Create a market sell order
   */
  async marketSell(symbol: string, amount: number): Promise<ExchangeOrder> {
    return this.createOrder(symbol, 'market', 'sell', amount);
  }

  /**
   * Create a limit buy order
   */
  async limitBuy(symbol: string, amount: number, price: number): Promise<ExchangeOrder> {
    return this.createOrder(symbol, 'limit', 'buy', amount, price);
  }

  /**
   * Create a limit sell order
   */
  async limitSell(symbol: string, amount: number, price: number): Promise<ExchangeOrder> {
    return this.createOrder(symbol, 'limit', 'sell', amount, price);
  }

  /**
   * Cancel an open order
   */
  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    if (!this.hasCredentials()) {
      throw new Error('API credentials required for trading');
    }

    await this.loadMarkets();

    try {
      await this.exchange.cancelOrder(orderId, symbol);
      return true;
    } catch (error) {
      console.error('Failed to cancel order:', error);
      return false;
    }
  }

  /**
   * Fetch a specific order by ID
   */
  async fetchOrder(orderId: string, symbol: string): Promise<ExchangeOrder | null> {
    if (!this.hasCredentials()) {
      throw new Error('API credentials required for trading');
    }

    await this.loadMarkets();

    try {
      const order = await this.exchange.fetchOrder(orderId, symbol);

      return {
        id: order.id,
        symbol: order.symbol,
        side: order.side as 'buy' | 'sell',
        type: order.type as 'market' | 'limit',
        price: order.price || undefined,
        amount: order.amount || 0,
        filled: order.filled || 0,
        remaining: order.remaining || 0,
        status: order.status as 'open' | 'closed' | 'canceled',
        fee: order.fee ? { cost: order.fee.cost || 0, currency: order.fee.currency || '' } : undefined,
        timestamp: order.timestamp || Date.now(),
      };
    } catch (error) {
      console.error('Failed to fetch order:', error);
      return null;
    }
  }

  /**
   * Fetch all open orders
   */
  async fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    if (!this.hasCredentials()) {
      throw new Error('API credentials required for trading');
    }

    await this.loadMarkets();

    const orders = await this.exchange.fetchOpenOrders(symbol);

    return orders.map(order => ({
      id: order.id,
      symbol: order.symbol,
      side: order.side as 'buy' | 'sell',
      type: order.type as 'market' | 'limit',
      price: order.price || undefined,
      amount: order.amount || 0,
      filled: order.filled || 0,
      remaining: order.remaining || 0,
      status: order.status as 'open' | 'closed' | 'canceled',
      fee: order.fee ? { cost: order.fee.cost || 0, currency: order.fee.currency || '' } : undefined,
      timestamp: order.timestamp || Date.now(),
    }));
  }

  /**
   * Fetch account balances
   */
  async fetchBalance(): Promise<ExchangeBalance[]> {
    if (!this.hasCredentials()) {
      throw new Error('API credentials required for trading');
    }

    await this.loadMarkets();

    const balances = await this.exchange.fetchBalance();
    const result: ExchangeBalance[] = [];

    // CCXT returns balances in a specific format
    const totalBalances = (balances.total as unknown as Record<string, number>) || {};
    const freeBalances = (balances.free as unknown as Record<string, number>) || {};
    const usedBalances = (balances.used as unknown as Record<string, number>) || {};

    for (const currency of Object.keys(totalBalances)) {
      const total = totalBalances[currency] || 0;
      const free = freeBalances[currency] || 0;
      const used = usedBalances[currency] || 0;

      // Only include non-zero balances
      if (total > 0) {
        result.push({
          currency,
          free,
          used,
          total,
        });
      }
    }

    return result;
  }

  /**
   * Fetch balance for a specific currency
   */
  async fetchBalanceForCurrency(currency: string): Promise<ExchangeBalance | null> {
    const balances = await this.fetchBalance();
    return balances.find(b => b.currency.toUpperCase() === currency.toUpperCase()) || null;
  }

  /**
   * Fetch recent trades for account
   */
  async fetchMyTrades(symbol: string, limit: number = 50): Promise<ExchangeTrade[]> {
    if (!this.hasCredentials()) {
      throw new Error('API credentials required for trading');
    }

    await this.loadMarkets();

    const trades = await this.exchange.fetchMyTrades(symbol, undefined, limit);

    return trades.map(trade => ({
      id: String(trade.id || ''),
      symbol: String(trade.symbol || ''),
      side: trade.side as 'buy' | 'sell',
      price: trade.price || 0,
      amount: trade.amount || 0,
      cost: trade.cost || 0,
      fee: trade.fee ? { cost: trade.fee.cost || 0, currency: trade.fee.currency || '' } : undefined,
      timestamp: trade.timestamp || Date.now(),
    }));
  }

  /**
   * Calculate minimum order amount for a symbol
   */
  async getMinOrderAmount(symbol: string): Promise<number> {
    await this.loadMarkets();
    const market = this.exchange.market(symbol);
    return market.limits?.amount?.min || 0;
  }

  /**
   * Calculate order value in IDR
   */
  async calculateOrderValue(symbol: string, amount: number): Promise<number> {
    const ticker = await this.fetchTicker(symbol);
    return amount * ticker.last;
  }
}

export default new IndodaxExchange();
