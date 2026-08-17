import type { AirtableGrantIdentity, AirtableOAuthScope } from '@jooevents/airtable';
import type { ManagedBaseManifest } from './manifest';

export const MANAGED_PROVISIONING_SCOPES = Object.freeze([
  'schema.bases:read',
  'schema.bases:write',
  'data.records:read',
  'data.records:write',
  'user.email:read'
] as const satisfies readonly AirtableOAuthScope[]);

export interface ManagedCapabilityPreview {
  readonly ready: boolean;
  readonly missingScopes: readonly AirtableOAuthScope[];
  readonly tableCount: number;
  readonly fieldCount: number;
  readonly includesPersonalContact: readonly ('speaker_email' | 'speaker_phone')[];
  readonly inboundEffectiveFieldCount: number;
  readonly requestFieldCount: number;
}

export function previewManagedProvisioning(input: Readonly<{
  identity: AirtableGrantIdentity;
  manifest: ManagedBaseManifest;
}>): ManagedCapabilityPreview {
  const granted = new Set(input.identity.scopes);
  const missingScopes = MANAGED_PROVISIONING_SCOPES.filter((scope) => !granted.has(scope));
  const fields = input.manifest.tables.flatMap((table) => table.fields);
  const contacts: Array<'speaker_email' | 'speaker_phone'> = [];
  const speakerFields = input.manifest.tables.find((table) => table.key === 'speakers')?.fields ?? [];
  if (speakerFields.some((field) => field.key === 'email')) contacts.push('speaker_email');
  if (speakerFields.some((field) => field.key === 'phone')) contacts.push('speaker_phone');
  return Object.freeze({
    ready: missingScopes.length === 0,
    missingScopes: Object.freeze(missingScopes),
    tableCount: input.manifest.tables.length,
    fieldCount: fields.length,
    includesPersonalContact: Object.freeze(contacts),
    inboundEffectiveFieldCount: fields.filter((field) => field.authority === 'editable').length,
    requestFieldCount: fields.filter((field) => field.authority === 'request').length
  });
}
