import type { SecretStore, SecretStoreAdapterRef } from '@jooevents/application';
import type { AirtableDataPort, AirtableWebhookPort } from '@jooevents/airtable';
import type { CanonicalJson } from '@jooevents/kernel';
import {
  createManagedAirtableWebhook,
  type AirtableWebhookLifecycleRepository
} from './webhook-lifecycle';
import type { CompiledMapping } from './mapping';
import type { ManagedBaseManifest } from './manifest';
import {
  runManagedProvisioningStep,
  type ManagedProvisioningRepository,
  type ManagedProvisioningState,
  type ManagedSnapshotSource
} from './provisioning';

export interface AirtableActivationRepository
extends ManagedProvisioningRepository, AirtableWebhookLifecycleRepository {
  readProvisioningActivation(connectionId: string): Readonly<{
    connectionVersion: number;
    publicCallbackRef: string;
    provisioning: ManagedProvisioningState;
    mappingRevision: number;
    mapping: CanonicalJson;
    webhookActive: boolean;
  }> | undefined | Promise<Readonly<{
    connectionVersion: number;
    publicCallbackRef: string;
    provisioning: ManagedProvisioningState;
    mappingRevision: number;
    mapping: CanonicalJson;
    webhookActive: boolean;
  }> | undefined>;
  finalizeProvisioningActivation(input: Readonly<{
    connectionId: string;
    expectedConnectionVersion: number;
    mappingRevision: number;
    nowMs: number;
  }>): boolean | Promise<boolean>;
}

export type AirtableActivationStepResult =
  | Readonly<{ kind: 'advanced' | 'activated' | 'idle' | 'stale' }>
  | Readonly<{ kind: 'retry'; code: string; retryAfterMs: number }>
  | Readonly<{ kind: 'attention'; code: string }>;

function watchedFieldIds(input: Readonly<{
  mapping: CompiledMapping;
  state: ManagedProvisioningState;
  manifest: ManagedBaseManifest;
}>): readonly import('@jooevents/airtable').AirtableFieldId[] {
  const connected = new Set(input.mapping.areas
    .filter((area) => area.direction !== 'not_connected')
    .map((area) => area.areaKey));
  const ids = (input.state.binding?.tables ?? []).flatMap((binding) => {
    const included = binding.key === 'events' ? connected.size > 0
      : binding.key === 'speakers' ? connected.has('people')
        : binding.key === 'sessions' ? connected.has('sessions') || connected.has('schedule')
          : connected.has(binding.key as typeof input.mapping.areas[number]['areaKey']);
    if (!included) return [];
    const table = input.manifest.tables.find((candidate) => candidate.key === binding.key);
    if (!table) return [];
    const watchedKeys = new Set(table.fields
      .filter((field) => field.authority !== 'control')
      .map((field) => field.key));
    return binding.fields.filter((field) => watchedKeys.has(field.key)).map((field) => field.fieldId);
  });
  return Object.freeze([...new Set(ids)].sort());
}

/** Advances one durable activation unit; a crash after ready resumes at webhook creation. */
export async function runAirtableActivationStep(input: Readonly<{
  connectionId: string;
  workerId: string;
  nowMs: number;
  baseUrl: string;
  manifest: ManagedBaseManifest;
  repository: AirtableActivationRepository;
  provider: AirtableDataPort;
  webhooks: AirtableWebhookPort;
  source: ManagedSnapshotSource;
  secretStore: SecretStore;
  secretAdapter: SecretStoreAdapterRef;
}>): Promise<AirtableActivationStepResult> {
  let activation = await input.repository.readProvisioningActivation(input.connectionId);
  if (!activation) return { kind: 'idle' };
  if (activation.provisioning.phase !== 'ready') {
    const step = await runManagedProvisioningStep({
      connectionId: input.connectionId,
      workerId: input.workerId,
      nowMs: input.nowMs,
      leaseMs: 30_000,
      manifest: input.manifest,
      repository: input.repository,
      provider: input.provider,
      source: input.source
    });
    if (step.kind === 'attention') return step;
    if (step.kind === 'stale') return step;
    activation = await input.repository.readProvisioningActivation(input.connectionId);
    if (!activation || activation.provisioning.phase !== 'ready') {
      return step.kind === 'idle' ? { kind: 'idle' } : { kind: 'advanced' };
    }
  }
  const mapping = activation.mapping as unknown as CompiledMapping;
  if (!activation.webhookActive) {
    const binding = activation.provisioning.binding;
    if (!binding) return { kind: 'attention', code: 'provisioning_binding_missing' };
    const callback = new URL(
      `/api/webhooks/airtable/${encodeURIComponent(activation.publicCallbackRef)}`,
      input.baseUrl
    ).toString();
    const created = await createManagedAirtableWebhook({
      connectionId: input.connectionId,
      baseId: binding.baseId,
      notificationUrl: callback,
      tableIds: binding.tables.map((table) => table.tableId),
      watchedFieldIds: watchedFieldIds({
        mapping, state: activation.provisioning, manifest: input.manifest
      }),
      webhooks: input.webhooks,
      secretStore: input.secretStore,
      secretAdapter: input.secretAdapter,
      repository: input.repository,
      nowMs: input.nowMs
    });
    if (created.kind === 'retry') return created;
    if (created.kind === 'attention') return created;
  }
  const finalized = await input.repository.finalizeProvisioningActivation({
    connectionId: input.connectionId,
    expectedConnectionVersion: activation.connectionVersion,
    mappingRevision: activation.mappingRevision,
    nowMs: input.nowMs
  });
  return finalized ? { kind: 'activated' } : { kind: 'stale' };
}
