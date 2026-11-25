import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const FORMAT_VERSION = 'v1';

export class EncryptionKeyError extends Error {
  readonly code: 'MISSING_KEY' | 'INVALID_KEY_FORMAT' | 'DECRYPT_FAILED';

  constructor(code: 'MISSING_KEY' | 'INVALID_KEY_FORMAT' | 'DECRYPT_FAILED', message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
    this.code = code;
  }
}

export function parseEncryptionKey(rawKey?: string): Buffer {
  const trimmed = (rawKey ?? '').trim();
  if (!trimmed) {
    throw new EncryptionKeyError(
      'MISSING_KEY',
      'Brak zmiennej środowiskowej ENCRYPTION_KEY. Ustaw 32-bajtowy klucz (64 znaki hex lub 44 znaki base64) w Secrets.'
    );
  }

  // 64 hex chars -> 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Base64 decoding strictly checked for 32 bytes and canonical base64 characters
  if (/^[A-Za-z0-9+/]{43}=?$|^[A-Za-z0-9+/]{44}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 32) {
      return buf;
    }
  }

  throw new EncryptionKeyError(
    'INVALID_KEY_FORMAT',
    'Nieprawidłowy format ENCRYPTION_KEY. Wymagany jest 32-bajtowy klucz (64 znaki hex lub 44 znaki base64).'
  );
}

export function validateEncryptionKeyStatus(rawKey?: string): {
  present: boolean;
  valid: boolean;
  error?: string;
} {
  const trimmed = (rawKey ?? '').trim();
  if (!trimmed) {
    return { present: false, valid: false, error: 'Brak ustawionego ENCRYPTION_KEY.' };
  }
  try {
    parseEncryptionKey(trimmed);
    return { present: true, valid: true };
  } catch (err) {
    return {
      present: true,
      valid: false,
      error: err instanceof Error ? err.message : 'Nieprawidłowy format ENCRYPTION_KEY.',
    };
  }
}

export function encryptSecret(plaintext: string, rawKey?: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Hasło do zaszyfrowania nie może być puste.');
  }
  const key = parseEncryptionKey(rawKey ?? process.env.ENCRYPTION_KEY);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${FORMAT_VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string, rawKey?: string): string {
  const key = parseEncryptionKey(rawKey ?? process.env.ENCRYPTION_KEY);
  if (typeof payload !== 'string') {
    throw new EncryptionKeyError('DECRYPT_FAILED', 'Nieprawidłowy format zaszyfrowanego hasła.');
  }
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new EncryptionKeyError('DECRYPT_FAILED', 'Nieobsługiwany format zaszyfrowanego hasła.');
  }

  const [, ivHex, tagHex, cipherHex] = parts;
  if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(tagHex) || !/^[0-9a-f]+$/i.test(cipherHex)) {
    throw new EncryptionKeyError('DECRYPT_FAILED', 'Uszkodzone kodowanie szyfrogramu.');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new EncryptionKeyError('DECRYPT_FAILED', 'Nieprawidłowa długość IV lub authTag.');
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new EncryptionKeyError(
      'DECRYPT_FAILED',
      'Nie udało się odszyfrować hasła skrzynki — sprawdź zgodność ENCRYPTION_KEY.'
    );
  }
}

export function safeCompareSecret(provided: string | undefined | null, expected: string | undefined | null): boolean {
  if (!provided || !expected) return false;
  const providedHash = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

export function hashMessageId(messageId: string): string {
  const normalized = normalizeMessageId(messageId);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 40);
}

export function normalizeMessageId(messageId: string): string {
  return messageId.trim().replace(/^<+|>+$/g, '').toLowerCase();
}

export function sanitizeForLogs(message: string, secretsToRedact: string[] = []): string {
  let clean = String(message ?? '');

  const envSecrets = [
    process.env.ENCRYPTION_KEY,
    process.env.CRON_SECRET,
    process.env.GEMINI_API_KEY,
    ...secretsToRedact,
  ].filter((val): val is string => typeof val === 'string' && val.trim().length >= 4);

  for (const secret of envSecrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 4) {
      clean = clean.split(trimmed).join('[REDACTED]');
    }
  }

  // Redact common auth headers, password assignments, and AES ciphertext tokens
  clean = clean
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(password|pass|passwd|secret|token|apikey|api_key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+/gi, '[ENCRYPTED_SECRET]')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length > 480) {
    clean = `${clean.slice(0, 477)}...`;
  }
  return clean || 'Zdarzenie systemowe';
}
