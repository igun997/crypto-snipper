import chalk from 'chalk';
import ora from 'ora';
import dataFetcher from '../services/data-fetcher.js';
import predictor from '../services/predictor.js';
import accuracyTracker from '../services/accuracy-tracker.js';
import adaptiveLearner from '../services/adaptive-learner.js';
import orderBookAnalyzer, { Wall, OrderBookAnalysis } from '../services/orderbook-analyzer.js';
import sentimentFetcher from '../services/sentiment-fetcher.js';
import realtimeFetcher, { TradeData, RealtimePrice } from '../services/realtime-fetcher.js';
import scalper, { ScalpSignal, ActiveScalp } from '../services/scalper.js';
import chartRenderer from './chart-renderer.js';
import priceRepo from '../database/repositories/prices.js';
import { runMigrations, resetDatabase } from '../database/migrations.js';
import { FormulaType, ScalpOptions } from '../types/index.js';
import {
  FetchOptions,
  PredictOptions,
  EvaluateOptions,
  SummaryOptions,
  WatchOptions,
} from '../types/index.js';
import { telegramBot } from '../services/telegram-bot.js';
import { telegramAccountRepo } from '../database/repositories/telegram-accounts.js';
import { tradingExecutor } from '../services/trading-executor.js';

export interface ChartOptions {
  symbol?: string;
  all?: boolean;
  predict?: boolean;
  limit?: number;
}

export async function fetchCommand(options: FetchOptions): Promise<void> {
  const spinner = ora('Fetching market data...').start();

  try {
    if (options.symbol) {
      const count = await dataFetcher.fetchAndStore(options.symbol, '15m', options.limit || 100);
      spinner.succeed(`Fetched ${count} candles for ${options.symbol}`);
    } else if (options.all) {
      spinner.text = 'Fetching all trading pairs...';
      const results = await dataFetcher.fetchAll('15m', options.limit || 100);
      const total = Array.from(results.values()).reduce((a, b) => a + b, 0);
      spinner.succeed(`Fetched ${total} candles across ${results.size} pairs`);
    } else {
      // Default: fetch top pairs
      const pairs = await dataFetcher.getTradingPairs();
      const topPairs = pairs.slice(0, 10);

      for (const pair of topPairs) {
        spinner.text = `Fetching ${pair.symbol}...`;
        await dataFetcher.fetchAndStore(pair.symbol, '15m', options.limit || 100);
      }
      spinner.succeed(`Fetched data for ${topPairs.length} pairs`);
    }
  } catch (error) {
    spinner.fail(`Failed to fetch data: ${error}`);
  }
}

export async function pairsCommand(): Promise<void> {
  const spinner = ora('Loading trading pairs...').start();

  try {
    const pairs = await dataFetcher.getTradingPairs();
    spinner.stop();

    console.log(chalk.bold('\nAvailable Trading Pairs on Indodax:\n'));
    console.log(chalk.gray('Symbol'.padEnd(15) + 'Base'.padEnd(10) + 'Quote'));
    console.log(chalk.gray('-'.repeat(35)));

    for (const pair of pairs) {
      console.log(`${pair.symbol.padEnd(15)}${pair.base.padEnd(10)}${pair.quote}`);
    }

    console.log(chalk.gray(`\nTotal: ${pairs.length} pairs`));
  } catch (error) {
    spinner.fail(`Failed to load pairs: ${error}`);
  }
}

/**
 * Chart command - display full charts with technical analysis and predictions
 */
export async function chartCommand(options: ChartOptions): Promise<void> {
  const spinner = ora('Loading chart data...').start();

  try {
    // Get symbols to display
    let symbols: string[] = [];

    if (options.symbol) {
      symbols = [options.symbol];
    } else if (options.all) {
      symbols = dataFetcher.getStoredSymbols();
    } else {
      // Show available symbols in DB and prompt
      const stored = dataFetcher.getStoredSymbols();
      spinner.stop();

      if (stored.length === 0) {
        console.log(chalk.yellow('\nNo data in database. Run fetch first:'));
        console.log(chalk.gray('  npx crypto-snipper fetch -s BTC/IDR'));
        console.log(chalk.gray('  npx crypto-snipper fetch --all'));
        return;
      }

      console.log(chalk.bold('\n📊 Available Pairs in Database:\n'));
      console.log(chalk.gray('Symbol'.padEnd(12) + 'Candles'.padEnd(10) + 'Latest Data'));
      console.log(chalk.gray('-'.repeat(50)));

      for (const sym of stored) {
        const prices = priceRepo.getLatestPrices(sym, 1);
        const count = priceRepo.getLatestPrices(sym, 1000).length;
        const latest = prices[0] ? new Date(prices[0].timestamp).toLocaleString() : 'N/A';
        console.log(`${sym.padEnd(12)}${String(count).padEnd(10)}${latest}`);
      }

      console.log(chalk.gray(`\nTotal: ${stored.length} pairs with data`));
      console.log(chalk.cyan('\nUsage:'));
      console.log(chalk.gray('  npx crypto-snipper chart -s BTC/IDR     # Single pair'));
      console.log(chalk.gray('  npx crypto-snipper chart -s BTC/IDR -p  # With prediction'));
      console.log(chalk.gray('  npx crypto-snipper chart --all          # All pairs'));
      return;
    }

    if (symbols.length === 0) {
      spinner.fail('No symbols found in database');
      return;
    }

    spinner.stop();
    const limit = options.limit || 100;
    const showPrediction = options.predict !== false;

    for (const symbol of symbols) {
      const prices = priceRepo.getLatestPrices(symbol, limit);

      if (prices.length < 20) {
        console.log(chalk.yellow(`\n${symbol}: Insufficient data (${prices.length} candles, need 20+)`));
        continue;
      }

      // Render full chart
      console.log('\n');
      const chart = chartRenderer.renderPriceChart(symbol, prices, {
        height: 15,
        width: 60,
        showRSI: true,
        showMACD: true,
        showBollinger: true,
      });
      console.log(chart);

      // Volume chart
      const volumeChart = chartRenderer.renderVolumeChart(prices, 60);
      if (volumeChart) {
        console.log(chalk.cyan('  ') + volumeChart);
      }

      // Order book analysis with walls
      try {
        const orderBook = await orderBookAnalyzer.analyze(symbol);
        displayWalls(orderBook);
      } catch (err) {
        console.log(chalk.gray(`  ${symbol} OrderBook: Unable to fetch`));
      }

      // Run predictions if enabled
      if (showPrediction) {
        console.log(chalk.bold.cyan(`\n  ┌──────────────────────────────────────────────────────────────┐`));
        console.log(chalk.bold.cyan(`  │ 🎯 PREDICTIONS - ${symbol.padEnd(44)}│`));
        console.log(chalk.bold.cyan(`  └──────────────────────────────────────────────────────────────┘`));

        try {
          const results = await predictor.predictAll(symbol, 15);

          for (const result of results) {
            const pred = result.prediction;
            const priceChange = pred.predicted_price - result.currentPrice;
            const priceChangePercent = (priceChange / result.currentPrice) * 100;

            const direction =
              pred.predicted_direction === 'up'
                ? chalk.green.bold('▲ UP  ')
                : pred.predicted_direction === 'down'
                ? chalk.red.bold('▼ DOWN')
                : chalk.yellow.bold('◆ HOLD');

            let formulaLabel: string;
            switch (result.formulaType) {
              case 'arimax': formulaLabel = chalk.blue('ARIMAX    '); break;
              case 'arimax_sentiment': formulaLabel = chalk.magenta('SENTIMENT '); break;
              case 'ensemble': formulaLabel = chalk.cyan('ENSEMBLE  '); break;
              case 'technical': formulaLabel = chalk.yellow('TECHNICAL '); break;
              case 'lstm': formulaLabel = chalk.green('LSTM      '); break;
              default: formulaLabel = String(result.formulaType).padEnd(10);
            }

            const changeColor = priceChange >= 0 ? chalk.green : chalk.red;
            const changeSign = priceChange >= 0 ? '+' : '';

            console.log('');
            console.log(`  ${formulaLabel} ${direction} ${changeColor(`${changeSign}${priceChangePercent.toFixed(2)}%`)}`);
            console.log(chalk.gray(`  ─────────────────────────────────────────────────`));
            console.log(`  Current:    ${chalk.white(formatPrice(result.currentPrice))}`);
            console.log(`  Target:     ${chalk.bold(formatPrice(pred.predicted_price))}`);
            console.log(`  Confidence: ${chalk.cyan(`${(pred.confidence * 100).toFixed(0)}%`)}`);
            console.log(`  Expires:    ${chalk.gray(new Date(pred.target_timestamp).toLocaleString())}`);
          }

          // Best signal summary
          const bestPred = results.reduce((best, curr) =>
            curr.prediction.confidence > best.prediction.confidence ? curr : best
          );

          console.log('');
          console.log(chalk.bold.yellow(`  ════════════════════════════════════════════════════════════`));
          console.log(chalk.bold.yellow(`  📈 RECOMMENDATION: `) +
            (bestPred.prediction.predicted_direction === 'up'
              ? chalk.green.bold(`BUY → Target ${formatPrice(bestPred.prediction.predicted_price)}`)
              : bestPred.prediction.predicted_direction === 'down'
              ? chalk.red.bold(`SELL → Target ${formatPrice(bestPred.prediction.predicted_price)}`)
              : chalk.yellow.bold('HOLD - No clear direction'))
          );
          console.log(chalk.bold.yellow(`  ════════════════════════════════════════════════════════════`));

        } catch (err) {
          console.log(chalk.red(`  Failed to run predictions: ${err}`));
        }
      }

      // Separator between symbols
      if (symbols.length > 1) {
        console.log(chalk.gray('\n  ' + '═'.repeat(64) + '\n'));
      }
    }

  } catch (error) {
    spinner.fail(`Failed to load chart: ${error}`);
  }
}

/**
 * Telegram command - start Telegram bot for trading control
 */
export async function telegramCommand(): Promise<void> {
  console.log(chalk.bold.cyan(`
  ╔══════════════════════════════════════════════════════════════╗
  ║              📱 TELEGRAM TRADING BOT                         ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Control your trading via Telegram commands                  ║
  ╚══════════════════════════════════════════════════════════════╝`));

  const spinner = ora('Starting Telegram bot...').start();

  try {
    await telegramBot.start();
    spinner.succeed('Telegram bot started successfully');

    console.log(chalk.green('\n  Bot is now running!'));
    console.log(chalk.gray('  Open Telegram and message your bot to start trading.\n'));
    console.log(chalk.gray('  Commands available:'));
    console.log(chalk.gray('    /start - Welcome and registration'));
    console.log(chalk.gray('    /account_add - Add Indodax API credentials'));
    console.log(chalk.gray('    /balance - Check account balance'));
    console.log(chalk.gray('    /buy - Place buy order'));
    console.log(chalk.gray('    /sell - Place sell order'));
    console.log(chalk.gray('    /positions - View open positions'));
    console.log(chalk.gray('    /help - Full command list'));
    console.log(chalk.gray('\n  Press Ctrl+C to stop\n'));

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\n  Shutting down Telegram bot...'));
      await telegramBot.stop();
      process.exit(0);
    });

  } catch (error) {
    spinner.fail(`Failed to start Telegram bot: ${error}`);
    process.exit(1);
  }
}

/**
 * Scalp command - real-time scalping mode with quick entry/exit signals
 */
export async function scalpCommand(options: ScalpOptions): Promise<void> {
  const symbols = options.symbols
    ? options.symbols.split(',').map(s => s.trim())
    : ['BTC/IDR'];

  // Configure scalper
  if (options.takeProfit) {
    scalper.updateConfig({ takeProfitPercent: options.takeProfit });
  }
  if (options.stopLoss) {
    scalper.updateConfig({ stopLossPercent: options.stopLoss });
  }
  if (options.confidence) {
    scalper.updateConfig({ minConfidence: options.confidence / 100 });
  }

  const config = scalper.getConfig();
  const useTelegram = options.telegram || false;
  const autoExecute = options.auto || false;

  console.log(chalk.bold.magenta(`
  ╔══════════════════════════════════════════════════════════════╗
  ║              ⚡ SCALPING MODE ⚡                              ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Quick entry/exit signals for small, fast profits            ║
  ╚══════════════════════════════════════════════════════════════╝`));
  console.log(chalk.gray(`
  Symbols:      ${symbols.join(', ')}
  Take Profit:  ${config.takeProfitPercent}%
  Stop Loss:    ${config.stopLossPercent}%
  Risk/Reward:  ${(config.takeProfitPercent / config.stopLossPercent).toFixed(1)}:1
  Min Conf:     ${(config.minConfidence * 100).toFixed(0)}%
  Cooldown:     ${config.cooldownMs / 1000}s
  Telegram:     ${useTelegram ? chalk.green('Enabled') : chalk.gray('Disabled')}
  Auto-Execute: ${autoExecute ? chalk.yellow('Enabled (LIVE TRADING!)') : chalk.gray('Disabled')}

  Press Ctrl+C to stop
  `));

  // Start Telegram bot if enabled
  if (useTelegram) {
    try {
      console.log(chalk.cyan('  Starting Telegram bot for notifications...'));
      await telegramBot.start();
      console.log(chalk.green('  ✓ Telegram bot connected\n'));

      // Set auto-execute mode
      if (autoExecute) {
        console.log(chalk.yellow('  ⚠️  AUTO-EXECUTE MODE: Signals will be executed automatically!\n'));
      }
    } catch (error) {
      console.log(chalk.red(`  ✗ Failed to start Telegram bot: ${error}`));
      console.log(chalk.gray('  Continuing without Telegram notifications...\n'));
    }
  }

  const spinner = ora('Connecting to real-time feed...').start();

  try {
    // Connect to WebSocket
    await realtimeFetcher.connect();
    spinner.succeed('Connected to Indodax WebSocket');

    // Subscribe to symbols
    for (const symbol of symbols) {
      await realtimeFetcher.subscribe(symbol);
    }

    // Prefetch some data for technical analysis
    console.log(chalk.gray('\n  Prefetching data for analysis...'));
    for (const symbol of symbols) {
      const result = await dataFetcher.smartFetch(symbol, '15m', 50);
      console.log(chalk.gray(`  ${symbol}: ${result.total} candles ready`));
    }

    console.log(chalk.green('\n  ✓ Ready! Waiting for trades...\n'));
    console.log(chalk.gray('  Scanning for scalp opportunities...\n'));

    // Show initial price for each symbol
    for (const symbol of symbols) {
      const cached = realtimeFetcher.getPrice(symbol);
      if (cached) {
        console.log(chalk.gray(`  ${symbol}: ${formatPrice(cached.price)}`));
      } else {
        console.log(chalk.yellow(`  ${symbol}: Waiting for first trade...`));
      }
    }
    console.log('');

    // Listen for scalp signals
    scalper.on('signal', async (signal: ScalpSignal) => {
      displayScalpSignal(signal);

      // Send to Telegram if enabled
      if (useTelegram && telegramBot.isRunning()) {
        await telegramBot.broadcastScalpSignal(signal, autoExecute);
      }
    });

    scalper.on('exit', async (trade: ActiveScalp) => {
      displayScalpExit(trade);

      // Send exit notification to Telegram if enabled
      if (useTelegram && telegramBot.isRunning()) {
        await telegramBot.broadcastScalpExit(trade);
      }
    });

    // Track last analysis time
    const lastAnalysis: Map<string, number> = new Map();
    const analysisInterval = 2000; // Analyze every 2 seconds

    // Listen for price updates
    realtimeFetcher.on('price', async (price: RealtimePrice) => {
      const symbol = price.symbol;
      const now = Date.now();

      // Check active scalps for exit
      scalper.checkScalpExit(symbol, price.price);

      // Display active position if any
      const activeScalps = scalper.getActiveScalps();
      const activeScalp = activeScalps.get(symbol);

      if (activeScalp && activeScalp.status === 'active') {
        displayActiveScalp(activeScalp, price.price);
      } else {
        // Display price with scanning status
        displayScalpPrice(price);
      }

      // Run analysis periodically
      const lastTime = lastAnalysis.get(symbol) || 0;
      if (now - lastTime >= analysisInterval) {
        lastAnalysis.set(symbol, now);
        await scalper.analyze(symbol, price.price);
      }
    });

    // Display stats and heartbeat periodically
    let lastStatsTime = Date.now();
    let lastActivityTime = Date.now();
    let heartbeatCount = 0;

    setInterval(async () => {
      const now = Date.now();

      // Heartbeat every 10s if no activity
      if (now - lastActivityTime >= 10000) {
        heartbeatCount++;
        const elapsed = Math.floor((now - lastActivityTime) / 1000);

        // Try to get latest price via API if WebSocket is quiet
        for (const symbol of symbols) {
          const cached = realtimeFetcher.getPrice(symbol);
          if (!cached && heartbeatCount % 3 === 0) {
            // Fetch ticker if no WebSocket data
            try {
              const ticker = await dataFetcher.getTicker(symbol);
              process.stdout.write(
                `\r  ${chalk.bold(symbol.padEnd(10))} ` +
                chalk.gray('API  ') +
                `${chalk.white(formatPrice(ticker.last))} ` +
                chalk.gray(`(no WSS trades for ${elapsed}s)`) +
                '     '
              );

              // Run analysis with API price
              await scalper.analyze(symbol, ticker.last);
            } catch {
              // Ignore
            }
          } else if (cached) {
            process.stdout.write(
              `\r  ${chalk.bold(symbol.padEnd(10))} ` +
              chalk.gray('SCAN ') +
              `${chalk.white(formatPrice(cached.price))} ` +
              chalk.gray(`waiting... (${elapsed}s)`) +
              '     '
            );
          } else {
            process.stdout.write(
              `\r  ${chalk.bold(symbol.padEnd(10))} ` +
              chalk.yellow('Waiting for first trade...') +
              chalk.gray(` (${elapsed}s)`) +
              '     '
            );
          }
        }
      }

      // Stats every minute
      if (now - lastStatsTime >= 60000) {
        lastStatsTime = now;
        displayScalpStats();
      }
    }, 5000);

    // Track activity
    realtimeFetcher.on('trade', () => {
      lastActivityTime = Date.now();
    });

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\n  Shutting down scalper...'));
      displayScalpStats();
      realtimeFetcher.disconnect();

      // Stop Telegram bot if running
      if (useTelegram && telegramBot.isRunning()) {
        console.log(chalk.gray('  Stopping Telegram bot...'));
        await telegramBot.stop();
      }

      process.exit(0);
    });

  } catch (error) {
    spinner.fail(`Failed to start scalper: ${error}`);
  }
}

/**
 * Display scalp signal
 */
function displayScalpSignal(signal: ScalpSignal): void {
  const dirColor = signal.direction === 'long' ? chalk.green : chalk.red;
  const dirIcon = signal.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';

  console.log('\n');
  console.log(chalk.bold.yellow(`  ════════════════════════════════════════════════════════════`));
  console.log(chalk.bold.yellow(`  ⚡ SCALP SIGNAL - ${signal.symbol}`));
  console.log(chalk.bold.yellow(`  ════════════════════════════════════════════════════════════`));
  console.log('');
  console.log(`  ${dirColor.bold(dirIcon)} @ ${chalk.white(formatPrice(signal.entryPrice))}`);
  console.log('');
  console.log(chalk.gray(`  ┌─────────────────────────────────────────────────┐`));
  console.log(chalk.green(`  │ Take Profit: ${formatPrice(signal.takeProfit).padEnd(15)} (+${signal.takeProfitPercent.toFixed(2)}%)    │`));
  console.log(chalk.red(`  │ Stop Loss:   ${formatPrice(signal.stopLoss).padEnd(15)} (-${signal.stopLossPercent.toFixed(2)}%)    │`));
  console.log(chalk.cyan(`  │ Risk/Reward: ${signal.riskReward.toFixed(1)}:1                            │`));
  console.log(chalk.gray(`  └─────────────────────────────────────────────────┘`));
  console.log('');
  console.log(chalk.gray(`  Confidence: ${(signal.confidence * 100).toFixed(0)}%`));
  console.log(chalk.gray(`  Reasons:`));
  for (const reason of signal.reasons) {
    console.log(chalk.gray(`    • ${reason}`));
  }

  if (signal.nearestSupport || signal.nearestResistance) {
    console.log('');
    if (signal.nearestSupport) {
      console.log(chalk.green(`  Support:    ${formatPrice(signal.nearestSupport)}`));
    }
    if (signal.nearestResistance) {
      console.log(chalk.red(`  Resistance: ${formatPrice(signal.nearestResistance)}`));
    }
  }

  console.log(chalk.bold.yellow(`  ════════════════════════════════════════════════════════════\n`));

  // Sound alert
  process.stdout.write('\x07\x07');
}

/**
 * Display scalp exit
 */
function displayScalpExit(trade: ActiveScalp): void {
  const isWin = trade.status === 'tp_hit' || (trade.status === 'wall_exit' && (trade.profitPercent || 0) > 0);
  const isWallExit = trade.status === 'wall_exit';

  let statusColor;
  let statusText;

  if (trade.status === 'tp_hit') {
    statusColor = chalk.bgGreen.black;
    statusText = ' 🎯 TP HIT ';
  } else if (trade.status === 'wall_exit') {
    statusColor = chalk.bgYellow.black;
    statusText = ' 🧱 WALL EXIT ';
  } else {
    statusColor = chalk.bgRed.white;
    statusText = ' ✗ SL HIT ';
  }

  const profitColor = (trade.profitPercent || 0) >= 0 ? chalk.green : chalk.red;
  const duration = trade.duration ? (trade.duration / 1000).toFixed(1) : '?';

  console.log('\n');
  console.log(statusColor.bold(statusText));
  console.log(`  ${trade.signal.symbol} ${trade.signal.direction.toUpperCase()}`);
  console.log(`  Entry:  ${formatPrice(trade.signal.entryPrice)}`);
  console.log(`  Exit:   ${formatPrice(trade.exitPrice || 0)}`);
  console.log(`  P/L:    ${profitColor(`${(trade.profitPercent || 0) >= 0 ? '+' : ''}${(trade.profitPercent || 0).toFixed(3)}%`)}`);
  console.log(`  Time:   ${duration}s`);

  // Show wall exit reason
  if (isWallExit && trade.exitReason) {
    console.log(chalk.yellow(`  Reason: ${trade.exitReason}`));
    console.log(chalk.gray(`  (Auto-exited with profit due to blocking wall)`));
  }
  console.log('');

  // Sound alert (double for TP, single for others)
  if (trade.status === 'tp_hit') {
    process.stdout.write('\x07\x07');
  } else {
    process.stdout.write('\x07');
  }
}

/**
 * Display active scalp position
 */
function displayActiveScalp(scalp: ActiveScalp, currentPrice: number): void {
  const signal = scalp.signal;
  const isLong = signal.direction === 'long';

  // Calculate current P/L
  const pnl = isLong
    ? ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
    : ((signal.entryPrice - currentPrice) / signal.entryPrice) * 100;

  const pnlColor = pnl >= 0 ? chalk.green : chalk.red;

  // Progress to TP/SL
  const tpDistance = isLong
    ? ((signal.takeProfit - currentPrice) / (signal.takeProfit - signal.entryPrice)) * 100
    : ((currentPrice - signal.takeProfit) / (signal.entryPrice - signal.takeProfit)) * 100;

  const slDistance = isLong
    ? ((currentPrice - signal.stopLoss) / (signal.entryPrice - signal.stopLoss)) * 100
    : ((signal.stopLoss - currentPrice) / (signal.stopLoss - signal.entryPrice)) * 100;

  const progressToTP = Math.max(0, Math.min(100, 100 - tpDistance));

  // Time elapsed
  const elapsed = ((Date.now() - scalp.entryTime) / 1000).toFixed(0);

  process.stdout.write(
    `\r  ${chalk.bold(signal.symbol.padEnd(10))} ` +
    `${isLong ? chalk.green('LONG') : chalk.red('SHORT')} ` +
    `${chalk.white(formatPrice(currentPrice))} ` +
    pnlColor(`${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}%`.padEnd(10)) +
    chalk.gray(`TP: ${progressToTP.toFixed(0)}%`) +
    chalk.gray(` | ${elapsed}s`) +
    '     '
  );
}

/**
 * Display price in scalp mode (scanning)
 */
function displayScalpPrice(price: RealtimePrice): void {
  const changeColor = price.change >= 0 ? chalk.green : chalk.red;
  const arrow = price.change >= 0 ? '▲' : '▼';

  process.stdout.write(
    `\r  ${chalk.bold(price.symbol.padEnd(10))} ` +
    chalk.gray('SCAN ') +
    `${chalk.white(formatPrice(price.price))} ` +
    changeColor(`${arrow} ${price.changePercent >= 0 ? '+' : ''}${price.changePercent.toFixed(3)}%`.padEnd(12)) +
    '     '
  );
}

/**
 * Display scalp statistics
 */
function displayScalpStats(): void {
  const stats = scalper.getStats();

  if (stats.totalTrades === 0) {
    return;
  }

  const winRateColor = stats.winRate >= 50 ? chalk.green : chalk.red;
  const profitColor = stats.totalProfit >= 0 ? chalk.green : chalk.red;

  console.log('\n');
  console.log(chalk.bold.cyan(`  ┌──────────────────────────────────────────────────────────────┐`));
  console.log(chalk.bold.cyan(`  │ 📊 SCALP SESSION STATS                                       │`));
  console.log(chalk.bold.cyan(`  └──────────────────────────────────────────────────────────────┘`));

  // Show wins breakdown if there are wall exits
  if (stats.wallExits > 0) {
    const tpWins = stats.wins - stats.wallExits;
    console.log(`  Trades:     ${stats.totalTrades} (${chalk.green(`${tpWins}TP`)} + ${chalk.yellow(`${stats.wallExits}🧱`)} / ${chalk.red(`${stats.losses}L`)})`);
  } else {
    console.log(`  Trades:     ${stats.totalTrades} (${chalk.green(`${stats.wins}W`)} / ${chalk.red(`${stats.losses}L`)})`);
  }

  console.log(`  Win Rate:   ${winRateColor(`${stats.winRate.toFixed(1)}%`)}`);
  console.log(`  Total P/L:  ${profitColor(`${stats.totalProfit >= 0 ? '+' : ''}${stats.totalProfit.toFixed(3)}%`)}`);
  console.log(`  Avg P/L:    ${profitColor(`${stats.avgProfit >= 0 ? '+' : ''}${stats.avgProfit.toFixed(3)}%`)}`);
  console.log(`  Avg Time:   ${(stats.avgDuration / 1000).toFixed(1)}s`);
  console.log('');
}

export async function predictCommand(options: PredictOptions): Promise<void> {
  const spinner = ora('Running prediction...').start();

  try {
    const symbol = options.symbol || 'BTC/IDR';
    const interval = options.interval || 15;

    spinner.text = `Running prediction for ${symbol}...`;

    let results;
    if (options.formula === 'arimax') {
      results = [await predictor.predict(symbol, 'arimax', interval)];
    } else if (options.formula === 'sentiment') {
      results = [await predictor.predict(symbol, 'arimax_sentiment', interval)];
    } else if (options.formula === 'ensemble') {
      results = [await predictor.predictEnsemble(symbol, interval)];
    } else {
      // 'all' - run all models
      results = await predictor.predictAll(symbol, interval);
    }

    spinner.stop();

    console.log(chalk.bold(`\nPrediction Results for ${symbol}:\n`));

    for (const result of results) {
      const direction =
        result.prediction.predicted_direction === 'up'
          ? chalk.green('UP')
          : result.prediction.predicted_direction === 'down'
          ? chalk.red('DOWN')
          : chalk.yellow('NEUTRAL');

      let formulaLabel: string;
      switch (result.formulaType) {
        case 'arimax':
          formulaLabel = chalk.blue('ARIMAX (Enhanced)');
          break;
        case 'arimax_sentiment':
          formulaLabel = chalk.magenta('ARIMAX+Sentiment');
          break;
        case 'ensemble':
          formulaLabel = chalk.cyan('ENSEMBLE (ARIMAX+LSTM+Technical)');
          break;
        default:
          formulaLabel = chalk.white(result.formulaType);
      }

      console.log(`${formulaLabel}`);
      console.log(chalk.gray('-'.repeat(40)));
      console.log(`Current Price:   ${formatPrice(result.currentPrice)}`);
      console.log(`Predicted Price: ${formatPrice(result.prediction.predicted_price)}`);
      console.log(`Direction:       ${direction}`);
      console.log(`Confidence:      ${(result.prediction.confidence * 100).toFixed(1)}%`);
      console.log(`Target Time:     ${new Date(result.prediction.target_timestamp).toLocaleString()}`);
      console.log(`Prediction ID:   ${result.prediction.id}`);

      // Show ensemble component details
      if (result.ensembleDetails) {
        console.log(chalk.gray('\nComponent Predictions:'));
        const ed = result.ensembleDetails;
        console.log(chalk.gray(`  ARIMAX:      ${formatPrice(ed.components.arimax.price)} (${ed.components.arimax.direction})`));
        console.log(chalk.gray(`  LSTM:        ${formatPrice(ed.components.lstm.price)} (${ed.components.lstm.direction})`));
        console.log(chalk.gray(`  Technical:   ${formatPrice(ed.components.technical.price)} (${ed.components.technical.direction})`));
        if (ed.components.arimaxSentiment) {
          console.log(chalk.gray(`  Sentiment:   ${formatPrice(ed.components.arimaxSentiment.price)} (${ed.components.arimaxSentiment.direction})`));
        }
        console.log(chalk.gray(`\nVotes: UP=${ed.votes.up.toFixed(2)} DOWN=${ed.votes.down.toFixed(2)} NEUTRAL=${ed.votes.neutral.toFixed(2)}`));
      }
      console.log('');
    }
  } catch (error) {
    spinner.fail(`Prediction failed: ${error}`);
  }
}

export async function evaluateCommand(options: EvaluateOptions): Promise<void> {
  const spinner = ora('Evaluating predictions...').start();

  try {
    // First, fetch latest prices to have data for evaluation
    if (options.symbol) {
      await dataFetcher.fetchAndStore(options.symbol, '15m', 50);
    }

    const results = await accuracyTracker.evaluatePending();
    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow('\nNo pending predictions to evaluate.'));
      console.log(chalk.gray('Predictions can be evaluated once their target time has passed.'));
      return;
    }

    console.log(chalk.bold(`\nEvaluated ${results.length} Predictions:\n`));

    for (const result of results) {
      const symbol = result.prediction.symbol;
      const formula =
        result.prediction.formula_type === 'arimax'
          ? chalk.blue('ARIMAX')
          : chalk.magenta('ARIMAX+Sentiment');

      const directionMatch = result.isDirectionCorrect ? chalk.green('CORRECT') : chalk.red('WRONG');

      console.log(`${symbol} - ${formula}`);
      console.log(chalk.gray('-'.repeat(40)));
      console.log(`Predicted:  ${formatPrice(result.prediction.predicted_price)} (${result.prediction.predicted_direction})`);
      console.log(`Actual:     ${formatPrice(result.actualPrice)} (${result.actualDirection})`);
      console.log(`MAPE:       ${result.mape.toFixed(2)}% (${result.interpretation})`);
      console.log(`Direction:  ${directionMatch}`);
      console.log('');
    }
  } catch (error) {
    spinner.fail(`Evaluation failed: ${error}`);
  }
}

export async function summaryCommand(options: SummaryOptions): Promise<void> {
  const spinner = ora('Loading summary...').start();

  try {
    let formulaType: FormulaType | undefined;
    if (options.formula === 'arimax') {
      formulaType = 'arimax';
    } else if (options.formula === 'sentiment') {
      formulaType = 'arimax_sentiment';
    }

    const summaries = accuracyTracker.getSummary(options.symbol, formulaType);
    const comparison = accuracyTracker.getFormulaComparison();

    // Apply learned weights
    adaptiveLearner.applyLearnedWeights();

    spinner.stop();

    // Show adaptive learning summary
    console.log(adaptiveLearner.getSummary());

    if (summaries.length === 0 && comparison.length === 0) {
      console.log(chalk.yellow('\nNo accuracy data available yet.'));
      console.log(chalk.gray('Run predictions and wait for evaluation to see accuracy stats.'));
      return;
    }

    console.log(chalk.bold('\nFormula Comparison:\n'));
    console.log(
      chalk.gray(
        'Formula'.padEnd(20) +
          'Total'.padEnd(10) +
          'Correct'.padEnd(10) +
          'Accuracy'.padEnd(12) +
          'Avg MAPE'
      )
    );
    console.log(chalk.gray('-'.repeat(60)));

    for (const c of comparison) {
      const formula = c.formulaType === 'arimax' ? 'ARIMAX' : 'ARIMAX+Sentiment';
      console.log(
        `${formula.padEnd(20)}${String(c.total).padEnd(10)}${String(c.correct).padEnd(10)}${c.accuracy.toFixed(1).padEnd(12)}%${c.avgMape.toFixed(2)}%`
      );
    }

    if (summaries.length > 0) {
      console.log(chalk.bold('\n\nPer-Symbol Summary:\n'));
      console.log(
        chalk.gray(
          'Symbol'.padEnd(12) +
            'Formula'.padEnd(18) +
            'Predictions'.padEnd(14) +
            'Correct'.padEnd(10) +
            'MAPE'
        )
      );
      console.log(chalk.gray('-'.repeat(60)));

      for (const s of summaries) {
        const formula = s.formula_type === 'arimax' ? 'ARIMAX' : 'ARIMAX+Sent';
        const accuracy = s.total_predictions > 0
          ? ((s.correct_directions / s.total_predictions) * 100).toFixed(1)
          : '0.0';
        console.log(
          `${s.symbol.padEnd(12)}${formula.padEnd(18)}${String(s.total_predictions).padEnd(14)}${accuracy.padEnd(10)}%${s.avg_mape.toFixed(2)}%`
        );
      }
    }
  } catch (error) {
    spinner.fail(`Failed to load summary: ${error}`);
  }
}

// Active prediction tracking for live HIT detection
interface ActivePrediction {
  id: number;
  symbol: string;
  formula: string;
  startPrice: number;
  targetPrice: number;
  direction: 'up' | 'down' | 'neutral';
  targetTimestamp: number;
  timestamp: number;
  alerted: boolean;
}

const activePredictions: Map<string, ActivePrediction[]> = new Map();

/**
 * Real-time watch mode using WebSocket
 */
async function watchRealtime(
  symbols: string[],
  formula: string,
  predictionInterval: number,
  showCharts: boolean
): Promise<void> {
  const spinner = ora('Connecting to Indodax WebSocket...').start();

  try {
    // Connect to WebSocket
    await realtimeFetcher.connect();
    spinner.succeed('Connected to Indodax WebSocket');

    // Subscribe to all symbols
    for (const symbol of symbols) {
      await realtimeFetcher.subscribe(symbol);
      activePredictions.set(symbol, []);
    }

    // Track last prediction time per symbol
    const lastPrediction: Map<string, number> = new Map();
    const predictionIntervalMs = predictionInterval * 60 * 1000;

    // Listen for real-time price updates
    realtimeFetcher.on('price', (price: RealtimePrice) => {
      const now = Date.now();
      const symbol = price.symbol;

      // Check for HIT predictions
      checkPredictionHits(symbol, price.price, now);

      // Display real-time price update with active targets
      displayRealtimePriceWithTargets(price);

      // Check if it's time to run prediction
      const lastPred = lastPrediction.get(symbol) || 0;
      if (now - lastPred >= predictionIntervalMs) {
        lastPrediction.set(symbol, now);
        runRealtimePredictionWithTargets(symbol, formula, predictionInterval, showCharts);
      }
    });

    // Listen for trade activity (less verbose)
    let lastTradeTime = 0;
    realtimeFetcher.on('trade', (trade: TradeData) => {
      const now = Date.now();
      // Only show trades every 5 seconds to reduce noise
      if (now - lastTradeTime > 5000) {
        lastTradeTime = now;
        displayTrade(trade);
      }
    });

    // Handle disconnection
    realtimeFetcher.on('disconnected', () => {
      console.log(chalk.yellow('\n  [WSS] Connection lost, attempting to reconnect...'));
    });

    // Historical data already prefetched, run initial predictions
    console.log(chalk.gray('  Running initial predictions...\n'));
    for (const symbol of symbols) {
      lastPrediction.set(symbol, Date.now());
      await runRealtimePredictionWithTargets(symbol, formula, predictionInterval, showCharts);
    }

    // Keep the process running
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\nDisconnecting from WebSocket...'));
      realtimeFetcher.disconnect();
      process.exit(0);
    });

  } catch (error) {
    spinner.fail(`Failed to connect: ${error}`);
    throw error;
  }
}

/**
 * Check if any predictions have been HIT
 */
function checkPredictionHits(symbol: string, currentPrice: number, now: number): void {
  const predictions = activePredictions.get(symbol) || [];

  for (const pred of predictions) {
    if (pred.alerted) continue;

    // Check if target price reached
    const targetReached = pred.direction === 'up'
      ? currentPrice >= pred.targetPrice
      : pred.direction === 'down'
      ? currentPrice <= pred.targetPrice
      : false;

    // Check if direction is correct (for time-based evaluation)
    const timeExpired = now >= pred.targetTimestamp;
    const directionCorrect = pred.direction === 'up'
      ? currentPrice > pred.startPrice
      : pred.direction === 'down'
      ? currentPrice < pred.startPrice
      : true;

    if (targetReached && !pred.alerted) {
      // TARGET HIT!
      pred.alerted = true;
      const profit = ((currentPrice - pred.startPrice) / pred.startPrice * 100).toFixed(2);

      console.log('\n');
      console.log(chalk.bgGreen.black.bold(`  🎯🎯🎯 TARGET HIT! 🎯🎯🎯  `));
      console.log(chalk.green.bold(`  ${symbol} reached target ${formatPrice(pred.targetPrice)}!`));
      console.log(chalk.green(`  Entry: ${formatPrice(pred.startPrice)} → Current: ${formatPrice(currentPrice)}`));
      console.log(chalk.green(`  Profit: ${profit}% | Formula: ${pred.formula}`));
      console.log(chalk.bgGreen.black.bold(`  ════════════════════════════════════════  `));
      console.log('\n');

      // Play alert sound (bell)
      process.stdout.write('\x07');

    } else if (timeExpired && !pred.alerted) {
      // Time expired - evaluate
      pred.alerted = true;

      if (directionCorrect) {
        const profit = ((currentPrice - pred.startPrice) / pred.startPrice * 100).toFixed(2);
        console.log('\n');
        console.log(chalk.bgCyan.black.bold(`  ✓ DIRECTION CORRECT  `));
        console.log(chalk.cyan(`  ${symbol} moved ${pred.direction.toUpperCase()} as predicted`));
        console.log(chalk.cyan(`  ${formatPrice(pred.startPrice)} → ${formatPrice(currentPrice)} (${profit}%)`));
        console.log('\n');
      } else {
        console.log('\n');
        console.log(chalk.bgRed.white.bold(`  ✗ PREDICTION MISSED  `));
        console.log(chalk.red(`  ${symbol} did NOT move ${pred.direction.toUpperCase()}`));
        console.log(chalk.red(`  ${formatPrice(pred.startPrice)} → ${formatPrice(currentPrice)}`));
        console.log('\n');
      }
    }
  }

  // Clean up expired predictions
  const activeList = predictions.filter(p => !p.alerted || Date.now() - p.targetTimestamp < 60000);
  activePredictions.set(symbol, activeList);
}

/**
 * Display real-time price with active prediction targets
 */
function displayRealtimePriceWithTargets(price: RealtimePrice): void {
  const predictions = activePredictions.get(price.symbol) || [];
  const activePred = predictions.find(p => !p.alerted);

  const changeColor = price.change >= 0 ? chalk.green : chalk.red;
  const arrow = price.change >= 0 ? '▲' : '▼';
  const changeStr = `${price.change >= 0 ? '+' : ''}${price.changePercent.toFixed(3)}%`;

  let targetInfo = '';
  if (activePred) {
    const progress = activePred.direction === 'up'
      ? Math.min(100, ((price.price - activePred.startPrice) / (activePred.targetPrice - activePred.startPrice)) * 100)
      : activePred.direction === 'down'
      ? Math.min(100, ((activePred.startPrice - price.price) / (activePred.startPrice - activePred.targetPrice)) * 100)
      : 0;

    const progressBar = renderProgressBar(Math.max(0, progress), 10);
    const timeLeft = Math.max(0, Math.round((activePred.targetTimestamp - Date.now()) / 60000));

    targetInfo = chalk.gray(` | Target: ${formatPrice(activePred.targetPrice)} `) +
      (activePred.direction === 'up' ? chalk.green(progressBar) : chalk.red(progressBar)) +
      chalk.gray(` ${timeLeft}m left`);
  }

  process.stdout.write(
    `\r  ${chalk.bold(price.symbol.padEnd(10))} ` +
    `${chalk.white(formatPrice(price.price))} ` +
    `${changeColor(`${arrow} ${changeStr}`.padEnd(12))} ` +
    targetInfo +
    '     '
  );
}

/**
 * Render a progress bar
 */
function renderProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${percent.toFixed(0)}%`;
}

/**
 * Display real-time price update
 */
function displayRealtimePrice(price: RealtimePrice): void {
  const changeColor = price.change >= 0 ? chalk.green : chalk.red;
  const arrow = price.change >= 0 ? '▲' : '▼';
  const changeStr = `${price.change >= 0 ? '+' : ''}${price.changePercent.toFixed(4)}%`;

  // Compact real-time display
  process.stdout.write(
    `\r  ${chalk.bold(price.symbol.padEnd(10))} ` +
    `${chalk.white(formatPrice(price.price))} ` +
    `${changeColor(`${arrow} ${changeStr}`.padEnd(12))} ` +
    chalk.gray(`Vol: ${formatPrice(price.volume24h)}`) +
    '     '
  );
}

/**
 * Display individual trade
 */
function displayTrade(trade: TradeData): void {
  const sideColor = trade.side === 'buy' ? chalk.green : chalk.red;
  const sideIcon = trade.side === 'buy' ? '⬆' : '⬇';
  const time = new Date(trade.timestamp).toLocaleTimeString();

  console.log(
    chalk.gray(`\n  [${time}] `) +
    sideColor(`${sideIcon} ${trade.side.toUpperCase().padEnd(4)}`) +
    chalk.white(` ${formatPrice(trade.price)}`) +
    chalk.gray(` | Vol: ${trade.volumeCrypto.toFixed(6)} ${trade.symbol.split('/')[0]}`)
  );
}

/**
 * Run prediction for a symbol in real-time mode with target tracking
 */
async function runRealtimePredictionWithTargets(
  symbol: string,
  formula: string,
  intervalMinutes: number,
  showCharts: boolean
): Promise<void> {
  const timestamp = new Date().toLocaleTimeString();
  console.log(chalk.cyan(`\n\n  ════════════════════════════════════════════════════`));
  console.log(chalk.cyan(`  📊 PREDICTION CYCLE [${timestamp}] - ${symbol}`));
  console.log(chalk.cyan(`  ════════════════════════════════════════════════════\n`));

  try {
    // Show chart if enabled
    if (showCharts) {
      const prices = priceRepo.getLatestPrices(symbol, 100);
      if (prices.length >= 20) {
        const chart = chartRenderer.renderPriceChart(symbol, prices, {
          height: 10,
          width: 50,
          showRSI: true,
          showMACD: true,
          showBollinger: true,
        });
        console.log(chart);

        const volumeChart = chartRenderer.renderVolumeChart(prices, 50);
        if (volumeChart) {
          console.log(chalk.cyan('  ') + volumeChart);
        }
      }
    }

    // Get real-time order book and analyze walls (compact display for realtime)
    try {
      const orderBook = await orderBookAnalyzer.analyze(symbol);
      const obSignal = orderBook.signal === 'up' ? chalk.green('↑') : orderBook.signal === 'down' ? chalk.red('↓') : chalk.yellow('→');
      console.log(chalk.gray(`\n  ${symbol} OrderBook: Imbalance ${(orderBook.imbalance * 100).toFixed(1)}% ${obSignal} | Ratio ${orderBook.bidAskRatio.toFixed(2)}`));

      // Compact wall display for realtime mode (single line, key levels only)
      displayWallsCompact(orderBook);
    } catch (err) {
      // Fallback to realtime orderbook if API fails
      const realtimePrice = realtimeFetcher.getPrice(symbol);
      if (realtimePrice?.orderBook) {
        const ob = realtimePrice.orderBook;
        const totalBids = ob.bids.reduce((sum, b) => sum + b.volumeIdr, 0);
        const totalAsks = ob.asks.reduce((sum, a) => sum + a.volumeIdr, 0);
        const ratio = totalBids / (totalAsks || 1);
        const imbalance = (totalBids - totalAsks) / (totalBids + totalAsks || 1);
        const signal = imbalance > 0.1 ? chalk.green('↑') : imbalance < -0.1 ? chalk.red('↓') : chalk.yellow('→');

        console.log(chalk.gray(`\n  ${symbol} OrderBook (Live): Imbalance ${(imbalance * 100).toFixed(1)}% ${signal} | Ratio ${ratio.toFixed(2)}`));
      }
    }

    // Evaluate pending predictions
    const evaluated = await accuracyTracker.evaluatePending();
    if (evaluated.length > 0) {
      console.log(chalk.bold.yellow(`\n  ┌──────────────────────────────────────────────────────────────┐`));
      console.log(chalk.bold.yellow(`  │ 📈 EVALUATION RESULTS (${evaluated.length} predictions)                        │`));
      console.log(chalk.bold.yellow(`  └──────────────────────────────────────────────────────────────┘`));

      let hits = 0;
      let directionalPreds = 0;

      for (const result of evaluated) {
        const pred = result.prediction;
        const formulaShort = pred.formula_type === 'arimax' ? 'AR' :
          pred.formula_type === 'arimax_sentiment' ? 'AR+S' :
          pred.formula_type === 'technical' ? 'TECH' :
          pred.formula_type === 'ensemble' ? 'ENS' : pred.formula_type;

        // Skip neutral predictions in accuracy count
        if (pred.predicted_direction === 'neutral') {
          console.log(chalk.gray(`  ◆ ${pred.symbol} [${formulaShort}] NEUTRAL - No directional prediction`));
          continue;
        }

        directionalPreds++;
        const actualChangePercent = ((result.actualPrice - result.startPrice) / result.startPrice * 100).toFixed(2);
        const predictedChangePercent = ((result.predictedPrice - result.startPrice) / result.startPrice * 100).toFixed(2);
        const actualArrow = result.actualDirection === 'up' ? '▲' : result.actualDirection === 'down' ? '▼' : '◆';

        if (result.isDirectionCorrect) {
          hits++;
          console.log(chalk.bgGreen.black.bold(` 🎯 HIT `));
          console.log(chalk.green(`     ${pred.symbol} [${formulaShort}]`));
          console.log(chalk.green(`     Predicted: ${pred.predicted_direction.toUpperCase()} to ${formatPrice(result.predictedPrice)} (${predictedChangePercent}%)`));
          console.log(chalk.green(`     Actual:    ${actualArrow} ${result.actualDirection.toUpperCase()} to ${formatPrice(result.actualPrice)} (${actualChangePercent}%)`));
          console.log(chalk.green(`     MAPE: ${result.mape.toFixed(2)}% (${result.interpretation})`));
        } else {
          console.log(chalk.bgRed.white.bold(` ✗ MISS`));
          console.log(chalk.red(`     ${pred.symbol} [${formulaShort}]`));
          console.log(chalk.red(`     Predicted: ${pred.predicted_direction.toUpperCase()} to ${formatPrice(result.predictedPrice)} (${predictedChangePercent}%)`));
          console.log(chalk.red(`     Actual:    ${actualArrow} ${result.actualDirection.toUpperCase()} to ${formatPrice(result.actualPrice)} (${actualChangePercent}%)`));
          console.log(chalk.red(`     MAPE: ${result.mape.toFixed(2)}% (${result.interpretation})`));
        }
        console.log('');
      }

      if (directionalPreds > 0) {
        const hitRate = (hits / directionalPreds * 100).toFixed(1);
        const hitBar = '█'.repeat(Math.round(hits / directionalPreds * 10)) + '░'.repeat(10 - Math.round(hits / directionalPreds * 10));
        console.log(chalk.bold(`  📊 Direction Accuracy: [${hitBar}] ${hitRate}% (${hits}/${directionalPreds})`));
      }

      // Adaptive learning
      const learning = adaptiveLearner.learn();
      if (learning.updated) {
        console.log(chalk.cyan(`  🧠 Model weights updated based on results`));
      }
      console.log('');
    }

    // Run predictions
    const results = await predictor.predictByFormula(symbol, formula as any, intervalMinutes);

    // Clear old predictions for this symbol
    activePredictions.set(symbol, []);

    console.log(chalk.bold(`\n  ┌──────────────────────────────────────────────────────────────┐`));
    console.log(chalk.bold(`  │ 🎯 FORECAST TARGETS (${intervalMinutes} min timeframe)                          │`));
    console.log(chalk.bold(`  └──────────────────────────────────────────────────────────────┘`));

    for (const result of results) {
      const pred = result.prediction;
      const priceChange = pred.predicted_price - result.currentPrice;
      const priceChangePercent = (priceChange / result.currentPrice) * 100;

      const direction =
        pred.predicted_direction === 'up'
          ? chalk.green.bold('▲ UP  ')
          : pred.predicted_direction === 'down'
          ? chalk.red.bold('▼ DOWN')
          : chalk.yellow.bold('◆ HOLD');

      let formulaLabel: string;
      let formulaShort: string;
      switch (result.formulaType) {
        case 'arimax': formulaLabel = chalk.blue('ARIMAX    '); formulaShort = 'AR'; break;
        case 'arimax_sentiment': formulaLabel = chalk.magenta('SENTIMENT '); formulaShort = 'AR+S'; break;
        case 'ensemble': formulaLabel = chalk.cyan('ENSEMBLE  '); formulaShort = 'ENS'; break;
        case 'technical': formulaLabel = chalk.yellow('TECHNICAL '); formulaShort = 'TECH'; break;
        default: formulaLabel = result.formulaType.padEnd(10); formulaShort = result.formulaType;
      }

      const changeColor = priceChange >= 0 ? chalk.green : chalk.red;
      const changeSign = priceChange >= 0 ? '+' : '';
      const targetTime = new Date(pred.target_timestamp).toLocaleTimeString();

      console.log('');
      console.log(`  ${formulaLabel} ${direction}`);
      console.log(chalk.gray(`  ───────────────────────────────────────`));
      console.log(`  Current:    ${chalk.white(formatPrice(result.currentPrice))}`);
      console.log(`  Target:     ${chalk.bold(formatPrice(pred.predicted_price))} ${changeColor(`(${changeSign}${priceChangePercent.toFixed(2)}%)`)}`);
      console.log(`  Confidence: ${chalk.cyan(`${(pred.confidence * 100).toFixed(0)}%`)}`);
      console.log(`  Expires:    ${chalk.gray(targetTime)} (${intervalMinutes}m)`);

      // Add to active predictions for live tracking
      if (pred.predicted_direction !== 'neutral' && pred.id) {
        const predictions = activePredictions.get(symbol) || [];
        predictions.push({
          id: pred.id,
          symbol,
          formula: formulaShort,
          startPrice: result.currentPrice,
          targetPrice: pred.predicted_price,
          direction: pred.predicted_direction,
          targetTimestamp: pred.target_timestamp,
          timestamp: pred.timestamp,
          alerted: false,
        });
        activePredictions.set(symbol, predictions);
      }
    }

    // Show summary box
    const bestPred = results.reduce((best, curr) =>
      curr.prediction.confidence > best.prediction.confidence ? curr : best
    );

    console.log('');
    console.log(chalk.bold.cyan(`  ════════════════════════════════════════════════════`));
    console.log(chalk.bold.cyan(`  📈 BEST SIGNAL: `) +
      (bestPred.prediction.predicted_direction === 'up'
        ? chalk.green.bold(`BUY at ${formatPrice(bestPred.currentPrice)} → Target ${formatPrice(bestPred.prediction.predicted_price)}`)
        : bestPred.prediction.predicted_direction === 'down'
        ? chalk.red.bold(`SELL at ${formatPrice(bestPred.currentPrice)} → Target ${formatPrice(bestPred.prediction.predicted_price)}`)
        : chalk.yellow.bold('HOLD - No clear direction'))
    );
    console.log(chalk.bold.cyan(`  ════════════════════════════════════════════════════\n`));

  } catch (error) {
    console.error(chalk.red(`  Failed: ${error}`));
  }
}

/**
 * Prefetch historical data for symbols (smart fetch - uses cache when possible)
 */
async function prefetchHistoricalData(
  symbols: string[],
  duration: string
): Promise<void> {
  // Parse duration to get number of candles needed (15-min candles)
  const candleCounts: Record<string, number> = {
    '1h': 4,      // 4 x 15min = 1 hour
    '6h': 24,     // 24 x 15min = 6 hours
    '12h': 48,    // 48 x 15min = 12 hours
    '1d': 96,     // 96 x 15min = 24 hours
    '3d': 288,    // 288 x 15min = 3 days
    '7d': 672,    // 672 x 15min = 7 days
  };

  const candleCount = candleCounts[duration] || candleCounts['1d'];
  const durationLabel = duration || '1d';

  console.log(chalk.bold.cyan(`\n  ┌──────────────────────────────────────────────────────────────┐`));
  console.log(chalk.bold.cyan(`  │ 📊 PREFETCHING HISTORICAL DATA (${durationLabel})                           │`));
  console.log(chalk.bold.cyan(`  └──────────────────────────────────────────────────────────────┘\n`));

  const startTime = Date.now();
  let totalCached = 0;
  let totalFetched = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const spinner = ora(`  [${i + 1}/${symbols.length}] Checking ${symbol}...`).start();

    try {
      // Smart fetch 15-minute candles (checks DB first)
      spinner.text = `  [${i + 1}/${symbols.length}] ${symbol} (15m)...`;
      const result15m = await dataFetcher.smartFetch(symbol, '15m', candleCount);

      // Smart fetch 1-hour candles
      spinner.text = `  [${i + 1}/${symbols.length}] ${symbol} (1h)...`;
      const result1h = await dataFetcher.smartFetch(symbol, '1h', Math.ceil(candleCount / 4));

      const cached = result15m.cached + result1h.cached;
      const fetched = result15m.fetched + result1h.fetched;
      totalCached += cached;
      totalFetched += fetched;

      // Display result with cache info
      if (cached > 0 && fetched <= 10) {
        spinner.succeed(
          `  [${i + 1}/${symbols.length}] ${symbol}: ` +
          chalk.green(`${cached} cached`) +
          chalk.gray(` + ${fetched} fetched`)
        );
      } else if (cached > 0) {
        spinner.succeed(
          `  [${i + 1}/${symbols.length}] ${symbol}: ` +
          chalk.yellow(`${fetched} fetched`) +
          chalk.gray(` (${cached} in cache)`)
        );
      } else {
        spinner.succeed(
          `  [${i + 1}/${symbols.length}] ${symbol}: ` +
          chalk.blue(`${fetched} fetched from API`)
        );
      }

      // Show data range
      const prices = priceRepo.getLatestPrices(symbol, candleCount);
      if (prices.length > 0) {
        const oldest = new Date(Math.min(...prices.map(p => p.timestamp)));
        const newest = new Date(Math.max(...prices.map(p => p.timestamp)));
        console.log(chalk.gray(`       Range: ${oldest.toLocaleString()} → ${newest.toLocaleString()}`));
        console.log(chalk.gray(`       Total: ${prices.length} candles available`));
      }

    } catch (error) {
      spinner.fail(`  [${i + 1}/${symbols.length}] ${symbol}: Failed - ${error}`);
    }

    // Small delay between symbols to avoid rate limiting (skip if mostly cached)
    if (i < symbols.length - 1 && totalFetched > 10) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const cachePercent = totalCached + totalFetched > 0
    ? ((totalCached / (totalCached + totalFetched)) * 100).toFixed(0)
    : 0;

  console.log('');
  if (totalCached > 0) {
    console.log(chalk.green(`  ✓ Prefetch complete in ${elapsed}s`));
    console.log(chalk.gray(`    Cache hit: ${cachePercent}% (${totalCached} cached, ${totalFetched} fetched from API)`));
  } else {
    console.log(chalk.green(`  ✓ Prefetch complete in ${elapsed}s (${totalFetched} candles from API)`));
  }
  console.log('');
}

export async function watchCommand(options: WatchOptions): Promise<void> {
  const interval = options.interval || 5;
  const formula = options.formula || 'all';
  const showCharts = (options as WatchOptions & { charts?: boolean }).charts !== false;
  const useRealtime = options.realtime || false;
  const prefetchDuration = options.prefetch || '1d';
  const symbols = options.symbols
    ? options.symbols.split(',').map((s) => s.trim())
    : ['BTC/IDR', 'ETH/IDR'];

  // Apply learned weights from previous sessions
  adaptiveLearner.applyLearnedWeights();
  const weights = adaptiveLearner.getLearnedWeights();

  const formulaLabel = {
    arimax: 'ARIMAX only',
    sentiment: 'ARIMAX+Sentiment only',
    technical: 'Technical Indicators only',
    ensemble: 'Ensemble only',
    all: 'All models',
  }[formula] || formula;

  console.log(chalk.bold(`\n╔══════════════════════════════════════════════════════════════╗`));
  console.log(chalk.bold(`║  CRYPTO SNIPPER - Watch Mode (Adaptive Learning Enabled)    ║`));
  console.log(chalk.bold(`╚══════════════════════════════════════════════════════════════╝`));
  console.log(chalk.gray(`  Interval:  ${interval} minutes`));
  console.log(chalk.gray(`  Symbols:   ${symbols.join(', ')}`));
  console.log(chalk.cyan(`  Formula:   ${formulaLabel}`));
  console.log(chalk.cyan(`  Charts:    ${showCharts ? 'Enabled' : 'Disabled'}`));
  console.log(chalk.cyan(`  Mode:      ${useRealtime ? 'Real-time WebSocket' : 'Polling'}`));
  console.log(chalk.cyan(`  Prefetch:  ${prefetchDuration} historical data`));
  if (formula === 'all' || formula === 'ensemble') {
    console.log(chalk.gray(`  Weights:   AR=${(weights.arimax * 100).toFixed(0)}% Sent=${(weights.arimaxSentiment * 100).toFixed(0)}% LSTM=${(weights.lstm * 100).toFixed(0)}% Tech=${(weights.technical * 100).toFixed(0)}%`));
  }
  console.log(chalk.gray('  Press Ctrl+C to stop'));

  // Prefetch historical data first
  await prefetchHistoricalData(symbols, prefetchDuration);

  // Use real-time WebSocket mode if enabled
  if (useRealtime) {
    await watchRealtime(symbols, formula, interval, showCharts);
    return;
  }

  const runCycle = async () => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(chalk.gray(`\n[${timestamp}] Running prediction cycle...`));

    // Fetch latest data and analyze market
    for (const symbol of symbols) {
      try {
        await dataFetcher.fetchAndStore(symbol, '15m', 200);

        // Render price chart with technical indicators
        if (showCharts) {
          const prices = priceRepo.getLatestPrices(symbol, 100);
          if (prices.length >= 20) {
            const chart = chartRenderer.renderPriceChart(symbol, prices, {
              height: 10,
              width: 50,
              showRSI: true,
              showMACD: true,
              showBollinger: true,
            });
            console.log(chart);

            // Volume chart
            const volumeChart = chartRenderer.renderVolumeChart(prices, 50);
            if (volumeChart) {
              console.log(chalk.cyan('  ') + volumeChart);
            }
          }
        }

        // Analyze order book
        const orderBook = await orderBookAnalyzer.analyze(symbol);
        const obSignal = orderBook.signal === 'up' ? chalk.green('↑') : orderBook.signal === 'down' ? chalk.red('↓') : chalk.yellow('→');
        console.log(chalk.gray(`  ${symbol} OrderBook: Imbalance ${(orderBook.imbalance * 100).toFixed(1)}% ${obSignal} | Ratio ${orderBook.bidAskRatio.toFixed(2)}`));

        // Display detected walls (support/resistance)
        displayWalls(orderBook);

        // Fetch sentiment (skip for technical-only mode)
        if (formula !== 'technical') {
          const sentiment = await sentimentFetcher.getSentiment(symbol);
          const sentSignal = sentiment.score > 0.1 ? chalk.green('↑') : sentiment.score < -0.1 ? chalk.red('↓') : chalk.yellow('→');
          console.log(chalk.gray(`  ${symbol} Sentiment: Score ${(sentiment.score * 100).toFixed(1)}% ${sentSignal} | Tweets: ${sentiment.tweetCount}`));
        }
      } catch (error) {
        console.error(chalk.red(`Failed to fetch ${symbol}: ${error}`));
      }
    }

    // Evaluate pending predictions
    const evaluated = await accuracyTracker.evaluatePending();
    if (evaluated.length > 0) {
      console.log(chalk.bold.yellow(`\n  ┌──────────────────────────────────────────────────────────────┐`));
      console.log(chalk.bold.yellow(`  │ 📈 EVALUATION RESULTS (${evaluated.length} predictions)                        │`));
      console.log(chalk.bold.yellow(`  └──────────────────────────────────────────────────────────────┘`));

      // Show HIT/MISS for each evaluated prediction
      let hits = 0;
      let directionalPreds = 0;

      for (const result of evaluated) {
        const pred = result.prediction;
        const formulaShort = pred.formula_type === 'arimax' ? 'AR' :
          pred.formula_type === 'arimax_sentiment' ? 'AR+S' :
          pred.formula_type === 'technical' ? 'TECH' :
          pred.formula_type === 'ensemble' ? 'ENS' : pred.formula_type;

        // Skip neutral predictions
        if (pred.predicted_direction === 'neutral') {
          console.log(chalk.gray(`  ◆ ${pred.symbol} [${formulaShort}] NEUTRAL - No directional prediction`));
          continue;
        }

        directionalPreds++;
        const actualChangePercent = ((result.actualPrice - result.startPrice) / result.startPrice * 100).toFixed(2);
        const predictedChangePercent = ((result.predictedPrice - result.startPrice) / result.startPrice * 100).toFixed(2);
        const actualArrow = result.actualDirection === 'up' ? '▲' : result.actualDirection === 'down' ? '▼' : '◆';

        if (result.isDirectionCorrect) {
          hits++;
          console.log(chalk.bgGreen.black.bold(` 🎯 HIT `));
          console.log(chalk.green(`     ${pred.symbol} [${formulaShort}]`));
          console.log(chalk.green(`     Predicted: ${pred.predicted_direction.toUpperCase()} to ${formatPrice(result.predictedPrice)} (${predictedChangePercent}%)`));
          console.log(chalk.green(`     Actual:    ${actualArrow} ${result.actualDirection.toUpperCase()} to ${formatPrice(result.actualPrice)} (${actualChangePercent}%)`));
          console.log(chalk.green(`     MAPE: ${result.mape.toFixed(2)}% (${result.interpretation})`));
        } else {
          console.log(chalk.bgRed.white.bold(` ✗ MISS`));
          console.log(chalk.red(`     ${pred.symbol} [${formulaShort}]`));
          console.log(chalk.red(`     Predicted: ${pred.predicted_direction.toUpperCase()} to ${formatPrice(result.predictedPrice)} (${predictedChangePercent}%)`));
          console.log(chalk.red(`     Actual:    ${actualArrow} ${result.actualDirection.toUpperCase()} to ${formatPrice(result.actualPrice)} (${actualChangePercent}%)`));
          console.log(chalk.red(`     MAPE: ${result.mape.toFixed(2)}% (${result.interpretation})`));
        }
        console.log('');
      }

      // Show hit rate summary box (only for directional predictions)
      if (directionalPreds > 0) {
        const hitRate = (hits / directionalPreds * 100).toFixed(1);
        const hitBar = '█'.repeat(Math.round(hits / directionalPreds * 10)) + '░'.repeat(10 - Math.round(hits / directionalPreds * 10));
        console.log(chalk.bold(`  📊 Direction Accuracy: [${hitBar}] ${hitRate}% (${hits}/${directionalPreds})`));
      }

      // Run adaptive learning to adjust weights
      const learning = adaptiveLearner.learn();
      if (learning.updated) {
        console.log(chalk.cyan(`  🧠 Weights updated → AR:${(learning.weights.arimax * 100).toFixed(0)}% S:${(learning.weights.arimaxSentiment * 100).toFixed(0)}% LSTM:${(learning.weights.lstm * 100).toFixed(0)}% Tech:${(learning.weights.technical * 100).toFixed(0)}%`));
      }
      console.log('');
    }

    // Run new predictions based on selected formula
    for (const symbol of symbols) {
      try {
        const results = await predictor.predictByFormula(symbol, formula, interval);

        for (const result of results) {
          const direction =
            result.prediction.predicted_direction === 'up'
              ? chalk.green('UP')
              : result.prediction.predicted_direction === 'down'
              ? chalk.red('DOWN')
              : chalk.yellow('-');

          let formulaLabel: string;
          switch (result.formulaType) {
            case 'arimax': formulaLabel = chalk.blue('AR'); break;
            case 'arimax_sentiment': formulaLabel = chalk.magenta('AR+S'); break;
            case 'ensemble': formulaLabel = chalk.cyan('ENS'); break;
            case 'technical': formulaLabel = chalk.yellow('TECH'); break;
            default: formulaLabel = result.formulaType;
          }

          // Show technical indicators if using technical formula
          if (result.formulaType === 'technical') {
            console.log(
              `${symbol.padEnd(12)} [${formulaLabel}] ${formatPrice(result.currentPrice)} -> ${formatPrice(result.prediction.predicted_price)} ${direction} (${(result.prediction.confidence * 100).toFixed(0)}% conf)`
            );
          } else {
            console.log(
              `${symbol.padEnd(12)} [${formulaLabel}] ${formatPrice(result.currentPrice)} -> ${formatPrice(result.prediction.predicted_price)} ${direction}`
            );
          }
        }
      } catch (error) {
        console.error(chalk.red(`Failed to predict ${symbol}: ${error}`));
      }
    }
  };

  // Run immediately
  await runCycle();

  // Then run on interval
  setInterval(runCycle, interval * 60 * 1000);
}

export function dbMigrateCommand(): void {
  const spinner = ora('Running migrations...').start();
  try {
    runMigrations();
    spinner.succeed('Migrations complete');
  } catch (error) {
    spinner.fail(`Migration failed: ${error}`);
  }
}

export function dbResetCommand(): void {
  const spinner = ora('Resetting database...').start();
  try {
    resetDatabase();
    runMigrations();
    spinner.succeed('Database reset complete');
  } catch (error) {
    spinner.fail(`Reset failed: ${error}`);
  }
}

function formatPrice(price: number): string {
  if (price >= 1000000) {
    return `Rp ${(price / 1000000).toFixed(2)}M`;
  } else if (price >= 1000) {
    return `Rp ${(price / 1000).toFixed(2)}K`;
  }
  return `Rp ${price.toFixed(2)}`;
}

/**
 * Display order book walls (support/resistance levels)
 */
function displayWalls(analysis: OrderBookAnalysis): void {
  const { buyWalls, sellWalls, currentPrice, symbol } = analysis;

  if (buyWalls.length === 0 && sellWalls.length === 0) {
    console.log(chalk.gray(`  ${symbol} Walls: No significant walls detected`));
    return;
  }

  console.log(chalk.bold.cyan(`\n  ┌──────────────────────────────────────────────────────────────┐`));
  console.log(chalk.bold.cyan(`  │ 🧱 ORDER BOOK WALLS - ${symbol.padEnd(38)}│`));
  console.log(chalk.bold.cyan(`  └──────────────────────────────────────────────────────────────┘`));

  // Current price reference
  console.log(chalk.white(`  Current Price: ${formatPrice(currentPrice)}`));
  console.log('');

  // Display sell walls (resistance) - sorted from closest to furthest
  if (sellWalls.length > 0) {
    console.log(chalk.red.bold(`  ▼ SELL WALLS (Resistance) - Price may struggle to break above`));
    console.log(chalk.gray(`  ─────────────────────────────────────────────────────────────`));

    for (const wall of sellWalls.slice(0, 3)) {
      const strengthIcon = getWallStrengthIcon(wall.strength);
      const strengthColor = getWallStrengthColor(wall.strength);
      const distanceStr = wall.percentFromPrice >= 0 ? `+${wall.percentFromPrice.toFixed(2)}%` : `${wall.percentFromPrice.toFixed(2)}%`;

      console.log(
        `  ${strengthColor(strengthIcon)} ` +
        chalk.red(`${formatPrice(wall.price)}`.padEnd(14)) +
        chalk.gray(`(${distanceStr})`.padEnd(10)) +
        chalk.white(`Vol: ${wall.volume.toFixed(4)}`.padEnd(16)) +
        strengthColor(`[${wall.strength.toUpperCase()}]`) +
        chalk.gray(` ~${formatValue(wall.valueIDR)}`)
      );
    }
    console.log('');
  }

  // Display buy walls (support) - sorted from closest to furthest
  if (buyWalls.length > 0) {
    console.log(chalk.green.bold(`  ▲ BUY WALLS (Support) - Price likely to bounce here`));
    console.log(chalk.gray(`  ─────────────────────────────────────────────────────────────`));

    for (const wall of buyWalls.slice(0, 3)) {
      const strengthIcon = getWallStrengthIcon(wall.strength);
      const strengthColor = getWallStrengthColor(wall.strength);
      const distanceStr = wall.percentFromPrice >= 0 ? `+${wall.percentFromPrice.toFixed(2)}%` : `${wall.percentFromPrice.toFixed(2)}%`;

      console.log(
        `  ${strengthColor(strengthIcon)} ` +
        chalk.green(`${formatPrice(wall.price)}`.padEnd(14)) +
        chalk.gray(`(${distanceStr})`.padEnd(10)) +
        chalk.white(`Vol: ${wall.volume.toFixed(4)}`.padEnd(16)) +
        strengthColor(`[${wall.strength.toUpperCase()}]`) +
        chalk.gray(` ~${formatValue(wall.valueIDR)}`)
      );
    }
    console.log('');
  }

  // Show trading insight based on walls
  const nearestSellWall = sellWalls[0];
  const nearestBuyWall = buyWalls[0];

  if (nearestSellWall || nearestBuyWall) {
    console.log(chalk.bold.yellow(`  💡 INSIGHT:`));

    if (nearestBuyWall && nearestSellWall) {
      const range = ((nearestSellWall.price - nearestBuyWall.price) / currentPrice * 100).toFixed(2);
      console.log(chalk.gray(`  Price range between walls: ${range}%`));
      console.log(chalk.gray(`  Support: ${formatPrice(nearestBuyWall.price)} | Resistance: ${formatPrice(nearestSellWall.price)}`));

      // Check which wall is stronger
      if (nearestBuyWall.volume > nearestSellWall.volume * 1.5) {
        console.log(chalk.green(`  → Strong buy wall suggests bullish pressure`));
      } else if (nearestSellWall.volume > nearestBuyWall.volume * 1.5) {
        console.log(chalk.red(`  → Strong sell wall suggests bearish pressure`));
      }
    } else if (nearestBuyWall) {
      console.log(chalk.green(`  → Strong support at ${formatPrice(nearestBuyWall.price)} (${Math.abs(nearestBuyWall.percentFromPrice).toFixed(2)}% below)`));
    } else if (nearestSellWall) {
      console.log(chalk.red(`  → Strong resistance at ${formatPrice(nearestSellWall.price)} (${nearestSellWall.percentFromPrice.toFixed(2)}% above)`));
    }
  }

  console.log('');
}

function getWallStrengthIcon(strength: Wall['strength']): string {
  switch (strength) {
    case 'massive': return '🧱🧱🧱🧱';
    case 'strong': return '🧱🧱🧱 ';
    case 'medium': return '🧱🧱  ';
    case 'weak': return '🧱   ';
    default: return '    ';
  }
}

function getWallStrengthColor(strength: Wall['strength']): typeof chalk.red {
  switch (strength) {
    case 'massive': return chalk.bold.magenta;
    case 'strong': return chalk.bold.yellow;
    case 'medium': return chalk.cyan;
    case 'weak': return chalk.gray;
    default: return chalk.white;
  }
}

function formatValue(value: number): string {
  if (value >= 1000000000) {
    return `Rp ${(value / 1000000000).toFixed(1)}B`;
  } else if (value >= 1000000) {
    return `Rp ${(value / 1000000).toFixed(1)}M`;
  } else if (value >= 1000) {
    return `Rp ${(value / 1000).toFixed(1)}K`;
  }
  return `Rp ${value.toFixed(0)}`;
}

/**
 * Display compact wall info for realtime mode (single line)
 */
function displayWallsCompact(analysis: OrderBookAnalysis): void {
  const { buyWalls, sellWalls, currentPrice, symbol } = analysis;

  // Get nearest strong walls only (medium or above)
  const strongBuyWall = buyWalls.find(w => w.strength !== 'weak');
  const strongSellWall = sellWalls.find(w => w.strength !== 'weak');

  if (!strongBuyWall && !strongSellWall) {
    return; // No significant walls to show
  }

  let wallInfo = chalk.gray(`  ${symbol} Walls: `);

  if (strongBuyWall) {
    const icon = strongBuyWall.strength === 'massive' ? '🧱🧱' : '🧱';
    wallInfo += chalk.green(`${icon} Support ${formatPrice(strongBuyWall.price)} (${strongBuyWall.percentFromPrice.toFixed(1)}%)`);
  }

  if (strongBuyWall && strongSellWall) {
    wallInfo += chalk.gray(' | ');
  }

  if (strongSellWall) {
    const icon = strongSellWall.strength === 'massive' ? '🧱🧱' : '🧱';
    wallInfo += chalk.red(`${icon} Resistance ${formatPrice(strongSellWall.price)} (+${strongSellWall.percentFromPrice.toFixed(1)}%)`);
  }

  console.log(wallInfo);
}
