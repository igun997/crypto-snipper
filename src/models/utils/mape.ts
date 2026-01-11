/**
 * MAPE - Mean Absolute Percentage Error
 * Formula: MAPE = (1/n) * SUM(|y_i - y_hat_i| / |y_i|) * 100%
 */

export function calculateMAPE(actual: number[], predicted: number[]): number {
  if (actual.length !== predicted.length || actual.length === 0) {
    throw new Error('Arrays must be of equal length and non-empty');
  }

  let sumError = 0;
  let validCount = 0;

  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== 0) {
      sumError += Math.abs((actual[i] - predicted[i]) / actual[i]);
      validCount++;
    }
  }

  if (validCount === 0) return 0;
  return (sumError / validCount) * 100;
}

export function calculateSingleMAPE(actual: number, predicted: number): number {
  if (actual === 0) return 0;
  return Math.abs((actual - predicted) / actual) * 100;
}

/**
 * Interpret MAPE value
 * < 10%: Highly accurate
 * 10-20%: Good
 * 20-50%: Reasonable
 * > 50%: Inaccurate
 */
export function interpretMAPE(mape: number): string {
  if (mape < 10) return 'Highly accurate';
  if (mape < 20) return 'Good';
  if (mape < 50) return 'Reasonable';
  return 'Inaccurate';
}

export default {
  calculateMAPE,
  calculateSingleMAPE,
  interpretMAPE,
};
