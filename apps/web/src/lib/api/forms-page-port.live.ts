import type {
	FormDefinitionAuthorInput,
	FormDefinitionCreateAuthorInput,
	StructuredOutcome
} from '@jooevents/contracts';
import type { FormsPagePort } from './forms-page-port';
import type { WorkspaceFieldsApi } from './field-registry-workspace-adapter';
import { mapFormDefinitionToAuthorInput } from './mappers/intake-forms';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type {
	FormComposition,
	FormSummary,
	FormTarget,
	MutationOutcome
} from './types';
import type {
	OrganizerFormDraftView,
	OrganizerFormSummaryView,
	OrganizerFormsPort,
	OrganizerFormsResult
} from './view-models/intake-forms';

type AdapterFailure = Readonly<{ code: string; reason: string }>;

/** Safe, reviewed-copy failure at the tuned Forms boundary. */
export class FormsPageLiveAdapterError extends Error {
	readonly code: string;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'FormsPageLiveAdapterError';
		this.code = failure.code;
	}
}

function detailCode(outcome: StructuredOutcome): string | undefined {
	if (typeof outcome.detail !== 'object' || outcome.detail === null) return undefined;
	const code = (outcome.detail as { readonly code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function outcomeFailure(outcome: StructuredOutcome): AdapterFailure {
	const code = detailCode(outcome);
	if (outcome.class === 'stale_revision'
		|| code === 'stale_catalog'
		|| code === 'stale_definition'
		|| code === 'stale_registry'
		|| code === 'form_changed'
		|| code === 'policy_changed') {
		return {
			code: outcome.kind,
			reason: 'This form or its speaker fields changed while you were working. Reload and try again.'
		};
	}
	if (outcome.class === 'access_denied') {
		return { code: outcome.kind, reason: 'You no longer have permission to change forms.' };
	}
	if (outcome.class === 'idempotency_conflict') {
		return {
			code: outcome.kind,
			reason: 'This form action changed before it finished. Reload and try it again.'
		};
	}
	if (code === 'target_unavailable' || outcome.kind.includes('target_unavailable')) {
		return {
			code: outcome.kind,
			reason: 'That destination is no longer available. Choose a current track or format and try again.'
		};
	}
	if (code === 'deadline_unavailable' || outcome.kind.includes('deadline_unavailable')) {
		return {
			code: outcome.kind,
			reason: 'That close date is no longer available. Reload the form and try again.'
		};
	}
	return { code: outcome.kind, reason: 'This form change could not be applied.' };
}

function resultFailure(
	result: Exclude<OrganizerFormsResult<unknown>, { readonly kind: 'success' }>
): AdapterFailure {
	if (result.kind === 'outcome') return outcomeFailure(result.outcome);
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: 'Forms are not available in this live workspace.' };
	}
	return {
		code: result.error.code,
		reason: result.error.retryable
			? 'Forms could not be reached. Try again.'
			: 'This Form request is not valid.'
	};
}

function isMissing(result: Exclude<OrganizerFormsResult<unknown>, { readonly kind: 'success' }>): boolean {
	return result.kind === 'outcome'
		&& (result.outcome.kind.endsWith('.missing')
			|| result.outcome.kind.endsWith('.not_found'));
}

function sameJson(left: unknown, right: unknown): boolean {
	function ordered(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(ordered);
		if (typeof value !== 'object' || value === null) return value;
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
				.map(([key, child]) => [key, ordered(child)])
		);
	}
	return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

function receiptMatches(
	receipt: { readonly operationName: string; readonly operationVersion: number } | undefined,
	name: string
): boolean {
	return receipt?.operationName === name && receipt.operationVersion === 1;
}

function canonicalComposition(composition: FormComposition): FormComposition {
	return {
		excludedFieldIds: [...composition.excludedFieldIds].sort(),
		requiredOverrides: Object.fromEntries(
			Object.entries(composition.requiredOverrides).sort(([left], [right]) => left.localeCompare(right))
		),
		optionExposure: Object.fromEntries(
			Object.entries(composition.optionExposure)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([fieldId, optionIds]) => [fieldId, [...optionIds].sort()])
		)
	};
}

function canonicalTarget(target: FormTarget): FormDefinitionAuthorInput['target'] {
	switch (target.kind) {
		case 'general':
			return { kind: 'general_pool' };
		case 'category':
			return { kind: 'category', category: { kind: target.category, id: target.id } };
		case 'session':
			return { kind: 'session', sessionId: target.sessionId };
	}
}

function tunedTarget(target: OrganizerFormSummaryView['target']): FormTarget {
	switch (target.kind) {
		case 'general_pool':
			return { kind: 'general' };
		case 'category':
			return { kind: 'category', category: target.categoryKind, id: target.categoryId };
		case 'session':
			return { kind: 'session', sessionId: target.sessionId };
	}
}

function tunedSummary(summary: OrganizerFormSummaryView): FormSummary {
	return {
		id: summary.id,
		name: summary.name,
		target: tunedTarget(summary.target),
		status: summary.status,
		...(summary.closesAt === null ? {} : { closesAt: summary.closesAt }),
		version: summary.version,
		submissionCount: summary.submissionCount,
		fieldCount: summary.fieldCount,
		composition: canonicalComposition(summary.composition)
	};
}

function defaultIdempotencyKey(): string {
	return `je.forms.action.${globalThis.crypto.randomUUID()}`;
}

interface WorkflowInput {
	readonly action: 'create' | 'revise' | 'lifecycle' | 'closing';
	readonly draftOperationName: string;
	readonly draft: (idempotencyKey: string) => Promise<OrganizerFormsResult<OrganizerFormDraftView>>;
	readonly validateDraft: (draft: OrganizerFormDraftView) => boolean;
}

/**
 * Adapts canonical Form + Registry + Program Vocabulary operations to the
 * already-tuned page. Every UI gesture completes one exact Draft → Propose →
 * Commit loop; no Deadline identity or sample fallback crosses this seam.
 */
export function createLiveFormsPagePort(input: {
	readonly forms: OrganizerFormsPort;
	readonly fields: WorkspaceFieldsApi;
	readonly vocabulary: Pick<ProgramVocabularySettingsPort, 'tracks' | 'formats'>;
	readonly newIdempotencyKey?: () => string;
}): FormsPagePort {
	if (input.forms.source.kind !== 'live') throw new TypeError('forms_page_live_source_required');
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;

	async function catalog() {
		const result = await input.forms.list();
		if (result.kind !== 'success') throw new FormsPageLiveAdapterError(resultFailure(result));
		return result.data;
	}

	async function detail(formId: string) {
		const result = await input.forms.readDetail(formId);
		if (result.kind === 'success') return result.data;
		if (isMissing(result)) return null;
		throw new FormsPageLiveAdapterError(resultFailure(result));
	}

	async function workflow(work: WorkflowInput): Promise<void> {
		const baseKey = newIdempotencyKey();
		const drafted = await work.draft(`${baseKey}.${work.action}.draft`);
		if (drafted.kind !== 'success') {
			throw new FormsPageLiveAdapterError(resultFailure(drafted));
		}
		if (!receiptMatches(drafted.receipt, work.draftOperationName)
			|| drafted.data.action !== work.action
			|| !work.validateDraft(drafted.data)) {
			throw new FormsPageLiveAdapterError({
				code: 'invalid_contract',
				reason: 'The Form draft did not match the requested change.'
			});
		}
		if (drafted.data.approvalRequirement !== 'none') {
			throw new FormsPageLiveAdapterError({
				code: 'distinct_current_human_required',
				reason: 'This Form change needs confirmation from another currently authorized person.'
			});
		}
		const selector = {
			changesetId: drafted.data.changesetId,
			revisionId: drafted.data.revisionId,
			revisionDigest: drafted.data.revisionDigest
		};
		const proposed = await input.forms.propose(
			{ ...selector, expectedHeadVersion: drafted.data.headVersion },
			`${baseKey}.${work.action}.propose`
		);
		if (proposed.kind !== 'success') {
			throw new FormsPageLiveAdapterError(resultFailure(proposed));
		}
		const operation = proposed.data.operations[0];
		if (!receiptMatches(proposed.receipt, 'changeset.propose')
			|| proposed.data.changesetId !== selector.changesetId
			|| proposed.data.revisionId !== selector.revisionId
			|| proposed.data.revisionDigest !== selector.revisionDigest
			|| proposed.data.headVersion !== drafted.data.headVersion + 1
			|| proposed.data.status !== 'proposed'
			|| proposed.data.revisionNumber !== drafted.data.revisionNumber
			|| proposed.data.riskTier !== drafted.data.riskTier
			|| proposed.data.approvalRequirement !== drafted.data.approvalRequirement
			|| proposed.data.operations.length !== 1
			|| operation?.kind !== 'intake.form.mutate'
			|| operation.version !== 2
			|| operation.dependencyGroup !== 'intake_form'
			|| !sameJson(operation.safeDiff, drafted.data.safeDiff)) {
			throw new FormsPageLiveAdapterError({
				code: 'invalid_contract',
				reason: 'The proposed Form change did not match its reviewed draft.'
			});
		}
		const committed = await input.forms.commit(
			{ ...selector, expectedHeadVersion: proposed.data.headVersion },
			`${baseKey}.${work.action}.commit`
		);
		if (committed.kind !== 'success') {
			throw new FormsPageLiveAdapterError(resultFailure(committed));
		}
		if (!receiptMatches(committed.receipt, 'changeset.commit')
			|| committed.data.changesetId !== selector.changesetId
			|| committed.data.revisionId !== selector.revisionId
			|| committed.data.revisionDigest !== selector.revisionDigest
			|| committed.data.expectedHeadVersion !== proposed.data.headVersion
			|| committed.data.committedHeadVersion !== proposed.data.headVersion + 1) {
			throw new FormsPageLiveAdapterError({
				code: 'invalid_contract',
				reason: 'The committed Form receipt did not match the proposed change.'
			});
		}
	}

	async function guardedMutation(work: () => Promise<void>): Promise<MutationOutcome> {
		try {
			await work();
			return { ok: true };
		} catch (error) {
			if (error instanceof FormsPageLiveAdapterError) {
				return { ok: false, reason: error.message };
			}
			throw error;
		}
	}

	async function reviseComposition(formId: string, composition: FormComposition): Promise<void> {
		const current = await detail(formId);
		if (!current) {
			throw new FormsPageLiveAdapterError({ code: 'form_missing', reason: 'This form no longer exists.' });
		}
		const definition: FormDefinitionAuthorInput = {
			...current.form.definition,
			composition: canonicalComposition(composition)
		};
		await workflow({
			action: 'revise',
			draftOperationName: 'form.definition.revise.draft',
			draft: (key) => input.forms.draftRevise({
				formId,
				expectedDefinitionVersion: current.form.version,
				expectedRegistryVersion: current.registryPin.version,
				definition
			}, key),
			validateDraft: (draft) => draft.safeDiff.action === 'revise'
				&& draft.safeDiff.before.id === formId
				&& draft.safeDiff.before.version === current.form.version
				&& sameJson(mapFormDefinitionToAuthorInput(draft.safeDiff.after.definition), definition)
		});
	}

	const port: FormsPagePort = {
		templates: Object.freeze({
			async applicationFormSurfaceId(): Promise<string | null> {
				// No canonical template-surface owner is registered in live composition yet.
				return null;
			}
		}),
		vocab: Object.freeze({
			async tracks() {
				return (await input.vocabulary.tracks()).map((track) => ({
					id: track.id,
					name: track.name,
					accent: track.accent,
					status: track.status,
					usage: track.usage
				}));
			},
			async formats() {
				return (await input.vocabulary.formats()).map((format) => ({
					id: format.id,
					name: format.name,
					status: format.status,
					usage: format.usage
				}));
			}
		}),
		schedule: Object.freeze({
			async sessions() {
				// Collecting-session choices stay absent until their canonical read owner lands.
				return [];
			}
		}),
		forms: Object.freeze({
			async list() {
				return (await catalog()).forms.map(tunedSummary);
			},
			async get(formId) {
				const summary = (await catalog()).forms.find((form) => form.id === formId);
				return summary ? tunedSummary(summary) : null;
			},
			async fields(formId) {
				return (await detail(formId))?.fields.map((row) => structuredClone(row)) ?? null;
			},
			async create(createInput) {
				const current = await catalog();
				const definition: FormDefinitionCreateAuthorInput = {
					kind: 'cfp',
					name: createInput.name,
					target: canonicalTarget(createInput.target),
					availability: createInput.closesAt
						? { kind: 'fixed_close_date', displayDate: createInput.closesAt }
						: { kind: 'evergreen' },
					confirmation: 'Thanks — your proposal has been received.',
					composition: canonicalComposition({
						excludedFieldIds: [], requiredOverrides: {}, optionExposure: {}
					}),
					rules: []
				};
				let createdId = '';
				await workflow({
					action: 'create',
					draftOperationName: 'form.definition.create.draft',
					draft: (key) => input.forms.draftCreate({
						expectedCatalogVersion: current.catalogVersion,
						expectedRegistryVersion: current.registryPin.version,
						definition
					}, key),
					validateDraft: (draft) => {
						if (draft.safeDiff.action !== 'create' || draft.safeDiff.before !== null) return false;
						createdId = draft.safeDiff.after.id;
						const after = mapFormDefinitionToAuthorInput(draft.safeDiff.after.definition);
						const availabilityMatches = definition.availability.kind === 'evergreen'
							? after.availability.kind === 'evergreen'
							: after.availability.kind === 'deadline';
						return availabilityMatches
							&& after.name === definition.name
							&& sameJson(after.target, definition.target)
							&& after.confirmation === definition.confirmation
							&& sameJson(after.composition, definition.composition)
							&& sameJson(after.rules, definition.rules);
					}
				});
				const created = (await catalog()).forms.find((form) => form.id === createdId);
				if (!created) {
					throw new FormsPageLiveAdapterError({
						code: 'invalid_contract',
						reason: 'The committed form was not present in the updated catalog.'
					});
				}
				return tunedSummary(created);
			},
			setComposition: (formId, composition) => guardedMutation(
				() => reviseComposition(formId, composition)
			),
			async restoreComposition(formId, composition) {
				await reviseComposition(formId, composition);
			},
			setClosing: (formId, closesAt) => guardedMutation(async () => {
				const current = await detail(formId);
				if (!current) {
					throw new FormsPageLiveAdapterError({ code: 'form_missing', reason: 'This form no longer exists.' });
				}
				await workflow({
					action: 'closing',
					draftOperationName: 'form.closing.change.draft',
					draft: (key) => input.forms.draftClosing({
						formId,
						expectedDefinitionVersion: current.form.version,
						closesAt
					}, key),
					validateDraft: (draft) => draft.safeDiff.action === 'closing'
						&& draft.safeDiff.before.id === formId
						&& draft.safeDiff.before.version === current.form.version
						&& draft.safeDiff.deadline.after.displayDate === closesAt
						&& (closesAt === null
							? draft.safeDiff.after.definition.availability.kind === 'evergreen'
							: draft.safeDiff.after.definition.availability.kind === 'deadline')
				});
			}),
			setStatus: (formId, status) => guardedMutation(async () => {
				const current = await detail(formId);
				if (!current) {
					throw new FormsPageLiveAdapterError({ code: 'form_missing', reason: 'This form no longer exists.' });
				}
				const transition = status === 'closed'
					? 'close' as const
					: current.form.status === 'draft'
						? 'publish_and_open' as const
						: 'reopen' as const;
				await workflow({
					action: 'lifecycle',
					draftOperationName: 'form.lifecycle.change.draft',
					draft: (key) => input.forms.draftLifecycle(
						transition === 'publish_and_open'
							? {
									transition,
									formId,
									expectedDefinitionVersion: current.form.version,
									expectedRegistryVersion: current.registryPin.version
								}
							: { transition, formId, expectedDefinitionVersion: current.form.version },
						key
					),
					validateDraft: (draft) => draft.safeDiff.action === 'lifecycle'
						&& draft.safeDiff.before.id === formId
						&& draft.safeDiff.before.version === current.form.version
						&& draft.safeDiff.after.status === status
						&& (transition === 'publish_and_open'
							? draft.safeDiff.publishedVersion !== null
							: draft.safeDiff.publishedVersion === null)
				});
			})
		}),
		fields: Object.freeze({
			move: input.fields.move,
			remove: input.fields.remove,
			restore: input.fields.restore,
			add: input.fields.add
		})
	};
	return Object.freeze(port);
}
