import { describe, expect, test } from 'bun:test';
import {
  createApplicationOperationRuntime,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type InvocationEvidence,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS,
  organizerMessagePreviewRecipientListInputSchema
} from '@jooevents/contracts';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { PERMISSIONS } from '@jooevents/identity-access';
import { ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY } from './organizer-authoring-module';
import {
  ORGANIZER_COMMUNICATION_AUDIENCE_PREVIEW_READ_OPERATIONS,
  ORGANIZER_COMMUNICATION_EXACT_CONTACT_PERMISSION,
  createOrganizerAudiencePreviewReadOperationModule,
  type OrganizerPreviewContactDisclosure
} from './organizer-audience-preview-module';

const workspaceId = parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000');
const eventId = parseEventId('550e8400-e29b-41d4-a716-446655440001');
const userId = parseUserId('01890f47-9abc-7def-8123-456789abc001');
const membershipId = parseMembershipId('01890f47-9abc-7def-8123-456789abc002');
const now = parseInstant('2026-08-13T00:00:00.000Z');
const profile = { key: 'profile.communication.audience-preview-test', version: parseContractVersion(1) } as const;
const identity = organizerMessagePreviewRecipientListInputSchema.parse({
  audienceSpecId: '018f7d5a-4b3c-7abc-8def-000000000001',
  draftId: '018f7d5a-4b3c-7abc-8def-000000000002',
  draftVersion: 3,
  previewGeneration: 2,
  previewDigestProfile: 'communication.preview.sha256',
  previewDigestVersion: 1,
  previewDigestSha256: 'a'.repeat(64),
  limit: 20
});

class UnusedUnitOfWork implements EffectUnitOfWorkPort {
  findTerminalReceipt(): TerminalEffectReceipt | undefined { return undefined; }
  recordShortOperationAudit(_record: ShortOperationAuditRecord): void {}
  async runInUnitOfWork<Value>(_work: (unitOfWork: EffectUnitOfWork) => Promise<Value>) {
    return Promise.reject(new TypeError('unused'));
  }
}

function fixture(
  exact: boolean,
  enabledOperations?: readonly ('list_audience_options' | 'get_message_batch_preview'
    | 'list_message_preview_recipients')[]
) {
  const disclosures: OrganizerPreviewContactDisclosure[] = [];
  let invocation = 0;
  const module = createOrganizerAudiencePreviewReadOperationModule({
    workspaceId,
    policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
    currentAuthority: {
      resolve(resolution) {
        return {
          kind: 'authorized' as const,
          authority: {
            actor: { kind: 'workspace_user' as const, userId },
            principal: { kind: 'workspace_user' as const, userId, membershipId },
            lane: resolution.lane,
            scope: resolution.scope,
            grants: [
              { kind: 'permission' as const, key: 'communication.draft' },
              ...(exact
                ? [{ kind: 'permission' as const, key: ORGANIZER_COMMUNICATION_EXACT_CONTACT_PERMISSION }]
                : [])
            ],
            evidenceIds: ['membership.current'],
            authorityCitationIds: [],
            evaluatedAt: resolution.evaluatedAt
          }
        };
      }
    },
    currentEvent: {
      resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.selection.current'] })
    },
    read: {
      listAudienceOptions: () => ({
        kind: 'success', data: { schemaVersion: 1, rows: [], page: { hasMore: false } }
      }),
      getMessageBatchPreview: () => ({
        kind: 'outcome',
        outcome: {
          class: 'conflict', kind: 'communication.not_found', retryable: false,
          subjects: [], detail: null, detailSchemaVersion: 1
        }
      }),
      listMessagePreviewRecipients(_scope, _principal, input, disclosure) {
        disclosures.push(disclosure);
        const parsed = organizerMessagePreviewRecipientListInputSchema.parse(input);
        return {
          kind: 'success',
          data: {
            schemaVersion: 1,
            identity: {
              audienceSpecId: parsed.audienceSpecId,
              draftId: parsed.draftId,
              draftVersion: parsed.draftVersion,
              previewGeneration: parsed.previewGeneration,
              previewDigestProfile: parsed.previewDigestProfile,
              previewDigestVersion: parsed.previewDigestVersion,
              previewDigestSha256: parsed.previewDigestSha256
            },
            rows: [],
            page: { hasMore: false }
          }
        };
      }
    },
    clock: { now: () => now },
    ids: {
      newInvocationId: () => parseInvocationId(
        `018f7d5a-4b3c-7abc-8def-${(++invocation).toString().padStart(12, '0')}`
      )
    },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile
    },
    ...(enabledOperations === undefined ? {} : { enabledOperations })
  });
  const evidence: InvocationEvidence = {
    kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
    sessionHandle: 'session-current'
  };
  return { module, evidence, disclosures };
}

async function runtime(input: ReturnType<typeof fixture>) {
  return createApplicationOperationRuntime({
    source: input.module.source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => now },
      newInvocationId: () => parseInvocationId(crypto.randomUUID())
    },
    unitOfWork: new UnusedUnitOfWork()
  });
}

describe('organizer audience and preview read operations', () => {
  test('registers only the three frozen reads with their exact schemas and no effects', async () => {
    const input = fixture(false);
    const operations = await runtime(input);
    expect(input.module.source.operations.map((operation) => operation.name)).toEqual(
      Object.values(ORGANIZER_COMMUNICATION_AUDIENCE_PREVIEW_READ_OPERATIONS)
        .map((operation) => operation.name)
    );
    expect(input.module.source.effectOperations).toBeUndefined();
    expect(operations.registry.operatorHttpBindings).toHaveLength(3);
    expect(operations.registry.appModelReadBindings).toHaveLength(3);
    expect(input.module.source.operations.every((operation) =>
      operation.bindings.map((binding) => binding.surface).join(',') ===
        'operator_http,external_mcp,app_model'
    )).toBe(true);
    const recipientOperation = operations.registry.safeManifest.operations.find(
      (operation) => operation.name === 'list_message_preview_recipients'
    );
    expect(recipientOperation?.inputSchema).toEqual(
      ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listPreviewRecipients.inputSchema
    );
    expect(recipientOperation?.enabledBindings[0]?.resultSchema).toEqual(
      ORGANIZER_COMMUNICATION_OPERATION_SCHEMA_REFS.listPreviewRecipients.resultSchema
    );
    expect(input.module.source.operations.find(
      (operation) => operation.name === 'list_message_preview_recipients'
    )?.observability.immutableAudit).toMatchObject({ mode: 'required', reason: 'classified' });
    expect(input.module.source.operations.find(
      (operation) => operation.name === 'get_message_batch_preview'
    )?.observability.immutableAudit).toMatchObject({ mode: 'required', reason: 'classified' });
  });

  test('can advertise only a completed read subset', async () => {
    const input = fixture(false, ['list_audience_options']);
    expect(input.module.source.operations.map((operation) => operation.name)).toEqual([
      'list_audience_options'
    ]);
    expect((await runtime(input)).registry.operatorHttpBindings).toHaveLength(1);
  });

  test('defaults to masked contact data and widens only under an independent exact grant', async () => {
    expect(PERMISSIONS.some(
      (permission) => permission.id === ORGANIZER_COMMUNICATION_EXACT_CONTACT_PERMISSION
    )).toBe(true);
    for (const exact of [false, true]) {
      const input = fixture(exact);
      const operations = await runtime(input);
      const result = await operations.readExecutor.execute({
        operationName: 'list_message_preview_recipients',
        operationVersion: 1,
        surface: 'operator_http',
        correlationId: crypto.randomUUID(),
        businessInput: identity,
        verifiedEvidence: input.evidence
      });
      expect(result.kind).toBe('success');
      expect(input.disclosures).toEqual([exact ? 'exact_authorized' : 'masked']);
    }
  });
});
