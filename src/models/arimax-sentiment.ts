/**
 * ARIMAX Model with Sentiment - Formula 2
 * y_t = c + SUM(phi_i * y_{t-i}) + beta * X_t + epsilon_t
 *
 * Enhanced with sentiment analysis from X/Twitter
 * Sentiment is included as an additional exogenous variable
 */

import { mean } from 'simple-statistics';
import { PriceRecord, PredictionResult, Direction } from '../types/index.js';
import ArimaxModel from './arimax.js';

export interface SentimentData {
  score: number; // -1 to 1 (negative to positive)
  tweetCount: number;
  timestamp: number;
}

export class ArimaxSentimentModel extends ArimaxModel {
  private sentimentWeight: number = 0.15;
  private latestSentiment: SentimentData | null = null;

  constructor(p: number = 5) {
    super(p);
  }

  /**
   * Update sentiment data
   */
  setSentiment(sentiment: SentimentData): void {
    this.latestSentiment = sentiment;
  }

  /**
   * Make a prediction with sentiment
   */
  predictWithSentiment(prices: PriceRecord[], sentiment?: SentimentData): PredictionResult {
    // Get base prediction from parent ARIMAX model
    const baseResult = super.predict(prices);

    // Apply sentiment adjustment if available
    const sentimentData = sentiment || this.latestSentiment;

    if (!sentimentData) {
      return baseResult;
    }

    const currentPrice = prices.sort((a, b) => b.timestamp - a.timestamp)[0].close;

    // Calculate sentiment adjustment
    // Positive sentiment -> price increase expectation
    // Negative sentiment -> price decrease expectation
    const sentimentAdjustment =
      currentPrice * sentimentData.score * this.sentimentWeight * this.getTweetConfidence(sentimentData.tweetCount);

    const adjustedPrice = baseResult.predictedPrice + sentimentAdjustment;

    // Recalculate direction with sentiment
    let direction: Direction = 'neutral';
    const priceDiff = adjustedPrice - currentPrice;
    const threshold = currentPrice * 0.001;

    if (priceDiff > threshold) {
      direction = 'up';
    } else if (priceDiff < -threshold) {
      direction = 'down';
    }

    // Adjust confidence based on sentiment confidence
    const sentimentConfidence = Math.min(1, sentimentData.tweetCount / 50);
    const adjustedConfidence = baseResult.confidence * 0.7 + sentimentConfidence * 0.3;

    return {
      predictedPrice: adjustedPrice,
      direction,
      confidence: adjustedConfidence,
      components: {
        ...baseResult.components,
        exogenousComponent: baseResult.components.exogenousComponent + sentimentAdjustment,
      },
    };
  }

  /**
   * Calculate confidence multiplier based on tweet count
   */
  private getTweetConfidence(tweetCount: number): number {
    // More tweets = more confidence (up to a point)
    // 10 tweets = 0.5 confidence
    // 50+ tweets = 1.0 confidence
    return Math.min(1, Math.sqrt(tweetCount / 50));
  }

  /**
   * Analyze sentiment from tweet data
   */
  static analyzeSentiment(
    tweets: Array<{ rawContent: string; likeCount?: number; retweetCount?: number }>
  ): SentimentData {
    if (tweets.length === 0) {
      return { score: 0, tweetCount: 0, timestamp: Date.now() };
    }

    const sentimentScores: number[] = [];

    for (const tweet of tweets) {
      const score = ArimaxSentimentModel.calculateTweetSentiment(tweet.rawContent);
      // Weight by engagement
      const engagement = (tweet.likeCount || 0) + (tweet.retweetCount || 0) * 2;
      const weight = Math.min(1, Math.log(engagement + 1) / 5);
      sentimentScores.push(score * (1 + weight));
    }

    const avgScore = mean(sentimentScores);
    // Normalize to -1 to 1 range
    const normalizedScore = Math.max(-1, Math.min(1, avgScore));

    return {
      score: normalizedScore,
      tweetCount: tweets.length,
      timestamp: Date.now(),
    };
  }

  /**
   * Simple keyword-based sentiment analysis
   */
  private static calculateTweetSentiment(text: string): number {
    const lowerText = text.toLowerCase();

    // Positive indicators
    const positiveWords = [
      'bullish',
      'moon',
      'pump',
      'buy',
      'long',
      'breakout',
      'surge',
      'rally',
      'gain',
      'profit',
      'up',
      'high',
      'growth',
      'strong',
      'green',
      'ath',
      'hodl',
      'hold',
      'accumulate',
      'undervalued',
    ];

    // Negative indicators
    const negativeWords = [
      'bearish',
      'dump',
      'sell',
      'short',
      'crash',
      'drop',
      'fall',
      'loss',
      'down',
      'low',
      'weak',
      'red',
      'scam',
      'rug',
      'fear',
      'panic',
      'overvalued',
      'bubble',
      'correction',
      'dip',
    ];

    let score = 0;

    for (const word of positiveWords) {
      if (lowerText.includes(word)) {
        score += 0.1;
      }
    }

    for (const word of negativeWords) {
      if (lowerText.includes(word)) {
        score -= 0.1;
      }
    }

    // Cap at -1 to 1
    return Math.max(-1, Math.min(1, score));
  }
}

export default ArimaxSentimentModel;
