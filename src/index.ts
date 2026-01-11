#!/usr/bin/env node

import { Command } from 'commander';
import {
  fetchCommand,
  pairsCommand,
  chartCommand,
  scalpCommand,
  telegramCommand,
  predictCommand,
  evaluateCommand,
  summaryCommand,
  watchCommand,
  dbMigrateCommand,
  dbResetCommand,
} from './cli/commands.js';
import { runMigrations } from './database/migrations.js';
import { closeDatabase } from './database/connection.js';

const program = new Command();

program
  .name('crypto-snipper')
  .description('CLI tool for crypto price prediction on Indodax using ARIMAX models')
  .version('1.0.0');

// Fetch command
program
  .command('fetch')
  .description('Fetch and store market data from Indodax')
  .option('-s, --symbol <symbol>', 'Trading pair symbol (e.g., BTC/IDR)')
  .option('-a, --all', 'Fetch all available trading pairs')
  .option('-l, --limit <number>', 'Number of candles to fetch', '200')
  .action(async (options) => {
    await ensureMigrations();
    await fetchCommand({
      symbol: options.symbol,
      all: options.all,
      limit: parseInt(options.limit),
    });
    cleanup();
  });

// Pairs command
program
  .command('pairs')
  .description('List available trading pairs on Indodax')
  .action(async () => {
    await pairsCommand();
    cleanup();
  });

// Chart command
program
  .command('chart')
  .description('Display full charts with technical analysis and predictions')
  .option('-s, --symbol <symbol>', 'Trading pair symbol (e.g., BTC/IDR)')
  .option('-a, --all', 'Show charts for all pairs in database')
  .option('-p, --predict', 'Include price predictions (default: true)', true)
  .option('--no-predict', 'Disable predictions')
  .option('-l, --limit <number>', 'Number of candles to display', '100')
  .action(async (options) => {
    await ensureMigrations();
    await chartCommand({
      symbol: options.symbol,
      all: options.all,
      predict: options.predict,
      limit: parseInt(options.limit),
    });
    cleanup();
  });

// Scalp command
program
  .command('scalp')
  .description('Real-time scalping mode with quick entry/exit signals')
  .option('-s, --symbols <list>', 'Comma-separated list of symbols', 'BTC/IDR')
  .option('-t, --take-profit <percent>', 'Take profit percentage', '0.3')
  .option('-l, --stop-loss <percent>', 'Stop loss percentage', '0.15')
  .option('-c, --confidence <percent>', 'Minimum confidence to trigger signal', '60')
  .option('--telegram', 'Enable Telegram notifications')
  .option('--auto', 'Auto-execute signals (requires --telegram)')
  .action(async (options) => {
    await ensureMigrations();
    await scalpCommand({
      symbols: options.symbols,
      takeProfit: parseFloat(options.takeProfit),
      stopLoss: parseFloat(options.stopLoss),
      confidence: parseFloat(options.confidence),
      telegram: options.telegram,
      auto: options.auto,
    });
    // Note: scalp command runs indefinitely
  });

// Telegram command
program
  .command('telegram')
  .description('Start Telegram bot for trading control')
  .action(async () => {
    await ensureMigrations();
    await telegramCommand();
    // Note: telegram command runs indefinitely
  });

// Predict command
program
  .command('predict')
  .description('Run price prediction for a symbol')
  .option('-s, --symbol <symbol>', 'Trading pair symbol', 'BTC/IDR')
  .option('-f, --formula <type>', 'Formula type: arimax, sentiment, ensemble, or all', 'all')
  .option('-i, --interval <minutes>', 'Prediction interval in minutes', '15')
  .action(async (options) => {
    await ensureMigrations();
    await predictCommand({
      symbol: options.symbol,
      formula: options.formula as 'arimax' | 'sentiment' | 'ensemble' | 'all',
      interval: parseInt(options.interval),
    });
    cleanup();
  });

// Evaluate command
program
  .command('evaluate')
  .description('Evaluate past predictions against actual prices')
  .option('-s, --symbol <symbol>', 'Filter by trading pair symbol')
  .action(async (options) => {
    await ensureMigrations();
    await evaluateCommand({
      symbol: options.symbol,
    });
    cleanup();
  });

// Summary command
program
  .command('summary')
  .description('Show accuracy summary and comparison')
  .option('-s, --symbol <symbol>', 'Filter by trading pair symbol')
  .option('-f, --formula <type>', 'Filter by formula: arimax or sentiment')
  .action(async (options) => {
    await ensureMigrations();
    await summaryCommand({
      symbol: options.symbol,
      formula: options.formula as 'arimax' | 'sentiment' | undefined,
    });
    cleanup();
  });

// Watch command
program
  .command('watch')
  .description('Continuously monitor and predict prices')
  .option('-i, --interval <minutes>', 'Check interval in minutes', '5')
  .option('-s, --symbols <list>', 'Comma-separated list of symbols', 'BTC/IDR,ETH/IDR')
  .option('-f, --formula <type>', 'Formula: arimax, sentiment, technical, ensemble, or all', 'all')
  .option('-c, --charts', 'Show ASCII price charts with technical indicators', true)
  .option('--no-charts', 'Disable ASCII charts')
  .option('-r, --realtime', 'Enable WebSocket real-time data streaming')
  .option('-p, --prefetch <duration>', 'Prefetch historical data before watching: 1h, 6h, 1d, 7d', '1d')
  .action(async (options) => {
    await ensureMigrations();
    await watchCommand({
      interval: parseInt(options.interval),
      symbols: options.symbols,
      formula: options.formula,
      charts: options.charts,
      realtime: options.realtime,
      prefetch: options.prefetch,
    });
    // Note: watch command runs indefinitely
  });

// Database commands
program
  .command('db:migrate')
  .description('Run database migrations')
  .action(() => {
    dbMigrateCommand();
    cleanup();
  });

program
  .command('db:reset')
  .description('Reset database (drops all tables)')
  .action(() => {
    dbResetCommand();
    cleanup();
  });

// Helper functions
async function ensureMigrations(): Promise<void> {
  try {
    runMigrations();
  } catch {
    // Migrations already run or DB not initialized
  }
}

function cleanup(): void {
  closeDatabase();
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught error:', error);
  cleanup();
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  cleanup();
  process.exit(0);
});

// Parse command line arguments
program.parse();
