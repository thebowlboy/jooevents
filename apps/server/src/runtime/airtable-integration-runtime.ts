import type { SecretStore, SecretStoreAdapterRef } from '@jooevents/application';
import {
  airtableIntegrationViewSchema,
  type AirtableActivationInput,
  type AirtableAreaDirection,
  type AirtableIntegrationAreaKey,
  type AirtableIntegrationView,
  type AirtableSelectableBase
} from '@jooevents/contracts';
import {
  AIRTABLE_OAUTH_SCOPES,
  parseAirtableBaseId,
  type AirtableDataPort,
  type AirtableOAuthGrant,
  type AirtableOAuthPort,
  type AirtableProviderResult
} from '@jooevents/airtable';
import {
  compileInitialAirtableMapping,
  createAirtableOAuthCoordinator,
  createDefaultManagedBaseManifest,
  createManagedSelectedBaseProvisioningState,
  type AirtableOAuthCoordinatorRepository,
  type ConnectionState,
  type ManagedProvisioningState,
  type StoredAirtableOAuthGrant
} from '@jooevents/airtable-sync';
import type { CanonicalJson } from '@jooevents/kernel';
import type {
  AirtableIntegrationAction,
  AirtableIntegrationHttpRuntime
} from '../http/airtable-integration';

export interface AirtableRuntimeConnection {
  readonly id: string;
  readonly workspaceId: string;
  readonly publicCallbackRef?: string;
  readonly state: ConnectionState;
  readonly version: number;
  readonly providerAccountId?: string;
  readonly grant?: StoredAirtableOAuthGrant;
  readonly provisioning?: ManagedProvisioningState;
  readonly mapping?: Readonly<{ revision: number; value: CanonicalJson }>;
}

export interface AirtableIntegrationRuntimeRepository extends AirtableOAuthCoordinatorRepository {
  readWorkspaceConnection(workspaceId: string): AirtableRuntimeConnection | undefined | Promise<AirtableRuntimeConnection | undefined>;
  retireDraftConnection(input: Readonly<{ workspaceId: string; nowMs: number }>): void | Promise<void>;
  activateSelectedBase(input: Readonly<{
    connectionId: string;
    expectedConnectionVersion: number;
    provisioning: ManagedProvisioningState;
    mappingId: string;
    mappingRevision: number;
    manifestVersion: number;
    mappingDigest: string;
    mapping: CanonicalJson;
    nowMs: number;
  }>): boolean | Promise<boolean>;
}

export interface AirtableIntegrationRuntimeControls {
  setSharing(input: Readonly<{
    connection: AirtableRuntimeConnection;
    areaKey: AirtableIntegrationAreaKey;
    direction: AirtableAreaDirection;
  }>): Promise<void>;
  syncNow(connection: AirtableRuntimeConnection): Promise<void>;
  setPaused(connection: AirtableRuntimeConnection, paused: boolean): Promise<void>;
  revertHistory(connection: AirtableRuntimeConnection, historyId: string): Promise<void>;
  disconnect(connection: AirtableRuntimeConnection): Promise<void>;
  readHistory?(connection: AirtableRuntimeConnection): Promise<AirtableIntegrationView['history']>;
  readAttention?(connection: AirtableRuntimeConnection): Promise<AirtableIntegrationView['attention']>;
  readStatus?(connection: AirtableRuntimeConnection): Promise<Readonly<{
    state?: AirtableIntegrationView['state'];
    lastOutbound?: string;
    lastInbound?: string;
    lastFullCheck?: string;
    lastFullCheckSummary?: string;
  }>>;
}

type AirtableRuntimeStatus = Awaited<ReturnType<NonNullable<
  AirtableIntegrationRuntimeControls['readStatus']
>>>;

const areaFacts = Object.freeze([
  { key: 'people', label: 'People and speakers', sharedFields: 14, editableFields: 0, requestFields: 2 },
  { key: 'submissions', label: 'Submissions', sharedFields: 8, editableFields: 0, requestFields: 0 },
  { key: 'sessions', label: 'Sessions', sharedFields: 9, editableFields: 0, requestFields: 0 },
  { key: 'schedule', label: 'Schedule', sharedFields: 6, editableFields: 0, requestFields: 0 },
  { key: 'tasks', label: 'Speaker tasks', sharedFields: 10, editableFields: 1, requestFields: 0 }
] as const);

const recommendedDirections: Readonly<Record<AirtableIntegrationAreaKey, AirtableAreaDirection>> = Object.freeze({
  people: 'work_from_airtable',
  submissions: 'keep_airtable_updated',
  sessions: 'keep_airtable_updated',
  schedule: 'keep_airtable_updated',
  tasks: 'work_from_airtable'
});

function directionMap(connection?: AirtableRuntimeConnection): ReadonlyMap<string, AirtableAreaDirection> {
  const areas = connection?.mapping?.value && typeof connection.mapping.value === 'object'
    && !Array.isArray(connection.mapping.value) && 'areas' in connection.mapping.value
    ? connection.mapping.value.areas : undefined;
  if (!Array.isArray(areas)) return new Map(Object.entries(recommendedDirections));
  return new Map(areas.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('areaKey' in candidate) || !('direction' in candidate)
      || typeof candidate.areaKey !== 'string' || typeof candidate.direction !== 'string') return [];
    if (!['not_connected', 'keep_airtable_updated', 'work_from_airtable'].includes(candidate.direction)) return [];
    return [[candidate.areaKey, candidate.direction as AirtableAreaDirection] as const];
  }));
}

function areas(connection?: AirtableRuntimeConnection): AirtableIntegrationView['areas'] {
  const directions = directionMap(connection);
  return areaFacts.map((area) => Object.freeze({
    ...area,
    direction: directions.get(area.key) ?? recommendedDirections[area.key]
  }));
}

function providerError(result: AirtableProviderResult<unknown>): never {
  if (result.kind === 'success') throw new TypeError('airtable_provider_error_expected');
  throw new Error(`airtable_${result.failure.code}`);
}

/** Composes the owner-facing HTTP runtime without allowing browser input to select operations or field policy. */
export function createAirtableIntegrationRuntime(input: Readonly<{
  workspaceId: string;
  baseUrl: string;
  clientId: string;
  oauth: AirtableOAuthPort;
  repository: AirtableIntegrationRuntimeRepository;
  secretStore: SecretStore;
  secretAdapter: SecretStoreAdapterRef;
  providerForGrant(stored: StoredAirtableOAuthGrant): AirtableDataPort;
  inspectGrant(grant: AirtableOAuthGrant): Promise<ReturnType<AirtableDataPort['getGrantIdentity']> extends Promise<infer Result> ? Result : never>;
  authorize(input: Readonly<{ request: Request; action: AirtableIntegrationAction }>): Promise<'authorized' | 'unauthenticated' | 'forbidden'>;
  controls: AirtableIntegrationRuntimeControls;
  onActivationCommitted?(connectionId: string): void | Promise<void>;
  newId?: () => string;
  newCallbackRef?: () => string;
  now?: () => number;
}>): AirtableIntegrationHttpRuntime {
  const now = input.now ?? Date.now;
  const newId = input.newId ?? crypto.randomUUID;
  const newCallbackRef = input.newCallbackRef ?? (() => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return `airtable-callback-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  });
  const redirectUri = new URL('/api/integrations/airtable/oauth/callback', input.baseUrl).toString();
  const coordinator = createAirtableOAuthCoordinator({
    clientId: input.clientId,
    oauth: input.oauth,
    repository: input.repository,
    secretStore: input.secretStore,
    secretAdapter: input.secretAdapter,
    inspectGrant: input.inspectGrant,
    workerId: `airtable-oauth:${input.workspaceId}`,
    now
  });

  const current = async (): Promise<AirtableRuntimeConnection | undefined> =>
    input.repository.readWorkspaceConnection(input.workspaceId);
  const requireConnection = async (): Promise<AirtableRuntimeConnection> => {
    const connection = await current();
    if (!connection?.grant) throw new Error('airtable_connection_missing');
    return connection;
  };
  const read = async (): Promise<AirtableIntegrationView> => {
    const connection = await current();
    if (!connection) return airtableIntegrationViewSchema.parse({
      state: 'not_connected', areas: areas(), attention: [], history: []
    });
    const setupStage = connection.state === 'draft' && connection.grant
      ? 'choose_base' as const
      : connection.state === 'provisioning' ? 'adding_tables' as const : undefined;
    const providerBaseId = connection.provisioning?.providerBaseId ?? connection.provisioning?.binding?.baseId;
    const fallbackState = setupStage ? 'provisioning' as const
      : connection.state === 'active' ? 'current' as const
        : connection.state === 'paused' ? 'paused' as const
          : connection.state === 'needs_reconnect' ? 'needs_reconnect' as const
            : connection.state === 'disconnected' ? 'not_connected' as const : 'pending' as const;
    const [attention, history, status] = await Promise.all([
      input.controls.readAttention?.(connection) ?? Promise.resolve([]),
      input.controls.readHistory?.(connection) ?? Promise.resolve([]),
      input.controls.readStatus?.(connection) ?? Promise.resolve<AirtableRuntimeStatus>({})
    ]);
    return airtableIntegrationViewSchema.parse({
      ...status,
      state: setupStage ? fallbackState : status.state ?? fallbackState,
      ...(setupStage ? { setupStage } : {}),
      ...(connection.provisioning?.baseName ? { baseName: connection.provisioning.baseName } : {}),
      ...(providerBaseId ? { baseUrl: `https://airtable.com/${providerBaseId}` } : {}),
      ...(connection.providerAccountId ? { accountLabel: 'Airtable account' } : {}),
      supportCode: `airtable-${connection.id}`,
      areas: areas(connection), attention, history
    });
  };

  const runtime: AirtableIntegrationHttpRuntime = {
    authorize: input.authorize,
    read,
    async startOAuth() {
      const previous = await current();
      if ((previous?.state === 'draft' || previous?.state === 'needs_reconnect') && previous.grant) {
        await input.secretStore.revoke({
          reference: previous.grant.secretReference,
          expectedVersion: previous.grant.secretReference.version
        });
      }
      if (previous?.state === 'needs_reconnect') {
        if (!previous.publicCallbackRef) throw new Error('airtable_reconnect_anchor_missing');
        return coordinator.start({
          connectionId: previous.id,
          workspaceId: input.workspaceId,
          publicCallbackRef: previous.publicCallbackRef,
          attemptId: newId(),
          redirectUri,
          scopes: AIRTABLE_OAUTH_SCOPES
        });
      }
      await input.repository.retireDraftConnection({ workspaceId: input.workspaceId, nowMs: now() });
      return coordinator.start({
        connectionId: newId(), workspaceId: input.workspaceId,
        publicCallbackRef: newCallbackRef(), attemptId: newId(), redirectUri,
        scopes: AIRTABLE_OAUTH_SCOPES
      });
    },
    async completeOAuth(value) {
      const completed = await coordinator.complete(value);
      await input.onActivationCommitted?.(completed.connectionId);
      return { redirectTo: '/app/integrations/airtable?connected=1' };
    },
    async listBases(): Promise<readonly AirtableSelectableBase[]> {
      const connection = await requireConnection();
      const provider = input.providerForGrant(connection.grant!);
      const bases: AirtableSelectableBase[] = [];
      let offset: string | undefined;
      do {
        const page = await provider.listBases(offset ? { offset } : undefined);
        if (page.kind === 'failure') providerError(page);
        bases.push(...page.value.bases);
        offset = page.value.offset;
        if (bases.length > 1_000) throw new Error('airtable_base_list_too_large');
      } while (offset);
      return Object.freeze(bases.sort((left, right) => left.name.localeCompare(right.name)));
    },
    async activate(value: AirtableActivationInput) {
      const connection = await requireConnection();
      if (connection.state !== 'draft') throw new Error('airtable_connection_not_draft');
      const provider = input.providerForGrant(connection.grant!);
      const baseId = parseAirtableBaseId(value.baseId);
      const listed = await provider.listBases();
      if (listed.kind === 'failure') providerError(listed);
      const selected = listed.value.bases.find((base) => base.id === baseId);
      if (!selected || (selected.permissionLevel !== 'edit' && selected.permissionLevel !== 'create')) {
        throw new Error('airtable_base_not_writable');
      }
      const directions = new Map(value.directions.map((item) => [item.areaKey, item.direction]));
      const manifest = createDefaultManagedBaseManifest({
        scope: 'all_events', includeSpeakerEmail: false, includeSpeakerPhone: false
      });
      const granted = new Set(connection.grant!.scopes);
      const compiled = compileInitialAirtableMapping({
        manifestVersion: manifest.version,
        revision: 1,
        directions: areaFacts.map((area) => ({
          areaKey: area.key,
          direction: directions.get(area.key) ?? 'not_connected'
        })),
        canReadRecords: granted.has('data.records:read'),
        canWriteRecords: granted.has('data.records:write')
      });
      if (compiled.kind === 'refused') throw new Error('airtable_mapping_refused');
      const accepted = await input.repository.activateSelectedBase({
        connectionId: connection.id,
        expectedConnectionVersion: connection.version,
        provisioning: createManagedSelectedBaseProvisioningState({
          connectionId: connection.id, providerBaseId: baseId, baseName: selected.name, manifest
        }),
        mappingId: newId(), mappingRevision: compiled.mapping.revision,
        manifestVersion: manifest.version, mappingDigest: compiled.mapping.digestSha256,
        mapping: compiled.mapping as unknown as CanonicalJson, nowMs: now()
      });
      if (!accepted) throw new Error('airtable_activation_raced');
      await input.onActivationCommitted?.(connection.id);
      return read();
    },
    async setSharing(value) {
      const connection = await requireConnection();
      await input.controls.setSharing({ connection, areaKey: value.areaKey, direction: value.direction });
      return read();
    },
    async syncNow() { await input.controls.syncNow(await requireConnection()); return read(); },
    async setPaused(paused) { await input.controls.setPaused(await requireConnection(), paused); return read(); },
    async revertHistory(id) { await input.controls.revertHistory(await requireConnection(), id); return read(); },
    async disconnect() { await input.controls.disconnect(await requireConnection()); return read(); }
  };
  return Object.freeze(runtime);
}
