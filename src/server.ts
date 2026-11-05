/**
 * HTTP entrypoint. Run it instead of index.ts:
 *
 *   npm run dev:server           (TypeScript source)
 *   npm run build && npm run serve
 *
 * POST /v1/companies/categorize
 *   { "domain": "acme.com", "name": "Acme Inc" }                 one company
 *   { "companies": [ { "domain": ..., "name": ... }, "b.com" ] } several
 *   [ { "domain": ... }, "b.com" ]                                several
 * Add "force_refresh": true to ignore stored results.
 *
 * GET /health   (no auth) liveness probe.
 *
 * Deeluge app, for any number of organizations (see src/deeluge/, src/tenancy/):
 *   POST /deeluge/r/<registration id>/*   lifecycle, webhooks, record actions, widget -
 *                                         checked against THAT organization's signing
 *                                         secret and dispatched on the message's `type`
 *   GET  /deeluge/r/<id>/manifest.json    that organization's manifest (public)
 *   /v1/registrations, /v1/api-keys, /v1/me   the management API (src/tenancy/management.ts)
 *   GET  /setup                           a small page for the management API
 *
 * Every key is looked up in the database (categorizer_api_keys); ADMIN_API_KEY
 * and the old API_KEY from the environment are also accepted.
 *
 * See README.md, "HTTP API", for the response format.
 */
import http from 'node:http';
import { config, validateApiConfig, validateConfig } from './config.js';
import { assertConnection, assertScrapeColumns, closePool, enableTransportRecovery } from './db.js';
import { normalizeDomain } from './domain.js';
import { inflightCount, researchCompanies, waitForIdle } from './research.js';
import type { ResearchInput, ResearchResult } from './research.js';
import { closeScrapers } from './scraper.js';
import { closeLlm } from './llm.js';
import { deelugeJobsInFlight, handleDeelugeRequest, waitForDeelugeIdle } from './deeluge/app.js';
import { buildManifest } from './deeluge/manifest.js';
import { authenticate, presentedKey } from './tenancy/apiKeys.js';
import { ApiError, handleManagement, isManagementPath } from './tenancy/management.js';
import { getRegistration } from './tenancy/registrations.js';
import { ensureTenancyTables } from './tenancy/schema.js';
import { SETUP_PAGE } from './tenancy/setupPage.js';

const ROUTE = '/v1/companies/categorize';
const MAX_NAME_LENGTH = 200;
const MAX_DOMAIN_INPUT_LENGTH = 2048;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Per-item validation failure. Never touches the database or a provider. */
interface InvalidResult {
  domain: string | null;
  name: string | null;
  status: 'error';
  error_code: 'invalid_domain';
  error: string;
}
type ItemResult = ResearchResult | InvalidResult;

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Request parsing                                                     */
/* ------------------------------------------------------------------ */

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes.`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return; // over the limit: discard the rest
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface ParsedRequest {
  items: unknown[];
  /** True when the caller sent one company rather than a list. */
  single: boolean;
  forceRefresh: boolean;
}

function parseRequest(body: unknown): ParsedRequest {
  if (Array.isArray(body)) return { items: body, single: false, forceRefresh: false };
  if (!isObject(body)) {
    throw new HttpError(400, 'invalid_body', 'Body must be a company object, or a list of companies.');
  }

  const force = body.force_refresh;
  if (force !== undefined && typeof force !== 'boolean') {
    throw new HttpError(400, 'invalid_body', '"force_refresh" must be true or false.');
  }
  const forceRefresh = force === true;

  if ('companies' in body) {
    if (!Array.isArray(body.companies)) {
      throw new HttpError(400, 'invalid_body', '"companies" must be an array.');
    }
    return { items: body.companies, single: false, forceRefresh };
  }
  return { items: [body], single: true, forceRefresh };
}

/** A parsed item is either researchable, or already known to be invalid. */
type Slot = { ok: true; input: ResearchInput } | { ok: false; result: InvalidResult };

function toSlot(raw: unknown): Slot {
  const invalid = (domain: string | null, name: string | null, error: string): Slot => ({
    ok: false,
    result: { domain, name, status: 'error', error_code: 'invalid_domain', error },
  });

  let domainRaw: unknown;
  let nameRaw: unknown;
  if (typeof raw === 'string') {
    domainRaw = raw;
  } else if (isObject(raw)) {
    domainRaw = raw.domain ?? raw.website ?? raw.url;
    nameRaw = raw.name;
  } else {
    return invalid(null, null, 'Each company must be an object with a "domain", or a domain string.');
  }

  const name =
    typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim().slice(0, MAX_NAME_LENGTH) : null;

  if (typeof domainRaw !== 'string' || !domainRaw.trim()) {
    return invalid(null, name, 'Missing "domain".');
  }
  if (domainRaw.length > MAX_DOMAIN_INPUT_LENGTH) {
    return invalid(null, name, '"domain" is too long.');
  }
  const domain = normalizeDomain(domainRaw);
  if (!domain) {
    return invalid(domainRaw.slice(0, 200), name, `"${domainRaw.slice(0, 200)}" is not a valid domain.`);
  }
  return { ok: true, input: { domain, name } };
}

/* ------------------------------------------------------------------ */
/* Response                                                            */
/* ------------------------------------------------------------------ */

function send(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Results change as companies are re-researched; never let a proxy hold one.
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, err: HttpError): void {
  send(
    res,
    err.status,
    { error: { code: err.code, message: err.message } },
    // A 413 is sent while the client may still be uploading; don't reuse the connection.
    err.status === 413 ? { Connection: 'close' } : {}
  );
}

/** HTTP status for a single-company request, from that company's result. */
function statusFor(result: ItemResult): number {
  if (result.status === 'ok') return 200;
  if (result.status === 'in_progress') return 202;
  switch (result.error_code) {
    case 'invalid_domain':
      return 400;
    case 'processing_failed':
      return 502; // the scrape or the model failed - not this API's fault, not the caller's
    default:
      return 500;
  }
}

function summarize(results: ItemResult[]): Record<string, number> {
  const count = (fn: (r: ItemResult) => boolean): number => results.filter(fn).length;
  return {
    total: results.length,
    from_cache: count((r) => r.status === 'ok' && r.source === 'cache'),
    researched: count((r) => r.status === 'ok' && r.source === 'fresh'),
    failed: count((r) => r.status === 'error'),
    in_progress: count((r) => r.status === 'in_progress'),
  };
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function handleCategorize(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req, config.api.maxBodyBytes);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }

  const parsed = parseRequest(body);
  if (parsed.items.length === 0) {
    throw new HttpError(400, 'invalid_body', 'Provide at least one company.');
  }
  if (parsed.items.length > config.api.maxBatch) {
    throw new HttpError(
      413,
      'batch_too_large',
      `At most ${config.api.maxBatch} companies per request; got ${parsed.items.length}.`
    );
  }

  const slots = parsed.items.map(toSlot);
  const valid = slots.flatMap((s) => (s.ok ? [s.input] : []));
  const researched = valid.length
    ? await researchCompanies(valid, { forceRefresh: parsed.forceRefresh })
    : [];

  // Put results back in the order the caller sent them.
  let next = 0;
  const results: ItemResult[] = slots.map((s) => (s.ok ? (researched[next++] as ResearchResult) : s.result));

  if (parsed.single) {
    const only = results[0] as ItemResult;
    send(res, statusFor(only), only, only.status === 'in_progress' ? { 'Retry-After': '5' } : {});
    return;
  }
  send(res, 200, { summary: summarize(results), results });
}

/** This service's public address: PUBLIC_URL, or what the request was sent to. */
function publicBaseUrl(req: http.IncomingMessage): string {
  if (config.deeluge.publicUrl) return config.deeluge.publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0]?.trim() || 'https';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0]?.trim();
  return `${proto}://${host}`;
}

async function handleDeeluge(path: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const manifest = path.match(/^\/deeluge\/r\/([A-Za-z0-9_-]+)\/manifest\.json$/);
  if (manifest) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    const reg = await getRegistration(manifest[1] as string);
    if (!reg) throw new HttpError(404, 'not_found', 'No such registration.');
    send(res, 200, buildManifest(publicBaseUrl(req), reg));
    return;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');

  // The signature covers the exact bytes Deeluge sent, so keep them raw.
  const raw = await readBody(req, config.api.maxBodyBytes);
  const result = await handleDeelugeRequest(path ?? '/deeluge', req.headers, raw);
  if (result.status === 204 || result.body === undefined) {
    res.writeHead(result.status, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  send(res, result.status, result.body);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?', 1)[0];

  if (path === '/deeluge' || path?.startsWith('/deeluge/')) {
    await handleDeeluge(path, req, res);
    return;
  }

  if (path === '/setup' || path === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    const html = SETUP_PAGE;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(html);
    return;
  }

  if (path && isManagementPath(path)) {
    const principal = await authenticate(presentedKey(req.headers));
    let body: unknown = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const raw = await readBody(req, 64 * 1024);
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
        }
      }
    }
    try {
      const out = await handleManagement({ method: req.method ?? 'GET', path, principal, body, publicBaseUrl: publicBaseUrl(req) });
      send(res, out.status, out.body);
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
        return;
      }
      throw err;
    }
    return;
  }

  if (path === '/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    send(res, 200, { status: 'ok' });
    return;
  }

  if (path === ROUTE) {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'method_not_allowed', `Use POST ${ROUTE}.`);
    }
    if (!(await authenticate(presentedKey(req.headers)))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'unauthorized', 'Missing or invalid API key.');
    }
    await handleCategorize(req, res);
    return;
  }

  throw new HttpError(404, 'not_found', 'No such route.');
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  handle(req, res)
    .catch((err: unknown) => {
      if (err instanceof HttpError) return sendError(res, err);
      console.error('[api] Unhandled error:', err);
      sendError(res, new HttpError(500, 'internal_error', 'Internal server error.'));
    })
    .finally(() => {
      if (req.url !== '/health') {
        console.log(
          `[api] ${req.method} ${req.url} -> ${res.statusCode} in ${Date.now() - started}ms`
        );
      }
    });
});

// Time to receive the request. Deliberately NOT setting server.timeout: a
// response legitimately takes as long as the scrape + model calls do.
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
// Longer than the load balancer's idle timeout, so it - not us - closes idle sockets.
server.keepAliveTimeout = 65_000;

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let shuttingDown = false;

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    `[api] Shutting down (${inflightCount()} run(s), ${deelugeJobsInFlight()} Deeluge job(s) in flight)...`
  );
  server.close();
  // Cloud Run gives ~10s after SIGTERM. Let paid-for work land in the database
  // if it can; anything left is re-claimable once STALE_CLAIM_MS passes.
  await Promise.all([waitForIdle(8_000), waitForDeelugeIdle(8_000)]);
  closeScrapers();
  closeLlm();
  await closePool().catch(() => undefined);
  process.exit(code);
}

async function main(): Promise<void> {
  validateConfig();
  validateApiConfig();
  enableTransportRecovery();
  await assertConnection();
  await assertScrapeColumns();
  await ensureTenancyTables();

  const model = config.llm.provider === 'openai' ? config.openai.model : config.anthropic.model;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.api.port, '0.0.0.0', () => resolve());
  });
  console.log(
    `[api] Listening on :${config.api.port}  POST ${ROUTE}` +
      `  provider=${config.llm.provider} model=${model} scraper=${config.scraper.primary}` +
      `  freshness=${config.api.resultMaxAgeMonths}mo max-batch=${config.api.maxBatch}` +
      `  concurrency=${config.api.concurrency}`
  );
  console.log(
    `[api] Deeluge app: POST /deeluge/r/<registration>/*  management: /v1/registrations  setup page: GET /setup` +
      `  concurrency=${config.deeluge.concurrency}${config.deeluge.openSignup ? '  OPEN_SIGNUP on' : ''}`
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

main().catch(async (err) => {
  console.error('[api] Fatal:', err instanceof Error ? err.message : err);
  await shutdown(1);
});
