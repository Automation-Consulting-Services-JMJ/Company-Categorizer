import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { RateLimiter } from './rateLimit.js';
import { withRetry } from './retry.js';
import { CATEGORIZER_SYSTEM_PROMPT, FINANCIAL_CRITERIA_SYSTEM_PROMPT } from './prompts.js';
import { extractCategorizationJson, isCategorizationResult } from './categorization.js';
import { parseFinancialCriteria } from './financialCriteria.js';
import type {
  CategorizationOutcome,
  CategorizationResult,
  FinancialCriteria,
  FinancialCriteriaOutcome,
  TokenUsage,
} from './types.js';

/**
 * The Anthropic client is constructed lazily (on first use) rather than at
 * module load. This file is imported unconditionally by the provider
 * facade (llm.ts) so that both providers' rate limiters exist up front, but
 * when LLM_PROVIDER=openai there is no reason to require ANTHROPIC_API_KEY
 * or to construct an SDK client that will never be called.
 */
let anthropicClient: Anthropic | null = null;
export function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    if (!config.anthropic.apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is required to use the Anthropic provider (LLM_PROVIDER=anthropic).'
      );
    }
    anthropicClient = new Anthropic({
      apiKey: config.anthropic.apiKey,
      // Retries are handled by withRetry() so a 429 also teaches the limiter.
      maxRetries: 0,
    });
  }
  return anthropicClient;
}

export const anthropicLimiter = new RateLimiter({
  name: 'anthropic',
  rpm: config.anthropic.rpm,
  concurrency: config.anthropic.concurrency,
});

/**
 * Wraps any system prompt text in a cache_control block, so every cacheable
 * system prompt in the app (the categorizer's, the name screen's, any future
 * one) gets the same treatment. Building the block once and reusing the same
 * object is what matters for caching, not this function - callers should
 * call this once at module load and hold onto the result, same as SYSTEM
 * below, because a cache hit requires a byte-identical prefix.
 *
 * Below the model's minimum cacheable prefix (1,024 tokens for Sonnet 4.x /
 * Sonnet 5; 4,096 for Opus 4.5/4.6 and Haiku 4.5), marking a prompt this way
 * is harmless but pointless: no error, it just never reads from or writes to
 * cache. Check the `[claude] Prompt cache reported 0 read and 0 written`
 * warning in the logs (see reportCache below) to catch that case.
 */
export function buildCachedSystem(text: string): Anthropic.MessageCreateParams['system'] {
  if (!config.anthropic.cacheEnabled) return text;
  const block = {
    type: 'text' as const,
    text,
    cache_control:
      config.anthropic.cacheTtl === '1h'
        ? { type: 'ephemeral' as const, ttl: '1h' }
        : { type: 'ephemeral' as const },
  };
  return [block] as unknown as Anthropic.MessageCreateParams['system'];
}

const SYSTEM = buildCachedSystem(CATEGORIZER_SYSTEM_PROMPT);
const FINANCIAL_SYSTEM = buildCachedSystem(FINANCIAL_CRITERIA_SYSTEM_PROMPT);

export function readUsage(usage: unknown, model: string): TokenUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (key: string): number => {
    const value = u[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    input_tokens: n('input_tokens'),
    output_tokens: n('output_tokens'),
    cache_read_input_tokens: n('cache_read_input_tokens'),
    cache_creation_input_tokens: n('cache_creation_input_tokens'),
    model,
    at: new Date().toISOString(),
  };
}

let cacheWarningShown = false;

function reportCache(usage: TokenUsage, domain: string): void {
  const { cache_read_input_tokens: read, cache_creation_input_tokens: written } = usage;

  if (config.anthropic.cacheEnabled && read === 0 && written === 0 && !cacheWarningShown) {
    cacheWarningShown = true;
    console.warn(
      '[claude] Prompt cache reported 0 read and 0 written tokens. The cached prefix is ' +
        'probably below the model minimum (1,024 tokens for Sonnet, 4,096 for Opus 4.5/4.6 ' +
        'and Haiku 4.5). Check ANTHROPIC_MODEL, or lengthen the cached system prompt.'
    );
  }

  console.log(
    `[claude] ${domain}: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${read} cache_write=${written}`
  );
}

/**
 * Writes a cached system prompt into the prompt cache before the workers fan
 * out, for whichever prompt `system` holds (categorizer, name screen, or any
 * future one built with buildCachedSystem).
 *
 * Without this, N parallel first-calls all miss the cache and all pay a cache
 * WRITE (1.25x input price), because a cache entry only becomes readable once
 * the first response has started. One cheap warm-up call (max_tokens: 0,
 * zero output tokens billed) turns those N writes into 1 write + N-1 reads.
 *
 * `label` only affects logging/retry names, so it's easy to tell which
 * prompt warmed (or failed to) when both run in the same startup.
 */
async function warmSystemPrompt(
  system: Anthropic.MessageCreateParams['system'],
  label: string
): Promise<void> {
  const send = (maxTokens: number): Promise<Anthropic.Message> =>
    getAnthropicClient().messages.create({
      model: config.anthropic.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: 'warmup' }],
    });

  try {
    const message = await anthropicLimiter.schedule(() =>
      withRetry(
        async () => {
          try {
            return await send(0);
          } catch (err) {
            // Older API versions reject max_tokens: 0; 1 token is a fine
            // substitute and still writes the cache.
            const status = (err as { status?: number })?.status;
            if (status === 400) return await send(1);
            throw err;
          }
        },
        { name: `claude.prewarm.${label}`, retries: 2, limiter: anthropicLimiter }
      )
    );
    const usage = readUsage(message.usage, config.anthropic.model);
    console.log(
      `[claude] Prompt cache warmed (${label}): written=${usage.cache_creation_input_tokens}, ` +
        `read=${usage.cache_read_input_tokens}.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[claude] Cache pre-warm skipped (${label}): ${message}`);
  }
}

/** Warms the categorizer's cached system prompt. */
export async function prewarmPromptCache(): Promise<void> {
  if (!config.anthropic.cacheEnabled || !config.anthropic.prewarmCache) return;
  await warmSystemPrompt(SYSTEM, 'categorizer');
}

/** Warms the financial-criteria extractor's cached system prompt. */
export async function prewarmFinancialCriteriaCache(): Promise<void> {
  if (!config.financialCriteria.enabled) return;
  if (!config.anthropic.cacheEnabled || !config.anthropic.prewarmCache) return;
  await warmSystemPrompt(FINANCIAL_SYSTEM, 'financialCriteria');
}

/**
 * Warms any other cached system prompt built with buildCachedSystem (e.g.
 * the name screen's). Exported so modules other than this one can reuse the
 * exact same warm-up call/retry/logging path instead of duplicating it.
 */
export async function prewarmSystem(
  system: Anthropic.MessageCreateParams['system'],
  label: string
): Promise<void> {
  if (!config.anthropic.cacheEnabled || !config.anthropic.prewarmCache) return;
  await warmSystemPrompt(system, label);
}

/**
 * Calls Claude to categorize a single company from its scraped markdown, and
 * returns the parsed result together with the exact token counters the call
 * consumed so they can be written into the row's JSONB metadata.
 */
export async function categorizeCompany(
  companyMarkdown: string,
  domain: string
): Promise<CategorizationOutcome> {
  const message = await anthropicLimiter.schedule(() =>
    withRetry(
      () =>
        getAnthropicClient().messages.create({
          model: config.anthropic.model,
          max_tokens: config.anthropic.maxTokens,
          system: SYSTEM,
          messages: [{ role: 'user', content: `COMPANY DATA:\n${companyMarkdown}` }],
        }),
      { name: 'claude.messages', retries: config.pipeline.maxRetries, limiter: anthropicLimiter }
    )
  );

  const usage = readUsage(message.usage, config.anthropic.model);
  reportCache(usage, domain);

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  if (!textBlock) {
    const err = new Error('Claude response contained no text block') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  let parsed: CategorizationResult;
  try {
    parsed = extractCategorizationJson(textBlock.text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Failed to parse Claude JSON output: ${reason}\nRaw: ${textBlock.text.slice(0, 500)}`
    ) as Error & { usage: TokenUsage };
    wrapped.usage = usage;
    throw wrapped;
  }

  if (!isCategorizationResult(parsed)) {
    const err = new Error('Claude output missing "categories" array') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  return { result: parsed, usage };
}

/**
 * Calls Claude to pull revenue / EBITDA / enterprise-value criteria out of the
 * same scraped markdown the categorizer read. Throws on API failure or an
 * unparseable reply, with `.usage` attached when tokens were spent.
 */
export async function extractFinancialCriteria(
  companyMarkdown: string,
  domain: string
): Promise<FinancialCriteriaOutcome> {
  const message = await anthropicLimiter.schedule(() =>
    withRetry(
      () =>
        getAnthropicClient().messages.create({
          model: config.anthropic.model,
          max_tokens: config.financialCriteria.maxTokens,
          system: FINANCIAL_SYSTEM,
          messages: [{ role: 'user', content: `COMPANY DATA:\n${companyMarkdown}` }],
        }),
      { name: 'claude.financialCriteria', retries: config.pipeline.maxRetries, limiter: anthropicLimiter }
    )
  );

  const usage = readUsage(message.usage, config.anthropic.model);
  console.log(
    `[claude] ${domain} (financial criteria): in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens} cache_write=${usage.cache_creation_input_tokens}`
  );

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  if (!textBlock) {
    const err = new Error('Claude financial-criteria response contained no text block') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  let parsed: FinancialCriteria;
  try {
    parsed = parseFinancialCriteria(textBlock.text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Failed to parse financial-criteria JSON: ${reason}\nRaw: ${textBlock.text.slice(0, 500)}`
    ) as Error & { usage: TokenUsage };
    wrapped.usage = usage;
    throw wrapped;
  }

  return { result: parsed, usage };
}

export function closeAnthropic(): void {
  anthropicLimiter.close();
}
