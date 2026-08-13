import {
	changesetDiffDataSchema,
	formDefinitionContentSchema,
	formVersionSchema,
	organizerFormCatalogSchema,
	organizerFormDetailSchema,
	type FormDefinitionAuthorInput,
	type FormDefinitionContentDto,
	type FormDefinitionCreateAuthorInput,
	type FormDefinitionHeadDto,
	type FormFieldDefinitionDto,
	type FormVersionDto,
	type IntakeFormSafeDiff,
	type OrganizerFormDetailDto,
	type OrganizerFormFieldRowDto,
	type StructuredOutcome
} from '@jooevents/contracts';
import {
	intakeFormsFixtureIds,
	sampleFormRegistryPin,
	sampleOrganizerFormCatalogDto,
	sampleOrganizerFormDetailDtos,
	sampleOrganizerFormRows
} from '../fixtures/intake-forms';
import {
	mapOrganizerFormCatalog,
	mapOrganizerFormChangesetDiff,
	mapOrganizerFormDetail,
	mapOrganizerFormDraft
} from '../mappers/intake-forms';
import type {
	OrganizerFormsChangesetEffectInput,
	OrganizerFormsChangesetSelector,
	OrganizerFormsPort,
	OrganizerFormsResult
} from '../view-models/intake-forms';

type SampleAction = 'create' | 'revise' | 'publish' | 'lifecycle' | 'closing';

interface SamplePendingChange {
	readonly action: SampleAction;
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
	readonly safeDiff: IntakeFormSafeDiff;
	status: 'draft' | 'proposed' | 'committed';
	headVersion: number;
	readonly apply: () => void;
}

const scope = Object.freeze({
	workspaceId: intakeFormsFixtureIds.workspace,
	eventId: intakeFormsFixtureIds.event
});
const approvalPolicy = Object.freeze({
	reference: Object.freeze({ key: 'approval.form_ordinary', version: 1 }),
	definitionDigestSha256: 'd'.repeat(64),
	requirement: 'none' as const
});

function clone<Value>(value: Value): Value {
	return structuredClone(value);
}

function uuid(): string {
	return crypto.randomUUID();
}

function digest(seed: string): string {
	return seed.toLowerCase().replace(/[^a-f0-9]/gu, '0').padEnd(64, '0').slice(0, 64);
}

function now(): string {
	return new Date().toISOString();
}

function effectiveAt(displayDate: string): string {
	return `${displayDate}T23:59:59.000Z`;
}

function sampleOutcome(kind: string, subjectId: string): OrganizerFormsResult<never> {
	const outcome: StructuredOutcome = {
		class: 'stale_revision',
		kind,
		retryable: false,
		subjects: [{ type: 'intake_form', id: subjectId }],
		detail: null,
		detailSchemaVersion: 1
	};
	return { kind: 'outcome', outcome, terminal: false, correlationId: uuid() };
}

function sampleReceipt(operationName: string) {
	return Object.freeze({ id: uuid(), operationName, operationVersion: 1 });
}

function storedRules(
	rules: FormDefinitionAuthorInput['rules'] | FormDefinitionCreateAuthorInput['rules'],
	before: FormDefinitionContentDto | null = null
): FormDefinitionContentDto['rules'] {
	const previous = new Map(before?.rules.map((rule) => [rule.key, rule.id]) ?? []);
	return rules.map((rule, position) => ({
		id: previous.get(rule.key) ?? uuid(),
		key: rule.key,
		position,
		condition: structuredClone(rule.condition),
		effect: structuredClone(rule.effect)
	}));
}

function materializeCreate(
	author: FormDefinitionCreateAuthorInput
): { readonly definition: FormDefinitionContentDto; readonly closesAt: string | null } {
	const closesAt = author.availability.kind === 'fixed_close_date'
		? author.availability.displayDate
		: null;
	return {
		closesAt,
		definition: formDefinitionContentSchema.parse({
			kind: author.kind,
			name: author.name,
			target: author.target,
			availability: closesAt === null
				? { kind: 'evergreen' }
				: { kind: 'deadline', deadlineId: uuid() },
			confirmation: author.confirmation,
			composition: author.composition,
			rules: storedRules(author.rules)
		})
	};
}

function materializeRevision(
	author: FormDefinitionAuthorInput,
	before: FormDefinitionContentDto
): FormDefinitionContentDto {
	return formDefinitionContentSchema.parse({
		kind: author.kind,
		name: author.name,
		target: author.target,
		availability: author.availability,
		confirmation: author.confirmation,
		composition: author.composition,
		rules: storedRules(author.rules, before)
	});
}

function safeHead(head: FormDefinitionHeadDto) {
	return {
		id: head.id,
		version: head.version,
		status: head.status,
		currentPublishedVersionId: head.currentPublishedVersionId,
		definition: head.definition
	};
}

function joinedRows(
	definition: FormDefinitionContentDto,
	rows: readonly OrganizerFormFieldRowDto[]
): OrganizerFormFieldRowDto[] {
	const excluded = new Set(definition.composition.excludedFieldIds);
	return rows.map((row) => {
		const scoped = row.field.scope.kind === 'form';
		const exposure = definition.composition.optionExposure[row.field.id];
		return {
			...clone(row),
			included: scoped || !excluded.has(row.field.id),
			required: definition.composition.requiredOverrides[row.field.id]
				?? row.field.contexts.apply.required,
			requiredOverridden: definition.composition.requiredOverrides[row.field.id] !== undefined,
			options: row.options?.map((option) => ({
				...option,
				exposed: exposure === undefined || exposure.includes(option.id)
			})) ?? null,
			exposureAll: exposure === undefined
		};
	});
}

function versionField(row: OrganizerFormFieldRowDto, position: number): FormFieldDefinitionDto {
	const field = row.field;
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
		required: row.required,
		initiallyVisible: true,
		position
	};
	switch (field.kind) {
		case 'text':
			return { kind: 'text', ...base, maximumLength: 500, options: { kind: 'none' } };
		case 'textarea':
			return { kind: 'textarea', ...base, maximumLength: 10_000, options: { kind: 'none' } };
		case 'email':
			return { kind: 'email', ...base, maximumLength: 320, options: { kind: 'none' } };
		case 'url':
			return { kind: 'url', ...base, maximumLength: 2_048, options: { kind: 'none' } };
		case 'phone':
			return { kind: 'phone', ...base, maximumLength: 64, options: { kind: 'none' } };
		case 'number':
			return { kind: 'number', ...base, minimum: null, maximum: null, integerOnly: false, options: { kind: 'none' } };
		case 'date':
			return { kind: 'date', ...base, options: { kind: 'none' } };
		case 'datetime':
			return { kind: 'datetime', ...base, options: { kind: 'none' } };
		case 'checkbox':
			return { kind: 'checkbox', ...base, options: { kind: 'none' } };
		case 'select':
		case 'multiselect': {
			const options = field.options.kind === 'program_vocabulary'
				? {
						kind: 'program_vocabulary' as const,
						source: field.options.source,
						exposure: row.exposureAll
							? { kind: 'all_active' as const }
							: {
									kind: 'subset' as const,
									items: (row.options ?? []).filter((option) => option.exposed).map((option) => ({
										source: field.options.kind === 'program_vocabulary' ? field.options.source : 'tracks',
										id: option.id,
										version: option.version,
										label: option.name
									}))
								}
					}
				: {
						kind: 'custom' as const,
						choices: field.options.kind === 'custom'
							? field.options.choices.map((choice) => ({ ...choice }))
							: []
					};
			return field.kind === 'select'
				? { kind: 'select', ...base, options }
				: { kind: 'multiselect', ...base, options, maximumSelections: 20 };
		}
		case 'file':
			throw new TypeError('Sample published Forms cannot include upload-disabled file fields.');
	}
}

function publishVersion(
	detail: OrganizerFormDetailDto,
	closesAt: string | null
): FormVersionDto {
	const versionId = uuid();
	const definition = detail.head.definition;
	const fields = joinedRows(definition, detail.fields)
		.filter((row) => row.included)
		.map(versionField);
	const targetPin = definition.target.kind === 'general_pool'
		? null
		: definition.target.kind === 'category'
			? {
					kind: 'category' as const,
					categoryKind: definition.target.category.kind,
					id: definition.target.category.id,
					name: 'Sample category',
					version: 1
				}
			: {
					kind: 'session' as const,
					id: definition.target.sessionId,
					title: 'Sample collecting session',
					version: 1,
					lifecycle: 'collecting' as const
				};
	const deadlinePin = definition.availability.kind === 'deadline' && closesAt
		? {
				id: definition.availability.deadlineId,
				version: 1,
				digestSha256: digest(definition.availability.deadlineId),
				effectiveAt: effectiveAt(closesAt),
				displayDate: closesAt,
				gracePolicy: 'soft' as const
			}
		: null;
	return formVersionSchema.parse({
		schemaVersion: 1,
		id: versionId,
		formId: detail.head.id,
		scope,
		number: (detail.currentPublishedVersion?.number ?? 0) + 1,
		sourceDefinitionVersion: detail.head.version,
		sourceDefinitionDigestSha256: digest(`${detail.head.id}-source-${detail.head.version}`),
		registryPin: detail.registryPin,
		definitionDigestSha256: digest(versionId),
		definition: {
			kind: definition.kind,
			name: definition.name,
			target: definition.target,
			availability: definition.availability,
			confirmation: definition.confirmation,
			fields,
			rules: definition.rules.map((rule) => ({
				...rule,
				condition: rule.condition.kind === 'selected_any'
					? { ...rule.condition, programVocabularyPins: [] }
					: rule.condition
			}))
		},
		targetPin,
		deadlinePin,
		publishedByUserId: intakeFormsFixtureIds.user,
		publishedAt: now()
	});
}

export interface IntakeFormsSamplePort extends OrganizerFormsPort {
	readonly source: Extract<OrganizerFormsPort['source'], { readonly kind: 'sample' }>;
	reset(): void;
}

/** Resettable canonical demo. Effective state changes only after exact proposal and commit. */
export function createIntakeFormsSamplePort(): IntakeFormsSamplePort {
	let catalogVersion = sampleOrganizerFormCatalogDto.catalogVersion;
	let details = clone(sampleOrganizerFormDetailDtos) as Record<string, OrganizerFormDetailDto>;
	let closesAt = new Map(sampleOrganizerFormCatalogDto.forms.map((form) => [form.id, form.closesAt]));
	let pending = new Map<string, SamplePendingChange>();
	let idempotency = new Map<string, OrganizerFormsResult<unknown>>();
	let submissionCounts = new Map(
		sampleOrganizerFormCatalogDto.forms.map((form) => [form.id, form.submissionCount])
	);
	let deadlineVersions = new Map<string, number>();

	const reset = () => {
		catalogVersion = sampleOrganizerFormCatalogDto.catalogVersion;
		details = clone(sampleOrganizerFormDetailDtos) as Record<string, OrganizerFormDetailDto>;
		closesAt = new Map(sampleOrganizerFormCatalogDto.forms.map((form) => [form.id, form.closesAt]));
		pending = new Map();
		idempotency = new Map();
		submissionCounts = new Map(
			sampleOrganizerFormCatalogDto.forms.map((form) => [form.id, form.submissionCount])
		);
		deadlineVersions = new Map();
	};

	const summaries = () => organizerFormCatalogSchema.parse({
		schemaVersion: 1,
		catalogVersion,
		registryPin: sampleFormRegistryPin,
		forms: Object.values(details).map((detail) => {
			const rows = joinedRows(detail.head.definition, detail.fields);
			return {
				schemaVersion: 1,
				id: detail.head.id,
				name: detail.head.definition.name,
				target: detail.head.definition.target,
				availability: detail.head.definition.availability,
				status: detail.head.status,
				version: detail.head.version,
				currentPublishedVersionId: detail.head.currentPublishedVersionId,
				composition: detail.head.definition.composition,
				registryPin: detail.registryPin,
				closesAt: closesAt.get(detail.head.id) ?? null,
				fieldCount: rows.filter((row) => row.included).length,
				configurationIssues: detail.configurationIssues,
				submissionCount: submissionCounts.get(detail.head.id) ?? 0,
				updatedAt: detail.head.updatedAt
			};
		}).sort((left, right) => left.id.localeCompare(right.id))
	});

	const makePending = (
		action: SampleAction,
		safeDiff: IntakeFormSafeDiff,
		operationName: string,
		key: string,
		apply: () => void
	): OrganizerFormsResult<ReturnType<typeof mapOrganizerFormDraft>> => {
		const replayed = idempotency.get(key);
		if (replayed) return replayed as OrganizerFormsResult<ReturnType<typeof mapOrganizerFormDraft>>;
		const changesetId = uuid();
		const revisionId = uuid();
		const revisionDigest = digest(revisionId);
		const change: SamplePendingChange = {
			action,
			changesetId,
			revisionId,
			revisionDigest,
			safeDiff,
			status: 'draft',
			headVersion: 1,
			apply
		};
		pending.set(changesetId, change);
		const data = mapOrganizerFormDraft({
			schemaVersion: 1,
			action,
			changesetId,
			headVersion: 1,
			status: 'draft',
			revision: { id: revisionId, number: 1, digestSha256: revisionDigest },
			riskTier: 'normal',
			approvalPolicy,
			safeDiff
		});
		const result = {
			kind: 'success' as const,
			data,
			correlationId: uuid(),
			receipt: sampleReceipt(operationName)
		};
		idempotency.set(key, result);
		return result;
	};

	const replay = <Data>(key: string): OrganizerFormsResult<Data> | null =>
		(idempotency.get(key) as OrganizerFormsResult<Data> | undefined) ?? null;

	const readChange = (selector: OrganizerFormsChangesetSelector) => {
		const change = pending.get(selector.changesetId);
		return change && change.revisionId === selector.revisionId
			&& change.revisionDigest === selector.revisionDigest ? change : null;
	};

	const mapDiff = (change: SamplePendingChange) => mapOrganizerFormChangesetDiff(
		changesetDiffDataSchema.parse({
			changesetId: change.changesetId,
			headVersion: change.headVersion,
			status: change.status,
			revisionId: change.revisionId,
			revisionNumber: 1,
			revisionDigest: change.revisionDigest,
			riskTier: 'normal',
			approvalPolicy,
			operations: [{
				kind: 'intake.form.mutate',
				version: 2,
				riskTier: 'normal',
				dependencyGroup: 'intake_form',
				safeDiff: change.safeDiff,
				consequences: ['intake_form_changed']
			}]
		})
	);

	const source = Object.freeze({
		kind: 'sample' as const,
		label: 'Sample data' as const,
		scenario: Object.freeze({
			key: 'intake-forms-canonical',
			name: 'Organizer Forms',
			description: 'A resettable catalog with one open Form and one draft Form.'
		})
	});

	const port: IntakeFormsSamplePort = {
		source,
		reset,
		async list() {
			return { kind: 'success', data: mapOrganizerFormCatalog(summaries()), correlationId: uuid() };
		},
		async readDetail(formId) {
			const detail = details[formId];
			if (!detail) return sampleOutcome('intake_form.missing', formId);
			const joined = organizerFormDetailSchema.parse({
				...detail,
				fields: joinedRows(detail.head.definition, detail.fields)
			});
			return { kind: 'success', data: mapOrganizerFormDetail(joined), correlationId: uuid() };
		},
		async draftCreate(input, key) {
			const prior = replay<ReturnType<typeof mapOrganizerFormDraft>>(key);
			if (prior) return prior;
			if (input.expectedCatalogVersion !== catalogVersion
				|| input.expectedRegistryVersion !== sampleFormRegistryPin.version) {
				return sampleOutcome('intake_form.changed', 'catalog');
			}
			const at = now();
			const materialized = materializeCreate(input.definition);
			const head: FormDefinitionHeadDto = {
				schemaVersion: 1,
				id: uuid(),
				scope,
				version: 1,
				status: 'draft',
				currentPublishedVersionId: null,
				definition: materialized.definition,
				createdByUserId: intakeFormsFixtureIds.user,
				createdAt: at,
				updatedByUserId: intakeFormsFixtureIds.user,
				updatedAt: at
			};
			const diff: IntakeFormSafeDiff = { action: 'create', before: null, after: safeHead(head) };
			return makePending('create', diff, 'form.definition.create.draft', key, () => {
				details[head.id] = organizerFormDetailSchema.parse({
					schemaVersion: 1,
					head,
					registryPin: sampleFormRegistryPin,
					fields: joinedRows(head.definition, sampleOrganizerFormRows),
					configurationIssues: [],
					currentPublishedVersion: null
				});
				closesAt.set(head.id, materialized.closesAt);
				catalogVersion += 1;
			});
		},
		async draftRevise(input, key) {
			const prior = replay<ReturnType<typeof mapOrganizerFormDraft>>(key);
			if (prior) return prior;
			const detail = details[input.formId];
			if (!detail || detail.head.version !== input.expectedDefinitionVersion
				|| detail.registryPin.version !== input.expectedRegistryVersion) {
				return sampleOutcome('intake_form.changed', input.formId);
			}
			const after: FormDefinitionHeadDto = {
				...detail.head,
				version: detail.head.version + 1,
				definition: materializeRevision(input.definition, detail.head.definition),
				updatedByUserId: intakeFormsFixtureIds.user,
				updatedAt: now()
			};
			const diff: IntakeFormSafeDiff = {
				action: 'revise', before: safeHead(detail.head), after: safeHead(after)
			};
			return makePending('revise', diff, 'form.definition.revise.draft', key, () => {
				details[input.formId] = organizerFormDetailSchema.parse({
					...detail,
					head: after,
					fields: joinedRows(after.definition, detail.fields)
				});
				catalogVersion += 1;
			});
		},
		async draftPublish(input, key) {
			const prior = replay<ReturnType<typeof mapOrganizerFormDraft>>(key);
			if (prior) return prior;
			const detail = details[input.formId];
			if (!detail || detail.head.version !== input.expectedDefinitionVersion
				|| detail.registryPin.version !== input.expectedRegistryVersion) {
				return sampleOutcome('intake_form.changed', input.formId);
			}
			const version = publishVersion(detail, closesAt.get(input.formId) ?? null);
			const after: FormDefinitionHeadDto = {
				...detail.head,
				version: detail.head.version + 1,
				currentPublishedVersionId: version.id,
				updatedAt: version.publishedAt
			};
			const publishedVersion = {
				id: version.id,
				number: version.number,
				definitionDigestSha256: version.definitionDigestSha256
			};
			const diff: IntakeFormSafeDiff = {
				action: 'publish',
				before: safeHead(detail.head),
				after: safeHead(after),
				publishedVersion
			};
			return makePending('publish', diff, 'form.version.publish.draft', key, () => {
				details[input.formId] = organizerFormDetailSchema.parse({
					...detail, head: after, currentPublishedVersion: version
				});
				catalogVersion += 1;
			});
		},
		async draftLifecycle(input, key) {
			const prior = replay<ReturnType<typeof mapOrganizerFormDraft>>(key);
			if (prior) return prior;
			const detail = details[input.formId];
			if (!detail || detail.head.version !== input.expectedDefinitionVersion) {
				return sampleOutcome('intake_form.changed', input.formId);
			}
			const publishing = input.transition === 'publish_and_open';
			if ((publishing && (detail.head.status !== 'draft'
					|| input.expectedRegistryVersion !== detail.registryPin.version))
				|| (input.transition === 'reopen' && detail.head.status !== 'closed')
				|| (input.transition === 'close' && detail.head.status !== 'open')) {
				return sampleOutcome('intake_form.lifecycle_refused', input.formId);
			}
			const version = publishing
				? publishVersion(detail, closesAt.get(input.formId) ?? null)
				: null;
			const after: FormDefinitionHeadDto = {
				...detail.head,
				version: detail.head.version + 1,
				status: input.transition === 'close' ? 'closed' : 'open',
				currentPublishedVersionId: version?.id ?? detail.head.currentPublishedVersionId,
				updatedAt: version?.publishedAt ?? now()
			};
			if (after.currentPublishedVersionId === null) {
				return sampleOutcome('intake_form.publication_required', input.formId);
			}
			const diff: IntakeFormSafeDiff = {
				action: 'lifecycle',
				before: safeHead(detail.head),
				after: safeHead(after),
				publishedVersion: version
					? {
							id: version.id,
							number: version.number,
							definitionDigestSha256: version.definitionDigestSha256
						}
					: null
			};
			return makePending('lifecycle', diff, 'form.lifecycle.change.draft', key, () => {
				details[input.formId] = organizerFormDetailSchema.parse({
					...detail,
					head: after,
					currentPublishedVersion: version ?? detail.currentPublishedVersion
				});
				catalogVersion += 1;
			});
		},
		async draftClosing(input, key) {
			const prior = replay<ReturnType<typeof mapOrganizerFormDraft>>(key);
			if (prior) return prior;
			const detail = details[input.formId];
			if (!detail || detail.head.version !== input.expectedDefinitionVersion) {
				return sampleOutcome('intake_form.changed', input.formId);
			}
			const beforeDate = closesAt.get(input.formId) ?? null;
			if (beforeDate === input.closesAt) return sampleOutcome('intake_form.unchanged', input.formId);
			const priorDeadlineId = detail.head.definition.availability.kind === 'deadline'
				? detail.head.definition.availability.deadlineId
				: null;
			const deadlineId = priorDeadlineId ?? uuid();
			const beforeVersion = priorDeadlineId ? (deadlineVersions.get(deadlineId) ?? 1) : 0;
			const afterVersion = beforeVersion + 1;
			const beforeDeadline = beforeDate === null
				? null
				: {
						id: deadlineId,
						status: 'active' as const,
						version: Math.max(1, beforeVersion),
						displayDate: beforeDate,
						effectiveAt: effectiveAt(beforeDate),
						gracePolicy: 'soft' as const
					};
			const afterDeadline = input.closesAt === null
				? {
						id: deadlineId,
						status: 'cleared' as const,
						version: afterVersion,
						displayDate: null,
						effectiveAt: null,
						gracePolicy: 'soft' as const
					}
				: {
						id: deadlineId,
						status: 'active' as const,
						version: afterVersion,
						displayDate: input.closesAt,
						effectiveAt: effectiveAt(input.closesAt),
						gracePolicy: 'soft' as const
					};
			const after: FormDefinitionHeadDto = {
				...detail.head,
				version: detail.head.version + 1,
				definition: {
					...detail.head.definition,
					availability: input.closesAt === null
						? { kind: 'evergreen' }
						: { kind: 'deadline', deadlineId }
				},
				updatedAt: now()
			};
			const diff: IntakeFormSafeDiff = {
				action: 'closing',
				before: safeHead(detail.head),
				after: safeHead(after),
				deadline: {
					action: beforeDate === null ? 'create' : input.closesAt === null ? 'clear' : 'update',
					before: beforeDeadline,
					after: afterDeadline,
					representedConsequences: ['deadline_changed']
				}
			};
			return makePending('closing', diff, 'form.closing.change.draft', key, () => {
				details[input.formId] = organizerFormDetailSchema.parse({ ...detail, head: after });
				closesAt.set(input.formId, input.closesAt);
				deadlineVersions.set(deadlineId, afterVersion);
				catalogVersion += 1;
			});
		},
		async readDiff(selector) {
			const change = readChange(selector);
			return change
				? { kind: 'success', data: mapDiff(change), correlationId: uuid() }
				: sampleOutcome('changeset.revision_missing', selector.changesetId);
		},
		async propose(input: OrganizerFormsChangesetEffectInput, key) {
			const replayed = idempotency.get(key);
			if (replayed) return replayed as Awaited<ReturnType<IntakeFormsSamplePort['propose']>>;
			const change = readChange(input);
			if (!change || change.headVersion !== input.expectedHeadVersion || change.status !== 'draft') {
				return sampleOutcome('changeset.lifecycle_refused', input.changesetId);
			}
			change.status = 'proposed';
			change.headVersion += 1;
			const result = {
				kind: 'success' as const,
				data: mapDiff(change),
				correlationId: uuid(),
				receipt: sampleReceipt('changeset.propose')
			};
			idempotency.set(key, result);
			return result;
		},
		async commit(input: OrganizerFormsChangesetEffectInput, key) {
			const replayed = idempotency.get(key);
			if (replayed) return replayed as Awaited<ReturnType<IntakeFormsSamplePort['commit']>>;
			const change = readChange(input);
			if (!change || change.headVersion !== input.expectedHeadVersion || change.status !== 'proposed') {
				return sampleOutcome('changeset.lifecycle_refused', input.changesetId);
			}
			change.apply();
			change.status = 'committed';
			change.headVersion += 1;
			const result = {
				kind: 'success' as const,
				data: {
					changesetId: change.changesetId,
					expectedHeadVersion: input.expectedHeadVersion,
					committedHeadVersion: change.headVersion,
					revisionId: change.revisionId,
					revisionDigest: change.revisionDigest
				},
				correlationId: uuid(),
				receipt: sampleReceipt('changeset.commit')
			};
			idempotency.set(key, result);
			return result;
		}
	};

	return Object.freeze(port);
}
