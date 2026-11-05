/**
 * Secrets at rest, and the categorizer's own API keys.
 *
 * - Signing secrets and workspace API keys must be read back (to compute an
 *   HMAC, to call Deeluge), so they are encrypted with AES-256-GCM under
 *   SECRETS_ENCRYPTION_KEY rather than hashed.
 * - The categorizer's own API keys never need reading back, so only their
 *   SHA-256 is stored, like a password.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'enc:v1:';

function key(): Buffer {
  const raw = config.deeluge.encryptionKey;
  if (!raw) throw new Error('SECRETS_ENCRYPTION_KEY is not set.');
  return createHash('sha256').update(raw).digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

export function unseal(stored: string): string {
  if (!stored.startsWith(PREFIX)) throw new Error('Stored secret is not in the enc:v1 format.');
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** URL-safe random id with a readable prefix, e.g. "reg_3kq9…". */
export const newId = (prefix: string, bytes = 12): string => `${prefix}_${randomBytes(bytes).toString('base64url')}`;

/** A categorizer API key: shown once, stored as a hash. */
export const newApiKey = (): string => `cc_live_${randomBytes(24).toString('base64url')}`;
