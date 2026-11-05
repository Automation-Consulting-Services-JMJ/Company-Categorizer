import 'dotenv/config';
import type { AppConfig, LlmProvider, ScrapeProvider } from './types.js';

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function opt(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function required(name: string): string {
  const value = opt(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = opt(name);
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

function num(name: string, fallback: number): number {
  const value = opt(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${value}"`);
  }
  return parsed;
}

function pem(name: string): string | undefined {
  const value = opt(name);
  return value ? value.replace(/\\n/g, '\n') : undefined;
}

function provider(name: string, fallback: ScrapeProvider): ScrapeProvider {
  const value = str(name, fallback).toLowerCase();
  if (value !== 'firecrawl' && value !== 'tavily') {
    throw new Error(`${name} must be "firecrawl" or "tavily", got "${value}"`);
  }
  return value;
}

function llmProvider(name: string, fallback: LlmProvider): LlmProvider {
  const value = str(name, fallback).toLowerCase();
  if (value !== 'anthropic' && value !== 'openai') {
    throw new Error(`${name} must be "anthropic" or "openai", got "${value}"`);
  }
  return value;
}

const tavilyEnabled = bool('TAVILY_ENABLED', false);
const primaryProvider = provider('SCRAPE_PROVIDER', 'firecrawl');

// "none" disables the fallback. Default: once Tavily is switched on, whichever
// provider isn't primary rescues the domains the primary fails on.
const defaultFallback = tavilyEnabled
  ? primaryProvider === 'tavily'
    ? 'firecrawl'
    : 'tavily'
  : 'none';
const fallbackRaw = str('SCRAPE_FALLBACK_PROVIDER', defaultFallback).toLowerCase();
const fallbackProvider: ScrapeProvider | null =
  fallbackRaw === 'none' || fallbackRaw === ''
    ? null
    : provider('SCRAPE_FALLBACK_PROVIDER', defaultFallback === 'none' ? 'tavily' : defaultFallback);

const cacheTtlRaw = str('ANTHROPIC_CACHE_TTL', '5m').toLowerCase();
if (cacheTtlRaw !== '5m' && cacheTtlRaw !== '1h') {
  throw new Error(`ANTHROPIC_CACHE_TTL must be "5m" or "1h", got "${cacheTtlRaw}"`);
}

export const config: AppConfig = {
  google: {
    // Sheets is now optional: the pipeline reads from Postgres. Turn this on
    // only if you still want results mirrored into the old spreadsheet.
    enabled: bool('SHEET_WRITEBACK_ENABLED', false),
    clientEmail: opt('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    privateKey: pem('GOOGLE_PRIVATE_KEY'),
    spreadsheetId: opt('GOOGLE_SPREADSHEET_ID'),
    sheetName: str('GOOGLE_SHEET_NAME', 'Companies - Uncategorized'),
  },
  firecrawl: {
    apiKey: opt('FIRECRAWL_API_KEY'),
    baseUrl: str('FIRECRAWL_BASE_URL', 'https://api.firecrawl.dev/v1'),
    rpm: num('FIRECRAWL_RPM', 20),
    concurrency: num('FIRECRAWL_CONCURRENCY', 4),
    timeoutMs: num('FIRECRAWL_TIMEOUT_MS', 120000),
  },
  tavily: {
    enabled: tavilyEnabled,
    apiKey: opt('TAVILY_API_KEY'),
    baseUrl: str('TAVILY_BASE_URL', 'https://api.tavily.com'),
    extractDepth: str('TAVILY_EXTRACT_DEPTH', 'basic') === 'advanced' ? 'advanced' : 'basic',
    rpm: num('TAVILY_RPM', 60),
    concurrency: num('TAVILY_CONCURRENCY', 4),
    timeoutMs: num('TAVILY_TIMEOUT_MS', 60000),
  },
  siteCrawl: {
    // Only affects the Tavily scraper. Off = the original one-page extract.
    enabled: bool('SITE_CRAWL_ENABLED', true),
    mapDepth: Math.min(5, Math.max(1, num('SITE_MAP_DEPTH', 2))),
    mapBreadth: Math.min(500, Math.max(1, num('SITE_MAP_BREADTH', 20))),
    mapLimit: Math.max(1, num('SITE_MAP_LIMIT', 50)),
    mapTimeoutSec: Math.min(150, Math.max(10, num('SITE_MAP_TIMEOUT_SEC', 60))),
    maxPages: Math.min(20, Math.max(1, num('SITE_MAX_PAGES', 6))),
    maxCharsPerPage: Math.max(500, num('SITE_MAX_CHARS_PER_PAGE', 8000)),
    maxTotalChars: Math.max(1000, num('SITE_MAX_TOTAL_CHARS', 30000)),
  },
  scraper: {
    primary: primaryProvider,
    fallback: fallbackProvider === primaryProvider ? null : fallbackProvider,
  },
  llm: {
    // Which backend name-screening and categorization calls go through.
    // Everything else in this file (name screen thresholds, retries,
    // pipeline concurrency) is provider-agnostic and applies either way.
    provider: llmProvider('LLM_PROVIDER', 'anthropic'),
  },
  anthropic: {
    // Not `required()` here: only enforced when LLM_PROVIDER=anthropic (the
    // default), so an OpenAI-only setup doesn't need this key at all. See
    // validateConfig() below for the actual enforcement.
    apiKey: opt('ANTHROPIC_API_KEY'),
    model: str('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
    maxTokens: num('ANTHROPIC_MAX_TOKENS', 1500),
    cacheTtl: cacheTtlRaw,
    cacheEnabled: bool('ANTHROPIC_PROMPT_CACHE', true),
    prewarmCache: bool('ANTHROPIC_PREWARM_CACHE', true),
    rpm: num('ANTHROPIC_RPM', 40),
    concurrency: num('ANTHROPIC_CONCURRENCY', 4),
  },
  openai: {
    // Same deal as anthropic.apiKey above, but for LLM_PROVIDER=openai.
    apiKey: opt('OPENAI_API_KEY'),
    model: str('OPENAI_MODEL', 'gpt-4o-mini'),
    maxTokens: num('OPENAI_MAX_TOKENS', 1500),
    // OpenAI's own rate limits are typically much higher than Anthropic's
    // default tiers; adjust to your account's actual limits.
    rpm: num('OPENAI_RPM', 500),
    concurrency: num('OPENAI_CONCURRENCY', 8),
  },
  nameScreen: {
    // Cheap first pass on name + domain. A confident "target" is stored as-is
    // and never reaches Firecrawl/Tavily or the categorizer.
    enabled: bool('NAME_SCREEN_ENABLED', true),
    minConfidence: num('NAME_SCREEN_MIN_CONFIDENCE', 0.9),
    maxTokens: num('NAME_SCREEN_MAX_TOKENS', 250),
  },
  database: {
    connectionString: required('DATABASE_URL'),
    // Set DATABASE_SSL=true for hosted Postgres (Neon, Supabase, etc.).
    // Leave unset for local Postgres, Cloud SQL via the Cloud Run socket
    // connector, or when SSH_TUNNEL_ENABLED handles the transport instead.
    ssl: bool('DATABASE_SSL', false),
    table: str('DATABASE_TABLE', 'public.gpt_luna_company_metadata'),
    // One connection per worker plus a spare for the claim query. Through an
    // SSH tunnel every connection is a separate forwarded channel, so this is
    // the knob to turn down if the bastion limits them.
    poolMax: num('DATABASE_POOL_MAX', Math.max(2, num('PIPELINE_CONCURRENCY', 4) + 1)),
  },
  ssh: {
    // Set true when Postgres is only reachable by SSHing into its VPS first.
    enabled: bool('SSH_TUNNEL_ENABLED', false),
    host: opt('SSH_HOST'),
    port: num('SSH_PORT', 22),
    username: opt('SSH_USERNAME'),
    privateKey: pem('SSH_PRIVATE_KEY'),
    passphrase: opt('SSH_PRIVATE_KEY_PASSPHRASE'),
    password: opt('SSH_PASSWORD'),
    readyTimeoutMs: num('SSH_READY_TIMEOUT_MS', 20000),
    hostFingerprint: opt('SSH_HOST_FINGERPRINT'),
  },
  pipeline: {
    batchSize: num('BATCH_SIZE', 25),
    concurrency: num('PIPELINE_CONCURRENCY', 4),
    staleClaimMs: num('STALE_CLAIM_MS', 15 * 60 * 1000),
    retryErrored: bool('RETRY_ERRORED', false),
    maxRetries: num('MAX_RETRIES', 5),
    scheduleCron: str('SCHEDULE_CRON', '*/15 * * * *'),
    runOnStartup: bool('RUN_ON_STARTUP', true),
    sheetWriteback: bool('SHEET_WRITEBACK_ENABLED', false),
  },
  api: {
    // Cloud Run injects PORT; API_PORT is for everywhere else.
    port: num('PORT', num('API_PORT', 8080)),
    // Comma-separated so a new key can be added before the old one is removed.
    apiKeys: (opt('API_KEY') ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    maxBatch: Math.max(1, Math.floor(num('API_MAX_BATCH', 25))),
    concurrency: Math.max(1, Math.floor(num('API_CONCURRENCY', num('PIPELINE_CONCURRENCY', 4)))),
    resultMaxAgeMonths: Math.max(1, Math.floor(num('RESULT_MAX_AGE_MONTHS', 6))),
    waitForInflightMs: Math.max(0, num('API_WAIT_FOR_INFLIGHT_MS', 120_000)),
    maxBodyBytes: 1_048_576,
  },
  deeluge: {
    adminKeys: (opt('ADMIN_API_KEY') ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    encryptionKey: opt('SECRETS_ENCRYPTION_KEY'),
    publicUrl: opt('PUBLIC_URL')?.replace(/\/+$/, ''),
    concurrency: Math.max(
      1,
      Math.floor(num('DEELUGE_CONCURRENCY', num('API_CONCURRENCY', num('PIPELINE_CONCURRENCY', 4))))
    ),
    openSignup: bool('OPEN_SIGNUP', false),
    developer: {
      name: str('APP_DEVELOPER_NAME', 'Company Categorizer'),
      url: opt('APP_DEVELOPER_URL'),
      email: opt('APP_DEVELOPER_EMAIL'),
    },
    iconUrl: opt('APP_ICON_URL'),
    homepageUrl: opt('APP_HOMEPAGE_URL'),
  },
};

/**
 * Fails fast at startup with a readable message instead of blowing up
 * halfway through a batch because a provider was switched on without
 * its API key.
 */
export function validateConfig(): void {
  const problems: string[] = [];
  const usesFirecrawl =
    config.scraper.primary === 'firecrawl' || config.scraper.fallback === 'firecrawl';
  const usesTavily = config.scraper.primary === 'tavily' || config.scraper.fallback === 'tavily';

  if (usesFirecrawl && !config.firecrawl.apiKey) {
    problems.push('FIRECRAWL_API_KEY is required when Firecrawl is the primary or fallback scraper');
  }
  if (usesTavily) {
    if (!config.tavily.enabled) {
      problems.push(
        'Tavily is selected as a scraper but TAVILY_ENABLED is not true - set TAVILY_ENABLED=true'
      );
    }
    if (!config.tavily.apiKey) {
      problems.push('TAVILY_API_KEY is required when Tavily is the primary or fallback scraper');
    }
  }
  if (config.llm.provider === 'anthropic' && !config.anthropic.apiKey) {
    problems.push(
      'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic (the default) - set it, or set LLM_PROVIDER=openai instead'
    );
  }
  if (config.llm.provider === 'openai' && !config.openai.apiKey) {
    problems.push('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
  }

  if (config.pipeline.sheetWriteback) {
    if (!config.google.clientEmail || !config.google.privateKey || !config.google.spreadsheetId) {
      problems.push(
        'SHEET_WRITEBACK_ENABLED=true requires GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY and GOOGLE_SPREADSHEET_ID'
      );
    }
  }
  if (config.ssh.enabled && !config.ssh.privateKey && !config.ssh.password) {
    problems.push('SSH_TUNNEL_ENABLED=true requires either SSH_PRIVATE_KEY or SSH_PASSWORD');
  }

  if (config.nameScreen.minConfidence < 0 || config.nameScreen.minConfidence > 1) {
    problems.push('NAME_SCREEN_MIN_CONFIDENCE must be between 0 and 1');
  }

  if (config.pipeline.concurrency < 1) {
    problems.push('PIPELINE_CONCURRENCY must be at least 1');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Extra checks for the HTTP server only. Kept separate from validateConfig()
 * so the batch job doesn't start demanding an API key it never uses.
 *
 * Every request the API accepts can spend scrape and model credits, so running
 * it without authentication is refused outright rather than warned about.
 */
export function validateApiConfig(): void {
  const problems: string[] = [];
  // API keys for /v1/companies/categorize now live in the database (one or
  // more per organization). API_KEY in the environment is still accepted, but
  // is optional. ADMIN_API_KEY is how the operator gets in to create the first
  // organizations and keys.
  const d = config.deeluge;
  if (d.adminKeys.length === 0) {
    problems.push(
      'ADMIN_API_KEY is required: it is the operator key for the management API (organizations, ' +
        'signing secrets, API keys). Generate one with: openssl rand -hex 32'
    );
  }
  if (d.adminKeys.some((k) => k.length < 24)) problems.push('Every ADMIN_API_KEY must be at least 24 characters');
  if (!d.encryptionKey || d.encryptionKey.length < 32) {
    problems.push(
      'SECRETS_ENCRYPTION_KEY (at least 32 characters) is required: organizations\' signing secrets and ' +
        'workspace API keys are stored encrypted with it. Generate one with: openssl rand -hex 32. ' +
        'Keep it safe: losing it means every organization has to re-enter its secret and reinstall.'
    );
  }
  if (d.publicUrl && !/^https?:\/\//.test(d.publicUrl)) problems.push('PUBLIC_URL must start with https://');
  if (config.api.apiKeys.some((k) => k.length < 16)) {
    problems.push('Every API_KEY must be at least 16 characters');
  }
  if (!Number.isInteger(config.api.port) || config.api.port < 1 || config.api.port > 65535) {
    problems.push('PORT / API_PORT must be an integer between 1 and 65535');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid API configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
