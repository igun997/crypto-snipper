import { getDatabase } from './connection.js';

const migrations = [
  {
    version: 1,
    name: 'create_prices_table',
    sql: `
      CREATE TABLE IF NOT EXISTS prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, timestamp)
      );
      CREATE INDEX IF NOT EXISTS idx_prices_symbol ON prices(symbol);
      CREATE INDEX IF NOT EXISTS idx_prices_timestamp ON prices(timestamp);
    `,
  },
  {
    version: 2,
    name: 'create_predictions_table',
    sql: `
      CREATE TABLE IF NOT EXISTS predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        formula_type TEXT NOT NULL,
        predicted_price REAL NOT NULL,
        predicted_direction TEXT,
        confidence REAL,
        interval_minutes INTEGER,
        timestamp INTEGER NOT NULL,
        target_timestamp INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_predictions_symbol ON predictions(symbol);
      CREATE INDEX IF NOT EXISTS idx_predictions_formula ON predictions(formula_type);
      CREATE INDEX IF NOT EXISTS idx_predictions_target ON predictions(target_timestamp);
    `,
  },
  {
    version: 3,
    name: 'create_accuracy_results_table',
    sql: `
      CREATE TABLE IF NOT EXISTS accuracy_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prediction_id INTEGER NOT NULL,
        actual_price REAL NOT NULL,
        actual_direction TEXT,
        mape REAL,
        is_direction_correct INTEGER,
        evaluated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (prediction_id) REFERENCES predictions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_accuracy_prediction ON accuracy_results(prediction_id);
    `,
  },
  {
    version: 4,
    name: 'create_accuracy_summary_table',
    sql: `
      CREATE TABLE IF NOT EXISTS accuracy_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        formula_type TEXT NOT NULL,
        total_predictions INTEGER,
        correct_directions INTEGER,
        avg_mape REAL,
        period_start TEXT,
        period_end TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_summary_symbol ON accuracy_summary(symbol);
      CREATE INDEX IF NOT EXISTS idx_summary_formula ON accuracy_summary(formula_type);
    `,
  },
  {
    version: 5,
    name: 'create_sentiment_table',
    sql: `
      CREATE TABLE IF NOT EXISTS sentiments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        score REAL NOT NULL,
        positive_count INTEGER DEFAULT 0,
        negative_count INTEGER DEFAULT 0,
        neutral_count INTEGER DEFAULT 0,
        tweet_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, timestamp)
      );
      CREATE INDEX IF NOT EXISTS idx_sentiments_symbol ON sentiments(symbol);
      CREATE INDEX IF NOT EXISTS idx_sentiments_timestamp ON sentiments(timestamp);
    `,
  },
  // ============================================
  // Telegram Trading Integration Tables
  // ============================================
  {
    version: 6,
    name: 'create_telegram_users_table',
    sql: `
      CREATE TABLE IF NOT EXISTS telegram_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE NOT NULL,
        username TEXT,
        role TEXT DEFAULT 'user',
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_users_telegram_id ON telegram_users(telegram_id);
    `,
  },
  {
    version: 7,
    name: 'create_trading_accounts_table',
    sql: `
      CREATE TABLE IF NOT EXISTS trading_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        account_name TEXT NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        api_secret_encrypted TEXT NOT NULL,
        iv TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id),
        UNIQUE(telegram_user_id, account_name)
      );
      CREATE INDEX IF NOT EXISTS idx_trading_accounts_user ON trading_accounts(telegram_user_id);
    `,
  },
  {
    version: 8,
    name: 'create_orders_table',
    sql: `
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        exchange_order_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        amount REAL NOT NULL,
        price REAL,
        stop_price REAL,
        status TEXT DEFAULT 'pending',
        filled_amount REAL DEFAULT 0,
        filled_price REAL,
        fee REAL DEFAULT 0,
        error_message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES trading_accounts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
    `,
  },
  {
    version: 9,
    name: 'create_positions_table',
    sql: `
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        entry_order_id INTEGER,
        entry_price REAL NOT NULL,
        amount REAL NOT NULL,
        take_profit_price REAL,
        stop_loss_price REAL,
        status TEXT DEFAULT 'open',
        exit_price REAL,
        pnl_percent REAL,
        pnl_idr REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        closed_at TEXT,
        FOREIGN KEY (account_id) REFERENCES trading_accounts(id),
        FOREIGN KEY (entry_order_id) REFERENCES orders(id)
      );
      CREATE INDEX IF NOT EXISTS idx_positions_account ON positions(account_id);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
    `,
  },
  {
    version: 10,
    name: 'create_telegram_settings_table',
    sql: `
      CREATE TABLE IF NOT EXISTS telegram_settings (
        telegram_user_id INTEGER PRIMARY KEY,
        notifications INTEGER DEFAULT 1,
        auto_execute INTEGER DEFAULT 0,
        trade_amount_pct REAL DEFAULT 10,
        FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id)
      );
    `,
  },
  {
    version: 11,
    name: 'add_dry_run_support',
    sql: `
      -- Add is_dry_run column to orders
      ALTER TABLE orders ADD COLUMN is_dry_run INTEGER DEFAULT 0;

      -- Add is_dry_run column to positions
      ALTER TABLE positions ADD COLUMN is_dry_run INTEGER DEFAULT 0;

      -- Create dry run balances table
      CREATE TABLE IF NOT EXISTS dry_run_balances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        currency TEXT NOT NULL,
        balance REAL NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, currency),
        FOREIGN KEY (account_id) REFERENCES trading_accounts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_dry_run_balances_account ON dry_run_balances(account_id);
    `,
  },
];

export function runMigrations(): void {
  const db = getDatabase();

  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get applied migrations
  const applied = db
    .prepare('SELECT version FROM migrations')
    .all()
    .map((row: unknown) => (row as { version: number }).version);

  // Run pending migrations
  for (const migration of migrations) {
    if (!applied.includes(migration.version)) {
      console.log(`Running migration ${migration.version}: ${migration.name}`);
      db.exec(migration.sql);
      db.prepare('INSERT INTO migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      );
      console.log(`Migration ${migration.version} complete`);
    }
  }
}

export function resetDatabase(): void {
  const db = getDatabase();

  // Drop all tables (in order respecting foreign keys)
  const tables = [
    'telegram_settings',
    'positions',
    'orders',
    'trading_accounts',
    'telegram_users',
    'accuracy_summary',
    'accuracy_results',
    'predictions',
    'prices',
    'sentiments',
    'migrations'
  ];
  for (const table of tables) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  console.log('Database reset complete');
}

export default { runMigrations, resetDatabase };
