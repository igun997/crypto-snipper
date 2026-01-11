/**
 * AES-256-GCM Encryption Service
 * Used for secure storage of Indodax API credentials
 */

import crypto from 'crypto';
import { config } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;  // 128 bits
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

export interface EncryptedData {
  encrypted: string;  // Base64 encoded ciphertext + authTag
  iv: string;         // Base64 encoded IV
}

/**
 * Derive encryption key from master password using PBKDF2
 */
function deriveKey(): Buffer {
  const masterKey = config.encryption?.masterKey || 'default-change-me';
  const salt = config.encryption?.salt || 'crypto-snipper-salt';

  return crypto.pbkdf2Sync(
    masterKey,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha256'
  );
}

/**
 * Encrypt plaintext using AES-256-GCM
 */
export function encrypt(plaintext: string): EncryptedData {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Combine encrypted data and auth tag
  const combined = Buffer.concat([
    Buffer.from(encrypted, 'base64'),
    authTag
  ]);

  return {
    encrypted: combined.toString('base64'),
    iv: iv.toString('base64')
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM
 */
export function decrypt(encryptedData: EncryptedData): string {
  const key = deriveKey();
  const iv = Buffer.from(encryptedData.iv, 'base64');
  const combined = Buffer.from(encryptedData.encrypted, 'base64');

  // Split encrypted data and auth tag
  const encrypted = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Encrypt API credentials
 */
export function encryptCredentials(apiKey: string, apiSecret: string): {
  apiKeyEncrypted: EncryptedData;
  apiSecretEncrypted: EncryptedData;
} {
  return {
    apiKeyEncrypted: encrypt(apiKey),
    apiSecretEncrypted: encrypt(apiSecret)
  };
}

/**
 * Decrypt API credentials
 */
export function decryptCredentials(
  apiKeyEncrypted: EncryptedData,
  apiSecretEncrypted: EncryptedData
): { apiKey: string; apiSecret: string } {
  return {
    apiKey: decrypt(apiKeyEncrypted),
    apiSecret: decrypt(apiSecretEncrypted)
  };
}

/**
 * Verify encryption is working (self-test)
 */
export function verifyEncryption(): boolean {
  try {
    const testString = 'test-encryption-verify';
    const encrypted = encrypt(testString);
    const decrypted = decrypt(encrypted);
    return decrypted === testString;
  } catch {
    return false;
  }
}

export default {
  encrypt,
  decrypt,
  encryptCredentials,
  decryptCredentials,
  verifyEncryption
};
