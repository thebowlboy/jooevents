import { describe, expect, test } from 'bun:test';
import {
  createEffectInvocationContextBuilder,
  createHmacIdempotencyCredentialSealer,
  createHmacRequestHashSealer,
  recheckEffectInvocationCurrentAuthority
} from '@jooevents/application';
import {
  planChangesetOperationSynchronous,
  type ChangesetPlanningSnapshot
} from '@jooevents/changesets';
import type {
  FieldRegistrySnapshotDto,
  FormVersionDto,
  IntakeScopeDto
} from '@jooevents/contracts';
import {
  parseContractVersion,
  parseCorrelationId,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import {
  FORM_CHANGESET_KIND,
  FORM_CHANGESET_VERSION,
  applyFormChangesetPlan,
  assertFormOrdinaryChangesetBundle,
  createFormOrdinaryChangesetBundle,
  formCatalogGuardId,
  formChangesetReadPort,
  formChangesetTransactionPort,
  formChangesetValidationPort,
  formPlanningAttributionReadPort,
  formVersionSetGuardId,
  formVersionSetGuardVersion,
  parseFormChangesetAuthorInput,
  type FormChangesetReadPort,
  type FormChangesetTransactionPort,
  type FormPlanningAttributionSource
} from './form-changesets';
import {
  captureFormOrdinaryApprovalPolicy,
  issueFormOrdinaryPolicy
} from './form-policy';
import { parseFormCatalogState, type FormCatalogState } from './model';
import type { FormMutationPlan } from './forms';
import {
  fixtureAt,
  fixtureCreateDraft,
  fixtureId,
  fixtureIds,
  fixtureRegistry,
  fixtureScope
} from './test-fixtures';

let invocationSequence = 500;

async function planningAttribution(input: {
  readonly occurredAt: string;
  readonly operation: string;
  readonly correction?: boolean;
}): Promise<FormPlanningAttributionSource> {
  const workspaceId = parseWorkspaceId(fixtureScope.workspaceId);
  const eventId = parseEventId(fixtureScope.eventId);
  const userId = parseUserId(fixtureIds.user);
  const evaluatedAt = parseInstant(input.occurredAt);
  const version = parseContractVersion(1);
  const lane = Object.freeze({
    kind: 'operator' as const,
    surface: 'operator_http' as const,
    policy: Object.freeze({
      key: input.correction ? 'authority.changeset.lifecycle' : 'authority.intake.event-manage',
      version
    })
  });
  const operation = Object.freeze({ name: input.operation, version: 1 });
  const profile = Object.freeze({ key: 'intake.form-test', version });
  const requestHashProfile = Object.freeze({ key: 'request-hash.intake-form-test', version });
  const builder = createEffectInvocationContextBuilder({
    reference: { key: 'context.intake-form-test', version },
    operation,
    effect: 'draft',
    lanes: [lane],
    scopeResolver: {
      resolve: () => Object.freeze({
        workspaceId,
        eventId,
        subjects: Object.freeze([
          Object.freeze({ kind: 'workspace' as const, id: workspaceId }),
          Object.freeze({ kind: 'event' as const, id: eventId }),
          ...(input.correction ? [Object.freeze({
            kind: 'domain' as const,
            domain: 'changeset',
            entity: 'owner',
            id: 'intake_form'
          })] : [])
        ]),
        resolutionEvidenceIds: Object.freeze(['scope:intake-form-test'])
      })
    },
    authorityResolver: {
      resolve(request) {
        return Object.freeze({
          kind: 'authorized' as const,
          authority: Object.freeze({
            actor: Object.freeze({ kind: 'workspace_user' as const, userId }),
            principal: Object.freeze({
              kind: 'workspace_user' as const,
              userId,
              membershipId: parseMembershipId(fixtureId(499))
            }),
            lane: request.lane,
            scope: request.scope,
            grants: Object.freeze([{ kind: 'permission' as const, key: 'event.manage' }]),
            evidenceIds: Object.freeze(['membership:intake-form-test']),
            authorityCitationIds: Object.freeze([]),
            evaluatedAt: request.evaluatedAt
          })
        });
      }
    },
    clock: { now: () => evaluatedAt },
    newInvocationId: () => parseInvocationId(fixtureId(invocationSequence++)),
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashProfile,
    requestHashSealer: createHmacRequestHashSealer({
      profile: requestHashProfile,
      keyBytes: new Uint8Array(32).fill(0x41)
    }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: new Uint8Array(32).fill(0x42)
    }),
    deniedAuthorityOutcome: (reason) => ({
      class: 'access_denied', kind: `authority.${reason}`, retryable: false,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const built = await builder.build({
    operationName: operation.name,
    operationVersion: operation.version,
    surface: 'operator_http',
    correlationId: parseCorrelationId(fixtureId(498)),
    businessInput: {},
    verifiedEvidence: {
      kind: 'operator', surface: 'operator_http', client: { key: 'intake-form-test' },
      sessionHandle: 'session:intake-form-test'
    },
    rawIdempotencyKey: `intake-form-test:${invocationSequence}`
  });
  if (built.kind !== 'ready') throw new TypeError('expected_ready_attribution_context');
  return Object.freeze({
    context: built.context,
    authorityRecheck: await recheckEffectInvocationCurrentAuthority(built.context)
  });
}

class Store implements FormChangesetTransactionPort {
  catalog: FormCatalogState = parseFormCatalogState({
    scope: fixtureScope,
    version: 1,
    heads: []
  });
  registry: FieldRegistrySnapshotDto = fixtureRegistry;
  versions: FormVersionDto[] = [];
  attribution: FormPlanningAttributionSource | undefined;

  readFormCatalog(scope: IntakeScopeDto) {
    return scope.workspaceId === fixtureScope.workspaceId && scope.eventId === fixtureScope.eventId
      ? this.catalog : undefined;
  }
  readFormVersions() { return this.versions; }
  readFieldRegistrySnapshot() { return this.registry; }
  readFormPlanningAttribution() { return this.attribution; }
  resolveActiveCategory() { return undefined; }
  resolveCollectingSession() { return undefined; }
  resolveCurrentDeadline() { return undefined; }
  applyFormPlan(plan: FormMutationPlan) {
    const applied = applyFormChangesetPlan({ port: this, plan });
    this.catalog = applied.catalog;
    if (applied.publishedVersion) this.versions.push(applied.publishedVersion);
    return applied;
  }
}

function snapshot(store: Store): ChangesetPlanningSnapshot {
  return Object.freeze({ getPort: <Port>() => store as unknown as Port });
}

const policy = issueFormOrdinaryPolicy({
  key: 'intake.form.ordinary', version: 1, ordinaryRisk: 'normal',
  approval: { ordinary: 'none' }
});

async function plan(input: {
  readonly store: Store;
  readonly authorInput: unknown;
  readonly operation: string;
  readonly at: string;
}) {
  input.store.attribution = await planningAttribution({
    occurredAt: input.at,
    operation: input.operation
  });
  const bundle = createFormOrdinaryChangesetBundle({ policy });
  return {
    bundle,
    operation: planChangesetOperationSynchronous({
      registry: bundle.registry,
      kind: FORM_CHANGESET_KIND,
      version: FORM_CHANGESET_VERSION,
      dependencyGroup: 'intake_form',
      authorInput: input.authorInput,
      snapshot: snapshot(input.store)
    })
  };
}

async function apply(
  store: Store,
  bundle: ReturnType<typeof createFormOrdinaryChangesetBundle>,
  operation: ReturnType<typeof planChangesetOperationSynchronous>
) {
  const registration = bundle.registry.get(FORM_CHANGESET_KIND, FORM_CHANGESET_VERSION)!;
  const validated = await registration.validateWithin(operation.plan, {
    getPort: <Port>() => store as unknown as Port
  });
  if (validated.kind !== 'ready') throw new TypeError(validated.outcome.kind);
  return registration.applyWithin(validated.validated, {
    getPort: <Port>() => store as unknown as Port
  });
}

describe('Form ordinary changeset definition', () => {
  test('plans Registry-guarded composition creation and applies one Form fact', async () => {
    const store = new Store();
    const authorInput = {
      action: 'create' as const,
      scope: fixtureScope,
      draft: fixtureCreateDraft(),
      identities: { formId: fixtureIds.form, rules: [] },
      deadlineId: null
    };
    expect(parseFormChangesetAuthorInput(authorInput)).toEqual(authorInput);
    const { bundle, operation } = await plan({
      store,
      authorInput,
      operation: 'form.definition.create.draft',
      at: fixtureAt.create
    });
    expect(() => assertFormOrdinaryChangesetBundle(bundle)).not.toThrow();
    expect(captureFormOrdinaryApprovalPolicy({ policy, action: 'create' }).requirement).toBe('none');
    expect(operation.aggregateRefs).toContainEqual({
      id: `field_registry:${fixtureScope.eventId}`,
      version: fixtureRegistry.version
    });
    expect(operation.guardRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: formCatalogGuardId(fixtureScope.eventId), version: 1 }),
      {
        id: `field_registry_guard:${fixtureScope.eventId}`,
        version: fixtureRegistry.version,
        digest: fixtureRegistry.registryDigestSha256
      }
    ]));
    expect(operation.safeDiff).toMatchObject({
      action: 'create',
      before: null,
      after: { id: fixtureIds.form, definition: { composition: fixtureCreateDraft().definition.composition } }
    });
    expect(JSON.stringify(operation.safeDiff)).not.toContain(fixtureIds.user);
    const applied = await apply(store, bundle, operation);
    expect(applied.result).toMatchObject({
      action: 'create', formId: fixtureIds.form, catalogVersion: 2
    });
    expect(applied.facts.map((fact) => fact.kind)).toEqual(['intake_form_changed']);
  });

  test('first Open atomically materializes a FormVersion and transitions the same head', async () => {
    const store = new Store();
    const created = await plan({
      store,
      authorInput: {
        action: 'create', scope: fixtureScope,
        draft: fixtureCreateDraft(),
        identities: { formId: fixtureIds.form, rules: [] },
        deadlineId: null
      },
      operation: 'form.definition.create.draft',
      at: fixtureAt.create
    });
    await apply(store, created.bundle, created.operation);
    const opened = await plan({
      store,
      authorInput: {
        action: 'lifecycle',
        scope: fixtureScope,
        draft: {
          transition: 'publish_and_open',
          formId: fixtureIds.form,
          expectedDefinitionVersion: 1,
          expectedRegistryVersion: fixtureRegistry.version
        },
        formVersionId: fixtureIds.version
      },
      operation: 'form.lifecycle.change.draft',
      at: fixtureAt.publish
    });
    expect(opened.operation.safeDiff).toMatchObject({
      action: 'lifecycle',
      before: { status: 'draft', currentPublishedVersionId: null },
      after: { status: 'open', currentPublishedVersionId: fixtureIds.version },
      publishedVersion: { id: fixtureIds.version, number: 1 }
    });
    expect(opened.operation.guardRefs).toContainEqual(expect.objectContaining({
      id: formVersionSetGuardId(fixtureIds.form),
      version: formVersionSetGuardVersion(0)
    }));
    const result = await apply(store, opened.bundle, opened.operation);
    expect(result.result).toMatchObject({
      action: 'lifecycle',
      publishedVersionId: fixtureIds.version,
      formDefinitionVersion: 2
    });
    expect(store.catalog.heads[0]).toMatchObject({
      status: 'open', currentPublishedVersionId: fixtureIds.version
    });
    expect(store.versions).toHaveLength(1);
  });

  test('author schema refuses browser-invented two-step or malformed first-open identities', () => {
    expect(() => parseFormChangesetAuthorInput({
      action: 'create', scope: fixtureScope,
      draft: fixtureCreateDraft({
        availability: { kind: 'fixed_close_date', displayDate: '2026-09-01' }
      }),
      identities: { formId: fixtureIds.form, rules: [] },
      deadlineId: null
    })).toThrow();
    expect(() => parseFormChangesetAuthorInput({
      action: 'lifecycle', scope: fixtureScope,
      draft: {
        transition: 'reopen',
        formId: fixtureIds.form,
        expectedDefinitionVersion: 2
      },
      formVersionId: fixtureIds.version
    })).toThrow();
  });

  test('declares all collaborator ports without exposing private authority in safe diff', () => {
    const bundle = createFormOrdinaryChangesetBundle({ policy });
    const registration = bundle.registry.get(FORM_CHANGESET_KIND, FORM_CHANGESET_VERSION)!;
    expect(registration.readPorts).toContain(formChangesetReadPort);
    expect(registration.readPorts).toContain(formPlanningAttributionReadPort);
    expect(registration.validationPorts).toContain(formChangesetValidationPort);
    expect(registration.transactionPorts).toContain(formChangesetTransactionPort);
  });
});
