/**
 * Keys for this service's own API (POST /v1/companies/categorize and the
 * management routes), looked up in the database instead of a single key in
 * .env.
 *
 *   admin          the operator: every organization, every key
 *   organization   one organization: its own registration, its own keys,
 *                  and categorizing companies directly
 *
 * ADMIN_API_KEY in the environment always works as an admin key (it is how the
 * first organization gets created). API_KEY in the environment, if still set,
 * is accepted for /v1/companies/categorize only, so existing callers keep working.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { dbQuery } from '../db.js';
import { newApiKey, newId, sha256Hex } from './crypto.js';
import { API_KEYS } from './schema.js';

export type Role = 'admin' | 'organization' | 'legacy';

export interface Principal {
  role: Role;
  keyId: string;
  /** Set for organization keys. */
  registrationId: string | null;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  role: 'admin' | 'organization';
  registration_id: string | null;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface Row {
  id: string;
  name: string;
  role: 'admin' | 'organization';
  registration_id: string | null;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const digest = (v: string): Buffer => createHash('sha256').update(v).digest();
const matchesAny = (value: string, keys: string[]): boolean => {
  const d = digest(value);
  return keys.reduce((ok, k) => (timingSafeEqual(digest(k), d) ? true : ok), false);
};

/** The key a request presented: `Authorization: Bearer …` or `X-API-Key: …`. */
export function presentedKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  const x = headers['x-api-key'];
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim() || null;
  if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}

// A revoked key keeps working for at most this long on other instances.
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Principal | null }>();
const touched = new Map<string, number>();

export async function authenticate(key: string | null): Promise<Principal | null> {
  if (!key) return null;
  if (matchesAny(key, config.deeluge.adminKeys)) return { role: 'admin', keyId: 'env:ADMIN_API_KEY', registrationId: null };
  if (config.api.apiKeys.length && matchesAny(key, config.api.apiKeys)) {
    return { role: 'legacy', keyId: 'env:API_KEY', registrationId: null };
  }
  if (!key.startsWith('cc_live_')) return null;

  const hash = sha256Hex(key);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const { rows } = await dbQuery<Row>(
    `SELECT id, role, registration_id FROM ${API_KEYS} WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hash]
  );
  const row = rows[0];
  const value: Principal | null = row ? { role: row.role, keyId: row.id, registrationId: row.registration_id } : null;
  cache.set(hash, { at: Date.now(), value });

  if (value && Date.now() - (touched.get(value.keyId) ?? 0) > 60_000) {
    touched.set(value.keyId, Date.now());
    void dbQuery(`UPDATE ${API_KEYS} SET last_used_at = now() WHERE id = $1`, [value.keyId]).catch(() => undefined);
  }
  return value;
}

export async function createApiKey(input: {
  name: string;
  role: 'admin' | 'organization';
  registrationId: string | null;
}): Promise<{ key: string; summary: ApiKeySummary }> {
  const key = newApiKey();
  const id = newId('key', 9);
  const { rows } = await dbQuery<Row>(
    `INSERT INTO ${API_KEYS} (id, name, role, registration_id, key_hash, key_prefix)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, role, registration_id, key_prefix, created_at, last_used_at, revoked_at`,
    [id, input.name.slice(0, 120), input.role, input.registrationId, sha256Hex(key), key.slice(0, 14)]
  );
  return { key, summary: summarize(rows[0] as Row) };
}

function summarize(r: Row): ApiKeySummary {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    registration_id: r.registration_id,
    key_prefix: r.key_prefix,
    created_at: r.created_at.toISOString(),
    last_used_at: r.last_used_at ? r.last_used_at.toISOString() : null,
    revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
  };
}

export async function listApiKeys(registrationId: string | null): Promise<ApiKeySummary[]> {
  const { rows } = registrationId
    ? await dbQuery<Row>(`SELECT * FROM ${API_KEYS} WHERE registration_id = $1 ORDER BY created_at`, [registrationId])
    : await dbQuery<Row>(`SELECT * FROM ${API_KEYS} ORDER BY created_at`);
  return rows.map(summarize);
}

export async function getApiKey(id: string): Promise<ApiKeySummary | null> {
  const { rows } = await dbQuery<Row>(`SELECT * FROM ${API_KEYS} WHERE id = $1`, [id]);
  return rows[0] ? summarize(rows[0]) : null;
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `UPDATE ${API_KEYS} SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id]
  );
  cache.clear();
  return (rowCount ?? 0) > 0;
}
