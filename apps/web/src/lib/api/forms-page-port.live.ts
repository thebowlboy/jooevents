import type {
	FormDefinitionAuthorInput,
	FormDefinitionCreateAuthorInput,
	FormRuleAuthorInput,
	ReleaseOverviewDto,
	StructuredOutcome
} from '@jooevents/contracts';
import type {
	ApplicationSurfacePublication,
	FormPublishReview,
	FormsPagePort
} from './forms-page-port';
import type { WorkspaceFieldsApi } from './field-registry-workspace-adapter';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type {
	FormComposition,
	FormFieldRow,
	FormSummary,
	FormTarget,
	MutationOutcome
} from './types';
import type {
	OrganizerFormDetailView,
	OrganizerFormSummaryView,
	OrganizerFormsPort,
	OrganizerFormsResult,
	OrganizerFormWriteView
} from './view-models/intake-forms';
import { createInFlightSlot, shareInFlight } from './in-flight';

type AdapterFailure = Readonly<{ code: string; reason: string }>;

/** Maps the release owner's one apply head to the exact form it serves. */
export function applicationSurfacePublication(
	overview: ReleaseOverviewDto
): ApplicationSurfacePublication {
	const active = overview.activeSurfaceReleases.find((candidate) => candidate.kind === 'apply');
	return active?.kind === 'apply'
		? {
				kind: 'pinned',
				formId: active.formRef.formId,
				formVersionId: active.formRef.formVersionId
			}
		: { kind: 'none' };
}

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
	if (code === 'required_choice_has_no_options') {
		return {
			code: outcome.kind,
			reason: 'A required choice has no answers, so nobody could submit this Form. Add an active track or format, or make the question optional or hide it.'
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
		currentPublishedVersionId: summary.currentPublishedVersionId,
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

/**
 * Adapts canonical Form + Registry + Program Vocabulary operations to the tuned page.
 * Ordinary writes are direct; publication alone uses Form-owned review and publish.
 */
export function createLiveFormsPagePort(input: {
	readonly forms: OrganizerFormsPort;
	readonly fields: WorkspaceFieldsApi;
	readonly vocabulary: Pick<ProgramVocabularySettingsPort, 'tracks' | 'formats'>;
	readonly templates: {
		applicationFormSurfaceId(): Promise<string | null>;
		applicationSurfacePublication(): Promise<ApplicationSurfacePublication>;
	};
	readonly newIdempotencyKey?: () => string;
}): FormsPagePort {
	if (input.forms.source.kind !== 'live') throw new TypeError('forms_page_live_source_required');
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;
	const publishKeys = new Map<string, string>();
	const editorSlots = new Map<string, { current: Promise<{
		readonly summary: FormSummary;
		readonly fields: FormFieldRow[];
	} | null> | null }>();

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

	function summaryFromDetail(current: OrganizerFormDetailView): FormSummary {
		return {
			id: current.form.id,
			name: current.form.name,
			target: tunedTarget(current.form.target),
			status: current.form.status,
			currentPublishedVersionId: current.form.currentPublishedVersionId,
			version: current.form.version,
			submissionCount: 0,
			fieldCount: current.fields.length,
			composition: canonicalComposition(current.form.definition.composition)
		};
	}

	async function editor(formId: string) {
		let slot = editorSlots.get(formId);
		if (!slot) {
			slot = createInFlightSlot();
			editorSlots.set(formId, slot);
		}
		return shareInFlight(slot, async () => {
			const current = await detail(formId);
			if (!current) return null;
			return {
				summary: summaryFromDetail(current),
				fields: current.fields.map((row) => structuredClone(row))
			};
		});
	}

	async function write(
		expectedAction: OrganizerFormWriteView['action'],
		expectedFormId: string | null,
		invoke: (key: string) => Promise<OrganizerFormsResult<OrganizerFormWriteView>>
	): Promise<OrganizerFormWriteView> {
		const result = await invoke(newIdempotencyKey());
		if (result.kind !== 'success') throw new FormsPageLiveAdapterError(resultFailure(result));
		if (result.data.action !== expectedAction
			|| (expectedFormId !== null && result.data.formId !== expectedFormId)) {
			throw new FormsPageLiveAdapterError({ code: 'invalid_contract',
				reason: 'The Form result did not match the requested change.' });
		}
		return result.data;
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
		const result = await write('revise', formId, (key) => input.forms.revise({
				formId,
				expectedDefinitionVersion: current.form.version,
				expectedRegistryVersion: current.registryPin.version,
				definition
			}, key));
		if (result.formDefinitionVersion !== current.form.version + 1) {
			throw new FormsPageLiveAdapterError({ code: 'invalid_contract', reason: 'The updated Form version did not match.' });
		}
	}

	async function reviseRules(formId: string, rules: readonly FormRuleAuthorInput[]): Promise<void> {
		const current = await detail(formId);
		if (!current) {
			throw new FormsPageLiveAdapterError({ code: 'form_missing', reason: 'This form no longer exists.' });
		}
		const definition: FormDefinitionAuthorInput = {
			...current.form.definition,
			rules: rules.map((rule) => structuredClone(rule))
		};
		const result = await write('revise', formId, (key) => input.forms.revise({
			formId,
			expectedDefinitionVersion: current.form.version,
			expectedRegistryVersion: current.registryPin.version,
			definition
		}, key));
		if (result.formDefinitionVersion !== current.form.version + 1) {
			throw new FormsPageLiveAdapterError({ code: 'invalid_contract', reason: 'The updated Form version did not match.' });
		}
	}

	const port: FormsPagePort = {
		templates: Object.freeze({
			async applicationFormSurfaceId() {
				try {
					return await input.templates.applicationFormSurfaceId();
				} catch {
					return null;
				}
			},
			async applicationSurfacePublication() {
				try {
					return await input.templates.applicationSurfacePublication();
				} catch {
					return null;
				}
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
				return (await editor(formId))?.summary ?? null;
			},
			async fields(formId) {
				return (await editor(formId))?.fields ?? null;
			},
			async ruleOptions(formId) {
				return (await detail(formId))?.ruleOptions.map((entry) => structuredClone(entry)) ?? null;
			},
			async rules(formId) {
				return (await detail(formId))?.form.definition.rules.map((rule) => structuredClone(rule)) ?? null;
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
				const result = await write('create', null, (key) => input.forms.create({
						expectedCatalogVersion: current.catalogVersion,
						expectedRegistryVersion: current.registryPin.version,
						definition
					}, key));
				const created = (await catalog()).forms.find((form) => form.id === result.formId);
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
			setRules: (formId, rules) => guardedMutation(() => reviseRules(formId, rules)),
			setClosing: (formId, closesAt) => guardedMutation(async () => {
				const current = await detail(formId);
				if (!current) {
					throw new FormsPageLiveAdapterError({ code: 'form_missing', reason: 'This form no longer exists.' });
				}
				const expectedAction = current.form.definition.availability.kind === 'evergreen'
					? 'set_closing' as const : closesAt === null ? 'remove_closing' as const : 'update_closing' as const;
				const result = await write(expectedAction, formId, (key) => input.forms.closing({
						formId,
						expectedDefinitionVersion: current.form.version,
						closesAt
					}, key));
				if (result.formDefinitionVersion !== current.form.version + 1) {
					throw new FormsPageLiveAdapterError({ code: 'invalid_contract', reason: 'The Form close-date version did not match.' });
				}
			}),
			setStatus: (formId, status) => guardedMutation(async () => {
				const current = await detail(formId);
				if (!current) {
					throw new FormsPageLiveAdapterError({ code: 'form_missing', reason: 'This form no longer exists.' });
				}
				if (current.form.status === 'draft') {
					throw new FormsPageLiveAdapterError({ code: 'review_required', reason: 'Review this Form before publishing and opening it.' });
				}
				const transition = status === 'closed' ? 'close' as const : 'reopen' as const;
				const result = await write(transition, formId, (key) => input.forms.lifecycle({
					transition, formId, expectedDefinitionVersion: current.form.version
				}, key));
				if (result.formDefinitionVersion !== current.form.version + 1) {
					throw new FormsPageLiveAdapterError({ code: 'invalid_contract', reason: 'The Form lifecycle version did not match.' });
				}
			}),
			async preparePublish(formId) {
				try {
					const current = await detail(formId);
					if (!current) return { ok: false, reason: 'This form no longer exists.' };
					if (current.form.status !== 'draft') return { ok: false, reason: 'Only a draft Form can be published and opened.' };
					const drafted = await input.forms.draftPublish({ action: 'publish_and_open', formId,
						expectedDefinitionVersion: current.form.version,
						expectedRegistryVersion: current.registryPin.version }, newIdempotencyKey());
					if (drafted.kind !== 'success') throw new FormsPageLiveAdapterError(resultFailure(drafted));
					const diff = drafted.data.safeDiff;
					if (drafted.data.action !== 'publish_and_open' || diff.action !== 'publish_and_open'
						|| diff.before.id !== formId || diff.before.version !== current.form.version
						|| diff.after.status !== 'open' || diff.publishedVersion.number < 1) {
						throw new FormsPageLiveAdapterError({ code: 'invalid_contract', reason: 'The Form publication review did not match.' });
					}
					const review: FormPublishReview = Object.freeze({ action: 'publish_and_open',
						selector: Object.freeze({ draftId: drafted.data.draftId, revisionId: drafted.data.revision.id,
							revisionDigestSha256: drafted.data.revision.digestSha256 }),
						formId, formName: current.form.name, versionNumber: diff.publishedVersion.number,
						resultingStatus: 'open', surfaceSuccessorCount: diff.surfaceSuccessors.length });
					return { ok: true, review };
				} catch (error) {
					if (error instanceof FormsPageLiveAdapterError) return { ok: false, reason: error.message };
					throw error;
				}
			},
			publish: (review) => guardedMutation(async () => {
				const fingerprint = JSON.stringify(review.selector);
				const key = publishKeys.get(fingerprint) ?? newIdempotencyKey();
				publishKeys.set(fingerprint, key);
				const published = await input.forms.publish(review.selector, key);
				if (published.kind !== 'success') throw new FormsPageLiveAdapterError(resultFailure(published));
				if (published.data.action !== review.action || published.data.formId !== review.formId
					|| published.data.publishedVersionId === null) {
					throw new FormsPageLiveAdapterError({ code: 'invalid_contract', reason: 'The published Form did not match its review.' });
				}
				const current = await detail(review.formId);
				if (!current || current.form.status !== 'open'
					|| current.form.currentPublishedVersionId !== published.data.publishedVersionId) {
					throw new FormsPageLiveAdapterError({ code: 'invalid_contract', reason: 'The published Form could not be reconciled.' });
				}
				publishKeys.delete(fingerprint);
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
