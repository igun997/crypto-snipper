/**
 * Min-Max Normalization
 * Formula: X_norm = (X - min(X)) / (max(X) - min(X))
 */

export interface NormalizationParams {
  min: number;
  max: number;
}

export function normalize(value: number, params: NormalizationParams): number {
  const { min, max } = params;
  if (max === min) return 0;
  return (value - min) / (max - min);
}

export function denormalize(normalizedValue: number, params: NormalizationParams): number {
  const { min, max } = params;
  return normalizedValue * (max - min) + min;
}

export function computeNormalizationParams(values: number[]): NormalizationParams {
  if (values.length === 0) {
    return { min: 0, max: 1 };
  }
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function normalizeArray(values: number[]): { normalized: number[]; params: NormalizationParams } {
  const params = computeNormalizationParams(values);
  const normalized = values.map((v) => normalize(v, params));
  return { normalized, params };
}

export function denormalizeArray(normalizedValues: number[], params: NormalizationParams): number[] {
  return normalizedValues.map((v) => denormalize(v, params));
}

/**
 * Simple min-max normalization for an array
 */
export function minMaxNormalize(values: number[]): number[] {
  const params = computeNormalizationParams(values);
  return values.map((v) => normalize(v, params));
}

/**
 * Denormalize a single value given original min/max
 */
export function minMaxDenormalize(normalizedValue: number, min: number, max: number): number {
  return normalizedValue * (max - min) + min;
}

export default {
  normalize,
  denormalize,
  computeNormalizationParams,
  normalizeArray,
  denormalizeArray,
  minMaxNormalize,
  minMaxDenormalize,
};
