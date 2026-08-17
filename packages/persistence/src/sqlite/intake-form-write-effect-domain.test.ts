import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  composeOperationRegistryModules,
  createApplicationOperationRuntime,
  createHmacRequestHashSealer,
  type InvocationEvidence
} from '@jooevents/application';
import {
  intakeFormDirectOperationResultSchema,
  intakeFormVersionPublishOperationResultSchema,
  intakeFormVersionReviewDraftOperationResultSchema
} from '@jooevents/contracts';
import {
  INTAKE_EVENT_MANAGE_ACCESS_POLICY,
  INTAKE_FORM_CREATE_OPERATION,
  INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE,
  INTAKE_FORM_LIFECYCLE_OPERATION,
  INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE,
  INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE,
  INTAKE_FORM_VERSION_PUBLISH_OPERATION,
  INTAKE_FORM_VERSION_REVIEW_DRAFT_OPERATION,
  createIntakeFormWriteOperationModule
} from '@jooevents/intake-operations';
import {
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId,
  type Instant
} from '@jooevents/kernel';
import { installDeadlineSchema } from './deadline';
import {
  createSQLiteEventSpineOperatorEventRelationshipSource,
  installEventSpineSchema
} from './event-spine';
import { initializeCanonicalFieldRegistry, installFieldRegistrySchema } from './field-registry';
import {
  createSQLiteEffectDomainAdapterRegistry,
  installFoundationTrialUnitOfWorkSchema
} from './foundation-trial-uow';
import { installSQLiteIntakeSchema, SQLiteIntakeRepository } from './intake';
import {
  createSQLiteIntakeFormWriteEffectDomainRegistrations,
  installIntakeFormWriteEffectSchema
} from './intake-form-write-effect-domain';
import { installReleaseSchema } from './release';
import { installProgramVocabularySchema } from './program-vocabulary';
import { SQLiteEffectUnitOfWorkPort } from './sqlite-effect-unit-of-work';

const id = (suffix: number): string =>
  `019c1df9-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const workspaceId = parseWorkspaceId(id(1));
const eventId = parseEventId(id(2));
const userId = parseUserId(id(3));
const membershipId = parseMembershipId(id(4));
const start = parseInstant('2026-08-16T05:00:00.000Z');
const profile = Object.freeze({ key: 'intake-form-write-test', version: parseContractVersion(1) });
const evidence: InvocationEvidence = Object.freeze({
  kind: 'operator', surface: 'operator_http', client: { key: 'web.operator' },
  sessionHandle: 'verified-session-handle'
});

function openFixture() {
  const sqlite = new Database(':memory:', { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON;');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installEventSpineSchema(sqlite);
  installDeadlineSchema(sqlite);
  installProgramVocabularySchema(sqlite);
  installSQLiteIntakeSchema(sqlite);
  installFieldRegistrySchema(sqlite);
  installReleaseSchema(sqlite);
  installIntakeFormWriteEffectSchema(sqlite);
  sqlite.query(`INSERT INTO workspaces (id, name, state, created_at, updated_at, version)
    VALUES (?, 'Workspace', 'active', 1, 1, 1)`).run(workspaceId);
  sqlite.query(`INSERT INTO users (id, status, display_name, created_at, updated_at, version)
    VALUES (?, 'active', 'Organizer', 1, 1, 1)`).run(userId);
  sqlite.exec('BEGIN IMMEDIATE');
  sqlite.query(`INSERT INTO event_spine_workspace_sets (workspace_id, version, current_event_id)
    VALUES (?, 1, NULL)`).run(workspaceId);
  sqlite.query(`INSERT INTO event_spine_heads (
      workspace_id, id, name, timezone, start_date, end_date, version,
      created_by_user_id, created_at_ms, create_plan_digest_sha256
    ) VALUES (?, ?, 'Form Event', 'UTC', '2027-01-01', '2027-01-02', 1, ?, ?, ?)`)
    .run(workspaceId, eventId, userId, Date.parse(start), 'a'.repeat(64));
  sqlite.query(`INSERT INTO event_spine_scope_roots (workspace_id, event_id) VALUES (?, ?)`)
    .run(workspaceId, eventId);
  sqlite.query(`UPDATE event_spine_workspace_sets
    SET version = 2, current_event_id = ? WHERE workspace_id = ?`).run(eventId, workspaceId);
  sqlite.exec('COMMIT');
  sqlite.query(`INSERT INTO program_vocabulary_sets (
      workspace_id, event_id, set_version, created_by_user_id, created_at_ms,
      updated_by_user_id, updated_at_ms
    ) VALUES (?, ?, 2, ?, ?, ?, ?)`)
    .run(workspaceId, eventId, userId, Date.parse(start), userId, Date.parse(start));
  sqlite.query(`INSERT INTO program_vocabulary_tracks (
      workspace_id, event_id, id, name, status, version,
      created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
    ) VALUES (?, ?, ?, 'Engineering', 'active', 1, ?, ?, ?, ?)`)
    .run(workspaceId, eventId, id(0x501), userId, Date.parse(start), userId, Date.parse(start));
  sqlite.query(`INSERT INTO program_vocabulary_formats (
      workspace_id, event_id, id, name, status, version,
      created_by_user_id, created_at_ms, updated_by_user_id, updated_at_ms
    ) VALUES (?, ?, ?, 'Talk', 'active', 1, ?, ?, ?, ?)`)
    .run(workspaceId, eventId, id(0x502), userId, Date.parse(start), userId, Date.parse(start));
  let generated = 0x1000;
  const next = () => id(generated++);
  sqlite.transaction(() => initializeCanonicalFieldRegistry({
    sqlite,
    scope: { workspaceId, eventId },
    ids: { newFieldId: next, newChoiceId: next }
  })).immediate();
  const repository = new SQLiteIntakeRepository(sqlite, {
    resolveActiveCategory: () => undefined,
    resolveCollectingSession: () => undefined
  });
  const registrations = createSQLiteIntakeFormWriteEffectDomainRegistrations({
    sqlite,
    workspaceId,
    repository,
    eventRelationships: createSQLiteEventSpineOperatorEventRelationshipSource(),
    ids: {
      newFormEntityId: next,
      newFormVersionId: next,
      newReviewDraftId: next,
      newReviewRevisionId: next
    }
  });
  let currentTime: Instant = start;
  const authority: Parameters<typeof createIntakeFormWriteOperationModule>[0]['currentAuthority'] = {
    resolve(input) {
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId },
          principal: { kind: 'workspace_user', userId, membershipId },
          lane: input.lane,
          scope: input.scope,
          grants: [{ kind: 'permission', key: 'event.manage' }],
          evidenceIds: ['membership.current'],
          authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
  const requestSealer = (requestProfile: typeof INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE) =>
    createHmacRequestHashSealer({
      profile: requestProfile,
      keyBytes: new Uint8Array(32).fill(requestProfile.key.includes('publish') ? 0x62 : 0x61)
    });
  const module = createIntakeFormWriteOperationModule({
    workspaceId,
    policy: INTAKE_EVENT_MANAGE_ACCESS_POLICY,
    currentAuthority: authority,
    currentEvent: { resolveCurrentEvent: () => ({ eventId, evidenceIds: ['event.current'] }) },
    clock: { now: () => currentTime },
    ids: { newInvocationId: () => parseInvocationId(next()) },
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    directRequestHashSealer: requestSealer(INTAKE_FORM_DIRECT_REQUEST_HASH_PROFILE),
    reviewRequestHashSealer: requestSealer(INTAKE_FORM_REVIEW_DRAFT_REQUEST_HASH_PROFILE),
    publishRequestHashSealer: requestSealer(INTAKE_FORM_PUBLISH_REQUEST_HASH_PROFILE),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      seal(raw: string) {
        return {
          verifierProfile: profile,
          verifierSha256: createHash('sha256').update(`form:${raw}`).digest('hex')
        };
      }
    }
  });
  const adapters = createSQLiteEffectDomainAdapterRegistry(registrations);
  const unitOfWork = new SQLiteEffectUnitOfWorkPort(sqlite, adapters, {
    resolveAuthority: authority.resolve,
    now: () => currentTime
  });
  let receipt = 0x8000;
  const runtime = createApplicationOperationRuntime({
    source: composeOperationRegistryModules([module]),
    read: {
      operationalTrace: { emit() {} },
      immutableAudit: { append() {} },
      clock: { now: () => currentTime },
      newInvocationId: () => parseInvocationId(next())
    },
    unitOfWork,
    newOperationLogId: () => id(receipt++)
  });
  let correlation = 0x9000;
  return {
    sqlite,
    repository,
    registry: repository.readFieldRegistrySnapshot({ workspaceId, eventId })!,
    close: () => sqlite.close(),
    advance() {
      currentTime = parseInstant(new Date(Date.parse(currentTime) + 1_000).toISOString());
    },
    async effect(operation: { readonly name: string; readonly version: number }, input: unknown, key: string) {
      const composed = await runtime;
      const invocation = await composed.effectBuilder.build({
        operationName: operation.name,
        operationVersion: operation.version,
        surface: 'operator_http',
        correlationId: id(correlation++),
        businessInput: input,
        verifiedEvidence: evidence,
        rawIdempotencyKey: key
      });
      return composed.effectExecutor.execute(invocation);
    }
  };
}

function count(fixture: ReturnType<typeof openFixture>, table: string): number {
  return fixture.sqlite.query<{ total: number }, []>(`SELECT count(*) AS total FROM ${table}`)
    .get()?.total ?? -1;
}

describe('SQLite Intake Form owner write effect domain', () => {
  test('refuses publication when a required vocabulary choice exposes no answers', async () => {
    const fixture = openFixture();
    try {
      fixture.sqlite.query(`UPDATE program_vocabulary_tracks
        SET status = 'retired', version = 2, updated_at_ms = updated_at_ms + 1
        WHERE workspace_id = ? AND event_id = ?`).run(workspaceId, eventId);
      const registry = fixture.repository.readFieldRegistrySnapshot({ workspaceId, eventId });
      if (!registry) throw new Error('Field registry missing.');
      const created = intakeFormDirectOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_CREATE_OPERATION,
        {
          expectedCatalogVersion: 1,
          expectedRegistryVersion: registry.version,
          definition: {
            kind: 'cfp',
            name: 'Impossible CFP',
            target: { kind: 'general_pool' },
            availability: { kind: 'evergreen' },
            confirmation: 'Application received.',
            composition: {
              excludedFieldIds: [],
              requiredOverrides: {},
              optionExposure: {}
            },
            rules: []
          }
        },
        'impossible-form-create'
      ));
      expect(created.kind).toBe('success');
      if (created.kind !== 'success') throw new Error('Form create failed.');
      const review = intakeFormVersionReviewDraftOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_VERSION_REVIEW_DRAFT_OPERATION,
        {
          action: 'publish_and_open',
          formId: created.data.formId,
          expectedDefinitionVersion: 1,
          expectedRegistryVersion: registry.version
        },
        'impossible-form-review'
      ));
      expect(review).toMatchObject({
        kind: 'outcome',
        outcome: {
          class: 'policy_violation',
          kind: 'intake_form.change_refused',
          detail: {
            code: 'required_choice_has_no_options',
            action: 'publish_and_open',
            formId: created.data.formId
          }
        }
      });
      expect(count(fixture, 'intake_form_versions')).toBe(0);
      expect(fixture.repository.readFormHead(
        { workspaceId, eventId }, created.data.formId
      )?.status).toBe('draft');
    } finally {
      fixture.close();
    }
  });

  test('keeps review inert, publishes exactly, replays, and corrects lifecycle forward', async () => {
    const fixture = openFixture();
    try {
      const createInput = {
        expectedCatalogVersion: 1,
        expectedRegistryVersion: fixture.registry.version,
        definition: {
          kind: 'cfp' as const,
          name: 'Main CFP',
          target: { kind: 'general_pool' as const },
          availability: { kind: 'evergreen' as const },
          confirmation: 'Application received.',
          composition: { excludedFieldIds: [], requiredOverrides: {}, optionExposure: {} },
          rules: []
        }
      };
      const created = intakeFormDirectOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_CREATE_OPERATION, createInput, 'form-create'
      ));
      expect(created).toMatchObject({ kind: 'success', data: { action: 'create' } });
      if (created.kind !== 'success') throw new Error('Form create failed.');
      const formId = created.data.formId;

      fixture.advance();
      const drafted = intakeFormVersionReviewDraftOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_VERSION_REVIEW_DRAFT_OPERATION,
        {
          action: 'publish_and_open',
          formId,
          expectedDefinitionVersion: 1,
          expectedRegistryVersion: fixture.registry.version
        },
        'form-review'
      ));
      expect(drafted).toMatchObject({
        kind: 'success',
        data: {
          action: 'publish_and_open', status: 'draft',
          safeDiff: { action: 'publish_and_open', surfaceSuccessors: [] }
        }
      });
      if (drafted.kind !== 'success') throw new Error('Form review failed.');
      expect(count(fixture, 'intake_form_versions')).toBe(0);
      expect(fixture.repository.readFormHead({ workspaceId, eventId }, formId)?.status).toBe('draft');
      expect(count(fixture, 'intake_form_version_review_drafts')).toBe(1);

      const selector = {
        draftId: drafted.data.draftId,
        revisionId: drafted.data.revision.id,
        revisionDigestSha256: drafted.data.revision.digestSha256
      };
      fixture.advance();
      const published = intakeFormVersionPublishOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_VERSION_PUBLISH_OPERATION, selector, 'form-publish'
      ));
      expect(published).toMatchObject({
        kind: 'success',
        data: { action: 'publish_and_open', formId, formDefinitionVersion: 2 }
      });
      if (published.kind !== 'success') throw new Error('Form publish failed.');
      expect(fixture.repository.readFormHead({ workspaceId, eventId }, formId)?.status).toBe('open');
      expect(count(fixture, 'intake_form_versions')).toBe(1);
      expect(fixture.sqlite.query<{ readonly status: string }, []>(
        'SELECT status FROM intake_form_version_review_drafts'
      ).get()?.status).toBe('published');

      const replay = intakeFormVersionPublishOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_VERSION_PUBLISH_OPERATION, selector, 'form-publish'
      ));
      expect(replay).toMatchObject({ kind: 'success', receipt: { id: published.receipt.id } });
      expect(count(fixture, 'intake_form_versions')).toBe(1);

      const changed = intakeFormVersionPublishOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_VERSION_PUBLISH_OPERATION,
        { ...selector, revisionDigestSha256: 'b'.repeat(64) },
        'form-publish'
      ));
      expect(changed).toMatchObject({
        kind: 'outcome', terminal: false,
        outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
      });

      fixture.advance();
      const closed = intakeFormDirectOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_LIFECYCLE_OPERATION,
        { transition: 'close', formId, expectedDefinitionVersion: 2 },
        'form-close'
      ));
      expect(closed).toMatchObject({ kind: 'success', data: { action: 'close' } });
      fixture.advance();
      const reopened = intakeFormDirectOperationResultSchema.parse(await fixture.effect(
        INTAKE_FORM_LIFECYCLE_OPERATION,
        { transition: 'reopen', formId, expectedDefinitionVersion: 3 },
        'form-reopen'
      ));
      expect(reopened).toMatchObject({ kind: 'success', data: { action: 'reopen' } });
      expect(fixture.sqlite.query<{ readonly summary: string }, []>(`
        SELECT summary FROM operation_log ORDER BY occurred_at_ms, id
      `).all().map((row) => row.summary)).toEqual([
        'Created a form',
        'Completed form.version.publish.draft',
        'Published and opened a form',
        'Closed a form',
        'Reopened a form'
      ]);
      expect(fixture.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
