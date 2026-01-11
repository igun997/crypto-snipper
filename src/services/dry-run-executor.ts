/**
 * Dry Run Executor Service
 * Simulates trading with virtual balance for testing strategies
 */

import { EventEmitter } from 'events';
import { getDatabase } from '../database/connection.js';
import { orderRepo } from '../database/repositories/orders.js';
import priceRepo from '../database/repositories/prices.js';
import realtimeFetcher from './realtime-fetcher.js';
import { Order, Position, OrderSide } from '../types/index.js';
import { ScalpSignal } from './scalper.js';

export interface DryRunBalance {
  currency: string;
  balance: number;
}

export interface DryRunExecutionResult {
  success: boolean;
  orderId?: number;
  error?: string;
  order?: Order;
  position?: Position;
}

export interface DryRunStats {
  initialBalance: number;
  currentBalance: number;
  pnlPercent: number;
  pnlIdr: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
}

export class DryRunExecutor extends EventEmitter {
  private defaultBalance: number = 10000000; // 10 million IDR

  constructor() {
    super();
    this.initializeTable();
  }

  /**
   * Initialize dry_run_balances table if not exists
   */
  private initializeTable(): void {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS dry_run_balances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        currency TEXT NOT NULL,
        balance REAL NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, currency)
      )
    `);
  }

  /**
   * Initialize virtual balance for an account
   */
  async initialize(accountId: number, idrAmount: number = this.defaultBalance): Promise<void> {
    const db = getDatabase();

    // Set IDR balance
    db.prepare(`
      INSERT INTO dry_run_balances (account_id, currency, balance)
      VALUES (?, 'IDR', ?)
      ON CONFLICT(account_id, currency) DO UPDATE SET balance = ?, updated_at = CURRENT_TIMESTAMP
    `).run(accountId, idrAmount, idrAmount);

    this.emit('balance:initialized', { accountId, balance: idrAmount });
  }

  /**
   * Get virtual balance for an account
   */
  getBalance(accountId: number): DryRunBalance[] {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT currency, balance FROM dry_run_balances WHERE account_id = ?
    `).all(accountId) as Array<{ currency: string; balance: number }>;

    return rows.map(r => ({ currency: r.currency, balance: r.balance }));
  }

  /**
   * Get balance for a specific currency
   */
  getCurrencyBalance(accountId: number, currency: string): number {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT balance FROM dry_run_balances WHERE account_id = ? AND currency = ?
    `).get(accountId, currency) as { balance: number } | undefined;

    return row?.balance || 0;
  }

  /**
   * Update balance for a currency
   */
  private updateBalance(accountId: number, currency: string, newBalance: number): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO dry_run_balances (account_id, currency, balance)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id, currency) DO UPDATE SET balance = ?, updated_at = CURRENT_TIMESTAMP
    `).run(accountId, currency, newBalance, newBalance);
  }

  /**
   * Get current price from cache or database (no API calls)
   */
  private getCurrentPrice(symbol: string): number | null {
    // First try realtime cache
    const realtimePrice = realtimeFetcher.getPrice(symbol);
    if (realtimePrice && realtimePrice.price > 0) {
      return realtimePrice.price;
    }

    // Fallback to latest price in database
    const prices = priceRepo.getLatestPrices(symbol, 1);
    if (prices.length > 0) {
      return prices[0].close;
    }

    return null;
  }

  /**
   * Execute a dry run market order
   */
  async executeMarketOrder(
    accountId: number,
    symbol: string,
    side: OrderSide,
    amount: number,
    signalPrice?: number
  ): Promise<DryRunExecutionResult> {
    try {
      // Ensure account has initial balance
      const idrBalance = this.getCurrencyBalance(accountId, 'IDR');
      if (idrBalance === 0) {
        await this.initialize(accountId);
      }

      // Get current price from cache (no API call)
      const cachedPrice = this.getCurrentPrice(symbol);
      const price = signalPrice || cachedPrice;

      if (!price || price <= 0) {
        return { success: false, error: `No price data available for ${symbol}. Subscribe to symbol first.` };
      }
      const [base, quote] = symbol.split('/');

      // Calculate trade value
      const tradeValue = amount * price;
      const fee = tradeValue * 0.003; // 0.3% fee simulation

      if (side === 'buy') {
        // Check IDR balance
        const availableIdr = this.getCurrencyBalance(accountId, quote);
        if (availableIdr < tradeValue + fee) {
          return { success: false, error: `Insufficient ${quote} balance (need ${tradeValue + fee}, have ${availableIdr})` };
        }

        // Deduct IDR, add crypto
        this.updateBalance(accountId, quote, availableIdr - tradeValue - fee);
        const cryptoBalance = this.getCurrencyBalance(accountId, base);
        this.updateBalance(accountId, base, cryptoBalance + amount);
      } else {
        // Check crypto balance
        const availableCrypto = this.getCurrencyBalance(accountId, base);
        if (availableCrypto < amount) {
          return { success: false, error: `Insufficient ${base} balance (need ${amount}, have ${availableCrypto})` };
        }

        // Deduct crypto, add IDR
        this.updateBalance(accountId, base, availableCrypto - amount);
        const idrBalanceNow = this.getCurrencyBalance(accountId, quote);
        this.updateBalance(accountId, quote, idrBalanceNow + tradeValue - fee);
      }

      // Record order in database
      const orderId = orderRepo.createOrder({
        account_id: accountId,
        exchange_order_id: `DRY_${Date.now()}`,
        symbol,
        side,
        order_type: 'market',
        amount,
        price,
        status: 'filled',
        filled_amount: amount,
        filled_price: price,
        fee,
        is_dry_run: 1,
      });

      const order = orderRepo.getOrderById(orderId);

      this.emit('order:executed', order);

      return {
        success: true,
        orderId,
        order: order!,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Execute a dry run scalp signal
   */
  async executeScalpSignal(
    accountId: number,
    signal: ScalpSignal,
    amountPercent: number = 10
  ): Promise<DryRunExecutionResult> {
    try {
      // Ensure balance initialized
      let idrBalance = this.getCurrencyBalance(accountId, 'IDR');
      if (idrBalance === 0) {
        await this.initialize(accountId);
        idrBalance = this.defaultBalance;
      }

      const [base, quote] = signal.symbol.split('/');
      let tradeAmount: number;

      if (signal.direction === 'long') {
        // Calculate amount based on percentage of IDR balance
        const tradeValue = idrBalance * (amountPercent / 100);
        tradeAmount = tradeValue / signal.price;
      } else {
        // For short in dry run, simulate having crypto to sell
        // Use IDR value equivalent to calculate virtual crypto amount
        const tradeValue = idrBalance * (amountPercent / 100);
        tradeAmount = tradeValue / signal.price;

        // Give virtual crypto balance for the short
        const currentCryptoBalance = this.getCurrencyBalance(accountId, base);
        if (currentCryptoBalance < tradeAmount) {
          this.updateBalance(accountId, base, tradeAmount);
        }
      }

      // Execute entry (use signal price to avoid API calls)
      const side: OrderSide = signal.direction === 'long' ? 'buy' : 'sell';
      const entryResult = await this.executeMarketOrder(accountId, signal.symbol, side, tradeAmount, signal.price);

      if (!entryResult.success) {
        return entryResult;
      }

      // Create position
      const positionId = orderRepo.createPosition({
        account_id: accountId,
        symbol: signal.symbol,
        side: signal.direction,
        entry_order_id: entryResult.orderId!,
        entry_price: signal.price,
        amount: tradeAmount,
        take_profit_price: signal.takeProfit,
        stop_loss_price: signal.stopLoss,
        status: 'open',
        is_dry_run: 1,
      });

      const position = orderRepo.getPositionById(positionId);

      this.emit('position:opened', position);

      return {
        success: true,
        orderId: entryResult.orderId,
        order: entryResult.order,
        position: position!,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Close a dry run position
   */
  async closePosition(positionId: number): Promise<DryRunExecutionResult> {
    try {
      const position = orderRepo.getPositionById(positionId);
      if (!position) {
        return { success: false, error: 'Position not found' };
      }

      if ((position as any).is_dry_run !== 1) {
        return { success: false, error: 'Not a dry run position' };
      }

      if (position.status === 'closed') {
        return { success: false, error: 'Position already closed' };
      }

      // Get current price from cache (no API call)
      const exitPrice = this.getCurrentPrice(position.symbol);
      if (!exitPrice || exitPrice <= 0) {
        return { success: false, error: `No price data available for ${position.symbol}` };
      }

      // Execute exit order
      const side: OrderSide = position.side === 'long' ? 'sell' : 'buy';
      const exitResult = await this.executeMarketOrder(
        position.account_id,
        position.symbol,
        side,
        position.amount,
        exitPrice
      );

      if (!exitResult.success) {
        return exitResult;
      }

      // Calculate P/L
      const pnlPercent = position.side === 'long'
        ? ((exitPrice - position.entry_price) / position.entry_price) * 100
        : ((position.entry_price - exitPrice) / position.entry_price) * 100;

      const pnlIdr = (pnlPercent / 100) * position.amount * position.entry_price;

      // Close position
      orderRepo.closePosition(positionId, exitPrice, pnlPercent, pnlIdr);

      const closedPosition = orderRepo.getPositionById(positionId);

      this.emit('position:closed', closedPosition);

      return {
        success: true,
        orderId: exitResult.orderId,
        order: exitResult.order,
        position: closedPosition!,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get dry run statistics for an account
   */
  async getStats(accountId: number): Promise<DryRunStats> {
    const idrBalance = this.getCurrencyBalance(accountId, 'IDR');
    const currentBalance = idrBalance > 0 ? idrBalance : this.defaultBalance;

    // Get all dry run positions
    const positions = orderRepo.getClosedPositions(accountId, 1000)
      .filter(p => (p as any).is_dry_run === 1);

    const wins = positions.filter(p => (p.pnl_idr ?? 0) > 0).length;
    const losses = positions.filter(p => (p.pnl_idr ?? 0) <= 0).length;
    const totalPnl = positions.reduce((sum, p) => sum + (p.pnl_idr ?? 0), 0);

    return {
      initialBalance: this.defaultBalance,
      currentBalance,
      pnlPercent: ((currentBalance - this.defaultBalance) / this.defaultBalance) * 100,
      pnlIdr: totalPnl,
      totalTrades: positions.length,
      wins,
      losses,
      winRate: positions.length > 0 ? (wins / positions.length) * 100 : 0,
    };
  }

  /**
   * Reset dry run balance for an account
   */
  async reset(accountId: number, newBalance?: number): Promise<void> {
    const db = getDatabase();

    // Clear all balances for this account
    db.prepare('DELETE FROM dry_run_balances WHERE account_id = ?').run(accountId);

    // Re-initialize with new balance
    await this.initialize(accountId, newBalance || this.defaultBalance);

    this.emit('balance:reset', { accountId, balance: newBalance || this.defaultBalance });
  }
}

export const dryRunExecutor = new DryRunExecutor();
export default dryRunExecutor;
