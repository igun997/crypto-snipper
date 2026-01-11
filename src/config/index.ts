import { config as dotenvConfig } from 'dotenv';
import { Config } from '../types/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });

export const config: Config = {
  dbPath: process.env.DB_PATH || './data/crypto-snipper.db',
  logLevel: process.env.LOG_LEVEL || 'info',
  defaultInterval: parseInt(process.env.DEFAULT_INTERVAL || '15', 10),
  indodax: {
    apiKey: process.env.INDODAX_API_KEY,
    secret: process.env.INDODAX_SECRET,
  },
  twitter: {
    bearerToken: process.env.TWITTER_BEARER_TOKEN,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    adminIds: process.env.TELEGRAM_ADMIN_IDS?.split(',').map(id => id.trim()) || [],
  },
  encryption: {
    masterKey: process.env.ENCRYPTION_MASTER_KEY,
    salt: process.env.ENCRYPTION_SALT,
  },
};

export default config;
