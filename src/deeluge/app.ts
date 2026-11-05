/**
 * The categorizer as a Deeluge app, for any number of organizations.
 *
 * Request flow:
 *
 *   POST /deeluge/r/<registration id>/<anything>
 *     1. look the registration (organization) up            -> 404 / 403
 *     2. check the Standard Webhooks signature against THAT
 *        organization's signing secret(s) from the database   -> 401
 *     3. dispatch on the message `type`:
 *          app.installed / app.updated / app.uninstalled  -> that workspace's key, kept per
 *                                                            (registration, workspace)
 *          record_action.invoked                         -> categorize, write back
 *          record.created / record.updated               -> categorize in the background
 *          record_widget.requested                       -> the "Company category" panel
 *
 *   POST /deeluge or /deeluge/<anything> without a registration id is still
 *   accepted: the signature is checked against every active organization's
 *   secret and the one that matches is used.
 *
 * A workspace that installs an app another organization shared with it sends
 * to that organization's URLs, signed with that organization's secret, and
 * gets its own installation row with its own API key.
 */
import { findCompaniesByDomains, type CompanyRecord } from '../db.js';
import { config } from '../config.js';
import { researchCompanies, type ResearchResult } from '../research.js';
import {
  deleteInstallation,
  getInstallation,
  recordUsage,
  saveInstallation,
  updateFields,
  type FieldMap,
  type Installation,
} from '../tenancy/installations.js';
import {
  getRegistration,
  listRegistrations,
  touchRegistration,
  type Registration,
} from '../tenancy/registrations.js';
import {
  columnsFor,
  DOMAIN_KEYS,
  domainOf,
  getRecord,
  hasAnyColumn,
  isEmptyValue,
  linkedCompanyId,
  nameOf,
  patchRecord,
  type Columns,
  type DeelugeRecord,
} from './client.js';
import { signedHeaders, verify } from './signature.js';

export interface DeelugeResponse {
  status: number;
  body?: unknown;
}

const log = (...args: unknown[]): void => console.log('[deeluge]', ...args);
const warn = (...args: unknown[]): void => console.warn('[deeluge]', ...args);

type Msg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** /deeluge/r/<id>/... -> the registration id, or null for the unscoped address. */
export function registrationIdFromPath(path: string): string | null {
  const m = path.match(/^\/deeluge\/r\/([A-Za-z0-9_-]+)(\/|$)/);
  return m ? (m[1] as string) : null;
}

/* ======================================================================= */
/* Finding the company behind a record                                     */
/* ======================================================================= */

interface Company {
  domain: string | null;
  name: string | null;
}

/**
 * The record's own domain, or - for an opportunity and the like - the domain
 * of the account it points at (needs records:read on that object, which the
 * default manifest asks for).
 */
async function companyOf(install: Installation, record: DeelugeRecord, timeoutMs: number, retries: number): Promise<Company> {
  const own = domainOf(record);
  if (own) return { domain: own, name: nameOf(record) };
  const linked = linkedCompanyId(record);
  if (!linked || linked === record.id) return { domain: null, name: nameOf(record) };
  try {
    const account = await getRecord(install, linked, { timeoutMs, retries });
    return { domain: domainOf(account), name: nameOf(account) ?? nameOf(record) };
  } catch {
    return { domain: null, name: nameOf(record) };
  }
}

/* ======================================================================= */
/* Background work                                                         */
/* ======================================================================= */

type Outcome =
  | { kind: 'written'; domain: string; category: string | null; subCategory: string | null; source: 'cache' | 'fresh' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'no_domain' }
  | { kind: 'no_column' }
  | { kind: 'failed'; error: string };

interface Job {
  install: Installation;
  recordId: string;
  object: string;
  /** The record as the event carried it; fetched when absent. */
  record?: DeelugeRecord;
  force: boolean;
  /** Leave a category column that already has a value alone (automatic runs). */
  onlyIfEmpty: boolean;
  why: string;
}

// One pool for the whole service, so one organization's 1,000-record batch
// can't start unlimited scrapes; the providers' rate limiters apply on top.
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= config.deeluge.concurrency) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/** One run per record at a time; a second request for the same record shares it. */
const jobs = new Map<string, Promise<Outcome>>();
const jobKey = (i: Installation, recordId: string): string => `${i.registrationId}|${i.workspaceId}|${recordId}`;

export function deelugeJobsInFlight(): number {
  return jobs.size;
}

export async function waitForDeelugeIdle(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (jobs.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

function enqueue(job: Job): Promise<Outcome> {
  const key = jobKey(job.install, job.recordId);
  const running = jobs.get(key);
  if (running) return running;
  const promise = withSlot(() => runJob(job))
    .catch((err: unknown): Outcome => {
      const error = err instanceof Error ? err.message : String(err);
      warn(`${job.install.registrationId}/${job.install.workspaceId} record ${job.recordId}: ${error}`);
      return { kind: 'failed', error };
    })
    .finally(() => jobs.delete(key));
  jobs.set(key, promise);
  return promise;
}

async function runJob(job: Job): Promise<Outcome> {
  const { install } = job;
  const cols = columnsFor(install.fields, job.object);
  if (!hasAnyColumn(cols)) return { kind: 'no_column' };

  const record = job.record ?? (await getRecord(install, job.recordId, { timeoutMs: 15_000, retries: 3 }));
  if (job.onlyIfEmpty && cols.category && !isEmptyValue(record.values[cols.category])) {
    return { kind: 'skipped', reason: 'already categorized' };
  }
  const { domain, name } = await companyOf(install, record, 15_000, 3);
  if (!domain) return { kind: 'no_domain' };

  const tag = `${install.registrationId}/${install.workspaceId} record ${job.recordId} (${domain})`;
  log(`${tag}: categorizing - ${job.why}${job.force ? ', forced' : ''}`);
  let result = (await researchCompanies([{ domain, name }], { forceRefresh: job.force }))[0] as ResearchResult;
  // Someone else (the batch job, another instance) was mid-way through this
  // domain and didn't finish within API_WAIT_FOR_INFLIGHT_MS: ask once more.
  if (result.status === 'in_progress') result = (await researchCompanies([{ domain, name }]))[0] as ResearchResult;
  if (result.status !== 'ok') return { kind: 'failed', error: 'error' in result ? result.error : 'Unknown error' };

  const values: Record<string, unknown> = {};
  if (cols.category && result.category) values[cols.category] = result.category.slice(0, 2000);
  if (cols.subCategory) values[cols.subCategory] = result.sub_category ? result.sub_category.slice(0, 2000) : null;
  if (cols.note) values[cols.note] = result.note ? result.note.slice(0, 5000) : null;
  if (Object.keys(values).length === 0) return { kind: 'failed', error: 'The categorizer found no category for this company.' };

  await patchRecord(install, job.recordId, values, { timeoutMs: 15_000, retries: 3 });
  await recordUsage(install.registrationId, install.workspaceId).catch(() => undefined);
  log(`${tag}: wrote ${result.category ?? '-'} (${result.source})`);
  return { kind: 'written', domain, category: result.category, subCategory: result.sub_category, source: result.source };
}

function describe(o: Outcome): string {
  switch (o.kind) {
    case 'written':
      return `Categorized ${o.domain} as ${o.category ?? 'uncategorized'}${o.subCategory ? ` (${o.subCategory})` : ''}.`;
    case 'skipped':
      return `Left as it is: ${o.reason}.`;
    case 'no_domain':
      return 'No domain or website on this record (or on its account), so there is nothing to look up. Add one and try again.';
    case 'no_column':
      return "This object has no Category column from the app. Accept the app's latest update in Settings -> Apps.";
    case 'failed':
      return `Could not categorize this company: ${o.error.slice(0, 300)}`;
  }
}

/** The outcome if the job finishes within `ms`, otherwise null (it keeps running). */
async function within(promise: Promise<Outcome>, ms: number): Promise<Outcome | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* ======================================================================= */
/* Installations                                                           */
/* ======================================================================= */

function isFieldMap(v: unknown): v is FieldMap {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** This workspace's installation of this organization's app, with the freshest column mapping. */
async function installationFor(reg: Registration, msg: Msg): Promise<Installation | null> {
  const ws = String(msg.workspace_id ?? '');
  if (!ws) return null;
  const stored = await getInstallation(reg.id, ws);
  if (!stored) return null;
  if (isFieldMap(msg.fields)) {
    await updateFields(reg.id, ws, msg.fields).catch((e) => warn(`could not refresh columns for ${reg.id}/${ws}:`, e));
    return { ...stored, fields: msg.fields };
  }
  return stored;
}

const NO_KEY_MESSAGE =
  "The categorizer doesn't have this workspace's API key yet. Uninstall the app and install it again " +
  '(the key is handed over on install), or ask the categorizer\'s operator to add it.';

async function lifecycle(reg: Registration, msg: Msg): Promise<DeelugeResponse> {
  const ws = String(msg.workspace_id ?? '');
  if (!ws) return { status: 400, body: { error: 'workspace_id missing' } };

  if (msg.type === 'app.installed') {
    const apiBaseUrl = String(msg.api_base_url ?? '').replace(/\/+$/, '');
    if (typeof msg.api_key !== 'string' || !msg.api_key) return { status: 400, body: { error: 'app.installed carried no api_key' } };
    if (!/^https?:\/\//.test(apiBaseUrl)) {
      // A non-2xx answer cancels another workspace's install, instead of
      // leaving it with an app that can never write back.
      return { status: 500, body: { error: 'app.installed carried no api_base_url (APP_URL is not set on that Deeluge).' } };
    }
    await saveInstallation({
      registrationId: reg.id,
      workspaceId: ws,
      workspaceName: typeof msg.workspace?.name === 'string' ? msg.workspace.name : null,
      installationId: typeof msg.app?.installation_id === 'string' ? msg.app.installation_id : null,
      apiKey: msg.api_key,
      apiBaseUrl,
      fields: isFieldMap(msg.fields) ? msg.fields : {},
    });
    log(`${reg.name} (${reg.id}): installed in workspace ${ws}${msg.workspace?.name ? ` (${msg.workspace.name})` : ''}`);
    return { status: 200, body: { ok: true } };
  }
  if (msg.type === 'app.updated') {
    if (isFieldMap(msg.fields)) await updateFields(reg.id, ws, msg.fields);
    return { status: 200, body: { ok: true } };
  }
  await deleteInstallation(reg.id, ws); // app.uninstalled: the key is already revoked on Deeluge's side
  log(`${reg.name} (${reg.id}): uninstalled from workspace ${ws}`);
  return { status: 200, body: { ok: true } };
}

/* ======================================================================= */
/* Record actions and webhooks                                             */
/* ======================================================================= */

async function recordAction(reg: Registration, msg: Msg, path: string): Promise<DeelugeResponse> {
  const install = await installationFor(reg, msg);
  if (!install) return { status: 200, body: { message: NO_KEY_MESSAGE } };
  const recordId = String(msg.record?.id ?? '');
  const object = String(msg.record?.object ?? '');
  if (!recordId || !object) return { status: 400, body: { error: 'record missing' } };

  const actionKey = String(msg.action?.key ?? '');
  const force = actionKey === 'recategorize' || /\/recategorize\/?$/.test(path);
  const promise = enqueue({
    install,
    recordId,
    object,
    force,
    onlyIfEmpty: false,
    why: `"${msg.action?.label ?? actionKey}" by ${msg.user?.name ?? 'someone'}`,
  });

  // Run on many records at once: answer straight away, Deeluge sends the rest.
  if (msg.batch) return { status: 200, body: { message: 'Queued for categorizing.' } };

  // One record: a stored result usually comes back in well under a second, so
  // wait a little and say what happened; otherwise finish in the background.
  const outcome = await within(promise, 5_000);
  if (outcome) return { status: 200, body: { message: describe(outcome) } };
  return { status: 200, body: { message: 'Categorizing. The Category column fills in shortly - usually within a minute.' } };
}

async function recordEvent(reg: Registration, msg: Msg): Promise<DeelugeResponse> {
  const ok = { status: 200, body: { ok: true } };
  const record = msg.data?.record as DeelugeRecord | undefined;
  const s = reg.settings;
  if (!record?.id || !record.object || !s.auto_objects.includes(record.object)) return ok;

  if (msg.type === 'record.created' && !s.categorize_on_create) return ok;
  if (msg.type === 'record.updated') {
    const changed: unknown[] = Array.isArray(msg.data?.changed_attributes) ? msg.data.changed_attributes : [];
    if (!s.categorize_on_domain_change || !changed.some((k) => DOMAIN_KEYS.includes(String(k)))) return ok;
  }

  const install = await installationFor(reg, msg);
  if (!install) {
    warn(`${reg.id}: ${msg.type} for workspace ${msg.workspace_id}, which has no stored key`);
    return ok;
  }
  if (!hasAnyColumn(columnsFor(install.fields, record.object))) return ok;

  // Answer within Deeluge's ten seconds; the work carries on in the background.
  void enqueue({
    install,
    recordId: record.id,
    object: record.object,
    record: { ...record, values: record.values ?? {} },
    force: false,
    // A new record: never overwrite a category someone typed in. A changed
    // domain: the old category belonged to the old domain, so replace it.
    onlyIfEmpty: msg.type === 'record.created',
    why: msg.type,
  });
  return ok;
}

/* ======================================================================= */
/* The "Company category" panel                                            */
/* ======================================================================= */

type Block = Record<string, unknown>;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function timeoutAfter<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, ms)))]);
}

async function widget(reg: Registration, msg: Msg): Promise<DeelugeResponse> {
  // Deeluge allows three seconds; keep a margin for the network.
  const deadline = Date.now() + 2_600;
  const left = (): number => deadline - Date.now();

  const install = await installationFor(reg, msg);
  if (!install) {
    return { status: 200, body: { title: 'Company category', blocks: [{ type: 'text', text: NO_KEY_MESSAGE, tone: 'caution' }], cache_seconds: 30 } };
  }
  const recordId = String(msg.record?.id ?? '');
  const object = String(msg.record?.object ?? '');
  const cols: Columns = columnsFor(install.fields, object);
  if (!recordId || !hasAnyColumn(cols)) return { status: 204 };

  let message: string | undefined;
  const pressed = typeof msg.action === 'string' ? msg.action : null;
  if (pressed === 'categorize' || pressed === 'recategorize') {
    const job = enqueue({
      install,
      recordId,
      object,
      force: pressed === 'recategorize',
      onlyIfEmpty: false,
      why: `panel button by ${msg.user?.name ?? 'someone'}`,
    });
    const outcome = await within(job, 1_200);
    message = outcome ? describe(outcome) : 'Categorizing. This panel updates when it is done.';
  }

  const record = await timeoutAfter(getRecord(install, recordId, { timeoutMs: Math.max(300, left() - 900) }), left() - 800);
  const company = record ? await timeoutAfter(companyOf(install, record, Math.max(200, left() - 500), 0), left() - 400) : null;
  const domain = company?.domain ?? null;
  let stored: CompanyRecord | null = null;
  if (domain && left() > 150) stored = (await timeoutAfter(findCompaniesByDomains([domain]), left() - 100))?.get(domain) ?? null;

  const fromColumn = (key: string | null): string | null => {
    if (!record || !key) return null;
    const v = record.values[key];
    return isEmptyValue(v) ? null : Array.isArray(v) ? v.join(', ') : String(v);
  };
  const meta = stored?.metadata ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const category = fromColumn(cols.category) ?? str(meta.category);
  const subCategory = fromColumn(cols.subCategory) ?? str(meta.sub_category);
  const note = fromColumn(cols.note) ?? str(meta.note);
  const working = jobs.has(jobKey(install, recordId));

  const blocks: Block[] = [];
  if (working) blocks.push({ type: 'badge', label: 'Categorizing…', tone: 'caution' });

  if (!record) {
    blocks.push({ type: 'text', text: "Couldn't reach this workspace's records just now. Refresh to try again.", tone: 'caution' });
  } else if (category) {
    blocks.push({ type: 'badge', label: clip(category, 40), tone: /target/i.test(category) ? 'positive' : 'accent' });
    const items: Array<{ label: string; value: string }> = [];
    if (category.length > 40) items.push({ label: 'Category', value: clip(category, 200) });
    if (subCategory) items.push({ label: 'Sub-category', value: clip(subCategory, 200) });
    if (domain) items.push({ label: 'Domain', value: domain });
    const src = meta.classification_source === 'name_screen' ? 'Name and domain' : meta.classification_source === 'scrape' ? 'Website' : null;
    if (src) items.push({ label: 'Decided from', value: src });
    if (stored?.checkedAt) items.push({ label: 'Checked', value: stored.checkedAt.toISOString().slice(0, 10) });
    if (items.length) blocks.push({ type: 'fields', items });
    if (note) blocks.push({ type: 'text', text: clip(note, 1000) });
    if (cols.category && !fromColumn(cols.category)) {
      blocks.push({ type: 'text', text: 'Known to the categorizer but not saved on this record yet.', tone: 'neutral' });
      blocks.push({ type: 'action', label: 'Save to record', action: 'categorize', style: 'primary' });
    }
    if (!working && reg.settings.recategorize_action) {
      blocks.push({
        type: 'action',
        label: 'Research again',
        action: 'recategorize',
        style: 'secondary',
        confirm: 'Research this company again? This re-scrapes its website and spends model credits.',
      });
    }
  } else if (!domain) {
    blocks.push({ type: 'text', text: 'Add a domain or website to this record (or link it to an account that has one) to categorize it.' });
  } else if (!working) {
    blocks.push({ type: 'text', text: 'Not categorized yet.' });
    blocks.push({ type: 'action', label: 'Categorize now', action: 'categorize', style: 'primary' });
  }

  return {
    status: 200,
    body: { title: 'Company category', blocks, cache_seconds: working ? 10 : 120, ...(message ? { message } : {}) },
  };
}

/* ======================================================================= */
/* Entry point                                                             */
/* ======================================================================= */

// webhook-id is the same on every retry: remember recent ones so a retried
// record.created doesn't queue the same company twice.
const SEEN_MS = 15 * 60_000;
const seen = new Map<string, number>();
function firstTime(id: string): boolean {
  const now = Date.now();
  if (seen.size > 10_000) for (const [k, t] of seen) if (now - t > SEEN_MS) seen.delete(k);
  const t = seen.get(id);
  if (t && now - t < SEEN_MS) return false;
  seen.set(id, now);
  return true;
}

/** Which organization signed this request, or why none did. */
async function authenticateRequest(
  path: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer
): Promise<{ reg: Registration } | { response: DeelugeResponse }> {
  const signed = signedHeaders(headers);
  const id = registrationIdFromPath(path);

  if (id) {
    const reg = await getRegistration(id);
    if (!reg) return { response: { status: 404, body: { error: 'Unknown registration. Check the URLs in the app manifest.' } } };
    if (reg.disabled) return { response: { status: 403, body: { error: 'This organization is disabled on the categorizer.' } } };
    if (!reg.hasSigningSecret) {
      return { response: { status: 401, body: { error: "The organization's signing secret has not been given to the categorizer yet." } } };
    }
    return verify(reg.secrets, signed, rawBody) ? { reg } : { response: { status: 401, body: { error: 'Bad signature' } } };
  }

  // The unscoped address: whichever active organization's secret signed it.
  for (const reg of await listRegistrations()) {
    if (!reg.disabled && reg.secrets.length && verify(reg.secrets, signed, rawBody)) return { reg };
  }
  return { response: { status: 401, body: { error: 'Bad signature' } } };
}

export async function handleDeelugeRequest(
  path: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer
): Promise<DeelugeResponse> {
  const auth = await authenticateRequest(path, headers, rawBody);
  if ('response' in auth) return auth.response;
  const { reg } = auth;

  let msg: Msg;
  try {
    msg = JSON.parse(rawBody.toString('utf8')) as Msg;
  } catch {
    return { status: 400, body: { error: 'Body is not JSON' } };
  }
  void touchRegistration(reg, typeof msg.app?.id === 'string' ? msg.app.id : null).catch(() => undefined);

  switch (String(msg.type ?? '')) {
    case 'app.installed':
    case 'app.updated':
    case 'app.uninstalled':
      return lifecycle(reg, msg);
    case 'record_action.invoked':
      return recordAction(reg, msg, path);
    case 'record_widget.requested':
      return widget(reg, msg);
    case 'record.created':
    case 'record.updated': {
      const wid = signedHeaders(headers).id;
      if (wid && !firstTime(`${reg.id}|${wid}`)) return { status: 200, body: { ok: true, duplicate: true } };
      return recordEvent(reg, msg);
    }
    default:
      return { status: 200, body: { ok: true } }; // webhook.test and anything newer
  }
}
