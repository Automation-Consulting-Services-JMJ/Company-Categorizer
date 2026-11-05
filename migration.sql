-- Run this against an EXISTING company_metadata table (the one that already
-- holds your rows). It is additive and idempotent: no data is rewritten.

-- 0. Crawl output columns. REQUIRED: the app refuses to start without them.
--    sitemap      - URLs Tavily Map discovered on the site, one per line
--    scraped_text - the exact markdown text that was sent to the model
ALTER TABLE public.company_metadata
  ADD COLUMN IF NOT EXISTS sitemap TEXT,
  ADD COLUMN IF NOT EXISTS scraped_text TEXT;

-- 0b. ONLY if you already ran an earlier version of this migration that created
--     `sitemap` as JSONB: convert it to TEXT, keeping existing data (one URL per
--     line). Uncomment and run all four statements together.
-- BEGIN;
-- ALTER TABLE public.company_metadata ADD COLUMN sitemap_text TEXT;
-- UPDATE public.company_metadata
--    SET sitemap_text = (SELECT string_agg(u, E'\n') FROM jsonb_array_elements_text(sitemap) AS u)
--  WHERE jsonb_typeof(sitemap) = 'array';
-- ALTER TABLE public.company_metadata DROP COLUMN sitemap;
-- ALTER TABLE public.company_metadata RENAME COLUMN sitemap_text TO sitemap;
-- COMMIT;

-- 1. Index the unprocessed rows so the claim query doesn't scan the table.
CREATE INDEX IF NOT EXISTS company_metadata_pending_idx
  ON public.company_metadata (created_at)
  WHERE COALESCE(lower(metadata->>'checked') IN ('true','t','yes','1','y'), false) IS NOT TRUE;

CREATE INDEX IF NOT EXISTS company_metadata_domain_idx
  ON public.company_metadata ((metadata->>'domain'));

-- Used by the HTTP API's "have we already researched this domain?" lookup,
-- which compares lower(metadata->>'domain'). The index above is on the
-- un-lowered value, so Postgres cannot use it for that comparison.
CREATE INDEX IF NOT EXISTS company_metadata_domain_lower_idx
  ON public.company_metadata ((lower(metadata->>'domain')));

-- 2. Spend-tracking view.
CREATE OR REPLACE VIEW public.company_token_usage AS
SELECT
  id,
  metadata->>'domain'                                                       AS domain,
  metadata->>'category'                                                     AS category,
  COALESCE(NULLIF(metadata->>'input_tokens','')::numeric, 0)                AS input_tokens,
  COALESCE(NULLIF(metadata->>'output_tokens','')::numeric, 0)               AS output_tokens,
  COALESCE(NULLIF(metadata->>'cache_read_input_tokens','')::numeric, 0)     AS cache_read_input_tokens,
  COALESCE(NULLIF(metadata->>'cache_creation_input_tokens','')::numeric, 0) AS cache_creation_input_tokens,
  metadata->>'checked_at'                                                   AS checked_at,
  metadata->>'scrape_provider'                                              AS scrape_provider
FROM public.company_metadata;

-- 3. OPTIONAL: clear stale claim stamps left by a process that was killed
--    mid-run. The pipeline already reclaims these after STALE_CLAIM_MS, so
--    this is only for forcing an immediate retry.
-- UPDATE public.company_metadata
--    SET metadata = metadata - 'processing_started_at'
--  WHERE metadata ? 'processing_started_at';

-- 4. OPTIONAL: reset a batch of rows to be reprocessed from scratch.
-- UPDATE public.company_metadata
--    SET metadata = metadata || '{"checked": null, "errors": null}'::jsonb
--  WHERE metadata->>'domain' IN ('example.com');

-- ============================================================================
-- Multi-tenant Deeluge app (README "Deeluge app"). The server also creates
-- these on startup if its database user may.
--   deeluge_registrations  one per organization that registered the app in Deeluge
--   deeluge_installations  one per (registration, workspace) that installed it
--   categorizer_api_keys   keys for this service's API, stored as SHA-256 hashes
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.deeluge_registrations (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  -- [{ "secret": "enc:v1:...", "added_at": "...", "expires_at": null | "..." }]
  signing_secrets  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The Deeluge app id, learned from the first verified request that carries it.
  deeluge_app_id   TEXT,
  settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
  disabled         BOOLEAN NOT NULL DEFAULT false,
  last_request_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.deeluge_installations (
  registration_id      TEXT NOT NULL REFERENCES public.deeluge_registrations(id) ON DELETE CASCADE,
  workspace_id         TEXT NOT NULL,
  workspace_name       TEXT,
  installation_id      TEXT,
  api_key              TEXT NOT NULL,   -- enc:v1:..., the workspace's sf_live_ key
  api_base_url         TEXT NOT NULL,
  fields               JSONB NOT NULL DEFAULT '{}'::jsonb,
  categorized_count    INTEGER NOT NULL DEFAULT 0,
  last_categorized_at  TIMESTAMPTZ,
  installed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (registration_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS public.categorizer_api_keys (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('admin', 'organization')),
  registration_id  TEXT REFERENCES public.deeluge_registrations(id) ON DELETE CASCADE,
  key_hash         TEXT NOT NULL UNIQUE,
  key_prefix       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  CHECK (role = 'admin' OR registration_id IS NOT NULL)
);
