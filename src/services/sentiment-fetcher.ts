import { SentimentData, ArimaxSentimentModel } from '../models/arimax-sentiment.js';
import { getDatabase } from '../database/connection.js';

const KENDLE_API_URL = 'https://cds-kendle-x.qhjgw4.easypanel.host/search';

interface Tweet {
  id: number;
  id_str: string;
  url: string;
  date: string;
  rawContent: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  user: {
    username: string;
    displayname: string;
    followersCount: number;
  };
  hashtags: string[];
  cashtags: string[];
}

interface KendleResponse {
  query: string;
  count: number;
  tweets: Tweet[];
}

// Crypto-specific search terms for better sentiment accuracy
const CRYPTO_TERMS: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc', '$btc', '#bitcoin', 'satoshi'],
  ETH: ['ethereum', 'eth', '$eth', '#ethereum', 'vitalik'],
  USDT: ['tether', 'usdt', '$usdt'],
  BNB: ['binance', 'bnb', '$bnb', '#binance'],
  XRP: ['ripple', 'xrp', '$xrp', '#ripple'],
  SOL: ['solana', 'sol', '$sol', '#solana'],
  DOGE: ['dogecoin', 'doge', '$doge', '#dogecoin', 'elon'],
  ADA: ['cardano', 'ada', '$ada', '#cardano'],
};

export interface SentimentHistory {
  id?: number;
  symbol: string;
  score: number;
  tweet_count: number;
  positive_count: number;
  negative_count: number;
  neutral_count: number;
  timestamp: number;
}

export class SentimentFetcher {
  constructor() {
    this.initializeTable();
  }

  /**
   * Initialize sentiment_history table
   */
  private initializeTable(): void {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS sentiment_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        score REAL NOT NULL,
        tweet_count INTEGER NOT NULL,
        positive_count INTEGER DEFAULT 0,
        negative_count INTEGER DEFAULT 0,
        neutral_count INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sentiment_symbol_time ON sentiment_history(symbol, timestamp)`);
  }

  /**
   * Save sentiment to database
   */
  private saveSentiment(symbol: string, sentiment: SentimentData, breakdown: { positive: number; negative: number; neutral: number }): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO sentiment_history (symbol, score, tweet_count, positive_count, negative_count, neutral_count, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(symbol, sentiment.score, sentiment.tweetCount, breakdown.positive, breakdown.negative, breakdown.neutral, sentiment.timestamp);
  }

  /**
   * Get sentiment history for a symbol
   */
  getSentimentHistory(symbol: string, limit: number = 50): SentimentHistory[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM sentiment_history
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(symbol, limit) as SentimentHistory[];
  }

  /**
   * Get sentiment trend (average of recent sentiment scores)
   */
  getSentimentTrend(symbol: string, periods: number = 5): { trend: number; direction: 'bullish' | 'bearish' | 'neutral' } {
    const history = this.getSentimentHistory(symbol, periods);

    if (history.length === 0) {
      return { trend: 0, direction: 'neutral' };
    }

    const avgScore = history.reduce((sum, h) => sum + h.score, 0) / history.length;

    // Calculate trend direction based on recent vs older sentiment
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (history.length >= 2) {
      const recentAvg = history.slice(0, Math.ceil(history.length / 2)).reduce((s, h) => s + h.score, 0) / Math.ceil(history.length / 2);
      const olderAvg = history.slice(Math.ceil(history.length / 2)).reduce((s, h) => s + h.score, 0) / Math.floor(history.length / 2);

      if (recentAvg > olderAvg + 0.1) direction = 'bullish';
      else if (recentAvg < olderAvg - 0.1) direction = 'bearish';
    } else if (avgScore > 0.2) {
      direction = 'bullish';
    } else if (avgScore < -0.2) {
      direction = 'bearish';
    }

    return { trend: avgScore, direction };
  }
  /**
   * Fetch tweets from the Kendle X API with timeout
   */
  async fetchTweets(query: string, limit: number = 50): Promise<Tweet[]> {
    try {
      const url = new URL(KENDLE_API_URL);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('product', 'Latest');

      // Add 5 second timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url.toString(), {
        headers: {
          Accept: '*/*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = (await response.json()) as KendleResponse;
      return data.tweets || [];
    } catch (error) {
      // Silently fail - don't spam console
      return [];
    }
  }

  /**
   * Get sentiment for a crypto symbol with enhanced search
   */
  async getSentiment(symbol: string): Promise<SentimentData> {
    // Extract base currency from symbol (e.g., "BTC/IDR" -> "BTC")
    const baseCurrency = symbol.split('/')[0].toUpperCase();

    // Get crypto-specific search terms
    const specificTerms = CRYPTO_TERMS[baseCurrency] || [baseCurrency.toLowerCase()];

    // Build search queries - limited to 2 for speed
    const queries = [
      `$${baseCurrency}`,                          // Cashtag (e.g., $BTC)
      specificTerms[0] || baseCurrency,            // Main term (e.g., bitcoin)
    ];

    const allTweets: Tweet[] = [];

    // Fetch with overall timeout of 10 seconds
    const startTime = Date.now();
    const maxTime = 10000;

    for (const query of queries) {
      if (Date.now() - startTime > maxTime) break;

      const tweets = await this.fetchTweets(query, 30);
      allTweets.push(...tweets);
    }

    // Remove duplicates by tweet ID
    const uniqueTweets = Array.from(new Map(allTweets.map((t) => [t.id_str, t])).values());

    // Analyze sentiment with breakdown
    const breakdown = this.analyzeSentimentBreakdown(uniqueTweets);

    // Create sentiment data
    const sentiment: SentimentData = {
      score: breakdown.score,
      tweetCount: uniqueTweets.length,
      timestamp: Date.now(),
    };

    // Save to database
    if (uniqueTweets.length > 0) {
      try {
        this.saveSentiment(symbol, sentiment, breakdown);
      } catch {
        // Ignore save errors
      }
    }

    return sentiment;
  }

  /**
   * Analyze sentiment with detailed breakdown
   */
  private analyzeSentimentBreakdown(tweets: Tweet[]): { score: number; positive: number; negative: number; neutral: number } {
    if (tweets.length === 0) {
      return { score: 0, positive: 0, negative: 0, neutral: 0 };
    }

    let positive = 0;
    let negative = 0;
    let neutral = 0;
    let weightedSum = 0;
    let totalWeight = 0;

    for (const tweet of tweets) {
      const sentiment = this.analyzeTweetSentiment(tweet);
      const weight = this.calculateTweetWeight(tweet);

      if (sentiment > 0.1) positive++;
      else if (sentiment < -0.1) negative++;
      else neutral++;

      weightedSum += sentiment * weight;
      totalWeight += weight;
    }

    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

    return {
      score: Math.max(-1, Math.min(1, score)),
      positive,
      negative,
      neutral,
    };
  }

  /**
   * Analyze individual tweet sentiment
   */
  private analyzeTweetSentiment(tweet: Tweet): number {
    const text = tweet.rawContent.toLowerCase();

    // Enhanced sentiment words with weights
    const positiveWords: Record<string, number> = {
      'bullish': 0.3, 'moon': 0.25, 'pump': 0.2, 'buy': 0.15, 'long': 0.2,
      'breakout': 0.25, 'surge': 0.25, 'rally': 0.25, 'gain': 0.15, 'profit': 0.2,
      'up': 0.1, 'high': 0.1, 'growth': 0.15, 'strong': 0.15, 'green': 0.15,
      'ath': 0.3, 'hodl': 0.2, 'hold': 0.1, 'accumulate': 0.2, 'undervalued': 0.25,
      'bull': 0.2, 'rocket': 0.25, 'gem': 0.2, 'winner': 0.2, 'explode': 0.2,
    };

    const negativeWords: Record<string, number> = {
      'bearish': 0.3, 'dump': 0.25, 'sell': 0.15, 'short': 0.2, 'crash': 0.3,
      'drop': 0.2, 'fall': 0.2, 'loss': 0.2, 'down': 0.1, 'low': 0.1,
      'weak': 0.15, 'red': 0.15, 'scam': 0.4, 'rug': 0.4, 'fear': 0.2,
      'panic': 0.25, 'overvalued': 0.2, 'bubble': 0.25, 'correction': 0.15, 'dip': 0.1,
      'bear': 0.2, 'rekt': 0.3, 'dead': 0.25, 'worthless': 0.35, 'avoid': 0.2,
    };

    let score = 0;

    for (const [word, weight] of Object.entries(positiveWords)) {
      if (text.includes(word)) score += weight;
    }

    for (const [word, weight] of Object.entries(negativeWords)) {
      if (text.includes(word)) score -= weight;
    }

    return Math.max(-1, Math.min(1, score));
  }

  /**
   * Calculate tweet importance weight based on engagement
   */
  private calculateTweetWeight(tweet: Tweet): number {
    const engagement = (tweet.likeCount || 0) + (tweet.retweetCount || 0) * 2 + (tweet.replyCount || 0);
    const followers = tweet.user?.followersCount || 0;

    // Weight = log(engagement + 1) * log(followers + 10)
    const engagementWeight = Math.log10(engagement + 1);
    const followerWeight = Math.log10(Math.min(followers, 1000000) + 10) / 6; // Normalize to ~0-1

    return 1 + engagementWeight * 0.5 + followerWeight * 0.3;
  }

  /**
   * Get sentiment for multiple symbols
   */
  async getSentimentBatch(symbols: string[]): Promise<Map<string, SentimentData>> {
    const results = new Map<string, SentimentData>();

    for (const symbol of symbols) {
      try {
        const sentiment = await this.getSentiment(symbol);
        results.set(symbol, sentiment);
        // Rate limiting
        await this.sleep(500);
      } catch (error) {
        console.error(`Failed to get sentiment for ${symbol}:`, error);
        results.set(symbol, { score: 0, tweetCount: 0, timestamp: Date.now() });
      }
    }

    return results;
  }

  /**
   * Fetch trending crypto topics
   */
  async getTrendingCrypto(): Promise<string[]> {
    try {
      const tweets = await this.fetchTweets('crypto OR bitcoin OR cryptocurrency', 100);

      // Extract cashtags
      const cashtags = new Map<string, number>();
      for (const tweet of tweets) {
        for (const cashtag of tweet.cashtags || []) {
          const current = cashtags.get(cashtag) || 0;
          cashtags.set(cashtag, current + 1);
        }
      }

      // Sort by frequency and return top 10
      return Array.from(cashtags.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tag]) => tag);
    } catch (error) {
      console.error('Failed to get trending crypto:', error);
      return [];
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default new SentimentFetcher();
