/**
 * Repository for Telegram users and trading accounts
 */

import { getDatabase } from '../connection.js';
import { TelegramUser, TradingAccount, TelegramSettings } from '../../types/index.js';
import { encrypt, decrypt, EncryptedData } from '../../services/encryption.js';

export class TelegramAccountRepository {
  // ============================================
  // Telegram Users
  // ============================================

  /**
   * Create or update a Telegram user
   */
  createUser(telegramId: string, username?: string, role: 'admin' | 'user' = 'user'): number {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO telegram_users (telegram_id, username, role, is_active)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        is_active = 1
    `);
    const result = stmt.run(telegramId, username || null, role);
    return result.lastInsertRowid as number;
  }

  /**
   * Get user by Telegram ID
   */
  getUserByTelegramId(telegramId: string): TelegramUser | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM telegram_users WHERE telegram_id = ?');
    return (stmt.get(telegramId) as TelegramUser) || null;
  }

  /**
   * Get user by internal ID
   */
  getUserById(id: number): TelegramUser | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM telegram_users WHERE id = ?');
    return (stmt.get(id) as TelegramUser) || null;
  }

  /**
   * Get all active users
   */
  getAllUsers(activeOnly: boolean = true): TelegramUser[] {
    const db = getDatabase();
    let sql = 'SELECT * FROM telegram_users';
    if (activeOnly) sql += ' WHERE is_active = 1';
    sql += ' ORDER BY created_at DESC';
    const stmt = db.prepare(sql);
    return stmt.all() as TelegramUser[];
  }

  /**
   * Update user
   */
  updateUser(telegramId: string, updates: Partial<TelegramUser>): void {
    const db = getDatabase();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.username !== undefined) {
      fields.push('username = ?');
      values.push(updates.username);
    }
    if (updates.role !== undefined) {
      fields.push('role = ?');
      values.push(updates.role);
    }
    if (updates.is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(updates.is_active);
    }

    if (fields.length === 0) return;

    values.push(telegramId);
    const sql = `UPDATE telegram_users SET ${fields.join(', ')} WHERE telegram_id = ?`;
    const stmt = db.prepare(sql);
    stmt.run(...values);
  }

  /**
   * Deactivate user
   */
  deactivateUser(telegramId: string): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE telegram_users SET is_active = 0 WHERE telegram_id = ?');
    stmt.run(telegramId);
  }

  /**
   * Check if user is admin
   */
  isAdmin(telegramId: string): boolean {
    const user = this.getUserByTelegramId(telegramId);
    return user?.role === 'admin' && user?.is_active === 1;
  }

  // ============================================
  // Trading Accounts
  // ============================================

  /**
   * Add a trading account with encrypted credentials
   */
  addTradingAccount(
    telegramUserId: number,
    accountName: string,
    apiKey: string,
    apiSecret: string,
    isDefault: boolean = false
  ): number {
    const db = getDatabase();

    // Encrypt credentials
    const apiKeyEncrypted = encrypt(apiKey);
    const apiSecretEncrypted = encrypt(apiSecret);

    // If this is default, clear other defaults first
    if (isDefault) {
      db.prepare('UPDATE trading_accounts SET is_default = 0 WHERE telegram_user_id = ?')
        .run(telegramUserId);
    }

    const stmt = db.prepare(`
      INSERT INTO trading_accounts (
        telegram_user_id, account_name, api_key_encrypted, api_secret_encrypted, iv, is_default, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `);

    // Store both encrypted values with the same IV (they're encrypted separately)
    const result = stmt.run(
      telegramUserId,
      accountName,
      apiKeyEncrypted.encrypted,
      apiSecretEncrypted.encrypted,
      apiKeyEncrypted.iv + ':' + apiSecretEncrypted.iv, // Store both IVs
      isDefault ? 1 : 0
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get trading accounts for a user
   */
  getTradingAccounts(telegramUserId: number): TradingAccount[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM trading_accounts
      WHERE telegram_user_id = ? AND is_active = 1
      ORDER BY is_default DESC, account_name ASC
    `);
    return stmt.all(telegramUserId) as TradingAccount[];
  }

  /**
   * Get trading account by ID
   */
  getTradingAccountById(id: number): TradingAccount | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM trading_accounts WHERE id = ?');
    return (stmt.get(id) as TradingAccount) || null;
  }

  /**
   * Get default trading account for a user
   */
  getDefaultAccount(telegramUserId: number): TradingAccount | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM trading_accounts
      WHERE telegram_user_id = ? AND is_active = 1
      ORDER BY is_default DESC
      LIMIT 1
    `);
    return (stmt.get(telegramUserId) as TradingAccount) || null;
  }

  /**
   * Get decrypted credentials for an account
   */
  getDecryptedCredentials(accountId: number): { apiKey: string; apiSecret: string } | null {
    const account = this.getTradingAccountById(accountId);
    if (!account) return null;

    try {
      const [apiKeyIv, apiSecretIv] = account.iv.split(':');

      const apiKey = decrypt({
        encrypted: account.api_key_encrypted,
        iv: apiKeyIv
      });

      const apiSecret = decrypt({
        encrypted: account.api_secret_encrypted,
        iv: apiSecretIv
      });

      return { apiKey, apiSecret };
    } catch (error) {
      console.error('Failed to decrypt credentials:', error);
      return null;
    }
  }

  /**
   * Set default trading account
   */
  setDefaultAccount(telegramUserId: number, accountId: number): void {
    const db = getDatabase();

    // Clear all defaults for this user
    db.prepare('UPDATE trading_accounts SET is_default = 0 WHERE telegram_user_id = ?')
      .run(telegramUserId);

    // Set new default
    db.prepare('UPDATE trading_accounts SET is_default = 1 WHERE id = ? AND telegram_user_id = ?')
      .run(accountId, telegramUserId);
  }

  /**
   * Deactivate trading account
   */
  deactivateTradingAccount(accountId: number): void {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE trading_accounts SET is_active = 0 WHERE id = ?');
    stmt.run(accountId);
  }

  /**
   * Delete trading account (hard delete - use with caution)
   */
  deleteTradingAccount(accountId: number): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM trading_accounts WHERE id = ?');
    stmt.run(accountId);
  }

  // ============================================
  // Telegram Settings
  // ============================================

  /**
   * Get or create settings for a user
   */
  getSettings(telegramUserId: number): TelegramSettings {
    const db = getDatabase();
    let settings = db.prepare('SELECT * FROM telegram_settings WHERE telegram_user_id = ?')
      .get(telegramUserId) as TelegramSettings | undefined;

    if (!settings) {
      db.prepare(`
        INSERT INTO telegram_settings (telegram_user_id, notifications, auto_execute, trade_amount_pct)
        VALUES (?, 1, 0, 10)
      `).run(telegramUserId);

      settings = {
        telegram_user_id: telegramUserId,
        notifications: 1,
        auto_execute: 0,
        trade_amount_pct: 10
      };
    }

    return settings;
  }

  /**
   * Update user settings
   */
  updateSettings(telegramUserId: number, updates: Partial<TelegramSettings>): void {
    const db = getDatabase();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.notifications !== undefined) {
      fields.push('notifications = ?');
      values.push(updates.notifications);
    }
    if (updates.auto_execute !== undefined) {
      fields.push('auto_execute = ?');
      values.push(updates.auto_execute);
    }
    if (updates.trade_amount_pct !== undefined) {
      fields.push('trade_amount_pct = ?');
      values.push(updates.trade_amount_pct);
    }

    if (fields.length === 0) return;

    // Ensure settings exist first
    this.getSettings(telegramUserId);

    values.push(telegramUserId);
    const sql = `UPDATE telegram_settings SET ${fields.join(', ')} WHERE telegram_user_id = ?`;
    const stmt = db.prepare(sql);
    stmt.run(...values);
  }
}

export const telegramAccountRepo = new TelegramAccountRepository();
export default telegramAccountRepo;
