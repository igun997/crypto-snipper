# Crypto Snipper

A cryptocurrency trading bot for Indodax exchange with Telegram integration, price prediction, and automated scalping.

## Features

- **Price Prediction**: ARIMAX models with optional sentiment analysis
- **Telegram Bot**: Button-based UI for easy trading control
- **Real-time Data**: WebSocket feeds with subscription management
- **Scalping System**: Automated trading with configurable TP/SL
- **Dry Run Mode**: Paper trading simulation without real money
- **Position Tracking**: Auto TP/SL execution and P&L monitoring
- **Multi-Account**: Support for multiple trading accounts with encrypted credentials
- **Technical Indicators**: RSI, MACD, Bollinger Bands, and more
- **Docker Support**: Easy deployment with Docker Compose

## Requirements

- Node.js >= 20.0.0
- Indodax account (for trading)
- Telegram Bot Token

## Installation

```bash
# Clone repository
git clone https://github.com/igun997/crypto-snipper.git
cd crypto-snipper

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your credentials
nano .env

# Build
npm run build
```

## Configuration

Edit `.env` file:

```env
# Telegram Bot (required)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ADMIN_IDS=your_telegram_id

# Encryption (required - change in production!)
ENCRYPTION_MASTER_KEY=your_secure_key
ENCRYPTION_SALT=your_unique_salt

# Indodax API (optional - can add via Telegram)
INDODAX_API_KEY=
INDODAX_SECRET=
```

## Usage

### CLI Mode

```bash
# Run prediction
npx crypto-snipper predict BTC/IDR

# Fetch and store price data
npx crypto-snipper fetch BTC/IDR --limit 200

# View accuracy stats
npx crypto-snipper accuracy BTC/IDR
```

### Telegram Bot Mode

```bash
# Start Telegram bot
npx crypto-snipper telegram
```

#### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show main menu |
| `/subscribe <symbol>` | Subscribe to real-time data |
| `/subs` | Show subscription menu |
| `/buy <symbol> <amount>` | Place buy order |
| `/sell <symbol> <amount>` | Place sell order |
| `/balance` | Check account balance |
| `/positions` | View open positions |
| `/price <symbol>` | Get current price |

#### Scalping Commands (Admin)

| Command | Description |
|---------|-------------|
| `/scalp_start` | Start scalp worker |
| `/scalp_stop` | Stop scalp worker |
| `/scalp_status` | View scalp status with live prices |
| `/scalp_config` | Configure TP/SL settings |

### Docker

```bash
# Build and run
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

## Architecture

```
src/
├── cli/              # CLI commands and options
├── config/           # Configuration management
├── database/         # SQLite database and repositories
├── exchange/         # Indodax exchange integration (CCXT)
├── models/           # Prediction models (ARIMAX, LSTM, Ensemble)
├── services/         # Core services
│   ├── telegram-bot.ts      # Telegram bot with UI
│   ├── scalper.ts           # Scalping signal generator
│   ├── trading-executor.ts  # Real order execution
│   ├── dry-run-executor.ts  # Paper trading simulation
│   ├── realtime-fetcher.ts  # WebSocket price feeds
│   └── position-tracker.ts  # TP/SL monitoring
└── types/            # TypeScript type definitions
```

## Subscription System

Subscribe to symbols to receive real-time data:

1. From Main Menu: Tap "Subscribe"
2. Or use command: `/subscribe BTC`

Subscribed symbols:
- Receive WebSocket price updates
- Can be used for trading and charts
- Are available for scalping

## Dry Run Mode

Test strategies without risking real money:

1. Go to Scalping > Configure
2. Enable "Dry Run" mode
3. Set virtual balance (default: Rp 10,000,000)
4. Start scalping - trades are simulated

View results in "Dry Run Stats".

## Security

- API credentials are encrypted with AES-256-GCM
- Master key and salt are configurable
- Bot access restricted to admin IDs
- Supports multiple isolated trading accounts

## License

MIT
