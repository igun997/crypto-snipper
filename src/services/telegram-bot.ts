/**
 * Telegram Bot Service
 * Handles all Telegram interactions for trading control
 */

import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { EventEmitter } from 'events';
import { config } from '../config/index.js';
import { telegramAccountRepo } from '../database/repositories/telegram-accounts.js';
import { orderRepo } from '../database/repositories/orders.js';
import priceRepo from '../database/repositories/prices.js';
import { tradingExecutor } from './trading-executor.js';
import { dryRunExecutor } from './dry-run-executor.js';
import { positionTracker, PositionUpdate } from './position-tracker.js';
import scalper, { ScalpSignal, ActiveScalp } from './scalper.js';
import realtimeFetcher from './realtime-fetcher.js';
import dataFetcher from './data-fetcher.js';
import indodax from '../exchange/indodax.js';
import chartRenderer from '../cli/chart-renderer.js';
import { TelegramUser, Position, Order } from '../types/index.js';

// Symbol subscription status for data readiness
interface SymbolSubscription {
  symbol: string;
  status: 'idle' | 'prefetching' | 'connecting' | 'ready' | 'analyzing' | 'error';
  candleCount: number;
  lastUpdate: number;
  errorMessage?: string;
}

// Scalp worker configuration per user
interface ScalpWorkerConfig {
  symbols: string[];
  takeProfitPercent: number;
  stopLossPercent: number;
  minConfidence: number;
  autoExecute: boolean;
  dryRunMode: boolean;
  dryRunBalance: number; // IDR
}

// Scalp worker state
interface ScalpWorkerState {
  isRunning: boolean;
  symbols: string[];
  startedAt?: Date;
  signalCount: number;
  config: ScalpWorkerConfig;
}

// Wizard state for account setup
interface WizardState {
  step: 'name' | 'apiKey' | 'apiSecret' | 'confirm';
  accountName?: string;
  apiKey?: string;
  apiSecret?: string;
}

// Menu state for button-based UI
interface MenuState {
  menu: 'main' | 'account' | 'trading' | 'scalp' | 'positions' | 'settings' | 'help';
  subMenu?: string;
  inputMode?: 'account_name' | 'api_key' | 'api_secret' | 'symbol' | 'amount' | 'price';
  inputData?: Record<string, any>;
  selectedSymbol?: string;
  messageId?: number;
}

// Common trading symbols
const COMMON_SYMBOLS = ['BTC/IDR', 'ETH/IDR', 'DOGE/IDR', 'SOL/IDR', 'XRP/IDR', 'BNB/IDR'];

export class TelegramBot extends EventEmitter {
  private bot: Telegraf;
  private adminIds: string[];
  private wizardStates: Map<string, WizardState> = new Map();
  private menuStates: Map<string, MenuState> = new Map();
  private symbolSubscriptions: Map<string, SymbolSubscription> = new Map();
  private _isRunning: boolean = false;

  // Dry run virtual balances (accountId -> currency -> amount)
  private dryRunBalances: Map<number, Map<string, number>> = new Map();

  // Scalp worker state
  private scalpWorker: ScalpWorkerState = {
    isRunning: false,
    symbols: [],
    signalCount: 0,
    config: {
      symbols: ['BTC/IDR'],
      takeProfitPercent: 0.3,
      stopLossPercent: 0.15,
      minConfidence: 0.6,
      autoExecute: false,
      dryRunMode: false,
      dryRunBalance: 10000000, // 10 million IDR
    },
  };

  constructor() {
    super();

    const token = config.telegram?.botToken;
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN not configured');
    }

    this.bot = new Telegraf(token);
    this.adminIds = config.telegram?.adminIds || [];

    // Global error handler for callback queries that are too old
    this.bot.catch((err: any, ctx) => {
      const errorMessage = err?.message || String(err);
      if (errorMessage.includes('query is too old') || errorMessage.includes('query ID is invalid')) {
        // Ignore old callback query errors - they happen after bot restart
        console.log('[TelegramBot] Ignoring old callback query');
        return;
      }
      console.error('[TelegramBot] Unhandled error:', errorMessage);
    });

    this.setupCommands();
    this.setupCallbacks();
    this.setupEventListeners();
  }

  /**
   * Safely answer callback query (ignores timeout errors)
   */
  private async safeAnswerCbQuery(ctx: Context, text?: string): Promise<void> {
    try {
      await ctx.answerCbQuery(text);
    } catch (err: any) {
      const msg = err?.message || '';
      if (!msg.includes('query is too old') && !msg.includes('query ID is invalid')) {
        console.error('[TelegramBot] answerCbQuery error:', msg);
      }
    }
  }

  // ============================================
  // Menu Builders
  // ============================================

  /**
   * Build main menu keyboard
   */
  private buildMainMenu(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('💼 Account', 'menu_account'),
        Markup.button.callback('📈 Trading', 'menu_trading'),
      ],
      [
        Markup.button.callback('📡 Subscribe', 'menu_subscribe'),
        Markup.button.callback('⚡ Scalping', 'menu_scalp'),
      ],
      [
        Markup.button.callback('📊 Positions', 'menu_positions'),
        Markup.button.callback('⚙️ Settings', 'menu_settings'),
      ],
      [Markup.button.callback('❓ Help', 'menu_help')],
    ]);
  }

  /**
   * Build account menu keyboard
   */
  private buildAccountMenu(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('➕ Add Account', 'action_account_add'),
        Markup.button.callback('📋 My Accounts', 'action_account_list'),
      ],
      [
        Markup.button.callback('💰 Balance', 'action_balance'),
        Markup.button.callback('🗑️ Remove', 'action_account_remove'),
      ],
      [Markup.button.callback('« Back', 'menu_main')],
    ]);
  }

  /**
   * Build trading menu keyboard (symbol selection)
   */
  private buildTradingMenu(): ReturnType<typeof Markup.inlineKeyboard> {
    const symbolButtons = COMMON_SYMBOLS.map(s =>
      Markup.button.callback(s.replace('/IDR', ''), `symbol_${s.replace('/', '_')}`)
    );

    // Arrange in rows of 3
    const rows: any[][] = [];
    for (let i = 0; i < symbolButtons.length; i += 3) {
      rows.push(symbolButtons.slice(i, i + 3));
    }

    rows.push([Markup.button.callback('🔤 Other...', 'input_symbol')]);
    rows.push([Markup.button.callback('« Back', 'menu_main')]);

    return Markup.inlineKeyboard(rows);
  }

  /**
   * Build trading actions menu for a symbol
   */
  private buildTradingActionsMenu(symbol: string): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('🟢 Buy Market', `action_buy_market_${symbol.replace('/', '_')}`),
        Markup.button.callback('🔴 Sell Market', `action_sell_market_${symbol.replace('/', '_')}`),
      ],
      [
        Markup.button.callback('📗 Buy Limit', `action_buy_limit_${symbol.replace('/', '_')}`),
        Markup.button.callback('📕 Sell Limit', `action_sell_limit_${symbol.replace('/', '_')}`),
      ],
      [
        Markup.button.callback('💹 Price', `action_price_${symbol.replace('/', '_')}`),
        Markup.button.callback('📊 Chart', `action_chart_${symbol.replace('/', '_')}`),
      ],
      [Markup.button.callback('📋 Orders', 'action_orders')],
      [Markup.button.callback('« Back', 'menu_trading')],
    ]);
  }

  /**
   * Build amount selection menu
   */
  private buildAmountMenu(symbol: string, side: string, orderType: string): ReturnType<typeof Markup.inlineKeyboard> {
    const key = `${side}_${orderType}_${symbol.replace('/', '_')}`;
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('10%', `amount_10_${key}`),
        Markup.button.callback('25%', `amount_25_${key}`),
        Markup.button.callback('50%', `amount_50_${key}`),
        Markup.button.callback('100%', `amount_100_${key}`),
      ],
      [Markup.button.callback('🔢 Custom', `input_amount_${key}`)],
      [Markup.button.callback('« Back', `symbol_${symbol.replace('/', '_')}`)],
    ]);
  }

  /**
   * Build scalp menu keyboard
   */
  private buildScalpMenu(): ReturnType<typeof Markup.inlineKeyboard> {
    const isRunning = this.scalpWorker.isRunning;
    const cfg = this.scalpWorker.config;

    if (isRunning) {
      return Markup.inlineKeyboard([
        [
          Markup.button.callback('🛑 Stop', 'action_scalp_stop'),
          Markup.button.callback('📊 Status', 'action_scalp_status'),
        ],
        [
          Markup.button.callback('📈 Chart', 'action_scalp_chart'),
          Markup.button.callback('⚙️ Configure', 'menu_scalp_config'),
        ],
        [Markup.button.callback('« Back', 'menu_main')],
      ]);
    } else {
      const dryRunLabel = cfg.dryRunMode ? '📝 Dry Run Stats' : '📝 Enable Dry Run';
      return Markup.inlineKeyboard([
        [Markup.button.callback('📡 Subscribe', 'menu_subscription')],
        [
          Markup.button.callback('▶️ Start', 'action_scalp_start'),
          Markup.button.callback('⚙️ Configure', 'menu_scalp_config'),
        ],
        [Markup.button.callback(dryRunLabel, cfg.dryRunMode ? 'action_dryrun_stats' : 'config_dryrun_toggle')],
        [Markup.button.callback('« Back', 'menu_main')],
      ]);
    }
  }

  /**
   * Build subscription menu
   */
  private buildSubscriptionMenu(backTo: 'main' | 'scalp' = 'main'): ReturnType<typeof Markup.inlineKeyboard> {
    const buttons: any[][] = [];

    // Symbol buttons in rows of 3
    const symbolRow: any[] = [];
    for (const symbol of COMMON_SYMBOLS) {
      const sub = this.symbolSubscriptions.get(symbol);
      const icon = this.getSubscriptionIcon(sub?.status);
      symbolRow.push(Markup.button.callback(`${icon} ${symbol.replace('/IDR', '')}`, `sub_toggle_${symbol.replace('/', '_')}`));

      if (symbolRow.length === 3) {
        buttons.push([...symbolRow]);
        symbolRow.length = 0;
      }
    }
    if (symbolRow.length > 0) {
      buttons.push(symbolRow);
    }

    buttons.push([Markup.button.callback('➕ Add Custom', 'input_sub_custom')]);
    buttons.push([Markup.button.callback('« Back', `menu_${backTo}`)]);

    return Markup.inlineKeyboard(buttons);
  }

  /**
   * Build subscription status text
   */
  private buildSubscriptionStatusText(): string {
    let text = '📡 Subscriptions\n\n';
    text += 'Subscribe to symbols for real-time data.\n';
    text += 'Data is used for charts, trading, and scalping.\n\n';

    const subscribed = Array.from(this.symbolSubscriptions.values());
    if (subscribed.length > 0) {
      text += '━━━━━━━━━━━━━━━━━━━━━\n';
      text += 'Status:\n';
      for (const sub of subscribed) {
        const icon = this.getSubscriptionIcon(sub.status);
        text += `${icon} ${sub.symbol}: ${sub.status}`;
        if (sub.candleCount > 0) {
          text += ` (${sub.candleCount} candles)`;
        }
        if (sub.errorMessage) {
          text += ` - ${sub.errorMessage}`;
        }
        text += '\n';
      }
      text += '━━━━━━━━━━━━━━━━━━━━━\n';
    }

    text += '\nTap symbol to subscribe/unsubscribe:';
    return text;
  }

  /**
   * Get status icon for subscription
   */
  private getSubscriptionIcon(status?: string): string {
    switch (status) {
      case 'prefetching': return '🔄';
      case 'connecting': return '🔄';
      case 'ready': return '🟢';
      case 'analyzing': return '📊';
      case 'error': return '🔴';
      default: return '⚪';
    }
  }

  /**
   * Build scalp config menu with +/- buttons
   */
  private buildScalpConfigMenu(): ReturnType<typeof Markup.inlineKeyboard> {
    const cfg = this.scalpWorker.config;
    return Markup.inlineKeyboard([
      // Take Profit row
      [
        Markup.button.callback(`TP: ${cfg.takeProfitPercent}%`, 'noop'),
        Markup.button.callback('-', 'config_tp_-0.05'),
        Markup.button.callback('+', 'config_tp_+0.05'),
      ],
      // Stop Loss row
      [
        Markup.button.callback(`SL: ${cfg.stopLossPercent}%`, 'noop'),
        Markup.button.callback('-', 'config_sl_-0.05'),
        Markup.button.callback('+', 'config_sl_+0.05'),
      ],
      // Confidence row
      [
        Markup.button.callback(`Conf: ${(cfg.minConfidence * 100).toFixed(0)}%`, 'noop'),
        Markup.button.callback('-', 'config_conf_-5'),
        Markup.button.callback('+', 'config_conf_+5'),
      ],
      // Auto execute toggle
      [Markup.button.callback(`Auto Execute: ${cfg.autoExecute ? 'ON' : 'OFF'}`, 'config_auto_toggle')],
      // Dry run toggle
      [Markup.button.callback(`Dry Run: ${cfg.dryRunMode ? 'ON' : 'OFF'}`, 'config_dryrun_toggle')],
      // Dry run balance (only show if dry run enabled)
      ...(cfg.dryRunMode ? [[Markup.button.callback(`Balance: Rp ${this.formatNumber(cfg.dryRunBalance)}`, 'input_dryrun_balance')]] : []),
      // Symbols
      [Markup.button.callback(`Symbols: ${cfg.symbols.join(', ')}`, 'input_scalp_symbols')],
      // Actions
      [
        Markup.button.callback('💾 Save', 'action_scalp_save_config'),
        Markup.button.callback('« Back', 'menu_scalp'),
      ],
    ]);
  }

  /**
   * Build positions menu
   */
  private buildPositionsMenu(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 Open Positions', 'action_positions'),
        Markup.button.callback('📋 Open Orders', 'action_orders'),
      ],
      [
        Markup.button.callback('📈 Stats', 'action_stats'),
      ],
      [Markup.button.callback('« Back', 'menu_main')],
    ]);
  }

  /**
   * Build settings menu
   */
  private buildSettingsMenu(): ReturnType<typeof Markup.inlineKeyboard> {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Auto Execute Toggle', 'config_user_auto_toggle')],
      [Markup.button.callback('📋 Account Settings', 'action_account_list')],
      [Markup.button.callback('« Back', 'menu_main')],
    ]);
  }

  /**
   * Setup bot commands
   */
  private setupCommands(): void {
    // Start command
    this.bot.start(this.handleStart.bind(this));

    // Help command
    this.bot.help(this.handleHelp.bind(this));

    // Admin commands
    this.bot.command('admin_add', this.requireAdmin(this.handleAdminAdd.bind(this)));
    this.bot.command('admin_remove', this.requireAdmin(this.handleAdminRemove.bind(this)));
    this.bot.command('admin_list', this.requireAdmin(this.handleAdminList.bind(this)));
    this.bot.command('admin_stats', this.requireAdmin(this.handleAdminStats.bind(this)));

    // Account management
    this.bot.command('account_add', this.requireAuth(this.handleAccountAdd.bind(this)));
    this.bot.command('account_list', this.requireAuth(this.handleAccountList.bind(this)));
    this.bot.command('account_remove', this.requireAuth(this.handleAccountRemove.bind(this)));
    this.bot.command('balance', this.requireAuth(this.handleBalance.bind(this)));

    // Trading commands
    this.bot.command('buy', this.requireAuth(this.handleBuy.bind(this)));
    this.bot.command('sell', this.requireAuth(this.handleSell.bind(this)));
    this.bot.command('cancel', this.requireAuth(this.handleCancel.bind(this)));
    this.bot.command('orders', this.requireAuth(this.handleOrders.bind(this)));

    // Position management
    this.bot.command('positions', this.requireAuth(this.handlePositions.bind(this)));
    this.bot.command('close', this.requireAuth(this.handleClose.bind(this)));
    this.bot.command('set_tp', this.requireAuth(this.handleSetTp.bind(this)));
    this.bot.command('set_sl', this.requireAuth(this.handleSetSl.bind(this)));

    // Info commands
    this.bot.command('price', this.handlePrice.bind(this));
    this.bot.command('stats', this.requireAuth(this.handleStats.bind(this)));

    // Scalp commands
    this.bot.command('scalp_auto', this.requireAuth(this.handleScalpAuto.bind(this)));
    this.bot.command('scalp_start', this.requireAdmin(this.handleScalpStart.bind(this)));
    this.bot.command('scalp_stop', this.requireAdmin(this.handleScalpStop.bind(this)));
    this.bot.command('scalp_status', this.requireAuth(this.handleScalpStatus.bind(this)));
    this.bot.command('scalp_config', this.requireAdmin(this.handleScalpConfig.bind(this)));

    // Subscribe command - standalone subscription management
    this.bot.command('subscribe', this.requireAuth(this.handleSubscribeCommand.bind(this)));
    this.bot.command('subs', this.requireAuth(this.handleSubscribeCommand.bind(this))); // Alias

    // Handle text messages for wizard
    this.bot.on(message('text'), this.handleText.bind(this));
  }

  /**
   * Setup callback query handlers
   */
  private setupCallbacks(): void {
    // Menu navigation
    this.bot.action(/^menu_(.+)$/, this.handleMenuNavigation.bind(this));

    // Actions
    this.bot.action(/^action_(.+)$/, this.requireAuth(this.handleAction.bind(this)));

    // Config changes
    this.bot.action(/^config_(.+)$/, this.requireAuth(this.handleConfig.bind(this)));

    // Input requests (ForceReply)
    this.bot.action(/^input_(.+)$/, this.requireAuth(this.handleInputRequest.bind(this)));

    // Symbol selection
    this.bot.action(/^symbol_(.+)$/, this.requireAuth(this.handleSymbolSelect.bind(this)));

    // Amount selection
    this.bot.action(/^amount_(\d+)_(.+)$/, this.requireAuth(this.handleAmountSelect.bind(this)));

    // Subscription toggle
    this.bot.action(/^sub_toggle_(.+)$/, this.requireAuth(this.handleSubscriptionToggle.bind(this)));

    // Legacy callbacks
    this.bot.action(/^execute_(.+)$/, this.requireAuth(this.handleExecuteCallback.bind(this)));
    this.bot.action(/^skip_(.+)$/, this.handleSkipCallback.bind(this));
    this.bot.action(/^close_pos_(\d+)$/, this.requireAuth(this.handleClosePositionCallback.bind(this)));
    this.bot.action(/^cancel_order_(\d+)$/, this.requireAuth(this.handleCancelOrderCallback.bind(this)));
    this.bot.action('confirm_account', this.requireAuth(this.handleConfirmAccount.bind(this)));
    this.bot.action('cancel_account', this.handleCancelAccount.bind(this));
    this.bot.action('noop', (ctx) => ctx.answerCbQuery());
  }

  // ============================================
  // Menu Navigation Handler
  // ============================================

  private async handleMenuNavigation(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^menu_(.+)$/);
    if (!match) return;

    const menu = match[1];
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    await this.safeAnswerCbQuery(ctx);

    // Update menu state
    this.menuStates.set(userId, { menu: menu as MenuState['menu'] });

    switch (menu) {
      case 'main':
        await ctx.editMessageText(
          '🏠 Main Menu\n\nSelect an option:',
          this.buildMainMenu()
        );
        break;

      case 'account':
        await ctx.editMessageText(
          '💼 Account Management\n\nManage your trading accounts:',
          this.buildAccountMenu()
        );
        break;

      case 'trading':
        await ctx.editMessageText(
          '📈 Trading\n\nSelect a symbol to trade:',
          this.buildTradingMenu()
        );
        break;

      case 'scalp':
        const status = this.scalpWorker.isRunning ? '🟢 RUNNING' : '🔴 STOPPED';
        await ctx.editMessageText(
          `⚡ Scalping\n\nWorker Status: ${status}`,
          this.buildScalpMenu()
        );
        break;

      case 'scalp_config':
        await ctx.editMessageText(
          '⚙️ Scalp Configuration\n\nAdjust settings with +/- buttons:',
          this.buildScalpConfigMenu()
        );
        break;

      case 'subscribe':
      case 'subscription':
        await ctx.editMessageText(
          this.buildSubscriptionStatusText(),
          this.buildSubscriptionMenu()
        );
        break;

      case 'positions':
        await ctx.editMessageText(
          '📊 Positions & Orders\n\nView your trading activity:',
          this.buildPositionsMenu()
        );
        break;

      case 'settings':
        await ctx.editMessageText(
          '⚙️ Settings\n\nConfigure your preferences:',
          this.buildSettingsMenu()
        );
        break;

      case 'help':
        await ctx.editMessageText(
          this.getHelpText(userId),
          Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_main')]])
        );
        break;
    }
  }

  /**
   * Get help text
   */
  private getHelpText(userId: string): string {
    const isAdmin = this.adminIds.includes(userId);

    let text = `📚 Help\n\nButton Navigation:\n` +
      `• Account - Manage API keys\n` +
      `• Subscribe - Real-time data feeds\n` +
      `• Trading - Buy/Sell orders\n` +
      `• Scalping - Auto-trading signals\n` +
      `• Positions - View open trades\n` +
      `• Settings - Preferences\n\n` +
      `Slash commands:\n` +
      `/subscribe <symbol> - Subscribe to symbol\n` +
      `/subs - Show subscription menu\n` +
      `/buy, /sell, /balance, /positions`;

    if (isAdmin) {
      text += `\n\nAdmin: /admin_add, /admin_remove, /admin_list`;
    }

    return text;
  }

  // ============================================
  // Action Handler
  // ============================================

  private async handleAction(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^action_(.+)$/);
    if (!match) return;

    const action = match[1];
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    await this.safeAnswerCbQuery(ctx);

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) {
      await ctx.reply('⛔ Not authorized');
      return;
    }

    // Account actions
    if (action === 'account_add') {
      this.wizardStates.set(userId, { step: 'name' });
      await ctx.reply(
        'Enter a name for this account (e.g., "main", "trading"):',
        { reply_markup: { force_reply: true, selective: true } }
      );
      this.menuStates.set(userId, { menu: 'account', inputMode: 'account_name' });
      return;
    }

    if (action === 'account_list') {
      const accounts = telegramAccountRepo.getTradingAccounts(user.id!);
      if (accounts.length === 0) {
        await ctx.reply('No trading accounts linked.\nUse "Add Account" to get started.');
      } else {
        let text = '💼 Your Trading Accounts\n\n';
        for (const account of accounts) {
          const isDefault = account.is_default ? ' ⭐' : '';
          text += `• ${account.account_name}${isDefault}\n`;
        }
        await ctx.reply(text);
      }
      return;
    }

    if (action === 'account_remove') {
      const accounts = telegramAccountRepo.getTradingAccounts(user.id!);
      if (accounts.length === 0) {
        await ctx.reply('No accounts to remove.');
        return;
      }
      // Build account selection buttons
      const buttons = accounts.map(a =>
        [Markup.button.callback(`🗑️ ${a.account_name}`, `action_remove_account_${a.id}`)]
      );
      buttons.push([Markup.button.callback('« Cancel', 'menu_account')]);
      await ctx.editMessageText('Select account to remove:', Markup.inlineKeyboard(buttons));
      return;
    }

    if (action.startsWith('remove_account_')) {
      const accountId = parseInt(action.replace('remove_account_', ''));
      telegramAccountRepo.deactivateTradingAccount(accountId);
      await ctx.editMessageText('✅ Account removed', this.buildAccountMenu());
      return;
    }

    if (action === 'balance') {
      const account = telegramAccountRepo.getDefaultAccount(user.id!);
      if (!account) {
        await ctx.reply('No trading account found. Add one first.');
        return;
      }
      await ctx.reply('⏳ Fetching balance...');
      const result = await tradingExecutor.getBalance(account.id!);
      if (!result.success) {
        await ctx.reply(`❌ Failed: ${result.error}`);
        return;
      }
      let text = `💰 Balance (${account.account_name})\n\n`;
      for (const balance of result.balances || []) {
        if (balance.total > 0) {
          text += `${balance.currency}: ${this.formatNumber(balance.free)}`;
          if (balance.used > 0) text += ` (${this.formatNumber(balance.used)} in orders)`;
          text += '\n';
        }
      }
      await ctx.reply(text);
      return;
    }

    // Trading actions
    if (action.startsWith('buy_market_') || action.startsWith('sell_market_') ||
        action.startsWith('buy_limit_') || action.startsWith('sell_limit_')) {
      const parts = action.split('_');
      const side = parts[0] as 'buy' | 'sell';
      const orderType = parts[1] as 'market' | 'limit';
      const symbol = parts.slice(2).join('_').replace('_', '/');

      // Show amount selection
      await ctx.editMessageText(
        `${side === 'buy' ? '🟢 BUY' : '🔴 SELL'} ${symbol}\nType: ${orderType.toUpperCase()}\n\nSelect amount (% of balance):`,
        this.buildAmountMenu(symbol, side, orderType)
      );
      return;
    }

    if (action.startsWith('price_')) {
      const symbol = action.replace('price_', '').replace('_', '/');
      try {
        const ticker = await indodax.fetchTicker(symbol);
        await ctx.reply(
          `💹 ${symbol}\n\n` +
          `Price: Rp ${this.formatNumber(ticker.last)}\n` +
          `Bid: Rp ${this.formatNumber(ticker.bid)}\n` +
          `Ask: Rp ${this.formatNumber(ticker.ask)}\n` +
          `Volume: ${this.formatNumber(ticker.volume)}`
        );
      } catch {
        await ctx.reply(`❌ Failed to fetch price for ${symbol}`);
      }
      return;
    }

    if (action === 'orders') {
      const account = telegramAccountRepo.getDefaultAccount(user.id!);
      if (!account) return;
      const orders = orderRepo.getOpenOrders(account.id!);
      if (orders.length === 0) {
        await ctx.reply('No open orders');
        return;
      }
      let text = '📋 Open Orders\n\n';
      for (const order of orders) {
        text += `#${order.id} ${order.side.toUpperCase()} ${order.symbol}\n`;
        text += `  Amount: ${order.amount}`;
        if (order.price) text += ` @ Rp ${this.formatNumber(order.price)}`;
        text += '\n\n';
      }
      await ctx.reply(text);
      return;
    }

    if (action === 'positions') {
      const account = telegramAccountRepo.getDefaultAccount(user.id!);
      if (!account) return;
      const positions = orderRepo.getOpenPositions(account.id!);
      if (positions.length === 0) {
        await ctx.reply('No open positions');
        return;
      }
      for (const position of positions) {
        let currentPrice: number;
        try {
          const ticker = await indodax.fetchTicker(position.symbol);
          currentPrice = ticker.last;
        } catch {
          currentPrice = position.entry_price;
        }
        const pnlPercent = position.side === 'long'
          ? ((currentPrice - position.entry_price) / position.entry_price) * 100
          : ((position.entry_price - currentPrice) / position.entry_price) * 100;
        const pnlEmoji = pnlPercent >= 0 ? '🟢' : '🔴';

        await ctx.reply(
          `📊 Position #${position.id}\n` +
          `${position.symbol} ${position.side.toUpperCase()}\n` +
          `Entry: Rp ${this.formatNumber(position.entry_price)}\n` +
          `Current: Rp ${this.formatNumber(currentPrice)}\n` +
          `P/L: ${pnlEmoji} ${pnlPercent.toFixed(2)}%\n` +
          `TP: ${position.take_profit_price ? 'Rp ' + this.formatNumber(position.take_profit_price) : '-'}\n` +
          `SL: ${position.stop_loss_price ? 'Rp ' + this.formatNumber(position.stop_loss_price) : '-'}`,
          Markup.inlineKeyboard([
            [Markup.button.callback('Close Position', `close_pos_${position.id}`)]
          ])
        );
      }
      return;
    }

    if (action === 'stats') {
      const account = telegramAccountRepo.getDefaultAccount(user.id!);
      if (!account) return;
      const stats = orderRepo.getTradeStats(account.id!);
      await ctx.reply(
        `📊 Your Trading Statistics\n\n` +
        `Total Trades: ${stats.totalTrades}\n` +
        `Wins: ${stats.wins} | Losses: ${stats.losses}\n` +
        `Win Rate: ${stats.winRate.toFixed(1)}%\n` +
        `Total P/L: Rp ${this.formatNumber(stats.totalPnlIdr)}`
      );
      return;
    }

    // Scalp actions
    if (action === 'scalp_start') {
      await this.startScalpWorker(ctx);
      return;
    }

    if (action === 'scalp_stop') {
      await this.stopScalpWorker(ctx);
      return;
    }

    if (action === 'scalp_status') {
      await this.showScalpStatus(ctx);
      return;
    }

    if (action === 'scalp_save_config') {
      // Apply config to scalper if running
      if (this.scalpWorker.isRunning) {
        scalper.updateConfig({
          takeProfitPercent: this.scalpWorker.config.takeProfitPercent,
          stopLossPercent: this.scalpWorker.config.stopLossPercent,
          minConfidence: this.scalpWorker.config.minConfidence,
        });
      }
      await ctx.answerCbQuery('✅ Configuration saved');
      return;
    }

    // Chart action for trading menu
    if (action.startsWith('chart_')) {
      const symbol = action.replace('chart_', '').replace('_', '/');
      await this.showChart(ctx, symbol);
      return;
    }

    // Scalp chart action
    if (action === 'scalp_chart') {
      await this.showScalpChart(ctx);
      return;
    }

    // Dry run stats action
    if (action === 'dryrun_stats') {
      await this.showDryRunStats(ctx, user.id!);
      return;
    }

    // Dry run reset action
    if (action === 'dryrun_reset') {
      await this.resetDryRunBalance(ctx, user.id!);
      return;
    }
  }

  /**
   * Show chart for a symbol
   */
  private async showChart(ctx: Context, symbol: string): Promise<void> {
    try {
      // Get prices from database or fetch if needed
      let prices = priceRepo.getLatestPrices(symbol, 100);

      if (prices.length < 20) {
        await ctx.reply('⏳ Fetching price data...');
        await dataFetcher.smartFetch(symbol, '15m', 100);
        prices = priceRepo.getLatestPrices(symbol, 100);
      }

      if (prices.length < 5) {
        await ctx.reply(`⚠️ Insufficient data for ${symbol}. Subscribe first.`);
        return;
      }

      // Generate chart
      const chartText = chartRenderer.renderTelegramFull(symbol, prices);
      await ctx.reply(chartText, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply(`❌ Failed to generate chart: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Show charts for all scalp symbols
   */
  private async showScalpChart(ctx: Context): Promise<void> {
    const symbols = this.scalpWorker.config.symbols;

    if (symbols.length === 0) {
      await ctx.reply('⚠️ No symbols configured for scalping.');
      return;
    }

    await ctx.reply('📊 Generating charts...');

    for (const symbol of symbols.slice(0, 3)) { // Limit to 3 charts
      await this.showChart(ctx, symbol);
    }
  }

  /**
   * Show dry run statistics
   */
  private async showDryRunStats(ctx: Context, userId: number): Promise<void> {
    const account = telegramAccountRepo.getDefaultAccount(userId);
    if (!account) {
      await ctx.reply('⛔ No trading account found.');
      return;
    }

    const cfg = this.scalpWorker.config;
    const initialBalance = cfg.dryRunBalance;

    // Get virtual balance
    let currentBalance = this.dryRunBalances.get(account.id!)?.get('IDR') || initialBalance;

    // Get dry run trades from orders table
    const dryRunOrders = orderRepo.getOrdersByAccount(account.id!, 100).filter(o => (o as any).is_dry_run === 1);
    const dryRunPositions = orderRepo.getClosedPositions(account.id!, 100).filter(p => (p as any).is_dry_run === 1);

    const totalTrades = dryRunOrders.length;
    const wins = dryRunPositions.filter(p => (p.pnl_idr ?? 0) > 0).length;
    const losses = dryRunPositions.filter(p => (p.pnl_idr ?? 0) <= 0).length;
    const winRate = totalTrades > 0 ? (wins / (wins + losses)) * 100 : 0;
    const totalPnl = dryRunPositions.reduce((sum, p) => sum + (p.pnl_idr ?? 0), 0);
    const pnlPercent = ((currentBalance - initialBalance) / initialBalance) * 100;

    const text = `📝 Dry Run Statistics\n\n` +
      `Starting: Rp ${this.formatNumber(initialBalance)}\n` +
      `Current:  Rp ${this.formatNumber(currentBalance)}\n` +
      `P/L:      ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% (${totalPnl >= 0 ? '+' : ''}Rp ${this.formatNumber(totalPnl)})\n\n` +
      `Trades: ${totalTrades}\n` +
      `Wins: ${wins} (${winRate.toFixed(1)}%)\n` +
      `Losses: ${losses}`;

    await ctx.editMessageText(text, Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Reset Balance', 'action_dryrun_reset')],
      [Markup.button.callback('« Back', 'menu_scalp')],
    ]));
  }

  /**
   * Reset dry run balance
   */
  private async resetDryRunBalance(ctx: Context, userId: number): Promise<void> {
    const account = telegramAccountRepo.getDefaultAccount(userId);
    if (!account) return;

    const cfg = this.scalpWorker.config;

    // Reset balance
    if (!this.dryRunBalances.has(account.id!)) {
      this.dryRunBalances.set(account.id!, new Map());
    }
    this.dryRunBalances.get(account.id!)!.set('IDR', cfg.dryRunBalance);

    await ctx.answerCbQuery('✅ Balance reset to Rp ' + this.formatNumber(cfg.dryRunBalance));
    await this.showDryRunStats(ctx, userId);
  }

  // ============================================
  // Config Handler
  // ============================================

  private async handleConfig(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^config_(.+)$/);
    if (!match) return;

    const config = match[1];
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    // Scalp config adjustments
    if (config.startsWith('tp_')) {
      const delta = parseFloat(config.replace('tp_', ''));
      this.scalpWorker.config.takeProfitPercent = Math.max(0.05,
        Math.round((this.scalpWorker.config.takeProfitPercent + delta) * 100) / 100
      );
      await ctx.editMessageText(
        '⚙️ Scalp Configuration\n\nAdjust settings with +/- buttons:',
        this.buildScalpConfigMenu()
      );
      await ctx.answerCbQuery(`TP: ${this.scalpWorker.config.takeProfitPercent}%`);
      return;
    }

    if (config.startsWith('sl_')) {
      const delta = parseFloat(config.replace('sl_', ''));
      this.scalpWorker.config.stopLossPercent = Math.max(0.05,
        Math.round((this.scalpWorker.config.stopLossPercent + delta) * 100) / 100
      );
      await ctx.editMessageText(
        '⚙️ Scalp Configuration\n\nAdjust settings with +/- buttons:',
        this.buildScalpConfigMenu()
      );
      await ctx.answerCbQuery(`SL: ${this.scalpWorker.config.stopLossPercent}%`);
      return;
    }

    if (config.startsWith('conf_')) {
      const delta = parseFloat(config.replace('conf_', ''));
      const newConf = Math.max(10, Math.min(100, (this.scalpWorker.config.minConfidence * 100) + delta));
      this.scalpWorker.config.minConfidence = newConf / 100;
      await ctx.editMessageText(
        '⚙️ Scalp Configuration\n\nAdjust settings with +/- buttons:',
        this.buildScalpConfigMenu()
      );
      await ctx.answerCbQuery(`Confidence: ${newConf.toFixed(0)}%`);
      return;
    }

    if (config === 'auto_toggle') {
      this.scalpWorker.config.autoExecute = !this.scalpWorker.config.autoExecute;
      await ctx.editMessageText(
        '⚙️ Scalp Configuration\n\nAdjust settings with +/- buttons:',
        this.buildScalpConfigMenu()
      );
      await ctx.answerCbQuery(`Auto Execute: ${this.scalpWorker.config.autoExecute ? 'ON' : 'OFF'}`);
      return;
    }

    if (config === 'user_auto_toggle') {
      const user = telegramAccountRepo.getUserByTelegramId(userId);
      if (!user) return;
      const settings = telegramAccountRepo.getSettings(user.id!);
      const newValue = settings.auto_execute ? 0 : 1;
      telegramAccountRepo.updateSettings(user.id!, { auto_execute: newValue });
      await ctx.answerCbQuery(`Auto Execute: ${newValue ? 'ON' : 'OFF'}`);
      await ctx.editMessageText(
        `⚙️ Settings\n\nAuto Execute: ${newValue ? 'ON' : 'OFF'}`,
        this.buildSettingsMenu()
      );
      return;
    }

    if (config === 'dryrun_toggle') {
      this.scalpWorker.config.dryRunMode = !this.scalpWorker.config.dryRunMode;
      await ctx.editMessageText(
        '⚙️ Scalp Configuration\n\nAdjust settings with +/- buttons:',
        this.buildScalpConfigMenu()
      );
      await ctx.answerCbQuery(`Dry Run: ${this.scalpWorker.config.dryRunMode ? 'ON' : 'OFF'}`);
      return;
    }
  }

  // ============================================
  // Subscription Handler
  // ============================================

  private async handleSubscriptionToggle(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^sub_toggle_(.+)$/);
    if (!match) return;

    const symbol = match[1].replace('_', '/');
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    await this.safeAnswerCbQuery(ctx);

    const existing = this.symbolSubscriptions.get(symbol);

    if (existing && existing.status !== 'idle' && existing.status !== 'error') {
      // Unsubscribe
      this.symbolSubscriptions.delete(symbol);
      if (realtimeFetcher.connected) {
        realtimeFetcher.unsubscribe(symbol);
      }
      await this.updateSubscriptionMenu(ctx);
      return;
    }

    // Subscribe - start prefetch process
    await this.subscribeToSymbol(ctx, symbol);
  }

  /**
   * Subscribe to a symbol with prefetch
   */
  private async subscribeToSymbol(ctx: Context, symbol: string): Promise<void> {
    // Initialize subscription status
    this.symbolSubscriptions.set(symbol, {
      symbol,
      status: 'prefetching',
      candleCount: 0,
      lastUpdate: Date.now(),
    });

    await this.updateSubscriptionMenu(ctx);

    try {
      // Fetch 1 month of historical data with progress updates
      const sub = this.symbolSubscriptions.get(symbol);

      const result = await dataFetcher.fetchHistorical(symbol, (phase, progress) => {
        if (sub) {
          sub.status = 'prefetching';
          sub.lastUpdate = Date.now();
        }
        // Log progress for debugging
        console.log(`[Subscribe] ${symbol}: ${phase} (${progress}%)`);
      });

      // Update candle count
      if (sub) {
        sub.candleCount = result.total;
        sub.status = 'connecting';
      }

      await this.updateSubscriptionMenu(ctx);

      // Connect to WebSocket if not connected
      if (!realtimeFetcher.connected) {
        await realtimeFetcher.connect();
      }

      // Subscribe to realtime updates
      await realtimeFetcher.subscribe(symbol);

      // Mark as ready (or analyzing if scalp is running)
      if (sub) {
        sub.lastUpdate = Date.now();

        // If scalp is running, add this symbol and set to analyzing
        if (this.scalpWorker.isRunning) {
          if (!this.scalpWorker.symbols.includes(symbol)) {
            this.scalpWorker.symbols.push(symbol);
          }
          sub.status = 'analyzing';
        } else {
          sub.status = 'ready';
        }
      }

      await this.updateSubscriptionMenu(ctx);

      // Send summary notification
      const timeframeSummary = Object.entries(result.timeframes)
        .map(([tf, count]) => `${tf}: ${count}`)
        .join(', ');

      const scalpNote = this.scalpWorker.isRunning
        ? `\n⚡ Added to active scalp worker!`
        : '';

      await ctx.reply(
        `✅ Subscribed to ${symbol}\n\n` +
        `📊 Historical data: ${result.total} candles\n` +
        `📈 Timeframes: ${timeframeSummary}\n` +
        `🔴 WebSocket: Connected${scalpNote}`
      );

    } catch (error) {
      const sub = this.symbolSubscriptions.get(symbol);
      if (sub) {
        sub.status = 'error';
        sub.errorMessage = error instanceof Error ? error.message : String(error);
      }
      await this.updateSubscriptionMenu(ctx);
    }
  }

  /**
   * Update subscription menu in place
   */
  private async updateSubscriptionMenu(ctx: Context): Promise<void> {
    let subText = '📡 Subscriptions\n\nSelect symbols to subscribe:\n';
    const subscribed = Array.from(this.symbolSubscriptions.values());
    if (subscribed.length > 0) {
      subText += '\nStatus:\n';
      for (const sub of subscribed) {
        const icon = this.getSubscriptionIcon(sub.status);
        subText += `${icon} ${sub.symbol}: ${sub.status}`;
        if (sub.status === 'ready' || sub.status === 'prefetching') {
          subText += ` (${sub.candleCount} candles)`;
        }
        subText += '\n';
      }
    }

    try {
      await ctx.editMessageText(subText, this.buildSubscriptionMenu());
    } catch {
      // Ignore edit errors (message might not have changed)
    }
  }

  // ============================================
  // Input Request Handler (ForceReply)
  // ============================================

  private async handleInputRequest(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^input_(.+)$/);
    if (!match) return;

    const inputType = match[1];
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    await this.safeAnswerCbQuery(ctx);

    // Get current menu state
    const state = this.menuStates.get(userId) || { menu: 'main' };

    if (inputType === 'symbol') {
      this.menuStates.set(userId, { ...state, inputMode: 'symbol' });
      await ctx.reply(
        'Enter symbol (e.g., BTC/IDR):',
        { reply_markup: { force_reply: true, selective: true } }
      );
      return;
    }

    if (inputType.startsWith('amount_')) {
      const parts = inputType.replace('amount_', '').split('_');
      const side = parts[0];
      const orderType = parts[1];
      const symbol = parts.slice(2).join('_').replace('_', '/');

      this.menuStates.set(userId, {
        ...state,
        inputMode: 'amount',
        inputData: { side, orderType, symbol },
      });
      await ctx.reply(
        `Enter amount for ${side.toUpperCase()} ${symbol}:`,
        { reply_markup: { force_reply: true, selective: true } }
      );
      return;
    }

    if (inputType === 'scalp_symbols') {
      this.menuStates.set(userId, { ...state, inputMode: 'symbol', inputData: { target: 'scalp_config' } });
      await ctx.reply(
        'Enter symbols separated by comma (e.g., BTC/IDR, ETH/IDR):',
        { reply_markup: { force_reply: true, selective: true } }
      );
      return;
    }
  }

  // ============================================
  // Symbol Selection Handler
  // ============================================

  private async handleSymbolSelect(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^symbol_(.+)$/);
    if (!match) return;

    const symbol = match[1].replace('_', '/');
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    await this.safeAnswerCbQuery(ctx);

    // Update state
    this.menuStates.set(userId, { menu: 'trading', selectedSymbol: symbol });

    // Fetch current price
    let priceText = '';
    try {
      const ticker = await indodax.fetchTicker(symbol);
      priceText = `\nCurrent: Rp ${this.formatNumber(ticker.last)}`;
    } catch {}

    await ctx.editMessageText(
      `📈 ${symbol}${priceText}\n\nSelect action:`,
      this.buildTradingActionsMenu(symbol)
    );
  }

  // ============================================
  // Amount Selection Handler
  // ============================================

  private async handleAmountSelect(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^amount_(\d+)_(.+)$/);
    if (!match) return;

    const percent = parseInt(match[1]);
    const parts = match[2].split('_');
    const side = parts[0] as 'buy' | 'sell';
    const orderType = parts[1] as 'market' | 'limit';
    const symbol = parts.slice(2).join('_').replace('_', '/');

    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const account = telegramAccountRepo.getDefaultAccount(user.id!);
    if (!account) {
      await ctx.answerCbQuery('No trading account found');
      return;
    }

    await ctx.answerCbQuery(`${percent}% selected`);

    // For limit orders, ask for price first
    if (orderType === 'limit') {
      this.menuStates.set(userId, {
        menu: 'trading',
        inputMode: 'price',
        inputData: { side, orderType, symbol, percent },
      });
      await ctx.reply(
        `Enter limit price for ${side.toUpperCase()} ${symbol}:`,
        { reply_markup: { force_reply: true, selective: true } }
      );
      return;
    }

    // Execute market order
    await ctx.reply(`⏳ Executing ${side} ${symbol} (${percent}% of balance)...`);

    // Get balance
    const balanceResult = await tradingExecutor.getBalance(account.id!);
    if (!balanceResult.success) {
      await ctx.reply(`❌ Failed to get balance: ${balanceResult.error}`);
      return;
    }

    const [base, quote] = symbol.split('/');

    let tradeAmount: number;
    if (side === 'buy') {
      const quoteBalance = balanceResult.balances?.find(b => b.currency === quote);
      if (!quoteBalance || quoteBalance.free <= 0) {
        await ctx.reply(`❌ Insufficient ${quote} balance`);
        return;
      }
      // Get current price to calculate amount
      const ticker = await indodax.fetchTicker(symbol);
      const tradeValue = quoteBalance.free * (percent / 100);
      tradeAmount = tradeValue / ticker.last;
    } else {
      const baseBalance = balanceResult.balances?.find(b => b.currency === base);
      if (!baseBalance || baseBalance.free <= 0) {
        await ctx.reply(`❌ Insufficient ${base} balance`);
        return;
      }
      tradeAmount = baseBalance.free * (percent / 100);
    }

    const result = await tradingExecutor.executeMarketOrder(account.id!, symbol, side, tradeAmount);

    if (result.success) {
      await ctx.reply(
        `✅ Order Executed\n\n` +
        `${side.toUpperCase()} ${symbol}\n` +
        `Amount: ${tradeAmount.toFixed(8)}\n` +
        `Order ID: ${result.exchangeOrderId}`
      );
    } else {
      await ctx.reply(`❌ Order failed: ${result.error}`);
    }
  }

  // ============================================
  // Scalp Worker Helpers
  // ============================================

  private async startScalpWorker(ctx: Context): Promise<void> {
    if (this.scalpWorker.isRunning) {
      await ctx.reply('⚠️ Scalp worker is already running!');
      return;
    }

    // Get symbols from subscriptions or config
    let symbols = this.scalpWorker.config.symbols;

    // Check if we have subscriptions
    const readySubscriptions = Array.from(this.symbolSubscriptions.values())
      .filter(s => s.status === 'ready');

    if (readySubscriptions.length > 0) {
      // Use subscribed symbols
      symbols = readySubscriptions.map(s => s.symbol);
    } else {
      // Check if configured symbols have enough data
      const notReady: string[] = [];
      for (const symbol of symbols) {
        const candleCount = priceRepo.getLatestPrices(symbol, 50).length;
        if (candleCount < 50) {
          notReady.push(symbol);
        }
      }

      if (notReady.length > 0) {
        await ctx.reply(
          `⚠️ Cannot start scalp - insufficient data for: ${notReady.join(', ')}\n\n` +
          `Please go to Subscribe menu and subscribe to symbols first.\n` +
          `Required: at least 50 candles per symbol.`,
          this.buildScalpMenu()
        );
        return;
      }
    }

    await ctx.reply(`⏳ Starting scalp worker for: ${symbols.join(', ')}...`);

    try {
      scalper.updateConfig({
        takeProfitPercent: this.scalpWorker.config.takeProfitPercent,
        stopLossPercent: this.scalpWorker.config.stopLossPercent,
        minConfidence: this.scalpWorker.config.minConfidence,
      });

      // Connect to WebSocket if not already connected
      if (!realtimeFetcher.connected) {
        await realtimeFetcher.connect();

        // Subscribe to symbols
        for (const symbol of symbols) {
          await realtimeFetcher.subscribe(symbol);
        }
      }

      // Update subscription status to analyzing
      for (const symbol of symbols) {
        const sub = this.symbolSubscriptions.get(symbol);
        if (sub) {
          sub.status = 'analyzing';
        }
      }

      this.setupScalpSignalHandlers();
      this.setupScalpPriceHandler();

      this.scalpWorker.isRunning = true;
      this.scalpWorker.symbols = symbols;
      this.scalpWorker.startedAt = new Date();
      this.scalpWorker.signalCount = 0;

      const modeText = this.scalpWorker.config.dryRunMode
        ? `Mode: DRY RUN (Rp ${this.formatNumber(this.scalpWorker.config.dryRunBalance)})\n`
        : '';

      await ctx.reply(
        `⚡ Scalp Worker Started!\n\n` +
        `Symbols: ${symbols.join(', ')}\n` +
        `TP: ${this.scalpWorker.config.takeProfitPercent}%\n` +
        `SL: ${this.scalpWorker.config.stopLossPercent}%\n` +
        `${modeText}` +
        `Auto Execute: ${this.scalpWorker.config.autoExecute ? 'ON' : 'OFF'}`,
        this.buildScalpMenu()
      );
    } catch (error) {
      this.scalpWorker.isRunning = false;
      await ctx.reply(`❌ Failed to start: ${error}`);
    }
  }

  private async stopScalpWorker(ctx: Context): Promise<void> {
    if (!this.scalpWorker.isRunning) {
      await ctx.reply('⚠️ Scalp worker is not running.');
      return;
    }

    // Remove scalp-specific listeners (but keep WebSocket connected for subscriptions)
    scalper.removeAllListeners('signal');
    scalper.removeAllListeners('exit');
    realtimeFetcher.removeAllListeners('price');

    // Reset subscription statuses from 'analyzing' back to 'ready'
    for (const sub of this.symbolSubscriptions.values()) {
      if (sub.status === 'analyzing') {
        sub.status = 'ready';
      }
    }

    const duration = this.scalpWorker.startedAt
      ? Math.round((Date.now() - this.scalpWorker.startedAt.getTime()) / 1000 / 60)
      : 0;

    this.scalpWorker.isRunning = false;

    await ctx.editMessageText(
      `🛑 Scalp Worker Stopped\n\n` +
      `Duration: ${duration} minutes\n` +
      `Signals: ${this.scalpWorker.signalCount}\n\n` +
      `📡 Subscriptions preserved (WebSocket still connected)`,
      this.buildScalpMenu()
    );
  }

  private async showScalpStatus(ctx: Context): Promise<void> {
    if (!this.scalpWorker.isRunning) {
      await ctx.reply('📊 Scalp Worker: STOPPED');
      return;
    }

    const duration = this.scalpWorker.startedAt
      ? Math.round((Date.now() - this.scalpWorker.startedAt.getTime()) / 1000 / 60)
      : 0;

    const activeTrades = Array.from(scalper.getActiveScalps().values());
    const cfg = this.scalpWorker.config;
    const isDryRun = cfg.dryRunMode;

    let text = `📊 Scalp Status ${isDryRun ? '(DRY RUN)' : ''}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `⏱ Running: ${duration} min\n`;
    text += `📡 Symbols: ${this.scalpWorker.symbols.join(', ')}\n`;
    text += `📈 Signals: ${this.scalpWorker.signalCount}\n`;
    text += `🎯 TP: ${cfg.takeProfitPercent}% | SL: ${cfg.stopLossPercent}%\n\n`;

    // Real-time prices for subscribed symbols
    text += `💹 Live Prices:\n`;
    for (const symbol of this.scalpWorker.symbols) {
      const realtimePrice = realtimeFetcher.getPrice(symbol);
      if (realtimePrice) {
        const changeIcon = realtimePrice.changePercent >= 0 ? '🟢' : '🔴';
        const changeSign = realtimePrice.changePercent >= 0 ? '+' : '';
        text += `${changeIcon} ${symbol}: Rp ${this.formatNumber(realtimePrice.price)} (${changeSign}${realtimePrice.changePercent.toFixed(2)}%)\n`;
      } else {
        text += `⚪ ${symbol}: No data\n`;
      }
    }

    // Active trades with TP/SL status
    if (activeTrades.length > 0) {
      text += `\n📍 Active Positions (${activeTrades.length}):\n`;
      text += `━━━━━━━━━━━━━━━━━━━━━\n`;

      for (const trade of activeTrades) {
        const signal = trade.signal;
        const currentPrice = realtimeFetcher.getPrice(signal.symbol)?.price || signal.price;
        const entryPrice = signal.price;

        // Calculate current P/L
        const pnlPercent = signal.direction === 'long'
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - currentPrice) / entryPrice) * 100;

        // Calculate distance to TP and SL
        const distanceToTP = signal.direction === 'long'
          ? ((signal.takeProfit - currentPrice) / currentPrice) * 100
          : ((currentPrice - signal.takeProfit) / currentPrice) * 100;

        const distanceToSL = signal.direction === 'long'
          ? ((currentPrice - signal.stopLoss) / currentPrice) * 100
          : ((signal.stopLoss - currentPrice) / currentPrice) * 100;

        // Status indicators
        const pnlIcon = pnlPercent >= 0 ? '🟢' : '🔴';
        const dirIcon = signal.direction === 'long' ? '📈' : '📉';

        // TP/SL hit check
        let tpslStatus = '';
        if (distanceToTP <= 0) {
          tpslStatus = '🎯 TP HIT!';
        } else if (distanceToSL <= 0) {
          tpslStatus = '🛑 SL HIT!';
        } else if (distanceToTP < 0.1) {
          tpslStatus = '⚡ Near TP!';
        } else if (distanceToSL < 0.05) {
          tpslStatus = '⚠️ Near SL!';
        }

        text += `\n${dirIcon} ${signal.symbol} ${signal.direction.toUpperCase()}\n`;
        text += `   Entry: Rp ${this.formatNumber(entryPrice)}\n`;
        text += `   Now:   Rp ${this.formatNumber(currentPrice)}\n`;
        text += `   ${pnlIcon} P/L: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(3)}%\n`;
        text += `   TP: ${distanceToTP.toFixed(2)}% away | SL: ${distanceToSL.toFixed(2)}% away\n`;
        if (tpslStatus) {
          text += `   ${tpslStatus}\n`;
        }
      }
    } else {
      text += `\n📍 No active positions\n`;
      text += `Waiting for signals...\n`;
    }

    text += `\n⏰ Updated: ${new Date().toLocaleTimeString('id-ID')}`;

    await ctx.reply(text, Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Refresh', 'action_scalp_status'),
        Markup.button.callback('📊 Chart', 'action_scalp_chart'),
      ],
      [Markup.button.callback('« Back', 'menu_scalp')],
    ]));
  }

  /**
   * Setup event listeners for trading events
   */
  private setupEventListeners(): void {
    // Position tracker events
    positionTracker.on('position:auto_closed', this.handlePositionAutoClosed.bind(this));
    positionTracker.on('position:update', this.handlePositionUpdate.bind(this));

    // Trading executor events
    tradingExecutor.on('order:executed', this.handleOrderExecuted.bind(this));
    tradingExecutor.on('position:opened', this.handlePositionOpened.bind(this));
  }

  // ============================================
  // Middleware
  // ============================================

  /**
   * Require admin access
   */
  private requireAdmin(handler: (ctx: Context) => Promise<void>) {
    return async (ctx: Context) => {
      const userId = ctx.from?.id?.toString();
      if (!userId || !this.adminIds.includes(userId)) {
        await ctx.reply('⛔ Admin access required');
        return;
      }
      await handler(ctx);
    };
  }

  /**
   * Require user authentication
   */
  private requireAuth(handler: (ctx: Context) => Promise<void>) {
    return async (ctx: Context) => {
      const userId = ctx.from?.id?.toString();
      if (!userId) {
        await ctx.reply('⛔ Unable to identify user');
        return;
      }

      const user = telegramAccountRepo.getUserByTelegramId(userId);
      if (!user || !user.is_active) {
        // Check if user is admin (auto-authorize admins)
        if (this.adminIds.includes(userId)) {
          telegramAccountRepo.createUser(userId, ctx.from?.username, 'admin');
        } else {
          await ctx.reply('⛔ You are not authorized. Contact admin for access.');
          return;
        }
      }

      await handler(ctx);
    };
  }

  // ============================================
  // Command Handlers
  // ============================================

  private async handleStart(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    // Check if admin
    if (this.adminIds.includes(userId)) {
      telegramAccountRepo.createUser(userId, ctx.from?.username, 'admin');
      await ctx.reply(
        '👋 Welcome Admin!\n\n' +
        'You have full access to Crypto Snipper Trading Bot.\n\n' +
        'Select an option below to get started:',
        this.buildMainMenu()
      );
    } else {
      const user = telegramAccountRepo.getUserByTelegramId(userId);
      if (user && user.is_active) {
        await ctx.reply(
          '👋 Welcome back to Crypto Snipper!\n\n' +
          'Select an option:',
          this.buildMainMenu()
        );
      } else {
        await ctx.reply(
          '👋 Welcome to Crypto Snipper Trading Bot!\n\n' +
          '⛔ You are not authorized yet.\n' +
          'Please contact an admin to get access.'
        );
      }
    }
  }

  private async handleHelp(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    const isAdmin = userId && this.adminIds.includes(userId);

    let helpText = `📚 Available Commands

Account Management
/account_add - Add Indodax API credentials
/account_list - List your trading accounts
/account_remove <name> - Remove an account
/balance - Check account balance

Trading
/buy <symbol> <amount> [price] - Buy order
/sell <symbol> <amount> [price] - Sell order
/orders - List open orders
/cancel <order_id> - Cancel an order

Positions
/positions - List open positions
/close <id> [price] - Close a position
/set_tp <id> <price> - Set take profit
/set_sl <id> <price> - Set stop loss

Scalping
/scalp_start [symbols] - Start scalp worker
/scalp_stop - Stop scalp worker
/scalp_status - Check worker status
/scalp_config - Configure scalp settings
/scalp_auto on|off - Toggle auto-execute

Info
/price <symbol> - Get current price
/stats - Trading statistics
/help - Show this help
`;

    if (isAdmin) {
      helpText += `
Admin Commands
/admin_add <telegram_id> - Authorize user
/admin_remove <telegram_id> - Revoke access
/admin_list - List all users
/admin_stats - Global statistics
`;
    }

    helpText += `
Examples
/buy BTC/IDR 0.001 - Market buy
/sell BTC/IDR 0.001 500000000 - Limit sell
/price BTC/IDR - Check BTC price
`;

    await ctx.reply(helpText);
  }

  // Admin commands
  private async handleAdminAdd(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 1) {
      await ctx.reply('Usage: /admin_add <telegram_id> [username]');
      return;
    }

    const telegramId = args[0];
    const username = args[1] || null;

    telegramAccountRepo.createUser(telegramId, username, 'user');
    await ctx.reply(`✅ User ${telegramId} authorized`);
  }

  private async handleAdminRemove(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 1) {
      await ctx.reply('Usage: /admin_remove <telegram_id>');
      return;
    }

    const telegramId = args[0];
    telegramAccountRepo.deactivateUser(telegramId);
    await ctx.reply(`✅ User ${telegramId} access revoked`);
  }

  private async handleAdminList(ctx: Context): Promise<void> {
    const users = telegramAccountRepo.getAllUsers(false);

    if (users.length === 0) {
      await ctx.reply('No users found');
      return;
    }

    let text = '👥 Authorized Users\n\n';
    for (const user of users) {
      const status = user.is_active ? '✅' : '❌';
      const role = user.role === 'admin' ? '👑' : '👤';
      text += `${status} ${role} ${user.telegram_id}`;
      if (user.username) text += ` @${user.username}`;
      text += '\n';
    }

    await ctx.reply(text);
  }

  private async handleAdminStats(ctx: Context): Promise<void> {
    const stats = orderRepo.getGlobalStats();

    const text = `📊 Global Trading Statistics

Total Trades: ${stats.totalTrades}
Wins: ${stats.wins}
Losses: ${stats.losses}
Win Rate: ${stats.winRate.toFixed(1)}%
Total P/L: Rp ${this.formatNumber(stats.totalPnlIdr)}`;

    await ctx.reply(text);
  }

  // Account management
  private async handleAccountAdd(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    // Start wizard
    this.wizardStates.set(userId, { step: 'name' });

    await ctx.reply(
      '🔐 *Add Trading Account*\n\n' +
      'This wizard will help you add your Indodax API credentials.\n' +
      'Your keys will be encrypted and stored securely.\n\n' +
      'Step 1/3: Enter a name for this account (e.g., "main", "trading"):',
      { parse_mode: 'Markdown' }
    );
  }

  private async handleAccountList(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const accounts = telegramAccountRepo.getTradingAccounts(user.id!);

    if (accounts.length === 0) {
      await ctx.reply(
        'No trading accounts linked.\n' +
        'Use /account_add to add your Indodax API credentials.'
      );
      return;
    }

    let text = '💼 Your Trading Accounts\n\n';
    for (const account of accounts) {
      const isDefault = account.is_default ? ' ⭐' : '';
      text += `• ${account.account_name}${isDefault}\n`;
    }

    await ctx.reply(text);
  }

  private async handleAccountRemove(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 1) {
      await ctx.reply('Usage: /account_remove <account_name>');
      return;
    }

    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const accounts = telegramAccountRepo.getTradingAccounts(user.id!);
    const account = accounts.find(a => a.account_name === args[0]);

    if (!account) {
      await ctx.reply(`Account "${args[0]}" not found`);
      return;
    }

    telegramAccountRepo.deactivateTradingAccount(account.id!);
    await ctx.reply(`✅ Account "${args[0]}" removed`);
  }

  private async handleBalance(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const account = telegramAccountRepo.getDefaultAccount(user.id!);
    if (!account) {
      await ctx.reply('No trading account found. Use /account_add first.');
      return;
    }

    await ctx.reply('⏳ Fetching balance...');

    const result = await tradingExecutor.getBalance(account.id!);

    if (!result.success) {
      await ctx.reply(`❌ Failed to fetch balance: ${result.error}`);
      return;
    }

    let text = `💰 Balance (${account.account_name})\n\n`;

    for (const balance of result.balances || []) {
      if (balance.total > 0) {
        text += `${balance.currency}\n`;
        text += `  Free: ${this.formatNumber(balance.free)}\n`;
        if (balance.used > 0) {
          text += `  In Orders: ${this.formatNumber(balance.used)}\n`;
        }
        text += '\n';
      }
    }

    await ctx.reply(text);
  }

  // Trading commands
  private async handleBuy(ctx: Context): Promise<void> {
    await this.handleOrder(ctx, 'buy');
  }

  private async handleSell(ctx: Context): Promise<void> {
    await this.handleOrder(ctx, 'sell');
  }

  private async handleOrder(ctx: Context, side: 'buy' | 'sell'): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 2) {
      await ctx.reply(`Usage: /${side} <symbol> <amount> [price]`);
      return;
    }

    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const account = telegramAccountRepo.getDefaultAccount(user.id!);
    if (!account) {
      await ctx.reply('No trading account found. Use /account_add first.');
      return;
    }

    const symbol = args[0].toUpperCase();
    const amount = parseFloat(args[1]);
    const price = args[2] ? parseFloat(args[2]) : undefined;

    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('Invalid amount');
      return;
    }

    await ctx.reply(`⏳ Placing ${side} order...`);

    let result;
    if (price) {
      result = await tradingExecutor.executeLimitOrder(account.id!, symbol, side, amount, price);
    } else {
      result = await tradingExecutor.executeMarketOrder(account.id!, symbol, side, amount);
    }

    if (result.success) {
      const order = result.order!;
      const orderType = price ? 'Limit' : 'Market';

      await ctx.reply(
        `✅ ${orderType} ${side.toUpperCase()} Order Placed\n\n` +
        `Symbol: ${symbol}\n` +
        `Amount: ${amount}\n` +
        (price ? `Price: Rp ${this.formatNumber(price)}\n` : '') +
        `Order ID: ${result.exchangeOrderId}\n` +
        `Status: ${order.status}`
      );
    } else {
      await ctx.reply(`❌ Order failed: ${result.error}`);
    }
  }

  private async handleCancel(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 1) {
      await ctx.reply('Usage: /cancel <order_id>');
      return;
    }

    const orderId = parseInt(args[0]);
    if (isNaN(orderId)) {
      await ctx.reply('Invalid order ID');
      return;
    }

    const result = await tradingExecutor.cancelOrder(orderId);

    if (result.success) {
      await ctx.reply(`✅ Order ${orderId} cancelled`);
    } else {
      await ctx.reply(`❌ Failed to cancel: ${result.error}`);
    }
  }

  private async handleOrders(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const account = telegramAccountRepo.getDefaultAccount(user.id!);
    if (!account) {
      await ctx.reply('No trading account found');
      return;
    }

    const orders = orderRepo.getOpenOrders(account.id!);

    if (orders.length === 0) {
      await ctx.reply('No open orders');
      return;
    }

    let text = '📋 Open Orders\n\n';

    for (const order of orders) {
      text += `#${order.id} ${order.side.toUpperCase()} ${order.symbol}\n`;
      text += `  Amount: ${order.amount}\n`;
      if (order.price) text += `  Price: Rp ${this.formatNumber(order.price)}\n`;
      text += `  Status: ${order.status}\n\n`;
    }

    await ctx.reply(text);
  }

  // Position management
  private async handlePositions(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const account = telegramAccountRepo.getDefaultAccount(user.id!);
    if (!account) {
      await ctx.reply('No trading account found');
      return;
    }

    const positions = orderRepo.getOpenPositions(account.id!);

    if (positions.length === 0) {
      await ctx.reply('No open positions');
      return;
    }

    for (const position of positions) {
      let currentPrice: number;
      try {
        const ticker = await indodax.fetchTicker(position.symbol);
        currentPrice = ticker.last;
      } catch {
        currentPrice = position.entry_price;
      }

      const pnlPercent = position.side === 'long'
        ? ((currentPrice - position.entry_price) / position.entry_price) * 100
        : ((position.entry_price - currentPrice) / position.entry_price) * 100;

      const pnlEmoji = pnlPercent >= 0 ? '🟢' : '🔴';

      const text = `📊 Position #${position.id}
Symbol: ${position.symbol}
Side: ${position.side.toUpperCase()}
Amount: ${position.amount}
Entry: Rp ${this.formatNumber(position.entry_price)}
Current: Rp ${this.formatNumber(currentPrice)}
P/L: ${pnlEmoji} ${pnlPercent.toFixed(2)}%
TP: ${position.take_profit_price ? 'Rp ' + this.formatNumber(position.take_profit_price) : 'Not set'}
SL: ${position.stop_loss_price ? 'Rp ' + this.formatNumber(position.stop_loss_price) : 'Not set'}`;

      await ctx.reply(text, Markup.inlineKeyboard([
        Markup.button.callback('Close Position', `close_pos_${position.id}`)
      ]));
    }
  }

  private async handleClose(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 1) {
      await ctx.reply('Usage: /close <position_id> [price]');
      return;
    }

    const positionId = parseInt(args[0]);
    const price = args[1] ? parseFloat(args[1]) : undefined;

    if (isNaN(positionId)) {
      await ctx.reply('Invalid position ID');
      return;
    }

    await ctx.reply('⏳ Closing position...');

    const result = await tradingExecutor.closePosition(positionId, price);

    if (result.success) {
      const pos = result.position!;
      const pnlEmoji = (pos.pnl_percent || 0) >= 0 ? '🟢' : '🔴';

      await ctx.reply(
        `✅ Position Closed\n\n` +
        `Symbol: ${pos.symbol}\n` +
        `Exit Price: Rp ${this.formatNumber(pos.exit_price || 0)}\n` +
        `P/L: ${pnlEmoji} ${pos.pnl_percent?.toFixed(2)}%\n` +
        `P/L IDR: Rp ${this.formatNumber(pos.pnl_idr || 0)}`
      );
    } else {
      await ctx.reply(`❌ Failed to close: ${result.error}`);
    }
  }

  private async handleSetTp(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 2) {
      await ctx.reply('Usage: /set_tp <position_id> <price>');
      return;
    }

    const positionId = parseInt(args[0]);
    const price = parseFloat(args[1]);

    if (isNaN(positionId) || isNaN(price)) {
      await ctx.reply('Invalid parameters');
      return;
    }

    const result = await tradingExecutor.updateTakeProfit(positionId, price);

    if (result.success) {
      await ctx.reply(`✅ Take profit set to Rp ${this.formatNumber(price)}`);
    } else {
      await ctx.reply(`❌ Failed: ${result.error}`);
    }
  }

  private async handleSetSl(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 2) {
      await ctx.reply('Usage: /set_sl <position_id> <price>');
      return;
    }

    const positionId = parseInt(args[0]);
    const price = parseFloat(args[1]);

    if (isNaN(positionId) || isNaN(price)) {
      await ctx.reply('Invalid parameters');
      return;
    }

    const result = await tradingExecutor.updateStopLoss(positionId, price);

    if (result.success) {
      await ctx.reply(`✅ Stop loss set to Rp ${this.formatNumber(price)}`);
    } else {
      await ctx.reply(`❌ Failed: ${result.error}`);
    }
  }

  // Info commands
  private async handlePrice(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    if (!args || args.length < 1) {
      await ctx.reply('Usage: /price <symbol>');
      return;
    }

    const symbol = args[0].toUpperCase();

    try {
      const ticker = await indodax.fetchTicker(symbol);

      await ctx.reply(
        `💹 *${symbol}*\n\n` +
        `Price: Rp ${this.formatNumber(ticker.last)}\n` +
        `Bid: Rp ${this.formatNumber(ticker.bid)}\n` +
        `Ask: Rp ${this.formatNumber(ticker.ask)}\n` +
        `Volume: ${this.formatNumber(ticker.volume)}`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      await ctx.reply(`❌ Failed to fetch price for ${symbol}`);
    }
  }

  private async handleStats(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const account = telegramAccountRepo.getDefaultAccount(user.id!);
    if (!account) {
      await ctx.reply('No trading account found');
      return;
    }

    const stats = orderRepo.getTradeStats(account.id!);

    const text = `📊 Your Trading Statistics

Total Trades: ${stats.totalTrades}
Wins: ${stats.wins}
Losses: ${stats.losses}
Win Rate: ${stats.winRate.toFixed(1)}%
Avg P/L: ${stats.avgPnlPercent.toFixed(2)}%
Total P/L: Rp ${this.formatNumber(stats.totalPnlIdr)}`;

    await ctx.reply(text);
  }

  /**
   * Handle /subscribe command - show subscription menu
   */
  private async handleSubscribeCommand(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);

    // If symbol provided, subscribe directly
    if (args && args.length > 0) {
      const symbol = args[0].toUpperCase();
      const normalizedSymbol = symbol.includes('/') ? symbol : `${symbol}/IDR`;

      // Check if already subscribed
      const existing = this.symbolSubscriptions.get(normalizedSymbol);
      if (existing && existing.status !== 'idle' && existing.status !== 'error') {
        await ctx.reply(`ℹ️ Already subscribed to ${normalizedSymbol} (${existing.status}, ${existing.candleCount} candles)`);
        return;
      }

      await ctx.reply(`📡 Subscribing to ${normalizedSymbol}...`);
      await this.subscribeToSymbol(ctx, normalizedSymbol);
      return;
    }

    // Show subscription menu
    await ctx.reply(
      this.buildSubscriptionStatusText(),
      this.buildSubscriptionMenu('main')
    );
  }

  private async handleScalpAuto(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    if (!args || args.length < 1) {
      const settings = telegramAccountRepo.getSettings(user.id!);
      const status = settings.auto_execute ? 'ON' : 'OFF';
      await ctx.reply(`Auto-execute is currently: ${status}\nUse /scalp_auto on or /scalp_auto off`);
      return;
    }

    const value = args[0].toLowerCase() === 'on' ? 1 : 0;
    telegramAccountRepo.updateSettings(user.id!, { auto_execute: value });

    await ctx.reply(`✅ Auto-execute ${value ? 'enabled' : 'disabled'}`);
  }

  // Scalp worker control commands
  private async handleScalpStart(ctx: Context): Promise<void> {
    if (this.scalpWorker.isRunning) {
      await ctx.reply('⚠️ Scalp worker is already running!\nUse /scalp_stop to stop it first.');
      return;
    }

    const args = (ctx.message as any)?.text?.split(' ').slice(1);

    // Parse symbols from arguments or use config
    let symbols = this.scalpWorker.config.symbols;
    if (args && args.length > 0) {
      symbols = args[0].split(',').map((s: string) => s.trim().toUpperCase());
      // Ensure format is SYMBOL/IDR
      symbols = symbols.map((s: string) => s.includes('/') ? s : `${s}/IDR`);
    }

    await ctx.reply(`⏳ Starting scalp worker for: ${symbols.join(', ')}...`);

    try {
      // Apply scalp configuration
      scalper.updateConfig({
        takeProfitPercent: this.scalpWorker.config.takeProfitPercent,
        stopLossPercent: this.scalpWorker.config.stopLossPercent,
        minConfidence: this.scalpWorker.config.minConfidence,
      });

      // Connect to WebSocket
      await realtimeFetcher.connect();

      // Subscribe to symbols
      for (const symbol of symbols) {
        realtimeFetcher.subscribe(symbol);
      }

      // Setup signal handlers
      this.setupScalpSignalHandlers();

      // Setup price handler for analysis
      this.setupScalpPriceHandler();

      // Update state
      this.scalpWorker.isRunning = true;
      this.scalpWorker.symbols = symbols;
      this.scalpWorker.startedAt = new Date();
      this.scalpWorker.signalCount = 0;

      const configText = `⚡ Scalp Worker Started!

Symbols: ${symbols.join(', ')}
Take Profit: ${this.scalpWorker.config.takeProfitPercent}%
Stop Loss: ${this.scalpWorker.config.stopLossPercent}%
Min Confidence: ${(this.scalpWorker.config.minConfidence * 100).toFixed(0)}%
Auto Execute: ${this.scalpWorker.config.autoExecute ? 'ON' : 'OFF'}

Commands:
/scalp_status - Check status
/scalp_stop - Stop worker
/scalp_config - Configure settings
/scalp_auto on|off - Toggle auto-execute`;

      await ctx.reply(configText);

    } catch (error) {
      this.scalpWorker.isRunning = false;
      await ctx.reply(`❌ Failed to start scalp worker: ${error}`);
    }
  }

  private async handleScalpStop(ctx: Context): Promise<void> {
    if (!this.scalpWorker.isRunning) {
      await ctx.reply('⚠️ Scalp worker is not running.');
      return;
    }

    try {
      // Disconnect from WebSocket
      realtimeFetcher.disconnect();

      // Remove signal handlers
      scalper.removeAllListeners('signal');
      scalper.removeAllListeners('exit');
      realtimeFetcher.removeAllListeners('price');

      const duration = this.scalpWorker.startedAt
        ? Math.round((Date.now() - this.scalpWorker.startedAt.getTime()) / 1000 / 60)
        : 0;

      // Update state
      this.scalpWorker.isRunning = false;

      await ctx.reply(`🛑 Scalp Worker Stopped

Duration: ${duration} minutes
Signals Generated: ${this.scalpWorker.signalCount}`);

    } catch (error) {
      await ctx.reply(`❌ Error stopping scalp worker: ${error}`);
    }
  }

  private async handleScalpStatus(ctx: Context): Promise<void> {
    if (!this.scalpWorker.isRunning) {
      await ctx.reply(`📊 Scalp Worker Status: STOPPED

Use /scalp_start to start the worker.`);
      return;
    }

    const duration = this.scalpWorker.startedAt
      ? Math.round((Date.now() - this.scalpWorker.startedAt.getTime()) / 1000 / 60)
      : 0;

    const activeTrades = Array.from(scalper.getActiveScalps().values());

    let text = `📊 Scalp Worker Status: RUNNING

Symbols: ${this.scalpWorker.symbols.join(', ')}
Running Time: ${duration} minutes
Signals Generated: ${this.scalpWorker.signalCount}
Active Trades: ${activeTrades.length}

Configuration:
• TP: ${this.scalpWorker.config.takeProfitPercent}%
• SL: ${this.scalpWorker.config.stopLossPercent}%
• Min Confidence: ${(this.scalpWorker.config.minConfidence * 100).toFixed(0)}%
• Auto Execute: ${this.scalpWorker.config.autoExecute ? 'ON' : 'OFF'}`;

    if (activeTrades.length > 0) {
      text += '\n\nActive Trades:';
      for (const trade of activeTrades) {
        const pnl = trade.profitPercent?.toFixed(3) || '0';
        text += `\n• ${trade.signal.symbol} ${trade.signal.direction.toUpperCase()} ${pnl}%`;
      }
    }

    await ctx.reply(text);
  }

  private async handleScalpConfig(ctx: Context): Promise<void> {
    const args = (ctx.message as any)?.text?.split(' ').slice(1);

    if (!args || args.length < 2) {
      await ctx.reply(`⚙️ Scalp Configuration

Current Settings:
• symbols: ${this.scalpWorker.config.symbols.join(',')}
• tp: ${this.scalpWorker.config.takeProfitPercent}%
• sl: ${this.scalpWorker.config.stopLossPercent}%
• confidence: ${(this.scalpWorker.config.minConfidence * 100).toFixed(0)}%
• auto: ${this.scalpWorker.config.autoExecute ? 'on' : 'off'}

Usage:
/scalp_config <param> <value>

Examples:
/scalp_config symbols BTC/IDR,ETH/IDR
/scalp_config tp 0.5
/scalp_config sl 0.25
/scalp_config confidence 70
/scalp_config auto on`);
      return;
    }

    const param = args[0].toLowerCase();
    const value = args.slice(1).join(' ');

    switch (param) {
      case 'symbols':
        const symbols = value.split(',').map((s: string) => {
          const sym = s.trim().toUpperCase();
          return sym.includes('/') ? sym : `${sym}/IDR`;
        });
        this.scalpWorker.config.symbols = symbols;
        await ctx.reply(`✅ Symbols set to: ${symbols.join(', ')}`);
        break;

      case 'tp':
        const tp = parseFloat(value);
        if (isNaN(tp) || tp <= 0) {
          await ctx.reply('❌ Invalid take profit value');
          return;
        }
        this.scalpWorker.config.takeProfitPercent = tp;
        await ctx.reply(`✅ Take profit set to: ${tp}%`);
        break;

      case 'sl':
        const sl = parseFloat(value);
        if (isNaN(sl) || sl <= 0) {
          await ctx.reply('❌ Invalid stop loss value');
          return;
        }
        this.scalpWorker.config.stopLossPercent = sl;
        await ctx.reply(`✅ Stop loss set to: ${sl}%`);
        break;

      case 'confidence':
        const conf = parseFloat(value);
        if (isNaN(conf) || conf < 0 || conf > 100) {
          await ctx.reply('❌ Invalid confidence value (0-100)');
          return;
        }
        this.scalpWorker.config.minConfidence = conf / 100;
        await ctx.reply(`✅ Min confidence set to: ${conf}%`);
        break;

      case 'auto':
        const autoVal = value.toLowerCase() === 'on';
        this.scalpWorker.config.autoExecute = autoVal;
        await ctx.reply(`✅ Auto-execute ${autoVal ? 'enabled' : 'disabled'}`);
        break;

      default:
        await ctx.reply(`❌ Unknown parameter: ${param}\nValid params: symbols, tp, sl, confidence, auto`);
    }

    // Apply config to scalper if running
    if (this.scalpWorker.isRunning) {
      scalper.updateConfig({
        takeProfitPercent: this.scalpWorker.config.takeProfitPercent,
        stopLossPercent: this.scalpWorker.config.stopLossPercent,
        minConfidence: this.scalpWorker.config.minConfidence,
      });
    }
  }

  private setupScalpSignalHandlers(): void {
    // Remove existing handlers first
    scalper.removeAllListeners('signal');
    scalper.removeAllListeners('exit');

    // Signal handler
    scalper.on('signal', async (signal: ScalpSignal) => {
      this.scalpWorker.signalCount++;
      await this.broadcastScalpSignal(signal, this.scalpWorker.config.autoExecute);
    });

    // Exit handler
    scalper.on('exit', async (trade: ActiveScalp) => {
      await this.broadcastScalpExit(trade);
    });
  }

  private setupScalpPriceHandler(): void {
    // Remove existing handler first
    realtimeFetcher.removeAllListeners('price');

    // Track last analysis time per symbol
    const lastAnalysis: Map<string, number> = new Map();
    const analysisInterval = 2000; // 2 seconds

    realtimeFetcher.on('price', async (price: any) => {
      const now = Date.now();
      const lastTime = lastAnalysis.get(price.symbol) || 0;

      if (now - lastTime >= analysisInterval) {
        lastAnalysis.set(price.symbol, now);

        try {
          // Analyze for scalp opportunities (scalper fetches orderbook internally)
          await scalper.analyze(price.symbol, price.price);
        } catch (error) {
          // Silently ignore analysis errors
        }
      }
    });
  }

  // Text handler for wizard and ForceReply inputs
  private async handleText(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const text = (ctx.message as any)?.text?.trim();
    if (!text) return;

    // Check for menu state input mode first
    const menuState = this.menuStates.get(userId);
    if (menuState?.inputMode) {
      await this.handleMenuInput(ctx, userId, text, menuState);
      return;
    }

    // Check for wizard state
    const wizardState = this.wizardStates.get(userId);
    if (wizardState) {
      await this.handleWizardInput(ctx, userId, text, wizardState);
      return;
    }
  }

  /**
   * Handle menu-based ForceReply inputs
   */
  private async handleMenuInput(ctx: Context, userId: string, text: string, state: MenuState): Promise<void> {
    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    switch (state.inputMode) {
      case 'account_name':
        // Start wizard mode for account setup
        this.wizardStates.set(userId, { step: 'apiKey', accountName: text });
        this.menuStates.set(userId, { menu: 'account', inputMode: 'api_key' });
        await ctx.reply(
          'Enter your Indodax API Key:\n\n(Get it from indodax.com → Settings → API)',
          { reply_markup: { force_reply: true, selective: true } }
        );
        break;

      case 'api_key':
        const wizardApiKey = this.wizardStates.get(userId);
        if (wizardApiKey) {
          wizardApiKey.apiKey = text;
          wizardApiKey.step = 'apiSecret';
        }
        this.menuStates.set(userId, { menu: 'account', inputMode: 'api_secret' });
        await ctx.reply(
          'Enter your Indodax API Secret:',
          { reply_markup: { force_reply: true, selective: true } }
        );
        // Delete the message containing API key for security
        try { await ctx.deleteMessage(); } catch {}
        break;

      case 'api_secret':
        const wizardSecret = this.wizardStates.get(userId);
        if (wizardSecret) {
          wizardSecret.apiSecret = text;
          wizardSecret.step = 'confirm';
        }
        // Delete the message containing API secret for security
        try { await ctx.deleteMessage(); } catch {}
        // Clear input mode
        this.menuStates.set(userId, { menu: 'account' });

        await ctx.reply(
          `⚠️ Confirm Account Setup\n\n` +
          `Account Name: ${wizardSecret?.accountName}\n` +
          `API Key: ${wizardSecret?.apiKey?.substring(0, 8)}...***\n\n` +
          `Your credentials will be encrypted and stored securely.`,
          Markup.inlineKeyboard([
            Markup.button.callback('✅ Confirm', 'confirm_account'),
            Markup.button.callback('❌ Cancel', 'cancel_account')
          ])
        );
        break;

      case 'symbol':
        const symbol = text.toUpperCase().includes('/') ? text.toUpperCase() : `${text.toUpperCase()}/IDR`;

        // Check if this is for scalp config or trading
        if (state.inputData?.target === 'scalp_config') {
          const symbols = text.split(',').map(s => {
            const sym = s.trim().toUpperCase();
            return sym.includes('/') ? sym : `${sym}/IDR`;
          });
          this.scalpWorker.config.symbols = symbols;
          this.menuStates.delete(userId);
          await ctx.reply(
            `✅ Symbols set to: ${symbols.join(', ')}`,
            this.buildScalpConfigMenu()
          );
        } else {
          // Trading - show symbol actions
          this.menuStates.set(userId, { menu: 'trading', selectedSymbol: symbol });
          let priceText = '';
          try {
            const ticker = await indodax.fetchTicker(symbol);
            priceText = `\nCurrent: Rp ${this.formatNumber(ticker.last)}`;
          } catch {}
          await ctx.reply(
            `📈 ${symbol}${priceText}\n\nSelect action:`,
            this.buildTradingActionsMenu(symbol)
          );
        }
        break;

      case 'amount':
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
          await ctx.reply('❌ Invalid amount. Please enter a valid number.');
          return;
        }

        const { side, orderType, symbol: tradeSymbol } = state.inputData || {};
        if (!side || !tradeSymbol) return;

        const account = telegramAccountRepo.getDefaultAccount(user.id!);
        if (!account) {
          await ctx.reply('No trading account found');
          return;
        }

        // For limit orders, ask for price
        if (orderType === 'limit') {
          this.menuStates.set(userId, {
            menu: 'trading',
            inputMode: 'price',
            inputData: { side, orderType, symbol: tradeSymbol, amount },
          });
          await ctx.reply(
            `Enter limit price for ${side.toUpperCase()} ${tradeSymbol}:`,
            { reply_markup: { force_reply: true, selective: true } }
          );
          return;
        }

        // Execute market order
        this.menuStates.delete(userId);
        await ctx.reply(`⏳ Executing ${side} ${tradeSymbol}...`);

        const marketResult = await tradingExecutor.executeMarketOrder(account.id!, tradeSymbol, side, amount);
        if (marketResult.success) {
          await ctx.reply(
            `✅ Order Executed\n\n` +
            `${side.toUpperCase()} ${tradeSymbol}\n` +
            `Amount: ${amount}\n` +
            `Order ID: ${marketResult.exchangeOrderId}`
          );
        } else {
          await ctx.reply(`❌ Order failed: ${marketResult.error}`);
        }
        break;

      case 'price':
        const price = parseFloat(text);
        if (isNaN(price) || price <= 0) {
          await ctx.reply('❌ Invalid price. Please enter a valid number.');
          return;
        }

        const limitData = state.inputData;
        if (!limitData?.side || !limitData?.symbol) return;

        const limitAccount = telegramAccountRepo.getDefaultAccount(user.id!);
        if (!limitAccount) {
          await ctx.reply('No trading account found');
          return;
        }

        let tradeAmount: number;

        // If percent was selected, calculate amount from balance
        if (limitData.percent) {
          const balanceResult = await tradingExecutor.getBalance(limitAccount.id!);
          if (!balanceResult.success) {
            await ctx.reply(`❌ Failed to get balance: ${balanceResult.error}`);
            return;
          }

          const [base, quote] = limitData.symbol.split('/');

          if (limitData.side === 'buy') {
            const quoteBalance = balanceResult.balances?.find(b => b.currency === quote);
            if (!quoteBalance || quoteBalance.free <= 0) {
              await ctx.reply(`❌ Insufficient ${quote} balance`);
              return;
            }
            const tradeValue = quoteBalance.free * (limitData.percent / 100);
            tradeAmount = tradeValue / price;
          } else {
            const baseBalance = balanceResult.balances?.find(b => b.currency === base);
            if (!baseBalance || baseBalance.free <= 0) {
              await ctx.reply(`❌ Insufficient ${base} balance`);
              return;
            }
            tradeAmount = baseBalance.free * (limitData.percent / 100);
          }
        } else if (limitData.amount) {
          tradeAmount = limitData.amount;
        } else {
          await ctx.reply('❌ No amount specified');
          return;
        }

        this.menuStates.delete(userId);
        await ctx.reply(`⏳ Placing limit order...`);

        const limitResult = await tradingExecutor.executeLimitOrder(
          limitAccount.id!,
          limitData.symbol,
          limitData.side,
          tradeAmount,
          price
        );

        if (limitResult.success) {
          await ctx.reply(
            `✅ Limit Order Placed\n\n` +
            `${limitData.side.toUpperCase()} ${limitData.symbol}\n` +
            `Amount: ${tradeAmount.toFixed(8)}\n` +
            `Price: Rp ${this.formatNumber(price)}\n` +
            `Order ID: ${limitResult.exchangeOrderId}`
          );
        } else {
          await ctx.reply(`❌ Order failed: ${limitResult.error}`);
        }
        break;
    }
  }

  /**
   * Handle wizard-based inputs (legacy)
   */
  private async handleWizardInput(ctx: Context, userId: string, text: string, state: WizardState): Promise<void> {
    switch (state.step) {
      case 'name':
        state.accountName = text;
        state.step = 'apiKey';
        await ctx.reply(
          'Step 2/3: Enter your Indodax API Key:\n\n' +
          '(Get it from indodax.com → Settings → API)'
        );
        break;

      case 'apiKey':
        state.apiKey = text;
        state.step = 'apiSecret';
        await ctx.reply('Step 3/3: Enter your Indodax API Secret:');
        // Delete the message containing API key for security
        try { await ctx.deleteMessage(); } catch {}
        break;

      case 'apiSecret':
        state.apiSecret = text;
        state.step = 'confirm';
        // Delete the message containing API secret for security
        try { await ctx.deleteMessage(); } catch {}

        // Use plain text to avoid markdown parsing issues with user input
        await ctx.reply(
          `⚠️ Confirm Account Setup\n\n` +
          `Account Name: ${state.accountName}\n` +
          `API Key: ${state.apiKey?.substring(0, 8)}...***\n\n` +
          `Your credentials will be encrypted and stored securely.`,
          Markup.inlineKeyboard([
            Markup.button.callback('✅ Confirm', 'confirm_account'),
            Markup.button.callback('❌ Cancel', 'cancel_account')
          ])
        );
        break;
    }
  }

  // Callback handlers
  private async handleConfirmAccount(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const state = this.wizardStates.get(userId);
    if (!state || !state.accountName || !state.apiKey || !state.apiSecret) {
      await ctx.answerCbQuery('Session expired. Please start again with /account_add');
      this.wizardStates.delete(userId);
      return;
    }

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    try {
      const accounts = telegramAccountRepo.getTradingAccounts(user.id!);
      const isFirst = accounts.length === 0;

      telegramAccountRepo.addTradingAccount(
        user.id!,
        state.accountName,
        state.apiKey,
        state.apiSecret,
        isFirst
      );

      this.wizardStates.delete(userId);

      await ctx.editMessageText(
        `✅ Account "${state.accountName}" added successfully!\n\n` +
        `Use /balance to check your account balance.`
      );
    } catch (error) {
      await ctx.answerCbQuery('Failed to add account. Please try again.');
    }
  }

  private async handleCancelAccount(ctx: Context): Promise<void> {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    this.wizardStates.delete(userId);
    await ctx.editMessageText('❌ Account setup cancelled');
  }

  private async handleExecuteCallback(ctx: Context): Promise<void> {
    // Handle scalp signal execution callback
    const match = (ctx.callbackQuery as any)?.data?.match(/^execute_(.+)$/);
    if (!match) return;

    const signalId = match[1];
    await ctx.answerCbQuery('Executing signal...');

    // Get user and account
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const user = telegramAccountRepo.getUserByTelegramId(userId);
    if (!user) return;

    const account = telegramAccountRepo.getDefaultAccount(user.id!);
    if (!account) {
      await ctx.reply('No trading account found. Use /account_add first.');
      return;
    }

    // Signal execution would be handled by scalper integration
    // This is a placeholder for when scalper emits signals
    await ctx.reply('⏳ Signal execution initiated...');
  }

  private async handleSkipCallback(ctx: Context): Promise<void> {
    await ctx.answerCbQuery('Signal skipped');
    await ctx.editMessageReplyMarkup(undefined);
  }

  private async handleClosePositionCallback(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^close_pos_(\d+)$/);
    if (!match) return;

    const positionId = parseInt(match[1]);
    await ctx.answerCbQuery('Closing position...');

    // Check if this is a dry run position
    const position = orderRepo.getPositionById(positionId);
    const isDryRun = position && (position as any).is_dry_run === 1;

    const result = isDryRun
      ? await dryRunExecutor.closePosition(positionId)
      : await tradingExecutor.closePosition(positionId);

    if (result.success) {
      const pos = result.position!;
      const pnlEmoji = (pos.pnl_percent || 0) >= 0 ? '🟢' : '🔴';

      await ctx.editMessageText(
        `✅ ${isDryRun ? '[DRY RUN] ' : ''}Position Closed\n\n` +
        `Symbol: ${pos.symbol}\n` +
        `Exit Price: Rp ${this.formatNumber(pos.exit_price || 0)}\n` +
        `P/L: ${pnlEmoji} ${pos.pnl_percent?.toFixed(2)}%`
      );
    } else {
      await ctx.reply(`❌ Failed to close: ${result.error}`);
    }
  }

  private async handleCancelOrderCallback(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/^cancel_order_(\d+)$/);
    if (!match) return;

    const orderId = parseInt(match[1]);
    await ctx.answerCbQuery('Cancelling order...');

    const result = await tradingExecutor.cancelOrder(orderId);

    if (result.success) {
      await ctx.editMessageText(`✅ Order #${orderId} cancelled`);
    } else {
      await ctx.reply(`❌ Failed to cancel: ${result.error}`);
    }
  }

  // Event handlers
  private async handlePositionAutoClosed(data: any): Promise<void> {
    // Notify all users with positions
    const position = data.closedPosition as Position;
    const account = telegramAccountRepo.getTradingAccountById(position.account_id);
    if (!account) return;

    const user = telegramAccountRepo.getUserById(account.telegram_user_id);
    if (!user) return;

    const pnlEmoji = (position.pnl_percent || 0) >= 0 ? '🟢' : '🔴';
    const reason = data.reason === 'take_profit' ? '🎯 Take Profit Hit!' : '🛑 Stop Loss Hit!';

    try {
      await this.bot.telegram.sendMessage(
        user.telegram_id,
        `${reason}\n\n` +
        `Position #${position.id} Closed\n` +
        `Symbol: ${position.symbol}\n` +
        `Exit: Rp ${this.formatNumber(position.exit_price || 0)}\n` +
        `P/L: ${pnlEmoji} ${position.pnl_percent?.toFixed(2)}%\n` +
        `P/L IDR: Rp ${this.formatNumber(position.pnl_idr || 0)}`
      );
    } catch (error) {
      console.error('Failed to send position close notification:', error);
    }
  }

  private async handlePositionUpdate(update: PositionUpdate): Promise<void> {
    // Could be used for periodic P/L updates
  }

  private async handleOrderExecuted(order: Order): Promise<void> {
    // Could be used for order confirmation notifications
  }

  private async handlePositionOpened(position: Position): Promise<void> {
    const account = telegramAccountRepo.getTradingAccountById(position.account_id);
    if (!account) return;

    const user = telegramAccountRepo.getUserById(account.telegram_user_id);
    if (!user) return;

    try {
      await this.bot.telegram.sendMessage(
        user.telegram_id,
        `📈 Position Opened\n\n` +
        `Symbol: ${position.symbol}\n` +
        `Side: ${position.side.toUpperCase()}\n` +
        `Entry: Rp ${this.formatNumber(position.entry_price)}\n` +
        `Amount: ${position.amount}\n` +
        `TP: ${position.take_profit_price ? 'Rp ' + this.formatNumber(position.take_profit_price) : 'Not set'}\n` +
        `SL: ${position.stop_loss_price ? 'Rp ' + this.formatNumber(position.stop_loss_price) : 'Not set'}`
      );
    } catch (error) {
      console.error('Failed to send position open notification:', error);
    }
  }

  // ============================================
  // Public methods
  // ============================================

  /**
   * Send scalp signal to user
   */
  async sendScalpSignal(userId: string, signal: ScalpSignal): Promise<void> {
    const directionEmoji = signal.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';

    try {
      await this.bot.telegram.sendMessage(
        userId,
        `🎯 Scalp Signal\n\n` +
        `${directionEmoji}\n` +
        `Symbol: ${signal.symbol}\n` +
        `Price: Rp ${this.formatNumber(signal.price)}\n` +
        `TP: Rp ${this.formatNumber(signal.takeProfit)} (${signal.takeProfitPercent.toFixed(2)}%)\n` +
        `SL: Rp ${this.formatNumber(signal.stopLoss)} (${signal.stopLossPercent.toFixed(2)}%)\n` +
        `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n\n` +
        `Reasons:\n${signal.reasons.map(r => `• ${r}`).join('\n')}`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Execute', `execute_${signal.timestamp}`),
          Markup.button.callback('⏭️ Skip', `skip_${signal.timestamp}`)
        ])
      );
    } catch (error) {
      console.error('Failed to send scalp signal:', error);
    }
  }

  /**
   * Send message to all users
   */
  async broadcast(message: string): Promise<void> {
    const users = telegramAccountRepo.getAllUsers(true);

    for (const user of users) {
      try {
        await this.bot.telegram.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error(`Failed to send to ${user.telegram_id}:`, error);
      }
    }
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this._isRunning) return;

    console.log('Starting Telegram bot...');

    // Start position tracker
    await positionTracker.start();

    // Launch bot
    await this.bot.launch();
    this._isRunning = true;

    console.log('Telegram bot started');
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    if (!this._isRunning) return;

    console.log('Stopping Telegram bot...');

    positionTracker.stop();
    this.bot.stop('SIGTERM');
    this._isRunning = false;

    console.log('Telegram bot stopped');
  }

  /**
   * Check if bot is running
   */
  get running(): boolean {
    return this._isRunning;
  }

  /**
   * Check if bot is running (method version)
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Broadcast scalp signal to all authorized users
   */
  async broadcastScalpSignal(signal: ScalpSignal, autoExecute: boolean = false): Promise<void> {
    const users = telegramAccountRepo.getAllUsers(true);
    const directionEmoji = signal.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';

    for (const user of users) {
      try {
        const settings = telegramAccountRepo.getSettings(user.id!);
        const shouldAutoExecute = autoExecute || settings.auto_execute;

        // Check if user has a trading account
        const account = telegramAccountRepo.getDefaultAccount(user.id!);

        let text = `⚡ SCALP SIGNAL\n\n` +
          `${directionEmoji} ${signal.symbol}\n\n` +
          `Entry: Rp ${this.formatNumber(signal.entryPrice)}\n` +
          `TP: Rp ${this.formatNumber(signal.takeProfit)} (+${signal.takeProfitPercent.toFixed(2)}%)\n` +
          `SL: Rp ${this.formatNumber(signal.stopLoss)} (-${signal.stopLossPercent.toFixed(2)}%)\n` +
          `R/R: ${signal.riskReward.toFixed(1)}:1\n` +
          `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n\n` +
          `Reasons:\n${signal.reasons.map(r => `• ${r}`).join('\n')}`;

        if (shouldAutoExecute && account) {
          // Auto-execute the signal
          const isDryRun = this.scalpWorker.config.dryRunMode;
          text += isDryRun ? `\n\n📝 DRY RUN EXECUTING...` : `\n\n⚡ AUTO-EXECUTING...`;

          await this.bot.telegram.sendMessage(user.telegram_id, text);

          // Execute the signal (use dry run executor if dry run mode is enabled)
          const result = isDryRun
            ? await dryRunExecutor.executeScalpSignal(account.id!, signal)
            : await tradingExecutor.executeScalpSignal(account.id!, signal);

          if (result.success) {
            await this.bot.telegram.sendMessage(
              user.telegram_id,
              `✅ ${isDryRun ? '[DRY RUN] ' : ''}Order Executed\n` +
              `Position ID: #${result.position?.id}\n` +
              `Amount: ${result.order?.amount}`
            );
          } else {
            await this.bot.telegram.sendMessage(
              user.telegram_id,
              `❌ Execution Failed\n${result.error}`
            );
          }
        } else {
          // Send with execute/skip buttons
          await this.bot.telegram.sendMessage(
            user.telegram_id,
            text,
            Markup.inlineKeyboard([
              Markup.button.callback('✅ Execute', `execute_${signal.timestamp}`),
              Markup.button.callback('⏭️ Skip', `skip_${signal.timestamp}`)
            ])
          );
        }
      } catch (error) {
        console.error(`Failed to send scalp signal to ${user.telegram_id}:`, error);
      }
    }
  }

  /**
   * Broadcast scalp exit notification to all users
   */
  async broadcastScalpExit(trade: ActiveScalp): Promise<void> {
    const users = telegramAccountRepo.getAllUsers(true);

    let statusEmoji: string;
    let statusText: string;

    if (trade.status === 'tp_hit') {
      statusEmoji = '🎯';
      statusText = 'TAKE PROFIT HIT!';
    } else if (trade.status === 'wall_exit') {
      statusEmoji = '🧱';
      statusText = 'WALL EXIT';
    } else {
      statusEmoji = '🛑';
      statusText = 'STOP LOSS HIT';
    }

    const pnlEmoji = (trade.profitPercent || 0) >= 0 ? '🟢' : '🔴';
    const duration = trade.duration ? (trade.duration / 1000).toFixed(1) : '?';

    const text = `${statusEmoji} ${statusText}\n\n` +
      `${trade.signal.symbol} ${trade.signal.direction.toUpperCase()}\n` +
      `Entry: Rp ${this.formatNumber(trade.signal.entryPrice)}\n` +
      `Exit: Rp ${this.formatNumber(trade.exitPrice || 0)}\n` +
      `P/L: ${pnlEmoji} ${(trade.profitPercent || 0) >= 0 ? '+' : ''}${(trade.profitPercent || 0).toFixed(3)}%\n` +
      `Time: ${duration}s` +
      (trade.exitReason ? `\nReason: ${trade.exitReason}` : '');

    for (const user of users) {
      try {
        await this.bot.telegram.sendMessage(user.telegram_id, text);
      } catch (error) {
        console.error(`Failed to send scalp exit to ${user.telegram_id}:`, error);
      }
    }
  }

  // Helper methods
  private formatNumber(num: number): string {
    return num.toLocaleString('id-ID', { maximumFractionDigits: 8 });
  }

  /**
   * Escape special characters for Telegram Markdown
   */
  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
  }
}

// Lazy singleton - only created when first accessed
let _telegramBot: TelegramBot | null = null;

export function getTelegramBot(): TelegramBot {
  if (!_telegramBot) {
    _telegramBot = new TelegramBot();
  }
  return _telegramBot;
}

// Proxy object that lazily initializes the bot
export const telegramBot = {
  start: async () => getTelegramBot().start(),
  stop: async () => {
    if (_telegramBot) {
      await _telegramBot.stop();
    }
  },
  isRunning: () => _telegramBot?.isRunning() ?? false,
  running: () => _telegramBot?.running ?? false,
  broadcastScalpSignal: async (signal: ScalpSignal, autoExecute: boolean = false) => {
    return getTelegramBot().broadcastScalpSignal(signal, autoExecute);
  },
  broadcastScalpExit: async (trade: ActiveScalp) => {
    return getTelegramBot().broadcastScalpExit(trade);
  },
  broadcast: async (message: string) => {
    return getTelegramBot().broadcast(message);
  },
  sendScalpSignal: async (userId: string, signal: ScalpSignal) => {
    return getTelegramBot().sendScalpSignal(userId, signal);
  },
};

export default telegramBot;
