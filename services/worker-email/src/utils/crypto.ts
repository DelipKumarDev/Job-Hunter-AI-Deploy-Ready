/**
 * ============================================================
 * AES-256-GCM token encryption for stored Gmail OAuth tokens.
 *
 * The encryption key is supplied explicitly from the secrets
 * loader — it is never read from process.env here.
 * ============================================================
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO   = 'aes-256-gcm';
const IV_LEN = 12;

/** Parse the 64-char hex ENCRYPTION_KEY into a 32-byte Buffer */
function parseKey(hexKey: string): Buffer {
  if (hexKey.length !== 64) {
    throw new Error('[crypto] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hexKey, 'hex');
}

export function encryptToken(plaintext: string, encryptionKey: string): string {
  const key = parseKey(encryptionKey);
  const iv  = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptToken(ciphertext: string, encryptionKey: string): string {
  const key = parseKey(encryptionKey);
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('[crypto] Invalid ciphertext format');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
