import type { Database } from 'bun:sqlite';
import { createSecretStoreAdapterRef } from '@jooevents/application';
import {
  createAirtableHttpProvider,
  createAirtableOAuthClient,
  type AirtableFetch,
  type AirtableOAuthGrant
} from '@jooevents/airtable';
import {
  airtableReconciliationCadence,
  compileInitialAirtableMapping,
  createAirtableWebhookIngress,
  createAirtableWebhookVerifier,
  createDefaultManagedBaseManifest,
  createStoredAirtableGrantLease,
  deleteManagedAirtableWebhook,
  deriveAirtableSyncHealth,
  processAirtableWebhookCursor,
  processOneAirtableShadowSettle,
  processOneControlledAirtableSettle,
  refreshManagedAirtableWebhook,
  runAirtableActivationStep,
  runAirtableOutboundJob,
  scanOneAirtableReconciliationPage,
  type AirtableControlledOperationPort,
  type StoredAirtableOAuthGrant
} from '@jooevents/airtable-sync';
import type { AirtableIntegrationView } from '@jooevents/contracts';
import {
  parseInstant,
  parseSourceConnectionId,
  parseVerifierRevisionId,
  type CanonicalJson
} from '@jooevents/kernel';
import {
  SQLiteAirtableInboundBoundaryPort,
  SQLiteAirtableInboundCursorRepository,
  SQLiteAirtableLiveProjectionSource,
  SQLiteAirtableManagedSnapshotSource,
  SQLiteAirtableOutboundJobRepository,
  SQLiteAirtableProviderThrottle,
  SQLiteAirtableReconciliationRepository,
  SQLiteAirtableShadowContextSource,
  SQLiteAirtableShadowSettleRepository,
  SQLiteAirtableSyncRepository,
  SQLiteAirtableWebhookLifecycleRepository,
  SQLiteAirtableWebhookMacRegistrationResolver,
  SQLiteSecretStore
} from '@jooevents/persistence';
import type { AirtableProviderConfig } from '../config/airtable';
import { parseContractVersion } from '@jooevents/kernel';
import type { VersionedAccessPolicyRef } from '@jooevents/identity-access';
import type { AirtableWebhookIngressRuntime } from '../http/airtable-webhook';
import type {
  AirtableIntegrationAction,
  AirtableIntegrationHttpRuntime
} from '../http/airtable-integration';
import { createAirtableIntegrationRuntime } from './airtable-integration-runtime';

const SECRET_ADAPTER = createSecretStoreAdapterRef('secret.sqlite.airtable.aes-gcm', 1);
const WEBHOOK_VERIFIER_REVISION = parseVerifierRevisionId('019c30db-4e00-7000-8000-0000000000a1');
const manifest = createDefaultManagedBaseManifest({
  scope: 'all_events', includeSpeakerEmail: false, includeSpeakerPhone: false
});

export const AIRTABLE_INTEGRATION_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.integration.airtable.read', version: parseContractVersion(1)
});
export const AIRTABLE_INTEGRATION_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.integration.airtable.manage', version: parseContractVersion(1)
});

export interface AirtableLiveRuntime {
  readonly integration: AirtableIntegrationHttpRuntime;
  readonly webhookIngress: AirtableWebhookIngressRuntime;
  start(): void;
  wake(connectionId?: string): void;
  hasInFlightWork(): boolean;
  close(): Promise<void>;
}

/** Composes provider I/O only when an entry explicitly supplies Airtable configuration. */
export function createAirtableLiveRuntime(input: Readonly<{
  sqlite: Database;
  workspaceId: string;
  baseUrl: string;
  config: AirtableProviderConfig;
  authorize(input: Readonly<{
    request: Request;
    action: AirtableIntegrationAction;
  }>): Promise<'authorized' | 'unauthenticated' | 'forbidden'>;
  controlledOperations?: AirtableControlledOperationPort;
  serializeWork?<Value>(work: () => Promise<Value>): Promise<Value>;
  controlledOperationsForClaim?(claim: import('@jooevents/airtable-sync').AirtableShadowSettleClaim): AirtableControlledOperationPort;
  fetch?: AirtableFetch;
  now?: () => number;
}>): AirtableLiveRuntime {
  const now = input.now ?? Date.now;
  const fetcher = input.fetch ?? ((request, init) => globalThis.fetch(request, init));
  const repository = new SQLiteAirtableSyncRepository(input.sqlite);
  const secretStore = input.config.withSecretStoreKey((keyBytes) => new SQLiteSecretStore(
    input.sqlite,
    { adapter: SECRET_ADAPTER, keyBytes, nowMs: now }
  ));
  const oauth = createAirtableOAuthClient({
    clientId: input.config.clientId,
    clientSecretLease: input.config.clientSecretLease,
    fetch: fetcher,
    now
  });
  const providerForGrant = (stored: StoredAirtableOAuthGrant) => createAirtableHttpProvider({
    clientId: input.config.clientId,
    clientSecretLease: input.config.clientSecretLease,
    accessTokenLease: createStoredAirtableGrantLease({
      secretStore,
      stored,
      connectionId: stored.secretReference.scopeBinding
    }),
    fetch: fetcher,
    now
  });
  const inspectGrant = async (grant: AirtableOAuthGrant) => createAirtableHttpProvider({
    clientId: input.config.clientId,
    clientSecretLease: input.config.clientSecretLease,
    accessTokenLease: Object.freeze({
      async withAccessToken<Result>(use: (token: string) => Promise<Result>) {
        return use(grant.accessToken);
      }
    }),
    fetch: fetcher,
    now
  }).data.getGrantIdentity();
  const snapshot = new SQLiteAirtableManagedSnapshotSource(input.sqlite, input.workspaceId);
  const liveProjection = new SQLiteAirtableLiveProjectionSource(input.sqlite, snapshot);
  const lifecycle = new SQLiteAirtableWebhookLifecycleRepository(repository);
  const activationRepository = Object.freeze({
    claim: repository.claim.bind(repository),
    complete: repository.complete.bind(repository),
    readProvisioningActivation: repository.readProvisioningActivation.bind(repository),
    finalizeProvisioningActivation: repository.finalizeProvisioningActivation.bind(repository),
    saveCreated: lifecycle.saveCreated.bind(lifecycle),
    saveRefreshed: lifecycle.saveRefreshed.bind(lifecycle),
    saveDeleted: lifecycle.saveDeleted.bind(lifecycle)
  });
  const outboundRepository = new SQLiteAirtableOutboundJobRepository(repository);
  const cursorRepository = new SQLiteAirtableInboundCursorRepository(repository);
  const settleRepository = new SQLiteAirtableShadowSettleRepository(
    repository,
    new SQLiteAirtableShadowContextSource(input.sqlite, snapshot)
  );
  const boundary = new SQLiteAirtableInboundBoundaryPort(repository, {
    nowMs: now,
    newId: () => crypto.randomUUID()
  });
  const reconciliation = new SQLiteAirtableReconciliationRepository(input.sqlite);
  const running = new Set<string>();
  const activePasses = new Set<Promise<void>>();
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  let sweep: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let closed = false;

  const schedule = (connectionId: string, delayMs = 0) => {
    if (!started || closed || scheduled.has(connectionId)) return;
    scheduled.set(connectionId, setTimeout(() => {
      scheduled.delete(connectionId);
      const pass = (input.serializeWork
        ? input.serializeWork(() => pump(connectionId))
        : pump(connectionId)).catch((error) => {
        console.error('[jooevents] Airtable sync wake failed', error);
        schedule(connectionId, 30_000);
      }).finally(() => {
        activePasses.delete(pass);
      });
      activePasses.add(pass);
    }, delayMs));
  };
  const reconnectRequired = (code: string): boolean =>
    code === 'grant_revoked' || code === 'resource_forbidden';

  const pump = async (connectionId: string): Promise<void> => {
    if (closed || running.has(connectionId)) return;
    running.add(connectionId);
    try {
      for (let unit = 0; unit < 100 && !closed; unit += 1) {
        const connection = repository.readWorkspaceConnection(input.workspaceId);
        if (!connection || connection.id !== connectionId || !connection.grant) return;
        const provider = providerForGrant(connection.grant);
        if (connection.state === 'provisioning') {
          const result = await runAirtableActivationStep({
            connectionId,
            workerId: `airtable-activation:${connectionId}`,
            nowMs: now(),
            baseUrl: input.baseUrl,
            manifest,
            repository: activationRepository,
            provider: provider.data,
            webhooks: provider.webhooks,
            source: snapshot,
            secretStore,
            secretAdapter: SECRET_ADAPTER
          });
          if (result.kind === 'retry') {
            schedule(connectionId, result.retryAfterMs);
            return;
          }
          if (result.kind === 'attention' && reconnectRequired(result.code)) {
            repository.markConnectionNeedsReconnect({
              connectionId,
              expectedVersion: connection.version,
              nowMs: now()
            });
            return;
          }
          if (result.kind === 'attention' || result.kind === 'idle' || result.kind === 'stale') return;
          if (result.kind === 'activated') {
            const active = repository.readWorkspaceConnection(input.workspaceId);
            if (active?.mapping) liveProjection.promoteInitialLinks({
              connectionId,
              mappingRevision: active.mapping.revision,
              nowMs: now()
            });
            repository.scheduleConnectionReconciliation({
              workspaceId: input.workspaceId,
              kind: 'full',
              nowMs: now(),
              newRunId: () => crypto.randomUUID()
            });
          }
          continue;
        }
        if (connection.state !== 'active') return;
        const health = reconciliation.readHealth(connectionId);
        const registration = repository.readWebhookRegistrationAny(connectionId);
        const cadence = airtableReconciliationCadence({
          nowMs: now(),
          ...(health?.lastLightweightAtMs === undefined
            ? {} : { lastLightweightAtMs: health.lastLightweightAtMs }),
          ...(health?.lastFullAtMs === undefined ? {} : { lastFullAtMs: health.lastFullAtMs }),
          ...(registration ? { webhookExpiresAtMs: registration.expiresAtMs } : {})
        });
        if (cadence.renewalDue && registration) {
          const renewed = await refreshManagedAirtableWebhook({
            connectionId,
            baseId: registration.baseId,
            webhookId: registration.webhookId,
            webhooks: provider.webhooks,
            repository: lifecycle,
            nowMs: now()
          });
          if (renewed.kind === 'retry') {
            schedule(connectionId, renewed.retryAfterMs);
            return;
          }
          if (renewed.kind === 'attention') return;
        }
        if (cadence.fullDue || cadence.lightweightDue) {
          repository.scheduleConnectionReconciliation({
            workspaceId: input.workspaceId,
            kind: cadence.fullDue ? 'full' : 'lightweight',
            nowMs: now(),
            newRunId: () => crypto.randomUUID()
          });
        }
        const recoveringRetention = repository.hasOpenRetentionRecovery(connectionId);
        const cursor = recoveringRetention
          ? { kind: 'contended' as const }
          : await processAirtableWebhookCursor({
              connectionId,
              repository: cursorRepository,
              webhooks: provider.webhooks,
              nowMs: now(),
              maximumPages: 5
            });
        if (cursor.kind === 'attention' && reconnectRequired(cursor.code)) {
          repository.markConnectionNeedsReconnect({
            connectionId,
            expectedVersion: connection.version,
            nowMs: now()
          });
          return;
        }
        if (cursor.kind === 'retry') schedule(connectionId, cursor.retryAfterMs);
        if (cursor.kind === 'retention_recovery_required') {
          repository.scheduleConnectionReconciliation({
            workspaceId: input.workspaceId,
            kind: 'retention_recovery',
            nowMs: now(),
            newRunId: () => crypto.randomUUID()
          });
        }
        const retentionApplyPaused = recoveringRetention
          || cursor.kind === 'retention_recovery_required';
        const settle = retentionApplyPaused
          ? { kind: 'idle' as const }
          : input.controlledOperations || input.controlledOperationsForClaim
            ? await processOneControlledAirtableSettle({
              connectionId,
              workerId: `airtable-settle:${connectionId}`,
              nowMs: now(),
              repository: settleRepository,
              provider: provider.data,
              ...(input.controlledOperations ? { operations: input.controlledOperations } : {}),
              ...(input.controlledOperationsForClaim
                ? { operationsForClaim: input.controlledOperationsForClaim }
                : {}),
              boundary
              })
            : await processOneAirtableShadowSettle({
                connectionId,
                workerId: `airtable-shadow:${connectionId}`,
                nowMs: now(),
                repository: settleRepository,
                provider: provider.data
              });
        const outbound = await runAirtableOutboundJob({
          connectionId,
          workerId: `airtable-outbound:${connectionId}`,
          nowMs: now(),
          repository: outboundRepository,
          source: liveProjection,
          provider: provider.data,
          throttle: new SQLiteAirtableProviderThrottle(repository)
        });
        const scan = await scanOneAirtableReconciliationPage({
          connectionId,
          workerId: `airtable-reconcile:${connectionId}`,
          nowMs: now(),
          repository: reconciliation,
          provider: provider.data
        });
        if (scan.kind === 'ready_to_assess') reconciliation.assessReadyRun({
          runId: scan.runId,
          nowMs: now(),
          newFindingId: () => crypto.randomUUID(),
          newWorkId: () => crypto.randomUUID(),
          newSettleId: () => crypto.randomUUID()
        });
        if (retentionApplyPaused) continue;
        const noSettle = settle.kind === 'idle';
        const noOutbound = outbound.kind === 'idle' || outbound.kind === 'contended';
        const noScan = scan.kind === 'idle';
        if (noSettle && noOutbound && noScan
          && cursor.kind !== 'retry' && (cursor.kind !== 'processed' || cursor.candidates === 0)) return;
      }
      schedule(connectionId, 100);
    } finally {
      running.delete(connectionId);
    }
  };

  const controls = {
    async setSharing(value: Parameters<NonNullable<Parameters<typeof createAirtableIntegrationRuntime>[0]>['controls']['setSharing']>[0]) {
      const directions = new Map(
        (value.connection.mapping?.value as { readonly areas?: readonly { areaKey: string; direction: string }[] } | undefined)
          ?.areas?.map((area) => [area.areaKey, area.direction]) ?? []
      );
      directions.set(value.areaKey, value.direction);
      const compiled = compileInitialAirtableMapping({
        manifestVersion: manifest.version,
        revision: (value.connection.mapping?.revision ?? 0) + 1,
        directions: ['people', 'submissions', 'sessions', 'schedule', 'tasks'].map((areaKey) => ({
          areaKey: areaKey as 'people' | 'submissions' | 'sessions' | 'schedule' | 'tasks',
          direction: (directions.get(areaKey) ?? 'not_connected') as 'not_connected' | 'keep_airtable_updated' | 'work_from_airtable'
        })),
        canReadRecords: value.connection.grant!.scopes.includes('data.records:read'),
        canWriteRecords: value.connection.grant!.scopes.includes('data.records:write')
      });
      if (compiled.kind === 'refused') throw new Error('airtable_mapping_refused');
      const changed = repository.replaceActiveMapping({
        id: crypto.randomUUID(),
        observationId: crypto.randomUUID(),
        connectionId: value.connection.id,
        expectedConnectionVersion: value.connection.version,
        revision: compiled.mapping.revision,
        manifestVersion: manifest.version,
        mappingDigest: compiled.mapping.digestSha256,
        mapping: compiled.mapping as unknown as CanonicalJson,
        nowMs: now()
      });
      if (!changed) throw new Error('airtable_mapping_raced');
      if (value.direction !== 'not_connected') {
        repository.enqueueManagedAreaRefresh({
          connectionId: value.connection.id,
          workspaceId: input.workspaceId,
          mappingRevision: compiled.mapping.revision,
          areaKey: value.areaKey,
          nowMs: now(),
          newWorkId: () => crypto.randomUUID()
        });
        repository.enqueueManagedAreaRefresh({
          connectionId: value.connection.id,
          workspaceId: input.workspaceId,
          mappingRevision: compiled.mapping.revision,
          areaKey: 'events',
          nowMs: now(),
          newWorkId: () => crypto.randomUUID()
        });
      }
      repository.scheduleConnectionReconciliation({
        workspaceId: input.workspaceId,
        kind: 'full',
        nowMs: now(),
        newRunId: () => crypto.randomUUID()
      });
      schedule(value.connection.id);
    },
    async syncNow(connection: { readonly id: string }) {
      repository.scheduleConnectionReconciliation({
        workspaceId: input.workspaceId,
        kind: 'user_requested',
        nowMs: now(),
        newRunId: () => crypto.randomUUID()
      });
      schedule(connection.id);
    },
    async setPaused(connection: { readonly id: string; readonly version: number }, paused: boolean) {
      if (!repository.setConnectionPaused({
        connectionId: connection.id, expectedVersion: connection.version, paused, nowMs: now()
      })) throw new Error('airtable_connection_raced');
      if (!paused) schedule(connection.id);
    },
    async revertHistory() { throw new Error('airtable_history_revert_unavailable'); },
    async disconnect(connection: { readonly id: string; readonly version: number; readonly grant?: StoredAirtableOAuthGrant }) {
      const disconnectVersion = repository.beginDisconnect({
        connectionId: connection.id,
        expectedVersion: connection.version,
        nowMs: now()
      });
      if (disconnectVersion === undefined) throw new Error('airtable_connection_raced');
      const registration = repository.readWebhookRegistrationAny(connection.id);
      if (registration && connection.grant) {
        const provider = providerForGrant(connection.grant);
        const deleted = await deleteManagedAirtableWebhook({
          connectionId: connection.id,
          baseId: registration.baseId,
          webhookId: registration.webhookId,
          webhooks: provider.webhooks,
          repository: lifecycle,
          nowMs: now()
        });
        if (deleted.kind !== 'completed') throw new Error(`airtable_disconnect_${deleted.code}`);
      }
      if (connection.grant) await secretStore.revoke({
        reference: connection.grant.secretReference,
        expectedVersion: connection.grant.secretReference.version
      });
      if (!repository.disconnectLocal({
        connectionId: connection.id, expectedVersion: disconnectVersion, nowMs: now()
      })) throw new Error('airtable_connection_raced');
    },
    async readAttention(connection: { readonly id: string }) {
      const conflicts = input.sqlite.query<{
        readonly id: string;
        readonly kind: 'conflict' | 'request';
      }, [string]>(`
        SELECT id,'conflict' AS kind FROM airtable_sync_conflicts
         WHERE connection_id=? AND status='open' ORDER BY created_at_ms DESC LIMIT 100
      `).all(connection.id).map((row) => ({
        id: row.id,
        kind: row.kind,
        title: 'An Airtable edit needs review',
        href: '/app/integrations/airtable',
        actionLabel: 'Review'
      }));
      const requests = input.sqlite.query<{
        readonly id: string;
        readonly request_kind: 'cancellation' | 'deletion';
        readonly subject_label: string | null;
      }, [string, string]>(`
        SELECT engagement.id AS id,'cancellation' AS request_kind,
               person.display_name AS subject_label
          FROM airtable_sync_record_links link
          JOIN engagement_heads engagement
            ON link.subject_kind='engagement' AND engagement.id=link.subject_id
          LEFT JOIN participant_identity_family person ON person.person_id=engagement.person_id
         WHERE link.connection_id=?
           AND json_type(engagement.head_json,'$.cancellationRequest')='object'
        UNION ALL
        SELECT observation.id,'deletion' AS request_kind,NULL AS subject_label
          FROM airtable_sync_boundary_observations observation
         WHERE observation.connection_id=? AND observation.kind='request'
           AND observation.field_key='record.deleted'
         ORDER BY id LIMIT 100
      `).all(connection.id, connection.id).map((row) => ({
        id: row.id,
        kind: 'request' as const,
        title: row.request_kind === 'cancellation'
          ? `${row.subject_label ?? 'A speaker'} has a cancellation request from Airtable`
          : 'A record deletion in Airtable needs review',
        href: row.request_kind === 'cancellation'
          ? '/app/speakers?request=cancellation'
          : '/app/integrations/airtable',
        actionLabel: row.request_kind === 'cancellation' ? 'Review there' : 'Review'
      }));
      return [...conflicts, ...requests].slice(0, 100);
    },
    async readStatus(connection: { readonly id: string; readonly state: string }) {
      const health = reconciliation.readHealth(connection.id);
      const registration = repository.readWebhookRegistrationAny(connection.id);
      if (!health) return {};
      const live = input.sqlite.query<{
        readonly due_work: number;
        readonly conflicts: number;
        readonly requests: number;
      }, [string, string, string, string, string]>(`
        SELECT
          (SELECT count(*) FROM airtable_sync_projection_work
            WHERE connection_id=? AND status IN ('pending','running','failed'))
          + (SELECT count(*) FROM airtable_sync_settle_heads
            WHERE connection_id=? AND status IN ('pending','running')) AS due_work,
          (SELECT count(*) FROM airtable_sync_conflicts
            WHERE connection_id=? AND status='open') AS conflicts,
          (SELECT count(*) FROM airtable_sync_record_links link
             JOIN engagement_heads engagement
               ON link.subject_kind='engagement' AND engagement.id=link.subject_id
            WHERE link.connection_id=?
              AND json_type(engagement.head_json,'$.cancellationRequest')='object')
          + (SELECT count(*) FROM airtable_sync_boundary_observations
              WHERE connection_id=? AND kind='request' AND field_key='record.deleted') AS requests
      `).get(connection.id, connection.id, connection.id, connection.id, connection.id) ?? {
        due_work: health.dueWork, conflicts: health.conflicts, requests: health.requests
      };
      const providerState = connection.state === 'active'
        || connection.state === 'paused'
        || connection.state === 'needs_reconnect'
        || connection.state === 'disconnected'
        ? connection.state : 'active';
      const derived = deriveAirtableSyncHealth({
        state: providerState,
        nowMs: now(),
        ...(health.lastOutboundAtMs === undefined
          ? {} : { lastOutboundAtMs: health.lastOutboundAtMs }),
        ...(health.lastInboundAtMs === undefined
          ? {} : { lastInboundAtMs: health.lastInboundAtMs }),
        ...(registration ? { webhookExpiresAtMs: registration.expiresAtMs } : {}),
        dueWork: live.due_work,
        conflicts: live.conflicts,
        requests: live.requests,
        schemaDrift: health.schemaDrift,
        deadLetters: health.deadLetters
      });
      return Object.freeze({
        state: derived.state,
        ...(health.lastOutboundAtMs === undefined
          ? {} : { lastOutbound: new Date(health.lastOutboundAtMs).toISOString() }),
        ...(health.lastInboundAtMs === undefined
          ? {} : { lastInbound: new Date(health.lastInboundAtMs).toISOString() }),
        ...(health.lastFullAtMs === undefined
          ? {} : { lastFullCheck: new Date(health.lastFullAtMs).toISOString() }),
        ...(health.lastFullSummary === undefined
          ? {} : { lastFullCheckSummary: health.lastFullSummary })
      });
    },
    async readHistory(connection: { readonly id: string }): Promise<AirtableIntegrationView['history']> {
      return input.sqlite.query<{
        readonly id: string;
        readonly kind: string;
        readonly field_key: string;
        readonly occurred_at_ms: number;
        readonly provider_actor_email: string | null;
      }, [string]>(`
        SELECT id,kind,field_key,occurred_at_ms,provider_actor_email
          FROM airtable_sync_boundary_observations
         WHERE connection_id=? ORDER BY occurred_at_ms DESC,id DESC LIMIT 100
      `).all(connection.id).map((row) => ({
        id: row.id,
        kind: row.kind === 'sharing' ? 'sharing' : row.kind === 'applied' ? 'applied' : 'refused',
        summary: row.kind === 'sharing'
          ? 'Airtable sharing settings changed.'
          : `${row.field_key} was ${row.kind === 'applied' ? 'updated from Airtable' : 'kept at its JooEvents value'}.`,
        occurredAt: new Date(row.occurred_at_ms).toISOString(),
        ...(row.provider_actor_email ? { actorLabel: row.provider_actor_email } : {})
      }));
    }
  } satisfies Parameters<typeof createAirtableIntegrationRuntime>[0]['controls'];

  const integration = createAirtableIntegrationRuntime({
    workspaceId: input.workspaceId,
    baseUrl: input.baseUrl,
    clientId: input.config.clientId,
    oauth,
    repository,
    secretStore,
    secretAdapter: SECRET_ADAPTER,
    providerForGrant: (stored) => providerForGrant(stored).data,
    inspectGrant,
    authorize: input.authorize,
    controls,
    onActivationCommitted: (connectionId) => schedule(connectionId)
  });
  const registrations = new SQLiteAirtableWebhookMacRegistrationResolver(repository, secretStore);
  const verifier = createAirtableWebhookVerifier({
    revisionId: WEBHOOK_VERIFIER_REVISION,
    registrations
  });
  const webhookIngress = createAirtableWebhookIngress({
    intakes: {
      async resolve(callbackRef) {
        const connectionId = repository.resolveConnectionIdByCallbackRef(callbackRef);
        if (!connectionId) return undefined;
        return {
          async intake(value) {
            const verified = await verifier.verify({
              rawEnvelope: value.rawEnvelope,
              protocolEvidence: value.protocolEvidence,
              receivedAt: parseInstant(new Date(now()).toISOString()),
              sourceConnectionId: parseSourceConnectionId(connectionId)
            });
            if (verified.kind !== 'verified') return { kind: 'rejected' as const };
            schedule(connectionId);
            return { kind: 'intake' as const };
          }
        };
      }
    }
  });
  return Object.freeze({
    integration,
    webhookIngress,
    start() {
      if (started || closed) return;
      started = true;
      const current = repository.readWorkspaceConnection(input.workspaceId);
      if (current?.state === 'provisioning' || current?.state === 'active') schedule(current.id);
      sweep = setInterval(() => {
        const connection = repository.readWorkspaceConnection(input.workspaceId);
        if (connection?.state === 'provisioning' || connection?.state === 'active') {
          schedule(connection.id);
        }
      }, 60_000);
      sweep.unref?.();
    },
    wake(connectionId?: string) {
      const id = connectionId ?? repository.readWorkspaceConnection(input.workspaceId)?.id;
      if (id) schedule(id);
    },
    hasInFlightWork: () => activePasses.size > 0,
    async close() {
      if (closed) {
        await Promise.all([...activePasses]);
        return;
      }
      closed = true;
      if (sweep !== undefined) clearInterval(sweep);
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
      await Promise.all([...activePasses]);
    }
  });
}
