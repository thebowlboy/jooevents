import {
  applicationDraftHeadSchema,
  applicationDraftRevisionSchema,
  formDefinitionHeadSchema,
  formRegistryPinSchema,
  formVersionSchema,
  intakeScopeSchema,
  organizerFormCatalogSchema,
  organizerFormDetailSchema,
  organizerFormSummarySchema,
  organizerSubmissionContactSchema,
  servedPublicFormSchema,
  submissionConsentEvidenceSchema,
  submissionDirectEntryEvidenceSchema,
  submissionHeadSchema,
  submissionParticipantEvidenceSchema,
  submissionSubmitEvidenceSchema,
  type ApplicationDraftHeadDto,
  type ApplicationDraftRevisionDto,
  type FieldRegistryFieldViewDto,
  type FieldRegistryOptionSource,
  type FieldRegistrySnapshotDto,
  type FormConfigurationIssueDto,
  type FormAvailability,
  type FormDeadlineReferencePinDto,
  type FormDefinitionContentDto,
  type FormDefinitionHeadDto,
  type FormRegistryPinDto,
  type FormTarget,
  type FormTargetReferencePinDto,
  type FormVersionDto,
  type IntakeScopeDto,
  type OrganizerFormCatalogDto,
  type OrganizerFormDetailDto,
  type OrganizerFormFieldRowDto,
  type OrganizerFormSummaryDto,
  type OrganizerSubmissionContactDto,
  type ServedPublicFormDto,
  type SubmissionConsentEvidenceDto,
  type SubmissionDirectEntryEvidenceDto,
  type SubmissionHeadDto,
  type SubmissionParticipantEvidenceDto,
  type SubmissionSubmitEvidenceDto
} from '@jooevents/contracts';

export interface FormCatalogState {
  readonly scope: IntakeScopeDto;
  readonly version: number;
  readonly heads: readonly FormDefinitionHeadDto[];
}

export interface IntakeStateInput {
  readonly catalog: FormCatalogState;
  readonly versions: readonly FormVersionDto[];
}

export interface IntakeProgramVocabularyOption {
  readonly id: string;
  readonly label: string;
  readonly version: number;
  readonly status: 'active' | 'retired';
}

export interface IntakeProgramVocabularyOptionSource {
  readLiveOptions(
    scope: IntakeScopeDto,
    source: FieldRegistryOptionSource
  ): readonly IntakeProgramVocabularyOption[];
}

export interface IntakeFormReferenceSource {
  resolveActiveCategory(
    scope: IntakeScopeDto,
    target: Extract<FormTarget, { readonly kind: 'category' }>
  ): Extract<FormTargetReferencePinDto, { readonly kind: 'category' }> | undefined;
  resolveCollectingSession(
    scope: IntakeScopeDto,
    target: Extract<FormTarget, { readonly kind: 'session' }>
  ): Extract<FormTargetReferencePinDto, { readonly kind: 'session' }> | undefined;
  resolveCurrentDeadline(
    scope: IntakeScopeDto,
    availability: Extract<FormAvailability, { readonly kind: 'deadline' }>
  ): FormDeadlineReferencePinDto | undefined;
}

export function sameIntakeScope(left: IntakeScopeDto, right: IntakeScopeDto): boolean {
  return left.workspaceId === right.workspaceId && left.eventId === right.eventId;
}

export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseFormCatalogState(value: unknown): FormCatalogState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntakeValidationError('invalid_form_catalog');
  }
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ['scope', 'version', 'heads'])
      || typeof input.version !== 'number'
      || !Number.isSafeInteger(input.version)
      || input.version <= 0
      || !Array.isArray(input.heads)) {
    throw new IntakeValidationError('invalid_form_catalog');
  }
  const scope = intakeScopeSchema.safeParse(input.scope);
  if (!scope.success) throw new IntakeValidationError('invalid_form_catalog');
  const heads = input.heads.map(parseFormDefinitionHead);
  const seen = new Set<string>();
  heads.forEach((head, index) => {
    if (!sameIntakeScope(head.scope, scope.data)
        || seen.has(head.id)
        || (index > 0 && compareCanonicalText(heads[index - 1]!.id, head.id) >= 0)) {
      throw new IntakeValidationError('invalid_form_catalog');
    }
    seen.add(head.id);
  });
  return deepFreeze({ scope: scope.data, version: input.version, heads });
}

export function parseFormDefinitionHead(value: unknown): FormDefinitionHeadDto {
  return parseSchema(formDefinitionHeadSchema, value, 'invalid_form_head');
}

export function parseFormVersion(value: unknown): FormVersionDto {
  return parseSchema(formVersionSchema, value, 'invalid_form_version');
}

export function parseApplicationDraftHead(value: unknown): ApplicationDraftHeadDto {
  return parseSchema(applicationDraftHeadSchema, value, 'invalid_application_draft');
}

export function parseApplicationDraftRevision(value: unknown): ApplicationDraftRevisionDto {
  return parseSchema(applicationDraftRevisionSchema, value, 'invalid_application_draft_revision');
}

export function parseSubmissionHead(value: unknown): SubmissionHeadDto {
  return parseSchema(submissionHeadSchema, value, 'invalid_submission');
}

export function parseSubmissionSubmitEvidence(value: unknown): SubmissionSubmitEvidenceDto {
  return parseSchema(submissionSubmitEvidenceSchema, value, 'invalid_submission_evidence');
}

export function parseSubmissionDirectEntryEvidence(value: unknown): SubmissionDirectEntryEvidenceDto {
  return parseSchema(submissionDirectEntryEvidenceSchema, value, 'invalid_submission_evidence');
}

export function parseSubmissionParticipantEvidence(value: unknown): SubmissionParticipantEvidenceDto {
  return parseSchema(submissionParticipantEvidenceSchema, value, 'invalid_participant_evidence');
}

export function parseSubmissionConsentEvidence(value: unknown): SubmissionConsentEvidenceDto {
  return parseSchema(submissionConsentEvidenceSchema, value, 'invalid_consent_evidence');
}

export function formRegistryPin(snapshot: FieldRegistrySnapshotDto): FormRegistryPinDto {
  return formRegistryPinSchema.parse({
    version: snapshot.version,
    digestSha256: snapshot.registryDigestSha256
  });
}

export interface AnalyzedFormComposition {
  readonly fields: readonly OrganizerFormFieldRowDto[];
  readonly issues: readonly FormConfigurationIssueDto[];
}

function issue(
  code: FormConfigurationIssueDto['code'],
  fieldId: string | null = null,
  ruleId: string | null = null
): FormConfigurationIssueDto {
  return { code, fieldId, ruleId };
}

function issueIdentity(value: FormConfigurationIssueDto): string {
  return `${value.code}:${value.fieldId ?? ''}:${value.ruleId ?? ''}`;
}

function resolveCurrentTarget(
  scope: IntakeScopeDto,
  target: FormTarget,
  references: IntakeFormReferenceSource
): FormTargetReferencePinDto | null | undefined {
  if (target.kind === 'general_pool') return null;
  if (target.kind === 'category') {
    const pin = references.resolveActiveCategory(scope, target);
    return pin?.categoryKind === target.category.kind && pin.id === target.category.id
      ? pin
      : undefined;
  }
  const pin = references.resolveCollectingSession(scope, target);
  return pin?.id === target.sessionId ? pin : undefined;
}

function resolveCurrentDeadline(
  scope: IntakeScopeDto,
  availability: Extract<FormAvailability, { readonly kind: 'deadline' }>,
  references: IntakeFormReferenceSource
): FormDeadlineReferencePinDto | undefined {
  const pin = references.resolveCurrentDeadline(scope, availability);
  return pin?.id === availability.deadlineId ? pin : undefined;
}

function currentReferenceIssues(
  head: FormDefinitionHeadDto,
  references: IntakeFormReferenceSource
): readonly FormConfigurationIssueDto[] {
  const issues: FormConfigurationIssueDto[] = [];
  if (head.definition.target.kind !== 'general_pool'
      && !resolveCurrentTarget(head.scope, head.definition.target, references)) {
    issues.push(issue('target_unavailable'));
  }
  if (head.definition.availability.kind === 'deadline'
      && !resolveCurrentDeadline(head.scope, head.definition.availability, references)) {
    issues.push(issue('deadline_unavailable'));
  }
  return issues;
}

/** Joins a Form head with the exact current Registry projection; no copied field catalog exists. */
export function analyzeFormComposition(input: {
  readonly formId: string;
  readonly definition: FormDefinitionContentDto;
  readonly registry: FieldRegistrySnapshotDto;
}): AnalyzedFormComposition {
  const composition = input.definition.composition;
  const eligible = input.registry.fields.filter((field) =>
    (field.scope.kind === 'shared' && field.contexts.apply.visible)
    || (field.scope.kind === 'form' && field.scope.formId === input.formId)
  );
  const byId = new Map(eligible.map((field) => [field.id, field]));
  const excluded = new Set(composition.excludedFieldIds);
  const issues: FormConfigurationIssueDto[] = [];

  for (const fieldId of composition.excludedFieldIds) {
    const field = byId.get(fieldId);
    if (!field || field.scope.kind !== 'shared') {
      issues.push(issue(field?.scope.kind === 'form' ? 'scoped_field_excluded' : 'unknown_excluded_field', fieldId));
    } else if (field.mapsTo === 'person.email'
        || field.constraints.applyVisibility === 'required_visible') {
      issues.push(issue('locked_email_excluded', fieldId));
    }
  }

  const included = eligible.filter((field) =>
    field.scope.kind === 'form' || !excluded.has(field.id)
  );
  const includedById = new Map(included.map((field) => [field.id, field]));
  if (!included.some((field) =>
    field.mapsTo === 'person.email'
    && field.kind === 'email'
    && field.constraints.applyVisibility === 'required_visible'
  )) issues.push(issue('locked_email_missing'));

  for (const fieldId of Object.keys(composition.requiredOverrides)) {
    if (!byId.has(fieldId)) issues.push(issue('unknown_required_override', fieldId));
    else if (!includedById.has(fieldId)) issues.push(issue('required_override_for_excluded_field', fieldId));
  }

  for (const [fieldId, itemIds] of Object.entries(composition.optionExposure)) {
    const field = byId.get(fieldId);
    if (!field) {
      issues.push(issue('unknown_option_exposure_field', fieldId));
      continue;
    }
    if (field.options.kind !== 'program_vocabulary' || field.resolvedOptions === null) {
      issues.push(issue('option_exposure_not_vocabulary', fieldId));
      continue;
    }
    const current = new Set(field.resolvedOptions.map((option) => option.id));
    if (itemIds.some((id) => !current.has(id))) issues.push(issue('option_exposure_item_missing', fieldId));
  }

  const rows = included.map((field): OrganizerFormFieldRowDto => {
    const override = composition.requiredOverrides[field.id];
    const exposure = composition.optionExposure[field.id];
    const options = field.resolvedOptions?.map((option) => ({
      id: option.id,
      name: option.label,
      version: option.version,
      exposed: exposure === undefined || exposure.includes(option.id)
    })) ?? null;
    if (field.kind === 'file') issues.push(issue('file_upload_disabled', field.id));
    return {
      field,
      included: true,
      required: override ?? field.contexts.apply.required,
      requiredOverridden: override !== undefined,
      options,
      exposureAll: field.options.kind !== 'program_vocabulary' || exposure === undefined
    };
  });

  const optionIds = (field: FieldRegistryFieldViewDto): ReadonlySet<string> => {
    if (field.options.kind === 'custom') {
      return new Set(field.options.choices.map((choice) => choice.id));
    }
    if (field.resolvedOptions !== null) {
      const exposure = composition.optionExposure[field.id];
      return new Set(field.resolvedOptions
        .filter((option) => exposure === undefined || exposure.includes(option.id))
        .map((option) => option.id));
    }
    return new Set();
  };

  const effects = new Map<string, Set<'show' | 'hide' | 'require'>>();
  for (const rule of input.definition.rules) {
    const source = includedById.get(rule.condition.sourceFieldId);
    if (!source) issues.push(issue(
      byId.has(rule.condition.sourceFieldId) ? 'rule_field_excluded' : 'rule_field_missing',
      rule.condition.sourceFieldId,
      rule.id
    ));
    if (source && rule.condition.kind === 'selected_any') {
      const choices = optionIds(source);
      if (rule.condition.choiceIds.some((id) => !choices.has(id))) {
        issues.push(issue('rule_choice_missing', source.id, rule.id));
      }
    }
    for (const targetId of rule.effect.targetFieldIds) {
      if (!includedById.has(targetId)) issues.push(issue(
        byId.has(targetId) ? 'rule_field_excluded' : 'rule_field_missing', targetId, rule.id
      ));
      const set = effects.get(targetId) ?? new Set();
      set.add(rule.effect.kind);
      effects.set(targetId, set);
    }
  }
  for (const [fieldId, kinds] of effects) {
    if (kinds.has('show') && kinds.has('hide')) issues.push(issue('rule_visibility_conflict', fieldId));
  }

  const orderedIssues = [...new Map(issues.map((entry) => [issueIdentity(entry), entry])).values()]
    .sort((left, right) => compareCanonicalText(issueIdentity(left), issueIdentity(right)));
  return deepFreeze({ fields: rows, issues: orderedIssues });
}

export function projectOrganizerFormSummary(input: {
  readonly head: FormDefinitionHeadDto;
  readonly submissionCount: number;
  readonly registry: FieldRegistrySnapshotDto;
  readonly references: IntakeFormReferenceSource;
}): OrganizerFormSummaryDto {
  const head = parseFormDefinitionHead(input.head);
  const analyzed = analyzeFormComposition({
    formId: head.id,
    definition: head.definition,
    registry: input.registry
  });
  const referenceIssues = currentReferenceIssues(head, input.references);
  const deadline = head.definition.availability.kind === 'deadline'
    ? resolveCurrentDeadline(head.scope, head.definition.availability, input.references)
    : undefined;
  return organizerFormSummarySchema.parse({
    schemaVersion: 1,
    id: head.id,
    name: head.definition.name,
    target: head.definition.target,
    availability: head.definition.availability,
    status: head.status,
    version: head.version,
    currentPublishedVersionId: head.currentPublishedVersionId,
    composition: head.definition.composition,
    registryPin: formRegistryPin(input.registry),
    closesAt: deadline?.displayDate ?? null,
    fieldCount: analyzed.fields.length,
    configurationIssues: [...analyzed.issues, ...referenceIssues]
      .sort((left, right) => compareCanonicalText(issueIdentity(left), issueIdentity(right))),
    submissionCount: input.submissionCount,
    updatedAt: head.updatedAt
  });
}

export function projectOrganizerFormCatalog(input: {
  readonly catalogVersion: number;
  readonly registry: FieldRegistrySnapshotDto;
  readonly forms: readonly OrganizerFormSummaryDto[];
}): OrganizerFormCatalogDto {
  return organizerFormCatalogSchema.parse({
    schemaVersion: 1,
    catalogVersion: input.catalogVersion,
    registryPin: formRegistryPin(input.registry),
    forms: input.forms
  });
}

export function projectOrganizerFormDetail(input: {
  readonly head: FormDefinitionHeadDto;
  readonly registry: FieldRegistrySnapshotDto;
  readonly references: IntakeFormReferenceSource;
  readonly currentPublishedVersion: FormVersionDto | null;
}): OrganizerFormDetailDto {
  const head = parseFormDefinitionHead(input.head);
  const analyzed = analyzeFormComposition({
    formId: head.id,
    definition: head.definition,
    registry: input.registry
  });
  return organizerFormDetailSchema.parse({
    schemaVersion: 1,
    head,
    registryPin: formRegistryPin(input.registry),
    fields: analyzed.fields,
    configurationIssues: [...analyzed.issues, ...currentReferenceIssues(head, input.references)]
      .sort((left, right) => compareCanonicalText(issueIdentity(left), issueIdentity(right))),
    currentPublishedVersion: input.currentPublishedVersion
  });
}

export function projectServedPublicForm(input: {
  readonly version: FormVersionDto;
  readonly optionSource: IntakeProgramVocabularyOptionSource;
  readonly references: IntakeFormReferenceSource;
}): ServedPublicFormDto {
  const version = parseFormVersion(input.version);
  const targetPin = resolveCurrentTarget(version.scope, version.definition.target, input.references);
  if (version.definition.target.kind !== 'general_pool' && !targetPin) {
    throw new IntakeValidationError('target_unavailable');
  }
  const deadlinePin = version.definition.availability.kind === 'deadline'
    ? resolveCurrentDeadline(version.scope, version.definition.availability, input.references)
    : undefined;
  if (version.definition.availability.kind === 'deadline' && !deadlinePin) {
    throw new IntakeValidationError('deadline_unavailable');
  }
  const fields = version.definition.fields.map((field) => {
    const base = {
      kind: field.kind,
      id: field.id,
      label: field.label,
      help: field.help,
      required: field.required,
      initiallyVisible: field.initiallyVisible,
      position: field.position
    };
    if (field.kind === 'text' || field.kind === 'textarea' || field.kind === 'email'
        || field.kind === 'url' || field.kind === 'phone') {
      return { ...base, maximumLength: field.maximumLength };
    }
    if (field.kind === 'number') {
      return { ...base, minimum: field.minimum, maximum: field.maximum, integerOnly: field.integerOnly };
    }
    if (field.kind === 'select' || field.kind === 'multiselect') {
      const options = field.options.kind === 'custom'
        ? field.options.choices.map(({ id, label, position }) => ({ id, label, position }))
        : field.options.kind === 'program_vocabulary'
          ? input.optionSource.readLiveOptions(version.scope, field.options.source)
            .filter((option) => option.status === 'active'
              && (field.options.kind !== 'program_vocabulary'
                || field.options.exposure.kind === 'all_active'
                || field.options.exposure.items.some((item) => item.id === option.id)))
            .sort((left, right) => compareCanonicalText(left.id, right.id))
            .map((option, position) => ({ id: option.id, label: option.label, position }))
          : [];
      return field.kind === 'select'
        ? { ...base, options }
        : { ...base, options, maximumSelections: field.maximumSelections };
    }
    return base;
  });
  return servedPublicFormSchema.parse({
    schemaVersion: 1,
    formId: version.formId,
    formVersionId: version.id,
    formVersionNumber: version.number,
    name: version.definition.name,
    confirmation: version.definition.confirmation,
    target: version.definition.target.kind === 'general_pool'
      ? { kind: 'general_pool' }
      : version.definition.target.kind === 'category' && targetPin?.kind === 'category'
        ? {
            kind: 'category',
            category: {
              kind: targetPin.categoryKind,
              id: targetPin.id,
              name: targetPin.name
            }
          }
        : targetPin?.kind === 'session'
          ? { kind: 'session', sessionId: targetPin.id, title: targetPin.title }
          : { kind: 'general_pool' },
    availability: deadlinePin
      ? { kind: 'closes', effectiveAt: deadlinePin.effectiveAt, gracePolicy: deadlinePin.gracePolicy }
      : { kind: 'evergreen' },
    fields,
    rules: version.definition.rules.map((rule) => ({
      id: rule.id,
      position: rule.position,
      condition: rule.condition.kind === 'selected_any'
        ? {
            kind: rule.condition.kind,
            sourceFieldId: rule.condition.sourceFieldId,
            choiceIds: rule.condition.choiceIds
          }
        : rule.condition,
      effect: rule.effect
    }))
  });
}

export function projectOrganizerSubmissionContact(input: {
  readonly submissionId: string;
  readonly personId: string;
  readonly participantIdentityId: string;
  readonly sourceFieldId: string;
  readonly email: string;
}): OrganizerSubmissionContactDto {
  return organizerSubmissionContactSchema.parse({ schemaVersion: 1, ...input });
}

export type IntakeValidationErrorCode =
  | 'invalid_form_catalog'
  | 'invalid_form_head'
  | 'invalid_form_version'
  | 'invalid_application_draft'
  | 'invalid_application_draft_revision'
  | 'invalid_submission'
  | 'invalid_submission_evidence'
  | 'invalid_participant_evidence'
  | 'invalid_consent_evidence'
  | 'target_unavailable'
  | 'deadline_unavailable';

export class IntakeValidationError extends TypeError {
  constructor(readonly code: IntakeValidationErrorCode) {
    super(code);
    this.name = 'IntakeValidationError';
  }
}

function parseSchema<Output>(
  schema: { readonly safeParse: (value: unknown) => { success: true; data: Output } | { success: false } },
  value: unknown,
  code: IntakeValidationErrorCode
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new IntakeValidationError(code);
  return deepFreeze(parsed.data);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...expected].sort(compareCanonicalText);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function deepFreeze<Value>(value: Value): Value {
  if (value !== null
      && typeof value === 'object'
      && !ArrayBuffer.isView(value)
      && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
