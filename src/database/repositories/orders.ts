/**
 * Repository for orders and positions
 */

import { getDatabase } from '../connection.js';
import { Order, Position, OrderStatus, PositionStatus } from '../../types/index.js';

export class OrderRepository {
  // ============================================
  // Orders
  // ============================================

  /**
   * Create a new order
   */
  createOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'> & { is_dry_run?: number }): number {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO orders (
        account_id, exchange_order_id, symbol, side, order_type,
        amount, price, stop_price, status, filled_amount, filled_price, fee, error_message, is_dry_run
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      order.account_id,
      order.exchange_order_id || null,
      order.symbol,
      order.side,
      order.order_type,
      order.amount,
      order.price || null,
      order.stop_price || null,
      order.status,
      order.filled_amount,
      order.filled_price || null,
      order.fee,
      order.error_message || null,
      order.is_dry_run || 0
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get order by ID
   */
  getOrderById(id: number): Order | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM orders WHERE id = ?');
    return (stmt.get(id) as Order) || null;
  }

  /**
   * Get order by exchange order ID
   */
  getOrderByExchangeId(exchangeOrderId: string): Order | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM orders WHERE exchange_order_id = ?');
    return (stmt.get(exchangeOrderId) as Order) || null;
  }

  /**
   * Update order
   */
  updateOrder(id: number, updates: Partial<Order>): void {
    const db = getDatabase();
    const fields: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const values: unknown[] = [];

    if (updates.exchange_order_id !== undefined) {
      fields.push('exchange_order_id = ?');
      values.push(updates.exchange_order_id);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.filled_amount !== undefined) {
      fields.push('filled_amount = ?');
      values.push(updates.filled_amount);
    }
    if (updates.filled_price !== undefined) {
      fields.push('filled_price = ?');
      values.push(updates.filled_price);
    }
    if (updates.fee !== undefined) {
      fields.push('fee = ?');
      values.push(updates.fee);
    }
    if (updates.error_message !== undefined) {
      fields.push('error_message = ?');
      values.push(updates.error_message);
    }

    values.push(id);
    const sql = `UPDATE orders SET ${fields.join(', ')} WHERE id = ?`;
    const stmt = db.prepare(sql);
    stmt.run(...values);
  }

  /**
   * Get open orders for an account
   */
  getOpenOrders(accountId: number, symbol?: string): Order[] {
    const db = getDatabase();
    let sql = `
      SELECT * FROM orders
      WHERE account_id = ? AND status IN ('pending', 'open', 'partial')
    `;
    const params: unknown[] = [accountId];

    if (symbol) {
      sql += ' AND symbol = ?';
      params.push(symbol);
    }

    sql += ' ORDER BY created_at DESC';
    const stmt = db.prepare(sql);
    return stmt.all(...params) as Order[];
  }

  /**
   * Get order history for an account
   */
  getOrderHistory(accountId: number, limit: number = 50, symbol?: string): Order[] {
    const db = getDatabase();
    let sql = 'SELECT * FROM orders WHERE account_id = ?';
    const params: unknown[] = [accountId];

    if (symbol) {
      sql += ' AND symbol = ?';
      params.push(symbol);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(sql);
    return stmt.all(...params) as Order[];
  }

  /**
   * Get orders by status
   */
  getOrdersByStatus(accountId: number, status: OrderStatus): Order[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM orders
      WHERE account_id = ? AND status = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(accountId, status) as Order[];
  }

  /**
   * Get orders by account
   */
  getOrdersByAccount(accountId: number, limit: number = 100): Order[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM orders
      WHERE account_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(accountId, limit) as Order[];
  }

  // ============================================
  // Positions
  // ============================================

  /**
   * Create a new position
   */
  createPosition(position: Omit<Position, 'id' | 'created_at' | 'closed_at'> & { is_dry_run?: number }): number {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO positions (
        account_id, symbol, side, entry_order_id, entry_price, amount,
        take_profit_price, stop_loss_price, status, is_dry_run
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      position.account_id,
      position.symbol,
      position.side,
      position.entry_order_id || null,
      position.entry_price,
      position.amount,
      position.take_profit_price || null,
      position.stop_loss_price || null,
      position.status,
      position.is_dry_run || 0
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get position by ID
   */
  getPositionById(id: number): Position | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM positions WHERE id = ?');
    return (stmt.get(id) as Position) || null;
  }

  /**
   * Update position
   */
  updatePosition(id: number, updates: Partial<Position>): void {
    const db = getDatabase();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.take_profit_price !== undefined) {
      fields.push('take_profit_price = ?');
      values.push(updates.take_profit_price);
    }
    if (updates.stop_loss_price !== undefined) {
      fields.push('stop_loss_price = ?');
      values.push(updates.stop_loss_price);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.exit_price !== undefined) {
      fields.push('exit_price = ?');
      values.push(updates.exit_price);
    }
    if (updates.pnl_percent !== undefined) {
      fields.push('pnl_percent = ?');
      values.push(updates.pnl_percent);
    }
    if (updates.pnl_idr !== undefined) {
      fields.push('pnl_idr = ?');
      values.push(updates.pnl_idr);
    }

    if (fields.length === 0) return;

    values.push(id);
    const sql = `UPDATE positions SET ${fields.join(', ')} WHERE id = ?`;
    const stmt = db.prepare(sql);
    stmt.run(...values);
  }

  /**
   * Close a position
   */
  closePosition(id: number, exitPrice: number, pnlPercent: number, pnlIdr: number): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE positions SET
        status = 'closed',
        exit_price = ?,
        pnl_percent = ?,
        pnl_idr = ?,
        closed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(exitPrice, pnlPercent, pnlIdr, id);
  }

  /**
   * Get open positions for an account
   */
  getOpenPositions(accountId: number, symbol?: string): Position[] {
    const db = getDatabase();
    let sql = "SELECT * FROM positions WHERE account_id = ? AND status = 'open'";
    const params: unknown[] = [accountId];

    if (symbol) {
      sql += ' AND symbol = ?';
      params.push(symbol);
    }

    sql += ' ORDER BY created_at DESC';
    const stmt = db.prepare(sql);
    return stmt.all(...params) as Position[];
  }

  /**
   * Get all open positions (all accounts)
   */
  getAllOpenPositions(symbol?: string): Position[] {
    const db = getDatabase();
    let sql = "SELECT * FROM positions WHERE status = 'open'";
    const params: unknown[] = [];

    if (symbol) {
      sql += ' AND symbol = ?';
      params.push(symbol);
    }

    sql += ' ORDER BY created_at DESC';
    const stmt = db.prepare(sql);
    return stmt.all(...params) as Position[];
  }

  /**
   * Get position history for an account
   */
  getPositionHistory(accountId: number, limit: number = 50, symbol?: string): Position[] {
    const db = getDatabase();
    let sql = 'SELECT * FROM positions WHERE account_id = ?';
    const params: unknown[] = [accountId];

    if (symbol) {
      sql += ' AND symbol = ?';
      params.push(symbol);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(sql);
    return stmt.all(...params) as Position[];
  }

  /**
   * Get closed positions for an account
   */
  getClosedPositions(accountId: number, limit: number = 50): Position[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM positions
      WHERE account_id = ? AND status = 'closed'
      ORDER BY closed_at DESC
      LIMIT ?
    `);
    return stmt.all(accountId, limit) as Position[];
  }

  /**
   * Get trading statistics for an account
   */
  getTradeStats(accountId: number): {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlPercent: number;
    totalPnlIdr: number;
    avgPnlPercent: number;
  } {
    const db = getDatabase();

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_percent <= 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(pnl_percent), 0) as total_pnl_percent,
        COALESCE(SUM(pnl_idr), 0) as total_pnl_idr,
        COALESCE(AVG(pnl_percent), 0) as avg_pnl_percent
      FROM positions
      WHERE account_id = ? AND status = 'closed'
    `).get(accountId) as {
      total_trades: number;
      wins: number;
      losses: number;
      total_pnl_percent: number;
      total_pnl_idr: number;
      avg_pnl_percent: number;
    };

    return {
      totalTrades: stats.total_trades || 0,
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      winRate: stats.total_trades > 0 ? (stats.wins / stats.total_trades) * 100 : 0,
      totalPnlPercent: stats.total_pnl_percent || 0,
      totalPnlIdr: stats.total_pnl_idr || 0,
      avgPnlPercent: stats.avg_pnl_percent || 0
    };
  }

  /**
   * Get global trading statistics (all accounts)
   */
  getGlobalStats(): {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlIdr: number;
  } {
    const db = getDatabase();

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_percent <= 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(pnl_idr), 0) as total_pnl_idr
      FROM positions
      WHERE status = 'closed'
    `).get() as {
      total_trades: number;
      wins: number;
      losses: number;
      total_pnl_idr: number;
    };

    return {
      totalTrades: stats.total_trades || 0,
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      winRate: stats.total_trades > 0 ? (stats.wins / stats.total_trades) * 100 : 0,
      totalPnlIdr: stats.total_pnl_idr || 0
    };
  }
}

export const orderRepo = new OrderRepository();
export default orderRepo;
