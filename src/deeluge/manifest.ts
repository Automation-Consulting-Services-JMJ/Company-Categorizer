/**
 * One organization's manifest, to paste into Deeluge -> Settings -> Developers
 * -> Apps. Every URL carries the organization's registration id, so requests
 * are checked against its own signing secret.
 *
 * With the default settings this reproduces the existing "Company Categorizer"
 * app - same app key, same column keys (account_category,
 * opportunity_category), same action and widget keys - so switching an
 * existing app over keeps its columns and their values.
 */
import { config } from '../config.js';
import type { Registration } from '../tenancy/registrations.js';

/** accounts -> account, opportunities -> opportunity, companies -> company. */
export function singular(objectKey: string): string {
  if (objectKey.endsWith('ies')) return `${objectKey.slice(0, -3)}y`;
  if (objectKey.endsWith('ses')) return objectKey.slice(0, -2);
  if (objectKey.endsWith('s')) return objectKey.slice(0, -1);
  return objectKey;
}

const fieldKey = (object: string, suffix: string): string => `${singular(object)}_${suffix}`.slice(0, 40);

export function registrationBaseUrl(publicBaseUrl: string, reg: Registration): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/deeluge/r/${reg.id}`;
}

export function buildManifest(publicBaseUrl: string, reg: Registration): Record<string, unknown> {
  const s = reg.settings;
  const base = registrationBaseUrl(publicBaseUrl, reg);
  const objects = s.objects;
  const d = config.deeluge;
  const developer = s.developer ?? { name: d.developer.name, url: d.developer.url ?? null, email: d.developer.email ?? null };

  const events = [
    ...(s.categorize_on_create ? ['record.created'] : []),
    ...(s.categorize_on_domain_change ? ['record.updated'] : []),
  ];

  return {
    manifest_version: 1,
    key: s.app_key,
    name: s.app_name,
    description: s.description,
    developer,
    icon_url: d.iconUrl ?? null,
    homepage_url: d.homepageUrl ?? null,
    scopes: [
      // To read an opportunity's linked account, and the workspace's columns.
      { scope: 'objects:read', objects: null },
      { scope: 'records:read', objects },
      { scope: 'records:write', objects },
    ],
    fields: objects.flatMap((object) => [
      { key: fieldKey(object, 'category'), object, name: 'Category', type: 'text', options: null, currency: null },
      ...(s.sub_category_column
        ? [{ key: fieldKey(object, 'sub_category'), object, name: 'Sub-category', type: 'text', options: null, currency: null }]
        : []),
    ]),
    webhooks: events.length && s.auto_objects.length ? [{ url: `${base}/webhooks`, events, objects: s.auto_objects }] : [],
    record_actions: [
      { key: 'categorize', label: 'Categorize company', objects, url: `${base}/actions/categorize`, confirm: null },
      ...(s.recategorize_action
        ? [
            {
              key: 'recategorize',
              label: 'Research category again',
              objects,
              url: `${base}/actions/recategorize`,
              confirm: 'Research this company again? This re-scrapes its website and spends model credits.',
            },
          ]
        : []),
    ],
    record_widgets: [{ key: 'categorizer', title: 'Company category', objects, type: 'card', url: `${base}/widgets/categorizer` }],
    lifecycle_url: `${base}/lifecycle`,
  };
}
