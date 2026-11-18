import OpenAI from 'openai';
import { config } from './config.js';
import { RateLimiter } from './rateLimit.js';
import { withRetry } from './retry.js';
import {
  CATEGORIZER_SYSTEM_PROMPT,
  FINANCIAL_CRITERIA_SYSTEM_PROMPT,
  NAME_SCREEN_SYSTEM_PROMPT,
} from './prompts.js';
import { extractCategorizationJson, isCategorizationResult } from './categorization.js';
import { cleanNameScreenInput, parseNameScreenResult } from './nameScreenParsing.js';
import { parseFinancialCriteria } from './financialCriteria.js';
import type {
  CategorizationOutcome,
  CategorizationResult,
  FinancialCriteria,
  FinancialCriteriaOutcome,
  NameScreenOutcome,
  NameScreenResult,
  TokenUsage,
} from './types.js';

/**
 * The OpenAI client is constructed lazily (on first use) rather than at
 * module load, for the same reason as getAnthropicClient() in
 * claudeAgent.ts: this file is imported unconditionally by the provider
 * facade (llm.ts), and when LLM_PROVIDER=anthropic there is no reason to
 * require OPENAI_API_KEY or construct a client that will never be called.
 */
let openaiClient: OpenAI | null = null;
function getOpenAiClient(): OpenAI {
  if (!openaiClient) {
    if (!config.openai.apiKey) {
      throw new Error(
        'OPENAI_API_KEY is required to use the OpenAI provider (LLM_PROVIDER=openai).'
      );
    }
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
      // Retries are handled by withRetry() so a 429 also teaches the limiter.
      maxRetries: 0,
    });
  }
  return openaiClient;
}

export const openaiLimiter = new RateLimiter({
  name: 'openai',
  rpm: config.openai.rpm,
  concurrency: config.openai.concurrency,
});

/**
 * OpenAI's prompt caching is automatic - there is no cache_control block to
 * set, and it kicks in on its own once a prompt's prefix reaches 1,024
 * tokens (a flat minimum, unlike Anthropic's per-model tiers). Both prompts
 * in ./prompts.ts were sized to clear that bar already (see the comments
 * there), so no extra padding is needed for OpenAI specifically.
 *
 * There is also no separate cache-write charge on OpenAI: cache reads are
 * simply billed at a discount off the base input price, so the "input
 * tokens vs cache-read tokens" split below is for cost visibility only, not
 * because OpenAI bills them differently up front the way Anthropic does.
 */
function readOpenAiUsage(
  usage: OpenAI.CompletionUsage | undefined,
  model: string
): TokenUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    // Mirrors the Anthropic split: input_tokens is the fresh/uncached
    // portion, cache_read_input_tokens is what was served from cache.
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cachedTokens,
    // OpenAI doesn't report or separately bill a cache-write step.
    cache_creation_input_tokens: 0,
    model,
    at: new Date().toISOString(),
  };
}

let cacheWarningShown = false;

function reportCache(usage: TokenUsage, domain: string): void {
  if (usage.cache_read_input_tokens === 0 && !cacheWarningShown) {
    cacheWarningShown = true;
    console.warn(
      '[openai] Prompt cache reported 0 cached tokens. OpenAI only caches prompts of 1,024+ ' +
        'tokens, and a cache entry only becomes available a short while after the first request ' +
        'that wrote it - this is expected on a cold start and should clear up after the first ' +
        'few calls. If it persists, check OPENAI_MODEL supports caching for your account.'
    );
  }
  console.log(
    `[openai] ${domain}: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens}`
  );
}

/**
 * Fires one cheap call per prompt before the workers fan out. OpenAI's cache
 * write itself is free, but a cache entry only becomes usable a short while
 * after the request that created it, so without this every worker's first
 * real call would race to be the one that pays for (and waits on) that
 * initial write. `label` only affects logging, same as claudeAgent.ts.
 */
async function warmPrompt(systemPrompt: string, label: string): Promise<void> {
  try {
    const response = await openaiLimiter.schedule(() =>
      withRetry(
        () =>
          getOpenAiClient().chat.completions.create({
            model: config.openai.model,
            max_completion_tokens: 1,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: 'warmup' },
            ],
          }),
        { name: `openai.prewarm.${label}`, retries: 2, limiter: openaiLimiter }
      )
    );
    const usage = readOpenAiUsage(response.usage, config.openai.model);
    console.log(
      `[openai] Prompt warmed (${label}): prompt_tokens=${response.usage?.prompt_tokens ?? 0}, ` +
        `cached=${usage.cache_read_input_tokens}.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[openai] Prompt warm-up skipped (${label}): ${message}`);
  }
}

/** Warms every cacheable prompt in use (categorizer, plus name screen / financial criteria if enabled). */
export async function prewarmOpenAi(): Promise<void> {
  await warmPrompt(CATEGORIZER_SYSTEM_PROMPT, 'categorizer');
  if (config.nameScreen.enabled) {
    await warmPrompt(NAME_SCREEN_SYSTEM_PROMPT, 'nameScreen');
  }
  if (config.financialCriteria.enabled) {
    await warmPrompt(FINANCIAL_CRITERIA_SYSTEM_PROMPT, 'financialCriteria');
  }
}

/**
 * Calls OpenAI to categorize a single company from its scraped markdown, and
 * returns the parsed result together with the exact token counters the call
 * consumed so they can be written into the row's JSONB metadata. Mirrors
 * categorizeCompany() in claudeAgent.ts.
 */
export async function categorizeCompanyOpenAi(
  companyMarkdown: string,
  domain: string
): Promise<CategorizationOutcome> {
  const response = await openaiLimiter.schedule(() =>
    withRetry(
      () =>
        getOpenAiClient().chat.completions.create({
          model: config.openai.model,
          max_completion_tokens: config.openai.maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: CATEGORIZER_SYSTEM_PROMPT },
            { role: 'user', content: `COMPANY DATA:\n${companyMarkdown}` },
          ],
        }),
      { name: 'openai.chat', retries: config.pipeline.maxRetries, limiter: openaiLimiter }
    )
  );

  const usage = readOpenAiUsage(response.usage, config.openai.model);
  reportCache(usage, domain);

  const text = response.choices[0]?.message?.content;
  if (!text) {
    const err = new Error('OpenAI response contained no message content') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  let parsed: CategorizationResult;
  try {
    parsed = extractCategorizationJson(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Failed to parse OpenAI JSON output: ${reason}\nRaw: ${text.slice(0, 500)}`
    ) as Error & { usage: TokenUsage };
    wrapped.usage = usage;
    throw wrapped;
  }

  if (!isCategorizationResult(parsed)) {
    const err = new Error('OpenAI output missing "categories" array') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  return { result: parsed, usage };
}

/**
 * Asks OpenAI whether a company is clearly a Target from its name and domain
 * alone. Mirrors screenCompanyName() in nameScreen.ts.
 */
export async function screenCompanyNameOpenAi(
  name: string,
  domain: string
): Promise<NameScreenOutcome> {
  const response = await openaiLimiter.schedule(() =>
    withRetry(
      () =>
        getOpenAiClient().chat.completions.create({
          model: config.openai.model,
          max_completion_tokens: config.nameScreen.maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: NAME_SCREEN_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `COMPANY NAME: ${cleanNameScreenInput(name)}\nDOMAIN: ${cleanNameScreenInput(domain)}`,
            },
          ],
        }),
      { name: 'openai.nameScreen', retries: config.pipeline.maxRetries, limiter: openaiLimiter }
    )
  );

  const usage = readOpenAiUsage(response.usage, config.openai.model);

  const text = response.choices[0]?.message?.content;
  if (!text) {
    const err = new Error('Name screen response contained no message content') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  let result: NameScreenResult;
  try {
    result = parseNameScreenResult(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Failed to parse name screen output: ${reason}\nRaw: ${text.slice(0, 300)}`
    ) as Error & { usage: TokenUsage };
    wrapped.usage = usage;
    throw wrapped;
  }

  return {
    result,
    usage,
    isConfidentTarget:
      result.verdict === 'target' && result.confidence >= config.nameScreen.minConfidence,
  };
}

/**
 * Calls OpenAI to pull revenue / EBITDA / enterprise-value criteria out of the
 * scraped markdown. Mirrors extractFinancialCriteria() in claudeAgent.ts.
 */
export async function extractFinancialCriteriaOpenAi(
  companyMarkdown: string,
  domain: string
): Promise<FinancialCriteriaOutcome> {
  const response = await openaiLimiter.schedule(() =>
    withRetry(
      () =>
        getOpenAiClient().chat.completions.create({
          model: config.openai.model,
          max_completion_tokens: config.financialCriteria.maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: FINANCIAL_CRITERIA_SYSTEM_PROMPT },
            { role: 'user', content: `COMPANY DATA:\n${companyMarkdown}` },
          ],
        }),
      { name: 'openai.financialCriteria', retries: config.pipeline.maxRetries, limiter: openaiLimiter }
    )
  );

  const usage = readOpenAiUsage(response.usage, config.openai.model);
  console.log(
    `[openai] ${domain} (financial criteria): in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens}`
  );

  const text = response.choices[0]?.message?.content;
  if (!text) {
    const err = new Error('OpenAI financial-criteria response contained no message content') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  let parsed: FinancialCriteria;
  try {
    parsed = parseFinancialCriteria(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Failed to parse financial-criteria JSON: ${reason}\nRaw: ${text.slice(0, 500)}`
    ) as Error & { usage: TokenUsage };
    wrapped.usage = usage;
    throw wrapped;
  }

  return { result: parsed, usage };
}

export function closeOpenAi(): void {
  openaiLimiter.close();
}
