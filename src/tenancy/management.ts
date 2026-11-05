/**
 * The management API: organizations (registrations), their signing secrets,
 * their workspaces' installations and their API keys.
 *
 * Who may do what:
 *   admin key (ADMIN_API_KEY or a stored admin key)  everything
 *   organization key                                  its own registration only
 *   nobody                                            POST /v1/registrations when OPEN_SIGNUP=true
 *
 * Routes (all JSON):
 *   GET    /v1/me
 *   POST   /v1/registrations                          create an organization (+ its first API key)
 *   GET    /v1/registrations                          admin: all; organization: its own
 *   GET    /v1/registrations/:id                      with installations and manifest URL
 *   PATCH  /v1/registrations/:id                      name, settings; disabled (admin)
 *   DELETE /v1/registrations/:id                      admin
 *   PUT    /v1/registrations/:id/signing-secret       { "signing_secret": "whsec_…" }
 *   GET    /v1/registrations/:id/manifest
 *   GET    /v1/registrations/:id/installations
 *   PUT    /v1/registrations/:id/installations/:ws    { "api_key", "api_base_url" } when app.installed never arrived
 *   DELETE /v1/registrations/:id/installations/:ws
 *   GET    /v1/registrations/:id/api-keys
 *   POST   /v1/registrations/:id/api-keys             { "name" } -> the key, once
 *   GET    /v1/api-keys                               admin
 *   POST   /v1/api-keys                               admin: { "name" } -> a new admin key, once
 *   DELETE /v1/api-keys/:id                           admin, or the key's own organization
 */
import { config } from '../config.js';
import { buildManifest, registrationBaseUrl } from '../deeluge/manifest.js';
import { createApiKey, getApiKey, listApiKeys, revokeApiKey, type Principal } from './apiKeys.js';
import { deleteInstallation, listInstallations, saveInstallation, type FieldMap } from './installations.js';
import {
  createRegistration,
  deleteRegistration,
  describeRegistration,
  getRegistration,
  listRegistrations,
  setSigningSecret,
  updateRegistration,
  ValidationError,
  type Registration,
} from './registrations.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface ManagementRequest {
  method: string;
  path: string;
  principal: Principal | null;
  body: unknown;
  /** This service's public address, for manifest URLs. */
  publicBaseUrl: string;
}

export interface ManagementResponse {
  status: number;
  body: unknown;
}

/** True for every path this module answers. */
export function isManagementPath(path: string): boolean {
  return path === '/v1/me' || /^\/v1\/(registrations|api-keys)(\/|$)/.test(path);
}

const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

function requireAuth(p: Principal | null): Principal {
  if (!p || p.role === 'legacy') throw new ApiError(401, 'unauthorized', 'Missing or invalid API key.');
  return p;
}
function requireAdmin(p: Principal | null): Principal {
  const a = requireAuth(p);
  if (a.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only an admin key can do this.');
  return a;
}

async function ownRegistration(p: Principal | null, id: string): Promise<Registration> {
  const a = requireAuth(p);
  if (a.role !== 'admin' && a.registrationId !== id) throw new ApiError(404, 'not_found', 'No such registration.');
  const reg = await getRegistration(id);
  if (!reg) throw new ApiError(404, 'not_found', 'No such registration.');
  return reg;
}

function view(reg: Registration, publicBaseUrl: string): Record<string, unknown> {
  const base = registrationBaseUrl(publicBaseUrl, reg);
  return {
    ...describeRegistration(reg),
    deeluge_url: base,
    manifest_url: `${base}/manifest.json`,
    status: reg.disabled ? 'disabled' : reg.hasSigningSecret ? 'ready' : 'waiting_for_signing_secret',
  };
}

function nextSteps(reg: Registration, publicBaseUrl: string): string[] {
  const steps = [
    `In Deeluge: Settings -> Developers -> Apps. Register a new app with the manifest from ${registrationBaseUrl(publicBaseUrl, reg)}/manifest.json ` +
      '(or, for an app you already registered, paste it over the current manifest - keep its "key").',
  ];
  if (!reg.hasSigningSecret) {
    steps.push(
      'Copy the app\'s signing secret (key icon on its row) and send it here: ' +
        `PUT /v1/registrations/${reg.id}/signing-secret { "signing_secret": "whsec_..." }.`
    );
  }
  steps.push('Install the app in your workspace (or uninstall and install again) so the categorizer receives the workspace\'s API key.');
  steps.push('To let other organizations use it: share the app in Deeluge (padlock icon) and send them the install link. Their installs use your registration.');
  return steps;
}

function wrapValidation<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e: unknown) => {
    if (e instanceof ValidationError) throw new ApiError(400, 'invalid_body', e.message, { problems: e.problems });
    throw e;
  });
}

export async function handleManagement(req: ManagementRequest): Promise<ManagementResponse> {
  const { method, principal: p, publicBaseUrl } = req;
  const parts = req.path.split('/').filter(Boolean).map(decodeURIComponent); // ['v1', 'registrations', ...]
  const body = obj(req.body);
  const not = (): never => {
    throw new ApiError(405, 'method_not_allowed', `${method} is not supported on ${req.path}.`);
  };

  /* ------------------------------------------------------------ /v1/me */
  if (parts[1] === 'me') {
    const a = requireAuth(p);
    const reg = a.registrationId ? await getRegistration(a.registrationId) : null;
    return { status: 200, body: { role: a.role, key_id: a.keyId, registration: reg ? view(reg, publicBaseUrl) : null } };
  }

  /* ------------------------------------------------------- /v1/api-keys */
  if (parts[1] === 'api-keys') {
    const keyId = parts[2];
    if (!keyId) {
      requireAdmin(p);
      if (method === 'GET') return { status: 200, body: { data: await listApiKeys(null) } };
      if (method === 'POST') {
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Admin key';
        const { key, summary } = await createApiKey({ name, role: 'admin', registrationId: null });
        return { status: 201, body: { api_key: key, key: summary, note: 'Shown once. Store it now.' } };
      }
      return not();
    }
    if (method !== 'DELETE') return not();
    const a = requireAuth(p);
    const existing = await getApiKey(keyId);
    if (!existing || (a.role !== 'admin' && existing.registration_id !== a.registrationId)) {
      throw new ApiError(404, 'not_found', 'No such key.');
    }
    await revokeApiKey(keyId);
    return { status: 200, body: { revoked: keyId } };
  }

  /* -------------------------------------------------- /v1/registrations */
  const id = parts[2];
  const sub = parts[3];

  if (!id) {
    if (method === 'POST') {
      if (!config.deeluge.openSignup) requireAdmin(p);
      const reg = await wrapValidation(() =>
        createRegistration({ name: body.name, settings: body.settings, signingSecret: body.signing_secret })
      );
      const { key, summary } = await createApiKey({ name: `${reg.name} key`, role: 'organization', registrationId: reg.id });
      return {
        status: 201,
        body: {
          registration: view(reg, publicBaseUrl),
          api_key: key,
          api_key_info: summary,
          manifest: buildManifest(publicBaseUrl, reg),
          next_steps: nextSteps(reg, publicBaseUrl),
          note: 'api_key is shown once: it is how this organization manages its registration and calls /v1/companies/categorize.',
        },
      };
    }
    if (method === 'GET') {
      const a = requireAuth(p);
      const regs = a.role === 'admin' ? await listRegistrations() : (await listRegistrations()).filter((r) => r.id === a.registrationId);
      return { status: 200, body: { data: regs.map((r) => view(r, publicBaseUrl)) } };
    }
    return not();
  }

  const reg = await ownRegistration(p, id);

  if (!sub) {
    if (method === 'GET') {
      return {
        status: 200,
        body: {
          ...view(reg, publicBaseUrl),
          installations: await listInstallations(reg.id),
          next_steps: nextSteps(reg, publicBaseUrl),
        },
      };
    }
    if (method === 'PATCH') {
      if (body.disabled !== undefined) requireAdmin(p);
      const updated = await wrapValidation(() =>
        updateRegistration(reg.id, { name: body.name, settings: body.settings, disabled: body.disabled })
      );
      return {
        status: 200,
        body: {
          ...view(updated as Registration, publicBaseUrl),
          note: 'If settings changed, paste the new manifest into Deeluge; other workspaces get it once their admins accept the update.',
        },
      };
    }
    if (method === 'DELETE') {
      requireAdmin(p);
      await deleteRegistration(reg.id);
      return { status: 200, body: { deleted: reg.id } };
    }
    return not();
  }

  switch (sub) {
    case 'signing-secret': {
      if (method !== 'PUT' && method !== 'POST') return not();
      const updated = await wrapValidation(() => setSigningSecret(reg.id, body.signing_secret));
      return { status: 200, body: { ...view(updated as Registration, publicBaseUrl), note: 'Signing secret saved. The previous one keeps working for an hour.' } };
    }
    case 'manifest':
      if (method !== 'GET') return not();
      return { status: 200, body: buildManifest(publicBaseUrl, reg) };
    case 'api-keys': {
      if (method === 'GET') return { status: 200, body: { data: await listApiKeys(reg.id) } };
      if (method === 'POST') {
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `${reg.name} key`;
        const { key, summary } = await createApiKey({ name, role: 'organization', registrationId: reg.id });
        return { status: 201, body: { api_key: key, key: summary, note: 'Shown once. Store it now.' } };
      }
      return not();
    }
    case 'installations': {
      const ws = parts[4];
      if (!ws) {
        if (method !== 'GET') return not();
        return { status: 200, body: { data: await listInstallations(reg.id) } };
      }
      if (method === 'DELETE') {
        const removed = await deleteInstallation(reg.id, ws);
        if (!removed) throw new ApiError(404, 'not_found', 'No such installation.');
        return { status: 200, body: { deleted: ws } };
      }
      if (method === 'PUT') {
        // For a workspace whose key was shown on screen instead of being sent
        // to the lifecycle URL (e.g. the categorizer was down at install time).
        const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
        const apiBaseUrl = typeof body.api_base_url === 'string' ? body.api_base_url.trim().replace(/\/+$/, '') : '';
        const problems: string[] = [];
        if (!apiKey.startsWith('sf_live_')) problems.push('api_key must be the workspace\'s sf_live_… key for this app.');
        if (!/^https?:\/\/.+\/api\/v1$/.test(apiBaseUrl)) problems.push('api_base_url must look like https://app.deeluge.com/api/v1.');
        const fields = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? (body.fields as FieldMap) : {};
        if (problems.length) throw new ApiError(400, 'invalid_body', problems.join(' '), { problems });
        await saveInstallation({
          registrationId: reg.id,
          workspaceId: ws,
          workspaceName: typeof body.workspace_name === 'string' ? body.workspace_name : null,
          installationId: null,
          apiKey,
          apiBaseUrl,
          fields,
        });
        return {
          status: 200,
          body: {
            saved: ws,
            note: Object.keys(fields).length
              ? 'Saved.'
              : 'Saved. The column mapping fills in with the first action or panel request from that workspace.',
          },
        };
      }
      return not();
    }
    default:
      throw new ApiError(404, 'not_found', 'No such route.');
  }
}
