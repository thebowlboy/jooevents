import {
	formatInstant,
	intakeFormSafeDiffSchema,
	type ChangesetDiffData,
	type FormDefinitionAuthorInput,
	type FormDefinitionContentDto,
	type FormTarget,
	type IntakeFormDraftData,
	type IntakeFormSafeDiff,
	type OrganizerFormCatalogDto,
	type OrganizerFormDetailDto,
	type OrganizerFormSummaryDto
} from '@jooevents/contracts';
import { mapFieldRegistryField } from './field-registry';
import type {
	OrganizerFormCatalogView,
	OrganizerFormChangesetDiffView,
	OrganizerFormDefinitionView,
	OrganizerFormDetailView,
	OrganizerFormDraftView,
	OrganizerFormSafeDiffView,
	OrganizerFormSummaryView,
	OrganizerFormTargetView
} from '../view-models/intake-forms';

type HandledSummaryKey =
	| 'schemaVersion'
	| 'id'
	| 'name'
	| 'target'
	| 'availability'
	| 'status'
	| 'version'
	| 'currentPublishedVersionId'
	| 'composition'
	| 'registryPin'
	| 'closesAt'
	| 'fieldCount'
	| 'configurationIssues'
	| 'submissionCount'
	| 'updatedAt';
const unhandledSummaryKeys: Record<Exclude<keyof OrganizerFormSummaryDto, HandledSummaryKey>, never> = {};
void unhandledSummaryKeys;

type HandledDetailKey =
	| 'schemaVersion'
	| 'head'
	| 'registryPin'
	| 'fields'
	| 'configurationIssues'
	| 'currentPublishedVersion';
const unhandledDetailKeys: Record<Exclude<keyof OrganizerFormDetailDto, HandledDetailKey>, never> = {};
void unhandledDetailKeys;

/**
 * A form's own bookkeeping timestamps — last edited, published. The zone is
 * named rather than implied; it is UTC because the Form wire contract carries
 * no event timezone, which is a statement this mapper can make honestly and a
 * silent local clock would not be.
 */
function instantLabel(instant: string): string {
	return formatInstant(instant, 'UTC', { zone: true, fallback: 'Not recorded' });
}

function unreachable(value: never): never {
	throw new TypeError(`Unsupported organizer Form contract variant: ${JSON.stringify(value)}`);
}

export function mapOrganizerFormTarget(target: FormTarget): OrganizerFormTargetView {
	switch (target.kind) {
		case 'general_pool':
			return Object.freeze({ kind: 'general_pool', label: 'General pool' });
		case 'category':
			return Object.freeze({
				kind: 'category',
				categoryKind: target.category.kind,
				categoryId: target.category.id,
				label: target.category.kind === 'track' ? 'Track target' : 'Format target'
			});
		case 'session':
			return Object.freeze({
				kind: 'session',
				sessionId: target.sessionId,
				label: 'Session target'
			});
		default:
			return unreachable(target);
	}
}

function cloneComposition(composition: FormDefinitionContentDto['composition']) {
	return {
		excludedFieldIds: [...composition.excludedFieldIds],
		requiredOverrides: { ...composition.requiredOverrides },
		optionExposure: Object.fromEntries(
			Object.entries(composition.optionExposure).map(([fieldId, ids]) => [fieldId, [...ids]])
		)
	};
}

/** Drops storage-owned rule identities while preserving every organizer-authored fact. */
export function mapFormDefinitionToAuthorInput(
	definition: FormDefinitionContentDto
): FormDefinitionAuthorInput {
	return {
		kind: definition.kind,
		name: definition.name,
		target: structuredClone(definition.target),
		availability: structuredClone(definition.availability),
		confirmation: definition.confirmation,
		composition: cloneComposition(definition.composition),
		rules: definition.rules.map((rule) => ({
			key: rule.key,
			condition: structuredClone(rule.condition),
			effect: structuredClone(rule.effect)
		}))
	};
}

function mapDefinitionView(input: {
	readonly id: string;
	readonly version: number;
	readonly status: OrganizerFormDefinitionView['status'];
	readonly currentPublishedVersionId: string | null;
	readonly definition: FormDefinitionContentDto;
}): OrganizerFormDefinitionView {
	return Object.freeze({
		id: input.id,
		version: input.version,
		status: input.status,
		currentPublishedVersionId: input.currentPublishedVersionId,
		name: input.definition.name,
		target: mapOrganizerFormTarget(input.definition.target),
		definition: mapFormDefinitionToAuthorInput(input.definition)
	});
}

export function mapOrganizerFormSummary(summary: OrganizerFormSummaryDto): OrganizerFormSummaryView {
	return Object.freeze({
		id: summary.id,
		name: summary.name,
		target: mapOrganizerFormTarget(summary.target),
		status: summary.status,
		statusLabel: summary.status === 'draft' ? 'Draft' : summary.status === 'open' ? 'Open' : 'Closed',
		version: summary.version,
		currentPublishedVersionId: summary.currentPublishedVersionId,
		composition: cloneComposition(summary.composition),
		registryPin: Object.freeze({ ...summary.registryPin }),
		closesAt: summary.closesAt,
		fieldCount: summary.fieldCount,
		configurationIssues: Object.freeze(summary.configurationIssues.map((issue) => Object.freeze({ ...issue }))),
		submissionCount: summary.submissionCount,
		updatedAt: summary.updatedAt,
		updatedAtLabel: instantLabel(summary.updatedAt)
	});
}

export function mapOrganizerFormCatalog(catalog: OrganizerFormCatalogDto): OrganizerFormCatalogView {
	return Object.freeze({
		catalogVersion: catalog.catalogVersion,
		registryPin: Object.freeze({ ...catalog.registryPin }),
		forms: Object.freeze(catalog.forms.map(mapOrganizerFormSummary))
	});
}

export function mapOrganizerFormDetail(detail: OrganizerFormDetailDto): OrganizerFormDetailView {
	return Object.freeze({
		form: mapDefinitionView(detail.head),
		registryPin: Object.freeze({ ...detail.registryPin }),
		fields: Object.freeze(detail.fields.map((row) => Object.freeze({
			field: mapFieldRegistryField(row.field),
			included: row.included,
			required: row.required,
			requiredOverridden: row.requiredOverridden,
			...(row.options === null
				? {}
				: {
						options: row.options.map((option) => Object.freeze({
							id: option.id,
							name: option.name,
							exposed: option.exposed
						}))
					}),
			exposureAll: row.exposureAll
		}))),
		configurationIssues: Object.freeze(
			detail.configurationIssues.map((issue) => Object.freeze({ ...issue }))
		),
		createdAt: detail.head.createdAt,
		updatedAt: detail.head.updatedAt,
		updatedAtLabel: instantLabel(detail.head.updatedAt),
		publishedVersion: detail.currentPublishedVersion
			? Object.freeze({
					id: detail.currentPublishedVersion.id,
					number: detail.currentPublishedVersion.number,
					sourceDefinitionVersion: detail.currentPublishedVersion.sourceDefinitionVersion,
					publishedAt: detail.currentPublishedVersion.publishedAt,
					publishedAtLabel: instantLabel(detail.currentPublishedVersion.publishedAt)
				})
			: null
	});
}

export function mapOrganizerFormSafeDiff(diff: IntakeFormSafeDiff): OrganizerFormSafeDiffView {
	return structuredClone(diff);
}

export function mapOrganizerFormDraft(draft: IntakeFormDraftData): OrganizerFormDraftView {
	return Object.freeze({
		action: draft.action,
		changesetId: draft.changesetId,
		headVersion: draft.headVersion,
		revisionId: draft.revision.id,
		revisionNumber: draft.revision.number,
		revisionDigest: draft.revision.digestSha256,
		riskTier: draft.riskTier,
		approvalRequirement: draft.approvalPolicy.requirement,
		safeDiff: mapOrganizerFormSafeDiff(draft.safeDiff)
	});
}

export function mapOrganizerFormChangesetDiff(diff: ChangesetDiffData): OrganizerFormChangesetDiffView {
	return Object.freeze({
		changesetId: diff.changesetId,
		headVersion: diff.headVersion,
		status: diff.status,
		revisionId: diff.revisionId,
		revisionNumber: diff.revisionNumber,
		revisionDigest: diff.revisionDigest,
		riskTier: diff.riskTier,
		approvalRequirement: diff.approvalPolicy.requirement,
		operations: Object.freeze(diff.operations.map((operation) => {
			// Cross-lane conformance note (Wave-2 J-WEB): the canonical
			// FORM_CHANGESET_VERSION moved 2 -> 3 with the intake source
			// widening; the sample dataset still emits 2 through this shared
			// mapper, so both served versions verify until the forms lane
			// converges the sample on the canonical version.
			if (operation.kind !== 'intake.form.mutate'
				|| (operation.version !== 2 && operation.version !== 3)) {
				throw new TypeError('Changeset diff contains a non-Form operation.');
			}
			const parsedSafeDiff = intakeFormSafeDiffSchema.safeParse(operation.safeDiff);
			if (!parsedSafeDiff.success) {
				throw new TypeError('Changeset Form diff does not match its wire contract.');
			}
			return Object.freeze({
				kind: operation.kind,
				version: operation.version,
				riskTier: operation.riskTier,
				dependencyGroup: operation.dependencyGroup,
				safeDiff: mapOrganizerFormSafeDiff(parsedSafeDiff.data),
				consequences: Object.freeze([...operation.consequences])
			});
		}))
	});
}
