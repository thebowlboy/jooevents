import { createHash } from 'node:crypto';
import {
  FORM_EMAIL_MAX_LENGTH,
  FORM_LONG_TEXT_MAX_LENGTH,
  FORM_MULTISELECT_MAX_SELECTIONS,
  FORM_PHONE_MAX_LENGTH,
  FORM_TEXT_MAX_LENGTH,
  FORM_URL_MAX_LENGTH,
  formDefinitionAuthorInputSchema,
  formDefinitionContentSchema,
  formDefinitionCreateDraftInputSchema,
  formDefinitionHeadSchema,
  formDeadlineReferencePinSchema,
  formClosingChangeDraftInputSchema,
  formLifecycleChangeDraftInputSchema,
  formTargetReferencePinSchema,
  formVersionDefinitionContentSchema,
  formVersionPublishDraftInputSchema,
  formVersionSchema,
  intakeIdSchema,
  intakeInstantSchema,
  intakeScopeSchema,
  type FieldRegistryFieldViewDto,
  type FieldRegistrySnapshotDto,
  type FormDeadlineReferencePinDto,
  type FormClosingChangeDraftInput,
  type FormDefinitionAuthorInput,
  type FormDefinitionCreateAuthorInput,
  type FormDefinitionContentDto,
  type FormDefinitionCreateDraftInput,
  type FormDefinitionHeadDto,
  type FormDefinitionReviseDraftInput,
  type FormFieldDefinitionDto,
  type FormLifecycleChangeDraftInput,
  type FormRegistryPinDto,
  type FormTarget,
  type FormTargetReferencePinDto,
  type FormVersionDefinitionContentDto,
  type FormVersionDto,
  type FormVersionPublishDraftInput,
  type FormVersionRuleDto,
  type IntakeScopeDto
} from '@jooevents/contracts';
import {
  formCloseDeadlinePin,
  type FormCloseDeadlineContribution
} from '@jooevents/deadline';
import { encodeCanonicalJson } from '@jooevents/kernel';
import { deadlineMutationPlanSchema } from '@jooevents/contracts/deadlines';
import {
  analyzeFormComposition,
  compareCanonicalText,
  deepFreeze,
  formRegistryPin,
  parseFormCatalogState,
  parseFormDefinitionHead,
  parseFormVersion,
  sameIntakeScope,
  type FormCatalogState,
  type IntakeFormReferenceSource
} from './model';

export interface FormDefinitionIdentityAssignment {
  readonly formId: string;
  readonly rules: readonly { readonly key: string; readonly id: string }[];
}

export interface FormTargetReferenceResolver extends IntakeFormReferenceSource {}

export type FormPlanningErrorCode =
  | 'wrong_scope'
  | 'stale_catalog'
  | 'stale_definition'
  | 'stale_registry'
  | 'form_exists'
  | 'form_missing'
  | 'form_not_publishable'
  | 'required_choice_has_no_options'
  | 'form_version_exists'
  | 'category_missing'
  | 'category_changed'
  | 'session_unavailable'
  | 'session_changed'
  | 'deadline_unavailable'
  | 'deadline_changed'
  | 'invalid_identity_assignment'
  | 'invalid_definition'
  | 'invalid_transition'
  | 'invalid_plan';

export class FormPlanningError extends Error {
  constructor(readonly code: FormPlanningErrorCode) {
    super(code);
    this.name = 'FormPlanningError';
  }
}

interface FormPlanBase {
  readonly scope: IntakeScopeDto;
  readonly targetPin: FormTargetReferencePinDto | null;
  readonly deadlinePin: FormDeadlineReferencePinDto | null;
}

interface RegistryGuardedPlan {
  readonly registryPin: FormRegistryPinDto;
}

export interface FormCreatePlan extends FormPlanBase, RegistryGuardedPlan {
  readonly action: 'create';
  readonly deadlineContribution: FormCloseDeadlineContribution | null;
  readonly expectedCatalogVersion: number;
  readonly catalogGuardDigestSha256: string;
  readonly resultingCatalogVersion: number;
  readonly before: null;
  readonly after: FormDefinitionHeadDto;
}

export interface FormRevisePlan extends FormPlanBase, RegistryGuardedPlan {
  readonly action: 'revise';
  readonly before: FormDefinitionHeadDto;
  readonly after: FormDefinitionHeadDto;
}

export interface FormPublishPlan extends FormPlanBase, RegistryGuardedPlan {
  readonly action: 'publish';
  readonly expectedLatestVersionNumber: number;
  readonly versionSetDigestSha256: string;
  readonly before: FormDefinitionHeadDto;
  readonly after: FormDefinitionHeadDto;
  readonly publishedVersion: FormVersionDto;
}

export interface FormLifecyclePlan extends FormPlanBase {
  readonly action: 'lifecycle';
  readonly registryPin: FormRegistryPinDto | null;
  readonly expectedLatestVersionNumber: number | null;
  readonly versionSetDigestSha256: string | null;
  readonly before: FormDefinitionHeadDto;
  readonly after: FormDefinitionHeadDto;
  readonly publishedVersion: FormVersionDto | null;
}

export interface FormClosingPlan extends FormPlanBase {
  readonly action: 'closing';
  readonly before: FormDefinitionHeadDto;
  readonly after: FormDefinitionHeadDto;
  readonly deadlineContribution: FormCloseDeadlineContribution;
}

export type FormMutationPlan =
  | FormCreatePlan
  | FormRevisePlan
  | FormPublishPlan
  | FormLifecyclePlan
  | FormClosingPlan;

export interface AppliedFormMutation {
  readonly catalog: FormCatalogState;
  readonly publishedVersion: FormVersionDto | null;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(encodeCanonicalJson(value)).digest('hex');
}

export function formCatalogDigest(catalog: FormCatalogState): string {
  return sha256({
    scope: catalog.scope,
    version: catalog.version,
    heads: catalog.heads.map((head) => ({ id: head.id, version: head.version }))
  });
}

export function formDefinitionDigest(definition: FormDefinitionContentDto): string {
  return sha256(definition);
}

export function formVersionSetDigest(versions: readonly FormVersionDto[]): string {
  return sha256([...versions]
    .map(parseFormVersion)
    .sort((left, right) => left.number - right.number || compareCanonicalText(left.id, right.id)));
}

export function formMutationPlanDigest(plan: FormMutationPlan): string {
  return sha256(plan);
}

/** Rehydrates persisted exact-plan evidence without compatibility normalization. */
export function parseFormMutationPlan(value: unknown): FormMutationPlan {
  try {
    const root = exactRecord(value);
    const action = root.action;
    const scope = intakeScopeSchema.parse(root.scope);
    const targetPin = parseTargetPin(root.targetPin);
    const deadlinePin = parseDeadlinePin(root.deadlinePin);
    if (action === 'create') {
      assertExactKeys(root, [
        'action', 'scope', 'targetPin', 'deadlinePin', 'registryPin',
        'expectedCatalogVersion', 'catalogGuardDigestSha256', 'resultingCatalogVersion',
        'deadlineContribution', 'before', 'after'
      ]);
      if (root.before !== null) throw new TypeError();
      return deepFreeze({
        action,
        scope,
        targetPin,
        deadlinePin,
        deadlineContribution: root.deadlineContribution === null
          ? null : parseDeadlineContribution(root.deadlineContribution),
        registryPin: parseRegistryPin(root.registryPin),
        expectedCatalogVersion: positiveVersion(root.expectedCatalogVersion),
        catalogGuardDigestSha256: digestValue(root.catalogGuardDigestSha256),
        resultingCatalogVersion: positiveVersion(root.resultingCatalogVersion),
        before: null,
        after: parseFormDefinitionHead(root.after)
      });
    }
    if (action === 'revise') {
      assertExactKeys(root, [
        'action', 'scope', 'targetPin', 'deadlinePin', 'registryPin', 'before', 'after'
      ]);
      return deepFreeze({
        action,
        scope,
        targetPin,
        deadlinePin,
        registryPin: parseRegistryPin(root.registryPin),
        before: parseFormDefinitionHead(root.before),
        after: parseFormDefinitionHead(root.after)
      });
    }
    if (action === 'lifecycle') {
      assertExactKeys(root, [
        'action', 'scope', 'targetPin', 'deadlinePin', 'registryPin',
        'expectedLatestVersionNumber', 'versionSetDigestSha256', 'before', 'after',
        'publishedVersion'
      ]);
      return deepFreeze({
        action,
        scope,
        targetPin,
        deadlinePin,
        registryPin: root.registryPin === null ? null : parseRegistryPin(root.registryPin),
        expectedLatestVersionNumber: root.expectedLatestVersionNumber === null
          ? null : nonnegativeVersion(root.expectedLatestVersionNumber),
        versionSetDigestSha256: root.versionSetDigestSha256 === null
          ? null : digestValue(root.versionSetDigestSha256),
        before: parseFormDefinitionHead(root.before),
        after: parseFormDefinitionHead(root.after),
        publishedVersion: root.publishedVersion === null
          ? null : parseFormVersion(root.publishedVersion)
      });
    }
    if (action === 'closing') {
      assertExactKeys(root, [
        'action', 'scope', 'targetPin', 'deadlinePin',
        'before', 'after', 'deadlineContribution'
      ]);
      return deepFreeze({
        action,
        scope,
        targetPin,
        deadlinePin,
        before: parseFormDefinitionHead(root.before),
        after: parseFormDefinitionHead(root.after),
        deadlineContribution: parseDeadlineContribution(root.deadlineContribution)
      });
    }
    if (action === 'publish') {
      assertExactKeys(root, [
        'action', 'scope', 'targetPin', 'deadlinePin', 'registryPin',
        'expectedLatestVersionNumber', 'versionSetDigestSha256', 'before', 'after',
        'publishedVersion'
      ]);
      return deepFreeze({
        action,
        scope,
        targetPin,
        deadlinePin,
        registryPin: parseRegistryPin(root.registryPin),
        expectedLatestVersionNumber: nonnegativeVersion(root.expectedLatestVersionNumber),
        versionSetDigestSha256: digestValue(root.versionSetDigestSha256),
        before: parseFormDefinitionHead(root.before),
        after: parseFormDefinitionHead(root.after),
        publishedVersion: parseFormVersion(root.publishedVersion)
      });
    }
    throw new TypeError();
  } catch {
    throw new FormPlanningError('invalid_plan');
  }
}

export function materializeFormDefinition(input: {
  readonly authorInput: FormDefinitionAuthorInput;
  readonly identities: FormDefinitionIdentityAssignment;
}): FormDefinitionContentDto {
  const author = formDefinitionAuthorInputSchema.parse(input.authorInput);
  const identities = parseIdentityAssignment(input.identities);
  const assignments = exactIdentityMap(
    author.rules.map((rule) => rule.key),
    identities.rules
  );
  const rules = author.rules.map((rule, position) => ({
    id: assignments.get(rule.key)!.id,
    key: rule.key,
    position,
    condition: rule.condition.kind === 'selected_any'
      ? {
          kind: 'selected_any' as const,
          sourceFieldId: rule.condition.sourceFieldId,
          choiceIds: [...rule.condition.choiceIds].sort(compareCanonicalText)
        }
      : { ...rule.condition },
    effect: {
      kind: rule.effect.kind,
      targetFieldIds: [...rule.effect.targetFieldIds].sort(compareCanonicalText)
    }
  }));
  const parsed = formDefinitionContentSchema.safeParse({
    kind: author.kind,
    name: author.name,
    target: author.target,
    availability: author.availability,
    confirmation: author.confirmation,
    composition: author.composition,
    rules
  });
  if (!parsed.success) throw new FormPlanningError('invalid_definition');
  return deepFreeze(parsed.data);
}

export function materializeFormCreationDefinition(input: {
  readonly authorInput: FormDefinitionCreateAuthorInput;
  readonly identities: FormDefinitionIdentityAssignment;
  readonly deadlinePin: FormDeadlineReferencePinDto | null;
}): FormDefinitionContentDto {
  const author = formDefinitionCreateDraftInputSchema.shape.definition.parse(input.authorInput);
  const availability = author.availability.kind === 'evergreen'
    ? (() => {
        if (input.deadlinePin !== null) throw new FormPlanningError('invalid_definition');
        return { kind: 'evergreen' as const };
      })()
    : (() => {
        if (input.deadlinePin === null || input.deadlinePin.displayDate !== author.availability.displayDate) {
          throw new FormPlanningError('deadline_changed');
        }
        return { kind: 'deadline' as const, deadlineId: input.deadlinePin.id };
      })();
  return materializeFormDefinition({
    authorInput: { ...author, availability },
    identities: input.identities
  });
}

export function planFormCreation(input: {
  readonly catalog: FormCatalogState;
  readonly registry: FieldRegistrySnapshotDto;
  readonly authorInput: FormDefinitionCreateDraftInput;
  readonly identities: FormDefinitionIdentityAssignment;
  readonly references: FormTargetReferenceResolver;
  readonly deadlineContribution: FormCloseDeadlineContribution | null;
  readonly server: { readonly createdByUserId: string; readonly createdAt: string };
}): FormCreatePlan {
  const catalog = parseFormCatalogState(input.catalog);
  assertRegistryScope(catalog.scope, input.registry, input.authorInput.expectedRegistryVersion);
  if (input.authorInput.expectedCatalogVersion !== catalog.version) {
    throw new FormPlanningError('stale_catalog');
  }
  const deadlineContribution = input.deadlineContribution === null
    ? null : parseDeadlineContribution(input.deadlineContribution);
  if (deadlineContribution !== null
      && (deadlineContribution.input.action !== 'create'
        || !sameIntakeScope(deadlineContribution.input.scope, catalog.scope)
        || deadlineContribution.input.attributedByUserId !== input.server.createdByUserId
        || deadlineContribution.input.attributedAt !== input.server.createdAt)) {
    throw new FormPlanningError('invalid_plan');
  }
  const deadlinePin = deadlineContribution === null ? null : formCloseDeadlinePin(deadlineContribution);
  const definition = materializeFormCreationDefinition({
    authorInput: input.authorInput.definition,
    identities: input.identities,
    deadlinePin
  });
  if (catalog.heads.some((head) => head.id === input.identities.formId)) {
    throw new FormPlanningError('form_exists');
  }
  assertDefinitionCurrent(input.identities.formId, definition, input.registry);
  const targetPin = resolveTargetPin(catalog.scope, definition.target, input.references);
  const userId = intakeIdSchema.parse(input.server.createdByUserId);
  const at = intakeInstantSchema.parse(input.server.createdAt);
  const after = formDefinitionHeadSchema.parse({
    schemaVersion: 1,
    id: intakeIdSchema.parse(input.identities.formId),
    scope: catalog.scope,
    version: 1,
    status: 'draft',
    currentPublishedVersionId: null,
    definition,
    createdByUserId: userId,
    createdAt: at,
    updatedByUserId: userId,
    updatedAt: at
  });
  return deepFreeze({
    action: 'create',
    scope: catalog.scope,
    targetPin,
    deadlinePin,
    deadlineContribution,
    registryPin: formRegistryPin(input.registry),
    expectedCatalogVersion: catalog.version,
    catalogGuardDigestSha256: formCatalogDigest(catalog),
    resultingCatalogVersion: catalog.version + 1,
    before: null,
    after
  });
}

export function planFormRevision(input: {
  readonly head: FormDefinitionHeadDto;
  readonly registry: FieldRegistrySnapshotDto;
  readonly authorInput: FormDefinitionReviseDraftInput;
  readonly identities: FormDefinitionIdentityAssignment;
  readonly references: FormTargetReferenceResolver;
  readonly server: { readonly updatedByUserId: string; readonly updatedAt: string };
}): FormRevisePlan {
  const before = parseFormDefinitionHead(input.head);
  assertRegistryScope(before.scope, input.registry, input.authorInput.expectedRegistryVersion);
  if (input.authorInput.formId !== before.id) throw new FormPlanningError('form_missing');
  if (input.authorInput.expectedDefinitionVersion !== before.version) {
    throw new FormPlanningError('stale_definition');
  }
  if (input.identities.formId !== before.id) throw new FormPlanningError('invalid_identity_assignment');
  assertPreservedRuleIdentities(before.definition, input.authorInput.definition, input.identities);
  const definition = materializeFormDefinition({
    authorInput: input.authorInput.definition,
    identities: input.identities
  });
  assertDefinitionCurrent(before.id, definition, input.registry);
  const targetPin = resolveTargetPin(before.scope, definition.target, input.references);
  const deadlinePin = resolveDeadlinePin(before.scope, definition.availability, input.references);
  const after = formDefinitionHeadSchema.parse({
    ...before,
    version: before.version + 1,
    definition,
    updatedByUserId: intakeIdSchema.parse(input.server.updatedByUserId),
    updatedAt: intakeInstantSchema.parse(input.server.updatedAt)
  });
  return deepFreeze({
    action: 'revise', scope: before.scope, targetPin, deadlinePin,
    registryPin: formRegistryPin(input.registry), before, after
  });
}

export function planFormPublication(input: {
  readonly head: FormDefinitionHeadDto;
  readonly registry: FieldRegistrySnapshotDto;
  readonly existingVersions: readonly FormVersionDto[];
  readonly authorInput: FormVersionPublishDraftInput;
  readonly references: FormTargetReferenceResolver;
  readonly server: {
    readonly formVersionId: string;
    readonly publishedByUserId: string;
    readonly publishedAt: string;
  };
}): FormPublishPlan {
  const before = parseFormDefinitionHead(input.head);
  const author = formVersionPublishDraftInputSchema.parse(input.authorInput);
  assertRegistryScope(before.scope, input.registry, author.expectedRegistryVersion);
  if (author.formId !== before.id) throw new FormPlanningError('form_missing');
  if (author.expectedDefinitionVersion !== before.version) {
    throw new FormPlanningError('stale_definition');
  }
  const definition = materializeFormVersionDefinition(before, input.registry);
  const versions = orderedVersions(input.existingVersions, before);
  const versionId = intakeIdSchema.parse(input.server.formVersionId);
  if (versions.some((version) => version.id === versionId)) {
    throw new FormPlanningError('form_version_exists');
  }
  const targetPin = resolveTargetPin(before.scope, before.definition.target, input.references);
  const deadlinePin = resolveDeadlinePin(
    before.scope, before.definition.availability, input.references
  );
  const publishedAt = intakeInstantSchema.parse(input.server.publishedAt);
  const publishedByUserId = intakeIdSchema.parse(input.server.publishedByUserId);
  const registryPin = formRegistryPin(input.registry);
  const publishedVersion = formVersionSchema.parse({
    schemaVersion: 1,
    id: versionId,
    formId: before.id,
    scope: before.scope,
    number: (versions.at(-1)?.number ?? 0) + 1,
    sourceDefinitionVersion: before.version,
    sourceDefinitionDigestSha256: formDefinitionDigest(before.definition),
    registryPin,
    definitionDigestSha256: sha256(definition),
    definition,
    targetPin,
    deadlinePin,
    publishedByUserId,
    publishedAt
  });
  const after = formDefinitionHeadSchema.parse({
    ...before,
    version: before.version + 1,
    currentPublishedVersionId: publishedVersion.id,
    updatedByUserId: publishedByUserId,
    updatedAt: publishedAt
  });
  return deepFreeze({
    action: 'publish',
    scope: before.scope,
    targetPin,
    deadlinePin,
    registryPin,
    expectedLatestVersionNumber: versions.at(-1)?.number ?? 0,
    versionSetDigestSha256: formVersionSetDigest(versions),
    before,
    after,
    publishedVersion
  });
}

export function planFormLifecycleChange(input: {
  readonly head: FormDefinitionHeadDto;
  readonly registry?: FieldRegistrySnapshotDto;
  readonly existingVersions?: readonly FormVersionDto[];
  readonly authorInput: FormLifecycleChangeDraftInput;
  readonly references: FormTargetReferenceResolver;
  readonly server: {
    readonly updatedByUserId: string;
    readonly updatedAt: string;
    readonly formVersionId?: string;
  };
}): FormLifecyclePlan {
  const before = parseFormDefinitionHead(input.head);
  const author = formLifecycleChangeDraftInputSchema.parse(input.authorInput);
  if (author.formId !== before.id) throw new FormPlanningError('form_missing');
  if (author.expectedDefinitionVersion !== before.version) {
    throw new FormPlanningError('stale_definition');
  }
  const targetStatus = author.transition === 'close' ? 'closed' : 'open';
  const firstOpen = author.transition === 'publish_and_open';
  if ((author.transition === 'publish_and_open'
        && (before.status !== 'draft' || before.currentPublishedVersionId !== null))
      || (author.transition === 'reopen'
        && (before.status !== 'closed' || before.currentPublishedVersionId === null))
      || (author.transition === 'close'
        && (before.status !== 'open' || before.currentPublishedVersionId === null))) {
    throw new FormPlanningError('invalid_transition');
  }
  const targetPin = targetStatus === 'open'
    ? resolveTargetPin(before.scope, before.definition.target, input.references)
    : null;
  const deadlinePin = targetStatus === 'open'
    ? resolveDeadlinePin(before.scope, before.definition.availability, input.references)
    : null;
  const updatedAt = intakeInstantSchema.parse(input.server.updatedAt);
  const updatedByUserId = intakeIdSchema.parse(input.server.updatedByUserId);
  let registryPin: FormRegistryPinDto | null = null;
  let expectedLatestVersionNumber: number | null = null;
  let versionSetDigestSha256: string | null = null;
  let publishedVersion: FormVersionDto | null = null;
  if (firstOpen) {
    if (!input.registry || !input.existingVersions || !input.server.formVersionId
        ) {
      throw new FormPlanningError('form_not_publishable');
    }
    assertRegistryScope(before.scope, input.registry, author.expectedRegistryVersion);
    const definition = materializeFormVersionDefinition(before, input.registry);
    const versions = orderedVersions(input.existingVersions, before);
    const versionId = intakeIdSchema.parse(input.server.formVersionId);
    if (versions.some((version) => version.id === versionId)) {
      throw new FormPlanningError('form_version_exists');
    }
    registryPin = formRegistryPin(input.registry);
    expectedLatestVersionNumber = versions.at(-1)?.number ?? 0;
    versionSetDigestSha256 = formVersionSetDigest(versions);
    publishedVersion = formVersionSchema.parse({
      schemaVersion: 1,
      id: versionId,
      formId: before.id,
      scope: before.scope,
      number: expectedLatestVersionNumber + 1,
      sourceDefinitionVersion: before.version,
      sourceDefinitionDigestSha256: formDefinitionDigest(before.definition),
      registryPin,
      definitionDigestSha256: sha256(definition),
      definition,
      targetPin,
      deadlinePin,
      publishedByUserId: updatedByUserId,
      publishedAt: updatedAt
    });
  }
  const after = formDefinitionHeadSchema.parse({
    ...before,
    version: before.version + 1,
    status: targetStatus,
    currentPublishedVersionId: publishedVersion?.id ?? before.currentPublishedVersionId,
    updatedByUserId,
    updatedAt
  });
  return deepFreeze({
    action: 'lifecycle', scope: before.scope, targetPin, deadlinePin, registryPin,
    expectedLatestVersionNumber, versionSetDigestSha256, before, after, publishedVersion
  });
}

export function planFormClosingChange(input: {
  readonly head: FormDefinitionHeadDto;
  readonly authorInput: FormClosingChangeDraftInput;
  readonly deadlineContribution: FormCloseDeadlineContribution;
  readonly server: { readonly updatedByUserId: string; readonly updatedAt: string };
}): FormClosingPlan {
  const before = parseFormDefinitionHead(input.head);
  const author = formClosingChangeDraftInputSchema.parse(input.authorInput);
  if (author.formId !== before.id) throw new FormPlanningError('form_missing');
  if (author.expectedDefinitionVersion !== before.version) {
    throw new FormPlanningError('stale_definition');
  }
  const contribution = parseDeadlineContribution(input.deadlineContribution);
  if (!sameIntakeScope(contribution.input.scope, before.scope)
      || contribution.input.attributedByUserId !== input.server.updatedByUserId
      || contribution.input.attributedAt !== input.server.updatedAt) {
    throw new FormPlanningError('invalid_plan');
  }
  const currentDeadlineId = before.definition.availability.kind === 'deadline'
    ? before.definition.availability.deadlineId
    : null;
  const expectedAction = currentDeadlineId === null ? 'create'
    : author.closesAt === null ? 'clear' : 'update';
  if (contribution.input.action !== expectedAction
      || (currentDeadlineId !== null && contribution.input.deadlineId !== currentDeadlineId)
      || (author.closesAt !== null
        && (contribution.after.status !== 'active'
          || contribution.after.displayDate !== author.closesAt))
      || (author.closesAt === null && contribution.after.status !== 'cleared')) {
    throw new FormPlanningError('invalid_plan');
  }
  const deadlinePin = formCloseDeadlinePin(contribution);
  const availability = deadlinePin === null
    ? { kind: 'evergreen' as const }
    : { kind: 'deadline' as const, deadlineId: deadlinePin.id };
  const after = formDefinitionHeadSchema.parse({
    ...before,
    version: before.version + 1,
    definition: { ...before.definition, availability },
    updatedByUserId: intakeIdSchema.parse(input.server.updatedByUserId),
    updatedAt: intakeInstantSchema.parse(input.server.updatedAt)
  });
  return deepFreeze({
    action: 'closing', scope: before.scope, targetPin: null, deadlinePin,
    before, after, deadlineContribution: contribution
  });
}

export function validateFormMutationPlan(input: {
  readonly catalog: FormCatalogState;
  readonly registry: FieldRegistrySnapshotDto;
  readonly plan: FormMutationPlan;
  readonly references: FormTargetReferenceResolver;
  readonly existingVersions?: readonly FormVersionDto[];
}): FormPlanningErrorCode | undefined {
  try {
    const catalog = parseFormCatalogState(input.catalog);
    const plan = input.plan;
    if (!sameIntakeScope(catalog.scope, plan.scope)) return 'wrong_scope';
    if (plan.action === 'closing') {
      if (plan.targetPin !== null
          || sha256(plan.deadlinePin) !== sha256(formCloseDeadlinePin(plan.deadlineContribution))) {
        return 'invalid_plan';
      }
    } else if (plan.action === 'lifecycle' && plan.after.status === 'closed') {
      if (plan.targetPin !== null || plan.deadlinePin !== null) return 'invalid_plan';
    } else {
      if (!targetPinIsCurrent(plan.scope, plan.after.definition.target, plan.targetPin, input.references)) {
        return plan.after.definition.target.kind === 'session' ? 'session_changed' : 'category_changed';
      }
      if (plan.action === 'create' && plan.deadlineContribution !== null) {
        if (sha256(plan.deadlinePin)
            !== sha256(formCloseDeadlinePin(plan.deadlineContribution))) return 'invalid_plan';
      } else if (!deadlinePinIsCurrent(
        plan.scope, plan.after.definition.availability, plan.deadlinePin, input.references
      )) return 'deadline_changed';
    }
    const registryPin = plan.action === 'create' || plan.action === 'revise' || plan.action === 'publish'
      ? plan.registryPin
      : plan.action === 'lifecycle'
        ? plan.registryPin
        : null;
    if (registryPin !== null && !sameRegistryPin(input.registry, registryPin)) return 'stale_registry';
    if (plan.action === 'create' || plan.action === 'revise' || plan.action === 'publish') {
      assertDefinitionCurrent(plan.after.id, plan.after.definition, input.registry);
    } else if (plan.action === 'lifecycle' && plan.publishedVersion !== null) {
      if (registryPin === null) return 'invalid_plan';
      assertDefinitionCurrent(plan.after.id, plan.after.definition, input.registry);
    }

    if (plan.action === 'create') {
      if (catalog.version !== plan.expectedCatalogVersion
          || formCatalogDigest(catalog) !== plan.catalogGuardDigestSha256) return 'stale_catalog';
      if (catalog.heads.some((head) => head.id === plan.after.id)) return 'form_exists';
      if (plan.resultingCatalogVersion !== plan.expectedCatalogVersion + 1
          || plan.before !== null || plan.after.version !== 1
          || plan.after.status !== 'draft' || plan.after.currentPublishedVersionId !== null
          || plan.after.createdByUserId !== plan.after.updatedByUserId
          || plan.after.createdAt !== plan.after.updatedAt) return 'invalid_plan';
      if (plan.deadlineContribution === null) {
        if (plan.after.definition.availability.kind !== 'evergreen'
            || plan.deadlinePin !== null) return 'invalid_plan';
      } else if (plan.deadlineContribution.input.action !== 'create'
          || !sameIntakeScope(plan.deadlineContribution.input.scope, plan.scope)
          || plan.deadlineContribution.input.attributedByUserId !== plan.after.createdByUserId
          || plan.deadlineContribution.input.attributedAt !== plan.after.createdAt
          || plan.after.definition.availability.kind !== 'deadline'
          || plan.after.definition.availability.deadlineId !== plan.deadlinePin?.id) {
        return 'invalid_plan';
      }
      return undefined;
    }

    const current = catalog.heads.find((head) => head.id === plan.before.id);
    if (!current) return 'form_missing';
    if (sha256(current) !== sha256(plan.before)) return 'stale_definition';
    if (plan.after.version !== plan.before.version + 1
        || !sameImmutableHeadIdentity(plan.before, plan.after)
        || plan.after.updatedAt < plan.before.updatedAt) return 'invalid_plan';

    if (plan.action === 'revise') {
      if (plan.after.status !== plan.before.status
          || plan.after.currentPublishedVersionId !== plan.before.currentPublishedVersionId) {
        return 'invalid_plan';
      }
      return undefined;
    }
    if (plan.action === 'closing') {
      const beforeDeadlineId = plan.before.definition.availability.kind === 'deadline'
        ? plan.before.definition.availability.deadlineId : null;
      const expectedAction = beforeDeadlineId === null ? 'create'
        : plan.deadlinePin === null ? 'clear' : 'update';
      const expectedAvailability = plan.deadlinePin === null
        ? { kind: 'evergreen' as const }
        : { kind: 'deadline' as const, deadlineId: plan.deadlinePin.id };
      if (plan.deadlineContribution.input.action !== expectedAction
          || (beforeDeadlineId !== null
            && plan.deadlineContribution.input.deadlineId !== beforeDeadlineId)
          || sha256(plan.after.definition)
            !== sha256({ ...plan.before.definition, availability: expectedAvailability })
          || plan.after.status !== plan.before.status
          || plan.after.currentPublishedVersionId !== plan.before.currentPublishedVersionId) {
        return 'invalid_plan';
      }
      return undefined;
    }
    if (plan.action === 'lifecycle') {
      if (sha256(plan.after.definition) !== sha256(plan.before.definition)
          || plan.after.status === plan.before.status
          || (plan.after.status !== 'open' && plan.after.status !== 'closed')) return 'invalid_plan';
      if (plan.publishedVersion === null) {
        if (plan.registryPin !== null || plan.expectedLatestVersionNumber !== null
            || plan.versionSetDigestSha256 !== null
            || plan.after.currentPublishedVersionId !== plan.before.currentPublishedVersionId
            || plan.before.currentPublishedVersionId === null
            || (plan.after.status === 'closed' && plan.before.status !== 'open')
            || (plan.after.status === 'open' && plan.before.status !== 'closed'
              && plan.before.status !== 'draft')) return 'invalid_plan';
        return undefined;
      }
      if (!input.existingVersions || plan.registryPin === null
          || plan.expectedLatestVersionNumber === null
          || plan.versionSetDigestSha256 === null
          || plan.before.status !== 'draft' || plan.after.status !== 'open'
          || plan.before.currentPublishedVersionId !== null) return 'invalid_plan';
      const versions = orderedVersions(input.existingVersions, plan.before);
      const latest = versions.at(-1)?.number ?? 0;
      const expectedDefinition = materializeFormVersionDefinition(plan.before, input.registry);
      if (latest !== plan.expectedLatestVersionNumber
          || formVersionSetDigest(versions) !== plan.versionSetDigestSha256
          || plan.publishedVersion.number !== latest + 1
          || versions.some((version) => version.id === plan.publishedVersion!.id)
          || plan.publishedVersion.formId !== plan.before.id
          || plan.publishedVersion.sourceDefinitionVersion !== plan.before.version
          || plan.publishedVersion.sourceDefinitionDigestSha256
            !== formDefinitionDigest(plan.before.definition)
          || plan.publishedVersion.registryPin.version !== plan.registryPin.version
          || plan.publishedVersion.registryPin.digestSha256 !== plan.registryPin.digestSha256
          || plan.publishedVersion.definitionDigestSha256 !== sha256(expectedDefinition)
          || sha256(plan.publishedVersion.definition) !== sha256(expectedDefinition)
          || sha256(plan.publishedVersion.targetPin) !== sha256(plan.targetPin)
          || sha256(plan.publishedVersion.deadlinePin) !== sha256(plan.deadlinePin)
          || plan.after.currentPublishedVersionId !== plan.publishedVersion.id) return 'invalid_plan';
      return undefined;
    }

    if (!input.existingVersions) return 'invalid_plan';
    const versions = orderedVersions(input.existingVersions, plan.before);
    const latest = versions.at(-1)?.number ?? 0;
    const expectedDefinition = materializeFormVersionDefinition(plan.before, input.registry);
    if (latest !== plan.expectedLatestVersionNumber
        || formVersionSetDigest(versions) !== plan.versionSetDigestSha256
        || plan.publishedVersion.number !== latest + 1
        || versions.some((version) => version.id === plan.publishedVersion.id)
        || plan.publishedVersion.formId !== plan.before.id
        || plan.publishedVersion.sourceDefinitionVersion !== plan.before.version
        || plan.publishedVersion.sourceDefinitionDigestSha256
          !== formDefinitionDigest(plan.before.definition)
        || plan.publishedVersion.registryPin.version !== plan.registryPin.version
        || plan.publishedVersion.registryPin.digestSha256 !== plan.registryPin.digestSha256
        || plan.publishedVersion.definitionDigestSha256 !== sha256(expectedDefinition)
        || sha256(plan.publishedVersion.definition) !== sha256(expectedDefinition)
        || sha256(plan.publishedVersion.targetPin) !== sha256(plan.targetPin)
        || sha256(plan.publishedVersion.deadlinePin) !== sha256(plan.deadlinePin)
        || plan.after.currentPublishedVersionId !== plan.publishedVersion.id
        || plan.after.status !== plan.before.status
        || sha256(plan.after.definition) !== sha256(plan.before.definition)) return 'invalid_plan';
    return undefined;
  } catch (error) {
    return error instanceof FormPlanningError ? error.code : 'invalid_plan';
  }
}

export function applyFormMutationPlan(input: {
  readonly catalog: FormCatalogState;
  readonly registry: FieldRegistrySnapshotDto;
  readonly plan: FormMutationPlan;
  readonly references: FormTargetReferenceResolver;
  readonly existingVersions?: readonly FormVersionDto[];
}): AppliedFormMutation {
  const refusal = validateFormMutationPlan(input);
  if (refusal) throw new FormPlanningError(refusal);
  const catalog = parseFormCatalogState(input.catalog);
  const heads = catalog.heads.filter((head) => head.id !== input.plan.after.id);
  heads.push(input.plan.after);
  heads.sort((left, right) => compareCanonicalText(left.id, right.id));
  return deepFreeze({
    catalog: parseFormCatalogState({
      scope: catalog.scope,
      version: catalog.version + 1,
      heads
    }),
    publishedVersion: input.plan.action === 'publish'
      ? input.plan.publishedVersion
      : input.plan.action === 'lifecycle'
        ? input.plan.publishedVersion
        : null
  });
}

export type FormCorrectionDerivation =
  | { readonly kind: 'exact'; readonly restoredHead: FormDefinitionHeadDto | null }
  | { readonly kind: 'semantic'; readonly restoredHead: FormDefinitionHeadDto; readonly retainedVersionId: string }
  | { readonly kind: 'blocked'; readonly reason: 'later_definition_change' | 'published_version_pinned' };

export function deriveFormCorrection(input: {
  readonly sourcePlan: FormMutationPlan;
  readonly currentHead: FormDefinitionHeadDto | undefined;
  readonly correctedByUserId: string;
  readonly correctedAt: string;
  readonly publishedVersionPinned: boolean;
}): FormCorrectionDerivation {
  const plan = input.sourcePlan;
  if (plan.action === 'create') {
    if (!input.currentHead || sha256(input.currentHead) !== sha256(plan.after)) {
      return deepFreeze({ kind: 'blocked', reason: 'later_definition_change' });
    }
    return deepFreeze({ kind: 'exact', restoredHead: null });
  }
  if (!input.currentHead || sha256(input.currentHead) !== sha256(plan.after)) {
    return deepFreeze({ kind: 'blocked', reason: 'later_definition_change' });
  }
  if (plan.action === 'publish' && input.publishedVersionPinned) {
    return deepFreeze({ kind: 'blocked', reason: 'published_version_pinned' });
  }
  if (plan.action === 'lifecycle' && plan.publishedVersion !== null) {
    const restoredHead = formDefinitionHeadSchema.parse({
      ...plan.after,
      version: plan.after.version + 1,
      status: 'closed',
      updatedByUserId: intakeIdSchema.parse(input.correctedByUserId),
      updatedAt: intakeInstantSchema.parse(input.correctedAt)
    });
    return deepFreeze({
      kind: 'semantic', restoredHead, retainedVersionId: plan.publishedVersion.id
    });
  }
  const restoredHead = formDefinitionHeadSchema.parse({
    ...plan.before,
    version: plan.after.version + 1,
    updatedByUserId: intakeIdSchema.parse(input.correctedByUserId),
    updatedAt: intakeInstantSchema.parse(input.correctedAt)
  });
  return plan.action === 'publish'
    ? deepFreeze({ kind: 'semantic', restoredHead, retainedVersionId: plan.publishedVersion.id })
    : deepFreeze({ kind: 'exact', restoredHead });
}

function materializeFormVersionDefinition(
  head: FormDefinitionHeadDto,
  registry: FieldRegistrySnapshotDto
): FormVersionDefinitionContentDto {
  const analyzed = analyzeFormComposition({
    formId: head.id,
    definition: head.definition,
    registry
  });
  if (analyzed.issues.length !== 0) throw new FormPlanningError('form_not_publishable');
  const showTargets = new Set(head.definition.rules
    .filter((rule) => rule.effect.kind === 'show')
    .flatMap((rule) => rule.effect.targetFieldIds));
  const fields = analyzed.fields.map((row, position) =>
    materializeField(row.field, row.required, !showTargets.has(row.field.id), position, head.definition)
  );
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const registryById = new Map(registry.fields.map((field) => [field.id, field]));
  const rules = head.definition.rules.map((rule): FormVersionRuleDto => {
    const source = fieldById.get(rule.condition.sourceFieldId);
    if (!source) throw new FormPlanningError('form_not_publishable');
    const condition = rule.condition.kind === 'checked_is'
      ? rule.condition
      : {
          ...rule.condition,
          programVocabularyPins: vocabularyRulePins(
            registryById.get(source.id), rule.condition.choiceIds
          )
        };
    return { ...rule, condition };
  });
  const parsed = formVersionDefinitionContentSchema.safeParse({
    kind: head.definition.kind,
    name: head.definition.name,
    target: head.definition.target,
    availability: head.definition.availability,
    confirmation: head.definition.confirmation,
    fields,
    rules
  });
  if (!parsed.success) throw new FormPlanningError('form_not_publishable');
  return deepFreeze(parsed.data);
}

function materializeField(
  field: FieldRegistryFieldViewDto,
  required: boolean,
  initiallyVisible: boolean,
  position: number,
  definition: FormDefinitionContentDto
): FormFieldDefinitionDto {
  if (field.kind === 'file') throw new FormPlanningError('form_not_publishable');
  const base = {
    id: field.id,
    sourceFieldVersion: field.version,
    key: field.key,
    mapsTo: field.mapsTo,
    purpose: field.purpose,
    answerOwner: field.answerOwner,
    group: field.group,
    constraints: field.constraints,
    label: field.label,
    help: field.help,
    required,
    initiallyVisible,
    position
  };
  if (field.kind === 'text') {
    return { ...base, kind: field.kind, maximumLength: FORM_TEXT_MAX_LENGTH, options: { kind: 'none' } };
  }
  if (field.kind === 'textarea') {
    return { ...base, kind: field.kind, maximumLength: FORM_LONG_TEXT_MAX_LENGTH, options: { kind: 'none' } };
  }
  if (field.kind === 'email') {
    return { ...base, kind: field.kind, maximumLength: FORM_EMAIL_MAX_LENGTH, options: { kind: 'none' } };
  }
  if (field.kind === 'url') {
    return { ...base, kind: field.kind, maximumLength: FORM_URL_MAX_LENGTH, options: { kind: 'none' } };
  }
  if (field.kind === 'phone') {
    return { ...base, kind: field.kind, maximumLength: FORM_PHONE_MAX_LENGTH, options: { kind: 'none' } };
  }
  if (field.kind === 'number') {
    return {
      ...base, kind: field.kind, minimum: null, maximum: null,
      integerOnly: false, options: { kind: 'none' }
    };
  }
  if (field.kind === 'date' || field.kind === 'datetime' || field.kind === 'checkbox') {
    return { ...base, kind: field.kind, options: { kind: 'none' } };
  }
  const options = field.options.kind === 'custom'
    ? { kind: 'custom' as const, choices: field.options.choices.map((choice) => ({ ...choice })) }
    : field.options.kind === 'program_vocabulary'
      ? {
          kind: 'program_vocabulary' as const,
          source: field.options.source,
          exposure: vocabularyExposure(field, definition)
        }
      : (() => { throw new FormPlanningError('form_not_publishable'); })();
  if (required && field.options.kind === 'program_vocabulary') {
    const exposed = definition.composition.optionExposure[field.id];
    const available = exposed ?? field.resolvedOptions?.map((choice) => choice.id) ?? [];
    if (available.length === 0) {
      throw new FormPlanningError('required_choice_has_no_options');
    }
  }
  return field.kind === 'select'
    ? { ...base, kind: field.kind, options }
    : {
        ...base, kind: field.kind, options,
        maximumSelections: FORM_MULTISELECT_MAX_SELECTIONS
      };
}

function vocabularyExposure(
  field: FieldRegistryFieldViewDto,
  definition: FormDefinitionContentDto
) {
  if (field.options.kind !== 'program_vocabulary' || field.resolvedOptions === null) {
    throw new FormPlanningError('form_not_publishable');
  }
  const selected = definition.composition.optionExposure[field.id];
  const source = field.options.source;
  if (selected === undefined) return { kind: 'all_active' as const };
  const byId = new Map(field.resolvedOptions.map((option) => [option.id, option]));
  return {
    kind: 'subset' as const,
    items: selected.map((id) => {
      const option = byId.get(id);
      if (!option) throw new FormPlanningError('form_not_publishable');
      return {
        source,
        id: option.id,
        version: option.version,
        label: option.label
      };
    })
  };
}

function vocabularyRulePins(
  field: FieldRegistryFieldViewDto | undefined,
  choiceIds: readonly string[]
) {
  if (!field || field.options.kind !== 'program_vocabulary' || field.resolvedOptions === null) return [];
  const source = field.options.source;
  const byId = new Map(field.resolvedOptions.map((option) => [option.id, option]));
  return choiceIds.map((id) => {
    const option = byId.get(id);
    if (!option) throw new FormPlanningError('form_not_publishable');
    return {
      source,
      id: option.id,
      version: option.version,
      label: option.label
    };
  });
}

function assertDefinitionCurrent(
  formId: string,
  definition: FormDefinitionContentDto,
  registry: FieldRegistrySnapshotDto
): void {
  if (analyzeFormComposition({ formId, definition, registry }).issues.length !== 0) {
    throw new FormPlanningError('invalid_definition');
  }
}

function assertRegistryScope(
  scope: IntakeScopeDto,
  registry: FieldRegistrySnapshotDto,
  expectedVersion: number
): void {
  if (!sameIntakeScope(scope, registry.scope)) throw new FormPlanningError('wrong_scope');
  if (registry.version !== expectedVersion) throw new FormPlanningError('stale_registry');
}

function sameRegistryPin(registry: FieldRegistrySnapshotDto, pin: FormRegistryPinDto): boolean {
  return registry.version === pin.version
    && registry.registryDigestSha256 === pin.digestSha256;
}

function resolveTargetPin(
  scope: IntakeScopeDto,
  target: FormTarget,
  resolver: FormTargetReferenceResolver
): FormTargetReferencePinDto | null {
  if (target.kind === 'general_pool') return null;
  if (target.kind === 'category') {
    const resolved = resolver.resolveActiveCategory(scope, target);
    if (!resolved || resolved.categoryKind !== target.category.kind
        || resolved.id !== target.category.id) throw new FormPlanningError('category_missing');
    return deepFreeze(resolved);
  }
  const resolved = resolver.resolveCollectingSession(scope, target);
  if (!resolved || resolved.id !== target.sessionId || resolved.lifecycle !== 'collecting') {
    throw new FormPlanningError('session_unavailable');
  }
  return deepFreeze(resolved);
}

function resolveDeadlinePin(
  scope: IntakeScopeDto,
  availability: FormDefinitionContentDto['availability'],
  resolver: FormTargetReferenceResolver
): FormDeadlineReferencePinDto | null {
  if (availability.kind === 'evergreen') return null;
  const resolved = resolver.resolveCurrentDeadline(scope, availability);
  if (!resolved || resolved.id !== availability.deadlineId) {
    throw new FormPlanningError('deadline_unavailable');
  }
  return deepFreeze(resolved);
}

function targetPinIsCurrent(
  scope: IntakeScopeDto,
  target: FormTarget,
  pin: FormTargetReferencePinDto | null,
  resolver: FormTargetReferenceResolver
): boolean {
  try {
    return sha256(resolveTargetPin(scope, target, resolver)) === sha256(pin);
  } catch {
    return false;
  }
}

function deadlinePinIsCurrent(
  scope: IntakeScopeDto,
  availability: FormDefinitionContentDto['availability'],
  pin: FormDeadlineReferencePinDto | null,
  resolver: FormTargetReferenceResolver
): boolean {
  try {
    return sha256(resolveDeadlinePin(scope, availability, resolver)) === sha256(pin);
  } catch {
    return false;
  }
}

function orderedVersions(
  values: readonly FormVersionDto[],
  head: FormDefinitionHeadDto
): readonly FormVersionDto[] {
  const versions = values.map(parseFormVersion)
    .sort((left, right) => left.number - right.number || compareCanonicalText(left.id, right.id));
  versions.forEach((version, index) => {
    if (version.formId !== head.id || !sameIntakeScope(version.scope, head.scope)
        || version.number !== index + 1) throw new FormPlanningError('invalid_plan');
  });
  if (new Set(versions.map((version) => version.id)).size !== versions.length
      || (head.currentPublishedVersionId !== null
        && !versions.some((version) => version.id === head.currentPublishedVersionId))) {
    throw new FormPlanningError('invalid_plan');
  }
  return versions;
}

function sameImmutableHeadIdentity(
  before: FormDefinitionHeadDto,
  after: FormDefinitionHeadDto
): boolean {
  return before.id === after.id
    && sameIntakeScope(before.scope, after.scope)
    && before.createdByUserId === after.createdByUserId
    && before.createdAt === after.createdAt;
}

function parseIdentityAssignment(
  input: FormDefinitionIdentityAssignment
): FormDefinitionIdentityAssignment {
  try {
    const formId = intakeIdSchema.parse(input.formId);
    const rules = input.rules.map((rule) => ({ key: rule.key, id: intakeIdSchema.parse(rule.id) }));
    if (new Set([formId, ...rules.map((rule) => rule.id)]).size !== rules.length + 1) {
      throw new TypeError();
    }
    return deepFreeze({ formId, rules });
  } catch {
    throw new FormPlanningError('invalid_identity_assignment');
  }
}

function exactIdentityMap(
  expectedKeys: readonly string[],
  entries: readonly { readonly key: string; readonly id: string }[]
): Map<string, { readonly key: string; readonly id: string }> {
  const expected = [...expectedKeys].sort(compareCanonicalText);
  const actual = entries.map((entry) => entry.key).sort(compareCanonicalText);
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new FormPlanningError('invalid_identity_assignment');
  }
  return new Map(entries.map((entry) => [entry.key, entry]));
}

function assertPreservedRuleIdentities(
  previous: FormDefinitionContentDto,
  next: FormDefinitionAuthorInput,
  identities: FormDefinitionIdentityAssignment
): void {
  const byKey = new Map(identities.rules.map((rule) => [rule.key, rule.id]));
  for (const prior of previous.rules) {
    if (next.rules.some((rule) => rule.key === prior.key) && byKey.get(prior.key) !== prior.id) {
      throw new FormPlanningError('invalid_identity_assignment');
    }
  }
}

function parseRegistryPin(value: unknown): FormRegistryPinDto {
  const root = exactRecord(value);
  assertExactKeys(root, ['version', 'digestSha256']);
  return {
    version: positiveVersion(root.version),
    digestSha256: digestValue(root.digestSha256)
  };
}

function parseTargetPin(value: unknown): FormTargetReferencePinDto | null {
  if (value === null) return null;
  const parsed = formTargetReferencePinSchema.safeParse(value);
  if (!parsed.success) throw new TypeError();
  return parsed.data;
}

function parseDeadlinePin(value: unknown): FormDeadlineReferencePinDto | null {
  if (value === null) return null;
  const parsed = formDeadlineReferencePinSchema.safeParse(value);
  if (!parsed.success) throw new TypeError();
  return parsed.data;
}

function parseDeadlineContribution(value: unknown): FormCloseDeadlineContribution {
  return deadlineMutationPlanSchema.parse(value);
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...expected].sort(compareCanonicalText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError();
  }
}

function positiveVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError();
  return value;
}

function nonnegativeVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError();
  return value;
}

function digestValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError();
  return value;
}
