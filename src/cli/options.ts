// CLI options and flag definitions
// This file is reserved for future expansion of CLI options

export const DEFAULT_SYMBOL = 'BTC/IDR';
export const DEFAULT_INTERVAL = 15;
export const DEFAULT_LIMIT = 200; // ~50 hours of 15m data for better LSTM training
export const DEFAULT_TIMEFRAME = '15m';

export const FORMULA_CHOICES = ['arimax', 'sentiment', 'both'] as const;

export type FormulaChoice = (typeof FORMULA_CHOICES)[number];
