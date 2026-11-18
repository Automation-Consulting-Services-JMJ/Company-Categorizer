/**
 * The behaviour behind the HTTP endpoint:
 *
 *   1. Look the domain up. Checked within the last RESULT_MAX_AGE_MONTHS -> return what's stored.
 *   2. Otherwise (no row, never checked, or too old) run the normal pipeline
 *      for it - name screen, scrape, classify - which writes the result to the row.
 *   3. Read the row back and return it, so the response is exactly what's stored.
 *
 * All the actual research is processCompany() from pipeline.ts, unchanged: the
 * API and the batch job produce identical rows.
 */
import { config } from './config.js';
import {
  claimForProcessing,
  findCompaniesByDomains,
  findCompanyById,
  releaseClaim,
  type CompanyRecord,
} from './db.js';
import { processCompany } from './pipeline.js';
import { emptyRange, toAmount } from './financialCriteria.js';
import type { FinancialCriteria, FinancialRange } from './types.js';

export type RefreshReason = 'not_found' | 'not_checked' | 'stale' | 'forced';

export interface ResearchInput {
  /** Already normalised (see normalizeDomain). */
  domain: string;
  name?: string | null;
}

export interface Classification {
  category: string | null;
  sub_category: string | null;
  note: string | null;
  /** "name_screen" (decided from name + domain alone) or "scrape" (from the website). */
  classification_source: string | null;
  checked_at: string | null;
  /** Revenue / EBITDA / enterprise-value criteria; null when not extracted (see the status). */
  financial_criteria: FinancialCriteria | null;
  /** extracted | skipped_target | not_scraped | disabled | failed, or null for rows from before this feature. */
  financial_criteria_status: string | null;
}

/** Reads the financial_criteria column back defensively: it is JSONB and null for older rows. */
function financialCriteriaOf(value: unknown): FinancialCriteria | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const range = (r: unknown): FinancialRange => {
    if (typeof r !== 'object' || r === null) return emptyRange();
    const o = r as Record<string, unknown>;
    return { min: toAmount(o.min), max: toAmount(o.max), is_flexible: o.is_flexible === true };
  };
  return { revenue: range(v.revenue), ebitda: range(v.ebitda), enterprise_value: range(v.enterprise_value) };
}

export type ResearchResult =
  | ({
      domain: string;
      name: string | null;
      status: 'ok';
      /** "cache" = served from the database; "fresh" = researched just now. */
      source: 'cache' | 'fresh';
      /** Only on source "fresh": why the stored result wasn't used. */
      refresh_reason?: RefreshReason;
    } & Classification)
  | {
      domain: string;
      name: string | null;
      status: 'error';
      error_code: 'processing_failed' | 'internal_error';
      error: string;
      /** The previous result, when a refresh of an older row failed. */
      last_known?: Classification;
    }
  | {
      domain: string;
      name: string | null;
      status: 'in_progress';
      error_code: 'in_progress';
      error: string;
      last_known?: Classification;
    };

/** How often to re-check a row somebody else is processing. */
const POLL_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two requests for the same domain at the same moment share one run instead
 * of each paying for one. (Across separate server instances the database
 * claim in claimForProcessing() does the same job.)
 */
const inflight = new Map<string, Promise<ResearchResult>>();

export function inflightCount(): number {
  return inflight.size;
}

/** Resolves once no research is running, or after `timeoutMs`. Used on shutdown. */
export async function waitForIdle(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inflight.size > 0 && Date.now() < deadline) await sleep(100);
}

function classificationOf(record: CompanyRecord): Classification {
  const m = record.metadata;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  return {
    category: str(m.category),
    sub_category: str(m.sub_category),
    note: str(m.note),
    classification_source: str(m.classification_source),
    checked_at: record.checkedAt ? record.checkedAt.toISOString() : null,
    financial_criteria: financialCriteriaOf(record.financialCriteria),
    financial_criteria_status: str(m.financial_criteria_status),
  };
}

/** The previous answer, if the row ever had one - offered when a refresh fails. */
function lastKnown(record: CompanyRecord | null): Classification | undefined {
  if (!record || !record.metadata.category) return undefined;
  return classificationOf(record);
}

function displayName(record: CompanyRecord | null, input: ResearchInput): string | null {
  const stored = record?.metadata.name;
  if (typeof stored === 'string' && stored.trim()) return stored;
  return input.name?.trim() || null;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

async function resolve(
  input: ResearchInput,
  initial: CompanyRecord | null | undefined,
  forceRefresh: boolean
): Promise<ResearchResult> {
  const { domain } = input;
  const deadline = Date.now() + config.api.waitForInflightMs;

  // `undefined` means "not looked up yet"; `null` means "looked up, no row".
  let record = initial;
  // A forced refresh skips the cache once. If we then have to wait for someone
  // else's run of the same domain, what they produce is as fresh as it gets.
  let bypassCache = forceRefresh;
  let previous: CompanyRecord | null = null;

  try {
    for (;;) {
      if (record === undefined) record = (await findCompaniesByDomains([domain])).get(domain) ?? null;
      if (record) previous = record;

      if (record?.isFresh && !bypassCache) {
        return { domain, name: displayName(record, input), status: 'ok', source: 'cache', ...classificationOf(record) };
      }

      const reason: RefreshReason = bypassCache
        ? 'forced'
        : !record
          ? 'not_found'
          : record.isChecked
            ? 'stale'
            : 'not_checked';

      const claimed = await claimForProcessing({
        domain,
        existingId: record?.id,
        name: input.name?.trim() || null,
      });

      if (claimed) {
        console.log(`[api] ${domain}: researching (${reason})`);
        try {
          await processCompany(claimed);
        } catch (err) {
          // processCompany has already written the failure to the row and
          // released the claim; this only matters if it failed before doing so.
          await releaseClaim(claimed.id).catch(() => undefined);
          return {
            domain,
            name: displayName(previous, input),
            status: 'error',
            error_code: 'processing_failed',
            error: errorMessage(err),
            ...(lastKnown(previous) ? { last_known: lastKnown(previous) } : {}),
          };
        }

        const after = await findCompanyById(claimed.id);
        if (!after || !after.isChecked) {
          return {
            domain,
            name: displayName(previous, input),
            status: 'error',
            error_code: 'processing_failed',
            error: 'Research finished but no result was stored for this company.',
          };
        }
        return {
          domain,
          name: displayName(after, input),
          status: 'ok',
          source: 'fresh',
          refresh_reason: reason,
          ...classificationOf(after),
        };
      }

      // Someone else holds a live claim on this row.
      if (Date.now() >= deadline) {
        return {
          domain,
          name: displayName(previous, input),
          status: 'in_progress',
          error_code: 'in_progress',
          error: 'This company is still being researched by another request. Retry shortly.',
          ...(lastKnown(previous) ? { last_known: lastKnown(previous) } : {}),
        };
      }
      await sleep(POLL_MS);
      record = undefined;
      bypassCache = false;
    }
  } catch (err) {
    // Database/transport failure. Details go to the log, not to the caller.
    console.error(`[api] ${domain}: unexpected error:`, err);
    return {
      domain,
      name: displayName(previous, input),
      status: 'error',
      error_code: 'internal_error',
      error: 'Internal error while researching this company.',
      ...(lastKnown(previous) ? { last_known: lastKnown(previous) } : {}),
    };
  }
}

function resolveShared(
  input: ResearchInput,
  initial: CompanyRecord | null | undefined,
  forceRefresh: boolean
): Promise<ResearchResult> {
  const running = inflight.get(input.domain);
  if (running) return running;
  const promise = resolve(input, initial, forceRefresh).finally(() => {
    inflight.delete(input.domain);
  });
  inflight.set(input.domain, promise);
  return promise;
}

/**
 * Researches every company, returning one result per input, in input order.
 * Never throws: a failure for one company is that company's result.
 */
export async function researchCompanies(
  inputs: ResearchInput[],
  opts: { forceRefresh?: boolean } = {}
): Promise<ResearchResult[]> {
  const forceRefresh = opts.forceRefresh ?? false;

  // The same domain listed twice is researched once (first non-empty name wins).
  const unique = new Map<string, ResearchInput>();
  for (const input of inputs) {
    const seen = unique.get(input.domain);
    if (!seen) unique.set(input.domain, { ...input });
    else if (!seen.name && input.name) seen.name = input.name;
  }
  const work = [...unique.values()];

  // One query answers "what do we already have?" for the whole request.
  let records = new Map<string, CompanyRecord>();
  let lookedUp = true;
  try {
    records = await findCompaniesByDomains(work.map((w) => w.domain));
  } catch (err) {
    console.error('[api] bulk lookup failed:', err);
    // Let each domain retry its own lookup inside resolve().
    lookedUp = false;
  }

  const results = new Map<string, ResearchResult>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = work[cursor++];
      if (!item) return;
      const initial = lookedUp ? (records.get(item.domain) ?? null) : undefined;
      results.set(item.domain, await resolveShared(item, initial, forceRefresh));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(config.api.concurrency, work.length) }, () => worker())
  );

  return inputs.map((i) => results.get(i.domain) as ResearchResult);
}
