import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decryptSecret,
  EncryptionKeyError,
  encryptSecret,
  parseEncryptionKey,
  safeCompareSecret,
  sanitizeForLogs,
  validateEncryptionKeyStatus,
} from './crypto';

const HEX_KEY = crypto.randomBytes(32).toString('hex');
const BASE64_KEY = crypto.randomBytes(32).toString('base64');

test('AES-256-GCM encrypt/decrypt round-trip with 64-char hex key', () => {
  const plaintext = 'SuperSecretAppPass!2026#pl';
  const enc1 = encryptSecret(plaintext, HEX_KEY);
  const enc2 = encryptSecret(plaintext, HEX_KEY);

  assert.match(enc1, /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
  assert.notEqual(enc1, enc2, 'Random IV must produce unique ciphertexts');
  assert.equal(decryptSecret(enc1, HEX_KEY), plaintext);
  assert.equal(decryptSecret(enc2, HEX_KEY), plaintext);
});

test('AES-256-GCM encrypt/decrypt round-trip with 44-char base64 key', () => {
  const plaintext = 'haslo-aplikacji-imap-993';
  const enc = encryptSecret(plaintext, BASE64_KEY);
  assert.equal(decryptSecret(enc, BASE64_KEY), plaintext);
});

test('rejects missing or invalid ENCRYPTION_KEY formats', () => {
  assert.throws(() => parseEncryptionKey(''), (err: unknown) => {
    return err instanceof EncryptionKeyError && err.code === 'MISSING_KEY';
  });

  assert.throws(() => parseEncryptionKey('too-short-key'), (err: unknown) => {
    return err instanceof EncryptionKeyError && err.code === 'INVALID_KEY_FORMAT';
  });

  // 64 chars but non-hex
  assert.throws(() => parseEncryptionKey('z'.repeat(64)), (err: unknown) => {
    return err instanceof EncryptionKeyError && err.code === 'INVALID_KEY_FORMAT';
  });

  const missingStatus = validateEncryptionKeyStatus('');
  assert.equal(missingStatus.present, false);
  assert.equal(missingStatus.valid, false);

  const validStatus = validateEncryptionKeyStatus(HEX_KEY);
  assert.equal(validStatus.present, true);
  assert.equal(validStatus.valid, true);
});

test('detects tampered ciphertext or wrong key on decrypt', () => {
  const enc = encryptSecret('my-mailbox-password', HEX_KEY);
  const parts = enc.split(':');
  // Flip last byte of authTag
  const badTag = parts[2].slice(0, -2) + (parts[2].endsWith('00') ? 'ff' : '00');
  const tampered = `${parts[0]}:${parts[1]}:${badTag}:${parts[3]}`;

  assert.throws(() => decryptSecret(tampered, HEX_KEY), (err: unknown) => {
    return err instanceof EncryptionKeyError && err.code === 'DECRYPT_FAILED';
  });

  const wrongKey = crypto.randomBytes(32).toString('hex');
  assert.throws(() => decryptSecret(enc, wrongKey), (err: unknown) => {
    return err instanceof EncryptionKeyError && err.code === 'DECRYPT_FAILED';
  });
});

test('safeCompareSecret validates matching secrets in constant time', () => {
  assert.equal(safeCompareSecret('my-cron-token-123456', 'my-cron-token-123456'), true);
  assert.equal(safeCompareSecret('my-cron-token-123456', 'different'), false);
  assert.equal(safeCompareSecret('', 'secret'), false);
  assert.equal(safeCompareSecret(undefined, 'secret'), false);
});

test('sanitizeForLogs strips passwords, bearer tokens, and ciphertext blobs', () => {
  const enc = encryptSecret('top-secret-pass', HEX_KEY);
  const raw = `Auth failed for password=top-secret-pass with Bearer eyJhbGciOiJIUzI1NiJ9.abc and payload ${enc}`;
  const clean = sanitizeForLogs(raw, ['top-secret-pass']);

  assert.equal(clean.includes('top-secret-pass'), false);
  assert.equal(clean.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.equal(clean.includes(enc), false);
  assert.equal(clean.includes('[REDACTED]'), true);
});
