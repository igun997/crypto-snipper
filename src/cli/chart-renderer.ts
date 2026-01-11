import asciichart from 'asciichart';
import chalk from 'chalk';
import { PriceRecord } from '../types/index.js';
import technicalIndicators from '../models/technical-indicators.js';

export interface ChartOptions {
  height?: number;
  width?: number;
  showVolume?: boolean;
  showRSI?: boolean;
  showMACD?: boolean;
  showBollinger?: boolean;
}

export class ChartRenderer {
  /**
   * Render price chart with optional indicators
   */
  renderPriceChart(
    symbol: string,
    prices: PriceRecord[],
    options: ChartOptions = {}
  ): string {
    const height = options.height || 12;
    const sortedPrices = [...prices].sort((a, b) => a.timestamp - b.timestamp);

    // Get last N prices for chart (fit terminal width)
    const chartWidth = options.width || 60;
    const displayPrices = sortedPrices.slice(-chartWidth);
    const closePrices = displayPrices.map(p => p.close);

    if (closePrices.length < 5) {
      return chalk.yellow('  Insufficient data for chart');
    }

    const lines: string[] = [];

    // Header
    const currentPrice = closePrices[closePrices.length - 1];
    const priceChange = closePrices.length > 1
      ? ((currentPrice - closePrices[0]) / closePrices[0] * 100)
      : 0;
    const changeColor = priceChange >= 0 ? chalk.green : chalk.red;
    const changeSign = priceChange >= 0 ? '+' : '';

    lines.push('');
    lines.push(chalk.bold.cyan(`  ╔══════════════════════════════════════════════════════════════╗`));
    lines.push(chalk.bold.cyan(`  ║ `) + chalk.bold.white(`${symbol} Price Chart`) + chalk.gray(` (${displayPrices.length} candles)`) +
      changeColor(` ${changeSign}${priceChange.toFixed(2)}%`) +
      chalk.bold.cyan(`                       ║`.slice(0, 20)));
    lines.push(chalk.bold.cyan(`  ╠══════════════════════════════════════════════════════════════╣`));

    // Price chart
    const priceChart = asciichart.plot(closePrices, {
      height,
      padding: '       ',
      format: (x: number) => this.formatShortPrice(x).padStart(10),
    });

    const priceLines = priceChart.split('\n');
    for (const line of priceLines) {
      lines.push(chalk.cyan('  ║ ') + chalk.green(line));
    }

    // Calculate and show technical indicators
    const indicators = technicalIndicators.calculate(sortedPrices);

    lines.push(chalk.bold.cyan(`  ╠══════════════════════════════════════════════════════════════╣`));

    // RSI with visual bar
    if (options.showRSI !== false) {
      const rsiBar = this.renderRSIBar(indicators.rsi);
      const rsiColor = indicators.rsi > 70 ? chalk.red : indicators.rsi < 30 ? chalk.green : chalk.yellow;
      lines.push(chalk.cyan('  ║ ') + chalk.bold('RSI: ') + rsiColor(`${indicators.rsi.toFixed(1)}`.padStart(5)) + ' ' + rsiBar);
    }

    // MACD
    if (options.showMACD !== false) {
      const macdColor = indicators.macdHistogram > 0 ? chalk.green : chalk.red;
      const macdSignalText = indicators.macdHistogram > 0 ? '▲ BUY ' : '▼ SELL';
      lines.push(chalk.cyan('  ║ ') +
        chalk.bold('MACD: ') +
        macdColor(`${indicators.macd.toFixed(2)}`.padStart(8)) +
        chalk.gray(' | Signal: ') +
        macdColor(`${indicators.macdSignal.toFixed(2)}`.padStart(8)) +
        chalk.gray(' | ') +
        macdColor(macdSignalText)
      );
    }

    // Bollinger Bands
    if (options.showBollinger !== false) {
      const bb = { upper: indicators.bollingerUpper, middle: indicators.bollingerMiddle, lower: indicators.bollingerLower };
      const bbPosition = this.getBBPosition(currentPrice, bb);
      lines.push(chalk.cyan('  ║ ') +
        chalk.bold('BB:   ') +
        chalk.red(`U:${this.formatShortPrice(bb.upper)}`.padStart(10)) +
        chalk.yellow(` M:${this.formatShortPrice(bb.middle)}`.padStart(10)) +
        chalk.green(` L:${this.formatShortPrice(bb.lower)}`.padStart(10)) +
        chalk.gray(' | ') + bbPosition
      );
    }

    // Moving Averages
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('MA:   ') +
      chalk.blue(`SMA20:${this.formatShortPrice(indicators.sma20)}`.padStart(12)) +
      chalk.magenta(` EMA12:${this.formatShortPrice(indicators.ema12)}`.padStart(12)) +
      chalk.cyan(` EMA26:${this.formatShortPrice(indicators.ema26)}`.padStart(12))
    );

    lines.push(chalk.bold.cyan(`  ╠══════════════════════════════════════════════════════════════╣`));
    lines.push(chalk.cyan('  ║ ') + chalk.bold.white('Extended Indicators:'));

    // Stochastic Oscillator
    const stochColor = indicators.stochSignal === 'up' ? chalk.green : indicators.stochSignal === 'down' ? chalk.red : chalk.yellow;
    const stochLabel = indicators.stochK > 80 ? 'OVERBOUGHT' : indicators.stochK < 20 ? 'OVERSOLD' : 'NEUTRAL';
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('STOCH:') +
      chalk.gray(' K:') + stochColor(`${indicators.stochK.toFixed(1)}`.padStart(5)) +
      chalk.gray(' D:') + stochColor(`${indicators.stochD.toFixed(1)}`.padStart(5)) +
      chalk.gray(' | ') + stochColor(stochLabel)
    );

    // ADX (trend strength)
    const adxColor = indicators.adx > 25 ? chalk.green : chalk.yellow;
    const adxTrend = indicators.adx > 50 ? 'STRONG' : indicators.adx > 25 ? 'TRENDING' : 'WEAK';
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('ADX:  ') + adxColor(`${indicators.adx.toFixed(1)}`.padStart(5)) +
      chalk.gray(' Trend: ') + adxColor(adxTrend) +
      chalk.gray(' | Dir: ') + this.signalColor(indicators.adxSignal)
    );

    // CCI
    const cciColor = indicators.cciSignal === 'up' ? chalk.green : indicators.cciSignal === 'down' ? chalk.red : chalk.yellow;
    const cciLabel = indicators.cci > 100 ? 'OVERBOUGHT' : indicators.cci < -100 ? 'OVERSOLD' : 'NEUTRAL';
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('CCI:  ') + cciColor(`${indicators.cci.toFixed(1)}`.padStart(7)) +
      chalk.gray(' | ') + cciColor(cciLabel)
    );

    // Williams %R
    const willColor = indicators.williamsSignal === 'up' ? chalk.green : indicators.williamsSignal === 'down' ? chalk.red : chalk.yellow;
    const willLabel = indicators.williamsR > -20 ? 'OVERBOUGHT' : indicators.williamsR < -80 ? 'OVERSOLD' : 'NEUTRAL';
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('W%R:  ') + willColor(`${indicators.williamsR.toFixed(1)}`.padStart(7)) +
      chalk.gray(' | ') + willColor(willLabel)
    );

    // OBV Trend
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('OBV:  ') + chalk.gray('Trend: ') + this.signalColor(indicators.obvTrend)
    );

    // EMA Crossover
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('EMA X:') + chalk.gray(' Cross Signal: ') + this.signalColor(indicators.emaCrossSignal)
    );

    // Momentum
    const momColor = indicators.momentumSignal === 'up' ? chalk.green : indicators.momentumSignal === 'down' ? chalk.red : chalk.yellow;
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('MOM:  ') + momColor(`${indicators.momentum.toFixed(2)}`.padStart(8)) +
      chalk.gray(' | ') + this.signalColor(indicators.momentumSignal)
    );

    // ATR (volatility)
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold('ATR:  ') + chalk.magenta(this.formatShortPrice(indicators.atr)) +
      chalk.gray(' (volatility)')
    );

    // Trend summary - use indicators directly since it contains overallSignal
    const trendIcon = indicators.overallSignal === 'up' ? '🟢' : indicators.overallSignal === 'down' ? '🔴' : '🟡';
    const trendText = indicators.overallSignal === 'up'
      ? chalk.green.bold('BULLISH')
      : indicators.overallSignal === 'down'
      ? chalk.red.bold('BEARISH')
      : chalk.yellow.bold('NEUTRAL');

    lines.push(chalk.bold.cyan(`  ╠══════════════════════════════════════════════════════════════╣`));
    lines.push(chalk.cyan('  ║ ') +
      chalk.bold(`Signal: ${trendIcon} ${trendText}`) +
      chalk.gray(` | Confidence: ${(indicators.confidence * 100).toFixed(0)}%`) +
      chalk.gray(` | Buy:${indicators.buySignals} Sell:${indicators.sellSignals} Neutral:${indicators.neutralSignals}`)
    );
    lines.push(chalk.bold.cyan(`  ╚══════════════════════════════════════════════════════════════╝`));

    return lines.join('\n');
  }

  /**
   * Render mini sparkline chart
   */
  renderSparkline(prices: number[], width: number = 20): string {
    if (prices.length < 2) return '';

    const normalized = this.normalizeArray(prices.slice(-width));
    const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

    let sparkline = '';
    for (const val of normalized) {
      const idx = Math.min(Math.floor(val * chars.length), chars.length - 1);
      sparkline += chars[idx];
    }

    const change = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
    const color = change >= 0 ? chalk.green : chalk.red;

    return color(sparkline);
  }

  /**
   * Render RSI bar visualization
   */
  private renderRSIBar(rsi: number): string {
    const barLength = 30;
    const position = Math.round((rsi / 100) * barLength);

    let bar = '';
    for (let i = 0; i < barLength; i++) {
      if (i < 9) { // 0-30 zone (oversold)
        bar += i === position ? chalk.bgGreen(' ') : chalk.green('░');
      } else if (i >= 21) { // 70-100 zone (overbought)
        bar += i === position ? chalk.bgRed(' ') : chalk.red('░');
      } else { // neutral zone
        bar += i === position ? chalk.bgYellow(' ') : chalk.gray('░');
      }
    }

    const label = rsi > 70 ? chalk.red('OVERBOUGHT') : rsi < 30 ? chalk.green('OVERSOLD') : chalk.gray('NEUTRAL');
    return `[${bar}] ${label}`;
  }

  /**
   * Get colored signal text
   */
  private signalColor(signal: 'up' | 'down' | 'neutral'): string {
    if (signal === 'up') return chalk.green.bold('▲ BUY');
    if (signal === 'down') return chalk.red.bold('▼ SELL');
    return chalk.yellow('● HOLD');
  }

  /**
   * Get Bollinger Band position description
   */
  private getBBPosition(price: number, bb: { upper: number; middle: number; lower: number }): string {
    const range = bb.upper - bb.lower;
    const position = (price - bb.lower) / range;

    if (position > 0.9) return chalk.red('Near Upper (Sell)');
    if (position < 0.1) return chalk.green('Near Lower (Buy)');
    if (position > 0.6) return chalk.yellow('Above Middle');
    if (position < 0.4) return chalk.yellow('Below Middle');
    return chalk.gray('At Middle');
  }

  /**
   * Format price for compact display
   */
  private formatShortPrice(price: number): string {
    if (price >= 1000000000) {
      return `${(price / 1000000000).toFixed(1)}B`;
    } else if (price >= 1000000) {
      return `${(price / 1000000).toFixed(1)}M`;
    } else if (price >= 1000) {
      return `${(price / 1000).toFixed(1)}K`;
    }
    return price.toFixed(2);
  }

  /**
   * Normalize array to 0-1 range
   */
  private normalizeArray(arr: number[]): number[] {
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const range = max - min || 1;
    return arr.map(v => (v - min) / range);
  }

  /**
   * Render volume chart
   */
  renderVolumeChart(prices: PriceRecord[], width: number = 60): string {
    const sortedPrices = [...prices].sort((a, b) => a.timestamp - b.timestamp).slice(-width);
    const volumes = sortedPrices.map(p => p.volume);

    if (volumes.length < 5) return '';

    const maxVol = Math.max(...volumes);
    const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    let volumeBar = '';
    for (let i = 0; i < volumes.length; i++) {
      const height = Math.round((volumes[i] / maxVol) * 8);
      const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
      const isAboveAvg = volumes[i] > avgVol;
      const char = chars[Math.min(height, 7)];
      volumeBar += isAboveAvg ? chalk.green(char) : chalk.gray(char);
    }

    return chalk.gray('Vol: ') + volumeBar + chalk.gray(` (avg: ${this.formatShortPrice(avgVol)})`);
  }

  /**
   * Render chart for Telegram (monospace, no colors)
   * Width: 40 chars (fits mobile), Height: 8 lines
   */
  renderTelegramChart(symbol: string, prices: PriceRecord[]): string {
    const sortedPrices = [...prices].sort((a, b) => a.timestamp - b.timestamp);
    const chartWidth = 36;
    const displayPrices = sortedPrices.slice(-chartWidth);
    const closePrices = displayPrices.map(p => p.close);

    if (closePrices.length < 5) {
      return '⚠️ Insufficient data for chart';
    }

    // Calculate price change
    const currentPrice = closePrices[closePrices.length - 1];
    const startPrice = closePrices[0];
    const priceChange = ((currentPrice - startPrice) / startPrice) * 100;
    const changeSign = priceChange >= 0 ? '+' : '';
    const changeIcon = priceChange >= 0 ? '📈' : '📉';

    const lines: string[] = [];

    // Header
    lines.push(`${changeIcon} ${symbol}`);
    lines.push(`💰 ${this.formatTelegramPrice(currentPrice)} (${changeSign}${priceChange.toFixed(2)}%)`);
    lines.push('');

    // Simple ASCII chart (8 lines height)
    const chart = asciichart.plot(closePrices, {
      height: 6,
      padding: '  ',
      format: (x: number) => this.formatCompactPrice(x).padStart(8),
    });

    lines.push('```');
    lines.push(chart);
    lines.push('```');

    return lines.join('\n');
  }

  /**
   * Render compact indicators for Telegram
   */
  renderTelegramIndicators(prices: PriceRecord[]): string {
    const sortedPrices = [...prices].sort((a, b) => a.timestamp - b.timestamp);

    if (sortedPrices.length < 20) {
      return '⚠️ Need more data for indicators';
    }

    const indicators = technicalIndicators.calculate(sortedPrices);
    const lines: string[] = [];

    // RSI with visual bar
    const rsiIcon = indicators.rsi > 70 ? '🔴' : indicators.rsi < 30 ? '🟢' : '🟡';
    const rsiStatus = indicators.rsi > 70 ? 'OVERBOUGHT' : indicators.rsi < 30 ? 'OVERSOLD' : 'NEUTRAL';
    const rsiBar = this.renderTextBar(indicators.rsi, 100, 10);
    lines.push(`RSI: ${rsiIcon} ${indicators.rsi.toFixed(0)} [${rsiBar}] ${rsiStatus}`);

    // MACD signal
    const macdIcon = indicators.macdHistogram > 0 ? '🟢' : '🔴';
    const macdSignal = indicators.macdHistogram > 0 ? 'BUY' : 'SELL';
    lines.push(`MACD: ${macdIcon} ${macdSignal} (${indicators.macdHistogram >= 0 ? '+' : ''}${indicators.macdHistogram.toFixed(0)})`);

    // Stochastic
    const stochIcon = indicators.stochK > 80 ? '🔴' : indicators.stochK < 20 ? '🟢' : '🟡';
    lines.push(`STOCH: ${stochIcon} K:${indicators.stochK.toFixed(0)} D:${indicators.stochD.toFixed(0)}`);

    // ADX trend strength
    const adxIcon = indicators.adx > 25 ? '💪' : '😴';
    const adxTrend = indicators.adx > 50 ? 'STRONG' : indicators.adx > 25 ? 'TRENDING' : 'WEAK';
    lines.push(`ADX: ${adxIcon} ${indicators.adx.toFixed(0)} (${adxTrend})`);

    // Overall signal
    lines.push('');
    const signalIcon = indicators.overallSignal === 'up' ? '🟢' : indicators.overallSignal === 'down' ? '🔴' : '🟡';
    const signalText = indicators.overallSignal === 'up' ? 'BULLISH' : indicators.overallSignal === 'down' ? 'BEARISH' : 'NEUTRAL';
    lines.push(`Signal: ${signalIcon} ${signalText} (${(indicators.confidence * 100).toFixed(0)}%)`);
    lines.push(`Votes: ⬆️${indicators.buySignals} ⬇️${indicators.sellSignals} ➡️${indicators.neutralSignals}`);

    return lines.join('\n');
  }

  /**
   * Render sparkline for Telegram (plain text)
   */
  renderTelegramSparkline(prices: number[], width: number = 20): string {
    if (prices.length < 2) return '';

    const normalized = this.normalizeArray(prices.slice(-width));
    const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

    let sparkline = '';
    for (const val of normalized) {
      const idx = Math.min(Math.floor(val * chars.length), chars.length - 1);
      sparkline += chars[idx];
    }

    return sparkline;
  }

  /**
   * Render combined chart + indicators for Telegram
   */
  renderTelegramFull(symbol: string, prices: PriceRecord[]): string {
    const sortedPrices = [...prices].sort((a, b) => a.timestamp - b.timestamp);

    if (sortedPrices.length < 20) {
      return `⚠️ Need more data (have ${sortedPrices.length}, need 20+)`;
    }

    const lines: string[] = [];

    // Chart
    lines.push(this.renderTelegramChart(symbol, sortedPrices));
    lines.push('');

    // Indicators
    lines.push('📊 Indicators:');
    lines.push(this.renderTelegramIndicators(sortedPrices));

    return lines.join('\n');
  }

  /**
   * Render a text-based progress bar
   */
  private renderTextBar(value: number, max: number, width: number): string {
    const filled = Math.round((value / max) * width);
    const empty = width - filled;
    return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
  }

  /**
   * Format price for Telegram (with Rupiah formatting)
   */
  private formatTelegramPrice(price: number): string {
    if (price >= 1000000000) {
      return `Rp ${(price / 1000000000).toFixed(2)}B`;
    } else if (price >= 1000000) {
      return `Rp ${(price / 1000000).toFixed(2)}M`;
    } else if (price >= 1000) {
      return `Rp ${(price / 1000).toFixed(2)}K`;
    }
    return `Rp ${price.toFixed(2)}`;
  }

  /**
   * Format compact price for chart axis
   */
  private formatCompactPrice(price: number): string {
    if (price >= 1000000000) {
      return `${(price / 1000000000).toFixed(2)}B`;
    } else if (price >= 1000000) {
      return `${(price / 1000000).toFixed(1)}M`;
    } else if (price >= 1000) {
      return `${(price / 1000).toFixed(0)}K`;
    }
    return price.toFixed(0);
  }
}

export default new ChartRenderer();
