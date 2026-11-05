/**
 * Organizations that registered the Company Categorizer in their Deeluge
 * workspace ("registrations").
 *
 * In Deeluge an app is registered by one organization and has ONE signing
 * secret. Every workspace that installs it - the organization's own, and any
 * it shares the app with - is sent lifecycle calls, actions, widget requests
 * and webhooks signed with that secret; each install gets its own API key.
 * So: one registration here = one Deeluge app = one signing secret, with its
 * own URLs (/deeluge/r/<id>/...) so we know whose secret to check before we
 * trust anything in the body. Webhook bodies don't say which app they are for,
 * which is why the id is in the path.
 */
import { dbQuery } from '../db.js';
import { newId, sameSecret, seal, unseal } from './crypto.js';
import { REGISTRATIONS } from './schema.js';

export interface RegistrationSettings {
  /** The manifest's `key`. Must match the app already registered in Deeluge, if any. */
  app_key: string;
  app_name: string;
  description: string;
  /** Objects that get the Category column, the record actions and the panel. */
  objects: string[];
  /** Objects whose new (and re-domained) records are categorized automatically. */
  auto_objects: string[];
  categorize_on_create: boolean;
  categorize_on_domain_change: boolean;
  /** Add a Sub-category column next to Category. */
  sub_category_column: boolean;
  /** Add "Research category again" (force refresh) to the record menu. */
  recategorize_action: boolean;
  /** Overrides the service-wide APP_DEVELOPER_* defaults in this organization's manifest. */
  developer: { name: string; url: string | null; email: string | null } | null;
}

export const DEFAULT_SETTINGS: RegistrationSettings = {
  app_key: 'company-categorizer',
  app_name: 'Company Categorizer',
  description: 'Categorizes a company and provides specific information about that company.',
  objects: ['accounts', 'opportunities'],
  auto_objects: ['accounts'],
  categorize_on_create: true,
  categorize_on_domain_change: true,
  sub_category_column: false,
  recategorize_action: true,
  developer: null,
};

interface StoredSecret {
  secret: string; // enc:v1:...
  added_at: string;
  expires_at: string | null;
}

export interface Registration {
  id: string;
  name: string;
  settings: RegistrationSettings;
  deelugeAppId: string | null;
  disabled: boolean;
  hasSigningSecret: boolean;
  signingSecretAddedAt: string | null;
  lastRequestAt: string | null;
  createdAt: string;
  /** Decrypted, current first. Never leaves this process. */
  secrets: string[];
}

interface Row {
  id: string;
  name: string;
  signing_secrets: StoredSecret[] | null;
  deeluge_app_id: string | null;
  settings: Partial<RegistrationSettings> | null;
  disabled: boolean;
  last_request_at: Date | null;
  created_at: Date;
}

export class ValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'ValidationError';
  }
}

/* ------------------------------------------------------------- settings */

const OBJECT_KEY = /^[a-z0-9_]{1,64}$/;
const APP_KEY = /^[a-z][a-z0-9-]{1,47}$/;

/** Validates a (partial) settings patch on top of `base`. Unknown keys are refused. */
export function mergeSettings(base: RegistrationSettings, patch: unknown): RegistrationSettings {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError(['settings must be an object.']);
  const p = patch as Record<string, unknown>;
  const problems: string[] = [];
  const out: RegistrationSettings = { ...base };

  for (const key of Object.keys(p)) {
    if (!(key in DEFAULT_SETTINGS)) problems.push(`Unknown setting "${key.slice(0, 40)}".`);
  }
  const text = (k: 'app_name' | 'description', max: number): void => {
    if (p[k] === undefined) return;
    if (typeof p[k] !== 'string' || !(p[k] as string).trim()) problems.push(`${k} must be non-empty text.`);
    else out[k] = (p[k] as string).trim().slice(0, max);
  };
  const flag = (k: 'categorize_on_create' | 'categorize_on_domain_change' | 'sub_category_column' | 'recategorize_action'): void => {
    if (p[k] === undefined) return;
    if (typeof p[k] !== 'boolean') problems.push(`${k} must be true or false.`);
    else out[k] = p[k] as boolean;
  };
  const objects = (k: 'objects' | 'auto_objects', allowEmpty: boolean): void => {
    if (p[k] === undefined) return;
    const v = p[k];
    if (!Array.isArray(v) || v.some((o) => typeof o !== 'string' || !OBJECT_KEY.test(o)) || (!allowEmpty && v.length === 0)) {
      problems.push(`${k} must be a list of Deeluge object keys, such as ["accounts"].`);
    } else out[k] = [...new Set(v as string[])];
  };

  if (p.app_key !== undefined) {
    if (typeof p.app_key !== 'string' || !APP_KEY.test(p.app_key)) {
      problems.push('app_key must be 2-48 lowercase letters, digits and dashes, starting with a letter.');
    } else out.app_key = p.app_key;
  }
  text('app_name', 60);
  text('description', 500);
  objects('objects', false);
  objects('auto_objects', true);
  flag('categorize_on_create');
  flag('categorize_on_domain_change');
  flag('sub_category_column');
  flag('recategorize_action');
  if (p.developer !== undefined) {
    const d = p.developer as Record<string, unknown> | null;
    if (d === null) out.developer = null;
    else if (typeof d !== 'object' || typeof d.name !== 'string' || !d.name.trim()) {
      problems.push('developer must be { "name": ..., "url"?: ..., "email"?: ... } or null.');
    } else {
      const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
      if (s(d.url) && !/^https:\/\//.test(s(d.url) as string)) problems.push('developer.url must start with https://.');
      out.developer = { name: d.name.trim().slice(0, 80), url: s(d.url), email: s(d.email) };
    }
  }
  const outside = out.auto_objects.filter((o) => !out.objects.includes(o));
  if (outside.length) problems.push(`auto_objects must also be in objects (not: ${outside.join(', ')}).`);
  if (out.objects.length > 5) problems.push('At most 5 objects (Deeluge allows 10 columns per app).');

  if (problems.length) throw new ValidationError(problems);
  return out;
}

/* -------------------------------------------------------------- secrets */

export function checkSigningSecretFormat(secret: unknown): string {
  if (typeof secret !== 'string') throw new ValidationError(['signing_secret must be text.']);
  const s = secret.trim();
  const bytes = s.startsWith('whsec_') ? Buffer.from(s.slice(6), 'base64') : Buffer.alloc(0);
  if (!/^whsec_[A-Za-z0-9+/]+=*$/.test(s) || bytes.length < 16) {
    throw new ValidationError([
      "signing_secret must be the app's whsec_… signing secret (Deeluge → Settings → Developers → Apps → key icon).",
    ]);
  }
  return s;
}

/* ---------------------------------------------------------------- reads */

const CACHE_MS = 30_000;
const byId = new Map<string, { at: number; value: Registration | null }>();
let all: { at: number; value: Registration[] } | null = null;

function invalidate(id?: string): void {
  if (id) byId.delete(id);
  else byId.clear();
  all = null;
}

function toRegistration(row: Row): Registration {
  const now = Date.now();
  const live = (row.signing_secrets ?? []).filter((s) => !s.expires_at || Date.parse(s.expires_at) > now);
  const secrets: string[] = [];
  for (const s of live) {
    try {
      secrets.push(unseal(s.secret));
    } catch (err) {
      console.error(`[tenancy] registration ${row.id}: a signing secret could not be decrypted (SECRETS_ENCRYPTION_KEY changed?)`);
    }
  }
  return {
    id: row.id,
    name: row.name,
    settings: { ...DEFAULT_SETTINGS, ...(row.settings ?? {}) },
    deelugeAppId: row.deeluge_app_id,
    disabled: row.disabled,
    hasSigningSecret: secrets.length > 0,
    signingSecretAddedAt: live[0]?.added_at ?? null,
    lastRequestAt: row.last_request_at ? row.last_request_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    secrets,
  };
}

export async function getRegistration(id: string): Promise<Registration | null> {
  if (!/^reg_[A-Za-z0-9_-]{8,40}$/.test(id)) return null;
  const hit = byId.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { rows } = await dbQuery<Row>(`SELECT * FROM ${REGISTRATIONS} WHERE id = $1`, [id]);
  const value = rows[0] ? toRegistration(rows[0]) : null;
  byId.set(id, { at: Date.now(), value });
  return value;
}

export async function listRegistrations(): Promise<Registration[]> {
  if (all && Date.now() - all.at < CACHE_MS) return all.value;
  const { rows } = await dbQuery<Row>(`SELECT * FROM ${REGISTRATIONS} ORDER BY created_at`);
  const value = rows.map(toRegistration);
  all = { at: Date.now(), value };
  return value;
}

/** Public shape: everything but the secrets. */
export function describeRegistration(r: Registration): Omit<Registration, 'secrets'> {
  const { secrets: _secrets, ...rest } = r;
  return rest;
}

/* --------------------------------------------------------------- writes */

async function assertSecretUnused(secret: string, exceptId: string | null): Promise<void> {
  for (const r of await listRegistrations()) {
    if (r.id !== exceptId && r.secrets.some((s) => sameSecret(s, secret))) {
      throw new ValidationError(['This signing secret already belongs to another organization here.']);
    }
  }
}

export async function createRegistration(input: {
  name: unknown;
  settings?: unknown;
  signingSecret?: unknown;
}): Promise<Registration> {
  const problems: string[] = [];
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) problems.push('name is required: the organization\'s name.');
  let settings = DEFAULT_SETTINGS;
  try {
    settings = mergeSettings(DEFAULT_SETTINGS, input.settings);
  } catch (e) {
    if (e instanceof ValidationError) problems.push(...e.problems);
    else throw e;
  }
  let secret: string | null = null;
  if (input.signingSecret !== undefined && input.signingSecret !== null && input.signingSecret !== '') {
    try {
      secret = checkSigningSecretFormat(input.signingSecret);
    } catch (e) {
      if (e instanceof ValidationError) problems.push(...e.problems);
      else throw e;
    }
  }
  if (problems.length) throw new ValidationError(problems);
  if (secret) await assertSecretUnused(secret, null);

  const id = newId('reg');
  const secrets: StoredSecret[] = secret ? [{ secret: seal(secret), added_at: new Date().toISOString(), expires_at: null }] : [];
  await dbQuery(
    `INSERT INTO ${REGISTRATIONS} (id, name, signing_secrets, settings) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
    [id, name, JSON.stringify(secrets), JSON.stringify(settings)]
  );
  invalidate();
  return (await getRegistration(id)) as Registration;
}

export async function updateRegistration(
  id: string,
  patch: { name?: unknown; settings?: unknown; disabled?: unknown }
): Promise<Registration | null> {
  const current = await getRegistration(id);
  if (!current) return null;
  const problems: string[] = [];
  let name = current.name;
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) problems.push('name must be non-empty text.');
    else name = patch.name.trim().slice(0, 120);
  }
  let disabled = current.disabled;
  if (patch.disabled !== undefined) {
    if (typeof patch.disabled !== 'boolean') problems.push('disabled must be true or false.');
    else disabled = patch.disabled;
  }
  let settings = current.settings;
  try {
    settings = mergeSettings(current.settings, patch.settings);
  } catch (e) {
    if (e instanceof ValidationError) problems.push(...e.problems);
    else throw e;
  }
  if (problems.length) throw new ValidationError(problems);
  await dbQuery(
    `UPDATE ${REGISTRATIONS} SET name = $2, settings = $3::jsonb, disabled = $4, updated_at = now() WHERE id = $1`,
    [id, name, JSON.stringify(settings), disabled]
  );
  invalidate(id);
  return getRegistration(id);
}

/**
 * Sets the organization's signing secret. When Deeluge rolls a secret the old
 * one stops at once on their side, so the previous one is kept here only for
 * `graceMinutes` - enough to cover messages already in flight or queued for retry.
 */
export async function setSigningSecret(id: string, rawSecret: unknown, graceMinutes = 60): Promise<Registration | null> {
  const secret = checkSigningSecretFormat(rawSecret);
  const current = await getRegistration(id);
  if (!current) return null;
  await assertSecretUnused(secret, id);
  if (current.secrets[0] && sameSecret(current.secrets[0], secret)) return current;

  const { rows } = await dbQuery<Row>(`SELECT * FROM ${REGISTRATIONS} WHERE id = $1`, [id]);
  const stored = rows[0]?.signing_secrets ?? [];
  const now = new Date();
  const expires = new Date(now.getTime() + graceMinutes * 60_000).toISOString();
  const next: StoredSecret[] = [
    { secret: seal(secret), added_at: now.toISOString(), expires_at: null },
    ...stored
      .filter((s) => !s.expires_at || Date.parse(s.expires_at) > now.getTime())
      .slice(0, 2)
      .map((s) => ({ ...s, expires_at: s.expires_at ?? expires })),
  ];
  await dbQuery(`UPDATE ${REGISTRATIONS} SET signing_secrets = $2::jsonb, updated_at = now() WHERE id = $1`, [
    id,
    JSON.stringify(next),
  ]);
  invalidate(id);
  return getRegistration(id);
}

export async function deleteRegistration(id: string): Promise<boolean> {
  const { rowCount } = await dbQuery(`DELETE FROM ${REGISTRATIONS} WHERE id = $1`, [id]);
  invalidate(id);
  return (rowCount ?? 0) > 0;
}

/** Notes the Deeluge app id and when the organization last called in (at most once a minute). */
const lastTouched = new Map<string, number>();
export async function touchRegistration(r: Registration, deelugeAppId: string | null): Promise<void> {
  const learnAppId = deelugeAppId && !r.deelugeAppId;
  const t = lastTouched.get(r.id) ?? 0;
  if (!learnAppId && Date.now() - t < 60_000) return;
  lastTouched.set(r.id, Date.now());
  await dbQuery(
    `UPDATE ${REGISTRATIONS}
        SET last_request_at = now(),
            deeluge_app_id = COALESCE(deeluge_app_id, $2)
      WHERE id = $1`,
    [r.id, deelugeAppId]
  );
  if (learnAppId) invalidate(r.id);
}
