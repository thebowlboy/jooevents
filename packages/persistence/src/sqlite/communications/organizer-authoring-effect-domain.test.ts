import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createApplicationOperationRuntime,
  type EffectInvocationContext,
  type InvocationEvidence
} from '@jooevents/application';
import {
  issueSynchronousClassifiedPayloadEncryptionProfile,
  type SynchronousClassifiedPayloadPutInput,
  type SynchronousClassifiedPayloadStore
} from '@jooevents/application/synchronous-classified-payload-store';
import {
  organizerCommunicationAuthoringPayloadOperationResultSchema,
  organizerCommunicationDraftMutationOperationResultSchema
} from '@jooevents/contracts/communications/organizer';
import { planEventCreation } from '@jooevents/event';
import {
  ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
  ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION,
  ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS,
  createOrganizerCommunicationMutationOperationModule
} from '@jooevents/communication-operations';
import {
  parseAgentRunId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseModelAttemptId,
  parseModelToolCallId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  SQLiteClassifiedPayloadStore,
  installSQLiteClassifiedPayloadStoreSchema
} from '../sqlite-classified-payload-store';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteEffectDomainAdapter
} from '../foundation-trial-uow';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema,
  SQLiteEventSpineRepository
} from '../event-spine';
import { SQLiteEffectUnitOfWorkPort } from '../sqlite-effect-unit-of-work';
import {
  SQLiteOrganizerCommunicationAuthoringRepository,
  installSQLiteOrganizerCommunicationAuthoringSchema
} from './organizer-authoring';
import {
  createSQLiteOrganizerCommunicationAuthoringEffectDomainRegistrations,
  installSQLiteOrganizerCommunicationAuthoringEffectSchema
} from './organizer-authoring-effect-domain';

const ids = Object.freeze({
  workspaceId: parseWorkspaceId('019c3400-0000-7000-8000-000000000001'),
  eventId: parseEventId('019c3400-0000-7000-8000-000000000002'),
  userId: parseUserId('019c3400-0000-7000-8000-000000000003'),
  membershipId: parseMembershipId('019c3400-0000-7000-8000-000000000004'),
  purposeId: '019c3400-0000-7000-8000-000000000005',
  purposeRevisionId: '019c3400-0000-7000-8000-000000000006',
  agentRunId: parseAgentRunId('019c3400-0000-7000-8000-000000000007'),
  modelAttemptId: parseModelAttemptId('019c3400-0000-7000-8000-000000000008'),
  modelToolCallId: parseModelToolCallId('019c3400-0000-7000-8000-000000000009')
});
const now = parseInstant('2026-08-13T12:00:00.000Z');
const profile = Object.freeze({
  key: 'profile.communication.authoring-effect-test',
  version: parseContractVersion(1)
});
const digest = (fill: string) => fill.repeat(64);
const purposeRevision = Object.freeze({
  purposeId: ids.purposeId,
  purposeKey: 'speaker.update',
  revisionId: ids.purposeRevisionId,
  revisionNumber: 1,
  digestSha256: digest('a')
});
const operatorEvidence: InvocationEvidence = Object.freeze({
  kind: 'operator',
  surface: 'operator_http',
  client: Object.freeze({ key: 'web.operator' }),
  sessionHandle: 'verified-organizer-session'
});
const modelEvidence: InvocationEvidence = Object.freeze({
  kind: 'app_model',
  surface: 'app_model',
  client: Object.freeze({ key: 'model.organizer' }),
  agentRunId: ids.agentRunId,
  modelAttemptId: ids.modelAttemptId,
  modelToolCallId: ids.modelToolCallId
});
const databases: Database[] = [];

function uuid(suffix: number): string {
  return `019c3400-0000-7000-8000-${suffix.toString(16).padStart(12, '0')}`;
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(
    `SELECT count(*) AS count FROM ${table}`
  ).get()?.count ?? -1;
}

function assertZeroized(buffers: readonly Uint8Array[]): void {
  expect(buffers.length).toBeGreaterThan(0);
  for (const bytes of buffers) {
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  }
}

function observingStore(
  base: SynchronousClassifiedPayloadStore,
  observed: Uint8Array[]
): SynchronousClassifiedPayloadStore {
  return Object.freeze({
    put(input: SynchronousClassifiedPayloadPutInput) {
      observed.push(input.bytes);
      return base.put(input);
    },
    read: base.read.bind(base)
  });
}

function bindAdapter(
  base: SQLiteEffectDomainAdapter,
  overrides: Partial<SQLiteEffectDomainAdapter> = {}
): SQLiteEffectDomainAdapter {
  return Object.freeze({
    openHandlerSnapshot: overrides.openHandlerSnapshot
      ?? base.openHandlerSnapshot.bind(base),
    applyDomainContribution: overrides.applyDomainContribution
      ?? base.applyDomainContribution.bind(base),
    ...(overrides.afterReceiptParentInserted
      ? { afterReceiptParentInserted: overrides.afterReceiptParentInserted }
      : base.afterReceiptParentInserted
        ? { afterReceiptParentInserted: base.afterReceiptParentInserted.bind(base) }
        : {}),
    ...(base.afterReceiptChildInserted
      ? { afterReceiptChildInserted: base.afterReceiptChildInserted.bind(base) }
      : {}),
    ...(base.afterExecutionClaimReleased
      ? { afterExecutionClaimReleased: base.afterExecutionClaimReleased.bind(base) }
      : {}),
    ...(base.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: base.afterUnitOfWorkCommitted.bind(base) }
      : {}),
    ...(base.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: base.afterUnitOfWorkFinished.bind(base) }
      : {})
  });
}

type AuthorityScenario =
  | 'current'
  | 'missing_grant_always'
  | 'missing_grant_in_transaction'
  | 'shift_event_in_transaction';

interface Fixture {
  readonly sqlite: Database;
  readonly observedPayloadBytes: readonly Uint8Array[];
  readonly repository: SQLiteOrganizerCommunicationAuthoringRepository;
  setAuthorityScenario(value: AuthorityScenario): void;
  execute(input: {
    readonly operationName: keyof typeof ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION;
    readonly businessInput: unknown;
    readonly idempotencyKey: string;
    readonly model?: boolean;
  }): Promise<unknown>;
}

function openFixture(input: {
  readonly noEvent?: boolean;
  readonly transformAdapter?: (base: SQLiteEffectDomainAdapter) => SQLiteEffectDomainAdapter;
} = {}): Fixture {
  const sqlite = new Database(':memory:', { strict: true });
  databases.push(sqlite);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE users (id TEXT PRIMARY KEY) STRICT;
  `);
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installSQLiteClassifiedPayloadStoreSchema(sqlite);
  installSQLiteOrganizerCommunicationAuthoringSchema(sqlite);
  installSQLiteOrganizerCommunicationAuthoringEffectSchema(sqlite);
  sqlite.query('INSERT INTO workspaces (id) VALUES (?)').run(ids.workspaceId);
  sqlite.query('INSERT INTO users (id) VALUES (?)').run(ids.userId);
  const spine = new SQLiteEventSpineRepository(sqlite);
  sqlite.transaction(() => {
    const eventSet = spine.bootstrapWorkspaceEventSet(ids.workspaceId);
    if (!input.noEvent) {
      spine.commitEventCreatePlan(planEventCreation({
        eventSet,
        authorInput: {
          expectedEventSetVersion: 1,
          name: 'JooConf',
          timezone: 'Asia/Singapore',
          startDate: '2027-04-16',
          endDate: '2027-04-18'
        },
        server: {
          workspaceId: ids.workspaceId,
          eventId: ids.eventId,
          createdByUserId: ids.userId,
          createdAt: now
        }
      }));
    }
  }).immediate();

  const observedPayloadBytes: Uint8Array[] = [];
  const encryptionProfile = issueSynchronousClassifiedPayloadEncryptionProfile({
    reference: { key: 'encryption.communication-authoring-effect-test', version: 1 },
    keyBytes: new Uint8Array(32).fill(0x71)
  });
  let nonceSeed = 1;
  const classifiedStore = new SQLiteClassifiedPayloadStore(sqlite, {
    encryptionProfile,
    nonceSource(size) {
      const nonce = Uint8Array.from(
        { length: size },
        (_, index) => (nonceSeed + index * 11) % 256
      );
      nonceSeed += 1;
      return nonce;
    }
  });
  const repository = new SQLiteOrganizerCommunicationAuthoringRepository(
    sqlite,
    observingStore(classifiedStore, observedPayloadBytes)
  );
  sqlite.transaction(() => {
    sqlite.query(`
      INSERT INTO communication_purposes (
        workspace_id,event_id,purpose_id,purpose_key,lifecycle,current_revision_id
      ) VALUES (?,?,?,?,?,?)
    `).run(
      ids.workspaceId,
      ids.eventId,
      ids.purposeId,
      purposeRevision.purposeKey,
      'active',
      ids.purposeRevisionId
    );
    sqlite.query(`
      INSERT INTO communication_purpose_revisions (
        workspace_id,event_id,purpose_id,purpose_key,revision_id,revision_number,
        digest_sha256,label,communication_class,policy_digest_sha256,description,
        allowed_audience_sources_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      ids.workspaceId,
      ids.eventId,
      ids.purposeId,
      purposeRevision.purposeKey,
      ids.purposeRevisionId,
      1,
      purposeRevision.digestSha256,
      'Speaker update',
      'transactional',
      digest('b'),
      'A pinned test purpose.',
      '["explicit_contacts"]'
    );
  }).immediate();

  let nextId = 0x100;
  const next = () => uuid(nextId++);
  const registrations = createSQLiteOrganizerCommunicationAuthoringEffectDomainRegistrations({
    sqlite,
    workspaceId: ids.workspaceId,
    repository,
    eventRelationships: createSQLiteEventSpineOperatorEventRelationshipSource(),
    ids: { newTimelineId: next },
    provenanceResolver: {
      resolveAgentProvenance(context: EffectInvocationContext) {
        if (context.provenance.kind !== 'app_model') return undefined;
        return {
          kind: 'agent',
          runRefId: context.provenance.agentRunId,
          scaffold: {
            reference: { key: 'scaffold.communication.compose', version: 1 },
            definitionDigestSha256: digest('c')
          },
          modelProfile: {
            reference: { key: 'model-profile.communication.default', version: 1 },
            definitionDigestSha256: digest('d')
          }
        };
      }
    }
  });
  const baseAdapter = registrations[0]?.adapter;
  if (!baseAdapter || registrations.some((registration) => registration.adapter !== baseAdapter)) {
    throw new TypeError('expected one shared organizer authoring adapter');
  }
  const adapter = input.transformAdapter?.(baseAdapter) ?? baseAdapter;
  const adapters = createSQLiteEffectDomainAdapterRegistry(
    registrations.map((registration) => Object.freeze({
      capability: registration.capability,
      adapter
    }))
  );

  let scenario: AuthorityScenario = 'current';
  let selectionShifted = false;
  const authority: Parameters<
    typeof createOrganizerCommunicationMutationOperationModule
  >[0]['currentAuthority'] = {
    resolve(resolution) {
      const insideTransaction = sqlite.inTransaction;
      if (scenario === 'shift_event_in_transaction' && insideTransaction && !selectionShifted) {
        selectionShifted = true;
        sqlite.query(`
          UPDATE event_spine_workspace_sets
             SET version=version+1,current_event_id=NULL
           WHERE workspace_id=?
        `).run(ids.workspaceId);
      }
      const actor = resolution.evidence.kind === 'operator'
        ? { kind: 'workspace_user' as const, userId: ids.userId }
        : resolution.evidence.kind === 'app_model'
          ? {
              kind: 'app_model_run' as const,
              agentRunId: resolution.evidence.agentRunId,
              delegatedByPrincipalId: `workspace-user:${ids.userId}`
            }
          : undefined;
      if (!actor) return Object.freeze({ kind: 'denied' as const, reason: 'lane_mismatch' as const });
      return Object.freeze({
        kind: 'authorized' as const,
        authority: Object.freeze({
          actor: Object.freeze(actor),
          principal: Object.freeze({
            kind: 'workspace_user' as const,
            userId: ids.userId,
            membershipId: ids.membershipId
          }),
          lane: resolution.lane,
          scope: resolution.scope,
          grants: scenario === 'missing_grant_always'
            || (scenario === 'missing_grant_in_transaction' && insideTransaction)
            ? Object.freeze([])
            : Object.freeze([Object.freeze({
                kind: 'permission' as const,
                key: 'communication.draft'
              })]),
          evidenceIds: Object.freeze(['membership.current']),
          authorityCitationIds: Object.freeze([]),
          evaluatedAt: resolution.evaluatedAt
        })
      });
    }
  };
  const module = createOrganizerCommunicationMutationOperationModule({
    workspaceId: ids.workspaceId,
    policy: ORGANIZER_COMMUNICATION_DRAFT_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: {
      resolveCurrentEvent() {
        const current = spine.readCurrentEventState(ids.workspaceId);
        return current?.currentEvent === undefined
          ? undefined
          : {
              eventId: current.currentEvent.id,
              evidenceIds: [`event.selection:${current.eventSet.version}`]
            };
      }
    },
    clock: { now: () => now },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    crypto: {
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashSealer: {
        seal(bytes) {
          const request = JSON.parse(new TextDecoder().decode(bytes)) as {
            readonly operation?: { readonly name?: unknown };
          };
          if (typeof request.operation?.name !== 'string') {
            throw new TypeError('test request operation missing');
          }
          return {
            verifierProfile: {
              key: `request-hash.communication.organizer.${request.operation.name}`,
              version: 1
            },
            verifierSha256: createHash('sha256')
              .update('organizer-authoring-test-key\0')
              .update(bytes)
              .digest('hex')
          };
        }
      },
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal(raw) {
          return {
            verifierProfile: profile,
            verifierSha256: createHash('sha256')
              .update(`organizer-authoring-idempotency:${raw}`)
              .digest('hex')
          };
        }
      }
    }
  });
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve.bind(authority),
    now: () => now
  });
  let receiptId = 0x800;
  const runtime = createApplicationOperationRuntime({
    source: module.source,
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => now },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newReceiptId: () => uuid(receiptId++)
  });

  return {
    sqlite,
    observedPayloadBytes,
    repository,
    setAuthorityScenario(value) {
      scenario = value;
      selectionShifted = false;
    },
    async execute(effect) {
      const composed = await runtime;
      const evidence = effect.model ? modelEvidence : operatorEvidence;
      const invocation = await composed.effectBuilder.build({
        operationName: effect.operationName,
        operationVersion: 1,
        surface: effect.model ? 'app_model' : 'operator_http',
        correlationId: uuid(0x900),
        businessInput: effect.businessInput,
        verifiedEvidence: evidence,
        rawIdempotencyKey: effect.idempotencyKey
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    sqlite.close(false);
  }
});

function contentInput(subject: string, body: string) {
  return {
    payload: {
      payloadKind: 'message_content' as const,
      schemaVersion: 1 as const,
      value: {
        kind: 'email/v1' as const,
        subject,
        body: { kind: 'plain_text/v1' as const, text: body }
      }
    }
  };
}

function audienceInput() {
  return {
    payload: {
      payloadKind: 'message_audience_draft' as const,
      schemaVersion: 1 as const,
      value: {
        schemaVersion: 1 as const,
        binding: 'current_snapshot' as const,
        purposeRevision,
        source: {
          kind: 'explicit_contacts' as const,
          contactRefIds: ['contact-1', 'contact-2']
        }
      }
    }
  };
}

describe('SQLite organizer communication authoring effect domain', () => {
  test('binds all four exact capabilities and executes operator/model authoring with replay-safe evidence', async () => {
    const fixture = openFixture();
    const operationNames = Object.values(ORGANIZER_COMMUNICATION_MUTATION_OPERATIONS)
      .map((operation) => operation.name);
    expect(Object.keys(ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION))
      .toEqual(operationNames);
    expect(Object.entries(ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION))
      .toEqual(operationNames.map((operationName) => [operationName, {
        key: `capability.communication.organizer.${operationName}`,
        version: 1
      }]));

    const firstContentInput = contentInput('Arrival details', 'PRIVATE-CONTENT-CANARY');
    const firstContent = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'store_communication_authoring_payload',
        businessInput: firstContentInput,
        idempotencyKey: 'content-1'
      })
    );
    const replay = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'store_communication_authoring_payload',
        businessInput: firstContentInput,
        idempotencyKey: 'content-1'
      })
    );
    expect(replay).toEqual(firstContent);
    if (firstContent.kind !== 'success') throw new TypeError('expected content success');

    const audience = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'store_communication_authoring_payload',
        businessInput: audienceInput(),
        idempotencyKey: 'audience-1'
      })
    );
    if (audience.kind !== 'success') throw new TypeError('expected audience success');

    const created = organizerCommunicationDraftMutationOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'create_message_draft',
        businessInput: {
          channel: 'email',
          purposeRevision,
          initial: {
            kind: 'adopted_payload_refs',
            contentPayload: firstContent.data,
            audiencePayload: audience.data
          }
        },
        idempotencyKey: 'draft-create',
        model: true
      })
    );
    if (created.kind !== 'success') throw new TypeError('expected create success');

    const nextContent = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'store_communication_authoring_payload',
        businessInput: contentInput('Updated arrival details', 'PRIVATE-REVISION-CANARY'),
        idempotencyKey: 'content-2'
      })
    );
    if (nextContent.kind !== 'success') throw new TypeError('expected next content success');

    const revised = organizerCommunicationDraftMutationOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'revise_message_batch',
        businessInput: {
          draftId: created.data.draftId,
          expectedVersion: 1,
          contentPayload: nextContent.data,
          audiencePayload: audience.data
        },
        idempotencyKey: 'draft-revise'
      })
    );
    expect(revised).toMatchObject({ kind: 'success', data: { version: 2, state: 'active' } });

    const discarded = organizerCommunicationDraftMutationOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'discard_message_draft',
        businessInput: {
          draftId: created.data.draftId,
          expectedVersion: 2,
          reasonCode: 'user.cancelled'
        },
        idempotencyKey: 'draft-discard'
      })
    );
    expect(discarded).toMatchObject({
      kind: 'success',
      data: { draftId: created.data.draftId, version: 3, state: 'discarded' }
    });
    expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(6);
    expect(count(fixture.sqlite, 'organizer_communication_authoring_receipt_links')).toBe(6);
    expect(count(fixture.sqlite, 'organizer_communication_authoring_timeline')).toBe(6);
    expect(count(fixture.sqlite, 'foundation_trial_operation_execution_claims')).toBe(0);
    expect(fixture.sqlite.query<{ provenance_json: string }, []>(
      'SELECT provenance_json FROM communication_drafts'
    ).get()?.provenance_json).toContain(ids.agentRunId);
    expect(Buffer.from(fixture.sqlite.serialize()).includes(Buffer.from('PRIVATE-CONTENT-CANARY')))
      .toBe(false);
    assertZeroized(fixture.observedPayloadBytes);
    expect(() => fixture.sqlite.query(
      'UPDATE organizer_communication_authoring_timeline SET source_kind=source_kind'
    ).run()).toThrow('organizer communication authoring timeline is immutable');
  });

  test('returns idempotency conflict for changed bytes without re-entering storage or timeline hooks', async () => {
    const fixture = openFixture();
    const first = contentInput('Stable subject', 'STABLE-CONTENT');
    const initial = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'store_communication_authoring_payload',
        businessInput: first,
        idempotencyKey: 'same-key'
      })
    );
    expect(initial.kind).toBe('success');
    const observedCount = fixture.observedPayloadBytes.length;
    const conflict = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'store_communication_authoring_payload',
        businessInput: contentInput('Changed subject', 'CHANGED-CONTENT'),
        idempotencyKey: 'same-key'
      })
    );
    expect(conflict).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });
    expect(fixture.observedPayloadBytes).toHaveLength(observedCount);
    expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
    expect(count(fixture.sqlite, 'organizer_communication_authoring_timeline')).toBe(1);
  });

  test('requires the transaction-local current grant and current Event selection before mutation', async () => {
    const missingGrant = openFixture();
    missingGrant.setAuthorityScenario('missing_grant_in_transaction');
    const denied = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
      await missingGrant.execute({
        operationName: 'store_communication_authoring_payload',
        businessInput: contentInput('Denied', 'SHOULD-NOT-PERSIST'),
        idempotencyKey: 'missing-current-grant'
      })
    );
    expect(denied).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { class: 'access_denied' }
    });
    expect(count(missingGrant.sqlite, 'communication_authoring_payloads')).toBe(0);
    expect(count(missingGrant.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(missingGrant.sqlite, 'foundation_trial_operation_execution_claims')).toBe(0);

    const malformedAuthority = openFixture();
    malformedAuthority.setAuthorityScenario('missing_grant_always');
    await expect(malformedAuthority.execute({
      operationName: 'store_communication_authoring_payload',
      businessInput: contentInput('No grant', 'SHOULD-NOT-PERSIST'),
      idempotencyKey: 'consistently-missing-grant'
    })).rejects.toThrow('Operation execution failed during write_snapshot.');
    expect(count(malformedAuthority.sqlite, 'communication_authoring_payloads')).toBe(0);
    expect(count(malformedAuthority.sqlite, 'foundation_trial_operation_receipts')).toBe(0);

    const shifted = openFixture();
    shifted.setAuthorityScenario('shift_event_in_transaction');
    await expect(shifted.execute({
      operationName: 'store_communication_authoring_payload',
      businessInput: contentInput('Stale Event', 'SHOULD-NOT-PERSIST'),
      idempotencyKey: 'stale-current-event'
    })).rejects.toThrow('Operation execution failed during write_snapshot.');
    expect(count(shifted.sqlite, 'communication_authoring_payloads')).toBe(0);
    expect(count(shifted.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(new SQLiteEventSpineRepository(shifted.sqlite)
      .readCurrentEventState(ids.workspaceId)?.currentEvent?.id).toBe(ids.eventId);
  });

  test('returns event-required nonterminally when both context and transaction see no selection', async () => {
    const fixture = openFixture({ noEvent: true });
    const result = organizerCommunicationAuthoringPayloadOperationResultSchema.parse(
      await fixture.execute({
        operationName: 'store_communication_authoring_payload',
        businessInput: contentInput('No Event', 'SHOULD-NOT-PERSIST'),
        idempotencyKey: 'event-required'
      })
    );
    expect(result).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { class: 'conflict', kind: 'communication.event_required' }
    });
    expect(count(fixture.sqlite, 'communication_authoring_payloads')).toBe(0);
    expect(count(fixture.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(fixture.sqlite, 'organizer_communication_authoring_timeline')).toBe(0);
  });

  test('rejects capability substitution before business writes', async () => {
    const fixture = openFixture({
      transformAdapter(base) {
        return bindAdapter(base, {
          openHandlerSnapshot(_capability, context, authorityRecheck) {
            return base.openHandlerSnapshot(
              ORGANIZER_COMMUNICATION_MUTATION_HANDLER_CAPABILITY_BY_OPERATION.create_message_draft,
              context,
              authorityRecheck
            );
          }
        });
      }
    });
    await expect(fixture.execute({
      operationName: 'store_communication_authoring_payload',
      businessInput: contentInput('Wrong capability', 'SHOULD-NOT-PERSIST'),
      idempotencyKey: 'capability-substitution'
    })).rejects.toThrow('Operation execution failed during write_snapshot.');
    expect(count(fixture.sqlite, 'communication_authoring_payloads')).toBe(0);
    expect(fixture.observedPayloadBytes).toHaveLength(0);
  });

  test('rolls domain, receipt, claim, and timeline back on contribution or late-hook failure and zeroizes bytes', async () => {
    const malformed = openFixture({
      transformAdapter(base) {
        return bindAdapter(base, {
          applyDomainContribution(contribution) {
            const domain = contribution as Record<string, unknown>;
            return base.applyDomainContribution({
              ...domain,
              entityVersion: Number(domain.entityVersion) + 1
            });
          }
        });
      }
    });
    await expect(malformed.execute({
      operationName: 'store_communication_authoring_payload',
      businessInput: contentInput('Malformed contribution', 'ROLLBACK-CONTENT-ONE'),
      idempotencyKey: 'malformed-contribution'
    })).rejects.toThrow('Operation execution failed during domain_contribution.');
    expect(count(malformed.sqlite, 'communication_authoring_payloads')).toBe(0);
    expect(count(malformed.sqlite, 'classified_payload_records')).toBe(0);
    expect(count(malformed.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(malformed.sqlite, 'organizer_communication_authoring_timeline')).toBe(0);
    expect(count(malformed.sqlite, 'foundation_trial_operation_execution_claims')).toBe(0);
    assertZeroized(malformed.observedPayloadBytes);

    const lateFailure = openFixture({
      transformAdapter(base) {
        if (!base.afterReceiptParentInserted) throw new TypeError('receipt hook missing');
        return bindAdapter(base, {
          afterReceiptParentInserted(receipt) {
            base.afterReceiptParentInserted!(receipt);
            throw new TypeError('injected_late_organizer_authoring_failure');
          }
        });
      }
    });
    await expect(lateFailure.execute({
      operationName: 'store_communication_authoring_payload',
      businessInput: contentInput('Late failure', 'ROLLBACK-CONTENT-TWO'),
      idempotencyKey: 'late-hook-failure'
    })).rejects.toThrow('Operation execution failed during receipt_parent.');
    for (const table of [
      'communication_authoring_payloads',
      'classified_payload_records',
      'foundation_trial_operation_receipts',
      'organizer_communication_authoring_receipt_links',
      'organizer_communication_authoring_timeline',
      'foundation_trial_operation_execution_claims'
    ]) {
      expect(count(lateFailure.sqlite, table)).toBe(0);
    }
    assertZeroized(lateFailure.observedPayloadBytes);
  });
});
