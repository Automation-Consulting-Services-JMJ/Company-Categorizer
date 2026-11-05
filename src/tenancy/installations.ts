/**
 * Every workspace that installed an organization's registration of the app:
 * the organization's own workspace, and each workspace it shared the app with.
 * Each has its own Deeluge API key (delivered by `app.installed`), API address
 * and column mapping, keyed by (registration, workspace).
 */
import { dbQuery } from '../db.js';
import { seal, unseal } from './crypto.js';
import { INSTALLATIONS } from './schema.js';

/** The app's own field key -> where it landed in this workspace. */
export type FieldMap = Record<string, { object: string; attribute_key: string }>;

export interface Installation {
  registrationId: string;
  workspaceId: string;
  workspaceName: string | null;
  installationId: string | null;
  apiKey: string;
  apiBaseUrl: string;
  fields: FieldMap;
}

export interface InstallationSummary {
  workspace_id: string;
  workspace_name: string | null;
  installation_id: string | null;
  api_base_url: string;
  columns: FieldMap;
  categorized_count: number;
  last_categorized_at: string | null;
  installed_at: string;
}

interface Row {
  registration_id: string;
  workspace_id: string;
  workspace_name: string | null;
  installation_id: string | null;
  api_key: string;
  api_base_url: string;
  fields: FieldMap | null;
  categorized_count: number;
  last_categorized_at: Date | null;
  installed_at: Date;
}

// Widgets are asked for on every record page view and have three seconds,
// so a short in-process cache saves a database round trip each time.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: Installation | null }>();
const ck = (registrationId: string, workspaceId: string): string => `${registrationId}|${workspaceId}`;

export async function getInstallation(registrationId: string, workspaceId: string): Promise<Installation | null> {
  const key = ck(registrationId, workspaceId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { rows } = await dbQuery<Row>(
    `SELECT * FROM ${INSTALLATIONS} WHERE registration_id = $1 AND workspace_id = $2`,
    [registrationId, workspaceId]
  );
  const row = rows[0];
  const value: Installation | null = row
    ? {
        registrationId: row.registration_id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        installationId: row.installation_id,
        apiKey: unseal(row.api_key),
        apiBaseUrl: row.api_base_url,
        fields: row.fields ?? {},
      }
    : null;
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function saveInstallation(install: Installation): Promise<void> {
  await dbQuery(
    `INSERT INTO ${INSTALLATIONS}
       (registration_id, workspace_id, workspace_name, installation_id, api_key, api_base_url, fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (registration_id, workspace_id) DO UPDATE SET
       workspace_name  = COALESCE(EXCLUDED.workspace_name, ${INSTALLATIONS}.workspace_name),
       installation_id = COALESCE(EXCLUDED.installation_id, ${INSTALLATIONS}.installation_id),
       api_key         = EXCLUDED.api_key,
       api_base_url    = EXCLUDED.api_base_url,
       fields          = CASE WHEN EXCLUDED.fields = '{}'::jsonb THEN ${INSTALLATIONS}.fields ELSE EXCLUDED.fields END,
       updated_at      = now()`,
    [
      install.registrationId,
      install.workspaceId,
      install.workspaceName,
      install.installationId,
      seal(install.apiKey),
      install.apiBaseUrl,
      JSON.stringify(install.fields),
    ]
  );
  cache.delete(ck(install.registrationId, install.workspaceId));
}

/** Keeps the column mapping current: actions, widgets and app.updated all carry it. */
export async function updateFields(registrationId: string, workspaceId: string, fields: FieldMap): Promise<void> {
  const current = await getInstallation(registrationId, workspaceId);
  if (!current || JSON.stringify(current.fields) === JSON.stringify(fields)) return;
  await dbQuery(
    `UPDATE ${INSTALLATIONS} SET fields = $3::jsonb, updated_at = now() WHERE registration_id = $1 AND workspace_id = $2`,
    [registrationId, workspaceId, JSON.stringify(fields)]
  );
  cache.set(ck(registrationId, workspaceId), { at: Date.now(), value: { ...current, fields } });
}

export async function deleteInstallation(registrationId: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `DELETE FROM ${INSTALLATIONS} WHERE registration_id = $1 AND workspace_id = $2`,
    [registrationId, workspaceId]
  );
  cache.delete(ck(registrationId, workspaceId));
  return (rowCount ?? 0) > 0;
}

/** Deeluge says to count usage per workspace on the app's side; this is that count. */
export async function recordUsage(registrationId: string, workspaceId: string): Promise<void> {
  await dbQuery(
    `UPDATE ${INSTALLATIONS}
        SET categorized_count = categorized_count + 1, last_categorized_at = now()
      WHERE registration_id = $1 AND workspace_id = $2`,
    [registrationId, workspaceId]
  );
}

export async function listInstallations(registrationId: string): Promise<InstallationSummary[]> {
  const { rows } = await dbQuery<Row>(
    `SELECT * FROM ${INSTALLATIONS} WHERE registration_id = $1 ORDER BY installed_at`,
    [registrationId]
  );
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    workspace_name: r.workspace_name,
    installation_id: r.installation_id,
    api_base_url: r.api_base_url,
    columns: r.fields ?? {},
    categorized_count: r.categorized_count,
    last_categorized_at: r.last_categorized_at ? r.last_categorized_at.toISOString() : null,
    installed_at: r.installed_at.toISOString(),
  }));
}

export function clearInstallationCache(): void {
  cache.clear();
}
