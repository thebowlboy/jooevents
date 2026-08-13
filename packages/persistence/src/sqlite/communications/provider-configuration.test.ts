import { afterEach, describe, expect, test } from 'bun:test';
import {
  finalizeEmailSetupManifest,
  type EmailProviderConnectionDraftInput
} from '@jooevents/contracts';
import { createFoundationEphemeralSQLiteRuntime } from '../foundation-ephemeral-sqlite-runtime';
import {
  SQLiteEmailProviderConfigurationError,
  SQLiteEmailProviderConfigurationRepository
} from './provider-configuration';

const workspaceId = '550e8400-e29b-41d4-a716-446655440000';
const createdAt = '2026-08-13T09:00:00.000Z';
const digest = 'a'.repeat(64);
const manifest = finalizeEmailSetupManifest({
  contractVersion: 1,
  schemaKey: 'je.communication.email-setup-manifest',
  schemaVersion: 1,
  manifestKey: 'cloud.example.rest.setup',
  manifestVersion: 1,
  adapterKey: 'cloud.example.rest',
  adapterVersion: 'v1',
  capabilities: { idempotency: 'none', reconciliation: 'none', callbacks: [], inboundReplies: false },
  capabilityStatus: {
    transactional_outbound: 'supported', delivery_callbacks: 'not_supported',
    suppression_callbacks: 'not_supported', inbound_replies: 'not_enabled'
  },
  nonSecretFields: [{ key: 'cloud.account_id', label: 'Account ID', valueKind: 'text', required: true }],
  requiredSecretReferences: [{ key: 'cloud.api_token', label: 'API token', required: true }],
  officialLinks: [], humanSteps: [],
  readinessChecks: [{
    key: 'cloud.outbound', capability: 'transactional_outbound',
    externalCheckKey: 'cloud.outbound_ready', observationSchemaVersion: 1,
    normalizerVersion: 1, maximumValidityMs: 60_000,
    observableClaimKeys: ['cloud.transport.configured']
  }],
  senderRequirements: {
    verifiedDomainRequired: true, verifiedFromAddressRequired: false,
    replyToMode: 'optional', envelopeFromMode: 'adapter_managed'
  },
  callbacks: { kind: 'disabled' },
  diagnostics: { kind: 'not_supported' }
});
const configRef = {
  payloadRefId: 'configuration-ref-1', payloadRefVersion: 1,
  payloadKind: 'email_provider_configuration' as const,
  schemaKey: 'cloud.example.configuration', schemaVersion: 1,
  classification: 'restricted' as const
};
const draft: EmailProviderConnectionDraftInput = {
  connectionId: 'connection-1', revisionId: 'connection-revision-1', workspaceId,
  displayName: 'Cloud Example', adapterKey: manifest.adapterKey,
  adapterVersion: manifest.adapterVersion, manifest, configSchemaVersion: 1,
  configRef,
  secretReferences: [{
    key: 'cloud.api_token', secretStoreKey: 'deployment.secret',
    secretReference: 'opaque-secret-reference-1'
  }],
  configDigestSha256: digest,
  createdAt
};

const runtimes: ReturnType<typeof createFoundationEphemeralSQLiteRuntime>[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});

function setup() {
  const runtime = createFoundationEphemeralSQLiteRuntime();
  runtimes.push(runtime);
  runtime.sqlite.query(`INSERT INTO workspaces (
    id, name, state, created_at, updated_at, version
  ) VALUES (?, 'Provider test', 'active', 1, 1, 1)`).run(workspaceId);
  return {
    sqlite: runtime.sqlite,
    repository: new SQLiteEmailProviderConfigurationRepository(runtime.sqlite)
  };
}

describe('SQLite email provider configuration', () => {
  test('stores an immutable candidate and only opaque secret references', () => {
    const { sqlite, repository } = setup();
    const result = repository.createConnection(draft);

    expect(result.lifecycle).toBe('draft');
    expect(result.currentRevisionId).toBeNull();
    expect(result.candidateRevisions[0]?.secretRequirements).toEqual([
      { key: 'cloud.api_token', configured: true }
    ]);
    const row = sqlite.query<{ revision_json: string }, []>(`
      SELECT revision_json FROM email_provider_connection_revisions
    `).get()!;
    expect(row.revision_json).not.toContain('opaque-secret-reference-1');
    expect(sqlite.query<{ secret_reference: string }, []>(`
      SELECT secret_reference FROM email_provider_connection_secret_refs
    `).get()?.secret_reference).toBe('opaque-secret-reference-1');
    expect(() => sqlite.query(`UPDATE email_provider_connection_revisions
      SET config_digest_sha256 = ? WHERE revision_id = ?`).run('b'.repeat(64), draft.revisionId))
      .toThrow();
  });

  test('appends with an optimistic head and refuses stale reuse', () => {
    const { repository } = setup();
    repository.createConnection(draft);
    const appended = repository.appendConnectionRevision({
      ...draft,
      revisionId: 'connection-revision-2',
      expectedHeadVersion: 1,
      createdAt: '2026-08-13T09:01:00.000Z'
    });

    expect(appended.headVersion).toBe(2);
    expect(appended.candidateRevisions.map((revision) => revision.revisionNumber)).toEqual([1, 2]);
    expect(() => repository.appendConnectionRevision({
      ...draft,
      revisionId: 'connection-revision-3',
      expectedHeadVersion: 1,
      createdAt: '2026-08-13T09:02:00.000Z'
    })).toThrow(new SQLiteEmailProviderConfigurationError('stale_head'));
  });

  test('persists sender and no-fallback routing candidates', () => {
    const { repository } = setup();
    repository.createConnection(draft);
    const sender = repository.createSenderProfile({
      senderProfileId: 'sender-1', workspaceId, profileKey: 'default.sender', createdAt,
      revision: {
        revisionId: 'sender-revision-1', senderProfileId: 'sender-1', revisionNumber: 1,
        fromName: 'JooEvents', fromAddressRef: configRef, replyModelKey: 'reply.optional',
        replyToRef: null, presentationContractKey: 'email.presentation',
        presentationContractVersion: 1, presentationDigestSha256: digest, createdAt
      }
    });
    const routing = repository.createRoutingPolicy({
      routingPolicyId: 'routing-1', workspaceId, policyKey: 'default.routing', createdAt,
      revision: {
        revisionId: 'routing-revision-1', routingPolicyId: 'routing-1', revisionNumber: 1,
        contractSchemaVersion: 1, digestSha256: digest, createdAt,
        rules: [{
          priority: 0, purposeKey: null, deliveryClassKey: null,
          providerConnectionRevisionId: draft.revisionId,
          senderProfileRevisionId: 'sender-revision-1', noFallback: true,
          ruleDigestSha256: digest
        }]
      }
    });
    const appendedAt = '2026-08-13T09:01:00.000Z';
    const senderAppended = repository.appendSenderProfileRevision({
      senderProfileId: 'sender-1', workspaceId, profileKey: 'default.sender',
      expectedHeadVersion: 1, appendedAt,
      revision: {
        revisionId: 'sender-revision-2', senderProfileId: 'sender-1', revisionNumber: 2,
        fromName: 'JooEvents Team', fromAddressRef: configRef, replyModelKey: 'reply.optional',
        replyToRef: null, presentationContractKey: 'email.presentation',
        presentationContractVersion: 1, presentationDigestSha256: 'b'.repeat(64),
        createdAt: appendedAt
      }
    });
    const routingAppended = repository.appendRoutingPolicyRevision({
      routingPolicyId: 'routing-1', workspaceId, policyKey: 'default.routing',
      expectedHeadVersion: 1, appendedAt,
      revision: {
        revisionId: 'routing-revision-2', routingPolicyId: 'routing-1', revisionNumber: 2,
        contractSchemaVersion: 1, digestSha256: 'b'.repeat(64), createdAt: appendedAt,
        rules: [{
          priority: 0, purposeKey: 'program.accepted', deliveryClassKey: null,
          providerConnectionRevisionId: draft.revisionId,
          senderProfileRevisionId: 'sender-revision-2', noFallback: true,
          ruleDigestSha256: 'b'.repeat(64)
        }]
      }
    });

    expect(sender.state).toBe('draft');
    expect(routing.candidateRevisions[0]?.rules[0]?.noFallback).toBe(true);
    expect(senderAppended.candidateRevisions.map((revision) => revision.revisionNumber))
      .toEqual([1, 2]);
    expect(routingAppended.candidateRevisions.map((revision) => revision.revisionNumber))
      .toEqual([1, 2]);
  });

  test('fences readiness completion against the latest exact revision head', () => {
    const { repository } = setup();
    repository.createConnection(draft);
    const input = {
      readinessCheckId: 'readiness-check-1',
      connectionId: draft.connectionId,
      connectionRevisionId: draft.revisionId,
      expectedConfigDigestSha256: digest,
      capability: 'transactional_outbound' as const,
      checkKey: 'cloud.outbound',
      requestedValidUntil: Date.parse(createdAt) + 30_000,
      requestDigestSha256: 'b'.repeat(64)
    };
    expect(repository.beginReadinessCheck(input, createdAt).state).toBe('checking');
    const completed = repository.completeReadinessCheck({
      readinessCheckId: input.readinessCheckId,
      readiness: 'ready',
      evidence: {
        evidenceId: 'readiness-evidence-1', registeredCode: 'readiness.ready',
        digestSha256: 'c'.repeat(64), observedAt: '2026-08-13T09:00:01.000Z'
      },
      validUntil: input.requestedValidUntil,
      completedAt: '2026-08-13T09:00:01.000Z'
    });

    expect(completed.state).toBe('passed');
    expect(repository.listLatestChecks(draft.revisionId)).toEqual([completed]);
  });

  test('refuses a readiness claim for a changed revision digest', () => {
    const { repository } = setup();
    repository.createConnection(draft);

    expect(() => repository.beginReadinessCheck({
      readinessCheckId: 'readiness-check-stale',
      connectionId: draft.connectionId,
      connectionRevisionId: draft.revisionId,
      expectedConfigDigestSha256: 'd'.repeat(64),
      capability: 'transactional_outbound',
      checkKey: 'cloud.outbound',
      requestedValidUntil: Date.parse(createdAt) + 30_000,
      requestDigestSha256: 'e'.repeat(64)
    }, createdAt)).toThrow(new SQLiteEmailProviderConfigurationError('stale_head'));
  });
});
