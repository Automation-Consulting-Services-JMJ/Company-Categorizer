/**
 * Calls back into a workspace's Deeluge API (/api/v1) with the key it gave us,
 * plus the small helpers for reading a Deeluge record: which columns are ours,
 * and what the company's domain and name are.
 */
import { normalizeDomain } from '../domain.js';
import type { FieldMap, Installation } from '../tenancy/installations.js';

export interface DeelugeRecord {
  id: string;
  object: string;
  title?: string | null;
  values: Record<string, unknown>;
}

export class DeelugeApiError extends Error {
  constructor(
    readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = 'DeelugeApiError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One request. `retries` > 0 retries 429/5xx/network errors with backoff
 * (honouring Retry-After) - used by background work, never by the widget,
 * which has three seconds in total.
 */
async function call<T>(
  install: Installation,
  method: 'GET' | 'PATCH',
  path: string,
  opts: { body?: unknown; timeoutMs: number; retries?: number }
): Promise<T> {
  const retries = opts.retries ?? 0;
  const url = `${install.apiBaseUrl}${path}`;
  for (let attempt = 0; ; attempt++) {
    let status: number | null = null;
    let message: string;
    let retryAfterMs: number | null = null;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${install.apiKey}`,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      status = res.status;
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      message = `Deeluge ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`;
      const ra = res.headers.get('retry-after');
      if (ra && /^\d+$/.test(ra)) retryAfterMs = Number(ra) * 1000;
    } catch (err) {
      message = `Deeluge ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const transient = status === null || status === 429 || status >= 500;
    if (!transient || attempt >= retries) throw new DeelugeApiError(status, message);
    const backoff = retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
    await sleep(backoff);
  }
}

export async function getRecord(
  install: Installation,
  recordId: string,
  opts: { timeoutMs: number; retries?: number }
): Promise<DeelugeRecord> {
  const res = await call<{ data: DeelugeRecord }>(install, 'GET', `/records/${encodeURIComponent(recordId)}`, opts);
  return { ...res.data, values: res.data.values ?? {} };
}

export async function patchRecord(
  install: Installation,
  recordId: string,
  values: Record<string, unknown>,
  opts: { timeoutMs: number; retries?: number }
): Promise<void> {
  await call(install, 'PATCH', `/records/${encodeURIComponent(recordId)}`, { ...opts, body: { values } });
}

/* ------------------------------------------------------------- columns */

export interface Columns {
  category: string | null;
  subCategory: string | null;
  note: string | null;
}

type Role = keyof Columns;

/** Which of our results a manifest field holds, from the app's own key for it. */
function roleOf(fieldKey: string): Role | null {
  const k = fieldKey.toLowerCase();
  if (/sub_?categor/.test(k)) return 'subCategory';
  if (/(^|_)(note|notes|reason|summary|rationale)$/.test(k)) return 'note';
  if (/categor|industry|sector|classification/.test(k)) return 'category';
  return null;
}

/**
 * The workspace's attribute keys for our columns on this record's object.
 * Mirrors the n8n "column" lookup, but also understands an optional
 * sub-category and note column. A single unrecognised field on the object is
 * treated as the category column, so an existing manifest keeps working.
 */
export function columnsFor(fields: FieldMap, object: string): Columns {
  const cols: Columns = { category: null, subCategory: null, note: null };
  const onObject = Object.entries(fields ?? {}).filter(([, f]) => f && f.object === object && f.attribute_key);
  const unassigned: string[] = [];
  for (const [key, f] of onObject) {
    const role = roleOf(key);
    if (role && !cols[role]) cols[role] = f.attribute_key;
    else unassigned.push(f.attribute_key);
  }
  if (!cols.category && unassigned[0]) cols.category = unassigned[0];
  return cols;
}

export const hasAnyColumn = (c: Columns): boolean => Boolean(c.category || c.subCategory || c.note);

/* ------------------------------------------------------- company facts */

/** Attribute keys that may hold a company's web address, most specific first. */
export const DOMAIN_KEYS = ['domains', 'domain', 'website', 'url', 'company_domain', 'company_website'];

function textOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['value', 'domain', 'url', 'href', 'name', 'label']) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
    }
  }
  return null;
}

/**
 * The record's company domain, normalised ("https://www.Acme.com/x" -> "acme.com"),
 * or null. Unlike the n8n workflow this never falls back to a placeholder
 * domain: a record without one is left alone.
 */
export function domainOf(record: { values: Record<string, unknown> }): string | null {
  for (const key of DOMAIN_KEYS) {
    const raw = record.values[key];
    const candidates = Array.isArray(raw) ? raw : [raw];
    for (const c of candidates) {
      const text = textOf(c);
      const domain = text ? normalizeDomain(text) : null;
      if (domain) return domain;
    }
  }
  return null;
}

/** Attribute keys that may point at the record's company (an opportunity's account). */
export const COMPANY_LINK_KEYS = ['account', 'company', 'accounts', 'companies'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id of the company record this record points at (e.g. an opportunity's account), if any. */
export function linkedCompanyId(record: { values: Record<string, unknown> }): string | null {
  for (const key of COMPANY_LINK_KEYS) {
    const raw = record.values[key];
    for (const c of Array.isArray(raw) ? raw : [raw]) {
      const id = typeof c === 'string' ? c : textOf(c) ?? (c && typeof c === 'object' ? textOf((c as Record<string, unknown>).id) : null);
      if (id && UUID.test(id)) return id;
    }
  }
  return null;
}

export function nameOf(record: { title?: string | null; values: Record<string, unknown> }): string | null {
  const v = textOf(record.values.name) ?? textOf(record.values.company_name) ?? textOf(record.title ?? null);
  return v ? v.slice(0, 200) : null;
}

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
}
