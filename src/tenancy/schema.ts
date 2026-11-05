/**
 * The three tables the multi-tenant app needs, created on server startup if
 * they are missing (the same SQL is at the end of schema.sql / migration.sql).
 *
 *   deeluge_registrations   one row per organization that registered the app in
 *                           Deeluge: its signing secret(s), manifest settings
 *   deeluge_installations   one row per (registration, workspace) that installed
 *                           it - the organization's own workspace and every
 *                           workspace it shared the app with - holding that
 *                           workspace's Deeluge API key
 *   categorizer_api_keys    keys for this service's own API, per organization
 *                           (or operator-wide), stored as SHA-256 hashes
 */
import { dbQuery } from '../db.js';

export const REGISTRATIONS = 'public.deeluge_registrations';
export const INSTALLATIONS = 'public.deeluge_installations';
export const API_KEYS = 'public.categorizer_api_keys';

export const TENANCY_SQL = `
CREATE TABLE IF NOT EXISTS ${REGISTRATIONS} (
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

CREATE TABLE IF NOT EXISTS ${INSTALLATIONS} (
  registration_id      TEXT NOT NULL REFERENCES ${REGISTRATIONS}(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS ${API_KEYS} (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('admin', 'organization')),
  registration_id  TEXT REFERENCES ${REGISTRATIONS}(id) ON DELETE CASCADE,
  key_hash         TEXT NOT NULL UNIQUE,
  key_prefix       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  CHECK (role = 'admin' OR registration_id IS NOT NULL)
);
`;

export async function ensureTenancyTables(): Promise<void> {
  try {
    await dbQuery(TENANCY_SQL);
  } catch (err) {
    throw new Error(
      'Could not create the tenancy tables (run the end of migration.sql as a user that can): ' +
        (err instanceof Error ? err.message : String(err))
    );
  }
}
