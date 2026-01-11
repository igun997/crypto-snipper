// OHLCV candle data
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Price record in database
export interface PriceRecord {
  id?: number;
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  created_at?: string;
}

// Prediction direction
export type Direction = 'up' | 'down' | 'neutral';

// Formula type
export type FormulaType = 'arimax' | 'arimax_sentiment' | 'ensemble' | 'lstm' | 'technical';

// Prediction record
export interface Prediction {
  id?: number;
  symbol: string;
  formula_type: FormulaType;
  predicted_price: number;
  predicted_direction: Direction;
  confidence: number;
  interval_minutes: number;
  timestamp: number;
  target_timestamp: number;
  created_at?: string;
}

// Accuracy result record
export interface AccuracyResult {
  id?: number;
  prediction_id: number;
  actual_price: number;
  actual_direction: Direction;
  mape: number;
  is_direction_correct: number;
  evaluated_at?: string;
}

// Accuracy summary record
export interface AccuracySummary {
  id?: number;
  symbol: string;
  formula_type: FormulaType;
  total_predictions: number;
  correct_directions: number;
  avg_mape: number;
  period_start: string;
  period_end: string;
  updated_at?: string;
}

// ARIMAX model parameters
export interface ArimaxParams {
  p: number;           // AR order (number of lags)
  phi: number[];       // AR coefficients
  beta: number[];      // Exogenous variable coefficients
  c: number;           // Intercept/constant
}

// Exogenous variables for ARIMAX
export interface ExogenousVars {
  volume: number;
  momentum: number;
  sma: number;
  ema: number;
  sentiment?: number;  // Optional sentiment score for Formula 2
}

// Prediction result from model
export interface PredictionResult {
  predictedPrice: number;
  direction: Direction;
  confidence: number;
  components: {
    arComponent: number;
    exogenousComponent: number;
    intercept: number;
  };
}

// Trading pair info
export interface TradingPair {
  symbol: string;
  base: string;
  quote: string;
  active: boolean;
}

// Config interface
export interface Config {
  dbPath: string;
  logLevel: string;
  defaultInterval: number;
  indodax: {
    apiKey?: string;
    secret?: string;
  };
  twitter?: {
    bearerToken?: string;
  };
  telegram?: {
    botToken?: string;
    adminIds?: string[];
  };
  encryption?: {
    masterKey?: string;
    salt?: string;
  };
}

// CLI command options
export interface FetchOptions {
  symbol?: string;
  all?: boolean;
  limit?: number;
}

export interface PredictOptions {
  symbol?: string;
  formula?: 'arimax' | 'sentiment' | 'ensemble' | 'all';
  interval?: number;
}

export interface EvaluateOptions {
  symbol?: string;
}

export interface SummaryOptions {
  symbol?: string;
  formula?: 'arimax' | 'sentiment';
}

export interface WatchOptions {
  interval?: number;
  symbols?: string;
  formula?: 'arimax' | 'sentiment' | 'technical' | 'ensemble' | 'all';
  charts?: boolean;
  realtime?: boolean;
  prefetch?: string;  // Prefetch duration: '1h', '6h', '1d', '7d'
}

// ============================================
// Telegram Trading Integration Types
// ============================================

// Telegram user (authorized to use the bot)
export interface TelegramUser {
  id?: number;
  telegram_id: string;
  username?: string;
  role: 'admin' | 'user';
  is_active: number;
  created_at?: string;
}

// Trading account (linked to Telegram user)
export interface TradingAccount {
  id?: number;
  telegram_user_id: number;
  account_name: string;
  api_key_encrypted: string;
  api_secret_encrypted: string;
  iv: string;
  is_default: number;
  is_active: number;
  created_at?: string;
}

// Order types
export type OrderType = 'market' | 'limit' | 'stop_loss' | 'take_profit';
export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'failed';

// Order record
export interface Order {
  id?: number;
  account_id: number;
  exchange_order_id?: string;
  symbol: string;
  side: OrderSide;
  order_type: OrderType;
  amount: number;
  price?: number;
  stop_price?: number;
  status: OrderStatus;
  filled_amount: number;
  filled_price?: number;
  fee: number;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
}

// Position status
export type PositionStatus = 'open' | 'closed';
export type PositionSide = 'long' | 'short';

// Position record
export interface Position {
  id?: number;
  account_id: number;
  symbol: string;
  side: PositionSide;
  entry_order_id?: number;
  entry_price: number;
  amount: number;
  take_profit_price?: number;
  stop_loss_price?: number;
  status: PositionStatus;
  exit_price?: number;
  pnl_percent?: number;
  pnl_idr?: number;
  created_at?: string;
  closed_at?: string;
}

// Telegram settings per user
export interface TelegramSettings {
  telegram_user_id: number;
  notifications: number;
  auto_execute: number;
  trade_amount_pct: number;
}

// Scalp command options
export interface ScalpOptions {
  symbols?: string;
  takeProfit?: number;
  stopLoss?: number;
  confidence?: number;
  telegram?: boolean;
  auto?: boolean;
}

// Telegram command options
export interface TelegramOptions {
  webhook?: string;
}
