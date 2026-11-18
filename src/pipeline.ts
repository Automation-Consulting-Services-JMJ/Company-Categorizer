import { config } from './config.js';
import {
  claimPendingCompanies,
  countPending,
  finishCompany,
  isTransportHealthy,
  saveScrapeData,
  tokenTotals,
} from './db.js';
import { scrapeCompany, scraperStats } from './scraper.js';
import { stripImages } from './cleanMarkdown.js';
import {
  categorizeCompany,
  combineCategories,
  extractFinancialCriteria,
  screenCompanyName,
  prewarmCaches,
} from './llm.js';
import { formatRange, isTargetOnly } from './financialCriteria.js';
import { EMPTY_USAGE } from './types.js';
import type {
  CategorizationResult,
  CompanyMetadata,
  FinancialCriteria,
  NameScreenOutcome,
  NameScreenRecord,
  PendingCompany,
  TokenUsage,
} from './types.js';

interface RunTotals {
  processed: number;
  failed: number;
  /** Of `processed`, how many were settled from the name alone (no scrape, no categorizer). */
  nameScreened: number;
  usage: TokenUsage;
}

/** How a company was ultimately classified, plus everything the call cost. */
interface ProcessResult {
  usage: TokenUsage;
  via: 'name_screen' | 'scrape';
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    // Keep the model/timestamp of the most recent call so last_run_usage stays attributable.
    model: b.model ?? a.model,
    at: b.at ?? a.at,
  };
}

/** Sums two optional usages; undefined means "nothing spent yet". */
function sumUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return addUsage(a, b);
}

/** Pulls the usage counters off an error thrown after a billable API call. */
function usageFromError(err: unknown): TokenUsage | undefined {
  const maybe = (err as { usage?: TokenUsage } | null)?.usage;
  return maybe && typeof maybe.input_tokens === 'number' ? maybe : undefined;
}

async function recordFailure(company: PendingCompany, message: string, usage?: TokenUsage) {
  const patch: Partial<CompanyMetadata> = {
    errors: message.slice(0, 2000),
    checked: false,
    checked_at: new Date().toISOString(),
  };
  await finishCompany(company.id, patch, usage);
}

/** Sheet mirroring is best-effort: the database is the source of truth. */
async function mirrorToSheet(
  domain: string,
  category: string,
  subCategory: string,
  note: string
): Promise<void> {
  if (!config.pipeline.sheetWriteback) return;
  try {
    const { updateRowByDomain } = await import('./googleSheets.js');
    await updateRowByDomain(domain, {
      Category: category,
      'Sub Category': subCategory,
      Note: note,
      Checked: 'True',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[pipeline] Sheet write-back failed for ${domain}: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Layer 1: name + domain screen                                       */
/* ------------------------------------------------------------------ */

interface ScreenStep {
  /** Null when the screen was skipped or failed - either way, carry on. */
  outcome: NameScreenOutcome | null;
  /** Tokens spent by the screen, including on a failed/unparseable reply. */
  usage?: TokenUsage;
}

/**
 * Never throws. Any problem with the screen (no name to look at, API error,
 * malformed JSON) means "we couldn't tell", which is exactly the case that
 * must fall through to the full scrape-and-categorize path - so a broken
 * screen can slow a company down but can never wrongly settle or fail it.
 */
async function runNameScreen(company: PendingCompany): Promise<ScreenStep> {
  if (!config.nameScreen.enabled) return { outcome: null };

  const name = typeof company.metadata.name === 'string' ? company.metadata.name.trim() : '';
  if (!name) {
    // A domain alone is too thin a basis for skipping verification.
    console.log(`[name-screen] ${company.domain}: no name on the row - continuing to scrape.`);
    return { outcome: null };
  }

  try {
    const outcome = await screenCompanyName(name, company.domain);
    const { verdict, confidence, reason } = outcome.result;
    console.log(
      `[name-screen] ${company.domain}: ${verdict} (${confidence.toFixed(2)})` +
        `${outcome.isConfidentTarget ? ' -> skipping scrape' : ' -> continuing'} - ${reason}`
    );
    return { outcome, usage: outcome.usage };
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.warn(`[name-screen] ${company.domain}: screen failed (${message}) - continuing to scrape.`);
    return { outcome: null, usage: usageFromError(err) };
  }
}

function toRecord(outcome: NameScreenOutcome, skippedScrape: boolean): NameScreenRecord {
  return { ...outcome.result, skipped_scrape: skippedScrape, at: new Date().toISOString() };
}

/** Writes a confident name-screen Target straight to the row. No scrape, no categorizer. */
async function storeNameScreenTarget(
  company: PendingCompany,
  name: string,
  outcome: NameScreenOutcome
): Promise<ProcessResult> {
  const { domain } = company;
  const note =
    `Target (no subcategory): Classified from company name and domain only; ` +
    `website was not scraped. ${outcome.result.reason}`.trim();

  const patch: Partial<CompanyMetadata> = {
    name,
    domain: company.metadata.domain ?? domain,
    category: 'Target',
    sub_category: null,
    note,
    errors: null,
    checked: true,
    checked_at: new Date().toISOString(),
    scrape_provider: null,
    classification_source: 'name_screen',
    name_screen: toRecord(outcome, true),
    // No website text was read, so there is nothing to extract criteria from.
    financial_criteria_status: 'not_scraped',
    financial_criteria_error: null,
  };

  // Clears the financial_criteria column too, so an earlier run's values don't linger.
  await finishCompany(company.id, patch, outcome.usage, { financialCriteria: null });
  await mirrorToSheet(domain, 'Target', '', note);

  console.log(`[pipeline] Done: ${domain} -> Target [name screen, scrape skipped]`);
  return { usage: outcome.usage, via: 'name_screen' };
}

/* ------------------------------------------------------------------ */
/* Financial criteria (revenue / EBITDA / enterprise value)            */
/* ------------------------------------------------------------------ */

type FinancialPatch = Pick<CompanyMetadata, 'financial_criteria_status' | 'financial_criteria_error'>;

interface FinancialStep {
  /** Goes to the financial_criteria column; null clears it. */
  criteria: FinancialCriteria | null;
  /** Status and error, merged into metadata. */
  patch: FinancialPatch;
  /** Tokens spent, including on a failed/unparseable reply. */
  usage?: TokenUsage;
}

/**
 * Never throws. The categorization is the row's main result, so a failed
 * extraction is recorded in financial_criteria_error and the row is still
 * marked checked. Every key is always written, so a re-run clears values
 * left over from an earlier run.
 */
async function runFinancialCriteria(
  markdown: string,
  domain: string,
  categorization: CategorizationResult
): Promise<FinancialStep> {
  const fc = config.financialCriteria;
  const none = (status: FinancialPatch['financial_criteria_status']): FinancialStep => ({
    criteria: null,
    patch: { financial_criteria_status: status, financial_criteria_error: null },
  });

  if (!fc.enabled) return none('disabled');
  if (fc.skipTargets && isTargetOnly(categorization.categories.map((c) => c.category))) {
    return none('skipped_target');
  }

  try {
    const outcome = await extractFinancialCriteria(markdown, domain);
    const r = outcome.result;
    const summary = (['revenue', 'ebitda', 'enterprise_value'] as const)
      .map((k) => `${k}=${formatRange(r[k]) ?? '-'}`)
      .join(' ');
    console.log(`[financial] ${domain}: ${summary}`);
    return {
      criteria: r,
      patch: {
        financial_criteria_status: 'extracted',
        financial_criteria_error: null,
      },
      usage: outcome.usage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[financial] ${domain}: extraction failed (${message.split('\n')[0]})`);
    return {
      criteria: null,
      patch: {
        financial_criteria_status: 'failed',
        financial_criteria_error: message.slice(0, 2000),
      },
      usage: usageFromError(err),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Per-company flow                                                    */
/* ------------------------------------------------------------------ */

export async function processCompany(company: PendingCompany): Promise<ProcessResult> {
  const { domain } = company;
  console.log(`[pipeline] Processing ${domain}`);

  // --- layer 1: name + domain screen (cheap; may settle the company outright) ---
  const screen = await runNameScreen(company);
  if (screen.outcome?.isConfidentTarget) {
    const name = String(company.metadata.name).trim();
    return storeNameScreenTarget(company, name, screen.outcome);
  }

  // Everything below is the original flow. Whatever the screen spent is carried
  // along so it lands in the row's token counters alongside the categorizer's.
  const screenUsage = screen.usage;

  // --- scrape ---
  let scraped;
  try {
    scraped = await scrapeCompany(domain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Scrape failed for ${domain}: ${message}`);
    await recordFailure(company, message, screenUsage);
    throw new Error(message);
  }

  const cleanedMarkdown = stripImages(scraped.markdown);
  if (!cleanedMarkdown) {
    const message = 'No scrapable content returned';
    await recordFailure(company, message, screenUsage);
    throw new Error(message);
  }

  // --- persist the crawl (sitemap + scraped_text columns) ---
  // Done before the model call so a failed categorization never costs us the
  // crawl we already paid for.
  try {
    await saveScrapeData(company.id, {
      sitemap: scraped.sitemap ?? null,
      scrapedText: cleanedMarkdown,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Could not save sitemap/scraped_text for ${domain}: ${message}`);
  }

  // --- categorize ---
  let outcome;
  try {
    outcome = await categorizeCompany(cleanedMarkdown, domain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Categorization failed for ${domain}: ${message}`);
    // Even a failed parse burned tokens - still bill them to the row.
    await recordFailure(company, message, sumUsage(screenUsage, usageFromError(err)));
    throw new Error(message);
  }

  const combined = combineCategories(outcome.result);

  // --- financial criteria (second call over the same text; never fails the row) ---
  const financial = await runFinancialCriteria(cleanedMarkdown, domain, outcome.result);

  const totalUsage =
    sumUsage(sumUsage(screenUsage, outcome.usage), financial.usage) ?? outcome.usage;

  // --- write result + token usage back into the JSONB ---
  const patch: Partial<CompanyMetadata> = {
    name: combined.companyName || company.metadata.name || null,
    domain: company.metadata.domain ?? domain,
    category: combined.combinedCategory || null,
    sub_category: combined.combinedSubcategory || null,
    note: combined.combinedNote || null,
    errors: null,
    checked: true,
    checked_at: new Date().toISOString(),
    scrape_provider: scraped.provider,
    classification_source: 'scrape',
    ...(screen.outcome ? { name_screen: toRecord(screen.outcome, false) } : {}),
    ...financial.patch,
  };

  await finishCompany(company.id, patch, totalUsage, { financialCriteria: financial.criteria });
  await mirrorToSheet(
    domain,
    combined.combinedCategory,
    combined.combinedSubcategory,
    combined.combinedNote
  );

  console.log(
    `[pipeline] Done: ${domain} -> ${combined.combinedCategory || '(no category)'} ` +
      `[${scraped.provider}]`
  );
  return { usage: totalUsage, via: 'scrape' };
}

/**
 * Fixed-size worker pool. Workers pull from a shared cursor, so a slow domain
 * never blocks the others - which is the real reason the old fixed sleeps
 * could go: throughput is now bounded by the per-provider rate limiters, not
 * by a worst-case delay applied to every company equally.
 */
async function runWorkers(companies: PendingCompany[], totals: RunTotals): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(config.pipeline.concurrency, companies.length);

  const worker = async (id: number): Promise<void> => {
    for (;;) {
      // A dead SSH tunnel means no result can be written for anything we do
      // from here on, so stop spending scrape/model credits. The claimed rows
      // are reclaimed automatically once STALE_CLAIM_MS passes.
      if (!isTransportHealthy()) {
        console.error('[pipeline] Database transport is down - stopping this run early.');
        return;
      }

      const index = cursor;
      cursor += 1;
      if (index >= companies.length) return;
      const company = companies[index];
      if (!company) return;

      try {
        const result = await processCompany(company);
        totals.processed += 1;
        if (result.via === 'name_screen') totals.nameScreened += 1;
        totals.usage = addUsage(totals.usage, result.usage);
      } catch {
        // Already logged and already written to the row's `errors` field.
        totals.failed += 1;
      }
      void id;
    }
  };

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
}

export async function runPipeline(): Promise<void> {
  const startedAt = Date.now();
  console.log('[pipeline] Claiming unchecked rows from the database...');

  const pending = await countPending();
  const batch = await claimPendingCompanies(config.pipeline.batchSize);

  console.log(
    `[pipeline] ${pending} unchecked row(s) in table, claimed ${batch.length} this run ` +
      `(concurrency ${config.pipeline.concurrency}).`
  );

  if (batch.length === 0) {
    console.log('[pipeline] Nothing to do.');
    return;
  }

  // Write the active provider's cacheable prompt(s) into its cache once
  // before workers fan out, so the parallel calls read them instead of each
  // paying for a cache write. The name screen runs on every claimed company
  // (before the scrape), so it needs the same treatment as the categorizer
  // prompt.
  await prewarmCaches();

  const totals: RunTotals = {
    processed: 0,
    failed: 0,
    nameScreened: 0,
    usage: { ...EMPTY_USAGE },
  };
  await runWorkers(batch, totals);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const { usage } = totals;
  const billableInput = usage.input_tokens + usage.cache_creation_input_tokens;
  const cacheRatio =
    usage.cache_read_input_tokens + billableInput > 0
      ? (
          (usage.cache_read_input_tokens / (usage.cache_read_input_tokens + billableInput)) *
          100
        ).toFixed(1)
      : '0.0';

  console.log(
    `[pipeline] Run complete in ${seconds}s: ${totals.processed} ok ` +
      `(${totals.nameScreened} settled by name screen, ${totals.processed - totals.nameScreened} scraped), ` +
      `${totals.failed} failed. ` +
      `Tokens this run: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens} cache_write=${usage.cache_creation_input_tokens} ` +
      `(${cacheRatio}% of input served from cache). Limiters: ${scraperStats()}.`
  );

  try {
    const totalsAllTime = await tokenTotals();
    console.log(
      `[pipeline] Table totals: in=${totalsAllTime.input} out=${totalsAllTime.output} ` +
        `cache_read=${totalsAllTime.cacheRead} cache_write=${totalsAllTime.cacheWrite}`
    );
  } catch {
    /* totals are informational only */
  }
}
