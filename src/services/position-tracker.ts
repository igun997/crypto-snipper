/**
 * Position Tracker Service
 * Monitors open positions for TP/SL hits and auto-closes them
 */

import { EventEmitter } from 'events';
import { orderRepo } from '../database/repositories/orders.js';
import { tradingExecutor } from './trading-executor.js';
import { Position } from '../types/index.js';
import realtimeFetcher, { RealtimePrice } from './realtime-fetcher.js';
import indodax from '../exchange/indodax.js';

export interface PositionUpdate {
  position: Position;
  currentPrice: number;
  pnlPercent: number;
  pnlIdr: number;
  hitTp: boolean;
  hitSl: boolean;
}

export class PositionTracker extends EventEmitter {
  private isRunning: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private subscribedSymbols: Set<string> = new Set();
  private lastPrices: Map<string, number> = new Map();

  /**
   * Start tracking positions
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('  [PositionTracker] Starting position monitoring...');

    // Subscribe to realtime price updates
    realtimeFetcher.on('price', this.handlePriceUpdate.bind(this));

    // Also run periodic checks as fallback
    this.checkInterval = setInterval(() => {
      this.checkAllPositions();
    }, 5000); // Check every 5 seconds

    // Initial subscription to symbols with open positions
    await this.updateSubscriptions();
  }

  /**
   * Stop tracking positions
   */
  stop(): void {
    this.isRunning = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    realtimeFetcher.off('price', this.handlePriceUpdate.bind(this));

    // Unsubscribe from all symbols
    for (const symbol of this.subscribedSymbols) {
      realtimeFetcher.unsubscribe(symbol);
    }
    this.subscribedSymbols.clear();

    console.log('  [PositionTracker] Stopped position monitoring');
  }

  /**
   * Handle realtime price updates
   */
  private async handlePriceUpdate(priceData: RealtimePrice): Promise<void> {
    if (!this.isRunning) return;

    const { symbol, price } = priceData;
    this.lastPrices.set(symbol, price);

    // Check positions for this symbol
    await this.checkPositionsForSymbol(symbol, price);
  }

  /**
   * Check all open positions (fallback method)
   */
  private async checkAllPositions(): Promise<void> {
    if (!this.isRunning) return;

    const positions = orderRepo.getAllOpenPositions();

    for (const position of positions) {
      let currentPrice = this.lastPrices.get(position.symbol);

      // If no realtime price, fetch from API
      if (!currentPrice) {
        try {
          const ticker = await indodax.fetchTicker(position.symbol);
          currentPrice = ticker.last;
          this.lastPrices.set(position.symbol, currentPrice);
        } catch (error) {
          console.error(`Failed to fetch price for ${position.symbol}:`, error);
          continue;
        }
      }

      await this.checkPosition(position, currentPrice);
    }

    // Update subscriptions
    await this.updateSubscriptions();
  }

  /**
   * Check positions for a specific symbol
   */
  private async checkPositionsForSymbol(symbol: string, currentPrice: number): Promise<void> {
    const positions = orderRepo.getAllOpenPositions(symbol);

    for (const position of positions) {
      await this.checkPosition(position, currentPrice);
    }
  }

  /**
   * Check a single position for TP/SL
   */
  private async checkPosition(position: Position, currentPrice: number): Promise<void> {
    if (position.status !== 'open') return;

    // Calculate current P/L
    const pnlPercent = position.side === 'long'
      ? ((currentPrice - position.entry_price) / position.entry_price) * 100
      : ((position.entry_price - currentPrice) / position.entry_price) * 100;

    const pnlIdr = (pnlPercent / 100) * position.amount * position.entry_price;

    // Check take profit
    let hitTp = false;
    if (position.take_profit_price) {
      if (position.side === 'long' && currentPrice >= position.take_profit_price) {
        hitTp = true;
      } else if (position.side === 'short' && currentPrice <= position.take_profit_price) {
        hitTp = true;
      }
    }

    // Check stop loss
    let hitSl = false;
    if (position.stop_loss_price) {
      if (position.side === 'long' && currentPrice <= position.stop_loss_price) {
        hitSl = true;
      } else if (position.side === 'short' && currentPrice >= position.stop_loss_price) {
        hitSl = true;
      }
    }

    // Emit position update
    const update: PositionUpdate = {
      position,
      currentPrice,
      pnlPercent,
      pnlIdr,
      hitTp,
      hitSl,
    };

    this.emit('position:update', update);

    // Auto-close if TP or SL hit
    if (hitTp || hitSl) {
      console.log(`  [PositionTracker] ${hitTp ? 'TP' : 'SL'} hit for position ${position.id} (${position.symbol})`);

      const result = await tradingExecutor.closePosition(position.id!);

      if (result.success) {
        this.emit('position:auto_closed', {
          ...update,
          reason: hitTp ? 'take_profit' : 'stop_loss',
          closedPosition: result.position,
        });
      } else {
        console.error(`  [PositionTracker] Failed to close position ${position.id}:`, result.error);
        this.emit('position:close_failed', {
          ...update,
          error: result.error,
        });
      }
    }
  }

  /**
   * Update symbol subscriptions based on open positions
   */
  private async updateSubscriptions(): Promise<void> {
    const positions = orderRepo.getAllOpenPositions();
    const requiredSymbols = new Set(positions.map(p => p.symbol));

    // Subscribe to new symbols
    for (const symbol of requiredSymbols) {
      if (!this.subscribedSymbols.has(symbol)) {
        try {
          await realtimeFetcher.subscribe(symbol);
          this.subscribedSymbols.add(symbol);
          console.log(`  [PositionTracker] Subscribed to ${symbol}`);
        } catch (error) {
          console.error(`  [PositionTracker] Failed to subscribe to ${symbol}:`, error);
        }
      }
    }

    // Unsubscribe from symbols no longer needed
    for (const symbol of this.subscribedSymbols) {
      if (!requiredSymbols.has(symbol)) {
        try {
          await realtimeFetcher.unsubscribe(symbol);
          this.subscribedSymbols.delete(symbol);
          console.log(`  [PositionTracker] Unsubscribed from ${symbol}`);
        } catch (error) {
          console.error(`  [PositionTracker] Failed to unsubscribe from ${symbol}:`, error);
        }
      }
    }
  }

  /**
   * Get current status of all open positions
   */
  async getPositionStatuses(): Promise<PositionUpdate[]> {
    const positions = orderRepo.getAllOpenPositions();
    const updates: PositionUpdate[] = [];

    for (const position of positions) {
      let currentPrice = this.lastPrices.get(position.symbol);

      if (!currentPrice) {
        try {
          const ticker = await indodax.fetchTicker(position.symbol);
          currentPrice = ticker.last;
        } catch {
          currentPrice = position.entry_price;
        }
      }

      const pnlPercent = position.side === 'long'
        ? ((currentPrice - position.entry_price) / position.entry_price) * 100
        : ((position.entry_price - currentPrice) / position.entry_price) * 100;

      const pnlIdr = (pnlPercent / 100) * position.amount * position.entry_price;

      let hitTp = false;
      let hitSl = false;

      if (position.take_profit_price) {
        hitTp = position.side === 'long'
          ? currentPrice >= position.take_profit_price
          : currentPrice <= position.take_profit_price;
      }

      if (position.stop_loss_price) {
        hitSl = position.side === 'long'
          ? currentPrice <= position.stop_loss_price
          : currentPrice >= position.stop_loss_price;
      }

      updates.push({
        position,
        currentPrice,
        pnlPercent,
        pnlIdr,
        hitTp,
        hitSl,
      });
    }

    return updates;
  }

  /**
   * Manually trigger a position check
   */
  async forceCheck(): Promise<void> {
    await this.checkAllPositions();
  }

  /**
   * Check if tracker is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get count of tracked positions
   */
  get positionCount(): number {
    return orderRepo.getAllOpenPositions().length;
  }
}

export const positionTracker = new PositionTracker();
export default positionTracker;
