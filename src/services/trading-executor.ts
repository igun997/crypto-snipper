/**
 * Trading Executor Service
 * Handles order execution and position management with Indodax
 */

import { EventEmitter } from 'events';
import { IndodaxExchange, ExchangeOrder, ExchangeBalance } from '../exchange/indodax.js';
import { telegramAccountRepo } from '../database/repositories/telegram-accounts.js';
import { orderRepo } from '../database/repositories/orders.js';
import { Order, Position, OrderType, OrderSide, TradingAccount } from '../types/index.js';
import { ScalpSignal } from './scalper.js';

export interface ExecutionResult {
  success: boolean;
  orderId?: number;
  exchangeOrderId?: string;
  error?: string;
  order?: Order;
  position?: Position;
}

export interface BalanceResult {
  success: boolean;
  balances?: ExchangeBalance[];
  error?: string;
}

export class TradingExecutor extends EventEmitter {
  private exchangeCache: Map<number, IndodaxExchange> = new Map();

  /**
   * Get or create exchange instance for an account
   */
  private async getExchange(accountId: number): Promise<IndodaxExchange | null> {
    // Check cache first
    if (this.exchangeCache.has(accountId)) {
      return this.exchangeCache.get(accountId)!;
    }

    // Get decrypted credentials
    const credentials = telegramAccountRepo.getDecryptedCredentials(accountId);
    if (!credentials) {
      console.error(`Failed to get credentials for account ${accountId}`);
      return null;
    }

    // Create new exchange instance
    const exchange = IndodaxExchange.createWithCredentials(
      credentials.apiKey,
      credentials.apiSecret
    );

    // Cache it
    this.exchangeCache.set(accountId, exchange);

    return exchange;
  }

  /**
   * Clear exchange cache for an account
   */
  clearCache(accountId?: number): void {
    if (accountId) {
      this.exchangeCache.delete(accountId);
    } else {
      this.exchangeCache.clear();
    }
  }

  /**
   * Execute a market order
   */
  async executeMarketOrder(
    accountId: number,
    symbol: string,
    side: OrderSide,
    amount: number
  ): Promise<ExecutionResult> {
    try {
      const exchange = await this.getExchange(accountId);
      if (!exchange) {
        return { success: false, error: 'Failed to get exchange credentials' };
      }

      // Execute order on exchange
      const exchangeOrder = await exchange.createOrder(symbol, 'market', side, amount);

      // Store order in database
      const orderId = orderRepo.createOrder({
        account_id: accountId,
        exchange_order_id: exchangeOrder.id,
        symbol,
        side,
        order_type: 'market',
        amount,
        status: exchangeOrder.status === 'closed' ? 'filled' : 'open',
        filled_amount: exchangeOrder.filled,
        filled_price: exchangeOrder.price,
        fee: exchangeOrder.fee?.cost || 0,
      });

      const order = orderRepo.getOrderById(orderId);

      this.emit('order:executed', order);

      return {
        success: true,
        orderId,
        exchangeOrderId: exchangeOrder.id,
        order: order!,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Store failed order
      const orderId = orderRepo.createOrder({
        account_id: accountId,
        symbol,
        side,
        order_type: 'market',
        amount,
        status: 'failed',
        filled_amount: 0,
        fee: 0,
        error_message: errorMessage,
      });

      this.emit('order:failed', { orderId, error: errorMessage });

      return { success: false, orderId, error: errorMessage };
    }
  }

  /**
   * Execute a limit order
   */
  async executeLimitOrder(
    accountId: number,
    symbol: string,
    side: OrderSide,
    amount: number,
    price: number
  ): Promise<ExecutionResult> {
    try {
      const exchange = await this.getExchange(accountId);
      if (!exchange) {
        return { success: false, error: 'Failed to get exchange credentials' };
      }

      // Execute order on exchange
      const exchangeOrder = await exchange.createOrder(symbol, 'limit', side, amount, price);

      // Store order in database
      const orderId = orderRepo.createOrder({
        account_id: accountId,
        exchange_order_id: exchangeOrder.id,
        symbol,
        side,
        order_type: 'limit',
        amount,
        price,
        status: exchangeOrder.status === 'closed' ? 'filled' : 'open',
        filled_amount: exchangeOrder.filled,
        filled_price: exchangeOrder.price,
        fee: exchangeOrder.fee?.cost || 0,
      });

      const order = orderRepo.getOrderById(orderId);

      this.emit('order:executed', order);

      return {
        success: true,
        orderId,
        exchangeOrderId: exchangeOrder.id,
        order: order!,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const orderId = orderRepo.createOrder({
        account_id: accountId,
        symbol,
        side,
        order_type: 'limit',
        amount,
        price,
        status: 'failed',
        filled_amount: 0,
        fee: 0,
        error_message: errorMessage,
      });

      this.emit('order:failed', { orderId, error: errorMessage });

      return { success: false, orderId, error: errorMessage };
    }
  }

  /**
   * Execute a scalp signal (entry with TP/SL)
   */
  async executeScalpSignal(
    accountId: number,
    signal: ScalpSignal,
    amountPercent: number = 10
  ): Promise<ExecutionResult> {
    try {
      const exchange = await this.getExchange(accountId);
      if (!exchange) {
        return { success: false, error: 'Failed to get exchange credentials' };
      }

      // Get balance to calculate position size
      const [base, quote] = signal.symbol.split('/');
      const balances = await exchange.fetchBalance();

      let tradeAmount: number;

      if (signal.direction === 'long') {
        // For long, we need quote currency (IDR) to buy
        const quoteBalance = balances.find(b => b.currency === quote);
        if (!quoteBalance || quoteBalance.free <= 0) {
          return { success: false, error: `Insufficient ${quote} balance` };
        }

        // Calculate amount based on percentage of balance
        const tradeValue = quoteBalance.free * (amountPercent / 100);
        tradeAmount = tradeValue / signal.price;
      } else {
        // For short, we need base currency to sell
        const baseBalance = balances.find(b => b.currency === base);
        if (!baseBalance || baseBalance.free <= 0) {
          return { success: false, error: `Insufficient ${base} balance` };
        }

        tradeAmount = baseBalance.free * (amountPercent / 100);
      }

      // Check minimum order amount
      const minAmount = await exchange.getMinOrderAmount(signal.symbol);
      if (tradeAmount < minAmount) {
        return { success: false, error: `Amount ${tradeAmount} below minimum ${minAmount}` };
      }

      // Execute entry order
      const side: OrderSide = signal.direction === 'long' ? 'buy' : 'sell';
      const exchangeOrder = await exchange.createOrder(signal.symbol, 'market', side, tradeAmount);

      // Store entry order
      const orderId = orderRepo.createOrder({
        account_id: accountId,
        exchange_order_id: exchangeOrder.id,
        symbol: signal.symbol,
        side,
        order_type: 'market',
        amount: tradeAmount,
        status: exchangeOrder.status === 'closed' ? 'filled' : 'open',
        filled_amount: exchangeOrder.filled,
        filled_price: exchangeOrder.price,
        fee: exchangeOrder.fee?.cost || 0,
      });

      // Create position
      const positionId = orderRepo.createPosition({
        account_id: accountId,
        symbol: signal.symbol,
        side: signal.direction,
        entry_order_id: orderId,
        entry_price: exchangeOrder.price || signal.price,
        amount: exchangeOrder.filled || tradeAmount,
        take_profit_price: signal.takeProfit,
        stop_loss_price: signal.stopLoss,
        status: 'open',
      });

      const position = orderRepo.getPositionById(positionId);

      this.emit('position:opened', position);

      return {
        success: true,
        orderId,
        exchangeOrderId: exchangeOrder.id,
        order: orderRepo.getOrderById(orderId)!,
        position: position!,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('scalp:failed', { signal, error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Close a position
   */
  async closePosition(
    positionId: number,
    price?: number
  ): Promise<ExecutionResult> {
    try {
      const position = orderRepo.getPositionById(positionId);
      if (!position) {
        return { success: false, error: 'Position not found' };
      }

      if (position.status === 'closed') {
        return { success: false, error: 'Position already closed' };
      }

      const exchange = await this.getExchange(position.account_id);
      if (!exchange) {
        return { success: false, error: 'Failed to get exchange credentials' };
      }

      // Close position (opposite side)
      const side: OrderSide = position.side === 'long' ? 'sell' : 'buy';
      const orderType = price ? 'limit' : 'market';

      const exchangeOrder = await exchange.createOrder(
        position.symbol,
        orderType,
        side,
        position.amount,
        price
      );

      // Store exit order
      const orderId = orderRepo.createOrder({
        account_id: position.account_id,
        exchange_order_id: exchangeOrder.id,
        symbol: position.symbol,
        side,
        order_type: orderType,
        amount: position.amount,
        price,
        status: exchangeOrder.status === 'closed' ? 'filled' : 'open',
        filled_amount: exchangeOrder.filled,
        filled_price: exchangeOrder.price,
        fee: exchangeOrder.fee?.cost || 0,
      });

      // Calculate P/L
      const exitPrice = exchangeOrder.price || price || 0;
      const pnlPercent = position.side === 'long'
        ? ((exitPrice - position.entry_price) / position.entry_price) * 100
        : ((position.entry_price - exitPrice) / position.entry_price) * 100;

      const pnlIdr = (pnlPercent / 100) * position.amount * position.entry_price;

      // Close position in database
      orderRepo.closePosition(positionId, exitPrice, pnlPercent, pnlIdr);

      const closedPosition = orderRepo.getPositionById(positionId);

      this.emit('position:closed', closedPosition);

      return {
        success: true,
        orderId,
        exchangeOrderId: exchangeOrder.id,
        order: orderRepo.getOrderById(orderId)!,
        position: closedPosition!,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: number): Promise<{ success: boolean; error?: string }> {
    try {
      const order = orderRepo.getOrderById(orderId);
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      if (!order.exchange_order_id) {
        return { success: false, error: 'No exchange order ID' };
      }

      const exchange = await this.getExchange(order.account_id);
      if (!exchange) {
        return { success: false, error: 'Failed to get exchange credentials' };
      }

      const success = await exchange.cancelOrder(order.exchange_order_id, order.symbol);

      if (success) {
        orderRepo.updateOrder(orderId, { status: 'cancelled' });
        this.emit('order:cancelled', order);
      }

      return { success };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get account balance
   */
  async getBalance(accountId: number): Promise<BalanceResult> {
    try {
      const exchange = await this.getExchange(accountId);
      if (!exchange) {
        return { success: false, error: 'Failed to get exchange credentials' };
      }

      const balances = await exchange.fetchBalance();

      return { success: true, balances };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Update take profit price for a position
   */
  async updateTakeProfit(positionId: number, newPrice: number): Promise<{ success: boolean; error?: string }> {
    try {
      const position = orderRepo.getPositionById(positionId);
      if (!position) {
        return { success: false, error: 'Position not found' };
      }

      orderRepo.updatePosition(positionId, { take_profit_price: newPrice });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Update stop loss price for a position
   */
  async updateStopLoss(positionId: number, newPrice: number): Promise<{ success: boolean; error?: string }> {
    try {
      const position = orderRepo.getPositionById(positionId);
      if (!position) {
        return { success: false, error: 'Position not found' };
      }

      orderRepo.updatePosition(positionId, { stop_loss_price: newPrice });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Sync order status with exchange
   */
  async syncOrderStatus(orderId: number): Promise<{ success: boolean; error?: string }> {
    try {
      const order = orderRepo.getOrderById(orderId);
      if (!order || !order.exchange_order_id) {
        return { success: false, error: 'Order not found or no exchange ID' };
      }

      const exchange = await this.getExchange(order.account_id);
      if (!exchange) {
        return { success: false, error: 'Failed to get exchange credentials' };
      }

      const exchangeOrder = await exchange.fetchOrder(order.exchange_order_id, order.symbol);
      if (!exchangeOrder) {
        return { success: false, error: 'Order not found on exchange' };
      }

      // Map exchange status to our status
      let status: Order['status'] = order.status;
      if (exchangeOrder.status === 'closed') {
        status = 'filled';
      } else if (exchangeOrder.status === 'canceled') {
        status = 'cancelled';
      } else if (exchangeOrder.filled > 0 && exchangeOrder.remaining > 0) {
        status = 'partial';
      }

      orderRepo.updateOrder(orderId, {
        status,
        filled_amount: exchangeOrder.filled,
        filled_price: exchangeOrder.price,
        fee: exchangeOrder.fee?.cost || 0,
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }
}

export const tradingExecutor = new TradingExecutor();
export default tradingExecutor;
