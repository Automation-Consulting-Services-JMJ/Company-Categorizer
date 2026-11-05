/**
 * Checking that a request really came from Deeluge.
 *
 * Deeluge signs every lifecycle call, webhook, record action and widget request
 * the Standard Webhooks way (https://www.standardwebhooks.com):
 *
 *   webhook-id:        msg_…   (the same on every retry)
 *   webhook-timestamp: unix seconds
 *   webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<raw body>">
 *                      (several, space-separated, while a secret is being rolled)
 *
 * keyed with the bytes after `whsec_` in the app's signing secret. This replaces
 * the hand-written SHA-256 in the n8n "Verify & route" node with node:crypto.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Older (or newer) than this is refused as a replay. */
export const TOLERANCE_SECONDS = 5 * 60;

export interface SignedHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export function signedHeaders(headers: Record<string, string | string[] | undefined>): SignedHeaders {
  const one = (name: string): string | undefined => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  return { id: one('webhook-id'), timestamp: one('webhook-timestamp'), signature: one('webhook-signature') };
}

function keyOf(secret: string): Buffer | null {
  if (!secret.startsWith('whsec_')) return null;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return key.length >= 16 ? key : null;
}

export function sign(secret: string, id: string, timestamp: string | number, body: string | Buffer): string {
  const key = keyOf(secret);
  if (!key) throw new Error('Not a whsec_ signing secret.');
  const mac = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest('base64');
  return `v1,${mac}`;
}

/**
 * True when any of the given secrets produced any of the request's `v1`
 * signatures over exactly these body bytes, and the timestamp is within five
 * minutes of now. Constant-time per comparison.
 */
export function verify(
  secrets: string[],
  headers: SignedHeaders,
  rawBody: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const given = signature
    .split(' ')
    .map((part) => part.split(','))
    .filter(([version, mac]) => version === 'v1' && mac)
    .map(([, mac]) => Buffer.from(mac as string, 'base64'));
  if (given.length === 0) return false;

  let ok = false;
  for (const secret of secrets) {
    const key = keyOf(secret);
    if (!key) continue;
    const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();
    for (const mac of given) {
      if (mac.length === expected.length && timingSafeEqual(mac, expected)) ok = true;
    }
  }
  return ok;
}
