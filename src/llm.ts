/**
 * Provider-agnostic facade over whichever LLM backend is configured
 * (LLM_PROVIDER=anthropic | openai). pipeline.ts and index.ts should import
 * from here rather than reaching into claudeAgent.ts / openaiAgent.ts
 * directly, so switching providers is a config change, not a code change.
 */
import { config } from './config.js';
import {
  categorizeCompany as categorizeCompanyClaude,
  extractFinancialCriteria as extractFinancialCriteriaClaude,
  prewarmPromptCache,
  prewarmFinancialCriteriaCache,
  closeAnthropic,
} from './claudeAgent.js';
import { screenCompanyName as screenCompanyNameClaude, prewarmNameScreenCache } from './nameScreen.js';
import {
  categorizeCompanyOpenAi,
  extractFinancialCriteriaOpenAi,
  screenCompanyNameOpenAi,
  prewarmOpenAi,
  closeOpenAi,
} from './openaiAgent.js';
import type { CategorizationOutcome, FinancialCriteriaOutcome, NameScreenOutcome } from './types.js';

export { combineCategories } from './categorization.js';

export async function categorizeCompany(
  companyMarkdown: string,
  domain: string
): Promise<CategorizationOutcome> {
  return config.llm.provider === 'openai'
    ? categorizeCompanyOpenAi(companyMarkdown, domain)
    : categorizeCompanyClaude(companyMarkdown, domain);
}

export async function extractFinancialCriteria(
  companyMarkdown: string,
  domain: string
): Promise<FinancialCriteriaOutcome> {
  return config.llm.provider === 'openai'
    ? extractFinancialCriteriaOpenAi(companyMarkdown, domain)
    : extractFinancialCriteriaClaude(companyMarkdown, domain);
}

export async function screenCompanyName(name: string, domain: string): Promise<NameScreenOutcome> {
  return config.llm.provider === 'openai'
    ? screenCompanyNameOpenAi(name, domain)
    : screenCompanyNameClaude(name, domain);
}

/**
 * Warms whichever provider's cacheable prompt(s) into its cache before the
 * workers fan out. A no-op call on the provider NOT selected is never made -
 * this only ever touches the active provider.
 */
export async function prewarmCaches(): Promise<void> {
  if (config.llm.provider === 'openai') {
    await prewarmOpenAi();
    return;
  }
  await prewarmPromptCache();
  await prewarmNameScreenCache();
  await prewarmFinancialCriteriaCache();
}

export function closeLlm(): void {
  if (config.llm.provider === 'openai') {
    closeOpenAi();
    return;
  }
  closeAnthropic();
}
